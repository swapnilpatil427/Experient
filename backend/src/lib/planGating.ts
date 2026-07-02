// Plan-tier gating for workflow triggers (Nina, 2026-07-01,
// DEEP_AUDIT_PM_FINDINGS.md §6d/§6c/§10c — "Crystal Signals require a Growth
// plan" was 100% marketing copy with zero code enforcement: no route middleware,
// no engine check, no plan field on WorkflowTriggerDef at all). This module is
// the single place that answers "is trigger type X allowed on org Y's current
// plan" — both callers (routes/workflows.ts at save time, workflowEngine.ts at
// execution time) import from here so the two checks can never drift apart.
//
// Defense in depth, by design (not an accident of two teams building the same
// thing twice):
//   - Save-time check (routes/workflows.ts POST/PUT) gives immediate, actionable
//     UX — a customer on Free trying to wire up `crystal.anomaly_detected` gets a
//     403 with an upgrade prompt the moment they hit Save, not a workflow that
//     silently never fires.
//   - Execution-time check (workflowEngine.ts runWorkflow) exists because plans
//     change after a workflow is already saved. This codebase's existing
//     precedent for "does a downgrade immediately affect already-provisioned
//     usage" is lib/seats.ts::checkSeatLimit, which reads org_profiles.plan_tier
//     fresh on every call — a downgrade is never grandfathered for currently
//     running usage. Following that precedent here: an org that saved a
//     `crystal.sentiment_spike` workflow while on Growth and is later downgraded
//     to Free should have that workflow stop firing on the very next trigger, not
//     keep running until someone happens to re-save it.
import { query } from './db';
import { PLAN_TIERS, DEFAULT_PLAN, isPlanTier, type PlanTier } from './creditPlans';
import { registry } from './workflowRegistry';

const TIER_RANK: Record<PlanTier, number> = Object.fromEntries(
  PLAN_TIERS.map((tier, i) => [tier, i])
) as Record<PlanTier, number>;

/**
 * The minimum plan tier a trigger type requires, or undefined if ungated. Reads
 * through `registry()` (the same public API routes/workflows.ts's own
 * GET /registry uses) rather than importing the raw `TRIGGERS` array directly —
 * keeps this in lockstep with the one function every existing test double
 * already mocks, instead of adding a second, easy-to-forget mock surface.
 */
export function minPlanTierFor(triggerType: string | null | undefined): PlanTier | undefined {
  if (!triggerType) return undefined;
  return registry().triggers.find((t) => t.type === triggerType)?.minPlanTier;
}

/** Resolve an org's current plan tier from org_profiles (defaults per creditPlans.DEFAULT_PLAN). */
export async function resolveOrgPlanTier(orgId: string): Promise<PlanTier> {
  try {
    const { rows } = await query<{ plan_tier: string | null }>(
      'SELECT plan_tier FROM org_profiles WHERE org_id = $1', [orgId]
    );
    const t = rows[0]?.plan_tier;
    return isPlanTier(t) ? t : DEFAULT_PLAN;
  } catch {
    return DEFAULT_PLAN; // org_profiles may not exist in some envs — fail to the safe default
  }
}

export function meetsPlanTier(orgTier: PlanTier, required: PlanTier): boolean {
  return TIER_RANK[orgTier] >= TIER_RANK[required];
}

export interface TriggerGateResult {
  allowed: boolean;
  requiredTier?: PlanTier;
  orgTier?: PlanTier;
}

/**
 * Check whether `orgId`'s current plan allows using `triggerType`. Triggers with
 * no `minPlanTier` are always allowed. Looks up the org's plan live (no caching)
 * so both the save-time and execution-time callers always see the current plan.
 */
export async function checkTriggerTierGate(orgId: string, triggerType: string | null | undefined): Promise<TriggerGateResult> {
  const required = minPlanTierFor(triggerType);
  if (!required) return { allowed: true };
  const orgTier = await resolveOrgPlanTier(orgId);
  return { allowed: meetsPlanTier(orgTier, required), requiredTier: required, orgTier };
}

/** Upgrade-prompt-shaped message for a 403 rejection (save-time and error-message reuse). */
export function upgradeRequiredMessage(triggerType: string, requiredTier: PlanTier): string {
  const label = requiredTier.charAt(0).toUpperCase() + requiredTier.slice(1);
  return `The '${triggerType}' trigger requires the ${label} plan or higher. Upgrade your plan to use this trigger.`;
}
