-- Org Dashboard (Command Center) — two small, independent, non-locking additions, combined
-- into one migration file (the feature's 12-file timestamp budget, 20260705000001-000012,
-- doesn't have a slot for each alone; neither needs CONCURRENTLY or its own transaction).

-- benchmark_nps lives on org_profiles — there is no `organizations` table to alter
-- (Decision 25 in docs/org-dashboard/DECISIONS.md). Column is nullable; every existing
-- column on org_profiles is nullable/defaulted, so this is a safe, non-locking addition.
ALTER TABLE org_profiles
  ADD COLUMN IF NOT EXISTS benchmark_nps INTEGER
    CHECK (benchmark_nps IS NULL OR benchmark_nps BETWEEN -100 AND 100);

-- Widen agent_runs.run_type to allow org brief/summary generation runs. Constraint name was
-- confirmed by grepping every migration that touches agent_runs.run_type
-- (supabase/migrations/20240514000000_agents.sql created it as 'survey_creation' only;
-- 20240516000000_insights.sql dropped and recreated it as agent_runs_run_type_check with
-- ('survey_creation','insight_generation')) — do not guess the constraint name.
-- Also includes 'topic_backfill': the manual "Backfill Tagging" job
-- (lib/topic_backfill.py / routes/insights.ts) already writes agent_runs rows with that
-- run_type ahead of its own migration for this same constraint
-- (20260713090000_response_tagging_resilience.sql, merged into main after this migration
-- was written on the org-dashboard branch) — that migration re-derives the constraint from
-- scratch too and must in turn keep 'org_brief_generation' once both land on main, or each
-- migration undoes the other's value depending on which runs last.
-- NOT VALID + a separate VALIDATE CONSTRAINT (Decision 16 item 9's own stated convention
-- for exactly this situation): agent_runs is a hot table written on every survey-creation/
-- insight-generation run platform-wide and may already hold production rows. A plain
-- `ADD CONSTRAINT ... CHECK (...)` takes a full ACCESS EXCLUSIVE lock while validating
-- every existing row. `NOT VALID` makes the ADD CONSTRAINT itself fast (it only briefly
-- locks to register the constraint for new/updated rows); the subsequent VALIDATE
-- CONSTRAINT then scans existing rows under a SHARE UPDATE EXCLUSIVE lock, which does not
-- block concurrent reads or writes.
ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_run_type_check;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_run_type_check
  CHECK (run_type IN ('survey_creation', 'insight_generation', 'org_brief_generation', 'topic_backfill')) NOT VALID;
ALTER TABLE agent_runs VALIDATE CONSTRAINT agent_runs_run_type_check;

-- ROLLBACK:
-- ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_run_type_check;
-- ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_run_type_check
--   CHECK (run_type IN ('survey_creation', 'insight_generation'));
-- ALTER TABLE org_profiles DROP COLUMN IF EXISTS benchmark_nps;
