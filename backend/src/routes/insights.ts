/**
 * Insight routes (v2 — agentic insights).
 *
 *   GET  /api/insights/:surveyId/list        — List active insights for a survey
 *   POST /api/insights/:surveyId/generate    — Trigger insight generation run
 *   GET  /api/insights/:surveyId/run-status  — Latest run status + stream events
 *   GET  /api/insights/:surveyId/stream      — SSE stream of insight events
 *   POST /api/insights/:id/feedback          — Thumbs / pin / dismiss
 *   POST /api/insights/:surveyId/ask         — NLQ over survey corpus (Ask Crystal)
 *   GET  /api/surveys/:surveyId/insights     — Legacy compatibility endpoint
 */
import express from 'express';
import type { Request, Response } from 'express';
import { requireAuth, DEV_MODE } from '../middleware/auth';
import { query } from '../lib/db';
import logger from '../lib/logger';
import fetch from 'node-fetch';
import { serverError, clientError } from '../lib/httpError';
import * as agentsClient from '../lib/agentsClient';
import { getRedisClient } from '../lib/redis';
import { checkCredits, debitCredits } from '../lib/creditLedger';
import { CREDIT_COSTS } from '../lib/creditPlans';
import { verifyToken } from '@clerk/backend';
import { getOrgClaims } from '../lib/clerkClaims';
import { validate } from '../lib/validate';
import { updateInsightSettingsSchema } from '../schemas/insightSettings';
import { manualRunSchema, runPreviewSchema } from '../schemas/insightRuns';
import {
  INSIGHT_SETTING_DEFAULTS,
  INSIGHT_SETTING_KEYS,
  computeConfigHash,
  type InsightSettingKey,
} from '../lib/insightConfig';

const REFRESH_DAILY_LIMIT = parseInt(process.env.REFRESH_DAILY_LIMIT ?? '5', 10);
const MANUAL_DAILY_RUN_LIMIT = parseInt(process.env.MANUAL_DAILY_RUN_LIMIT ?? '10', 10);

// SLO alert thresholds — used by GET /api/insights/_slo
const SLO_CITATION_VALIDITY_WARN     = 0.995; // Alert threshold: <99.5%
const SLO_CITATION_VALIDITY_CRITICAL = 0.99;  // Page threshold: <99%
const SLO_VERIFIER_PASS_WARN         = 0.95;  // Alert threshold: <95%
const SLO_VERIFIER_PASS_CRITICAL     = 0.90;  // Page threshold: <90%

// H2: Startup assertion — DEV_MODE must never be active in production.
if (DEV_MODE && process.env.NODE_ENV === 'production') {
  throw new Error('DEV_MODE must not be active in production — set CLERK_SECRET_KEY');
}

const AGENTS_URL          = process.env.AGENTS_URL ?? 'http://localhost:8001';
const AGENTS_INTERNAL_KEY = process.env.AGENTS_INTERNAL_KEY
  ?? (process.env.NODE_ENV !== 'production'
    ? 'dev-internal-key-change-in-prod'
    : (() => { throw new Error('AGENTS_INTERNAL_KEY must be set in production'); })());

// Crystal (ReAct loop + eval agent) regularly takes 10–20s on dev free-tier models.
// All other agents operations (status polls, feedback writes) complete in <5s.
const CRYSTAL_TIMEOUT_MS = 90_000;  // 90s — covers ReAct + eval + network
const DEFAULT_AGENTS_TIMEOUT_MS = 15_000;

async function _agentsFetch(path: string, opts: Record<string, unknown> = {}, timeoutMs: number = DEFAULT_AGENTS_TIMEOUT_MS): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${AGENTS_URL}${path}`, {
      ...(opts as Parameters<typeof fetch>[1]),
      signal: controller.signal as never,
      headers: {
        'Content-Type':   'application/json',
        'X-Internal-Key': AGENTS_INTERNAL_KEY,
        ...((opts.headers as Record<string, string>) || {}),
      },
    });
    clearTimeout(timer);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw Object.assign(new Error(`Agents ${res.status}: ${body}`), { status: res.status });
    }
    return res.json();
  } catch (err: unknown) {
    clearTimeout(timer);
    throw err;
  }
}

const router = express.Router();

// Module-level window map — normalises frontend aliases ('30d'→'last_30d') and
// prevents SQL injection by whitelisting the only valid values.
const WINDOW_MAP: Record<string, string> = {
  all_time: 'all_time',
  last_30d: 'last_30d',
  last_7d:  'last_7d',
  '30d':    'last_30d',
  '7d':     'last_7d',
};

// Auto-create tables that require migration 20240518000000_insights_v2.sql
async function ensureTopicsTables(): Promise<void> {
  const stmts = [
    // survey_topics
    `CREATE TABLE IF NOT EXISTS survey_topics (
       id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
       survey_id        TEXT        NOT NULL,
       org_id           TEXT        NOT NULL,
       run_id           TEXT,
       time_window      TEXT        NOT NULL DEFAULT 'all_time',
       name             TEXT        NOT NULL,
       aliases          TEXT[]      NOT NULL DEFAULT '{}',
       is_new           BOOLEAN     NOT NULL DEFAULT FALSE,
       volume           INT         NOT NULL DEFAULT 0,
       sentiment_score  NUMERIC(4,3),
       dominant_emotion TEXT,
       effort_score     NUMERIC(4,2),
       trending         TEXT        CHECK (trending IN ('up','down','stable','new')),
       nps_avg          NUMERIC(5,1),
       positive_pct     NUMERIC(5,1),
       negative_pct     NUMERIC(5,1),
       first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS survey_topics_survey_org ON survey_topics(survey_id, org_id)`,
    `CREATE INDEX IF NOT EXISTS survey_topics_org_window ON survey_topics(org_id, time_window)`,
    // crystal_threads
    `CREATE TABLE IF NOT EXISTS crystal_threads (
       id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
       org_id           TEXT        NOT NULL,
       survey_id        TEXT,
       thread_key       TEXT        NOT NULL UNIQUE,
       messages         JSONB       NOT NULL DEFAULT '[]',
       context_snapshot JSONB       NOT NULL DEFAULT '{}',
       created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS crystal_threads_org ON crystal_threads(org_id)`,
    // Additive columns — safe to run multiple times
    `ALTER TABLE survey_topics ADD COLUMN IF NOT EXISTS nps_avg NUMERIC(5,1)`,
    `ALTER TABLE survey_topics ADD COLUMN IF NOT EXISTS positive_pct NUMERIC(5,1)`,
    `ALTER TABLE survey_topics ADD COLUMN IF NOT EXISTS negative_pct NUMERIC(5,1)`,
    // v2 signal columns
    `ALTER TABLE survey_topics ADD COLUMN IF NOT EXISTS sentiment_momentum TEXT
       CHECK (sentiment_momentum IN ('improving','worsening','stable'))`,
    `ALTER TABLE survey_topics ADD COLUMN IF NOT EXISTS urgency_score NUMERIC(6,2)`,
    `ALTER TABLE survey_topics ADD COLUMN IF NOT EXISTS volume_delta INT DEFAULT 0`,
    `ALTER TABLE survey_topics ADD COLUMN IF NOT EXISTS volume_delta_pct NUMERIC(6,1) DEFAULT 0`,
    `ALTER TABLE survey_topics ADD COLUMN IF NOT EXISTS chronic BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE survey_topics ADD COLUMN IF NOT EXISTS negative_run_streak INT DEFAULT 0`,
    // Index for urgency-sorted queries
    `CREATE INDEX IF NOT EXISTS survey_topics_urgency ON survey_topics(survey_id, org_id, urgency_score DESC)`,
    // GIN index on responses.ai_topics for fast topic-quote lookups
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE tablename='responses' AND indexname='responses_ai_topics_gin') THEN
         CREATE INDEX responses_ai_topics_gin ON responses USING GIN (ai_topics) WHERE ai_topics IS NOT NULL;
       END IF;
     END $$`,
    // Hierarchy / theme columns
    `ALTER TABLE survey_topics ADD COLUMN IF NOT EXISTS parent_topic_id TEXT`,
    `ALTER TABLE survey_topics ADD COLUMN IF NOT EXISTS hierarchy_level INT NOT NULL DEFAULT 0`,
    `ALTER TABLE survey_topics ADD COLUMN IF NOT EXISTS sub_topic_count INT NOT NULL DEFAULT 0`,
    `ALTER TABLE survey_topics ADD COLUMN IF NOT EXISTS theme TEXT`,
    `ALTER TABLE survey_topics ADD COLUMN IF NOT EXISTS nps_correlation NUMERIC(5,3)`,
    `ALTER TABLE survey_topics ADD COLUMN IF NOT EXISTS keyword_list TEXT[] NOT NULL DEFAULT '{}'`,
    `CREATE INDEX IF NOT EXISTS survey_topics_parent ON survey_topics(parent_topic_id) WHERE parent_topic_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS survey_topics_theme ON survey_topics(survey_id, org_id, theme)`,
    `ALTER TABLE survey_topics ADD COLUMN IF NOT EXISTS summary TEXT`,
    `ALTER TABLE survey_topics ADD COLUMN IF NOT EXISTS neutral_pct NUMERIC(5,1)`,
    // Signal columns written by agents pipeline's compute_topic_signals
    `ALTER TABLE survey_topics ADD COLUMN IF NOT EXISTS emotion_breakdown JSONB NOT NULL DEFAULT '{}'`,
    `ALTER TABLE survey_topics ADD COLUMN IF NOT EXISTS avg_response_len INT NOT NULL DEFAULT 0`,
    `ALTER TABLE survey_topics ADD COLUMN IF NOT EXISTS sample_response_ids JSONB NOT NULL DEFAULT '[]'`,
    // Extended XM signal columns (20240520000001_topic_signals_extended.sql)
    `ALTER TABLE survey_topics ADD COLUMN IF NOT EXISTS net_sentiment FLOAT`,
    `ALTER TABLE survey_topics ADD COLUMN IF NOT EXISTS nps_impact FLOAT`,
    `ALTER TABLE survey_topics ADD COLUMN IF NOT EXISTS promoter_pct FLOAT`,
    `ALTER TABLE survey_topics ADD COLUMN IF NOT EXISTS detractor_pct FLOAT`,
    `ALTER TABLE survey_topics ADD COLUMN IF NOT EXISTS passive_pct FLOAT`,
    `ALTER TABLE survey_topics ADD COLUMN IF NOT EXISTS driver_score FLOAT`,
    `ALTER TABLE survey_topics ADD COLUMN IF NOT EXISTS velocity_pct FLOAT`,
    `ALTER TABLE survey_topics ADD COLUMN IF NOT EXISTS avg_csat FLOAT`,
    `ALTER TABLE survey_topics ADD COLUMN IF NOT EXISTS csat_impact FLOAT`,
    `ALTER TABLE survey_topics ADD COLUMN IF NOT EXISTS confidence_level TEXT`,
    `ALTER TABLE survey_topics ADD COLUMN IF NOT EXISTS avg_effort_score FLOAT`,
    `ALTER TABLE survey_topics ADD COLUMN IF NOT EXISTS top_verbatims JSONB DEFAULT '[]'`,
    `ALTER TABLE survey_topics ADD COLUMN IF NOT EXISTS emotion_distribution JSONB DEFAULT '{}'`,
    `ALTER TABLE survey_topics ADD COLUMN IF NOT EXISTS health_label TEXT`,
    // Unique constraint required for ON CONFLICT (survey_id, name, time_window) in upsert
    `CREATE UNIQUE INDEX IF NOT EXISTS survey_topics_survey_name_window_unique
       ON survey_topics (survey_id, name, time_window)`,
    // insights table — time_window column required by node_publish ON CONFLICT
    `ALTER TABLE insights ADD COLUMN IF NOT EXISTS time_window TEXT NOT NULL DEFAULT 'all_time'`,
    `CREATE UNIQUE INDEX IF NOT EXISTS insights_hash_window_unique
       ON insights(survey_id, insight_hash, time_window)`,
    // ── Insight Pipeline v2 Phase 4 — insight_checkpoints_v2 ──────────────────
    `CREATE TABLE IF NOT EXISTS insight_checkpoints_v2 (
       id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
       survey_id                   UUID        NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
       org_id                      TEXT        NOT NULL,
       run_id                      UUID        REFERENCES agent_runs(id) ON DELETE SET NULL,
       checkpoint_number           INT         NOT NULL DEFAULT 1,
       parent_checkpoint_id        UUID        REFERENCES insight_checkpoints_v2(id) ON DELETE SET NULL,
       lane                        TEXT        NOT NULL DEFAULT 'automated',
       run_mode                    TEXT,
       trigger                     TEXT,
       created_by                  TEXT,
       response_count_at_checkpoint INT        NOT NULL DEFAULT 0,
       response_high_watermark     TIMESTAMPTZ,
       new_response_count          INT         NOT NULL DEFAULT 0,
       nps_at_checkpoint           NUMERIC(5,1),
       csat_at_checkpoint          NUMERIC(5,1),
       ces_at_checkpoint           NUMERIC(5,1),
       topic_fingerprint           TEXT,
       delta_from_prior            JSONB,
       meaningful_delta            BOOLEAN     NOT NULL DEFAULT FALSE,
       lineage_json                JSONB,
       report_blob_ref             TEXT,
       citations_manifest_ref      TEXT,
       schema_version              INT         NOT NULL DEFAULT 2,
       window_start                TIMESTAMPTZ,
       window_end                  TIMESTAMPTZ,
       report_label                TEXT,
       created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS insight_checkpoints_v2_survey_org
       ON insight_checkpoints_v2 (survey_id, org_id, checkpoint_number DESC)`,
    `CREATE INDEX IF NOT EXISTS insight_checkpoints_v2_parent
       ON insight_checkpoints_v2 (parent_checkpoint_id) WHERE parent_checkpoint_id IS NOT NULL`,
    // ── Insight Pipeline v2 Phase 3 — insight_reports ─────────────────────────
    `CREATE TABLE IF NOT EXISTS insight_reports (
       id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
       survey_id                UUID        NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
       org_id                   TEXT        NOT NULL,
       run_id                   UUID        REFERENCES agent_runs(id) ON DELETE SET NULL,
       run_mode                 TEXT,
       label                    TEXT,
       status                   TEXT        NOT NULL DEFAULT 'generating',
       window_start             TIMESTAMPTZ,
       window_end               TIMESTAMPTZ,
       blob_ref                 TEXT,
       citations_manifest_ref   TEXT,
       summary_headline         TEXT,
       trust_score_avg          NUMERIC(5,2),
       checkpoint_id            UUID,
       created_by               TEXT,
       created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       completed_at             TIMESTAMPTZ
     )`,
    `CREATE INDEX IF NOT EXISTS insight_reports_survey_org
       ON insight_reports (survey_id, org_id, created_at DESC)`,
    // ── Custom Analysis Phase 6 — custom_reports ──────────────────────────────
    `CREATE TABLE IF NOT EXISTS custom_reports (
       id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
       survey_id           UUID        NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
       org_id              TEXT        NOT NULL,
       run_id              UUID        REFERENCES agent_runs(id) ON DELETE SET NULL,
       name                TEXT,
       filter_spec         JSONB,
       status              TEXT        NOT NULL DEFAULT 'pending',
       blob_ref            TEXT,
       output_url          TEXT,
       slug                TEXT,
       credit_cost         INT,
       trust_score_avg     NUMERIC(5,2),
       corpus_coverage_pct NUMERIC(5,2),
       sample_size         INT,
       created_by          TEXT,
       created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       completed_at        TIMESTAMPTZ,
       expires_at          TIMESTAMPTZ
     )`,
    `CREATE INDEX IF NOT EXISTS custom_reports_survey_org
       ON custom_reports (survey_id, org_id, created_at DESC)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS custom_reports_slug_unique
       ON custom_reports (org_id, slug) WHERE slug IS NOT NULL`,
    `CREATE TABLE IF NOT EXISTS custom_report_insights (
       id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
       custom_report_id UUID        NOT NULL REFERENCES custom_reports(id) ON DELETE CASCADE,
       survey_id        UUID        NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
       org_id           TEXT        NOT NULL,
       layer            TEXT,
       category         TEXT,
       headline         TEXT        NOT NULL DEFAULT '',
       narrative        TEXT,
       metric_json      JSONB,
       citations_json   JSONB       NOT NULL DEFAULT '[]',
       trust_score      NUMERIC(5,2),
       trust_json       JSONB,
       priority         INT,
       filter_label     TEXT,
       created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS custom_report_insights_report
       ON custom_report_insights (custom_report_id)`,
    // Idempotent fixups — rename report_blob_ref → blob_ref where needed.
    `DO $$
     BEGIN
       IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='insight_reports' AND column_name='report_blob_ref') THEN
         ALTER TABLE insight_reports RENAME COLUMN report_blob_ref TO blob_ref;
       END IF;
     END $$`,
    `ALTER TABLE insight_reports ADD COLUMN IF NOT EXISTS blob_ref TEXT`,
    `ALTER TABLE insight_reports ADD COLUMN IF NOT EXISTS citations_manifest_ref TEXT`,
    `ALTER TABLE insight_reports ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ`,
    `DO $$
     BEGIN
       IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='custom_reports' AND column_name='report_blob_ref') THEN
         ALTER TABLE custom_reports RENAME COLUMN report_blob_ref TO blob_ref;
       END IF;
     END $$`,
    `ALTER TABLE custom_reports ADD COLUMN IF NOT EXISTS blob_ref TEXT`,
    `ALTER TABLE custom_reports ADD COLUMN IF NOT EXISTS output_url TEXT`,
    `ALTER TABLE custom_reports ADD COLUMN IF NOT EXISTS credit_cost INT`,
    `ALTER TABLE custom_reports ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`,
  ];
  for (const sql of stmts) {
    await query(sql).catch(() => {}); // idempotent — ignore if already exists
  }
}
ensureTopicsTables().catch(err => logger.warn({ err: (err as Error).message }, 'insights:ensureTables:warn'));

router.use(requireAuth);

// ── Helper: verify survey belongs to org ──────────────────────────────────────
async function getSurvey(surveyId: string, orgId: string): Promise<Record<string, unknown> | null> {
  const { rows } = await query(
    `SELECT id, title, questions, org_id, status, created_by,
            (SELECT COUNT(*)::int FROM responses WHERE survey_id = surveys.id) AS response_count
     FROM surveys WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`,
    [surveyId, orgId],
  );
  if (rows[0]) return rows[0] as Record<string, unknown>;

  // Fallback: in dev mode, accept the survey regardless of org_id mismatch.
  if (DEV_MODE) {
    const { rows: bare } = await query(
      'SELECT id, title, questions, org_id, status, created_by FROM surveys WHERE id = $1 AND deleted_at IS NULL',
      [surveyId],
    ).catch(() => ({ rows: [] }));
    if (bare[0]) {
      logger.warn({ surveyId, req_org: orgId, survey_org: (bare[0] as Record<string, unknown>).org_id }, 'insights:getSurvey:dev_mode_fallback');
      return bare[0] as Record<string, unknown>;
    }
  } else {
    const { rows: bare } = await query(
      'SELECT org_id FROM surveys WHERE id = $1 AND deleted_at IS NULL',
      [surveyId],
    ).catch(() => ({ rows: [] }));
    if (bare[0]) {
      logger.warn({ surveyId, req_org: orgId, survey_org: (bare[0] as Record<string, unknown>).org_id }, 'insights:getSurvey:org_mismatch');
    } else {
      logger.warn({ surveyId, req_org: orgId }, 'insights:getSurvey:not_found');
    }
  }
  return null;
}

// ── Helper: create an insight_generation run ──────────────────────────────────
async function createInsightRun(surveyId: string, orgId: string, userId: string, trigger: string): Promise<string> {
  const threadId = `insight:${orgId}:${surveyId}:${Date.now()}`;
  const { rows } = await query(
    `INSERT INTO agent_runs
       (org_id, user_id, thread_id, run_type, status, intent, survey_id)
     VALUES ($1, $2, $3, 'insight_generation', 'running', $4, $5)
     RETURNING id`,
    [orgId, userId, threadId, `insight:${trigger}`, surveyId],
  );
  return (rows[0] as { id: string }).id;
}

// ── GET /org/metric-history ───────────────────────────────────────────────────
router.get('/org/metric-history', async (req: Request, res: Response): Promise<void> => {
  const days = Math.min(parseInt(req.query.days as string, 10) || 90, 365);
  try {
    const { rows } = await query(
      `SELECT captured_at, active_survey_count, total_responses,
              avg_nps, avg_csat, avg_completion_rate,
              top_urgent_topic, top_driver_topic
       FROM org_metric_snapshots
       WHERE org_id = $1 AND captured_at >= NOW() - ($2 * INTERVAL '1 day')
       ORDER BY captured_at ASC`,
      [req.orgId, days],
    ).catch(() => ({ rows: [] }));
    res.json({ history: rows, days, org_id: req.orgId });
  } catch (err: unknown) {
    logger.error({ err: (err as Error).message, orgId: req.orgId }, 'insights:org-metric-history:error');
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

// ── GET /_slo — org SLO dashboard (24h window) ───────────────────────────────
// Static path registered BEFORE any /:surveyId/* parameterized routes so Express
// does not accidentally match "_slo" as a survey ID. Requires org:admin.

router.get('/_slo', requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const orgRole = await resolveOrgRole(req);
    if (orgRole !== 'org:admin') {
      res.status(403).json({
        error:    'Only org admins can access the SLO dashboard.',
        required: 'org:admin',
        current:  orgRole,
      });
      return;
    }

    const { rows } = await query<{
      citation_validity_rate: string | null;
      verifier_pass_rate: string | null;
      total_insights_audited: string;
    }>(
      `SELECT
         COALESCE(SUM(citation_valid_count)::float / NULLIF(SUM(citation_count), 0), 1.0) AS citation_validity_rate,
         COALESCE(COUNT(*) FILTER (WHERE verifier_pass = true)::float / NULLIF(COUNT(*), 0), 1.0) AS verifier_pass_rate,
         COUNT(*) AS total_insights_audited
       FROM insight_audit_log
       WHERE org_id = $1 AND created_at >= NOW() - INTERVAL '24 hours'`,
      [req.orgId],
    ).catch((e: unknown) => {
      logger.warn({ err: (e as Error).message, orgId: req.orgId }, 'insights:slo:table_unavailable');
      return { rows: [{ citation_validity_rate: null, verifier_pass_rate: null, total_insights_audited: '0' }] };
    });

    const row = rows[0];
    const citation_validity_rate = row.citation_validity_rate  != null ? parseFloat(row.citation_validity_rate)  : 1.0;
    const verifier_pass_rate     = row.verifier_pass_rate      != null ? parseFloat(row.verifier_pass_rate)      : 1.0;
    const total_insights_audited = parseInt(row.total_insights_audited, 10);

    res.json({
      slo: {
        citation_validity_rate,
        verifier_pass_rate,
        total_insights_audited,
        window_hours: 24,
        thresholds: {
          citation_validity: { warn: SLO_CITATION_VALIDITY_WARN, critical: SLO_CITATION_VALIDITY_CRITICAL },
          verifier_pass:     { warn: SLO_VERIFIER_PASS_WARN,     critical: SLO_VERIFIER_PASS_CRITICAL     },
        },
        status: {
          citation_validity: citation_validity_rate >= SLO_CITATION_VALIDITY_WARN ? 'ok'
            : citation_validity_rate >= SLO_CITATION_VALIDITY_CRITICAL ? 'warn' : 'critical',
          verifier_pass: verifier_pass_rate >= SLO_VERIFIER_PASS_WARN ? 'ok'
            : verifier_pass_rate >= SLO_VERIFIER_PASS_CRITICAL ? 'warn' : 'critical',
        },
      },
    });
  } catch (err: unknown) {
    logger.error({ err: (err as Error).message, orgId: req.orgId }, 'insights:slo:error');
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

// ── GET /:surveyId/list ───────────────────────────────────────────────────────

router.get('/:surveyId/list', async (req: Request, res: Response): Promise<void> => {
  const { surveyId } = req.params;
  const { layer, limit = '50', time_window } = req.query as Record<string, string>;

  // Validate time_window — normalise frontend aliases via module-level WINDOW_MAP
  const safeWindow = WINDOW_MAP[time_window] ?? 'all_time';

  try {
    const survey = await getSurvey(surveyId, req.orgId);
    if (!survey) { res.status(404).json({ error: 'Survey not found' }); return; }

    const conditions = ['i.survey_id = $1', 'i.org_id = $2', 'i.superseded_at IS NULL'];
    const params: unknown[] = [surveyId, req.orgId];

    if (layer) {
      conditions.push(`i.layer = $${params.length + 1}`);
      params.push(layer);
    }

    if (safeWindow !== 'all_time') {
      conditions.push(`(i.time_window = $${params.length + 1} OR (i.time_window = 'all_time' AND i.category NOT LIKE 'metric.%'))`);
      params.push(safeWindow);
    } else {
      conditions.push(`i.time_window = 'all_time'`);
    }

    params.push(Math.min(parseInt(limit, 10) || 50, 100));

    const { rows } = await query(
      `SELECT i.* FROM insights i
       WHERE ${conditions.join(' AND ')}
       ORDER BY i.priority DESC NULLS LAST, i.generated_at DESC
       LIMIT $${params.length}`,
      params,
    );

    const { rows: runRows } = await query(
      `SELECT status FROM agent_runs
       WHERE survey_id = $1 AND run_type = 'insight_generation' AND org_id = $2
       ORDER BY created_at DESC LIMIT 1`,
      [surveyId, req.orgId],
    );

    // crystal_opening: top descriptive insight narrative
    const { rows: openingRows } = await query(
      `SELECT narrative FROM insights
       WHERE survey_id = $1 AND org_id = $2 AND layer = 'descriptive'
         AND superseded_at IS NULL
       ORDER BY trust_score DESC NULLS LAST LIMIT 1`,
      [surveyId, req.orgId]
    ).catch(() => ({ rows: [] }));
    const crystalOpening = (openingRows[0] as Record<string, unknown> | undefined)?.narrative || null;

    // pipeline_active: check for running run scoped to this org to avoid cross-tenant leakage
    const { rows: runningRows } = await query(
      `SELECT id FROM agent_runs
       WHERE survey_id = $1 AND org_id = $2 AND status = 'running' LIMIT 1`,
      [surveyId, req.orgId]
    ).catch(() => ({ rows: [] }));
    const pipelineActive = runningRows.length > 0;

    // latest_checkpoint — Phase 0.5 trajectory band. Try insight_checkpoints_v2 first
    // (the new table); fall back to legacy survey_insight_checkpoints. Tolerate neither
    // table existing yet (pre-migration) by wrapping each attempt in try/catch.
    let latestCheckpoint: {
      number: number;
      nps: number | null;
      delta: unknown;
      meaningful: boolean;
      created_at: unknown;
    } | null = null;
    try {
      const { rows: cpRows } = await query(
        `SELECT checkpoint_number, nps_at_checkpoint, delta_from_prior, meaningful_delta, created_at
         FROM insight_checkpoints_v2
         WHERE survey_id = $1 AND org_id = $2
         ORDER BY checkpoint_number DESC LIMIT 1`,
        [surveyId, req.orgId],
      );
      const cp = cpRows[0] as Record<string, unknown> | undefined;
      if (cp) {
        latestCheckpoint = {
          number:     cp.checkpoint_number as number,
          nps:        cp.nps_at_checkpoint != null ? parseFloat(String(cp.nps_at_checkpoint)) : null,
          delta:      cp.delta_from_prior ?? null,
          meaningful: cp.meaningful_delta === true,
          created_at: cp.created_at ?? null,
        };
      }
    } catch {
      // insight_checkpoints_v2 not migrated yet — try legacy table
    }
    if (!latestCheckpoint) {
      try {
        const { rows: cpRows } = await query(
          `SELECT checkpoint_number, nps_at_checkpoint, delta_from_prior, meaningful_delta, created_at
           FROM survey_insight_checkpoints
           WHERE survey_id = $1 AND org_id = $2
           ORDER BY checkpoint_number DESC LIMIT 1`,
          [surveyId, req.orgId],
        );
        const cp = cpRows[0] as Record<string, unknown> | undefined;
        if (cp) {
          latestCheckpoint = {
            number:     cp.checkpoint_number as number,
            nps:        cp.nps_at_checkpoint != null ? parseFloat(String(cp.nps_at_checkpoint)) : null,
            delta:      cp.delta_from_prior ?? null,
            meaningful: cp.meaningful_delta === true,
            created_at: cp.created_at ?? null,
          };
        }
      } catch (cpErr: unknown) {
        logger.warn({ err: (cpErr as Error).message, surveyId }, 'insights:list:latest_checkpoint_unavailable');
        latestCheckpoint = null;
      }
    }

    res.json({
      insights:        rows,
      run_status:      (runRows[0] as Record<string, unknown> | undefined)?.status ?? null,
      survey:          { id: survey.id, title: survey.title, response_count: (survey.response_count as number) ?? 0 },
      crystal_opening: crystalOpening,
      pipeline_active: pipelineActive,
      survey_status:   survey.status,
      latest_checkpoint: latestCheckpoint,
    });
  } catch (err: unknown) {
    logger.error({ err: (err as Error).message, surveyId }, 'insights:list:error');
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

// ── POST /:surveyId/generate ──────────────────────────────────────────────────

router.post('/:surveyId/generate', async (req: Request, res: Response): Promise<void> => {
  const { surveyId } = req.params;
  const body = req.body as Record<string, unknown>;
  const trigger = (body.trigger as string) || 'regenerate';
  const force   = body.force === true || req.query.force === 'true';

  try {
    const survey = await getSurvey(surveyId, req.orgId);
    if (!survey) { res.status(404).json({ error: 'Survey not found' }); return; }

    // Mark stale runs (running >10 min) as abandoned so they don't block retries.
    await query(
      `UPDATE agent_runs SET status='cancelled', completed_at=NOW()
       WHERE survey_id=$1 AND org_id=$2 AND run_type='insight_generation'
         AND status='running' AND created_at < NOW() - INTERVAL '10 minutes'`,
      [surveyId, req.orgId],
    );

    // Rate-limit: 1 active generation per survey per 60s, unless force=true.
    if (!force) {
      const { rows: recent } = await query(
        `SELECT id FROM agent_runs
         WHERE survey_id = $1 AND org_id = $2 AND run_type = 'insight_generation'
           AND status = 'running' AND created_at > NOW() - INTERVAL '60 seconds'
         LIMIT 1`,
        [surveyId, req.orgId],
      );
      if (recent.length) {
        res.status(429).json({ error: 'Generation already running. Please wait.', retryable: true });
        return;
      }
    } else {
      // force=true: abandon any active run from the last 60s too
      await query(
        `UPDATE agent_runs SET status='cancelled', completed_at=NOW()
         WHERE survey_id=$1 AND org_id=$2 AND run_type='insight_generation'
           AND status='running' AND created_at > NOW() - INTERVAL '60 seconds'`,
        [surveyId, req.orgId],
      );
    }

    // Credit metering — only user-initiated runs are charged. System auto-runs
    // (progressive 'stream' tier, 'schedule') are bundled, so customers are never surprised.
    const meteredRun = trigger === 'manual' || trigger === 'regenerate';
    if (meteredRun) {
      const check = await checkCredits(req.orgId, CREDIT_COSTS.insight_run, 'insight_run');
      if (!check.ok) {
        res.status(402).json({
          error:    'Not enough credits to generate insights.',
          code:     'INSUFFICIENT_CREDITS',
          required: check.required,
          available: check.available,
        });
        return;
      }
    }

    const runId = await createInsightRun(surveyId, req.orgId, req.userId, trigger);

    // Fire-and-forget to agents service
    _agentsFetch('/insights/generate', {
      method: 'POST',
      body: JSON.stringify({ survey_id: surveyId, org_id: req.orgId, run_id: runId, trigger }),
    }).catch(err => {
      logger.error({ err: (err as Error).message, surveyId, runId }, 'insights:generate:agents_error');
      query("UPDATE agent_runs SET status='failed', completed_at=NOW() WHERE id=$1", [runId]).catch(() => {});
    });

    // Debit after the run is committed. Pre-checked above, so this only fails on a rare
    // concurrent race — in which case the run is already enqueued, so we log and proceed.
    if (meteredRun) {
      try {
        await debitCredits(req.orgId, {
          actionType: 'insight_run',
          credits:    CREDIT_COSTS.insight_run,
          userId:     req.userId,
          actionRef:  runId,
          note:       `Insight run (${trigger})`,
        });
      } catch (err) {
        logger.warn({ err: (err as Error).message, surveyId, runId }, 'insights:generate:debit_failed');
      }
    }

    res.status(202).json({ run_id: runId, status: 'started' });
  } catch (err: unknown) {
    logger.error({ err: (err as Error).message, surveyId }, 'insights:generate:error');
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

// ── POST /:surveyId/topics/backfill ───────────────────────────────────────────
// Manual "Backfill Tagging" job (Experience → Topics page). Drains the
// survey's ENTIRE untagged-response backlog in the background — mirrors
// /:surveyId/generate's shape (duplicate-run guard, credit metering,
// agent_runs insert, fire-and-forget agentsClient call, 202 response) but
// against a new run_type ('topic_backfill') and a lighter, per-response job
// (lib/topic_backfill.py in CrystalOS) rather than a full report run.

router.post('/:surveyId/topics/backfill', async (req: Request, res: Response): Promise<void> => {
  const { surveyId } = req.params;

  try {
    const survey = await getSurvey(surveyId, req.orgId);
    if (!survey) { res.status(404).json({ error: 'Survey not found' }); return; }

    // One backfill job per survey at a time — a second click while one is
    // already running would just duplicate (billed) LLM/embedding work on the
    // exact same backlog.
    const { rows: running } = await query(
      `SELECT id FROM agent_runs
       WHERE survey_id = $1 AND org_id = $2 AND run_type = 'topic_backfill' AND status = 'running'
       LIMIT 1`,
      [surveyId, req.orgId],
    );
    if (running.length) {
      res.status(429).json({
        error: 'A tagging backfill is already running for this survey.',
        retryable: true,
        run_id: (running[0] as { id: string }).id,
      });
      return;
    }

    // Don't charge (or start a job at all) when there's nothing to do — fixed
    // 2026-07-13, independent sales/product review finding. Without this, a
    // customer double-checking "did everything already get tagged?" pays the
    // full flat cost for an instant no-op every time.
    const { rows: [{ untagged_count: untaggedCount }] } = await query(
      `SELECT COUNT(*)::int AS untagged_count FROM responses
       WHERE survey_id = $1 AND org_id = $2 AND ai_enriched_at IS NULL`,
      [surveyId, req.orgId],
    ) as { rows: { untagged_count: number }[] };
    if (untaggedCount === 0) {
      res.status(200).json({ status: 'nothing_to_backfill' });
      return;
    }

    const check = await checkCredits(req.orgId, CREDIT_COSTS.topic_backfill, 'topic_backfill');
    if (!check.ok) {
      res.status(402).json({
        error:    'Not enough credits to run a tagging backfill.',
        code:     'INSUFFICIENT_CREDITS',
        required: check.required,
        available: check.available,
      });
      return;
    }

    // The SELECT above is a fast-path check, not a lock — two near-simultaneous
    // requests (a double-submit that beats the frontend's button-disable, or
    // two browser tabs) can both observe zero running rows and both reach this
    // INSERT. uq_agent_runs_topic_backfill_inflight (partial unique index on
    // (survey_id, org_id) WHERE run_type='topic_backfill' AND status='running',
    // mirrors uq_gir_tag_inflight's pattern for group_insight_runs) makes the
    // SECOND insert fail with 23505 instead of silently creating a duplicate
    // job — caught below so the loser attaches to the winner's run instead of
    // starting a second job and double-debiting credits (fixed 2026-07-13,
    // independent review finding).
    const threadId = `topics:backfill:${req.orgId}:${surveyId}:${Date.now()}`;
    let runId: string;
    try {
      const { rows: [{ id }] } = await query(
        `INSERT INTO agent_runs
           (org_id, user_id, thread_id, run_type, status, intent, survey_id)
         VALUES ($1, $2, $3, 'topic_backfill', 'running', 'topics:backfill', $4)
         RETURNING id`,
        [req.orgId, req.userId, threadId, surveyId],
      ) as { rows: { id: string }[] };
      runId = id;
    } catch (err: unknown) {
      if ((err as { code?: string }).code === '23505') {
        const { rows: existing } = await query(
          `SELECT id FROM agent_runs
           WHERE survey_id = $1 AND org_id = $2 AND run_type = 'topic_backfill' AND status = 'running'
           LIMIT 1`,
          [surveyId, req.orgId],
        );
        res.status(429).json({
          error: 'A tagging backfill is already running for this survey.',
          retryable: true,
          run_id: existing.length ? (existing[0] as { id: string }).id : null,
        });
        return;
      }
      throw err;
    }

    agentsClient.triggerTopicBackfill({ surveyId, orgId: req.orgId, runId }).catch(err => {
      logger.error({ err: (err as Error).message, surveyId, runId }, 'insights:topics:backfill:agents_error');
      query("UPDATE agent_runs SET status='failed', completed_at=NOW() WHERE id=$1", [runId]).catch(() => {});
    });

    try {
      await debitCredits(req.orgId, {
        actionType: 'topic_backfill',
        credits:    CREDIT_COSTS.topic_backfill,
        userId:     req.userId,
        actionRef:  runId,
        note:       'Topic tagging backfill',
      });
    } catch (err) {
      logger.warn({ err: (err as Error).message, surveyId, runId }, 'insights:topics:backfill:debit_failed');
    }

    res.status(202).json({ run_id: runId, status: 'started' });
  } catch (err: unknown) {
    logger.error({ err: (err as Error).message, surveyId }, 'insights:topics:backfill:error');
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

// ── GET /:surveyId/run-status ─────────────────────────────────────────────────

router.get('/:surveyId/run-status', async (req: Request, res: Response): Promise<void> => {
  const { surveyId } = req.params;
  try {
    const { rows } = await query(
      `SELECT id, status, stream_events, error_log, created_at, completed_at,
              EXTRACT(EPOCH FROM (COALESCE(completed_at, NOW()) - created_at))::int AS duration_seconds,
              last_heartbeat_at
       FROM agent_runs
       WHERE survey_id = $1 AND org_id = $2 AND run_type = 'insight_generation'
       ORDER BY created_at DESC LIMIT 1`,
      [surveyId, req.orgId],
    );
    if (!rows.length) { res.json({ run_id: null, status: 'none', stream_events: [] }); return; }
    const run = rows[0] as Record<string, unknown>;
    const errorLog = Array.isArray(run.error_log) ? run.error_log : [];
    res.json({
      run_id:           run.id,
      status:           run.status,
      stream_events:    Array.isArray(run.stream_events) ? run.stream_events : [],
      error:            errorLog.length ? errorLog[errorLog.length - 1] : null,
      error_log:        errorLog,
      duration_seconds: run.duration_seconds != null ? parseInt(String(run.duration_seconds)) : null,
      created_at:       run.created_at,
      completed_at:     run.completed_at || null,
      last_heartbeat_at: run.last_heartbeat_at || null,
    });
  } catch (err: unknown) {
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

// ── GET /:surveyId/stream (SSE) ───────────────────────────────────────────────

router.get('/:surveyId/stream', async (req: Request, res: Response): Promise<void> => {
  const { surveyId } = req.params;

  res.set({
    'Content-Type':      'text/event-stream',
    'Cache-Control':     'no-cache',
    'Connection':        'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  let lastEventCount = 0;
  let pollCount = 0;
  const MAX_POLLS = 40;

  const send = (data: unknown): void => { res.write(`data: ${JSON.stringify(data)}\n\n`); };

  const poll = async (): Promise<void> => {
    if (pollCount++ >= MAX_POLLS) {
      send({ event: 'timeout' });
      clearInterval(interval);
      res.end();
      return;
    }
    try {
      const { rows } = await query(
        `SELECT id, status, stream_events FROM agent_runs
         WHERE survey_id = $1 AND org_id = $2 AND run_type = 'insight_generation'
         ORDER BY created_at DESC LIMIT 1`,
        [surveyId, req.orgId],
      );
      if (!rows.length) return;
      const run    = rows[0] as Record<string, unknown>;
      const events = Array.isArray(run.stream_events) ? run.stream_events : [];
      for (const ev of (events as unknown[]).slice(lastEventCount)) {
        send(ev);
        lastEventCount++;
      }
      if (run.status === 'completed' || run.status === 'failed') {
        const { rows: insights } = await query(
          `SELECT * FROM insights WHERE survey_id=$1 AND org_id=$2 AND superseded_at IS NULL ORDER BY priority DESC NULLS LAST`,
          [surveyId, req.orgId],
        );
        send({ event: 'insights_ready', data: { insights, status: run.status } });
        clearInterval(interval);
        res.end();
      }
    } catch (err: unknown) {
      logger.warn({ err: (err as Error).message }, 'insights:stream:poll_error');
      if (res.writableEnded) clearInterval(interval);
    }
  };

  const interval = setInterval(poll, 3000);
  await poll();
  req.on('close', () => clearInterval(interval));
});

// ── POST /:id/feedback ────────────────────────────────────────────────────────

router.post('/:id/feedback', async (req: Request, res: Response): Promise<void> => {
  const { thumbs, pinned, dismissed } = req.body as Record<string, unknown>;
  const updates: Record<string, unknown> = {};
  if (thumbs    !== undefined) updates.thumbs    = thumbs;
  if (pinned    !== undefined) updates.pinned    = pinned;
  if (dismissed !== undefined) updates.dismissed = dismissed;

  try {
    await query(
      `UPDATE insights
       SET user_state_json = user_state_json || $1::jsonb
       WHERE id = $2 AND org_id = $3`,
      [JSON.stringify(updates), req.params.id, req.orgId],
    );
    res.json({ success: true });
  } catch (err: unknown) {
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

// ── POST /:surveyId/ask (Ask Crystal — NLQ) ───────────────────────────────────

router.post('/:surveyId/ask', async (req: Request, res: Response): Promise<void> => {
  const { surveyId } = req.params;
  const { question } = req.body as { question?: unknown };

  if (!question || typeof question !== 'string') {
    res.status(400).json({ error: 'question is required' });
    return;
  }

  try {
    // M1: Per-(orgId, surveyId) rate limit — 10 requests per minute. Fail open if Redis unavailable.
    const redis = getRedisClient();
    if (redis) {
      const key = `rate:ask:${req.orgId}:${surveyId}`;
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, 60);
      if (count > 10) {
        clientError(res, 429, 'Too many questions — try again in a minute.');
        return;
      }
    }

    const { rows: insights } = await query(
      `SELECT headline, narrative, layer, category, trust_score, citations_json
       FROM insights
       WHERE survey_id = $1 AND org_id = $2 AND superseded_at IS NULL
       ORDER BY priority DESC NULLS LAST LIMIT 20`,
      [surveyId, req.orgId],
    );

    if (!insights.length) {
      res.json({
        answer:    'No insights have been generated for this survey yet. Generate insights first.',
        citations: [],
      });
      return;
    }

    // Credit metering — 1 credit per ask (cheap NLQ, not a full pipeline run).
    const askCheck = await checkCredits(req.orgId, 1, 'ask');
    if (!askCheck.ok) {
      res.status(402).json({
        error:     'Not enough credits to ask Crystal.',
        code:      'INSUFFICIENT_CREDITS',
        required:  askCheck.required,
        available: askCheck.available,
      });
      return;
    }

    const context = (insights as Record<string, unknown>[]).map((ins, i) =>
      `[${i + 1}] ${(ins.layer as string).toUpperCase()}: ${ins.headline}\n${ins.narrative}`,
    ).join('\n\n');

    const { chat } = require('../lib/openrouter') as { chat: (messages: unknown[], opts: undefined, opName: string, maxTokens: number) => Promise<string> };
    const answer = await chat(
      [
        {
          role: 'system',
          content: 'You are Crystal, an expert CX analyst. Answer the user\'s question using ONLY the provided insight context. Be concise (2-4 sentences). Cite insight numbers like [1], [2] inline. If the context does not cover the question, say so honestly.',
        },
        {
          role: 'user',
          content: `Insight context:\n${context}\n\nQuestion: ${question}`,
        },
      ],
      undefined,
      'ask-insights',
      600,
    );

    // Debit after successful answer (mirrors /generate pattern).
    await debitCredits(req.orgId, {
      actionType: 'ask',
      credits:    1,
      userId:     req.userId,
      actionRef:  surveyId,
      note:       'Ask Crystal NLQ',
    }).catch((e) => logger.warn({ err: e }, 'ask_debit_failed'));

    res.json({ answer, citations: insights.slice(0, 3) });
  } catch (err: unknown) {
    logger.error({ err: (err as Error).message, surveyId }, 'insights:ask:error');
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

// ── GET /:surveyId/topics ─────────────────────────────────────────────────────

router.get('/:surveyId/topics', async (req: Request, res: Response): Promise<void> => {
  const { surveyId } = req.params;
  const window = (req.query.window as string) || 'all_time';
  try {
    const survey = await getSurvey(surveyId, req.orgId);
    if (!survey) { res.status(404).json({ error: 'Survey not found' }); return; }

    const sortBy = req.query.sort === 'urgency' ? 'urgency_score DESC NULLS LAST, volume DESC' : 'volume DESC';
    const { rows } = await query(
      `SELECT id, name, aliases, is_new, volume, sentiment_score, dominant_emotion,
              effort_score, trending, sentiment_momentum, urgency_score,
              volume_delta, volume_delta_pct, chronic, health_label, velocity_pct,
              first_seen_at, last_seen_at, nps_avg, positive_pct, negative_pct,
              net_sentiment, nps_impact, promoter_pct, detractor_pct, passive_pct,
              driver_score, avg_csat, csat_impact, avg_effort_score,
              confidence_level, top_verbatims, emotion_distribution,
              parent_topic_id, hierarchy_level, sub_topic_count
       FROM survey_topics
       WHERE survey_id = $1 AND org_id = $2 AND time_window = $3
       ORDER BY ${sortBy} LIMIT 50`,
      [surveyId, req.orgId, window],
    ).catch(() => ({ rows: [] }));

    const { rows: runRows } = await query(
      `SELECT status, created_at FROM agent_runs
       WHERE survey_id = $1 AND org_id = $2 AND run_type = 'insight_generation'
       ORDER BY created_at DESC LIMIT 1`,
      [surveyId, req.orgId],
    ).catch(() => ({ rows: [] }));

    res.json({
      topics:     rows,
      run_status: (runRows[0] as Record<string, unknown> | undefined)?.status ?? null,
      window,
    });
  } catch {
    res.json({ topics: [], run_status: null, window });
  }
});

// ── GET /:surveyId/drivers — NPS driver analysis ──────────────────────────────

router.get('/:surveyId/drivers', async (req: Request, res: Response): Promise<void> => {
  const { surveyId } = req.params;
  const window = (req.query.window as string) || 'all_time';
  try {
    const survey = await getSurvey(surveyId, req.orgId);
    if (!survey) { res.status(404).json({ error: 'Survey not found' }); return; }

    // Overall survey NPS average
    const { rows: [overall] } = await query(
      `SELECT ROUND(AVG(nps_score)::numeric, 1) AS avg_nps, COUNT(*) FILTER (WHERE nps_score IS NOT NULL)::int AS nps_count
       FROM responses WHERE survey_id = $1 AND org_id = $2`,
      [surveyId, req.orgId],
    ).catch(() => ({ rows: [{ avg_nps: null, nps_count: 0 }] }));

    const overallRow = overall as { avg_nps: unknown; nps_count: number } | undefined;
    const overallNps = overallRow?.avg_nps != null ? parseFloat(String(overallRow.avg_nps)) : null;

    // Get topics from registry
    const { rows: topics } = await query(
      `SELECT id, name, volume, sentiment_score, effort_score, trending, nps_avg, positive_pct, negative_pct
       FROM survey_topics
       WHERE survey_id = $1 AND org_id = $2 AND time_window = $3
       ORDER BY volume DESC LIMIT 20`,
      [surveyId, req.orgId, window],
    ).catch(() => ({ rows: [] }));

    if (!topics.length) {
      res.json({ drivers: [], overall_nps: overallNps, window });
      return;
    }

    // Try to enrich with per-topic NPS from responses.ai_topics (GIN index)
    let topicNpsMap: Record<string, { avg_nps: number; tagged_count: number }> = {};
    try {
      const { rows: taggedNps } = await query(
        `SELECT
           topic_name,
           ROUND(AVG(nps_score)::numeric, 1) AS topic_avg_nps,
           COUNT(*)::int AS tagged_count
         FROM (
           SELECT r.nps_score, jsonb_array_elements_text(r.ai_topics) AS topic_name
           FROM responses r
           WHERE r.survey_id = $1 AND r.org_id = $2 AND r.ai_topics IS NOT NULL
             AND r.nps_score IS NOT NULL
         ) t
         GROUP BY topic_name`,
        [surveyId, req.orgId],
      );
      for (const row of taggedNps as Record<string, unknown>[]) {
        topicNpsMap[row.topic_name as string] = {
          avg_nps:      parseFloat(String(row.topic_avg_nps)),
          tagged_count: row.tagged_count as number,
        };
      }
    } catch { /* ai_topics column may not exist yet */ }

    // Build driver objects
    const drivers = (topics as Record<string, unknown>[]).map(t => {
      const tagged        = topicNpsMap[t.name as string];
      const topicNps      = tagged?.avg_nps ?? (t.nps_avg != null ? parseFloat(String(t.nps_avg)) : null);
      const taggedCount   = tagged?.tagged_count ?? t.volume;
      const sentimentScore = t.sentiment_score != null ? parseFloat(String(t.sentiment_score)) : null;

      const npsDelta = (topicNps != null && overallNps != null)
        ? Math.round((topicNps - overallNps) * 10) / 10
        : null;

      const impactScore = npsDelta != null
        ? Math.abs(npsDelta) * Math.sqrt(t.volume as number)
        : Math.abs(sentimentScore ?? 0) * Math.sqrt(t.volume as number);

      return {
        id:            t.id,
        name:          t.name,
        volume:        t.volume,
        tagged_count:  taggedCount,
        topic_avg_nps: topicNps,
        nps_delta:     npsDelta,
        impact_score:  Math.round(impactScore * 10) / 10,
        sentiment_score: sentimentScore,
        effort_score:  t.effort_score != null ? parseFloat(String(t.effort_score)) : null,
        trending:      t.trending,
        positive_pct:  t.positive_pct != null ? parseFloat(String(t.positive_pct)) : null,
        negative_pct:  t.negative_pct != null ? parseFloat(String(t.negative_pct)) : null,
        direction:     npsDelta != null ? (npsDelta > 0 ? 'positive' : npsDelta < 0 ? 'negative' : 'neutral')
                      : (sentimentScore != null ? (sentimentScore > 0.2 ? 'positive' : sentimentScore < -0.2 ? 'negative' : 'neutral') : 'neutral'),
      };
    });

    // Sort: most impactful first (biggest movers up or down)
    drivers.sort((a, b) => b.impact_score - a.impact_score);

    res.json({
      drivers,
      overall_nps: overallNps,
      total_topics: topics.length,
      window,
    });
  } catch (err: unknown) {
    logger.error({ err: (err as Error).message, surveyId }, 'insights:drivers:error');
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

// ── GET /:surveyId/topics/:topicId/quotes ─────────────────────────────────────

router.get('/:surveyId/topics/:topicId/quotes', async (req: Request, res: Response): Promise<void> => {
  const { surveyId, topicId } = req.params;
  try {
    const survey = await getSurvey(surveyId, req.orgId);
    if (!survey) { res.status(404).json({ error: 'Survey not found' }); return; }

    // Fetch topic name
    const { rows: [topic] } = await query(
      'SELECT id, name FROM survey_topics WHERE id = $1 AND survey_id = $2 AND org_id = $3',
      [topicId, surveyId, req.orgId],
    ).catch(() => ({ rows: [] }));

    if (!topic) { res.status(404).json({ error: 'Topic not found' }); return; }
    const topicRow = topic as { id: string; name: string };

    // Strategy 1: ai_topics tagged responses
    let quotes: Record<string, unknown>[] = [];
    try {
      const { rows } = await query(
        `SELECT r.id, r.answers, r.nps_score, r.submitted_at
         FROM responses r
         WHERE r.survey_id = $1 AND r.org_id = $2
           AND r.ai_topics IS NOT NULL
           AND $3 = ANY(SELECT jsonb_array_elements_text(r.ai_topics))
         ORDER BY r.submitted_at DESC LIMIT 20`,
        [surveyId, req.orgId, topicRow.name],
      );
      quotes = rows as Record<string, unknown>[];
    } catch { /* ai_topics column may not exist */ }

    // Strategy 2: keyword search in text answers (fallback or supplement)
    if (quotes.length < 5) {
      try {
        const keywords = topicRow.name.toLowerCase().split(/\s+/).filter(w => w.length >= 3);
        if (keywords.length > 0) {
          const ilikeParts = keywords.map((_, i) => `r.answers::text ILIKE $${i + 3}`);
          const { rows: kwRows } = await query(
            `SELECT r.id, r.answers, r.nps_score, r.submitted_at
             FROM responses r
             WHERE r.survey_id = $1 AND r.org_id = $2
               AND (${ilikeParts.join(' OR ')})
             ORDER BY r.submitted_at DESC LIMIT 15`,
            [surveyId, req.orgId, ...keywords.map(w => `%${w}%`)],
          );
          // Merge — deduplicate by id
          const seen = new Set(quotes.map(q => q.id));
          for (const row of kwRows as Record<string, unknown>[]) {
            if (!seen.has(row.id)) { quotes.push(row); seen.add(row.id); }
          }
        }
      } catch { /* ignore */ }
    }

    // Extract text answer values from each response's answers JSONB
    const textTypes = new Set(['open_text', 'short_text', 'text']);
    const result = quotes.slice(0, 20).map(r => {
      const answers = Array.isArray(r.answers) ? r.answers as Record<string, unknown>[] : [];
      const texts = answers
        .filter(a => !a.type || textTypes.has(a.type as string))
        .map(a => (typeof a.value === 'string' ? a.value.trim() : ''))
        .filter(Boolean);
      return {
        response_id:  r.id,
        texts,
        nps_score:    r.nps_score,
        submitted_at: r.submitted_at,
      };
    }).filter(r => r.texts.length > 0);

    res.json({ topic_id: topicId, topic_name: topicRow.name, quotes: result });
  } catch (err: unknown) {
    logger.error({ err: (err as Error).message, surveyId, topicId }, 'insights:quotes:error');
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

// ── POST /:surveyId/crystal — stateful Crystal chat with thread persistence ───

router.post('/:surveyId/crystal', async (req: Request, res: Response): Promise<void> => {
  const { surveyId } = req.params;
  const body = req.body as Record<string, unknown>;
  const { message, window: timeWindow = 'all_time', focused_topic } = body;

  if (!message || typeof message !== 'string' || (message as string).trim().length < 2) {
    res.status(400).json({ error: 'message is required' });
    return;
  }

  // Validate time window to prevent SQL injection
  const validWindows = ['all_time', '30d', '7d'];
  const safeWindow = validWindows.includes(timeWindow as string) ? (timeWindow as string) : 'all_time';

  try {
    const survey = await getSurvey(surveyId, req.orgId);
    if (!survey) { res.status(404).json({ error: 'Survey not found' }); return; }

    // Rate limiting — Crystal is conversational; 20 turns/min per org+survey is generous.
    const redis = getRedisClient();
    if (redis) {
      const key = `rate:crystal:${req.orgId}:${surveyId}`;
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, 60);
      if (count > 20) {
        clientError(res, 429, 'Too many Crystal messages — try again in a minute.');
        return;
      }
    }

    // Credit metering — a Crystal conversational turn is a metered AI action.
    const crystalCheck = await checkCredits(req.orgId, CREDIT_COSTS.crystal_turn, 'crystal_turn');
    if (!crystalCheck.ok) {
      res.status(402).json({
        error:     'Not enough credits to ask Crystal.',
        code:      'INSUFFICIENT_CREDITS',
        required:  crystalCheck.required,
        available: crystalCheck.available,
      });
      return;
    }

    // Load current insights — try with time_window filter first, fall back without
    let insights: Record<string, unknown>[] = [];
    try {
      const { rows } = await query(
        `SELECT id, layer, category, headline, narrative, metric_json, citations_json,
                trust_score, priority, trust_json
         FROM insights
         WHERE survey_id = $1 AND org_id = $2 AND superseded_at IS NULL
           AND time_window = $3
         ORDER BY priority DESC NULLS LAST LIMIT 30`,
        [surveyId, req.orgId, safeWindow],
      );
      // Fall back to all_time if window had no results
      if (!rows.length && safeWindow !== 'all_time') {
        const { rows: fallback } = await query(
          `SELECT id, layer, category, headline, narrative, metric_json, citations_json,
                  trust_score, priority, trust_json
           FROM insights
           WHERE survey_id = $1 AND org_id = $2 AND superseded_at IS NULL
           ORDER BY priority DESC NULLS LAST LIMIT 30`,
          [surveyId, req.orgId],
        );
        insights = fallback as Record<string, unknown>[];
      } else {
        insights = rows as Record<string, unknown>[];
      }
    } catch {
      // time_window column may not exist in older DBs — fall back without it
      const { rows } = await query(
        `SELECT id, layer, category, headline, narrative, metric_json, citations_json,
                trust_score, priority, trust_json
         FROM insights
         WHERE survey_id = $1 AND org_id = $2 AND superseded_at IS NULL
         ORDER BY priority DESC NULLS LAST LIMIT 30`,
        [surveyId, req.orgId],
      );
      insights = rows as Record<string, unknown>[];
    }

    // Try to load topics — use same time window, prioritize focused_topic
    let topics: Record<string, unknown>[] = [];
    try {
      const { rows: topicRows } = await query(
        `SELECT name, volume, sentiment_score, dominant_emotion, effort_score, trending, is_new,
                nps_avg, positive_pct, negative_pct
         FROM survey_topics WHERE survey_id = $1 AND org_id = $2 AND time_window = $3
         ORDER BY volume DESC LIMIT 25`,
        [surveyId, req.orgId, safeWindow],
      );
      const tr = topicRows as Record<string, unknown>[];
      // If focused_topic provided, move it to the front so Crystal sees it first
      if (focused_topic && typeof focused_topic === 'string') {
        const focusedIdx = tr.findIndex(
          t => (t.name as string).toLowerCase() === (focused_topic as string).toLowerCase(),
        );
        if (focusedIdx > 0) {
          const [ft] = tr.splice(focusedIdx, 1);
          tr.unshift(ft);
        }
      }
      topics = tr;
    } catch { /* topics table may not exist */ }

    // Load conversation thread (graceful if table missing)
    const threadKey = `crystal:${req.orgId}:${surveyId}`;
    let thread: Record<string, unknown> | null = null;
    try {
      const { rows } = await query(
        'SELECT * FROM crystal_threads WHERE thread_key = $1',
        [threadKey],
      );
      thread = (rows[0] as Record<string, unknown>) || null;
    } catch { /* crystal_threads table may not exist */ }

    const history = (thread?.messages as unknown[]) || [];

    // Derive key metrics from insight rows
    const npsInsight  = insights.find(i => i.category === 'metric.nps');
    const csatInsight = insights.find(i => i.category === 'metric.csat');
    const metrics = {
      nps:            (npsInsight?.metric_json as Record<string, unknown>)  || null,
      csat:           (csatInsight?.metric_json as Record<string, unknown>) || null,
      response_count: (npsInsight?.trust_json as Record<string, unknown>)?.sample_size || (csatInsight?.trust_json as Record<string, unknown>)?.sample_size || 0,
    };

    // Build agent payload
    const agentPayload = {
      survey_id:             surveyId,
      org_id:                req.orgId,
      message:               (message as string).trim(),
      insights: insights.map(i => ({
        id:          i.id,
        layer:       i.layer,
        category:    i.category,
        headline:    i.headline,
        narrative:   i.narrative,
        metric_json: i.metric_json,
        trust_score: i.trust_score,
      })),
      topics,
      survey_title:          survey.title || '',
      survey_response_count: metrics.response_count,
      metrics,
      conversation_history:  (history as unknown[]).slice(-10),
      page_context: {
        time_window:   safeWindow,
        focused_topic: (focused_topic && typeof focused_topic === 'string') ? focused_topic : null,
      },
    };

    const response = await _agentsFetch('/insights/crystal', {
      method: 'POST',
      body:   JSON.stringify(agentPayload),
    }, CRYSTAL_TIMEOUT_MS) as Record<string, unknown>;

    // Debit one Crystal turn now that we have a successful answer (pre-checked above).
    try {
      await debitCredits(req.orgId, {
        actionType: 'crystal_turn',
        credits:    CREDIT_COSTS.crystal_turn,
        userId:     req.userId,
        actionRef:  surveyId,
        note:       'Crystal conversational turn',
      });
    } catch (err) {
      logger.warn({ err: (err as Error).message, surveyId }, 'insights:crystal:debit_failed');
    }

    // Persist thread — keep last 20 exchanges (40 messages)
    const userMsg      = { role: 'user',      content: (message as string).trim(),  created_at: new Date().toISOString() };
    const assistantMsg = { role: 'assistant', content: response.answer, created_at: new Date().toISOString() };
    const newMessages  = [...(history as unknown[]), userMsg, assistantMsg].slice(-40);

    try {
      await query(
        `INSERT INTO crystal_threads (org_id, survey_id, thread_key, messages, context_snapshot, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, NOW())
         ON CONFLICT (thread_key) DO UPDATE SET
           messages = $4::jsonb, updated_at = NOW()`,
        [
          req.orgId, surveyId, threadKey,
          JSON.stringify(newMessages),
          JSON.stringify({ insight_count: insights.length, generated_at: new Date().toISOString() }),
        ],
      );
    } catch { /* graceful degradation if crystal_threads table not yet migrated */ }

    res.json({
      answer:       response.answer,
      suggestions:  response.suggestions  || [],
      insight_refs: response.insight_refs || [],
      citations:    response.citations    || [],
      thread_key:   threadKey,
    });
  } catch (err: unknown) {
    logger.error({ err: (err as Error).message, surveyId }, 'insights:crystal:error');
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

// ── GET /:surveyId/crystal/history — load conversation history ────────────────

router.get('/:surveyId/crystal/history', async (req: Request, res: Response): Promise<void> => {
  const threadKey = `crystal:${req.orgId}:${req.params.surveyId}`;
  try {
    const { rows } = await query(
      'SELECT messages, updated_at FROM crystal_threads WHERE thread_key = $1',
      [threadKey],
    );
    const thread = rows[0] as Record<string, unknown> | undefined;
    res.json({
      messages:   thread?.messages   || [],
      updated_at: thread?.updated_at || null,
    });
  } catch {
    res.json({ messages: [], updated_at: null });
  }
});

// ── DELETE /:surveyId/crystal/history — clear thread history ─────────────────

router.delete('/:surveyId/crystal/history', async (req: Request, res: Response): Promise<void> => {
  const threadKey = `crystal:${req.orgId}:${req.params.surveyId}`;
  try {
    await query('DELETE FROM crystal_threads WHERE thread_key = $1', [threadKey]);
  } catch { /* ok if table missing */ }
  res.json({ success: true });
});

// ── POST /:surveyId/schedule — manually toggle scheduled generation ───────────

router.post('/:surveyId/schedule', async (req: Request, res: Response): Promise<void> => {
  const { surveyId } = req.params;
  const { enabled = true } = req.body as { enabled?: boolean };

  try {
    const survey = await getSurvey(surveyId, req.orgId);
    if (!survey) { res.status(404).json({ error: 'Survey not found' }); return; }

    await query(
      `UPDATE surveys SET insight_schedule_enabled = $1 WHERE id = $2 AND org_id = $3`,
      [enabled, surveyId, req.orgId],
    ).catch(() => {
      // Column may not exist yet in older DBs — ignore gracefully
    });

    logger.info({ surveyId, orgId: req.orgId, enabled }, 'insights:schedule:toggled');
    res.json({ success: true, survey_id: surveyId, scheduled: enabled });
  } catch (err: unknown) {
    logger.error({ err: (err as Error).message, surveyId }, 'insights:schedule:error');
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

// ── GET /:surveyId/topics/hierarchy ──────────────────────────────────────────

router.get('/:surveyId/topics/hierarchy', async (req: Request, res: Response): Promise<void> => {
  const { surveyId } = req.params;
  const window = (req.query.window as string) || 'all_time';

  try {
    const survey = await getSurvey(surveyId, req.orgId);
    if (!survey) { res.status(404).json({ error: 'Survey not found' }); return; }

    let rows: Record<string, unknown>[] = [];
    try {
      const result = await query(
        `SELECT id, name, theme, aliases, volume, volume_delta, volume_delta_pct,
                sentiment_score, dominant_emotion, effort_score, trending,
                sentiment_momentum, urgency_score, chronic, nps_avg, nps_correlation,
                positive_pct, negative_pct, is_new, first_seen_at, last_seen_at,
                hierarchy_level, parent_topic_id,
                (SELECT COUNT(*)::int FROM survey_topics c
                 WHERE c.parent_topic_id = survey_topics.id) AS sub_topic_count
         FROM survey_topics
         WHERE survey_id = $1 AND org_id = $2 AND time_window = $3
         ORDER BY volume DESC`,
        [surveyId, req.orgId, window],
      );
      rows = result.rows as Record<string, unknown>[];
    } catch (colErr: unknown) {
      // One or more new columns missing — fall back to base columns only
      logger.warn({ err: (colErr as Error).message, surveyId }, 'insights:hierarchy:column_fallback');
      try {
        const result = await query(
          `SELECT id, name, aliases, volume, volume_delta, volume_delta_pct,
                  sentiment_score, dominant_emotion, effort_score, trending,
                  sentiment_momentum, urgency_score, chronic, nps_avg,
                  positive_pct, negative_pct, is_new, first_seen_at, last_seen_at,
                  NULL::text   AS theme,
                  NULL::numeric AS nps_correlation,
                  NULL::int    AS hierarchy_level,
                  NULL::uuid   AS parent_topic_id,
                  0            AS sub_topic_count
           FROM survey_topics
           WHERE survey_id = $1 AND org_id = $2 AND time_window = $3
           ORDER BY volume DESC`,
          [surveyId, req.orgId, window],
        );
        rows = result.rows as Record<string, unknown>[];
      } catch {
        rows = [];
      }
    }

    // Separate root topics from subtopics
    const isRoot = (t: Record<string, unknown>): boolean =>
      t.hierarchy_level === 0 ||
      t.hierarchy_level === null ||
      t.parent_topic_id === null;

    const rootTopics = rows.filter(isRoot);
    const subtopics  = rows.filter(t => !isRoot(t));

    // Build a map: parent_id → subtopic[]
    const subtopicsByParent: Record<string, Record<string, unknown>[]> = {};
    for (const st of subtopics) {
      const pid = st.parent_topic_id as string;
      if (pid) {
        if (!subtopicsByParent[pid]) subtopicsByParent[pid] = [];
        subtopicsByParent[pid].push(st);
      }
    }

    // Attach subtopics to each root topic
    const topicsWithSubs = rootTopics.map(t => ({
      ...t,
      subtopics: subtopicsByParent[t.id as string] || [],
    })) as Array<Record<string, unknown>>;

    // Group root topics by theme
    const themeMap = new Map<string, { name: string; _volume: number; _sentiment_sum: number; _sentiment_count: number; topics: Record<string, unknown>[] }>();
    for (const t of topicsWithSubs) {
      const themeName = (t.theme && (t.theme as string).trim()) ? (t.theme as string).trim() : null;
      const groupKey  = themeName || (t.name as string);

      if (!themeMap.has(groupKey)) {
        themeMap.set(groupKey, {
          name:            groupKey,
          _volume:         0,
          _sentiment_sum:  0,
          _sentiment_count: 0,
          topics:          [],
        });
      }
      const group = themeMap.get(groupKey)!;
      group.topics.push(t);
      group._volume += ((t.volume as number) || 0);
      if (t.sentiment_score != null) {
        group._sentiment_sum   += parseFloat(String(t.sentiment_score));
        group._sentiment_count += 1;
      }
    }

    // Build final themes array — sort by total volume descending
    const themes = Array.from(themeMap.values())
      .map(g => ({
        name:         g.name,
        volume:       g._volume,
        sentiment_avg: g._sentiment_count > 0
          ? Math.round((g._sentiment_sum / g._sentiment_count) * 1000) / 1000
          : null,
        topics: g.topics,
      }))
      .sort((a, b) => b.volume - a.volume);

    res.json({
      themes,
      total_topics: rows.length,
      window,
    });
  } catch (err: unknown) {
    logger.error({ err: (err as Error).message, surveyId }, 'insights:hierarchy:error');
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

// ── GET /:surveyId/topics/:topicId/detail ─────────────────────────────────────

router.get('/:surveyId/topics/:topicId/detail', async (req: Request, res: Response): Promise<void> => {
  const { surveyId, topicId } = req.params;
  const window = (req.query.window as string) || 'all_time';

  try {
    const survey = await getSurvey(surveyId, req.orgId);
    if (!survey) { res.status(404).json({ error: 'Survey not found' }); return; }

    // Fetch the topic itself
    const { rows: topicRows } = await query(
      'SELECT * FROM survey_topics WHERE id = $1 AND survey_id = $2 AND org_id = $3',
      [topicId, surveyId, req.orgId],
    );
    if (!topicRows.length) { res.status(404).json({ error: 'Topic not found' }); return; }
    const topic = topicRows[0] as Record<string, unknown>;

    // ── 1. Trend series (last 30 days) ─────────────────────────────────────────
    let trendSeries: Record<string, unknown>[] = [];
    try {
      const { rows: trendRows } = await query(
        `SELECT
           DATE_TRUNC('day', submitted_at)::date AS day,
           COUNT(*)::int AS volume,
           AVG(CASE WHEN nps_score IS NOT NULL THEN nps_score END) AS avg_nps,
           COUNT(CASE WHEN nps_score >= 9 THEN 1 END)::int AS promoters,
           COUNT(CASE WHEN nps_score <= 6 THEN 1 END)::int AS detractors
         FROM responses
         WHERE survey_id = $1 AND org_id = $2
           AND submitted_at > NOW() - INTERVAL '30 days'
           AND ai_topics @> jsonb_build_array($3::text)
         GROUP BY DATE_TRUNC('day', submitted_at)::date
         ORDER BY day ASC`,
        [surveyId, req.orgId, topic.name],
      );
      trendSeries = (trendRows as Record<string, unknown>[]).map(r => ({
        day:        r.day,
        volume:     r.volume,
        avg_nps:    r.avg_nps != null ? Math.round(parseFloat(String(r.avg_nps)) * 10) / 10 : null,
        promoters:  r.promoters,
        detractors: r.detractors,
      }));
    } catch (trendErr: unknown) {
      logger.warn({ err: (trendErr as Error).message, topicId }, 'insights:detail:trend_fallback');
      trendSeries = [];
    }

    // ── 2. Co-occurring topics ──────────────────────────────────────────────────
    let coOccurring: Record<string, unknown>[] = [];
    try {
      const { rows: coRows } = await query(
        `SELECT topic_name, COUNT(*)::int AS co_count
         FROM (
           SELECT jsonb_array_elements_text(ai_topics) AS topic_name
           FROM responses
           WHERE survey_id = $1 AND org_id = $2
             AND ai_topics IS NOT NULL
             AND $3 = ANY(SELECT jsonb_array_elements_text(ai_topics))
         ) co
         WHERE topic_name != $4
         GROUP BY topic_name
         ORDER BY co_count DESC
         LIMIT 5`,
        [surveyId, req.orgId, topic.name, topic.name],
      );
      coOccurring = (coRows as Record<string, unknown>[]).map(r => ({
        name:     r.topic_name,
        co_count: r.co_count,
        lift: null,
      }));
    } catch (coErr: unknown) {
      logger.warn({ err: (coErr as Error).message, topicId }, 'insights:detail:co_occurring_fallback');
      coOccurring = [];
    }

    // ── 3. Subtopics ───────────────────────────────────────────────────────────
    let subtopics: Record<string, unknown>[] = [];
    try {
      const { rows: subRows } = await query(
        `SELECT id, name, volume, sentiment_score, trending, dominant_emotion, urgency_score
         FROM survey_topics
         WHERE parent_topic_id = $1 AND org_id = $2 AND survey_id = $3
         ORDER BY volume DESC`,
        [topicId, req.orgId, surveyId],
      );
      subtopics = subRows as Record<string, unknown>[];
    } catch {
      subtopics = [];
    }

    res.json({
      topic,
      detail: {
        trend_series: trendSeries,
        co_occurring: coOccurring,
        subtopics,
      },
      window,
    });
  } catch (err: unknown) {
    logger.error({ err: (err as Error).message, surveyId, topicId }, 'insights:detail:error');
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

// ── GET /:surveyId/topics/:topicId/verbatims ──────────────────────────────────

router.get('/:surveyId/topics/:topicId/verbatims', async (req: Request, res: Response): Promise<void> => {
  const { surveyId, topicId } = req.params;

  // Parse and clamp pagination params
  const limit  = Math.min(parseInt(req.query.limit  as string, 10) || 50, 100);
  const offset = Math.max(parseInt(req.query.offset as string, 10) || 0, 0);

  // Validated filter params
  const VALID_SENTIMENTS  = new Set(['all', 'positive', 'negative', 'neutral']);
  const VALID_NPS_BUCKETS = new Set(['all', 'promoter', 'passive', 'detractor']);
  const sentiment  = VALID_SENTIMENTS.has(req.query.sentiment as string)   ? req.query.sentiment as string   : 'all';
  const npsBucket  = VALID_NPS_BUCKETS.has(req.query.nps_bucket as string) ? req.query.nps_bucket as string  : 'all';

  // Time window — filter verbatims by submission date
  const window = WINDOW_MAP[req.query.window as string] ?? 'all_time';

  try {
    const survey = await getSurvey(surveyId, req.orgId);
    if (!survey) { res.status(404).json({ error: 'Survey not found' }); return; }

    // Fetch topic name (needed for JSONB text search)
    const { rows: topicRows } = await query(
      'SELECT id, name FROM survey_topics WHERE id = $1 AND survey_id = $2 AND org_id = $3',
      [topicId, surveyId, req.orgId],
    );
    if (!topicRows.length) { res.status(404).json({ error: 'Topic not found' }); return; }
    const topic = topicRows[0] as { id: string; name: string };

    // ── Build parameterized WHERE clauses for filters ──────────────────────────
    const baseParams: unknown[] = [surveyId, req.orgId, topic.name];
    const filterClauses: string[] = [];

    // Sentiment filter
    if (sentiment !== 'all') {
      baseParams.push(sentiment);
      filterClauses.push(`r.ai_sentiment = $${baseParams.length}`);
    }

    // NPS bucket filter
    if (npsBucket !== 'all') {
      if (npsBucket === 'promoter') {
        filterClauses.push(`r.nps_score >= 9`);
      } else if (npsBucket === 'passive') {
        filterClauses.push(`r.nps_score BETWEEN 7 AND 8`);
      } else if (npsBucket === 'detractor') {
        filterClauses.push(`r.nps_score <= 6`);
      }
    }

    // Time window filter on submission date
    if (window === 'last_7d') {
      filterClauses.push(`r.submitted_at >= NOW() - INTERVAL '7 days'`);
    } else if (window === 'last_30d') {
      filterClauses.push(`r.submitted_at >= NOW() - INTERVAL '30 days'`);
    }

    const filterSql = filterClauses.length > 0
      ? ' AND ' + filterClauses.join(' AND ')
      : '';

    // ── Fetch rows via ai_topics GIN index ─────────────────────────────────────
    let rows: Record<string, unknown>[] = [];
    let total = 0;

    try {
      // Count query (same filters, no limit/offset)
      const countParams = [...baseParams];
      const { rows: countRows } = await query(
        `SELECT COUNT(*)::int AS cnt
         FROM responses r
         WHERE r.survey_id = $1 AND r.org_id = $2
           AND r.ai_topics IS NOT NULL
           AND $3 = ANY(SELECT jsonb_array_elements_text(r.ai_topics))
           ${filterSql}`,
        countParams,
      );
      total = (countRows[0] as { cnt: number })?.cnt || 0;

      // Data query
      const dataParams = [...baseParams, limit, offset];
      const { rows: dataRows } = await query(
        `SELECT r.id, r.answers, r.nps_score, r.submitted_at,
                r.ai_topics, r.ai_sentiment, r.ai_sentiment_score
         FROM responses r
         WHERE r.survey_id = $1 AND r.org_id = $2
           AND r.ai_topics IS NOT NULL
           AND $3 = ANY(SELECT jsonb_array_elements_text(r.ai_topics))
           ${filterSql}
         ORDER BY r.submitted_at DESC
         LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
        dataParams,
      );
      rows = dataRows as Record<string, unknown>[];
    } catch (tagErr: unknown) {
      logger.warn({ err: (tagErr as Error).message, topicId }, 'insights:verbatims:ai_topics_fallback');
      rows  = [];
      total = 0;
    }

    // ── Extract verbatim text from answers JSONB ───────────────────────────────
    const TEXT_TYPES = new Set(['open_text', 'short_text', 'text']);

    const verbatims = rows
      .map(r => {
        const answers = Array.isArray(r.answers) ? r.answers as Record<string, unknown>[] : [];
        const allTexts = answers
          .filter(a => !a.type || TEXT_TYPES.has(a.type as string))
          .map(a => (typeof a.value === 'string' ? a.value.trim() : ''))
          .filter(Boolean);

        if (!allTexts.length) return null;

        return {
          response_id:     r.id,
          text:            allTexts[0],
          all_texts:       allTexts,
          nps_score:       r.nps_score,
          sentiment:       r.ai_sentiment       || null,
          sentiment_score: r.ai_sentiment_score != null
            ? Math.round(parseFloat(String(r.ai_sentiment_score)) * 1000) / 1000
            : null,
          submitted_at:    r.submitted_at,
          topics:          Array.isArray(r.ai_topics) ? r.ai_topics : [],
        };
      })
      .filter(Boolean);

    res.json({
      verbatims,
      total,
      has_more: offset + verbatims.length < total,
      limit,
      offset,
    });
  } catch (err: unknown) {
    logger.error({ err: (err as Error).message, surveyId, topicId }, 'insights:verbatims:error');
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

// ── PATCH /:surveyId/topics/:topicId — rename a topic ────────────────────────

router.patch('/:surveyId/topics/:topicId', async (req: Request, res: Response): Promise<void> => {
  const { surveyId, topicId } = req.params;
  const { name } = req.body as { name?: unknown };

  if (!name || typeof name !== 'string' || !(name as string).trim()) {
    res.status(400).json({ error: 'name is required' });
    return;
  }

  try {
    const survey = await getSurvey(surveyId, req.orgId);
    if (!survey) { res.status(404).json({ error: 'Survey not found' }); return; }

    // Fetch current name before update so we can cascade to insight headlines
    const { rows: [existing] } = await query(
      'SELECT name FROM survey_topics WHERE id = $1 AND survey_id = $2 AND org_id = $3',
      [topicId, surveyId, req.orgId],
    );
    if (!existing) { res.status(404).json({ error: 'Topic not found' }); return; }

    const oldName  = (existing as { name: string }).name;
    const newName  = (name as string).trim();

    await query(
      'UPDATE survey_topics SET name = $1 WHERE id = $2 AND survey_id = $3 AND org_id = $4',
      [newName, topicId, surveyId, req.orgId],
    );

    // Cascade rename into active voice.topic insight headlines so they stay in sync
    if (oldName !== newName) {
      await query(
        `UPDATE insights
         SET headline = REPLACE(headline, $1, $2)
         WHERE survey_id = $3 AND org_id = $4
           AND category = 'voice.topic' AND superseded_at IS NULL`,
        [oldName, newName, surveyId, req.orgId],
      ).catch(() => {}); // non-critical — best-effort
    }

    res.json({ success: true, name: newName });
  } catch (err: unknown) {
    logger.error({ err: (err as Error).message, surveyId, topicId }, 'insights:topic:rename:error');
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

// ── GET /:surveyId/metric-history ────────────────────────────────────────────

router.get('/:surveyId/metric-history', async (req: Request, res: Response): Promise<void> => {
  const { surveyId } = req.params;
  const days = Math.min(parseInt(req.query.days as string, 10) || 90, 365);
  try {
    const survey = await getSurvey(surveyId, req.orgId);
    if (!survey) { res.status(404).json({ error: 'Survey not found' }); return; }

    const { rows } = await query(
      `SELECT captured_at, response_count,
              nps, nps_ci_low, nps_ci_high, nps_n,
              promoter_pct, detractor_pct, passive_pct,
              csat, completion_rate, effort_score,
              response_velocity_7d, anomaly_flag
       FROM survey_metric_snapshots
       WHERE survey_id = $1 AND org_id = $2
         AND captured_at >= NOW() - ($3 * INTERVAL '1 day')
       ORDER BY captured_at ASC`,
      [surveyId, req.orgId, days],
    ).catch(() => ({ rows: [] }));

    res.json({ history: rows, days, survey_id: surveyId });
  } catch (err: unknown) {
    logger.error({ err: (err as Error).message, surveyId }, 'insights:metric-history:error');
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

// ── GET /:surveyId/topic-trends ───────────────────────────────────────────────

router.get('/:surveyId/topic-trends', async (req: Request, res: Response): Promise<void> => {
  const { surveyId } = req.params;
  const weeks   = Math.min(parseInt(req.query.weeks as string, 10) || 12, 52);
  const topicId = (req.query.topicId as string) || null;

  try {
    const survey = await getSurvey(surveyId, req.orgId);
    if (!survey) { res.status(404).json({ error: 'Survey not found' }); return; }

    const params: unknown[] = [surveyId, req.orgId, weeks];
    let topicFilter = '';

    if (topicId) {
      const { rows: [topic] } = await query(
        'SELECT id FROM survey_topics WHERE id = $1 AND survey_id = $2 AND org_id = $3',
        [topicId, surveyId, req.orgId],
      ).catch(() => ({ rows: [] }));
      if (!topic) { res.status(404).json({ error: 'Topic not found' }); return; }
      params.push(topicId);
      topicFilter = `AND tw.topic_id = $${params.length}`;
    }

    const { rows } = await query(
      `SELECT tw.topic_id, st.name AS topic_name,
              tw.window_start, tw.window_end,
              tw.response_count,
              tw.avg_sentiment_score, tw.avg_nps, tw.health_label,
              tw.net_sentiment, tw.nps_impact, tw.urgency_score,
              tw.velocity_pct, tw.promoter_pct, tw.detractor_pct,
              tw.emotion_distribution
       FROM topic_windows tw
       JOIN survey_topics st ON tw.topic_id = st.id
       WHERE tw.survey_id = $1 AND tw.org_id = $2
         AND tw.window_start >= NOW() - ($3 * INTERVAL '1 week')
         ${topicFilter}
       ORDER BY tw.topic_id, tw.window_start ASC`,
      params,
    ).catch(() => ({ rows: [] }));

    // Group windows by topic_id
    const byTopic: Record<string, { topic_id: string; topic_name: string; windows: Record<string, unknown>[] }> = {};
    for (const row of rows as Record<string, unknown>[]) {
      const tid = row.topic_id as string;
      if (!byTopic[tid]) {
        byTopic[tid] = { topic_id: tid, topic_name: row.topic_name as string, windows: [] };
      }
      byTopic[tid].windows.push({
        window_start:         row.window_start,
        window_end:           row.window_end,
        response_count:       row.response_count,
        avg_sentiment_score:  row.avg_sentiment_score,
        avg_nps:              row.avg_nps,
        health_label:         row.health_label,
        net_sentiment:        row.net_sentiment,
        nps_impact:           row.nps_impact,
        urgency_score:        row.urgency_score,
        velocity_pct:         row.velocity_pct,
        promoter_pct:         row.promoter_pct,
        detractor_pct:        row.detractor_pct,
        emotion_distribution: row.emotion_distribution,
      });
    }

    res.json({ topics: Object.values(byTopic), weeks, survey_id: surveyId });
  } catch (err: unknown) {
    logger.error({ err: (err as Error).message, surveyId }, 'insights:topic-trends:error');
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

// ── GET /:surveyId/checkpoints ────────────────────────────────────────────────

router.get('/:surveyId/checkpoints', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { surveyId } = req.params;
  const { orgId } = req;
  try {
    // Try insight_checkpoints_v2 first (post-migration table); fall back to legacy
    // survey_insight_checkpoints so the endpoint returns data on both old and new schemas.
    let rows: unknown[] = [];
    try {
      const result = await query(
        `SELECT id, checkpoint_number,
                nps_at_checkpoint, csat_at_checkpoint,
                created_at, (report_blob_ref IS NOT NULL) as has_report
         FROM insight_checkpoints_v2
         WHERE survey_id = $1 AND org_id = $2
         ORDER BY checkpoint_number DESC
         LIMIT 20`,
        [surveyId, orgId]
      );
      if (result.rows.length) {
        rows = result.rows;
      }
    } catch {
      // insight_checkpoints_v2 not migrated yet — fall through to legacy
    }
    if (!rows.length) {
      const result = await query(
        `SELECT id, checkpoint_number, response_count_at_checkpoint,
                nps_at_checkpoint, csat_at_checkpoint, topic_fingerprint,
                created_at, (report_url IS NOT NULL) as has_report
         FROM survey_insight_checkpoints
         WHERE survey_id = $1 AND org_id = $2
         ORDER BY checkpoint_number DESC
         LIMIT 20`,
        [surveyId, orgId]
      );
      rows = result.rows;
    }
    // Phase 7: deprecation headers — clients should migrate to GET /api/insights/:surveyId/trail
    res.set('Deprecation', 'true');
    res.set('Sunset', new Date(Date.now() + 90 * 86400000).toUTCString()); // 90 days from now
    res.set('Link', '</api/insights/:surveyId/trail>; rel="successor-version"');
    res.json({ checkpoints: rows });
  } catch (err: unknown) {
    serverError(res, err instanceof Error ? err : new Error(String(err)), { endpoint: 'checkpoints_list', surveyId });
  }
});

// ── GET /:surveyId/checkpoints/:checkpointId/report ───────────────────────────

router.get('/:surveyId/checkpoints/:checkpointId/report', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { surveyId, checkpointId } = req.params;
  const { orgId } = req;
  try {
    // Fixed 2026-07-04: this used to query ONLY survey_insight_checkpoints (legacy)
    // by id, so any checkpointId from insight_checkpoints_v2 (e.g. ids returned by
    // the /checkpoints list above, which is v2-first) would 404 here even though
    // the checkpoint exists. Reuses loadCheckpointRow (v2-then-legacy, ownership
    // scoped) — the same lookup GET /trail/:checkpointId already uses.
    const found = await loadCheckpointRow(checkpointId, surveyId, orgId);
    if (!found) { clientError(res, 404, 'checkpoint_not_found'); return; }
    const blobRef = (found.row.report_blob_ref as string | null) ?? (found.row.report_url as string | null) ?? null;
    if (!blobRef) { clientError(res, 404, 'report_not_ready'); return; }

    const isProduction = process.env.NODE_ENV === 'production' || process.env.AGENTS_ENV === 'staging';
    if (isProduction) {
      const url = await agentsClient.getCheckpointReadUrl(blobRef);
      res.json({ url, expires_in_seconds: 900 });
    } else {
      const blob = await agentsClient.getCheckpointBlob(blobRef);
      res.json(blob);
    }
  } catch (err: unknown) {
    serverError(res, err instanceof Error ? err : new Error(String(err)), { endpoint: 'checkpoint_report', surveyId, checkpointId });
  }
});

// ── POST /:surveyId/trigger ───────────────────────────────────────────────────

router.post('/:surveyId/trigger', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { surveyId } = req.params;
  const { orgId } = req;
  const redis = getRedisClient();

  try {
    // Validate survey belongs to org and is active
    const { rows: surveyRows } = await query(
      `SELECT status, (SELECT COUNT(*)::int FROM responses WHERE survey_id = surveys.id) AS response_count
       FROM surveys WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`,
      [surveyId, orgId]
    );
    if (!surveyRows.length) { clientError(res, 404, 'survey_not_found'); return; }
    const surveyRow = surveyRows[0] as { status: string; response_count: number };
    if (surveyRow.status !== 'active') {
      clientError(res, 409, 'insights_pipeline_suspended');
      return;
    }

    // Rate limiting: Redis first; DB count fallback when Redis unavailable.
    // Use explicit UTC midnight for the window start — avoids Postgres server timezone drift
    // when casting a date string to TIMESTAMPTZ (e.g. server in PST would shift the window by 8h).
    const todayUtcDate = new Date().toISOString().split('T')[0];
    const todayUtcMidnight = `${todayUtcDate}T00:00:00Z`;
    const rateKey = `manual_refresh:${orgId}:${surveyId}:${todayUtcDate}`;
    if (redis) {
      const count = await redis.incr(rateKey);
      if (count === 1) await redis.expire(rateKey, 86400);
      if (count > REFRESH_DAILY_LIMIT) {
        res.status(429).json({ error: 'daily_limit_reached', limit: REFRESH_DAILY_LIMIT });
        return;
      }
    } else {
      const { rows: [{ run_count }] } = await query<{ run_count: number }>(
        `SELECT COUNT(*)::int AS run_count FROM agent_runs
         WHERE survey_id = $1 AND org_id = $2 AND run_type = 'insight_generation'
           AND intent = 'manual_refresh' AND created_at >= $3::timestamptz`,
        [surveyId, orgId, todayUtcMidnight]
      );
      if (run_count >= REFRESH_DAILY_LIMIT) {
        res.status(429).json({ error: 'daily_limit_reached', limit: REFRESH_DAILY_LIMIT });
        return;
      }
    }

    // Credit pre-flight
    const creditCost = CREDIT_COSTS.insight_run;
    const creditCheck = await checkCredits(orgId, creditCost, 'manual_refresh');
    if (!creditCheck.ok) {
      res.status(402).json({ error: 'insufficient_credits', required: creditCost, available: creditCheck.available });
      return;
    }

    // Check min new responses
    const { rows: lastRun } = await query(
      `SELECT response_count_at_run FROM agent_runs
       WHERE survey_id = $1 AND org_id = $2 AND run_type = 'insight_generation'
         AND status = 'completed'
       ORDER BY completed_at DESC LIMIT 1`,
      [surveyId, orgId]
    );
    const lastCount = ((lastRun[0] as Record<string, unknown> | undefined)?.response_count_at_run as number) || 0;
    const currentCount = surveyRow.response_count || 0;
    const minNewResponses = 10;
    if (currentCount - lastCount < minNewResponses) {
      res.status(400).json({ error: 'min_responses_not_met', required: minNewResponses, new_responses: currentCount - lastCount });
      return;
    }

    // Create run, debit credits, and trigger
    const { rows: runRows } = await query(
      `INSERT INTO agent_runs (org_id, user_id, thread_id, run_type, status, intent, survey_id, response_count_at_run)
       VALUES ($1, $2, $3, 'insight_generation', 'running', 'manual_refresh', $4, $5)
       RETURNING id`,
      [orgId, req.userId, `manual:${orgId}:${surveyId}:${Date.now()}`, surveyId, currentCount]
    );
    const runId = (runRows[0] as { id: string }).id;

    await debitCredits(orgId, { actionType: 'insight_run', credits: creditCost, userId: req.userId, actionRef: runId });
    await agentsClient.triggerInsightGeneration({ surveyId, orgId, runId, trigger: 'manual', force_regenerate: true } as Parameters<typeof agentsClient.triggerInsightGeneration>[0]);
    res.json({ run_id: runId, status: 'triggered' });
  } catch (err: unknown) {
    serverError(res, err instanceof Error ? err : new Error(String(err)), { endpoint: 'trigger_insights', surveyId });
  }
});

// ── GET /api/insights/:surveyId/actions ──────────────────────────────────────

router.get('/:surveyId/actions', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { surveyId } = req.params;
  try {
    const { rows } = await query(
      `SELECT actions_json, urgency_level, summary, generated_at, dismissed_ids
       FROM action_recommendations
       WHERE survey_id = $1 AND org_id = $2
       LIMIT 1`,
      [surveyId, req.orgId],
    ).catch(() => ({ rows: [] }));

    if (!rows.length) {
      res.json({ actions: [], urgency_level: null, summary: null, generated_at: null });
      return;
    }

    const row = rows[0] as { actions_json: unknown[]; urgency_level: string | null; summary: string | null; generated_at: string | null; dismissed_ids: string[] | null };
    const { actions_json, urgency_level, summary, generated_at, dismissed_ids } = row;
    const dismissedSet = new Set(dismissed_ids || []);
    const actions = (actions_json || []).filter(a => !dismissedSet.has((a as { id: string }).id));

    res.json({ actions, urgency_level, summary, generated_at });
  } catch (err: unknown) {
    logger.error({ err: (err as Error).message, surveyId }, 'insights:actions:error');
    res.json({ actions: [], urgency_level: null, summary: null });
  }
});

// ── POST /api/insights/:surveyId/actions/:actionId/dismiss ────────────────────

router.post('/:surveyId/actions/:actionId/dismiss', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { surveyId, actionId } = req.params;
  try {
    await query(
      `UPDATE action_recommendations
       SET dismissed_ids = array_append(
         COALESCE(dismissed_ids, '{}'),
         $3::text
       )
       WHERE survey_id = $1 AND org_id = $2`,
      [surveyId, req.orgId, actionId],
    ).catch(() => {});
    res.json({ success: true });
  } catch (err: unknown) {
    logger.error({ err: (err as Error).message, surveyId, actionId }, 'insights:actions:dismiss:error');
    res.json({ success: false });
  }
});

// ── POST /api/insights/:surveyId/crystal/proposals ────────────────────────────
// Records the outcome of a Crystal action proposal (emitted/accepted/dismissed/
// succeeded/failed). UPSERTs on (org_id, proposal_key) so repeated calls for the
// same proposal update the existing row rather than duplicating it.

router.post('/:surveyId/crystal/proposals', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { surveyId } = req.params;
  const {
    proposalKey,
    type,
    params,
    priority,
    businessRationale,
    confidence,
    status,
    outcomeRef,
    errorDetail,
    brandId,
  } = req.body as Record<string, unknown>;

  if (typeof type !== 'string' || !type) {
    clientError(res, 400, 'type is required');
    return;
  }
  if (typeof status !== 'string' || !status) {
    clientError(res, 400, 'status is required');
    return;
  }

  try {
    const { rows } = await query(
      `INSERT INTO crystal_action_proposals
         (org_id, brand_id, survey_id, proposal_key, type, params, priority,
          business_rationale, confidence, status, outcome_ref, error_detail)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, '{}')::jsonb, COALESCE($7, 'medium'),
               $8, $9, $10, $11, $12)
       ON CONFLICT (org_id, proposal_key) WHERE proposal_key IS NOT NULL
       DO UPDATE SET
         status       = EXCLUDED.status,
         outcome_ref  = COALESCE(EXCLUDED.outcome_ref, crystal_action_proposals.outcome_ref),
         error_detail = EXCLUDED.error_detail,
         updated_at   = NOW()
       RETURNING *`,
      [
        req.orgId,
        brandId ?? null,
        surveyId,
        proposalKey ?? null,
        type,
        params != null ? JSON.stringify(params) : null,
        priority ?? null,
        businessRationale ?? null,
        confidence ?? null,
        status,
        outcomeRef ?? null,
        errorDetail ?? null,
      ],
    );
    res.json(rows[0]);
  } catch (err: unknown) {
    serverError(res, err instanceof Error ? err : new Error(String(err)), { endpoint: 'crystal_proposals', surveyId });
  }
});

// ── GET /api/insights/:surveyId/crystal/proposals ─────────────────────────────
// Recent proposals for the org (optionally filtered by status) — for future analytics.

router.get('/:surveyId/crystal/proposals', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { surveyId } = req.params;
  const status = typeof req.query.status === 'string' ? req.query.status : null;
  try {
    const params: unknown[] = [req.orgId, surveyId];
    let sql = `SELECT * FROM crystal_action_proposals WHERE org_id = $1 AND survey_id = $2`;
    if (status) {
      params.push(status);
      sql += ` AND status = $${params.length}`;
    }
    sql += ` ORDER BY updated_at DESC LIMIT 200`;

    const { rows } = await query(sql, params);
    res.json({ proposals: rows });
  } catch (err: unknown) {
    logger.error({ err: (err as Error).message, surveyId }, 'insights:crystal:proposals:list:error');
    res.json({ proposals: [] });
  }
});

// ── Insight settings (Phase 1) ────────────────────────────────────────────────

const SETTINGS_COLUMNS = INSIGHT_SETTING_KEYS.join(',\n         ');

// NUMERIC setting columns whose pg values arrive as strings and must be coerced.
const NUMERIC_SETTING_KEYS = new Set<InsightSettingKey>([
  'meaningful_delta_nps_points',
  'meaningful_delta_topic_pct',
]);

function coerceSettingValue(key: InsightSettingKey, value: unknown): unknown {
  if (value == null) return null;
  if (NUMERIC_SETTING_KEYS.has(key)) return parseFloat(String(value));
  return value;
}

/**
 * Resolve the verified Clerk org role for the request. In DEV_MODE there is no token,
 * so we grant admin (matches requireRole's DEV_MODE no-op). Returns the normalized
 * `org:<role>` string, or null when it can't be determined.
 */
async function resolveOrgRole(req: Request): Promise<string | null> {
  if (DEV_MODE) return 'org:admin';
  try {
    const token = req.headers.authorization?.slice(7);
    if (!token) return null;
    const payload = await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY! });
    return getOrgClaims(payload).orgRole;
  } catch {
    return null;
  }
}

// GET /api/insights/:surveyId/settings — effective + survey + org layers (any member)
router.get('/:surveyId/settings', async (req: Request, res: Response): Promise<void> => {
  const { surveyId } = req.params;
  try {
    const survey = await getSurvey(surveyId, req.orgId);
    if (!survey) { res.status(404).json({ error: 'Survey not found' }); return; }

    // Survey-level overrides (tolerate table not migrated yet → null layer).
    let surveyLayer: Record<string, unknown> = {};
    try {
      const { rows } = await query(
        `SELECT ${SETTINGS_COLUMNS}
         FROM survey_insight_settings WHERE survey_id = $1 AND org_id = $2`,
        [surveyId, req.orgId],
      );
      surveyLayer = (rows[0] as Record<string, unknown>) ?? {};
    } catch (e: unknown) {
      logger.warn({ err: (e as Error).message, surveyId }, 'insights:settings:survey_layer_unavailable');
    }

    // Org-level defaults — only the subset of keys that exist on org_insight_defaults
    // is present; others stay undefined and fall through to the platform constant.
    let orgLayer: Record<string, unknown> = {};
    try {
      const { rows } = await query(
        `SELECT * FROM org_insight_defaults WHERE org_id = $1`,
        [req.orgId],
      );
      orgLayer = (rows[0] as Record<string, unknown>) ?? {};
    } catch (e: unknown) {
      logger.warn({ err: (e as Error).message, orgId: req.orgId }, 'insights:settings:org_layer_unavailable');
    }

    // 3-level COALESCE merge: survey → org → platform constant.
    const effective: Record<string, unknown> = {};
    const surveyOverrides: Record<string, unknown> = {};
    const orgDefaults: Record<string, unknown> = {};
    for (const key of INSIGHT_SETTING_KEYS) {
      const sv = coerceSettingValue(key, surveyLayer[key]);
      const ov = coerceSettingValue(key, orgLayer[key]);
      if (sv != null) surveyOverrides[key] = sv;
      if (ov != null) orgDefaults[key] = ov;
      effective[key] = sv != null ? sv : (ov != null ? ov : INSIGHT_SETTING_DEFAULTS[key]);
    }

    const orgRole = await resolveOrgRole(req);
    const isAdmin = orgRole === 'org:admin';
    const isOwner = survey.created_by === req.userId;
    const editable = isAdmin || isOwner;

    res.json({
      survey_id:        surveyId,
      effective,
      survey_overrides: surveyOverrides,
      org_defaults:     orgDefaults,
      config_hash:      computeConfigHash(effective),
      config_version:   (surveyLayer.config_version as number) ?? null,
      editable,
    });
  } catch (err: unknown) {
    logger.error({ err: (err as Error).message, surveyId }, 'insights:settings:get:error');
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

// PATCH /api/insights/:surveyId/settings — brand_admin OR survey_owner
router.patch(
  '/:surveyId/settings',
  validate(updateInsightSettingsSchema),
  async (req: Request, res: Response): Promise<void> => {
    const { surveyId } = req.params;
    try {
      const survey = await getSurvey(surveyId, req.orgId);
      if (!survey) { res.status(404).json({ error: 'Survey not found' }); return; }

      // Authorization: admin OR the survey owner. requireRole('analyst') is insufficient
      // per 05_CONFIGURATION.md §8 — only brand_admin or the owning user may write.
      const orgRole = await resolveOrgRole(req);
      const isAdmin = orgRole === 'org:admin';
      const isOwner = survey.created_by === req.userId;
      if (!isAdmin && !isOwner) {
        res.status(403).json({
          error:    'Only org admins or the survey owner can change insight settings.',
          required: 'org:admin OR survey_owner',
          current:  orgRole,
        });
        return;
      }

      const patch = req.body as Record<string, unknown>;
      const keys = Object.keys(patch) as InsightSettingKey[];
      if (keys.length === 0) {
        res.status(400).json({ error: 'No settings provided' });
        return;
      }

      // Build a parameterized UPSERT. config_version bumps on every write.
      const insertCols = ['survey_id', 'org_id', ...keys, 'updated_by'];
      const insertParams: unknown[] = [surveyId, req.orgId, ...keys.map(k => patch[k]), req.userId];
      const placeholders = insertParams.map((_, i) => `$${i + 1}`);
      const updateAssignments = keys.map(k => `${k} = EXCLUDED.${k}`);
      updateAssignments.push('updated_by = EXCLUDED.updated_by');
      updateAssignments.push('config_version = survey_insight_settings.config_version + 1');
      updateAssignments.push('updated_at = NOW()');

      const { rows } = await query(
        `INSERT INTO survey_insight_settings (${insertCols.join(', ')})
         VALUES (${placeholders.join(', ')})
         ON CONFLICT (survey_id) DO UPDATE SET
           ${updateAssignments.join(',\n           ')}
         RETURNING ${SETTINGS_COLUMNS}, config_version`,
        insertParams,
      );

      const saved = (rows[0] as Record<string, unknown>) ?? {};
      const effective: Record<string, unknown> = {};
      const surveyOverrides: Record<string, unknown> = {};
      for (const key of INSIGHT_SETTING_KEYS) {
        const sv = coerceSettingValue(key, saved[key]);
        if (sv != null) surveyOverrides[key] = sv;
        effective[key] = sv != null ? sv : INSIGHT_SETTING_DEFAULTS[key];
      }

      logger.info({ surveyId, orgId: req.orgId, keys, by: req.userId }, 'insights:settings:patched');
      res.json({
        survey_id:        surveyId,
        survey_overrides: surveyOverrides,
        config_version:   (saved.config_version as number) ?? null,
        config_hash:      computeConfigHash(effective),
      });
    } catch (err: unknown) {
      logger.error({ err: (err as Error).message, surveyId }, 'insights:settings:patch:error');
      serverError(res, err instanceof Error ? err : new Error(String(err)));
    }
  },
);

// ── Insight Pipeline v2 — Phase 3 (manual runs + reports) & Phase 4 (trail) ───

/**
 * Resolve the effective insight settings for a survey via the 3-level COALESCE merge
 * (survey_insight_settings → org_insight_defaults → platform constant). Tolerates the
 * v2 tables not being migrated yet (each layer wrapped in try/catch → falls through to
 * the platform default). NUMERIC columns are coerced to numbers.
 */
async function resolveEffectiveSettings(surveyId: string, orgId: string): Promise<Record<string, unknown>> {
  let surveyLayer: Record<string, unknown> = {};
  try {
    const { rows } = await query(
      `SELECT ${SETTINGS_COLUMNS}
       FROM survey_insight_settings WHERE survey_id = $1 AND org_id = $2`,
      [surveyId, orgId],
    );
    surveyLayer = (rows[0] as Record<string, unknown>) ?? {};
  } catch (e: unknown) {
    logger.warn({ err: (e as Error).message, surveyId }, 'insights:resolveSettings:survey_layer_unavailable');
  }

  let orgLayer: Record<string, unknown> = {};
  try {
    const { rows } = await query(`SELECT * FROM org_insight_defaults WHERE org_id = $1`, [orgId]);
    orgLayer = (rows[0] as Record<string, unknown>) ?? {};
  } catch (e: unknown) {
    logger.warn({ err: (e as Error).message, orgId }, 'insights:resolveSettings:org_layer_unavailable');
  }

  const effective: Record<string, unknown> = {};
  for (const key of INSIGHT_SETTING_KEYS) {
    const sv = coerceSettingValue(key, surveyLayer[key]);
    const ov = coerceSettingValue(key, orgLayer[key]);
    effective[key] = sv != null ? sv : (ov != null ? ov : INSIGHT_SETTING_DEFAULTS[key]);
  }
  return effective;
}

type RunMode = 'expert' | 'quick' | 'refresh';

/** Map a run mode to its credit-cost setting key + CREDIT_COSTS fallback. */
const MODE_COST_SETTING: Record<RunMode, { settingKey: InsightSettingKey; fallback: number }> = {
  refresh: { settingKey: 'credit_cost_refresh',       fallback: CREDIT_COSTS.refresh },
  quick:   { settingKey: 'credit_cost_manual_quick',  fallback: CREDIT_COSTS.manual_quick },
  expert:  { settingKey: 'credit_cost_manual_expert', fallback: CREDIT_COSTS.manual_expert },
};

/** Resolve the credit cost for a run mode from effective settings (NULL override → CREDIT_COSTS default). */
function resolveRunCost(mode: RunMode, settings: Record<string, unknown>): number {
  const { settingKey, fallback } = MODE_COST_SETTING[mode];
  const v = settings[settingKey];
  const n = v != null ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

/** Map a run mode → the daily-limit setting key + env-default fallback. */
function resolveDailyLimit(mode: RunMode, settings: Record<string, unknown>): number {
  if (mode === 'refresh') {
    const v = Number(settings.refresh_daily_limit);
    return Number.isFinite(v) && v > 0 ? Math.trunc(v) : REFRESH_DAILY_LIMIT;
  }
  const v = Number(settings.manual_daily_run_limit);
  return Number.isFinite(v) && v > 0 ? Math.trunc(v) : MANUAL_DAILY_RUN_LIMIT;
}

/** The agent_runs.intent value used to count daily runs of a mode. */
function runIntentFor(mode: RunMode): string {
  return mode === 'refresh' ? 'manual_refresh' : `manual_${mode}`;
}

/** Resolve the sampling cap applied to the corpus for a mode (used by preview). */
function resolveSampleCap(mode: RunMode, settings: Record<string, unknown>): number {
  if (mode === 'quick')  return Number(settings.manual_quick_sample_cap) || 150;
  if (mode === 'expert') return Number(settings.manual_expert_max_corpus) || 2000;
  // refresh: bounded by the configured lookback window, not a hard sample cap
  return Number(settings.manual_expert_max_corpus) || 2000;
}

// ── POST /:surveyId/runs — manual / refresh run (Phase 3) ─────────────────────

router.post(
  '/:surveyId/runs',
  validate(manualRunSchema),
  async (req: Request, res: Response): Promise<void> => {
    const { surveyId } = req.params;
    const { mode, window_start, window_end, label } = req.body as {
      mode: RunMode; window_start?: string; window_end?: string; label?: string;
    };

    try {
      const survey = await getSurvey(surveyId, req.orgId);
      if (!survey) { res.status(404).json({ error: 'Survey not found' }); return; }

      const settings = await resolveEffectiveSettings(surveyId, req.orgId);

      // Daily-limit gate — count today's runs of this mode (UTC midnight window) in agent_runs.
      const dailyLimit = resolveDailyLimit(mode, settings);
      const intent = runIntentFor(mode);
      const todayUtcMidnight = `${new Date().toISOString().split('T')[0]}T00:00:00Z`;
      const { rows: [{ run_count }] } = await query<{ run_count: number }>(
        `SELECT COUNT(*)::int AS run_count FROM agent_runs
         WHERE survey_id = $1 AND org_id = $2 AND run_type = 'insight_generation'
           AND intent = $3 AND created_at >= $4::timestamptz`,
        [surveyId, req.orgId, intent, todayUtcMidnight],
      ).catch(() => ({ rows: [{ run_count: 0 }] }));
      if (run_count >= dailyLimit) {
        res.status(429).json({
          error: 'Daily run limit reached for this mode.',
          code:  'RATE_LIMITED',
          mode,
          limit: dailyLimit,
        });
        return;
      }

      // Credit pre-flight (02_ARCHITECTURE.md §6) → 402 when insufficient.
      const cost = resolveRunCost(mode, settings);
      const check = await checkCredits(req.orgId, cost, intent);
      if (!check.ok) {
        res.status(402).json({
          error:     'Not enough credits to start this insight run.',
          code:      'INSUFFICIENT_CREDITS',
          required:  check.required,
          available: check.available,
        });
        return;
      }

      // Create the agent_runs row before enqueue so the run is traceable.
      const { rows: runRows } = await query(
        `INSERT INTO agent_runs
           (org_id, user_id, thread_id, run_type, status, intent, survey_id)
         VALUES ($1, $2, $3, 'insight_generation', 'running', $4, $5)
         RETURNING id`,
        [req.orgId, req.userId, `${intent}:${req.orgId}:${surveyId}:${Date.now()}`, intent, surveyId],
      );
      const runId = (runRows[0] as { id: string }).id;

      // Debit after the run is committed (mirrors /generate + /trigger). Pre-checked above.
      try {
        await debitCredits(req.orgId, {
          actionType: intent,
          credits:    cost,
          userId:     req.userId,
          actionRef:  runId,
          note:       `Insight run (${mode})`,
        });
      } catch (err) {
        logger.warn({ err: (err as Error).message, surveyId, runId }, 'insights:runs:debit_failed');
      }

      // Fire-and-forget to CrystalOS. Tolerate the endpoint not existing yet (built in parallel).
      const actor = `user:${req.userId}`;
      const sampleCap = resolveSampleCap(mode, settings);
      agentsClient.triggerManualInsightRun({
        surveyId, orgId: req.orgId, runId, mode,
        windowStart: window_start ?? null,
        windowEnd:   window_end ?? null,
        label:       label ?? null,
        actor,
        sample_cap:  sampleCap,
      }).catch(err => {
        logger.error({ err: (err as Error).message, surveyId, runId, mode }, 'insights:runs:agents_error');
        query("UPDATE agent_runs SET status='failed', completed_at=NOW() WHERE id=$1", [runId]).catch(() => {});
      });

      logger.info({ surveyId, orgId: req.orgId, runId, mode, cost }, 'insights:runs:started');
      res.status(202).json({ run_id: runId, status: 'started' });
    } catch (err: unknown) {
      logger.error({ err: (err as Error).message, surveyId }, 'insights:runs:error');
      serverError(res, err instanceof Error ? err : new Error(String(err)));
    }
  },
);

// ── POST /:surveyId/runs/preview — cost / corpus preview (no debit) ────────────

router.post(
  '/:surveyId/runs/preview',
  validate(runPreviewSchema),
  async (req: Request, res: Response): Promise<void> => {
    const { surveyId } = req.params;
    const { mode, window_start, window_end } = req.body as {
      mode: RunMode; window_start?: string; window_end?: string;
    };

    try {
      const survey = await getSurvey(surveyId, req.orgId);
      if (!survey) { res.status(404).json({ error: 'Survey not found' }); return; }

      // Rate limiting — max 5 previews per 10 seconds per org (COUNT query protection).
      const redis = getRedisClient();
      if (redis) {
        const key = `rate:runs-preview:${req.orgId}`;
        const count = await redis.incr(key);
        if (count === 1) await redis.expire(key, 10); // 10-second window
        if (count > 5) { // max 5 previews per 10 seconds per org
          clientError(res, 429, 'Preview rate limit — wait a moment before previewing again.');
          return;
        }
      }

      const settings = await resolveEffectiveSettings(surveyId, req.orgId);
      const cost = resolveRunCost(mode, settings);

      // Resolve the time window. Manual modes use the provided window (or the mode's
      // default-days fallback); refresh uses refresh_lookback_days. We count responses
      // by submitted_at within the window.
      const params: unknown[] = [surveyId, req.orgId];
      const clauses: string[] = ['survey_id = $1', 'org_id = $2'];

      const resolvedStart: string | null = window_start ?? null;
      const resolvedEnd: string | null = window_end ?? null;

      if (!resolvedStart) {
        const defaultDays = mode === 'refresh'
          ? (Number(settings.refresh_lookback_days) || 30)
          : mode === 'quick'
            ? (Number(settings.manual_quick_default_window_days) || 14)
            : 90; // expert default window = 90d when unspecified
        params.push(defaultDays);
        clauses.push(`submitted_at >= NOW() - ($${params.length} * INTERVAL '1 day')`);
      } else {
        params.push(resolvedStart);
        clauses.push(`submitted_at >= $${params.length}::timestamptz`);
      }
      if (resolvedEnd) {
        params.push(resolvedEnd);
        clauses.push(`submitted_at <= $${params.length}::timestamptz`);
      }

      const { rows: [countRow] } = await query<{ corpus_size: number }>(
        `SELECT COUNT(*)::int AS corpus_size FROM responses WHERE ${clauses.join(' AND ')}`,
        params,
      ).catch(() => ({ rows: [{ corpus_size: 0 }] }));
      const corpusSize = countRow?.corpus_size ?? 0;

      // Apply the sampling cap from settings: sample_size = min(corpus, cap).
      const sampleCap = resolveSampleCap(mode, settings);
      const sampleSize = Math.min(corpusSize, sampleCap);

      // Coarse duration label by mode + corpus size.
      const estimatedDurationLabel = mode === 'quick'
        ? '~60–90s'
        : mode === 'refresh'
          ? '~1–2 min'
          : corpusSize > 1000 ? '~3–5 min' : '~2–3 min';

      res.json({
        estimated_cost:           cost,
        corpus_size:              corpusSize,
        estimated_duration_label: estimatedDurationLabel,
        sample_size:              sampleSize,
        mode,
        window_start:             resolvedStart,
        window_end:               resolvedEnd,
      });
    } catch (err: unknown) {
      logger.error({ err: (err as Error).message, surveyId }, 'insights:runs:preview:error');
      serverError(res, err instanceof Error ? err : new Error(String(err)));
    }
  },
);

// ── GET /:surveyId/reports/:reportId — manual report document (Phase 3) ────────

router.get('/:surveyId/reports/:reportId', async (req: Request, res: Response): Promise<void> => {
  const { surveyId, reportId } = req.params;
  try {
    const survey = await getSurvey(surveyId, req.orgId);
    if (!survey) { res.status(404).json({ error: 'Survey not found' }); return; }

    const { rows } = await query(
      `SELECT id, survey_id, org_id, run_id, run_mode, label,
              window_start, window_end, created_by, created_at,
              status, blob_ref, citations_manifest_ref,
              summary_headline, trust_score_avg, checkpoint_id
       FROM insight_reports
       WHERE id = $1 AND survey_id = $2 AND org_id = $3`,
      [reportId, surveyId, req.orgId],
    ).catch((e: unknown) => {
      logger.warn({ err: (e as Error).message, reportId }, 'insights:reports:table_unavailable');
      return { rows: [] };
    });

    if (!rows.length) { res.status(404).json({ error: 'Report not found' }); return; }
    const report = rows[0] as Record<string, unknown>;
    if (report.trust_score_avg != null) report.trust_score_avg = parseFloat(String(report.trust_score_avg));

    // Load the report blob document when a ref is present. Mirror the checkpoint-report
    // pattern: signed read URL in prod, inline blob otherwise. Best-effort — on failure
    // return the row + the blob_ref so the frontend/Crystal can fetch it directly.
    let document: unknown = undefined;
    let blobUrl: string | null = null;
    const blobRef = report.blob_ref as string | null;
    if (blobRef) {
      const isProduction = process.env.NODE_ENV === 'production' || process.env.AGENTS_ENV === 'staging';
      try {
        if (isProduction) {
          blobUrl = await agentsClient.getCheckpointReadUrl(blobRef);
        } else {
          document = await agentsClient.getCheckpointBlob(blobRef);
        }
      } catch (e: unknown) {
        logger.warn({ err: (e as Error).message, reportId, blobRef }, 'insights:reports:blob_load_failed');
        blobUrl = blobRef; // let the caller resolve it
      }
    }

    res.json({ report, document, blob_url: blobUrl });
  } catch (err: unknown) {
    logger.error({ err: (err as Error).message, surveyId, reportId }, 'insights:reports:error');
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

// ── Trail helpers (Phase 4) ───────────────────────────────────────────────────

const NUM = (v: unknown): number | null => (v != null ? parseFloat(String(v)) : null);

const TIER_THRESHOLDS = [
  { min: 100, label: 'full_report'     as const },
  { min: 70,  label: 'growing_picture' as const },
  { min: 40,  label: 'early_signals'   as const },
  { min: 10,  label: 'first_voices'    as const },
];

function computeTierLabel(count: unknown): 'first_voices' | 'early_signals' | 'growing_picture' | 'full_report' | null {
  const n = count != null ? Number(count) : NaN;
  if (Number.isNaN(n) || n < 10) return null;
  for (const tier of TIER_THRESHOLDS) {
    if (n >= tier.min) return tier.label;
  }
  return null;
}

/** Shape a v2 checkpoint row into the trail item contract. */
function shapeV2Checkpoint(r: Record<string, unknown>): Record<string, unknown> {
  return {
    id:           r.id ?? null,
    number:       r.checkpoint_number != null ? Number(r.checkpoint_number) : null,
    lane:         r.lane ?? null,
    run_mode:     r.run_mode ?? null,
    trigger:      r.trigger ?? null,
    nps:          NUM(r.nps_at_checkpoint),
    csat:         NUM(r.csat_at_checkpoint),
    ces:          NUM(r.ces_at_checkpoint),
    delta:        r.delta_from_prior ?? null,
    meaningful:   r.meaningful_delta === true,
    report_id:    r.report_id ?? null,
    created_at:   r.created_at ?? null,
    created_by:   r.created_by ?? null,
    report_label:   r.report_label ?? null,
    window_start:   r.window_start ?? null,
    window_end:     r.window_end ?? null,
    response_count: r.response_count_at_checkpoint != null ? Number(r.response_count_at_checkpoint) : null,
    tier_label:     computeTierLabel(r.response_count_at_checkpoint),
  };
}

/** Shape a legacy survey_insight_checkpoints row into the same trail item contract. */
function shapeLegacyCheckpoint(r: Record<string, unknown>): Record<string, unknown> {
  return {
    id:           r.id ?? null,
    number:       r.checkpoint_number != null ? Number(r.checkpoint_number) : null,
    lane:         'automated',
    run_mode:     'automated_incremental',
    trigger:      r.trigger ?? null,
    nps:          NUM(r.nps_at_checkpoint),
    csat:         NUM(r.csat_at_checkpoint),
    ces:          NUM(r.ces_at_checkpoint),
    delta:        r.delta_from_prior ?? null,
    meaningful:   r.meaningful_delta === true,
    created_at:   r.created_at ?? null,
    created_by:   r.created_by ?? null,
    report_label:   null,
    window_start:   null,
    window_end:     null,
    response_count: r.response_count_at_checkpoint != null ? Number(r.response_count_at_checkpoint) : null,
    tier_label:     computeTierLabel(r.response_count_at_checkpoint),
  };
}

// ── GET /:surveyId/trail — linked checkpoint list + manual reports (Phase 4) ───

router.get('/:surveyId/trail', async (req: Request, res: Response): Promise<void> => {
  const { surveyId } = req.params;

  const VALID_LANES = new Set(['automated', 'manual', 'all']);
  const lane  = VALID_LANES.has(req.query.lane as string) ? (req.query.lane as string) : 'all';
  const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 20, 1), 100);
  // cursor = checkpoint_number to page before (descending). null/invalid → newest.
  const cursorNum = req.query.cursor != null && !Number.isNaN(parseInt(req.query.cursor as string, 10))
    ? parseInt(req.query.cursor as string, 10)
    : null;

  try {
    const survey = await getSurvey(surveyId, req.orgId);
    if (!survey) { res.status(404).json({ error: 'Survey not found' }); return; }

    let checkpoints: Record<string, unknown>[] = [];
    let usedV2 = false;

    // Prefer insight_checkpoints_v2; fall back to legacy survey_insight_checkpoints
    // when v2 is empty/missing (tolerates pre-backfill state).
    try {
      const params: unknown[] = [surveyId, req.orgId];
      const conds = ['survey_id = $1', 'org_id = $2'];
      if (lane !== 'all') { params.push(lane); conds.push(`lane = $${params.length}`); }
      if (cursorNum != null) { params.push(cursorNum); conds.push(`checkpoint_number < $${params.length}`); }
      params.push(limit);
      const { rows } = await query(
        `SELECT icv2.id, icv2.checkpoint_number, icv2.lane, icv2.run_mode, icv2.trigger,
                icv2.nps_at_checkpoint, icv2.csat_at_checkpoint, icv2.ces_at_checkpoint,
                icv2.delta_from_prior, icv2.meaningful_delta, icv2.created_at, icv2.created_by,
                icv2.report_label, icv2.window_start, icv2.window_end, icv2.response_count_at_checkpoint,
                (SELECT ir.id FROM insight_reports ir WHERE ir.checkpoint_id = icv2.id LIMIT 1) AS report_id
         FROM insight_checkpoints_v2 icv2
         WHERE ${conds.map((c) => `icv2.${c}`).join(' AND ')}
         ORDER BY icv2.checkpoint_number DESC
         LIMIT $${params.length}`,
        params,
      );
      if (rows.length) {
        checkpoints = (rows as Record<string, unknown>[]).map(shapeV2Checkpoint);
        usedV2 = true;
      }
    } catch (e: unknown) {
      logger.warn({ err: (e as Error).message, surveyId }, 'insights:trail:v2_unavailable');
    }

    // Legacy fallback (only automated lane exists there).
    if (!usedV2 && lane !== 'manual') {
      try {
        const params: unknown[] = [surveyId, req.orgId];
        const conds = ['survey_id = $1', 'org_id = $2'];
        if (cursorNum != null) { params.push(cursorNum); conds.push(`checkpoint_number < $${params.length}`); }
        params.push(limit);
        const { rows } = await query(
          `SELECT id, checkpoint_number, trigger,
                  nps_at_checkpoint, csat_at_checkpoint, ces_at_checkpoint,
                  delta_from_prior, meaningful_delta, created_at, created_by,
                  response_count_at_checkpoint
           FROM survey_insight_checkpoints
           WHERE ${conds.join(' AND ')}
           ORDER BY checkpoint_number DESC
           LIMIT $${params.length}`,
          params,
        );
        checkpoints = (rows as Record<string, unknown>[]).map(shapeLegacyCheckpoint);
      } catch (e: unknown) {
        logger.warn({ err: (e as Error).message, surveyId }, 'insights:trail:legacy_unavailable');
        checkpoints = [];
      }
    }

    // Manual reports for the manual lane (or 'all'). Tolerate the table not existing.
    let reports: Record<string, unknown>[] = [];
    if (lane === 'manual' || lane === 'all') {
      try {
        const { rows } = await query(
          `SELECT id, run_id, run_mode, label, window_start, window_end,
                  created_by, created_at, status, summary_headline,
                  trust_score_avg, checkpoint_id
           FROM insight_reports
           WHERE survey_id = $1 AND org_id = $2
           ORDER BY created_at DESC
           LIMIT $3`,
          [surveyId, req.orgId, limit],
        );
        reports = (rows as Record<string, unknown>[]).map(r => ({
          ...r,
          trust_score_avg: NUM(r.trust_score_avg),
        }));
      } catch (e: unknown) {
        logger.warn({ err: (e as Error).message, surveyId }, 'insights:trail:reports_unavailable');
        reports = [];
      }
    }

    // Custom analysis reports. Tolerate the table not existing yet.
    let customReports: Record<string, unknown>[] = [];
    if (lane !== 'automated') {
      try {
        const { rows: crRows } = await query(
          `SELECT id, name, filter_spec, status, run_id,
                  corpus_coverage_pct, sample_size, trust_score_avg,
                  slug, created_by, created_at, completed_at
           FROM custom_reports
           WHERE survey_id = $1 AND org_id = $2 AND status = 'ready'
           ORDER BY created_at DESC
           LIMIT $3`,
          [surveyId, req.orgId, limit],
        );
        customReports = (crRows as Record<string, unknown>[]).map(r => ({
          id:                  r.id ?? null,
          label:               r.name ?? null,
          name:                r.name ?? null,
          mode:                null,
          report_type:         'custom',
          created_at:          r.created_at ?? null,
          created_by:          r.created_by ?? null,
          window_start:        null,
          window_end:          null,
          trust_score_avg:     NUM(r.trust_score_avg),
          corpus_coverage_pct: r.corpus_coverage_pct != null ? Number(r.corpus_coverage_pct) : null,
          sample_size:         r.sample_size != null ? Number(r.sample_size) : null,
          slug:                r.slug ?? null,
        }));
      } catch (e: unknown) {
        logger.warn({ err: (e as Error).message, surveyId }, 'insights:trail:custom_reports_unavailable');
      }
    }

    // Cursor for the next (older) page: the lowest checkpoint_number returned, if a full page.
    const nextCursor = checkpoints.length === limit
      ? (checkpoints[checkpoints.length - 1].number as number | null)
      : null;

    res.json({
      checkpoints,
      reports: [
        ...reports.map(r => ({ ...r, report_type: 'manual' as const })),
        ...customReports,
      ],
      next_cursor: nextCursor,
    });
  } catch (err: unknown) {
    logger.error({ err: (err as Error).message, surveyId }, 'insights:trail:error');
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

/**
 * Load a single checkpoint by id from v2 (preferred) or legacy. Returns the raw row +
 * a `source` tag, or null if not found in either. Ownership-scoped.
 */
async function loadCheckpointRow(
  checkpointId: string, surveyId: string, orgId: string,
): Promise<{ row: Record<string, unknown>; source: 'v2' | 'legacy' } | null> {
  try {
    const { rows } = await query(
      `SELECT * FROM insight_checkpoints_v2
       WHERE id = $1 AND survey_id = $2 AND org_id = $3`,
      [checkpointId, surveyId, orgId],
    );
    if (rows.length) return { row: rows[0] as Record<string, unknown>, source: 'v2' };
  } catch (e: unknown) {
    logger.warn({ err: (e as Error).message, checkpointId }, 'insights:trail:detail:v2_unavailable');
  }
  try {
    const { rows } = await query(
      `SELECT * FROM survey_insight_checkpoints
       WHERE id = $1 AND survey_id = $2 AND org_id = $3`,
      [checkpointId, surveyId, orgId],
    );
    if (rows.length) return { row: rows[0] as Record<string, unknown>, source: 'legacy' };
  } catch (e: unknown) {
    logger.warn({ err: (e as Error).message, checkpointId }, 'insights:trail:detail:legacy_unavailable');
  }
  return null;
}

// ── GET /:surveyId/trail/:checkpointId — node + lineage + delta + blob ─────────

router.get('/:surveyId/trail/:checkpointId', async (req: Request, res: Response): Promise<void> => {
  const { surveyId, checkpointId } = req.params;
  try {
    const survey = await getSurvey(surveyId, req.orgId);
    if (!survey) { res.status(404).json({ error: 'Survey not found' }); return; }

    const found = await loadCheckpointRow(checkpointId, surveyId, req.orgId);
    if (!found) { res.status(404).json({ error: 'Checkpoint not found' }); return; }

    const { row, source } = found;
    const node = source === 'v2' ? shapeV2Checkpoint(row) : shapeLegacyCheckpoint(row);
    const blobRef = (row.report_blob_ref as string | null) ?? (row.report_url as string | null) ?? null;

    // Best-effort blob load (same pattern as checkpoint report endpoint).
    let document: unknown = undefined;
    let blobUrl: string | null = null;
    if (blobRef) {
      const isProduction = process.env.NODE_ENV === 'production' || process.env.AGENTS_ENV === 'staging';
      try {
        if (isProduction) blobUrl = await agentsClient.getCheckpointReadUrl(blobRef);
        else document = await agentsClient.getCheckpointBlob(blobRef);
      } catch (e: unknown) {
        logger.warn({ err: (e as Error).message, checkpointId, blobRef }, 'insights:trail:detail:blob_load_failed');
        blobUrl = blobRef;
      }
    }

    res.json({
      checkpoint:       node,
      lineage_json:     row.lineage_json ?? null,
      delta_from_prior: row.delta_from_prior ?? null,
      report_blob_ref:  blobRef,
      document,
      blob_url:         blobUrl,
      source,
    });
  } catch (err: unknown) {
    logger.error({ err: (err as Error).message, surveyId, checkpointId }, 'insights:trail:detail:error');
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

// ── GET /:surveyId/trail/:checkpointId/compare/:otherId — side-by-side ─────────

router.get('/:surveyId/trail/:checkpointId/compare/:otherId', async (req: Request, res: Response): Promise<void> => {
  const { surveyId, checkpointId, otherId } = req.params;
  try {
    const survey = await getSurvey(surveyId, req.orgId);
    if (!survey) { res.status(404).json({ error: 'Survey not found' }); return; }

    const [aFound, bFound] = await Promise.all([
      loadCheckpointRow(checkpointId, surveyId, req.orgId),
      loadCheckpointRow(otherId, surveyId, req.orgId),
    ]);
    if (!aFound) { res.status(404).json({ error: 'Checkpoint not found', missing: checkpointId }); return; }
    if (!bFound) { res.status(404).json({ error: 'Checkpoint not found', missing: otherId }); return; }

    const a = aFound.source === 'v2' ? shapeV2Checkpoint(aFound.row) : shapeLegacyCheckpoint(aFound.row);
    const b = bFound.source === 'v2' ? shapeV2Checkpoint(bFound.row) : shapeLegacyCheckpoint(bFound.row);

    const metricDelta = (x: number | null, y: number | null): number | null =>
      (x != null && y != null) ? Math.round((y - x) * 10) / 10 : null;

    // Topic diff from each node's topic_fingerprint or delta topic name-sets, if present.
    const topicNames = (row: Record<string, unknown>): Set<string> => {
      const delta = row.delta_from_prior as Record<string, unknown> | null;
      const changes = (delta?.topic_changes as Record<string, unknown>) || {};
      const names = new Set<string>();
      for (const key of ['emerged', 'persisted', 'growing'] as const) {
        const arr = changes[key];
        if (Array.isArray(arr)) {
          for (const t of arr) names.add(typeof t === 'string' ? t : String((t as Record<string, unknown>)?.name ?? ''));
        }
      }
      names.delete('');
      return names;
    };
    const aTopics = topicNames(aFound.row);
    const bTopics = topicNames(bFound.row);
    const added   = [...bTopics].filter(t => !aTopics.has(t));
    const removed = [...aTopics].filter(t => !bTopics.has(t));

    res.json({
      a,
      b,
      metric_deltas: {
        nps:  metricDelta(a.nps  as number | null, b.nps  as number | null),
        csat: metricDelta(a.csat as number | null, b.csat as number | null),
        ces:  metricDelta(a.ces  as number | null, b.ces  as number | null),
      },
      topic_diff: { added, removed },
    });
  } catch (err: unknown) {
    logger.error({ err: (err as Error).message, surveyId, checkpointId, otherId }, 'insights:trail:compare:error');
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

// ── GET /api/insights/:insightId/audit — per-insight LLM run audit trail ──────
// Requires brand_admin (org:admin) role. Returns the 10 most-recent audit log
// entries for the given insight. Enables GDPR right-to-explanation and SOC2
// audit compliance (see insight_audit_log migration 20260626000001).

router.get('/:insightId/audit', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { insightId } = req.params;
  try {
    // Role gate: only org:admin (brand_admin) may access the raw audit trail.
    const orgRole = await resolveOrgRole(req);
    if (orgRole !== 'org:admin') {
      res.status(403).json({
        error:    'Only org admins can access the insight audit trail.',
        required: 'org:admin',
        current:  orgRole,
      });
      return;
    }

    // Verify the insight belongs to the requesting org.
    const { rows: insightRows } = await query(
      `SELECT id, survey_id FROM insights WHERE id = $1 AND org_id = $2`,
      [insightId, req.orgId],
    );
    if (!insightRows.length) {
      res.status(404).json({ error: 'Insight not found' });
      return;
    }

    const { rows: auditRows } = await query(
      `SELECT * FROM insight_audit_log
       WHERE insight_id = $1
       ORDER BY created_at DESC
       LIMIT 10`,
      [insightId],
    ).catch((e: unknown) => {
      logger.warn({ err: (e as Error).message, insightId }, 'insights:audit:table_unavailable');
      return { rows: [] };
    });

    res.json({ audit: auditRows });
  } catch (err: unknown) {
    logger.error({ err: (err as Error).message, insightId }, 'insights:audit:error');
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

// ── Legacy: GET /api/surveys/:surveyId/insights ───────────────────────────────
// Backward compat — clients should migrate to GET /api/insights/:surveyId/list

router.get('/:surveyId/insights', async (req: Request, res: Response): Promise<void> => {
  // Phase 7: deprecation headers — clients should migrate to GET /api/insights/:surveyId/list
  res.set('Deprecation', 'true');
  res.set('Sunset', new Date(Date.now() + 90 * 86400000).toUTCString()); // 90 days from now
  res.set('Link', '</api/insights/:surveyId/list>; rel="successor-version"');
  try {
    const { rows } = await query(
      `SELECT * FROM insights
       WHERE survey_id = $1 AND org_id = $2 AND superseded_at IS NULL
         AND time_window = 'all_time'
       ORDER BY priority DESC NULLS LAST`,
      [req.params.surveyId, req.orgId],
    );

    if (!rows.length) {
      res.json({ insights: null });
      return;
    }

    const npsRow = (rows as Record<string, unknown>[]).find(r => r.category === 'metric.nps');
    const topics = (rows as Record<string, unknown>[])
      .filter(r => r.category === 'voice.topic')
      .map(r => ({
        name:      r.headline,
        sentiment: ((r.metric_json as Record<string, unknown>)?.dominant_sentiment) || 'neutral',
        volume:    (r.metric_json as Record<string, unknown>)?.value || 0,
        phrases:   ((r.citations_json as Record<string, unknown>[] || []).slice(0, 3).map(c => ((c.quote as string) || '').slice(0, 60))),
      }));

    // Compute sentiment breakdown from actual AI-enriched response data.
    let sentimentBreakdown = { positive: 0, neutral: 0, negative: 0 };
    try {
      const { rows: [sb] } = await query(
        `SELECT
           ROUND(COUNT(CASE WHEN ai_sentiment = 'positive' THEN 1 END) * 100.0 / NULLIF(COUNT(*), 0))::int AS positive,
           ROUND(COUNT(CASE WHEN ai_sentiment = 'neutral'  THEN 1 END) * 100.0 / NULLIF(COUNT(*), 0))::int AS neutral,
           ROUND(COUNT(CASE WHEN ai_sentiment = 'negative' THEN 1 END) * 100.0 / NULLIF(COUNT(*), 0))::int AS negative
         FROM responses
         WHERE survey_id = $1 AND org_id = $2 AND ai_sentiment IS NOT NULL`,
        [req.params.surveyId, req.orgId],
      );
      const sbRow = sb as { positive: number | null; neutral: number | null; negative: number | null } | undefined;
      if (sbRow && (sbRow.positive != null || sbRow.neutral != null || sbRow.negative != null)) {
        sentimentBreakdown = {
          positive: sbRow.positive ?? 0,
          neutral:  sbRow.neutral  ?? 0,
          negative: sbRow.negative ?? 0,
        };
      }
    } catch { /* ai_sentiment column may not exist — leave zeros */ }

    const firstRow = rows[0] as Record<string, unknown>;
    res.json({
      insights: {
        id:                 firstRow.id,
        survey_id:          req.params.surveyId,
        org_id:             req.orgId,
        summary:            `${firstRow.headline}. ${firstRow.narrative}`,
        nps_score:          (npsRow?.metric_json as Record<string, unknown>)?.value ?? null,
        topics,
        sentiment_breakdown: sentimentBreakdown,
        top_phrases:         topics.slice(0, 5).map(t => t.name),
        response_count:      (npsRow?.trust_json as Record<string, unknown>)?.sample_size ?? 0,
        created_at:          firstRow.generated_at,
      },
    });
  } catch (err: unknown) {
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

export default router;
