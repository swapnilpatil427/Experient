-- org_profiles.plan_tier (added by 20260603000011_org_plan_tier.sql) is restricted to
-- ('starter','growth','enterprise') — three of the five canonical PlanTier values
-- (backend/src/lib/creditPlans.ts::PLAN_TIERS: free/starter/growth/enterprise/platform).
-- credit_accounts.plan_tier (20260625000001_credit_system.sql) already allows all five.
--
-- These two columns are supposed to represent the same concept but drifted apart:
-- getOrCreateAccount() seeds credit_accounts.plan_tier from org_profiles.plan_tier once,
-- on first touch, but creditLedger.ts::setPlan() (POST /api/billing/plan — the actual
-- "change my plan" endpoint) only ever wrote to credit_accounts, never back to
-- org_profiles — the column planGating.ts/seats.ts/roles.ts actually gate on. An org could
-- "upgrade" to Growth (correct credit allowance) and still get 403'd out of
-- Growth-gated features because org_profiles.plan_tier never moved. setPlan() is being
-- updated in the same change to write both columns atomically; this migration widens
-- org_profiles' constraint first so 'free' and 'platform' orgs (which setPlan() can also
-- set) have somewhere valid to land, not just the three seat/Command-Center-relevant tiers.
--
-- NOT VALID + a separate VALIDATE CONSTRAINT, matching this codebase's convention for
-- agent_runs_run_type_check (20260705000010_org_profiles_benchmark_and_agent_runs_run_type.sql):
-- the new set is a strict superset of the old one so validation can never fail, but
-- org_profiles is read on every requireAuth-gated request, so this still avoids the brief
-- ACCESS EXCLUSIVE lock a plain ADD CONSTRAINT would take to re-scan the table.
ALTER TABLE org_profiles DROP CONSTRAINT IF EXISTS org_profiles_plan_tier_check;
ALTER TABLE org_profiles ADD CONSTRAINT org_profiles_plan_tier_check
  CHECK (plan_tier IN ('free', 'starter', 'growth', 'enterprise', 'platform')) NOT VALID;
ALTER TABLE org_profiles VALIDATE CONSTRAINT org_profiles_plan_tier_check;

-- ROLLBACK:
-- ALTER TABLE org_profiles DROP CONSTRAINT IF EXISTS org_profiles_plan_tier_check;
-- ALTER TABLE org_profiles ADD CONSTRAINT org_profiles_plan_tier_check
--   CHECK (plan_tier IN ('starter','growth','enterprise'));
