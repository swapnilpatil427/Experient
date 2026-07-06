-- Org Dashboard (Command Center) production-readiness fix — supports
-- survey_health_summary's 14-day window filter
-- (`WHERE r.submitted_at >= NOW() - INTERVAL '14 days'`), which scans `responses` across
-- ALL orgs with no per-org scoping in that CTE. The existing indexes that touch
-- submitted_at — `responses_survey_submitted (survey_id, submitted_at DESC)` and
-- `idx_responses_org_submitted (org_id, submitted_at)` — both lead with a different
-- column, so neither one supports an index scan for this org-agnostic, submitted_at-only
-- predicate; it falls back to a sequential scan of the entire table every refresh.
--
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction block. This file must contain
-- ONLY the CONCURRENTLY statement below — no other DDL — matching the exact isolation
-- convention established by supabase/migrations/20260705000011_idx_insights_survey_layer_
-- trust_concurrent.sql (scripts/migrate.js detects the CONCURRENTLY keyword and runs that
-- file outside the usual BEGIN/COMMIT wrapper).

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_responses_submitted_at
  ON responses (submitted_at);

-- ROLLBACK:
-- DROP INDEX CONCURRENTLY IF EXISTS idx_responses_submitted_at;
