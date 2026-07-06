-- Org Dashboard (Command Center) — org_custom_summaries trust columns.
-- org_crystal_briefs got hallucination_score/trust_json in
-- 20260705000007_org_crystal_briefs.sql; org_custom_summaries never did, so every
-- crystalos/lib/org_brief_verify.py::_write_verification_result UPDATE against
-- org_custom_summaries has been throwing a column-does-not-exist error since day one
-- (caught, logged, never surfaced) — manual/custom-range summaries have never actually
-- been verified. Purely additive, nullable, no default needed — matches the existing
-- org_crystal_briefs convention exactly.

ALTER TABLE org_custom_summaries
  ADD COLUMN IF NOT EXISTS hallucination_score NUMERIC(5,4),
  ADD COLUMN IF NOT EXISTS trust_json JSONB;

-- ROLLBACK:
-- ALTER TABLE org_custom_summaries DROP COLUMN IF EXISTS hallucination_score;
-- ALTER TABLE org_custom_summaries DROP COLUMN IF EXISTS trust_json;
