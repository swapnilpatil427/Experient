/**
 * Org Intelligence Dashboard (Command Center) routes.
 *
 * Mounted at /api/org (docs/org-dashboard/ARCHITECTURE.md "API Design" — some routes
 * live at /api/org/dashboard/*, one at /api/org/health-score, so the router is mounted
 * one level up rather than at /api/org/dashboard).
 *
 * ── Integration pass: add these two lines (coordinate before editing per
 *    docs/org-dashboard/IMPLEMENTATION_SPEC.md "File ownership") ──────────────────
 *
 *   // backend/src/index.ts — near the other apiLimiter-gated route registrations:
 *   import orgDashboardRouter from './routes/org-dashboard';
 *   app.use('/api/org', apiLimiter, orgDashboardRouter);
 *
 *   // Separately (SSE stream is mounted directly on the app, not via this router —
 *   // mirrors notifications.ts's pattern):
 *   import { registerOrgDashboardStream } from './services/org-realtime.service';
 *   registerOrgDashboardStream(app);
 *
 * ─────────────────────────────────────────────────────────────────────────────────
 *
 * Per Decision 26 (docs/org-dashboard/DECISIONS.md): no new role-gating system — every
 * route here is `requireAuth` only, matching Tag Report's actual current access model
 * (open to any authenticated org member).
 */
import express from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { query } from '../lib/db';
import { validate } from '../lib/validate';
import { clientError, serverError } from '../lib/httpError';
import { checkCredits, debitCredits } from '../lib/creditLedger';
import { resolveOrgSummaryCost } from '../lib/orgSummaryCost';
import * as agentsClient from '../lib/agentsClient';
import { transitionAlert } from '../lib/alertEngine';
import { orgMetricsService } from '../services/org-metrics.service';
import logger from '../lib/logger';

const router = express.Router();
router.use(requireAuth);

// ── Config (env-overridable, matching the rest of this codebase's convention —
//    see routes/insights.ts's REFRESH_DAILY_LIMIT / routes/survey-groups.ts's
//    TAG_REPORT_MANUAL_DAILY_LIMIT) ────────────────────────────────────────────────

// Single reconciled range cap (docs/org-dashboard/ARCHITECTURE.md Addendum, Decision 16
// item 3): 90 days is the only value that satisfies both the servability constraint
// (org_metrics_daily-backed aggregation) and the signal-logic-validity constraint.
const MAX_RANGE_DAYS = parseInt(process.env.ORG_DASHBOARD_MAX_RANGE_DAYS ?? '90', 10);

// Daily-limit gate scoped by org_id only (Addendum: "not survey_id"), mirroring
// custom_analysis_daily_limit's default of 3.
const ORG_SUMMARY_DAILY_LIMIT = parseInt(process.env.ORG_SUMMARY_DAILY_LIMIT ?? '3', 10);

// low_confidence floor for the preview endpoint — org-wide corpora warrant a higher
// floor than survey-level Custom Analysis's custom_analysis_min_n_for_nps (default 30),
// since "low confidence" here describes an org-wide rollup, not one survey's NPS.
const ORG_SUMMARY_MIN_N = parseInt(process.env.ORG_SUMMARY_MIN_N ?? '100', 10);

const ORG_BRIEF_REGENERATE_ESTIMATED_SECONDS = parseInt(process.env.ORG_BRIEF_REGENERATE_ESTIMATED_SECONDS ?? '45', 10);

// ── Shared range validation (POST /summaries + /summaries/preview) ──────────────
// Servability + signal-logic-validity constraints, reconciled to a single 90-day cap
// (DECISIONS.md Decision 16 item 3, ARCHITECTURE.md Addendum "Range limit").

interface RangeError { ok: false; status: number; code: 'INVALID_RANGE' | 'RANGE_TOO_LARGE' | 'RANGE_NOT_COVERED'; message: string }
interface RangeOk { ok: true; rangeDays: number }

function parseRange(startStr: string, endStr: string): { start: Date; end: Date; rangeDays: number } | null {
  const start = new Date(startStr);
  const end = new Date(endStr);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return null;
  const rangeDays = Math.ceil((end.getTime() - start.getTime()) / 86_400_000) + 1;
  return { start, end, rangeDays };
}

async function validateRange(orgId: string, startStr: string, endStr: string): Promise<RangeOk | RangeError> {
  const parsed = parseRange(startStr, endStr);
  if (!parsed) return { ok: false, status: 400, code: 'INVALID_RANGE', message: 'Invalid date range' };
  if (parsed.rangeDays > MAX_RANGE_DAYS) {
    return { ok: false, status: 400, code: 'RANGE_TOO_LARGE', message: `Date range cannot exceed ${MAX_RANGE_DAYS} days` };
  }
  const todayUtc = new Date().toISOString().slice(0, 10);
  if (endStr >= todayUtc) {
    return { ok: false, status: 400, code: 'RANGE_NOT_COVERED', message: 'Range cannot extend into today — the latest fully-aggregated day is the boundary' };
  }
  const { rows } = await query<{ min_date: string | null }>(
    `SELECT MIN(date)::text AS min_date FROM org_metrics_daily WHERE org_id = $1`,
    [orgId],
  ).catch(() => ({ rows: [{ min_date: null }] }));
  const earliest = rows[0]?.min_date;
  if (earliest && startStr < earliest) {
    return { ok: false, status: 400, code: 'RANGE_NOT_COVERED', message: `No aggregated data available before ${earliest}` };
  }
  return { ok: true, rangeDays: parsed.rangeDays };
}

/**
 * Total response count + distinct contributing survey count across the org for
 * [startDate, endDate] (inclusive, UTC calendar days). Direct query against `responses`
 * — bounded by the 90-day range cap above, so this never scans an unbounded window.
 */
async function countOrgResponses(orgId: string, startDate: string, endDate: string): Promise<{ responseCount: number; programsIncluded: number }> {
  const { rows } = await query<{ total: number; programs: number }>(
    `SELECT COUNT(*)::int AS total, COUNT(DISTINCT survey_id)::int AS programs
       FROM responses
      WHERE org_id = $1 AND submitted_at >= $2::date AND submitted_at < ($3::date + INTERVAL '1 day')`,
    [orgId, startDate, endDate],
  ).catch(() => ({ rows: [{ total: 0, programs: 0 }] }));
  return { responseCount: rows[0]?.total ?? 0, programsIncluded: rows[0]?.programs ?? 0 };
}

/**
 * Maps a raw org_custom_summaries row to the frontend's `OrgSummary` shape
 * (app/src/types/orgDashboard.ts). `label`/`runId` are always `null` on read — see this
 * file's header / org-metrics.service.ts's header for why (no persisted column for
 * either in the shipped migration).
 */
function mapOrgSummaryRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    dateRangeStart: row.date_range_start,
    dateRangeEnd: row.date_range_end,
    label: null,
    status: row.status,
    runId: null,
    briefText: row.brief_text ?? null,
    createdAt: row.requested_at,
    completedAt: row.generated_at ?? null,
  };
}

// ── GET /dashboard ────────────────────────────────────────────────────────────────

router.get('/dashboard', async (req: Request, res: Response): Promise<void> => {
  try {
    const cached = await orgMetricsService.getDashboardPayload(req.orgId);
    if ('error' in cached.value) {
      // ARCHITECTURE.md's API Design explicitly calls out: "org has no surveys yet
      // (return empty state payload, not a 404)" — 200 with a structured error the
      // frontend renders as an empty state, never a 404 or a 500.
      res.json({ error: cached.value.error });
      return;
    }
    res.json({ ...cached.value, dataFreshnessAt: cached.dataFreshnessAt });
  } catch (err: unknown) {
    serverError(res, err instanceof Error ? err : new Error(String(err)), { endpoint: 'org_dashboard' });
  }
});

// ── GET /dashboard/trends ─────────────────────────────────────────────────────────

router.get('/dashboard/trends', async (req: Request, res: Response): Promise<void> => {
  try {
    const cached = await orgMetricsService.getTrends(req.orgId, {
      range: typeof req.query.range === 'string' ? req.query.range : undefined,
      granularity: typeof req.query.granularity === 'string' ? req.query.granularity : undefined,
    });
    res.json(cached.value);
  } catch (err: unknown) {
    serverError(res, err instanceof Error ? err : new Error(String(err)), { endpoint: 'org_dashboard_trends' });
  }
});

// ── GET /dashboard/programs ───────────────────────────────────────────────────────

router.get('/dashboard/programs', async (req: Request, res: Response): Promise<void> => {
  try {
    const cached = await orgMetricsService.getPrograms(req.orgId, {
      page: req.query.page != null ? parseInt(String(req.query.page), 10) : undefined,
      pageSize: req.query.pageSize != null ? parseInt(String(req.query.pageSize), 10) : undefined,
      sort: typeof req.query.sort === 'string' ? (req.query.sort as 'health') : undefined,
      order: req.query.order === 'desc' ? 'desc' : req.query.order === 'asc' ? 'asc' : undefined,
      tagId: typeof req.query.tagId === 'string' ? req.query.tagId : (typeof req.query.tagGroupId === 'string' ? req.query.tagGroupId : null),
      status: typeof req.query.status === 'string' ? (req.query.status as 'healthy') : null,
    });
    res.json(cached.value);
  } catch (err: unknown) {
    serverError(res, err instanceof Error ? err : new Error(String(err)), { endpoint: 'org_dashboard_programs' });
  }
});

// ── GET /dashboard/topics ──────────────────────────────────────────────────────────

router.get('/dashboard/topics', async (req: Request, res: Response): Promise<void> => {
  try {
    const cached = await orgMetricsService.getTopics(req.orgId);
    res.json(cached.value);
  } catch (err: unknown) {
    serverError(res, err instanceof Error ? err : new Error(String(err)), { endpoint: 'org_dashboard_topics' });
  }
});

// Not in ARCHITECTURE.md's original API Design list, but required by the already-built
// frontend contract (app/src/lib/api.ts's `getOrgTopicBreakdown`, `OrgTopicBreakdown` in
// app/src/types/orgDashboard.ts) — added so that integration point isn't left broken.
router.get('/dashboard/topics/:topicLabel', async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await orgMetricsService.getTopicBreakdown(req.orgId, req.params.topicLabel);
    res.json(result);
  } catch (err: unknown) {
    serverError(res, err instanceof Error ? err : new Error(String(err)), { endpoint: 'org_dashboard_topic_breakdown' });
  }
});

// ── GET /dashboard/tags (Tag Intelligence — tag_metrics + survey_tags) ────────────
// Same rationale as the topic-breakdown route above: not in ARCHITECTURE.md's original
// list, but required by app/src/hooks/useTagMetrics.ts / api.ts's `getOrgTagMetrics`.

router.get('/dashboard/tags', async (req: Request, res: Response): Promise<void> => {
  try {
    const cached = await orgMetricsService.getTagMetrics(req.orgId);
    res.json(cached.value);
  } catch (err: unknown) {
    serverError(res, err instanceof Error ? err : new Error(String(err)), { endpoint: 'org_dashboard_tags' });
  }
});

// ── GET /dashboard/alerts + PATCH acknowledge ─────────────────────────────────────

router.get('/dashboard/alerts', async (req: Request, res: Response): Promise<void> => {
  try {
    const limit = req.query.limit != null ? parseInt(String(req.query.limit), 10) : undefined;
    const cached = await orgMetricsService.getAlerts(req.orgId, { limit });
    res.json(cached.value);
  } catch (err: unknown) {
    serverError(res, err instanceof Error ? err : new Error(String(err)), { endpoint: 'org_dashboard_alerts' });
  }
});

router.patch('/dashboard/alerts/:alertId/acknowledge', async (req: Request, res: Response): Promise<void> => {
  try {
    // Reuses alertEngine's existing state machine (Decision 23: alert_events IS the
    // anomaly-alert store — no separate table, no separate transition logic). Always
    // scoped by org_id inside transitionAlert's WHERE clause — never trust the path
    // param alone.
    const updated = await transitionAlert(req.params.alertId, req.orgId, 'acknowledge', req.userId);
    if (!updated) { clientError(res, 404, 'Alert not found'); return; }
    await orgMetricsService.invalidateAlerts(req.orgId);
    res.json({ alertId: req.params.alertId, acknowledgedAt: (updated as Record<string, unknown>).acknowledged_at });
  } catch (err: unknown) {
    serverError(res, err instanceof Error ? err : new Error(String(err)), { endpoint: 'org_dashboard_alert_ack' });
  }
});

// ── GET /dashboard/crystal-brief + POST regenerate ────────────────────────────────

router.get('/dashboard/crystal-brief', async (req: Request, res: Response): Promise<void> => {
  try {
    const cached = await orgMetricsService.getLatestCrystalBrief(req.orgId);
    res.json(cached.value);
  } catch (err: unknown) {
    serverError(res, err instanceof Error ? err : new Error(String(err)), { endpoint: 'org_dashboard_crystal_brief' });
  }
});

/** Current ISO week's [Monday, Sunday] as YYYY-MM-DD — matches org_metrics_weekly's
 *  DATE_TRUNC('week', ...) grain, so a manual regenerate targets the same row the
 *  automated weekly run would have (upserts onto it via org_crystal_briefs' own
 *  UNIQUE(org_id, date_range_start), per ARCHITECTURE.md Addendum 2). */
function currentIsoWeekRange(): { start: string; end: string } {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun..6=Sat
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() + diffToMonday);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return { start: monday.toISOString().slice(0, 10), end: sunday.toISOString().slice(0, 10) };
}

router.post('/dashboard/crystal-brief/regenerate', async (req: Request, res: Response): Promise<void> => {
  try {
    const { start, end } = currentIsoWeekRange();
    const threadId = `org_brief:${req.orgId}:manual:${Date.now()}`;
    const { rows: runRows } = await query(
      `INSERT INTO agent_runs (org_id, user_id, thread_id, run_type, status, intent)
       VALUES ($1, $2, $3, 'org_brief_generation', 'running', 'org_brief_regenerate')
       RETURNING id`,
      [req.orgId, req.userId, threadId],
    );
    const runId = (runRows[0] as { id: string }).id;

    // CrystalOS's org-brief endpoint is synchronous on its side (awaits the full graph +
    // verify_and_score) — this backend call is fired in the background so the HTTP
    // response below stays fast; the brief lands in org_crystal_briefs directly (Decision
    // 21: "brief ready" delivery rides the existing app-wide notification stream, a
    // separate parallel workstream — not this endpoint's or org-realtime.service.ts's job).
    agentsClient.triggerOrgBrief({
      orgId: req.orgId, dateRangeStart: start, dateRangeEnd: end,
      periodType: 'weekly', requestedBy: req.userId,
    }).then(() => {
      query("UPDATE agent_runs SET status='completed', completed_at=NOW() WHERE id=$1", [runId]).catch(() => {});
      orgMetricsService.invalidateCrystalBrief(req.orgId).catch(() => {});
    }).catch((err: unknown) => {
      logger.error({ err: (err as Error).message, orgId: req.orgId, runId }, 'org_dashboard:brief_regenerate:agents_error');
      query("UPDATE agent_runs SET status='failed', completed_at=NOW() WHERE id=$1", [runId]).catch(() => {});
    });

    res.status(202).json({ jobId: runId, estimatedSeconds: ORG_BRIEF_REGENERATE_ESTIMATED_SECONDS });
  } catch (err: unknown) {
    serverError(res, err instanceof Error ? err : new Error(String(err)), { endpoint: 'org_dashboard_brief_regenerate' });
  }
});

// ── GET /dashboard/briefs (history) + compare ─────────────────────────────────────

router.get('/dashboard/briefs', async (req: Request, res: Response): Promise<void> => {
  try {
    const cached = await orgMetricsService.getBriefHistory(req.orgId, {
      page: req.query.page != null ? parseInt(String(req.query.page), 10) : undefined,
      pageSize: req.query.pageSize != null ? parseInt(String(req.query.pageSize), 10) : undefined,
    });
    res.json(cached.value);
  } catch (err: unknown) {
    serverError(res, err instanceof Error ? err : new Error(String(err)), { endpoint: 'org_dashboard_briefs' });
  }
});

router.get('/dashboard/briefs/:briefId/compare/:otherId', async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await orgMetricsService.compareBriefs(req.orgId, req.params.briefId, req.params.otherId);
    if (!result) { clientError(res, 404, 'One or both briefs were not found'); return; }
    res.json(result);
  } catch (err: unknown) {
    serverError(res, err instanceof Error ? err : new Error(String(err)), { endpoint: 'org_dashboard_briefs_compare' });
  }
});

// ── Manual summaries (mirrors backend/src/routes/reports.ts's Custom Analysis pattern) ──

const summaryRequestSchema = z.object({
  dateRangeStart: z.string().refine((v) => !Number.isNaN(Date.parse(v)), { message: 'must be an ISO-8601 date' }),
  dateRangeEnd: z.string().refine((v) => !Number.isNaN(Date.parse(v)), { message: 'must be an ISO-8601 date' }),
  label: z.string().trim().min(1).max(160).optional(),
}).strict();

router.post('/dashboard/summaries', validate(summaryRequestSchema), async (req: Request, res: Response): Promise<void> => {
  const { dateRangeStart, dateRangeEnd, label } = req.body as { dateRangeStart: string; dateRangeEnd: string; label?: string };

  try {
    const rangeCheck = await validateRange(req.orgId, dateRangeStart, dateRangeEnd);
    if (!rangeCheck.ok) { res.status(rangeCheck.status).json({ error: rangeCheck.message, code: rangeCheck.code }); return; }

    const { responseCount } = await countOrgResponses(req.orgId, dateRangeStart, dateRangeEnd);
    const cost = resolveOrgSummaryCost(responseCount);

    // Daily-limit gate scoped by org_id ONLY (not survey_id) — Addendum's explicit call-out.
    const todayUtcMidnight = `${new Date().toISOString().split('T')[0]}T00:00:00Z`;
    const { rows: [{ run_count }] } = await query<{ run_count: number }>(
      `SELECT COUNT(*)::int AS run_count FROM org_custom_summaries WHERE org_id = $1 AND requested_at >= $2::timestamptz`,
      [req.orgId, todayUtcMidnight],
    ).catch(() => ({ rows: [{ run_count: 0 }] }));
    if (run_count >= ORG_SUMMARY_DAILY_LIMIT) {
      res.status(429).json({ error: 'Daily org summary limit reached.', code: 'RATE_LIMITED', limit: ORG_SUMMARY_DAILY_LIMIT });
      return;
    }

    const check = await checkCredits(req.orgId, cost, 'org_custom_summary');
    if (!check.ok) {
      res.status(402).json({ error: 'Not enough credits to run this summary.', code: 'INSUFFICIENT_CREDITS', required: check.required, available: check.available });
      return;
    }

    const { rows: runRows } = await query(
      `INSERT INTO agent_runs (org_id, user_id, thread_id, run_type, status, intent)
       VALUES ($1, $2, $3, 'org_brief_generation', 'running', 'org_custom_summary')
       RETURNING id`,
      [req.orgId, req.userId, `org_custom_summary:${req.orgId}:${Date.now()}`],
    );
    const runId = (runRows[0] as { id: string }).id;

    // NOTE: org_custom_summaries (per the real, shipped migration) has no `label` column
    // — `label` is a display-only hint that would be lost on read either way, since
    // CrystalOS's own completion write overwrites `input_snapshot` with the real metrics
    // snapshot (see org-metrics.service.ts's file header). Not persisted here; GET
    // /summaries and /summaries/:id always return `label: null`.
    const { rows: summaryRows } = await query(
      `INSERT INTO org_custom_summaries (org_id, date_range_start, date_range_end, status, requested_by)
       VALUES ($1, $2, $3, 'pending', $4)
       RETURNING id, status`,
      [req.orgId, dateRangeStart, dateRangeEnd, req.userId],
    );
    const summary = summaryRows[0] as { id: string; status: string };

    try {
      await debitCredits(req.orgId, {
        actionType: 'org_custom_summary', credits: cost, userId: req.userId,
        actionRef: summary.id, note: `Org Custom Summary (${responseCount} responses)`,
      });
    } catch (err: unknown) {
      logger.warn({ err: (err as Error).message, runId, summaryId: summary.id }, 'org_dashboard:summaries:debit_failed');
    }

    // CrystalOS's org-brief endpoint (period_type='custom') writes brief_text/status
    // directly onto this org_custom_summaries row on success — this call only needs to
    // mark the row 'failed' if the dispatch itself fails (network/5xx/timeout).
    agentsClient.triggerOrgCustomSummary({
      orgId: req.orgId, dateRangeStart, dateRangeEnd, requestedBy: req.userId,
    }).catch((err: unknown) => {
      logger.error({ err: (err as Error).message, runId, summaryId: summary.id }, 'org_dashboard:summaries:agents_error');
      query("UPDATE agent_runs SET status='failed', completed_at=NOW() WHERE id=$1", [runId]).catch(() => {});
      query("UPDATE org_custom_summaries SET status='failed', error_message=$2 WHERE id=$1", [summary.id, 'Failed to dispatch to CrystalOS']).catch(() => {});
    });

    logger.info({ orgId: req.orgId, runId, summaryId: summary.id, cost, responseCount, label: label ?? null }, 'org_dashboard:summaries:started');
    res.status(202).json({ summaryId: summary.id, runId, status: 'pending' });
  } catch (err: unknown) {
    serverError(res, err instanceof Error ? err : new Error(String(err)), { endpoint: 'org_dashboard_summaries_create' });
  }
});

const summaryPreviewSchema = z.object({
  dateRangeStart: z.string().refine((v) => !Number.isNaN(Date.parse(v)), { message: 'must be an ISO-8601 date' }),
  dateRangeEnd: z.string().refine((v) => !Number.isNaN(Date.parse(v)), { message: 'must be an ISO-8601 date' }),
}).strict();

router.post('/dashboard/summaries/preview', validate(summaryPreviewSchema), async (req: Request, res: Response): Promise<void> => {
  const { dateRangeStart, dateRangeEnd } = req.body as { dateRangeStart: string; dateRangeEnd: string };
  try {
    const parsed = parseRange(dateRangeStart, dateRangeEnd);
    if (!parsed) { res.status(400).json({ error: 'Invalid date range', code: 'INVALID_RANGE' }); return; }

    // Unlike POST /summaries, an over-long range is a WARNING flag here (exceeds_max_range),
    // not a hard failure — the preview lets the frontend show that warning before the user
    // commits. Data-availability problems (into today / before earliest data) are still
    // hard failures — there is no meaningful preview to compute for those.
    const exceedsMaxRange = parsed.rangeDays > MAX_RANGE_DAYS;

    const todayUtc = new Date().toISOString().slice(0, 10);
    if (dateRangeEnd >= todayUtc) {
      res.status(400).json({ error: 'Range cannot extend into today', code: 'RANGE_NOT_COVERED' });
      return;
    }
    const { rows: earliestRows } = await query<{ min_date: string | null }>(
      `SELECT MIN(date)::text AS min_date FROM org_metrics_daily WHERE org_id = $1`,
      [req.orgId],
    ).catch(() => ({ rows: [{ min_date: null }] }));
    const earliest = earliestRows[0]?.min_date;
    if (earliest && dateRangeStart < earliest) {
      res.status(400).json({ error: `No aggregated data available before ${earliest}`, code: 'RANGE_NOT_COVERED' });
      return;
    }

    const { responseCount, programsIncluded } = await countOrgResponses(req.orgId, dateRangeStart, dateRangeEnd);
    const estimatedCost = resolveOrgSummaryCost(responseCount);

    res.json({
      estimatedCost,
      responseCount,
      programsIncluded,
      dateRangeDays: parsed.rangeDays,
      lowConfidence: responseCount < ORG_SUMMARY_MIN_N,
      exceedsMaxRange,
    });
  } catch (err: unknown) {
    serverError(res, err instanceof Error ? err : new Error(String(err)), { endpoint: 'org_dashboard_summaries_preview' });
  }
});

router.get('/dashboard/summaries', async (req: Request, res: Response): Promise<void> => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit ?? ''), 10) || 50, 100);
    const { rows } = await query(
      `SELECT id, org_id, date_range_start, date_range_end, status, brief_text, recommendations,
              requested_by, requested_at, generated_at, model_version, error_message, compared_against_brief_id
         FROM org_custom_summaries WHERE org_id = $1
        ORDER BY requested_at DESC LIMIT $2`,
      [req.orgId, limit],
    ).catch((e: unknown) => {
      logger.warn({ err: (e as Error).message, orgId: req.orgId }, 'org_dashboard:summaries:list:table_unavailable');
      return { rows: [] };
    });
    res.json({ summaries: (rows as Record<string, unknown>[]).map(mapOrgSummaryRow) });
  } catch (err: unknown) {
    serverError(res, err instanceof Error ? err : new Error(String(err)), { endpoint: 'org_dashboard_summaries_list' });
  }
});

router.get('/dashboard/summaries/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const { rows } = await query(
      `SELECT * FROM org_custom_summaries WHERE id = $1 AND org_id = $2`,
      [req.params.id, req.orgId],
    );
    if (!rows.length) { clientError(res, 404, 'Summary not found'); return; }
    res.json({ summary: mapOrgSummaryRow(rows[0] as Record<string, unknown>) });
  } catch (err: unknown) {
    serverError(res, err instanceof Error ? err : new Error(String(err)), { endpoint: 'org_dashboard_summaries_detail' });
  }
});

// ── GET /health-score ──────────────────────────────────────────────────────────────

router.get('/health-score', async (req: Request, res: Response): Promise<void> => {
  try {
    const cached = await orgMetricsService.getHealthScore(req.orgId);
    if (!cached.value) { res.json({ totalScore: 0, status: 'healthy', components: null, history: [], computedAt: null }); return; }
    res.json(cached.value);
  } catch (err: unknown) {
    serverError(res, err instanceof Error ? err : new Error(String(err)), { endpoint: 'org_health_score' });
  }
});

export default router;
