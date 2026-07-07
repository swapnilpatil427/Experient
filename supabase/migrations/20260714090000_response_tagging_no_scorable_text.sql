-- Distinguishes "confirmed no scorable text, terminal" from "processed but
-- missing sentiment/emotion/effort, retriable" for responses.ai_enriched_at.
--
-- Two motivating gaps:
--   1. lib/response_tagging.py::_process_batch only marked a batch
--      "enriched, no text" (ai_enriched_at set, all AI fields left NULL)
--      when EVERY response in it lacked scorable text. A MIXED batch (some
--      responses answered the open-text question, some skipped/left it
--      blank) silently left the non-answering rows with ai_enriched_at
--      permanently NULL — _fetch_untagged_responses's ORDER BY
--      submitted_at ASC then kept re-selecting those exact same
--      unscoreable oldest rows on every future sweep, forever, instead of
--      ever marking them done. Fixed by having _mark_enriched_no_text set
--      this flag whenever it marks a response enriched with nothing to
--      score.
--   2. The manual Catch Up Tagging job (lib/topic_backfill.py) needs a way
--      to retry a QUARANTINED response (ai_enriched_at set, but
--      ai_sentiment/ai_emotion/ai_effort_score never got written because
--      every automatic attempt failed — see ai_tagging_attempts) without
--      ALSO re-selecting every genuinely textless response forever on
--      every manual click. This flag is exactly the "don't ever retry,
--      there's nothing there" terminal marker that lets those two cases be
--      told apart.
ALTER TABLE responses
  ADD COLUMN IF NOT EXISTS ai_no_scorable_text BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN responses.ai_no_scorable_text IS
  'TRUE when this response has no open-text answer to score (skipped/blank) — ai_enriched_at is still set (terminal, never re-swept), but sentiment/emotion/effort/topics are intentionally left NULL. Distinguishes this from a quarantined response (also ai_enriched_at set with those fields NULL) which failed rather than having nothing to score, and IS retriable via the manual Catch Up Tagging job.';
