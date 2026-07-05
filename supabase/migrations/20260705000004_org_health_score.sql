-- Org Dashboard (Command Center) — org_health_score (plain table, upserted by a
-- computation procedure — NOT a materialized view, per IMPLEMENTATION_SPEC.md).
--
-- Weighting (ARCHITECTURE.md "Materialized View Refresh Strategy" intent, ported onto the
-- real schema): nps 40%, sentiment 30%, response velocity 20%, anomaly-free 10%.
-- anomaly_free_score counts OPEN, ORG-WIDE alert_events (not per-survey) — distinct from
-- survey_health_summary.anomaly_count, which is per-survey.

CREATE TABLE IF NOT EXISTS org_health_score (
  id                      UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                  TEXT         NOT NULL,
  nps_score               NUMERIC(5,4) NOT NULL,   -- 0.0-1.0, weight 40%
  sentiment_score         NUMERIC(5,4) NOT NULL,   -- 0.0-1.0, weight 30%
  response_velocity_score NUMERIC(5,4) NOT NULL,   -- 0.0-1.0, weight 20%
  anomaly_free_score      NUMERIC(5,4) NOT NULL,   -- 0.0-1.0, weight 10%
  total_score             INT          NOT NULL CHECK (total_score BETWEEN 0 AND 100),
  computed_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  valid_through           TIMESTAMPTZ  NOT NULL,
  CONSTRAINT org_health_score_org_unique UNIQUE (org_id)
);

CREATE INDEX IF NOT EXISTS org_health_score_computed_at_idx
  ON org_health_score (computed_at DESC);

-- Computes/upserts one row per org that has data in org_metrics_daily. Called daily by
-- backend/src/scheduler/jobs/orgHealthScore.job.ts via CALL compute_all_org_health_scores();
CREATE OR REPLACE PROCEDURE compute_all_org_health_scores()
LANGUAGE plpgsql
AS $$
DECLARE
  rec                  RECORD;
  v_nps_score          NUMERIC(5,4);
  v_sentiment_score    NUMERIC(5,4);
  v_velocity_score     NUMERIC(5,4);
  v_anomaly_free_score NUMERIC(5,4);
  v_total_score        INT;
  v_open_anomalies     INT;
BEGIN
  -- Most recent org_metrics_daily row per org (DISTINCT ON + ORDER BY date DESC).
  FOR rec IN
    SELECT DISTINCT ON (org_id) org_id, avg_nps, avg_sentiment, response_velocity
    FROM org_metrics_daily
    ORDER BY org_id, date DESC
  LOOP
    SELECT COUNT(*) INTO v_open_anomalies
    FROM alert_events
    WHERE org_id = rec.org_id AND status = 'active';

    v_nps_score          := LEAST(GREATEST((COALESCE(rec.avg_nps, 0) + 100) / 200.0, 0), 1);
    v_sentiment_score    := LEAST(GREATEST((COALESCE(rec.avg_sentiment, 0) + 1) / 2.0, 0), 1);
    v_velocity_score     := LEAST(COALESCE(rec.response_velocity, 0) / 3.0, 1);
    v_anomaly_free_score := 1 - LEAST(v_open_anomalies::NUMERIC / 10.0, 1);
    v_total_score        := ROUND(
      (v_nps_score * 0.4 + v_sentiment_score * 0.3
        + v_velocity_score * 0.2 + v_anomaly_free_score * 0.1) * 100
    );

    INSERT INTO org_health_score (
      org_id, nps_score, sentiment_score, response_velocity_score,
      anomaly_free_score, total_score, computed_at, valid_through
    ) VALUES (
      rec.org_id, v_nps_score, v_sentiment_score, v_velocity_score,
      v_anomaly_free_score, v_total_score, NOW(), NOW() + INTERVAL '1 day'
    )
    ON CONFLICT (org_id) DO UPDATE SET
      nps_score               = EXCLUDED.nps_score,
      sentiment_score          = EXCLUDED.sentiment_score,
      response_velocity_score  = EXCLUDED.response_velocity_score,
      anomaly_free_score       = EXCLUDED.anomaly_free_score,
      total_score              = EXCLUDED.total_score,
      computed_at              = EXCLUDED.computed_at,
      valid_through            = EXCLUDED.valid_through;
  END LOOP;
END;
$$;

-- ROLLBACK:
-- DROP PROCEDURE IF EXISTS compute_all_org_health_scores();
-- DROP TABLE IF EXISTS org_health_score;
