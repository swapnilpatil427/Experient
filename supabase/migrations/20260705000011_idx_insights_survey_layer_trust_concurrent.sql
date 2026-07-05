-- Org Dashboard (Command Center) — supports aggregate_org_metrics' "top 3-5 highest-
-- trust_score insights per critical/attention survey, filtered by layer" query (Addendum 2,
-- Decision 16 item 9). The existing insights indexes ((survey_id, priority DESC NULLS LAST,
-- generated_at DESC) and the insight_hash uniqueness index) do not cover this access pattern
-- and would force a sequential scan per contributing survey on every brief generation.
--
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction block, and no existing migration
-- in this repo uses CONCURRENTLY (grepped supabase/migrations — zero hits), so there was no
-- transaction-wrapping precedent to follow here. scripts/migrate.js wraps every migration
-- file's SQL in BEGIN/COMMIT unconditionally; it has been given a narrow, additive exception
-- (see its isConcurrent check) that skips the transaction wrapper for any migration file whose
-- SQL contains the CONCURRENTLY keyword, running it as a bare statement instead. This file
-- must contain ONLY the CONCURRENTLY statement below — no other DDL — so that exception stays
-- safe and narrowly scoped.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_insights_survey_layer_trust
  ON insights (survey_id, layer, trust_score DESC);

-- ROLLBACK:
-- DROP INDEX CONCURRENTLY IF EXISTS idx_insights_survey_layer_trust;
