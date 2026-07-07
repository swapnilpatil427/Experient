-- "Uncategorized" bucket for topic orphans that can't be resolved by the
-- manual Catch Up Tagging job (Experience → Topics page): a response
-- already fully sentiment/emotion/effort-scored, sitting in topic_candidates
-- (doesn't match any existing centroid), that STILL never crosses
-- min_cluster_size on a discovery flush after several real attempts.
--
-- Before this: such responses stayed permanently invisible — not "failed,"
-- just silently sitting in the topic_candidates buffer forever with no
-- signal anywhere that they existed. lib/topic_backfill.py::run_topic_backfill
-- now flags them here the moment it detects that wait-state (see its
-- "evidence-collection stall" handling), so they're visible/filterable on the
-- Data page (Topics column shows "Uncategorized" instead of a blank "—")
-- and a human can go look for a common thread across them.
--
-- Deliberately a SEPARATE column from responses.ai_topics, not a synthetic
-- ["Uncategorized"] value written into ai_topics itself — several existing
-- checks across graphs/insights.py and lib/response_tagging.py treat
-- "ai_topics is non-empty" as "this response's topic is already resolved,
-- stop reconsidering it" (bootstrap-orphan detection, discovery aspect
-- hints, already-decorated skip lists). Writing a fake topic value into
-- ai_topics would silently make every one of those treat "Uncategorized" as
-- a real, resolved topic and never reconsider the response again — exactly
-- the opposite of the goal (these should keep getting a fair shot at a real
-- topic on every future manual backfill click, live-traffic accumulation, or
-- full pipeline run). ai_topics_pending is a purely additive signal nothing
-- existing reads, so it changes no other behavior.
ALTER TABLE responses
  ADD COLUMN IF NOT EXISTS ai_topics_pending BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN responses.ai_topics_pending IS
  'TRUE when this response could not be assigned to an existing topic or clustered into a new one after real attempts, so it is administratively bucketed as "Uncategorized" for visibility. ai_topics stays NULL (this response remains eligible for future assignment/discovery attempts) — cleared back to FALSE the moment a real topic is later found. Always check ai_topics IS NULL alongside this flag: a real topic found later takes precedence and this flag may be stale until the next write touches the row.';

CREATE INDEX IF NOT EXISTS responses_ai_topics_pending_idx
  ON responses (survey_id, org_id)
  WHERE ai_topics_pending = TRUE;
