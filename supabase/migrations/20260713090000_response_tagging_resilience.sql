-- Response tagging resilience (2026-07-13): quarantine circuit breaker for
-- permanently-poisoned responses + a new run_type for the manual topic-tagging
-- backfill job.
--
-- Context: lib/response_tagging.py::tag_untagged_responses always re-selects
-- the OLDEST untagged responses first. A single response that reliably fails
-- (malformed answers, a corrupted embedding, etc) used to be re-fetched and
-- re-failed by every future sweep, permanently blocking every response behind
-- it — including brand-new ones. ai_tagging_attempts/ai_tagging_last_error let
-- the sweep quarantine a response after MAX_RESPONSE_TAGGING_ATTEMPTS (see
-- lib/constants.py) instead of retrying it forever.

ALTER TABLE responses
  ADD COLUMN IF NOT EXISTS ai_tagging_attempts   INT  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ai_tagging_last_error TEXT;

COMMENT ON COLUMN responses.ai_tagging_attempts IS
  'Consecutive tagging-sweep failures for this response. Quarantined (ai_enriched_at set) after MAX_RESPONSE_TAGGING_ATTEMPTS.';
COMMENT ON COLUMN responses.ai_tagging_last_error IS
  'Truncated error message from the most recent failed tagging attempt, for ops debugging.';

-- Manual "Backfill Tagging" job (Experience → Topics page). Follows the same
-- agent_runs convention as insight_generation: Node inserts the row, CrystalOS
-- only updates it (stream_events progress, status, heartbeat).
ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_run_type_check;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_run_type_check
  CHECK (run_type IN ('survey_creation', 'insight_generation', 'topic_backfill'));

-- Prevent duplicate concurrent topic_backfill jobs for the same survey
-- (mirrors uq_gir_tag_inflight's pattern for group_insight_runs, see
-- 20260702110000_tag_report_run_mode.sql). Without this, a check-then-insert
-- race in the Node route (two near-simultaneous POSTs — a double-submit that
-- beats the frontend's button-disable, or two browser tabs) could both pass
-- the "is one already running" check, insert two rows, double-debit credits,
-- and race two jobs against the identical backlog.
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_runs_topic_backfill_inflight
  ON agent_runs (survey_id, org_id)
  WHERE run_type = 'topic_backfill' AND status = 'running';
