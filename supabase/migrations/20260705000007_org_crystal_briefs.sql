-- Org Dashboard (Command Center) — org_crystal_briefs (scheduled weekly brief archive).
-- No `organizations` table exists (org_id is a bare Clerk-issued TEXT everywhere in this
-- schema); `hallucination_score` (not `trust_score` — that name/scale is taken by
-- insights.trust_score, a different per-insight-row 0-100 scale) per Decision 16 item 9.

CREATE TABLE IF NOT EXISTS org_crystal_briefs (
  id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               TEXT         NOT NULL,
  date_range_start     DATE         NOT NULL,
  date_range_end       DATE         NOT NULL,
  brief_text           TEXT         NOT NULL,
  recommendations      JSONB        NOT NULL DEFAULT '[]',
  generated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  model_version        TEXT         NOT NULL,
  input_snapshot       JSONB,
  parent_checkpoint_id UUID         REFERENCES org_crystal_briefs(id),  -- self-FK, nullable
  delta_from_prior     JSONB,
  hallucination_score  NUMERIC(5,4),                                   -- nullable
  trust_json           JSONB,
  CONSTRAINT org_crystal_briefs_org_week_unique UNIQUE (org_id, date_range_start),
  CONSTRAINT org_crystal_briefs_range_valid CHECK (date_range_end >= date_range_start)
);

CREATE INDEX IF NOT EXISTS org_crystal_briefs_org_range_idx
  ON org_crystal_briefs (org_id, date_range_start DESC);

-- recommendations JSONB shape (Decision 14/16):
-- [
--   {
--     "rank": 1,
--     "action": "Investigate declining NPS in the Onboarding survey (down 12 points WoW)",
--     "rationale": "Three of your five critical-path programs show correlated negative sentiment",
--     "survey_id": "uuid | null",
--     "tag_id": "uuid | null",                 -- survey_tags.id ("Tag Group" = a survey_tags row)
--     "action_type": "investigate | review | celebrate | monitor",
--     "source_insight_ids": ["uuid", ...]       -- empty array when numbers-only; never fabricated
--   }
-- ]
-- Citation-bearing recommendations (non-empty source_insight_ids) are gated behind
-- ORG_BRIEF_ENABLE_INSIGHT_CITATIONS (default false) per Decision 24 — CrystalOS scope, not
-- this migration's concern, but the column shape must support it from day one.

-- ROLLBACK:
-- DROP TABLE IF EXISTS org_crystal_briefs;
