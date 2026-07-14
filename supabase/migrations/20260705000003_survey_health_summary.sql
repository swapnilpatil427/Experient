-- Org Dashboard (Command Center) — survey_health_summary materialized view.
--
-- Real-schema notes:
--   * anomaly_count reuses the existing alert_events/alert_rules system (Decision 23 in
--     docs/org-dashboard/DECISIONS.md) — there is no separate "survey_anomalies" table.
--   * "Tag Group" = a survey_tags row via survey_tag_mappings, many-to-many (0-5 tags per
--     survey, DB-enforced) — NOT a singular tag_group_id column on surveys.
--   * last_nps / sentiment_trend are computed from `responses`/`response_embeddings` over a
--     rolling 14-day window (this view is meant to reflect "current" per-survey health, not a
--     static all-time cached figure), not read off `surveys.nps_score` (a different, all-time
--     rollup maintained elsewhere).
--
-- Refreshed hourly by backend/src/scheduler/jobs/surveyHealthSummary.job.ts.

CREATE MATERIALIZED VIEW IF NOT EXISTS survey_health_summary AS
WITH response_sentiment AS (
  SELECT response_id, AVG(sentiment) AS avg_sentiment
  FROM response_embeddings
  WHERE sentiment IS NOT NULL
  GROUP BY response_id
),
recent AS (
  SELECT
    r.survey_id,
    ROUND(
      AVG(r.nps_score) FILTER (WHERE r.submitted_at >= NOW() - INTERVAL '14 days')::NUMERIC, 2
    )                                                                              AS last_nps,
    COUNT(*) FILTER (WHERE r.submitted_at >= NOW() - INTERVAL '7 days')::INT       AS response_velocity_7d,
    ROUND(
      AVG(rs.avg_sentiment) FILTER (WHERE r.submitted_at >= NOW() - INTERVAL '7 days')::NUMERIC, 4
    )                                                                              AS recent_sentiment,
    ROUND(
      AVG(rs.avg_sentiment) FILTER (
        WHERE r.submitted_at BETWEEN NOW() - INTERVAL '14 days' AND NOW() - INTERVAL '7 days'
      )::NUMERIC, 4
    )                                                                              AS prior_sentiment,
    MAX(r.submitted_at)                                                           AS last_activity_at
  FROM responses r
  LEFT JOIN response_sentiment rs ON rs.response_id = r.id
  WHERE r.submitted_at >= NOW() - INTERVAL '14 days'
  GROUP BY r.survey_id
),
anomaly_counts AS (
  SELECT survey_id, COUNT(*)::INT AS anomaly_count
  FROM alert_events
  WHERE status = 'active' AND survey_id IS NOT NULL
  GROUP BY survey_id
),
survey_tags_agg AS (
  SELECT
    m.survey_id,
    array_agg(t.id ORDER BY t.name)   AS tag_ids,
    array_agg(t.name ORDER BY t.name) AS tag_names
  FROM survey_tag_mappings m
  JOIN survey_tags t ON t.id = m.tag_id
  GROUP BY m.survey_id
)
SELECT
  s.id                                                                 AS survey_id,
  s.org_id,
  COALESCE(r.last_nps, 0)                                              AS last_nps,
  COALESCE(r.response_velocity_7d, 0)                                  AS response_velocity_7d,
  CASE
    WHEN r.recent_sentiment IS NULL OR r.prior_sentiment IS NULL THEN 'stable'
    WHEN r.recent_sentiment > r.prior_sentiment + 0.05            THEN 'improving'
    WHEN r.recent_sentiment < r.prior_sentiment - 0.05            THEN 'declining'
    ELSE 'stable'
  END                                                                   AS sentiment_trend,
  COALESCE(ac.anomaly_count, 0)                                        AS anomaly_count,
  CASE
    WHEN COALESCE(ac.anomaly_count, 0) > 2 OR COALESCE(r.last_nps, 0) < -20 THEN 'critical'
    WHEN COALESCE(ac.anomaly_count, 0) > 0 OR COALESCE(r.last_nps, 0) < 20  THEN 'attention'
    ELSE 'healthy'
  END                                                                   AS health_status,
  COALESCE(sta.tag_ids, '{}')                                          AS tag_ids,
  COALESCE(sta.tag_names, '{}')                                        AS tag_names,
  r.last_activity_at,
  NOW()                                                                AS created_at
FROM surveys s
LEFT JOIN recent r            ON r.survey_id = s.id
LEFT JOIN anomaly_counts ac   ON ac.survey_id = s.id
LEFT JOIN survey_tags_agg sta ON sta.survey_id = s.id
WHERE s.deleted_at IS NULL
WITH DATA;

CREATE UNIQUE INDEX IF NOT EXISTS survey_health_summary_survey_unique
  ON survey_health_summary (survey_id);
CREATE INDEX IF NOT EXISTS survey_health_summary_org_status_idx
  ON survey_health_summary (org_id, health_status);
CREATE INDEX IF NOT EXISTS survey_health_summary_org_activity_idx
  ON survey_health_summary (org_id, last_activity_at DESC);

-- ROLLBACK:
-- DROP MATERIALIZED VIEW IF EXISTS survey_health_summary;
