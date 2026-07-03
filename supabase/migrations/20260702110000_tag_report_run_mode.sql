-- ── Migration: Tag Report — group_insight_runs additions ────────────────────────
-- See docs/tag-report/DESIGN.md Appendix A.1.1 (authoritative column shapes) and
-- Appendix A.5 (concurrency index). Purely additive — existing rows/callers keep
-- working unchanged: run_mode defaults to 'manual' (today's only behavior),
-- trigger defaults to 'manual', all other new columns are nullable.

ALTER TABLE group_insight_runs
  ADD COLUMN IF NOT EXISTS run_mode      TEXT NOT NULL DEFAULT 'manual'
                            CHECK (run_mode IN ('manual','automated','custom_range')),
  ADD COLUMN IF NOT EXISTS window_start  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS window_end    TIMESTAMPTZ
                            CHECK (window_end IS NULL OR window_start IS NULL OR window_end > window_start),
  ADD COLUMN IF NOT EXISTS parent_run_id UUID REFERENCES group_insight_runs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS trigger       TEXT NOT NULL DEFAULT 'manual'
                            CHECK (trigger IN ('manual','scheduled','api'));

CREATE INDEX IF NOT EXISTS idx_gir_parent_run ON group_insight_runs (parent_run_id) WHERE parent_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_gir_run_mode   ON group_insight_runs (org_id, run_mode, created_at DESC);

-- ── Concurrency guard (Appendix A.5) ─────────────────────────────────────────────
-- Any run (manual, automated, or custom_range) blocks any other run for the same
-- tag while one is in flight. Replaces the earlier (org_id, tag_id, window_bucket)
-- idea from an early draft — that scheme only covered automated-vs-automated races
-- and is not implemented anywhere; this is the sole concurrency mechanism.
CREATE UNIQUE INDEX IF NOT EXISTS uq_gir_tag_inflight
  ON group_insight_runs (org_id, tag_ids)
  WHERE status IN ('pending', 'running');

COMMENT ON COLUMN group_insight_runs.run_mode IS
  'What the user asked for: manual | automated | custom_range. Orthogonal to trigger (what caused it to fire).';
COMMENT ON COLUMN group_insight_runs.trigger IS
  'Causal origin: manual (human click) | scheduled (cron) | api (external integration).';
COMMENT ON COLUMN group_insight_runs.parent_run_id IS
  'Chains a run to the run it supersedes/compares against, making a tag''s report history a traversable linked list.';
