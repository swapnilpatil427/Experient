-- Org Dashboard (Command Center) — org_metrics_daily materialized view.
--
-- Real-schema notes (see docs/org-dashboard/IMPLEMENTATION_SPEC.md — binding over
-- ARCHITECTURE.md/ROADMAP.md wherever they conflict):
--   * Response table is `responses` (NOT `survey_responses`).
--   * Sentiment lives on `response_embeddings` (one row per open-text answer, so a single
--     response can have multiple rows) — average to response grain first, then roll up.
--   * `surveys.deleted_at IS NULL` is the exclude-soft-deleted filter (not a status check).
--
-- Refreshed every 15 minutes by backend/src/scheduler/jobs/orgMetricsDaily.job.ts via
-- REFRESH MATERIALIZED VIEW CONCURRENTLY (pg_cron is not installed in this stack — see
-- Decision 22 in docs/org-dashboard/DECISIONS.md).
--
-- response_velocity mirrors ARCHITECTURE.md's formula exactly: responses in the last 24h as
-- a proportion of the trailing-7-day daily average. This is a NOW()-relative "current pulse"
-- reading, not a per-`date`-row historical figure — every date row for a given org ends up
-- with the same velocity value as a side effect of the single GROUP BY pass. That matches the
-- original design intent (the field is meant to be read off today's/latest row); it is not
-- meaningful for a historical date and callers should treat it that way.

CREATE MATERIALIZED VIEW IF NOT EXISTS org_metrics_daily AS
WITH response_sentiment AS (
  SELECT response_id, AVG(sentiment) AS avg_sentiment
  FROM response_embeddings
  WHERE sentiment IS NOT NULL
  GROUP BY response_id
)
SELECT
  r.org_id,
  DATE_TRUNC('day', r.submitted_at)::DATE                            AS date,
  COUNT(*)::INT                                                       AS total_responses,
  ROUND(AVG(r.nps_score)::NUMERIC, 2)                                 AS avg_nps,
  ROUND(AVG(rs.avg_sentiment)::NUMERIC, 4)                            AS avg_sentiment,
  COUNT(DISTINCT r.survey_id)::INT                                    AS active_surveys,
  ROUND(
    COUNT(*) FILTER (WHERE r.submitted_at >= NOW() - INTERVAL '24 hours')::NUMERIC
    / NULLIF(
        COUNT(*) FILTER (WHERE r.submitted_at >= NOW() - INTERVAL '7 days')::NUMERIC / 7.0,
        0
      ),
    2
  )                                                                    AS response_velocity,
  NOW()                                                                AS created_at
FROM responses r
JOIN surveys s ON s.id = r.survey_id AND s.deleted_at IS NULL
LEFT JOIN response_sentiment rs ON rs.response_id = r.id
GROUP BY r.org_id, DATE_TRUNC('day', r.submitted_at)::DATE
WITH DATA;

CREATE UNIQUE INDEX IF NOT EXISTS org_metrics_daily_org_date_unique
  ON org_metrics_daily (org_id, date);
CREATE INDEX IF NOT EXISTS org_metrics_daily_org_date_desc_idx
  ON org_metrics_daily (org_id, date DESC);

-- ROLLBACK:
-- DROP MATERIALIZED VIEW IF EXISTS org_metrics_daily;
