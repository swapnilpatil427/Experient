-- Org Dashboard (Command Center) production-readiness fix — supports three separate
-- materialized-view CTEs (org_metrics_daily's tag_metrics, org_topic_trends, and the
-- topic-breakdown drill-down query in org-metrics.service.ts) that all do
-- `GROUP BY response_id` over `response_embeddings`. The existing indexes on this table
-- only cover (org_id, survey_id) and a partial (org_id, emotion) plus the vector index —
-- none of them lead with response_id, so every one of those GROUP BYs forces a sequential
-- scan of the whole table.
--
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction block. This file must contain
-- ONLY the CONCURRENTLY statement below — no other DDL — matching the exact isolation
-- convention established by supabase/migrations/20260705000011_idx_insights_survey_layer_
-- trust_concurrent.sql (scripts/migrate.js detects the CONCURRENTLY keyword and runs that
-- file outside the usual BEGIN/COMMIT wrapper).

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_response_embeddings_response_id
  ON response_embeddings (response_id);

-- ROLLBACK:
-- DROP INDEX CONCURRENTLY IF EXISTS idx_response_embeddings_response_id;
