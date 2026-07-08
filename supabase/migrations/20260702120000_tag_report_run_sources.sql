-- ── Migration: Tag Report — group_insight_run_sources (new table) ───────────────
-- See docs/tag-report/DESIGN.md Appendix A.1.2 (authoritative). One row per
-- checkpoint selected for a run, per survey: 'single' for Manual/Automated,
-- 'start'+'end' pair for Custom Range's bracketed-snapshot delta.
--
-- Tag Report never generates new checkpoints; it only reads/diffs checkpoints
-- the per-survey insight pipeline already produced (crystalos/graphs/insights.py),
-- which is why checkpoint_id targets insight_checkpoints_v2, not insight_reports.

CREATE TABLE IF NOT EXISTS group_insight_run_sources (
  id                              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                          UUID         NOT NULL REFERENCES group_insight_runs(id) ON DELETE CASCADE,
  survey_id                       UUID         NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
  checkpoint_id                   UUID         REFERENCES insight_checkpoints_v2(id) ON DELETE SET NULL,
  org_id                          TEXT         NOT NULL,

  bracket_position                TEXT         NOT NULL
                                   CHECK (bracket_position IN ('single','start','end')),
  source_mode                     TEXT         NOT NULL
                                   CHECK (source_mode IN ('latest','bracket_pair')),

  matched_checkpoint_window_start TIMESTAMPTZ,
  matched_checkpoint_window_end   TIMESTAMPTZ,
  boundary_offset_interval        INTERVAL,

  trend_eligible                  BOOLEAN      NOT NULL DEFAULT FALSE,
  response_count_at_generation    INT          NOT NULL DEFAULT 0,

  -- Only ever set on HARD exclusions (checkpoint_id IS NULL — survey never
  -- entered the run at all). The SOFT case (survey included, but below the
  -- response-count floor) is fully captured by trend_eligible=false +
  -- response_count_at_generation above; it does not get a text reason here.
  exclusion_reason                TEXT
                                   CHECK (exclusion_reason IS NULL OR exclusion_reason IN (
                                     'no_checkpoint_in_range',
                                     'excluded_by_recency_cap'
                                   )),

  created_at                      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  UNIQUE (run_id, survey_id, bracket_position)
);

CREATE INDEX IF NOT EXISTS idx_girs_run       ON group_insight_run_sources (run_id);
CREATE INDEX IF NOT EXISTS idx_girs_survey    ON group_insight_run_sources (survey_id, checkpoint_id);
CREATE INDEX IF NOT EXISTS idx_girs_excluded  ON group_insight_run_sources (run_id) WHERE exclusion_reason IS NOT NULL;

COMMENT ON TABLE group_insight_run_sources IS
  'Durable per-survey, per-checkpoint provenance for a group_insight_runs row. Empty for runs produced by the old shallow group_insights.py graph — frontend must treat "no source rows" as "predates per-checkpoint tracking," not an error.';
COMMENT ON COLUMN group_insight_run_sources.trend_eligible IS
  'Denormalized decision frozen at run time — depends on settings that can change later, so it is not recomputed from timestamps at read time.';
