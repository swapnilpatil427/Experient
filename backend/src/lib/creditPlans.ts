/**
 * Credit system configuration — the single source of truth for plan allowances and
 * per-action credit costs. Everything is overridable via env so pricing can change
 * without a code deploy (see docs/pricing/PRICING_PROPOSAL.md "Configurable parameters").
 *
 * 1 credit = $0.01. Only the expensive analytical AI is metered; core usage and Copilot
 * survey authoring are bundled (never debited). See docs/pricing/METERING_AND_USAGE.md.
 */

export type PlanTier = 'free' | 'starter' | 'growth' | 'enterprise' | 'platform';

export const PLAN_TIERS: PlanTier[] = ['free', 'starter', 'growth', 'enterprise', 'platform'];

const envInt = (key: string, fallback: number): number => {
  const raw = process.env[key];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
};

/**
 * Monthly AI-credit allowance per plan. `free` is a one-time lifetime grant (monthly
 * allowance 0 — it does not reset), granted into pack_balance at account creation.
 */
export const PLAN_MONTHLY_ALLOWANCE: Record<PlanTier, number> = {
  free:       envInt('CREDIT_ALLOWANCE_FREE', 0),
  starter:    envInt('CREDIT_ALLOWANCE_STARTER', 1_500),
  growth:     envInt('CREDIT_ALLOWANCE_GROWTH', 12_000),
  enterprise: envInt('CREDIT_ALLOWANCE_ENTERPRISE', 80_000),
  platform:   envInt('CREDIT_ALLOWANCE_PLATFORM', 500_000),
};

/** One-time lifetime credits granted to a brand-new free account (≈3 insight runs + 5 Crystal turns). */
export const FREE_LIFETIME_GRANT = envInt('CREDIT_FREE_LIFETIME_GRANT', 225);

/** Monthly list price (USD) per plan — single source of truth for the pricing/upgrade UI. */
export const PLAN_PRICE_USD: Record<PlanTier, number> = {
  free:       0,
  starter:    envInt('CREDIT_PRICE_STARTER', 49),
  growth:     envInt('CREDIT_PRICE_GROWTH', 299),
  enterprise: envInt('CREDIT_PRICE_ENTERPRISE', 1_499),
  platform:   envInt('CREDIT_PRICE_PLATFORM', 0),
};

/** Per-action credit cost. Only metered (expensive AI + pass-through comms) actions appear here. */
export const CREDIT_COSTS = {
  insight_run:     envInt('CREDIT_COST_INSIGHT_RUN', 50),
  crystal_turn:    envInt('CREDIT_COST_CRYSTAL_TURN', 15),
  xo_fusion:       envInt('CREDIT_COST_XO_FUSION', 200),
  broadcast_email: envInt('CREDIT_COST_BROADCAST_EMAIL', 2),
  broadcast_sms:   envInt('CREDIT_COST_BROADCAST_SMS', 8),
  // Insight Pipeline v2 — per-run costs (05_CONFIGURATION.md §7). These are the platform
  // fallbacks; survey_insight_settings / org_insight_defaults may override per org/survey.
  refresh:         envInt('CREDIT_COST_REFRESH', 8),
  manual_quick:    envInt('CREDIT_COST_MANUAL_QUICK', 15),
  manual_expert:   envInt('CREDIT_COST_MANUAL_EXPERT', 40),
  custom_base:     envInt('CREDIT_COST_CUSTOM_BASE', 25),
  // Catch Up Tagging (topic_backfill) — tier 1 (≤500 responses) of a
  // volume-scaled ladder, NOT a flat cost. See resolveTopicBackfillCost below
  // for tiers 2+ and the full pricing rationale (2026-07-13 pricing review).
  topic_backfill:  envInt('CREDIT_COST_TOPIC_BACKFILL', 15),
} as const;

// Tiers 2/3 + the linear per-1,000 rate above tier 3 for
// resolveTopicBackfillCost — independently overridable per this file's
// "everything is overridable via env" principle above.
const TOPIC_BACKFILL_TIER_2_COST         = envInt('CREDIT_COST_TOPIC_BACKFILL_TIER2', 40);
const TOPIC_BACKFILL_TIER_3_COST         = envInt('CREDIT_COST_TOPIC_BACKFILL_TIER3', 200);
const TOPIC_BACKFILL_PER_1K_ABOVE_TIER3  = envInt('CREDIT_COST_TOPIC_BACKFILL_PER_1K', 5);

/**
 * Tiered cost for a Catch Up Tagging (topic_backfill) job, based on the
 * survey's untagged-response backlog size at trigger time.
 *
 * Fixed 2026-07-13 (pricing review, prompted by a sales/product finding that
 * a flat cost was a margin risk at scale): unlike Custom Analysis's bounded,
 * SAMPLED corpus (`resolveCustomCost` above, which can safely flatten out at
 * its top tier), Catch Up Tagging processes EVERY untagged response with no
 * sampling — embeddings + a batched ABSA LLM call scale linearly with count,
 * so cost is genuinely unbounded. A flat top tier here would silently
 * reintroduce the exact bug this function exists to fix, so above tier 3 the
 * cost keeps climbing per additional 1,000 responses rather than flattening,
 * up to the same 500-credit ceiling `resolveCustomCost` uses platform-wide.
 *
 * This is priced as a SPEED convenience, not premium metered AI — the exact
 * same per-response work happens for FREE via the automatic live-stream
 * consumer and the 15-minute scheduler backlog sweep; this button only pays
 * to do it now instead of waiting. Margins here are intentionally thinner
 * than `insight_run`/`manual_expert` for that reason.
 *
 * Tiers (grounded in prod ABSA cost — gemini-2.5-flash, ~$0.05/1,000
 * responses tagged including margin buffer):
 *   0            → 0 (nothing to do — callers should skip billing entirely)
 *   1–500        → CREDIT_COSTS.topic_backfill (15)
 *   501–5,000    → 40
 *   5,001–50,000 → 200
 *   50,001+      → 200 + 5 credits per 1,000 responses above 50,000,
 *                  capped at 500 (covers roughly a 110k-response backlog)
 */
export function resolveTopicBackfillCost(backlogSize: number): number {
  const n = Number.isFinite(backlogSize) && backlogSize > 0 ? Math.trunc(backlogSize) : 0;
  if (n === 0) return 0;
  let cost: number;
  if (n <= 500) cost = CREDIT_COSTS.topic_backfill;
  else if (n <= 5_000) cost = TOPIC_BACKFILL_TIER_2_COST;
  else if (n <= 50_000) cost = TOPIC_BACKFILL_TIER_3_COST;
  else cost = TOPIC_BACKFILL_TIER_3_COST + TOPIC_BACKFILL_PER_1K_ABOVE_TIER3 * Math.ceil((n - 50_000) / 1_000);
  return Math.min(Math.max(cost, 1), 500);
}

export type MeteredAction = keyof typeof CREDIT_COSTS;

export const METERED_ACTIONS = Object.keys(CREDIT_COSTS) as MeteredAction[];

/** Dollar value of one credit (display only). */
export const CREDIT_USD = 0.01;

export function isPlanTier(v: unknown): v is PlanTier {
  return typeof v === 'string' && (PLAN_TIERS as string[]).includes(v);
}

export function costFor(action: MeteredAction): number {
  return CREDIT_COSTS[action];
}

/**
 * Custom Analysis credit cost scaling (05_CONFIGURATION.md §7).
 * Cost scales by corpus-size tier on top of `custom_base`:
 *   ≤500 responses  → base               (default 25)
 *   ≤2000 responses → base + 1 step       (default 50)
 *   >2000 responses → base + 2 steps      (default 75)
 *
 * `custom_base` is env-overridable (`CREDIT_COST_CUSTOM_BASE`, default 25). The per-tier
 * step is derived so the documented 25/50/75 ladder holds at the default base (step = base).
 * Capped at the platform ceiling (500) to mirror the per-run cost validation rules.
 */
export function resolveCustomCost(corpusSize: number): number {
  const base = CREDIT_COSTS.custom_base;
  const step = base; // default base 25 → 25/50/75 ladder
  const n = Number.isFinite(corpusSize) && corpusSize > 0 ? Math.trunc(corpusSize) : 0;
  let cost: number;
  if (n <= 500)       cost = base;
  else if (n <= 2000) cost = base + step;
  else                cost = base + step * 2;
  return Math.min(Math.max(cost, 1), 500);
}

/** Plan period length in days (monthly). Configurable for testing/annual experiments. */
export const PLAN_PERIOD_DAYS = envInt('CREDIT_PERIOD_DAYS', 30);

/**
 * Plan assigned to a brand-new account when org_profiles has no plan_tier. Defaults to 'free'
 * (correct for production). Set CREDIT_DEFAULT_PLAN=enterprise in a dev/demo env to avoid
 * hitting the free lifetime cap while testing.
 */
export const DEFAULT_PLAN: PlanTier = (() => {
  const raw = process.env.CREDIT_DEFAULT_PLAN;
  return isPlanTier(raw) ? raw : 'free';
})();
