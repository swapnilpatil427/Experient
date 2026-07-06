/**
 * Agent run tracking routes — unified across all run types.
 *
 *   GET  /api/runs           — List all agent runs for the org (filterable by type/status)
 *   GET  /api/runs/:runId    — Get a single run by ID
 */
import express from 'express';
import type { Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { query } from '../lib/db';
import logger from '../lib/logger';
import { serverError } from '../lib/httpError';

const router = express.Router();
router.use(requireAuth);

// ── GET /api/runs ──────────────────────────────────────────────────────────────
// Query params:
//   run_type  — filter by type: 'survey_creation' | 'insight_generation'
//   status    — filter by status: 'running' | 'completed' | 'failed' | 'cancelled' | 'waiting_approval'
//   survey_id — filter by survey
//   limit     — max rows (default 20, max 50)
//   offset    — pagination offset

router.get('/', async (req: Request, res: Response): Promise<void> => {
  const { run_type, status, survey_id, limit = '20', offset = '0' } = req.query as Record<string, string>;

  const VALID_TYPES   = new Set(['survey_creation', 'insight_generation', 'topic_backfill']);
  const VALID_STATUSES = new Set(['running', 'completed', 'failed', 'cancelled', 'waiting_approval']);

  const clauses: string[] = ['org_id = $1'];
  const params: unknown[]  = [req.orgId];

  if (run_type && VALID_TYPES.has(run_type)) {
    clauses.push(`run_type = $${params.length + 1}`);
    params.push(run_type);
  }
  if (status && VALID_STATUSES.has(status)) {
    clauses.push(`status = $${params.length + 1}`);
    params.push(status);
  }
  if (survey_id && typeof survey_id === 'string') {
    clauses.push(`survey_id = $${params.length + 1}`);
    params.push(survey_id);
  }

  const pageLimit  = Math.min(parseInt(limit,  10) || 20, 50);
  const pageOffset = Math.max(parseInt(offset, 10) || 0,   0);
  params.push(pageLimit, pageOffset);

  try {
    const { rows } = await query(
      `SELECT id, run_type, status, intent, survey_id, survey_type_id,
              total_tokens, cost_usd, qc_score, compliance_risk_level,
              created_at, completed_at, error_log,
              EXTRACT(EPOCH FROM (COALESCE(completed_at, NOW()) - created_at))::int AS duration_seconds
       FROM agent_runs
       WHERE ${clauses.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    const { rows: [{ total }] } = await query(
      `SELECT COUNT(*)::int AS total FROM agent_runs WHERE ${clauses.slice(0, -2).join(' AND ') || 'org_id = $1'}`,
      params.slice(0, params.length - 2),
    );

    res.json({
      runs:     (rows as Record<string, unknown>[]).map(normaliseRun),
      total:    (total as number) || 0,
      limit:    pageLimit,
      offset:   pageOffset,
      has_more: pageOffset + rows.length < ((total as number) || 0),
    });
  } catch (err: unknown) {
    logger.error({ err: (err as Error).message }, 'runs:list:error');
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

// ── GET /api/runs/:runId ───────────────────────────────────────────────────────

router.get('/:runId', async (req: Request, res: Response): Promise<void> => {
  const { runId } = req.params;
  try {
    const { rows } = await query(
      `SELECT *, EXTRACT(EPOCH FROM (COALESCE(completed_at, NOW()) - created_at))::int AS duration_seconds
       FROM agent_runs WHERE id = $1 AND org_id = $2`,
      [runId, req.orgId],
    );
    if (!rows.length) { res.status(404).json({ error: 'Run not found' }); return; }
    res.json(normaliseRun(rows[0] as Record<string, unknown>));
  } catch (err: unknown) {
    logger.error({ err: (err as Error).message, runId }, 'runs:get:error');
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function normaliseRun(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id:                    row.id,
    run_type:              row.run_type   || 'unknown',
    status:                row.status,
    intent:                row.intent     || null,
    survey_id:             row.survey_id  || null,
    survey_type_id:        row.survey_type_id || null,
    total_tokens:          row.total_tokens   ?? null,
    cost_usd:              row.cost_usd       != null ? parseFloat(String(row.cost_usd)) : null,
    qc_score:              row.qc_score       != null ? parseFloat(String(row.qc_score)) : null,
    compliance_risk_level: row.compliance_risk_level || null,
    created_at:            row.created_at,
    completed_at:          row.completed_at  || null,
    duration_seconds:      row.duration_seconds != null ? parseInt(String(row.duration_seconds)) : null,
    error:                 Array.isArray(row.error_log) ? row.error_log[row.error_log.length - 1] : null,
    // Progress feed — same convention every run_type already writes into
    // (insight generation, tag report, and now topic_backfill all append here;
    // no run_type has a numeric total/completed column, by design — see
    // lib/topic_backfill.py's "backfill_progress" events for the shape a
    // poller should read: { total_untagged, processed, remaining, ... }).
    stream_events:         Array.isArray(row.stream_events) ? row.stream_events : [],
  };
}

export default router;
