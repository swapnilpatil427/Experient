/**
 * Survey Groups API. Mounted at /api/group-insights (see src/index.ts — the
 * "Mounted at" line historically written here does not match; this comment is
 * corrected to the real mount path since Tag Report's TRACKER.md endpoint list
 * assumed the stale /api/survey-groups prefix — see this worktree's hand-off
 * notes for the full discrepancy).
 *
 * Cross-survey insight generation, SSE streaming, and group Crystal chat.
 * Groups are defined by survey tags — a "group" = all surveys sharing a tag.
 *
 *   POST /api/group-insights/generate                    — start group insight run
 *   GET  /api/group-insights/:runId/status               — get run status + stream_events
 *   GET  /api/group-insights/:runId/stream                — SSE stream of events
 *   GET  /api/group-insights/:runId                       — get completed run + insights
 *   POST /api/group-insights/crystal                      — Crystal chat with group scope
 *
 *   Tag Report (docs/tag-report/DESIGN.md + TRACKER.md):
 *   GET  /api/group-insights/tag-reports                  — index list, org-scoped
 *   POST /api/group-insights/tag-report/manual             — start a Manual-mode run
 *   POST /api/group-insights/tag-report/custom-range        — start a Custom Range run
 *   POST /api/group-insights/tag-report/automated           — internal-only (X-Internal-Key), scheduler-triggered
 *   GET  /api/group-insights/tag-report/:runId              — completed/in-progress run + sources + insights-by-metric
 *   GET  /api/group-insights/tag-report/:runId/trail        — provenance + parent_run_id lineage
 *
 *   (Latest report for a tag lives at GET /api/survey-tags/:id/latest-report in tags.ts)
 */
import express from 'express';
import type { Request, Response } from 'express';
import fetch from 'node-fetch';
import { query } from '../lib/db';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { requireInternalKey } from '../middleware/internalKey';
import { serverError } from '../lib/httpError';
import logger from '../lib/logger';
import * as agentsClient from '../lib/agentsClient';
import { insertGroupInsightRunWithConcurrencyGuard } from '../lib/groupInsightRunConcurrency';
import { startTagReportRun } from '../lib/tagReportRunner';
import { buildMetricTracks, buildDisclosure } from '../lib/tagReportView';

const router = express.Router();

const AGENTS_URL = process.env.AGENTS_URL ?? 'http://localhost:8001';
const AGENTS_INTERNAL_KEY = process.env.AGENTS_INTERNAL_KEY
  ?? (process.env.NODE_ENV !== 'production'
    ? 'dev-internal-key-change-in-prod'
    : (() => { throw new Error('AGENTS_INTERNAL_KEY must be set in production'); })());

// Tag Report manual/custom-range daily trigger cap, per (org, tag) — mirrors the
// survey_insight_settings.manual_daily_run_limit-style cap pattern (TRACKER.md
// §1 "Rate Limiting / Operational Concerns" Task 16). Env-overridable, same
// convention as REFRESH_DAILY_LIMIT/MANUAL_DAILY_RUN_LIMIT in routes/insights.ts.
const TAG_REPORT_MANUAL_DAILY_LIMIT = parseInt(process.env.TAG_REPORT_MANUAL_DAILY_LIMIT ?? '10', 10);

// ── POST /api/survey-groups/insights/generate ─────────────────────────────────

// requireRole('analyst') added (TRACKER.md §1 Task 12) — this route previously had
// no role gate beyond requireAuth, a pre-existing gap flagged by Riley's security
// review (§4a finding 3) that Tag Report would otherwise have inherited.
router.post('/generate', requireAuth, requireRole('analyst'), async (req: Request, res: Response): Promise<void> => {
  try {
    const { tag_ids, survey_ids: providedSurveyIds } = req.body as Record<string, unknown>;

    if (!Array.isArray(tag_ids) || (tag_ids as unknown[]).length === 0) {
      res.status(400).json({ error: 'tag_ids must be a non-empty array' });
      return;
    }

    // Validate all tag_ids exist and belong to this org
    const { rows: validTags } = await query(
      'SELECT id FROM survey_tags WHERE id = ANY($1::uuid[]) AND org_id = $2',
      [tag_ids, req.orgId]
    );
    if (validTags.length !== (tag_ids as unknown[]).length) {
      res.status(400).json({ error: 'One or more tag IDs are invalid or do not belong to your org' });
      return;
    }

    // Collect survey_ids from tag mappings if not explicitly provided
    let surveyIds: string[] = Array.isArray(providedSurveyIds) && (providedSurveyIds as unknown[]).length > 0
      ? (providedSurveyIds as string[])
      : [];

    if (surveyIds.length === 0) {
      const { rows: mappings } = await query(
        `SELECT DISTINCT m.survey_id
         FROM survey_tag_mappings m
         JOIN surveys s ON s.id = m.survey_id
         WHERE m.tag_id = ANY($1::uuid[]) AND m.org_id = $2
           AND s.deleted_at IS NULL`,
        [tag_ids, req.orgId]
      );
      surveyIds = (mappings as { survey_id: string }[]).map(r => r.survey_id);
    } else {
      // TRACKER.md §1 Task 12b / DESIGN.md A.2 — this endpoint previously accepted
      // client-supplied survey_ids with ZERO validation that they belong to the
      // calling org, flowing straight to the DB insert and to CrystalOS. Tag
      // Report's own new request contract fixes this by never accepting
      // survey_ids at all; this is the pre-existing endpoint's own separate half
      // of the same root-cause gap (still supports explicit survey_ids for
      // non-tag-scoped callers, but now org-scoped).
      const { rows: validSurveys } = await query(
        'SELECT id FROM surveys WHERE id = ANY($1::uuid[]) AND org_id = $2 AND deleted_at IS NULL',
        [surveyIds, req.orgId]
      );
      if (validSurveys.length !== surveyIds.length) {
        res.status(400).json({ error: 'One or more survey IDs are invalid or do not belong to your org' });
        return;
      }
    }

    if (surveyIds.length === 0) {
      res.status(400).json({ error: 'No surveys found for the specified tags' });
      return;
    }

    // Fixed 2026-07-02 (security review, Riley — MEDIUM, confirmed): this route
    // writes into the same group_insight_runs table, for the same (org_id,
    // tag_ids), as Tag Report's manual/custom-range endpoints — but never
    // enforced TAG_REPORT_MANUAL_DAILY_LIMIT itself, so it was a straightforward
    // bypass of that limit (and this route's underlying graph, group_insights.py,
    // makes REAL fresh LLM calls per run, unlike Tag Report — a genuine cost/quota
    // bypass, not just cosmetic). Checked per tag_id; any one at its limit blocks
    // the whole call, same "most restrictive wins" semantic as a single-tag call.
    for (const checkTagId of tag_ids as string[]) {
      const rate = await checkTagReportDailyLimit(req.orgId, checkTagId);
      if (!rate.ok) {
        res.status(429).json({ error: 'Daily tag report limit reached for this tag', code: 'RATE_LIMITED', limit: rate.limit, tag_id: checkTagId });
        return;
      }
    }

    // Create group_insight_runs record through the shared concurrency-safe
    // helper (TRACKER.md §1 "Interaction found with the existing /generate
    // route" / DESIGN.md Appendix A.5) — uq_gir_tag_inflight applies to this
    // table as a whole, so a concurrent duplicate call here must attach to the
    // in-flight run rather than surfacing a raw 23505 as a 500.
    const { runId, attachedToExisting } = await insertGroupInsightRunWithConcurrencyGuard({
      orgId: req.orgId,
      createdBy: req.userId,
      tagIds: tag_ids as string[],
      surveyIds,
    });

    logger.info({ orgId: req.orgId, runId, tagCount: (tag_ids as unknown[]).length, surveyCount: surveyIds.length, attachedToExisting }, 'survey_groups:generate:started');

    // Fire-and-forget to agents service — but only for a genuinely new run;
    // attaching to an in-flight run must never trigger a second generation.
    if (!attachedToExisting) {
      agentsClient.generateGroupInsights(runId, tag_ids as string[], surveyIds, req.orgId)
        .catch((err: unknown) => {
          logger.error({ err: (err as Error).message, runId }, 'survey_groups:generate:agents_error');
          query(
            "UPDATE group_insight_runs SET status = 'failed', completed_at = NOW() WHERE id = $1",
            [runId]
          ).catch(() => {});
        });
    }

    res.status(202).json({ run_id: runId, attached_to_existing: attachedToExisting });
  } catch (err: unknown) {
    logger.error({ err: (err as Error).message, orgId: req.orgId }, 'survey_groups:generate:error');
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

// ── Tag Report (docs/tag-report/DESIGN.md, TRACKER.md §1) ─────────────────────
//
// All three POST endpoints funnel through lib/tagReportRunner.ts::startTagReportRun
// so tag validation, the candidate-survey existence check, effective_max_surveys
// resolution, and the concurrency-safe insert are exactly one code path
// regardless of trigger source (manual click, custom-range click, or the
// Automated-mode scheduler). Zero-fresh-AI enforcement (DESIGN.md §2.2) holds by
// construction: the only agentsClient call anywhere in this section is inside
// startTagReportRun's post-insert kick-off.

async function checkTagReportDailyLimit(orgId: string, tagId: string): Promise<{ ok: boolean; limit: number; count: number }> {
  const todayUtcMidnight = `${new Date().toISOString().split('T')[0]}T00:00:00Z`;
  const { rows } = await query<{ run_count: number }>(
    `SELECT COUNT(*)::int AS run_count FROM group_insight_runs
     WHERE org_id = $1 AND $2::uuid = ANY(tag_ids)
       AND run_mode IN ('manual', 'custom_range')
       AND created_at >= $3::timestamptz`,
    [orgId, tagId, todayUtcMidnight],
  ).catch(() => ({ rows: [{ run_count: 0 }] }));
  const count = rows[0]?.run_count ?? 0;
  return { ok: count < TAG_REPORT_MANUAL_DAILY_LIMIT, limit: TAG_REPORT_MANUAL_DAILY_LIMIT, count };
}

// ── GET /api/group-insights/tag-reports — index list (Task 18) ────────────────
// Registered BEFORE the generic GET /:runId handler below — "tag-reports" is a
// single path segment and would otherwise be captured as :runId.

router.get('/tag-reports', requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const sortParam = typeof req.query.sort === 'string' ? req.query.sort : 'recent';
    const sortKey = (['recent', 'alpha', 'survey_count'] as const).includes(sortParam as never) ? sortParam : 'recent';
    const orderBy = {
      recent:       'latest_run_created_at DESC NULLS LAST',
      alpha:        't.name ASC',
      survey_count: 'survey_count DESC',
    }[sortKey as 'recent' | 'alpha' | 'survey_count'];

    const params: unknown[] = [req.orgId];
    let searchClause = '';
    if (q) {
      params.push(`%${q}%`);
      searchClause = `AND t.name ILIKE $${params.length}`;
    }

    // JOIN LATERAL (not LEFT JOIN) on the latest-run subquery is what enforces
    // "for every tag with >=1 group_insight_runs row" — a tag with zero runs
    // produces zero rows from the lateral subquery and is naturally excluded.
    const { rows } = await query(
      `SELECT
         t.id AS tag_id, t.name AS tag_name, t.color AS tag_color,
         COUNT(DISTINCT m.survey_id)::int AS survey_count,
         lr.id AS latest_run_id, lr.run_mode AS latest_run_mode, lr.created_at AS latest_run_created_at,
         (SELECT COUNT(*)::int FROM group_insight_run_sources girs
           WHERE girs.run_id = lr.id AND girs.checkpoint_id IS NOT NULL) AS latest_run_included_count,
         (SELECT COUNT(*)::int FROM group_insight_run_sources girs
           WHERE girs.run_id = lr.id
             AND (girs.exclusion_reason IS NOT NULL OR girs.trend_eligible = FALSE)) AS latest_run_warning_count,
         -- Fixed 2026-07-03 (customer-journey review finding): the Reports
         -- index page's Automated-schedules-active stat read automated_enabled
         -- off this response, but this field was never selected here -- the
         -- tile was permanently stuck at 0. Reads the same program_config
         -- JSONB path the due-tags sweep (tagReportScheduler.ts) already uses
         -- as the source of truth for whether Automated mode is on for a tag.
         COALESCE((t.program_config -> 'tag_report_automated' ->> 'enabled')::boolean, FALSE) AS automated_enabled
       FROM survey_tags t
       JOIN LATERAL (
         SELECT id, run_mode, created_at FROM group_insight_runs gir
         WHERE gir.org_id = t.org_id AND gir.tag_ids @> ARRAY[t.id]::uuid[]
         ORDER BY gir.created_at DESC
         LIMIT 1
       ) lr ON true
       LEFT JOIN survey_tag_mappings m ON m.tag_id = t.id AND m.org_id = t.org_id
       WHERE t.org_id = $1 ${searchClause}
       GROUP BY t.id, t.program_config, lr.id, lr.run_mode, lr.created_at
       ORDER BY ${orderBy}`,
      params,
    );

    const tags = (rows as Record<string, unknown>[]).map((row) => {
      const includedCount = Number(row.latest_run_included_count ?? 0);
      const warningCount = Number(row.latest_run_warning_count ?? 0);
      // has_active_warning is derived, not stored (TRACKER.md §1 Task 18): true
      // when the latest run has any unresolved comparability/staleness warning,
      // or is the single-survey R-T2a case — omitted (false) when there are no
      // source rows yet (predates per-checkpoint tracking, or still in flight).
      const hasActiveWarning = includedCount > 0 && (includedCount === 1 || warningCount > 0);
      return {
        tag_id:     row.tag_id,
        tag_name:   row.tag_name,
        tag_color:  row.tag_color,
        survey_count: row.survey_count,
        automated_enabled: Boolean(row.automated_enabled),
        latest_run: {
          run_id:     row.latest_run_id,
          mode:       row.latest_run_mode,
          created_at: row.latest_run_created_at,
          has_active_warning: hasActiveWarning,
        },
      };
    });

    // Corrected 2026-07-02 (integration reconciliation): frontend's
    // TagReportsIndexResponse type (built in parallel, and the endpoint's only
    // real consumer — it hasn't shipped yet) expects `{reports, total}`, not the
    // original `{tags}`.
    res.json({ reports: tags, total: tags.length });
  } catch (err: unknown) {
    logger.error({ err: (err as Error).message, orgId: req.orgId }, 'tag_report:index:error');
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

// ── POST /api/group-insights/tag-report/manual ─────────────────────────────────

router.post('/tag-report/manual', requireAuth, requireRole('analyst'), async (req: Request, res: Response): Promise<void> => {
  try {
    const { tag_id } = req.body as Record<string, unknown>;
    if (!tag_id || typeof tag_id !== 'string') {
      res.status(400).json({ error: 'tag_id is required' });
      return;
    }

    const rate = await checkTagReportDailyLimit(req.orgId, tag_id);
    if (!rate.ok) {
      res.status(429).json({ error: 'Daily tag report limit reached for this tag', code: 'RATE_LIMITED', limit: rate.limit });
      return;
    }

    const result = await startTagReportRun({
      orgId: req.orgId, userId: req.userId, tagId: tag_id, runMode: 'manual', trigger: 'manual',
    });
    if (!result.ok) { res.status(result.status).json({ error: result.error }); return; }
    res.status(202).json({ run_id: result.runId, attached_to_existing: result.attachedToExisting, created_at: result.createdAt });
  } catch (err: unknown) {
    logger.error({ err: (err as Error).message, orgId: req.orgId }, 'tag_report:manual:error');
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

// ── POST /api/group-insights/tag-report/custom-range ────────────────────────────

router.post('/tag-report/custom-range', requireAuth, requireRole('analyst'), async (req: Request, res: Response): Promise<void> => {
  try {
    const { tag_id, window_start, window_end } = req.body as Record<string, unknown>;
    if (!tag_id || typeof tag_id !== 'string') {
      res.status(400).json({ error: 'tag_id is required' });
      return;
    }
    if (typeof window_start !== 'string' || typeof window_end !== 'string'
      || Number.isNaN(Date.parse(window_start)) || Number.isNaN(Date.parse(window_end))) {
      res.status(400).json({ error: 'window_start and window_end must be valid ISO timestamps' });
      return;
    }
    if (Date.parse(window_end) <= Date.parse(window_start)) {
      res.status(400).json({ error: 'window_end must be after window_start' });
      return;
    }

    const rate = await checkTagReportDailyLimit(req.orgId, tag_id);
    if (!rate.ok) {
      res.status(429).json({ error: 'Daily tag report limit reached for this tag', code: 'RATE_LIMITED', limit: rate.limit });
      return;
    }

    const result = await startTagReportRun({
      orgId: req.orgId, userId: req.userId, tagId: tag_id, runMode: 'custom_range', trigger: 'manual',
      windowStart: window_start, windowEnd: window_end,
    });
    if (!result.ok) { res.status(result.status).json({ error: result.error }); return; }
    res.status(202).json({ run_id: result.runId, attached_to_existing: result.attachedToExisting, created_at: result.createdAt });
  } catch (err: unknown) {
    logger.error({ err: (err as Error).message, orgId: req.orgId }, 'tag_report:custom_range:error');
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

// ── POST /api/group-insights/tag-report/automated — internal-only ──────────────
// X-Internal-Key gated (requireInternalKey), NOT requireAuth — called by the
// Automated-mode scheduler (lib/tagReportScheduler.ts), never by an end-user
// client. There is no Clerk session on this call, so org_id travels explicitly
// in the body (mirrors routes/internal-workflows.ts's established pattern for
// "another internal service/process calls back into Node").

router.post('/tag-report/automated', requireInternalKey, async (req: Request, res: Response): Promise<void> => {
  try {
    const { org_id, tag_id } = req.body as Record<string, unknown>;
    if (!org_id || typeof org_id !== 'string') {
      res.status(400).json({ error: 'org_id is required' });
      return;
    }
    if (!tag_id || typeof tag_id !== 'string') {
      res.status(400).json({ error: 'tag_id is required' });
      return;
    }

    const result = await startTagReportRun({
      orgId: org_id, userId: null, tagId: tag_id, runMode: 'automated', trigger: 'scheduled',
    });
    if (!result.ok) { res.status(result.status).json({ error: result.error }); return; }
    res.status(202).json({ run_id: result.runId, attached_to_existing: result.attachedToExisting, created_at: result.createdAt });
  } catch (err: unknown) {
    logger.error({ err: (err as Error).message, orgId: req.body?.org_id }, 'tag_report:automated:error');
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

// ── GET /api/group-insights/tag-report/:runId ──────────────────────────────────
// Joins group_insight_run_sources, partitions group_insights by metric_key.

router.get('/tag-report/:runId', requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const { rows } = await query(
      `SELECT id, org_id, tag_ids, survey_ids, status, run_mode, window_start, window_end,
              trigger, parent_run_id, stream_events, error_log, result_json, created_at, completed_at
       FROM group_insight_runs
       WHERE id = $1 AND org_id = $2`,
      [req.params.runId, req.orgId],
    );
    if (!rows.length) { res.status(404).json({ error: 'Run not found' }); return; }
    // Tag Report always populates tag_ids with exactly one ID (TRACKER.md
    // reconciliation item 5 — the array survives only for schema compatibility
    // with the older multi-tag group_insights system); frontend's TagReportRun
    // type wants a singular tag_id alongside the raw tag_ids array.
    const run = { ...rows[0], tag_id: (rows[0] as { tag_ids: string[] }).tag_ids?.[0] };

    const { rows: sources } = await query(
      `SELECT gs.id, gs.run_id, gs.survey_id, s.title AS survey_title, gs.checkpoint_id, gs.bracket_position,
              gs.source_mode, gs.matched_checkpoint_window_start, gs.matched_checkpoint_window_end,
              gs.boundary_offset_interval, gs.trend_eligible, gs.response_count_at_generation,
              gs.exclusion_reason, gs.created_at
       FROM group_insight_run_sources gs
       LEFT JOIN surveys s ON s.id = gs.survey_id
       WHERE gs.run_id = $1 AND gs.org_id = $2
       ORDER BY gs.created_at ASC`,
      [req.params.runId, req.orgId],
    ).catch(() => ({ rows: [] }));

    // Multi-metric partitioning (TRACKER.md §1 Query Implementation Notes):
    // partition by metric_key in SQL (ORDER BY COALESCE), bucket in one pass here
    // — not N queries per metric.
    const { rows: insights } = await query(
      `SELECT * FROM group_insights
       WHERE run_id = $1 AND org_id = $2
       ORDER BY COALESCE(metric_key, 'zzz_unpartitioned') ASC, priority DESC NULLS LAST`,
      [req.params.runId, req.orgId],
    ).catch(() => ({ rows: [] }));

    const insightsByMetric: Record<string, unknown[]> = {};
    for (const insight of insights as Record<string, unknown>[]) {
      const key = (insight.metric_key as string | null) ?? 'unpartitioned';
      if (!insightsByMetric[key]) insightsByMetric[key] = [];
      insightsByMetric[key].push(insight);
    }

    // metric_tracks / disclosure fields (2026-07-02 integration reconciliation,
    // lib/tagReportView.ts): the frontend's DisclosureBanner and MetricHeadlineCard
    // render against this pre-shaped view, not the raw rows above — kept alongside
    // the raw shape (sources/insights/insights_by_metric) rather than replacing it,
    // since the raw shape is still useful for the Trail page's provenance view.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const metricTracks = buildMetricTracks(insights as any, sources as any, run as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const disclosure = buildDisclosure(run as any, sources as any);

    res.json({
      run, sources, insights, insights_by_metric: insightsByMetric,
      metric_tracks: metricTracks, ...disclosure,
    });
  } catch (err: unknown) {
    logger.error({ err: (err as Error).message, runId: req.params.runId }, 'tag_report:get_run:error');
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

// ── GET /api/group-insights/tag-report/:runId/trail ────────────────────────────
// Full provenance + bounded parent_run_id lineage walk (cap depth ~10).

const TAG_REPORT_TRAIL_MAX_DEPTH = 10;

router.get('/tag-report/:runId/trail', requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const { rows: rootRows } = await query(
      'SELECT id FROM group_insight_runs WHERE id = $1 AND org_id = $2',
      [req.params.runId, req.orgId],
    );
    if (!rootRows.length) { res.status(404).json({ error: 'Run not found' }); return; }

    // Walk parent_run_id backwards, capped at TAG_REPORT_TRAIL_MAX_DEPTH hops —
    // should never actually chain that deep (ON DELETE SET NULL on parent_run_id
    // prevents true cycles), but a hard cap keeps this endpoint's worst case
    // bounded regardless.
    const lineage: Record<string, unknown>[] = [];
    let currentId: string | null = req.params.runId;
    let hops = 0;
    while (currentId && hops < TAG_REPORT_TRAIL_MAX_DEPTH) {
      const { rows: runRows } = await query(
        `SELECT id, run_mode, trigger, window_start, window_end, parent_run_id,
                status, created_at, completed_at
         FROM group_insight_runs
         WHERE id = $1 AND org_id = $2`,
        [currentId, req.orgId],
      );
      if (!runRows.length) break;
      const run = runRows[0] as Record<string, unknown>;
      lineage.push(run);
      currentId = (run.parent_run_id as string | null) ?? null;
      hops++;
    }

    const lineageIds = lineage.map((r) => r.id as string);
    const { rows: sources } = await query(
      `SELECT gs.run_id, gs.survey_id, s.title AS survey_title, gs.checkpoint_id,
              gs.bracket_position, gs.trend_eligible, gs.response_count_at_generation,
              gs.exclusion_reason, gs.matched_checkpoint_window_start, gs.matched_checkpoint_window_end
       FROM group_insight_run_sources gs
       LEFT JOIN surveys s ON s.id = gs.survey_id
       WHERE gs.run_id = ANY($1::uuid[]) AND gs.org_id = $2
       ORDER BY gs.created_at ASC`,
      [lineageIds, req.orgId],
    ).catch(() => ({ rows: [] }));

    res.json({
      run_id: req.params.runId,
      lineage,
      sources,
      truncated: hops >= TAG_REPORT_TRAIL_MAX_DEPTH && currentId !== null,
    });
  } catch (err: unknown) {
    logger.error({ err: (err as Error).message, runId: req.params.runId }, 'tag_report:trail:error');
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

// ── GET /api/survey-groups/insights/:runId/status ─────────────────────────────

router.get('/:runId/status', requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const { rows } = await query(
      `SELECT id, status, tag_ids, survey_ids, stream_events, error_log, created_at, completed_at,
              EXTRACT(EPOCH FROM (COALESCE(completed_at, NOW()) - created_at))::int AS duration_seconds
       FROM group_insight_runs
       WHERE id = $1 AND org_id = $2`,
      [req.params.runId, req.orgId]
    );
    if (!rows.length) { res.status(404).json({ error: 'Run not found' }); return; }

    const run = rows[0] as Record<string, unknown>;
    const errorLog = Array.isArray(run.error_log) ? (run.error_log as unknown[]) : [];
    res.json({
      run_id:           run.id,
      status:           run.status,
      tag_ids:          run.tag_ids,
      survey_ids:       run.survey_ids,
      stream_events:    Array.isArray(run.stream_events) ? run.stream_events : [],
      error:            errorLog.length ? errorLog[errorLog.length - 1] : null,
      error_log:        errorLog,
      duration_seconds: run.duration_seconds != null ? parseInt(String(run.duration_seconds)) : null,
      created_at:       run.created_at,
      completed_at:     run.completed_at || null,
    });
  } catch (err: unknown) {
    logger.error({ err: (err as Error).message, runId: req.params.runId }, 'survey_groups:status:error');
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

// ── GET /api/survey-groups/insights/:runId/stream (SSE) ───────────────────────

router.get('/:runId/stream', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { runId } = req.params;

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
      res.end();
      return;
    }
    try {
      const { rows } = await query(
        `SELECT id, status, stream_events
         FROM group_insight_runs
         WHERE id = $1 AND org_id = $2`,
        [runId, req.orgId]
      );
      if (!rows.length) return;

      const run = rows[0] as Record<string, unknown>;
      const events = Array.isArray(run.stream_events) ? (run.stream_events as unknown[]) : [];

      // Send any new events since last poll
      for (const ev of events.slice(lastEventCount)) {
        send(ev);
        lastEventCount++;
      }

      if (run.status === 'completed' || run.status === 'failed') {
        // Fetch the group insights for this run
        const { rows: insights } = await query(
          `SELECT * FROM group_insights WHERE run_id = $1 AND org_id = $2
           ORDER BY priority DESC NULLS LAST`,
          [runId, req.orgId]
        ).catch(() => ({ rows: [] }));

        send({ event: 'complete', data: { insights, status: run.status } });
        clearInterval(interval);
        res.end();
      }
    } catch (err: unknown) {
      logger.warn({ err: (err as Error).message, runId }, 'survey_groups:stream:poll_error');
    }
  };

  const interval = setInterval(poll, 3000);
  await poll();
  req.on('close', () => clearInterval(interval));
});

// ── GET /api/survey-groups/insights/:runId — get completed run + insights ─────

router.get('/:runId', requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const { rows } = await query(
      `SELECT id, status, tag_ids, survey_ids, stream_events, error_log, created_at, completed_at
       FROM group_insight_runs
       WHERE id = $1 AND org_id = $2`,
      [req.params.runId, req.orgId]
    );
    if (!rows.length) { res.status(404).json({ error: 'Run not found' }); return; }

    const run = rows[0];

    const { rows: insights } = await query(
      `SELECT * FROM group_insights WHERE run_id = $1 AND org_id = $2
       ORDER BY priority DESC NULLS LAST`,
      [req.params.runId, req.orgId]
    ).catch(() => ({ rows: [] }));

    res.json({ run, insights });
  } catch (err: unknown) {
    logger.error({ err: (err as Error).message, runId: req.params.runId }, 'survey_groups:get_run:error');
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

// ── POST /api/group-insights/crystal — Crystal chat with group scope ──────────

router.post('/crystal', requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const { tag_ids, message, conversation_history } = req.body as Record<string, unknown>;

    if (!Array.isArray(tag_ids) || (tag_ids as unknown[]).length === 0) {
      res.status(400).json({ error: 'tag_ids must be a non-empty array' });
      return;
    }
    if (!message || typeof message !== 'string' || (message as string).trim().length < 2) {
      res.status(400).json({ error: 'message is required' });
      return;
    }

    // Validate tags belong to this org
    const { rows: validTags } = await query(
      'SELECT id, name FROM survey_tags WHERE id = ANY($1::uuid[]) AND org_id = $2',
      [tag_ids, req.orgId]
    );
    if (validTags.length !== (tag_ids as unknown[]).length) {
      res.status(400).json({ error: 'One or more tag IDs are invalid' });
      return;
    }

    const payload = {
      tag_ids,
      org_id:               req.orgId,
      user_id:              req.userId,
      message:              (message as string).trim(),
      conversation_history: Array.isArray(conversation_history) ? conversation_history : [],
    };

    logger.info({ orgId: req.orgId, tagCount: (tag_ids as unknown[]).length }, 'survey_groups:crystal:request');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90_000);

    let fetchRes;
    try {
      fetchRes = await fetch(`${AGENTS_URL}/groups/crystal`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type':   'application/json',
          'X-Internal-Key': AGENTS_INTERNAL_KEY,
        },
        body: JSON.stringify(payload),
      });
      clearTimeout(timer);
    } catch (fetchErr: unknown) {
      clearTimeout(timer);
      throw fetchErr;
    }

    if (!fetchRes.ok) {
      const body = await fetchRes.text().catch(() => '');
      logger.error({ status: fetchRes.status, body, orgId: req.orgId }, 'survey_groups:crystal:agents_error');
      res.status(502).json({ error: 'AI service unavailable. Please try again.' });
      return;
    }

    const response = await fetchRes.json() as Record<string, unknown>;
    res.json({
      answer:       response.answer,
      suggestions:  response.suggestions  || [],
      insight_refs: response.insight_refs || [],
      citations:    response.citations    || [],
    });
  } catch (err: unknown) {
    logger.error({ err: (err as Error).message, orgId: req.orgId }, 'survey_groups:crystal:error');
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

export default router;
