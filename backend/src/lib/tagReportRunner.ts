/**
 * Tag Report — shared run-creation flow (TRACKER.md §1 Tasks 6/7/13).
 *
 * Used by all three POST endpoints (manual, custom-range, automated) in
 * `routes/survey-groups.ts` AND by the Automated-mode due-tags sweep
 * (`lib/tagReportScheduler.ts`) so there is exactly ONE code path that creates a
 * Tag Report run, regardless of trigger source.
 *
 * Owns only what TRACKER.md reconciliation item 7 assigns to the backend: tag
 * validation/org-scoping, a cheap candidate-survey existence check,
 * effective_max_surveys resolution, and the concurrency-safe run insert. Zero
 * `insight_checkpoints_v2` reads happen here — CrystalOS's `tag_report.py` graph
 * owns all checkpoint-level resolution, backfill, and gating, using the
 * `effective_max_surveys` this module resolves as its `target_n`.
 *
 * Zero-fresh-AI enforcement (DESIGN.md §2.2): the only CrystalOS call anywhere in
 * this module is the explicit `generateTagReport(...)` kick-off AFTER a run row
 * is durably created — there is no other `agentsClient` import or call in the
 * selection path, and none is made at all when this call attaches to an
 * already-in-flight run (no duplicate generation kick-off).
 */
import { query } from './db';
import * as agentsClient from './agentsClient';
import logger from './logger';
import { getOrgScopedTag, resolveEffectiveMaxSurveys, tagHasAnyCandidateSurvey } from './tagReportSelection';
import {
  insertGroupInsightRunWithConcurrencyGuard,
  type GroupInsightRunMode,
  type GroupInsightRunTrigger,
} from './groupInsightRunConcurrency';

export type TagReportRunMode = GroupInsightRunMode;
export type TagReportTrigger = GroupInsightRunTrigger;

export interface StartTagReportRunOptions {
  orgId: string;
  userId: string | null;
  tagId: string;
  runMode: TagReportRunMode;
  trigger: TagReportTrigger;
  windowStart?: string | null;
  windowEnd?: string | null;
}

export type StartTagReportRunResult =
  | { ok: true; runId: string; attachedToExisting: boolean; createdAt: string }
  | { ok: false; status: number; error: string };

/**
 * Validate + resolve + (concurrency-safe) create a Tag Report run, then fire the
 * (best-effort, fire-and-forget) CrystalOS kick-off. Never awaits the CrystalOS
 * pipeline itself — only the HTTP kick-off is best-effort-caught, matching the
 * existing `generateGroupInsights` call pattern in the pre-existing `/generate`
 * route.
 */
export async function startTagReportRun(opts: StartTagReportRunOptions): Promise<StartTagReportRunResult> {
  const tag = await getOrgScopedTag(opts.tagId, opts.orgId);
  if (!tag) return { ok: false, status: 404, error: 'Tag not found' };

  const hasCandidates = await tagHasAnyCandidateSurvey(opts.tagId, opts.orgId);
  if (!hasCandidates) return { ok: false, status: 400, error: 'This tag has no surveys to report on' };

  const effectiveMaxSurveys = await resolveEffectiveMaxSurveys(opts.tagId, opts.orgId);

  const { runId, attachedToExisting, createdAt } = await insertGroupInsightRunWithConcurrencyGuard({
    orgId: opts.orgId,
    createdBy: opts.userId,
    tagIds: [opts.tagId],
    // Tag Report never resolves survey membership on the backend (reconciliation
    // item 7) — CrystalOS's fetch_next_batch resolves candidates directly from
    // tag_id. survey_ids starts empty; group_insight_run_sources (written by
    // CrystalOS) is the real per-survey provenance record for Tag Report runs.
    surveyIds: [],
    runMode: opts.runMode,
    trigger: opts.trigger,
    windowStart: opts.windowStart ?? null,
    windowEnd: opts.windowEnd ?? null,
  });

  if (!attachedToExisting) {
    logger.info({ orgId: opts.orgId, runId, tagId: opts.tagId, runMode: opts.runMode }, 'tag_report:run_started');
    agentsClient
      .generateTagReport(runId, opts.orgId, opts.tagId, opts.runMode, effectiveMaxSurveys, opts.windowStart ?? null, opts.windowEnd ?? null)
      .catch((err: unknown) => {
        logger.error({ err: (err as Error).message, runId }, 'tag_report:generate:agents_error');
        query("UPDATE group_insight_runs SET status = 'failed', completed_at = NOW() WHERE id = $1", [runId]).catch(() => {});
      });
  } else {
    logger.info({ orgId: opts.orgId, runId, tagId: opts.tagId, runMode: opts.runMode }, 'tag_report:attached_to_inflight_run');
  }

  return { ok: true, runId, attachedToExisting, createdAt };
}
