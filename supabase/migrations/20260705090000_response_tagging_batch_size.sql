-- response_tagging_batch_size (added 2026-07-04, alongside crystalos/lib/response_tagging.py)
--
-- Governs how many new-response stream events accumulate before
-- consumers/response_stream.py runs a lightweight sentiment/emotion/effort/topic
-- tagging sweep for untagged responses — a SECOND, independent, much lighter
-- trigger from stream_response_threshold above, which still gates full
-- report+checkpoint generation (unchanged, default 100).
--
-- Same shape as stream_response_threshold: NOT NULL DEFAULT on
-- survey_insight_settings (every row always has a value), nullable override on
-- org_insight_defaults (NULL = fall through to the survey/platform default).
-- Default 1 — tag every response as it arrives; high-frequency surveys can raise
-- this up to 10 to batch several responses per sweep.
ALTER TABLE survey_insight_settings
  ADD COLUMN IF NOT EXISTS response_tagging_batch_size INT NOT NULL DEFAULT 1
    CHECK (response_tagging_batch_size >= 1 AND response_tagging_batch_size <= 10);

ALTER TABLE org_insight_defaults
  ADD COLUMN IF NOT EXISTS response_tagging_batch_size INT
    CHECK (response_tagging_batch_size IS NULL
           OR (response_tagging_batch_size >= 1 AND response_tagging_batch_size <= 10));
