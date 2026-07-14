/**
 * Set an org's plan tier directly, bypassing the `billing:manage`-gated
 * POST /api/billing/plan route entirely — for dev/staging setup when nobody in the org
 * has the Super Admin role yet (billing:manage is Super-Admin-only, see
 * src/lib/rbac.ts::BUILTIN_ROLES), or when there's no real Stripe subscription flow to
 * drive it: Stripe in this codebase only fulfills one-time credit-pack purchases
 * (src/routes/webhooks/stripe.ts, checkout.session.completed) — there is no Stripe
 * subscription webhook that sets plan_tier. That's a normal, expected gap for
 * dev/staging: reach for this script there instead of trying to configure Stripe.
 *
 * Calls the real creditLedger.setPlan() (not a hand-rolled UPDATE) so credit_accounts'
 * monthly_allowance/allowance_remaining/period_start and org_profiles.plan_tier all move
 * together correctly, exactly as the real billing route would.
 *
 *   npm run set:plan -- <org_id> <free|starter|growth|enterprise|platform>
 *
 * Reads DATABASE_URL from backend/.env (via dotenv) — point it at dev or staging as needed.
 */
import 'dotenv/config';
import { setPlan } from '../src/lib/creditLedger';
import { isPlanTier } from '../src/lib/creditPlans';
import { pool } from '../src/lib/db';

async function main(): Promise<void> {
  const [orgId, plan] = process.argv.slice(2);

  if (!orgId || !isPlanTier(plan)) {
    console.error('Usage: npm run set:plan -- <org_id> <free|starter|growth|enterprise|platform>');
    process.exit(1);
  }

  const balance = await setPlan(orgId, plan);
  console.log(`[set-org-plan] ${orgId} → ${balance.plan_tier} (allowance: ${balance.allowance_remaining}/${balance.monthly_allowance})`);
}

main()
  .catch((err) => { console.error('[set-org-plan] failed:', err); process.exitCode = 1; })
  .finally(() => pool.end());
