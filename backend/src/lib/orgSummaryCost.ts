/**
 * Org-wide Custom Summary credit cost curve (Org Intelligence Dashboard).
 *
 * Deliberately NOT a reuse of `resolveCustomCost`'s survey-level tiers (creditPlans.ts) —
 * docs/org-dashboard/DECISIONS.md Decision 12 (Jordan's flag, reaffirmed in the
 * Addendum's manual-summary spec) found that applying the survey-level 25/50/75 ladder
 * unchanged to an org-wide corpus would systematically undercharge it, since an org
 * summary aggregates responses across every survey in the org for the requested range,
 * not just one survey.
 *
 * This curve keeps `resolveCustomCost`'s base+step shape (cheap to reason about, matches
 * the rest of the credit system) but scales both the base cost (~3x) and the volume
 * thresholds (~4-5x) to reflect org-wide scope. Judgment call: the "2-4x" instruction in
 * IMPLEMENTATION_SPEC.md doesn't pin an exact multiplier or exact thresholds — these are
 * chosen to land near the middle of that range at default settings (75/150/225 vs.
 * survey-level's 25/50/75, i.e. a flat 3x) while remaining fully env-overridable so
 * pricing can be retuned without a code deploy, same as every other cost in
 * creditPlans.ts.
 */
import { CREDIT_COSTS } from './creditPlans';

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/**
 * Base cost for an org-wide custom summary (env-overridable). Defaults to 3x
 * `custom_base` (survey-level Custom Analysis base, default 25) — an org summary
 * always spans every survey in the org for the range, never just one.
 */
const ORG_SUMMARY_BASE = envInt('CREDIT_COST_ORG_SUMMARY_BASE', CREDIT_COSTS.custom_base * 3);

/** Platform ceiling for a single org summary — mirrors resolveCustomCost's 500 ceiling, scaled ~3x for org-wide scope. */
const ORG_SUMMARY_MAX = envInt('CREDIT_COST_ORG_SUMMARY_MAX', 1_500);

/**
 * Org-wide Custom Summary credit cost, tiered by total response count across every
 * contributing survey for the requested date range:
 *
 *   ≤2,000 responses   → base            (default 75)
 *   ≤10,000 responses  → base + 1 step   (default 150)
 *   >10,000 responses  → base + 2 steps  (default 225)
 *
 * Thresholds are ~4-5x `resolveCustomCost`'s survey-level tiers (500/2,000 responses),
 * since an org-wide corpus routinely spans many surveys' worth of responses at once.
 */
export function resolveOrgSummaryCost(responseCount: number): number {
  const base = ORG_SUMMARY_BASE;
  const step = base; // mirrors resolveCustomCost: step size == base at default settings
  const n = Number.isFinite(responseCount) && responseCount > 0 ? Math.trunc(responseCount) : 0;

  let cost: number;
  if (n <= 2_000) cost = base;
  else if (n <= 10_000) cost = base + step;
  else cost = base + step * 2;

  return Math.min(Math.max(cost, 1), ORG_SUMMARY_MAX);
}
