-- Org Dashboard (Command Center) production-readiness fix — per-org kill switch.
--
-- Separate from the plan-tier gate (backend/src/routes/org-dashboard.ts's router-level
-- middleware): this lets support disable Command Center for one specific problem
-- customer without a redeploy and without affecting anyone else. Nullable/defaulted,
-- following the exact pattern of this feature's earlier `benchmark_nps` addition
-- (supabase/migrations/20260705000010_org_profiles_benchmark_and_agent_runs_run_type.sql)
-- — every existing column on org_profiles is nullable/defaulted, so this is a safe,
-- non-locking addition.
ALTER TABLE org_profiles
  ADD COLUMN IF NOT EXISTS command_center_disabled BOOLEAN DEFAULT FALSE;

-- ROLLBACK:
-- ALTER TABLE org_profiles DROP COLUMN IF EXISTS command_center_disabled;
