-- Org Dashboard (Command Center) — org_topic_trends (plain table + computation
-- procedure, NOT a materialized view — needs cross-week comparison a REFRESH can't
-- express).
--
-- Rolls up `survey_topics` (verified columns per supabase/migrations/20240518000000_
-- insights_v2.sql, 20240520000000_topic_centroids.sql, 20240520000001_topic_signals_
-- extended.sql — NOT the fictional "topic_label"/"frequency" names from ARCHITECTURE.md):
--   survey_topics.name            -> topic label
--   survey_topics.volume          -> frequency
--   survey_topics.sentiment_score -> per-survey sentiment (-1.000 .. 1.000)
--   survey_topics.time_window     -> almost always 'all_time' in practice (verified via
--                                     crystalos grep) — this is a live "current state"
--                                     snapshot per survey/topic, not a per-week historical
--                                     log. org_topic_trends itself is what accumulates the
--                                     week-over-week history: each weekly run snapshots the
--                                     current cross-survey rollup and compares it against
--                                     org_topic_trends' own prior week_start rows.

CREATE TABLE IF NOT EXISTS org_topic_trends (
  id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               TEXT         NOT NULL,
  week_start           DATE         NOT NULL,
  topic_label          TEXT         NOT NULL,
  frequency            INT          NOT NULL DEFAULT 0,
  avg_sentiment        NUMERIC(5,4) NOT NULL DEFAULT 0,
  is_new_this_week     BOOLEAN      NOT NULL DEFAULT FALSE,
  frequency_change_pct NUMERIC(8,2),                 -- NULL for new topics
  rank                 INT          NOT NULL CHECK (rank BETWEEN 1 AND 20),
  computed_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT org_topic_trends_org_week_rank_unique UNIQUE (org_id, week_start, rank)
);

CREATE INDEX IF NOT EXISTS org_topic_trends_org_week_idx
  ON org_topic_trends (org_id, week_start DESC);
CREATE INDEX IF NOT EXISTS org_topic_trends_org_topic_idx
  ON org_topic_trends (org_id, topic_label);

-- Snapshots the current cross-survey topic rollup per org (top 20 by frequency), comparing
-- against org_topic_trends' own most recent PRIOR week_start row per (org, topic_label) to
-- derive is_new_this_week / frequency_change_pct. Idempotent within the same week: clears
-- this week's rows first, then re-inserts — reruns never double-count or leave stale ranks
-- behind if the topic count shrinks between runs.
-- Called weekly (Monday) by backend/src/scheduler/jobs/orgTopicTrends.job.ts.
CREATE OR REPLACE PROCEDURE compute_org_topic_trends()
LANGUAGE plpgsql
AS $$
DECLARE
  v_week_start DATE := DATE_TRUNC('week', NOW())::DATE;
BEGIN
  DELETE FROM org_topic_trends WHERE week_start = v_week_start;

  INSERT INTO org_topic_trends (
    org_id, week_start, topic_label, frequency, avg_sentiment,
    is_new_this_week, frequency_change_pct, rank, computed_at
  )
  SELECT
    cur.org_id,
    v_week_start,
    cur.topic_label,
    cur.frequency,
    COALESCE(cur.avg_sentiment, 0),
    (prev.topic_label IS NULL)                                              AS is_new_this_week,
    CASE
      WHEN prev.frequency IS NULL OR prev.frequency = 0 THEN NULL
      ELSE ROUND(((cur.frequency - prev.frequency)::NUMERIC / prev.frequency) * 100, 2)
    END                                                                     AS frequency_change_pct,
    cur.rank,
    NOW()
  FROM (
    SELECT
      s.org_id,
      st.name AS topic_label,
      SUM(st.volume)::INT AS frequency,
      ROUND((
        SUM(st.sentiment_score * st.volume) FILTER (WHERE st.sentiment_score IS NOT NULL)
        / NULLIF(SUM(st.volume) FILTER (WHERE st.sentiment_score IS NOT NULL), 0)
      )::NUMERIC, 4) AS avg_sentiment,
      ROW_NUMBER() OVER (PARTITION BY s.org_id ORDER BY SUM(st.volume) DESC) AS rank
    FROM survey_topics st
    JOIN surveys s ON s.id = st.survey_id AND s.deleted_at IS NULL
    WHERE st.time_window = 'all_time'
    GROUP BY s.org_id, st.name
  ) cur
  LEFT JOIN LATERAL (
    SELECT p.topic_label, p.frequency
    FROM org_topic_trends p
    WHERE p.org_id = cur.org_id
      AND p.topic_label = cur.topic_label
      AND p.week_start < v_week_start
    ORDER BY p.week_start DESC
    LIMIT 1
  ) prev ON TRUE
  WHERE cur.rank <= 20;
END;
$$;

-- ROLLBACK:
-- DROP PROCEDURE IF EXISTS compute_org_topic_trends();
-- DROP TABLE IF EXISTS org_topic_trends;
