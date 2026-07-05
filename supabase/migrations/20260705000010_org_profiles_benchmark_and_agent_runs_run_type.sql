-- Org Dashboard (Command Center) — two small, independent, non-locking additions, combined
-- into one migration file (the feature's 12-file timestamp budget, 20260705000001-000012,
-- doesn't have a slot for each alone; neither needs CONCURRENTLY or its own transaction).

-- benchmark_nps lives on org_profiles — there is no `organizations` table to alter
-- (Decision 25 in docs/org-dashboard/DECISIONS.md). Column is nullable; every existing
-- column on org_profiles is nullable/defaulted, so this is a safe, non-locking addition.
ALTER TABLE org_profiles
  ADD COLUMN IF NOT EXISTS benchmark_nps INTEGER
    CHECK (benchmark_nps IS NULL OR benchmark_nps BETWEEN -100 AND 100);

-- Widen agent_runs.run_type to allow org brief/summary generation runs. Constraint name and
-- the exact current set of allowed values were confirmed by grepping every migration that
-- touches agent_runs.run_type (supabase/migrations/20240514000000_agents.sql created it as
-- 'survey_creation' only; supabase/migrations/20240516000000_insights.sql dropped and
-- recreated it as agent_runs_run_type_check with ('survey_creation','insight_generation') —
-- no later migration has touched it) — do not guess the constraint name or value set.
ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_run_type_check;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_run_type_check
  CHECK (run_type IN ('survey_creation', 'insight_generation', 'org_brief_generation'));

-- ROLLBACK:
-- ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_run_type_check;
-- ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_run_type_check
--   CHECK (run_type IN ('survey_creation', 'insight_generation'));
-- ALTER TABLE org_profiles DROP COLUMN IF EXISTS benchmark_nps;
