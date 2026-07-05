-- Org Dashboard (Command Center) — supports custom-range summary queries that need to hit
-- `responses` directly for partial first/last-day fragments at the edges of a custom range
-- (Addendum: Org Insight History & Manual Custom-Range Summary), and generally any org-scoped
-- time-range scan over `responses` that isn't already covered by org_metrics_daily.
--
-- Same CONCURRENTLY / non-transactional caveat as 20260705000011 — see that file's header.
-- This file must contain ONLY the CONCURRENTLY statement below.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_responses_org_submitted
  ON responses (org_id, submitted_at);

-- ROLLBACK:
-- DROP INDEX CONCURRENTLY IF EXISTS idx_responses_org_submitted;
