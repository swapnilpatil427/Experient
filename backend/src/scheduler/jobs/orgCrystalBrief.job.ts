import { query } from '../../lib/db';
import logger from '../../lib/logger';
import * as agentsClient from '../../lib/agentsClient';
import { fetchAllOrgBriefEligibility } from '../../services/org-metrics.service';
import { currentIsoWeekRange } from '../../routes/org-dashboard';

/**
 * orgCrystalBrief — auto-scheduled weekly (prod/staging) or daily-refresh (dev)
 * generation of the org-level Crystal Brief.
 *
 * The scheduler registry (backend/src/scheduler/registry.ts) is a pure fixed-interval
 * scheduler with no day-of-week primitive, so — mirroring orgTopicTrends.job.ts's own
 * "tick daily, self-gate to Monday UTC inside the handler" pattern — this job is
 * registered on a daily tick and self-gates based on environment tier:
 *
 *   - production / staging: only proceed past the gate on Monday UTC (real weekly
 *     cadence — one brief per org per ISO week, matching `org_crystal_briefs`'
 *     UNIQUE(org_id, date_range_start)).
 *   - dev: proceed on every tick (deliberate — a developer testing locally
 *     shouldn't have to wait a week to see the automation work). This does NOT
 *     invent a new "daily period" concept: it still generates for the *same*
 *     current-ISO-week range every time, so a dev-tier tick is just a faster
 *     automatic-refresh cadence of the same weekly-shaped brief, landing on the
 *     same upsert-on-(org_id, date_range_start) row the manual "regenerate" button
 *     already targets.
 *
 * For the (possibly gated) run, all eligible orgs (>=3 surveys, >=14 days of data —
 * see org-metrics.service.ts's `fetchAllOrgBriefEligibility`, one aggregate query,
 * not N+1) are processed SEQUENTIALLY with a small delay between each
 * `agentsClient.triggerOrgBrief` call — this fans out real LLM-calling work to
 * CrystalOS, so a `Promise.all` here would thundering-herd it (mirrors
 * `resumeDelayedExecutions.ts`/`credentialHealth.ts`'s own per-item isolation
 * pattern: one org's failure must never abort the rest of the sweep).
 */

function currentEnvTier(): 'production' | 'staging' | 'dev' {
  const nodeEnv = (process.env.NODE_ENV || '').toLowerCase();
  if (nodeEnv === 'production') return 'production';
  if (nodeEnv === 'staging' || process.env.AGENTS_ENV === 'staging') return 'staging';
  return 'dev';
}

const MONDAY_UTC = 1; // Date#getUTCDay(): 0 = Sunday, 1 = Monday

// Small delay between sequential per-org CrystalOS triggers, so a tick with many
// eligible orgs doesn't fire a burst of concurrent LLM-calling requests at once.
// Env-overridable for ops tuning, matching this codebase's existing `intSec`-style
// convention (registry.ts) without needing a new registry primitive.
const DEFAULT_INTER_ORG_DELAY_MS = 2_000;
function interOrgDelayMs(): number {
  const n = Number(process.env.ORG_CRYSTAL_BRIEF_INTER_ORG_DELAY_MS);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : DEFAULT_INTER_ORG_DELAY_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function orgCrystalBrief(): Promise<{ affected: number; note: string }> {
  const tier = currentEnvTier();

  if (tier !== 'dev' && new Date().getUTCDay() !== MONDAY_UTC) {
    return { affected: 0, note: `skipped — env=${tier}, not Monday UTC (env-gated weekly cadence)` };
  }

  const { start, end } = currentIsoWeekRange();

  // Both batch queries below run before the per-org loop's own try/catch — wrapped here
  // so a transient DB blip (connection reset, pool exhaustion) degrades to a clean
  // "0 affected, will retry next tick" result instead of throwing and surfacing as an
  // opaque job failure. This is a different failure mode than the per-org isolation the
  // loop below already guarantees (one org's CrystalOS call failing never aborts the
  // rest) — this guards the batch-level setup steps that precede the loop entirely.
  let eligibleOrgIds: string[];
  let notEligibleCount: number;
  let alreadyGeneratedSet: Set<string>;
  try {
    const eligibility = await fetchAllOrgBriefEligibility();
    eligibleOrgIds = eligibility.filter((e) => e.eligible).map((e) => e.orgId);
    notEligibleCount = eligibility.length - eligibleOrgIds.length;

    if (eligibleOrgIds.length === 0) {
      return {
        affected: 0,
        note: `env=${tier} week=${start}..${end} eligible=0 notEligible=${notEligibleCount}`,
      };
    }

    // Batched existence check — one query for every eligible org rather than one
    // per-org SELECT (avoids N+1 the same way fetchAllOrgBriefEligibility does for
    // the eligibility scan itself).
    const { rows: existingRows } = await query<{ org_id: string }>(
      `SELECT org_id FROM org_crystal_briefs WHERE org_id = ANY($1) AND date_range_start = $2`,
      [eligibleOrgIds, start],
    );
    alreadyGeneratedSet = new Set(existingRows.map((r) => r.org_id));
  } catch (err: unknown) {
    logger.error(
      { err: (err as Error).message, job: 'org-crystal-brief' },
      'org-crystal-brief: eligibility/existence batch query failed — skipping this tick, will retry next',
    );
    return { affected: 0, note: `env=${tier} week=${start}..${end} error: ${(err as Error).message}` };
  }

  let triggered = 0;
  let alreadyGenerated = 0;
  let failed = 0;

  for (let i = 0; i < eligibleOrgIds.length; i++) {
    const orgId = eligibleOrgIds[i];
    if (alreadyGeneratedSet.has(orgId)) {
      alreadyGenerated++;
      continue;
    }
    try {
      await agentsClient.triggerOrgBrief({
        orgId,
        dateRangeStart: start,
        dateRangeEnd: end,
        periodType: 'weekly',
        requestedBy: 'scheduler',
      });
      triggered++;
    } catch (err: unknown) {
      failed++;
      logger.error(
        { err: (err as Error).message, orgId, job: 'org-crystal-brief' },
        'org-crystal-brief: trigger failed for org — continuing sweep',
      );
    }
    // Sequential, not Promise.all — a small pause between orgs so this doesn't
    // thundering-herd CrystalOS with concurrent LLM-calling requests. Skipped after
    // the last org — nothing left to stagger against, so it would be pure added
    // wall-clock time with no benefit.
    if (i < eligibleOrgIds.length - 1) await sleep(interOrgDelayMs());
  }

  const note = `env=${tier} week=${start}..${end} eligible=${eligibleOrgIds.length} `
    + `notEligible=${notEligibleCount} triggered=${triggered} alreadyGenerated=${alreadyGenerated} failed=${failed}`;
  logger.info({ job: 'org-crystal-brief', tier, start, end, triggered, alreadyGenerated, failed, notEligibleCount }, note);
  return { affected: triggered, note };
}
