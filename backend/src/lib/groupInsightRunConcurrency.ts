/**
 * Shared insert-with-attach helper for `group_insight_runs` (TRACKER.md §1
 * "Interaction found with the existing /generate route" / DESIGN.md Appendix A.5).
 *
 * The `uq_gir_tag_inflight` partial unique index —
 *   CREATE UNIQUE INDEX uq_gir_tag_inflight ON group_insight_runs (org_id, tag_ids)
 *     WHERE status IN ('pending', 'running');
 * — blocks ANY concurrent run (manual, automated, or custom_range) for the same
 * (org_id, tag_ids) while one is already in flight. That index applies to the
 * WHOLE `group_insight_runs` table, including the pre-existing
 * `POST /api/survey-groups/insights/generate` route, which also inserts into
 * this table with the same (org_id, tag_ids) shape. Without this helper, a
 * concurrent duplicate call to that route would now surface a raw Postgres
 * `23505` unique-violation as a 500 — a real regression versus its previous
 * (silent, redundant-row) behavior.
 *
 * Both the old `/generate` route and the new Tag Report endpoints MUST insert
 * through this helper — on a `23505` conflict it looks up and returns the
 * already-in-flight `run_id` (per Appendix A.5: "returns the already-in-flight
 * run_id... rather than erroring") instead of throwing. This is one shared fix
 * for both call sites, not two divergent ones.
 */
import { query } from './db';

export type GroupInsightRunMode = 'manual' | 'automated' | 'custom_range';
export type GroupInsightRunTrigger = 'manual' | 'scheduled' | 'api';

export interface InsertGroupInsightRunParams {
  orgId: string;
  createdBy: string | null;
  tagIds: string[];
  surveyIds: string[];
  runMode?: GroupInsightRunMode;
  trigger?: GroupInsightRunTrigger;
  windowStart?: string | null;
  windowEnd?: string | null;
  parentRunId?: string | null;
}

export interface InsertGroupInsightRunResult {
  runId: string;
  createdAt: string;
  /** True when this call attached to an already-in-flight run instead of creating a new one. */
  attachedToExisting: boolean;
}

interface PgError extends Error {
  code?: string;
}

/**
 * Insert a new `group_insight_runs` row, or — if a concurrent in-flight run
 * already exists for this (org_id, tag_ids) — attach to it instead of erroring.
 */
export async function insertGroupInsightRunWithConcurrencyGuard(
  params: InsertGroupInsightRunParams,
): Promise<InsertGroupInsightRunResult> {
  const {
    orgId, createdBy, tagIds, surveyIds,
    runMode = 'manual', trigger = 'manual',
    windowStart = null, windowEnd = null, parentRunId = null,
  } = params;

  try {
    const { rows } = await query<{ id: string; created_at: string }>(
      `INSERT INTO group_insight_runs
         (org_id, created_by, tag_ids, survey_ids, status, stream_events,
          run_mode, trigger, window_start, window_end, parent_run_id)
       VALUES ($1, $2, $3::uuid[], $4::uuid[], 'pending', '[]'::jsonb,
               $5, $6, $7, $8, $9)
       RETURNING id, created_at`,
      [orgId, createdBy, tagIds, surveyIds, runMode, trigger, windowStart, windowEnd, parentRunId],
    );
    const row = rows[0];
    return { runId: row.id, createdAt: row.created_at, attachedToExisting: false };
  } catch (err: unknown) {
    const pgErr = err as PgError;
    if (pgErr.code === '23505') {
      const { rows } = await query<{ id: string; created_at: string }>(
        `SELECT id, created_at FROM group_insight_runs
         WHERE org_id = $1 AND tag_ids = $2::uuid[] AND status IN ('pending', 'running')
         ORDER BY created_at DESC
         LIMIT 1`,
        [orgId, tagIds],
      );
      if (rows.length) {
        return { runId: rows[0].id, createdAt: rows[0].created_at, attachedToExisting: true };
      }
    }
    throw err;
  }
}
