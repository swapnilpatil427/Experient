-- ── Migration: Tag Report — multi-metric partitioning + max-surveys config ──────
-- See docs/tag-report/DESIGN.md Appendix A.1.3 (metric_key) and A.1.4 (caps).
-- All additive: metric_key IS NULL preserves every existing non-partitioned
-- group_insights row/category unchanged; the two max-surveys columns are
-- nullable overrides in the existing 3-tier settings pattern (per-tag override
-- -> org default -> hardcoded platform fallback, resolved in application code).

ALTER TABLE survey_tags
  ADD COLUMN IF NOT EXISTS max_surveys_override INT
    CHECK (max_surveys_override IS NULL OR (max_surveys_override BETWEEN 1 AND 20));

ALTER TABLE org_insight_defaults
  ADD COLUMN IF NOT EXISTS max_surveys_per_tag_report INT
    CHECK (max_surveys_per_tag_report IS NULL OR (max_surveys_per_tag_report BETWEEN 1 AND 20));

ALTER TABLE group_insights
  ADD COLUMN IF NOT EXISTS metric_key TEXT
    CHECK (metric_key IS NULL OR metric_key IN ('nps', 'csat', 'ces'));

CREATE INDEX IF NOT EXISTS idx_gi_metric_key ON group_insights (org_id, run_id, metric_key)
  WHERE metric_key IS NOT NULL;

COMMENT ON COLUMN survey_tags.max_surveys_override IS
  'Per-tag override for Tag Report''s survey-selection cap. Resolution order: this -> org_insight_defaults.max_surveys_per_tag_report -> hardcoded fallback 20. Platform default when neither is set: 5.';
COMMENT ON COLUMN group_insights.metric_key IS
  'nps | csat | ces | NULL. Once Tag Report evaluates metrics independently (never blended), a single run produces N independent findings, each self-contained. NULL preserved for pre-existing non-metric-partitioned categories.';
