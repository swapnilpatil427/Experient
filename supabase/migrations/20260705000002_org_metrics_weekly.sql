-- Org Dashboard (Command Center) — org_metrics_weekly materialized view.
-- Rolls up org_metrics_daily by ISO week; LAG()-based week-over-week deltas.
-- Refreshed daily by backend/src/scheduler/jobs/orgMetricsWeekly.job.ts.

CREATE MATERIALIZED VIEW IF NOT EXISTS org_metrics_weekly AS
WITH weekly AS (
  SELECT
    org_id,
    DATE_TRUNC('week', date)::DATE        AS week_start,
    SUM(total_responses)::INT             AS total_responses,
    ROUND(AVG(avg_nps)::NUMERIC, 2)       AS avg_nps,
    ROUND(AVG(avg_sentiment)::NUMERIC, 4) AS avg_sentiment,
    MAX(active_surveys)::INT              AS active_surveys
  FROM org_metrics_daily
  GROUP BY org_id, DATE_TRUNC('week', date)::DATE
),
lagged AS (
  SELECT
    w.*,
    LAG(w.avg_nps)         OVER (PARTITION BY w.org_id ORDER BY w.week_start) AS prev_nps,
    LAG(w.total_responses) OVER (PARTITION BY w.org_id ORDER BY w.week_start) AS prev_responses,
    LAG(w.avg_sentiment)   OVER (PARTITION BY w.org_id ORDER BY w.week_start) AS prev_sentiment
  FROM weekly w
)
SELECT
  org_id,
  week_start,
  total_responses,
  avg_nps,
  avg_sentiment,
  active_surveys,
  ROUND((avg_nps - COALESCE(prev_nps, avg_nps))::NUMERIC, 2)                   AS nps_wow_delta,
  (total_responses - COALESCE(prev_responses, total_responses))               AS responses_wow_delta,
  ROUND((avg_sentiment - COALESCE(prev_sentiment, avg_sentiment))::NUMERIC, 4) AS sentiment_wow_delta,
  NOW()                                                                       AS created_at
FROM lagged
WITH DATA;

CREATE UNIQUE INDEX IF NOT EXISTS org_metrics_weekly_org_week_unique
  ON org_metrics_weekly (org_id, week_start);
CREATE INDEX IF NOT EXISTS org_metrics_weekly_org_week_desc_idx
  ON org_metrics_weekly (org_id, week_start DESC);

-- ROLLBACK:
-- DROP MATERIALIZED VIEW IF EXISTS org_metrics_weekly;
