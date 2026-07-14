-- Org Dashboard (Command Center) — tag_metrics materialized view.
-- Replaces the fictional "tag_group_metrics" from ARCHITECTURE.md: a "Tag Group" is a
-- survey_tags row, joined many-to-many via survey_tag_mappings (0-5 tags/survey).
-- Refreshed every 15 minutes by backend/src/scheduler/jobs/orgMetricsDaily.job.ts
-- (same cadence as org_metrics_daily; see IMPLEMENTATION_SPEC.md scheduler job list).

CREATE MATERIALIZED VIEW IF NOT EXISTS tag_metrics AS
WITH response_sentiment AS (
  SELECT response_id, AVG(sentiment) AS avg_sentiment
  FROM response_embeddings
  WHERE sentiment IS NOT NULL
  GROUP BY response_id
)
SELECT
  t.id                                     AS tag_id,
  t.org_id,
  t.name                                   AS tag_name,
  DATE_TRUNC('day', r.submitted_at)::DATE  AS date,
  COUNT(*)::INT                            AS total_responses,
  ROUND(AVG(r.nps_score)::NUMERIC, 2)      AS avg_nps,
  ROUND(AVG(rs.avg_sentiment)::NUMERIC, 4) AS avg_sentiment,
  COUNT(DISTINCT s.id)::INT                AS active_surveys,
  NOW()                                    AS created_at
FROM survey_tag_mappings m
JOIN survey_tags t ON t.id = m.tag_id
JOIN surveys s      ON s.id = m.survey_id AND s.deleted_at IS NULL
JOIN responses r    ON r.survey_id = s.id
LEFT JOIN response_sentiment rs ON rs.response_id = r.id
GROUP BY t.id, t.org_id, t.name, DATE_TRUNC('day', r.submitted_at)::DATE
WITH DATA;

CREATE UNIQUE INDEX IF NOT EXISTS tag_metrics_tag_date_unique
  ON tag_metrics (tag_id, date);
CREATE INDEX IF NOT EXISTS tag_metrics_org_date_idx
  ON tag_metrics (org_id, date DESC);
CREATE INDEX IF NOT EXISTS tag_metrics_tag_date_desc_idx
  ON tag_metrics (tag_id, date DESC);

-- ROLLBACK:
-- DROP MATERIALIZED VIEW IF EXISTS tag_metrics;
