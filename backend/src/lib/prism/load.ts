/**
 * Prism LOAD — exactly-once natural-key UPSERT into responses / signals.
 *
 * Guarantees (architecture-ingestion.md §4):
 *   1. Per-natural-key serialization via pg_advisory_xact_lock(hashtext(org||key))
 *      — concurrent writers to one key serialize inside the batch txn (no lost-update).
 *   2. Source-time monotonicity — DO UPDATE only overwrites when the incoming
 *      record's source_observed_at >= the stored one. A late backfill describing an
 *      OLDER state is dropped as a no-op, never clobbering a fresher live edit.
 *   3. Hash no-op — equal source-time + equal payload_hash → no write at all.
 *   4. Batched transactions (≤500 rows) — the unit of retry and of lost-work on crash.
 *      Original source timestamps preserved (submitted_at, NEVER import time).
 *
 * The natural key is (org_id, metadata->'prism'->>'source_platform',
 * metadata->'prism'->>'source_record_id'), matched by a unique partial index.
 *
 * A COPY → staging → MERGE fast-path stub is provided for the bulk burst path
 * (operations-runbook.md §2.3); it is gated off until pg-copy-streams is added.
 */
import type { PoolClient } from 'pg';
import { pool } from '../db';
import logger from '../logger';
import type { StagedRow } from './transform';

export const BATCH_SIZE = 500;

export interface LoadResult {
  loaded: number;    // rows actually inserted or updated
  skipped: number;   // no-op (monotonicity guard or hash-equal)
  failed: number;
}

// Natural-key UPSERT with advisory lock + monotonicity + hash guard.
// The advisory lock is taken per-row inside the txn so concurrent batches to the
// same key serialize; it auto-releases at COMMIT/ROLLBACK (xact-scoped).
const UPSERT_RESPONSE = `
WITH lock AS (
  SELECT pg_advisory_xact_lock(hashtext($1 || ':' || $4)) AS l
)
INSERT INTO responses AS r
  (id, org_id, survey_id, answers, respondent, submitted_at, source_observed_at, metadata, payload_hash)
SELECT gen_random_uuid(), $1, $2, $3::jsonb, $5::jsonb, $6, $7, $8::jsonb, $9
FROM lock
ON CONFLICT (org_id, (metadata->'prism'->>'source_platform'), (metadata->'prism'->>'source_record_id'))
  WHERE metadata ? 'prism' AND deleted_at IS NULL
DO UPDATE SET
  answers            = EXCLUDED.answers,
  respondent         = EXCLUDED.respondent,
  submitted_at       = EXCLUDED.submitted_at,
  source_observed_at = EXCLUDED.source_observed_at,
  metadata           = r.metadata || EXCLUDED.metadata,
  payload_hash       = EXCLUDED.payload_hash,
  updated_at         = now()
WHERE
  -- Monotonicity: only overwrite with an equal-or-newer source state…
  (EXCLUDED.source_observed_at IS NULL
   OR r.source_observed_at IS NULL
   OR EXCLUDED.source_observed_at >= r.source_observed_at)
  -- …and skip pure no-op rewrites (hash-equal).
  AND r.payload_hash IS DISTINCT FROM EXCLUDED.payload_hash
RETURNING (xmax = 0) AS inserted
`;

// Signals share the identical exactly-once shape; only the target table differs.
const UPSERT_SIGNAL = UPSERT_RESPONSE.replace(/responses/g, 'signals');

/**
 * Load a single batch (≤500) in one all-or-nothing transaction.
 * `surveyId` is the canonical target survey for responses — the import's
 * materialized survey (lib/prism/survey.ts). Each staged row also carries its own
 * `survey_id` (stamped at TRANSFORM); the per-row value wins, falling back to the
 * batch `surveyId` for backward compatibility. `responses.survey_id` is NOT NULL, so
 * a response row with neither is an error (the materialize step guarantees one).
 * Signals may resolve null and store their source ref in metadata. Returns per-row
 * outcome counts.
 */
async function loadBatch(rows: StagedRow[], surveyId: string | null): Promise<LoadResult> {
  if (rows.length === 0) return { loaded: 0, skipped: 0, failed: 0 };
  const client: PoolClient = await pool.connect();
  let loaded = 0;
  let skipped = 0;
  try {
    await client.query('BEGIN');
    for (const row of rows) {
      const isSignal = row.kind === 'signal';
      const sql = isSignal ? UPSERT_SIGNAL : UPSERT_RESPONSE;
      // Per-row survey_id wins (stamped at TRANSFORM from the materialized survey);
      // fall back to the batch-level surveyId. Enforce NOT NULL for responses so LOAD
      // never blocks silently on the constraint — surface a clear, fixable error.
      const rowSurveyId = row.survey_id ?? surveyId;
      if (!isSignal && !rowSurveyId) {
        throw new Error(
          `prism:load response row ${row.natural_key} has no survey_id — ensureImportSurvey must run before LOAD`,
        );
      }
      const params = [
        row.org_id,                             // $1
        rowSurveyId,                            // $2 survey_id (per-row → batch fallback)
        JSON.stringify(row.answers),            // $3
        row.natural_key,                        // $4 advisory-lock key
        JSON.stringify(row.respondent ?? null), // $5
        row.submitted_at,                       // $6 original source time
        row.source_observed_at,                 // $7
        JSON.stringify(row.metadata),           // $8
        row.payload_hash,                       // $9
      ];
      const res = await client.query<{ inserted: boolean }>(sql, params);
      if (res.rowCount && res.rows[0]) loaded++; // a returned row = insert or update happened
      else skipped++;                            // guard suppressed the write (older state or hash-equal)
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error(
      { err: (err as Error).message, batch: rows.length },
      'prism:load batch failed — rolled back (will retry idempotently)',
    );
    throw err;
  } finally {
    client.release();
  }
  return { loaded, skipped, failed: 0 };
}

/**
 * Load all staged rows in batches of ≤500. Each batch is an independent txn so a
 * crash loses at most one batch; replaying converges (upsert is idempotent +
 * monotonic). Returns aggregate counts.
 */
export async function load(rows: StagedRow[], surveyId: string | null): Promise<LoadResult> {
  const total: LoadResult = { loaded: 0, skipped: 0, failed: 0 };
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const res = await loadBatch(batch, surveyId);
    total.loaded += res.loaded;
    total.skipped += res.skipped;
    total.failed += res.failed;
  }
  logger.info({ ...total, surveyId }, 'prism:load complete');
  return total;
}

/**
 * COPY → UNLOGGED staging → set-based MERGE bulk fast path (operations-runbook.md §2.3).
 *
 * COPY-speed ingest with exactly-once at the MERGE; ~15–30k rows/s vs ~3–6k for
 * per-row upsert. Requires a binary COPY stream driver (`pg-copy-streams`), which
 * is NOT yet a dependency, so this is a stub that throws until the dep is added.
 *
 * TODO(verify): add pg-copy-streams (a new dep — out of scope for this change) and
 * wire: BEGIN → CREATE UNLOGGED TABLE prism_load_stage_<batch> (LIKE responses) →
 * COPY … FROM STDIN (FORMAT binary) → INSERT … SELECT … ON CONFLICT … DO UPDATE
 * (same monotonicity guard as above) → DROP TABLE → COMMIT.
 */
export async function loadBulkCopy(_rows: StagedRow[], _surveyId: string | null): Promise<LoadResult> {
  throw new Error('loadBulkCopy: COPY→staging→MERGE fast path not implemented — needs pg-copy-streams dep');
}
