-- Bump the platform-hardcoded default for survey_insight_settings.
-- stream_response_threshold from 10 to 100 new responses, to match:
--   - crystalos/lib/constants.py::DEFAULT_STREAM_THRESHOLD (bumped alongside
--     this migration, 2026-07-04)
--   - crystalos/lib/insight_settings.py::resolve_stream_response_threshold's
--     platform-fallback value
--
-- Column-default-only change: does NOT backfill existing rows. A survey that
-- already has an explicit (or previously-defaulted) value of 10 keeps it —
-- there is no way to distinguish "customer explicitly chose 10" from "row was
-- created before this migration and got the old default" for a NOT NULL
-- column, and silently overwriting either case would be wrong. This only
-- changes what a NEW row gets when the column is omitted from an INSERT.
ALTER TABLE survey_insight_settings
  ALTER COLUMN stream_response_threshold SET DEFAULT 100;
