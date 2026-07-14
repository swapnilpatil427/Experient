-- Org Dashboard (Command Center) — org_custom_summaries (user-requested, arbitrary
-- date-range summaries). Deliberately isolated from org_crystal_briefs (which has a hard
-- UNIQUE(org_id, date_range_start) tied to the scheduled weekly cadence) — no uniqueness
-- constraint here, a user may freely re-run overlapping ranges. Persisted forever (no expiry
-- job): these are user-requested artifacts tied to `requested_by`, and deleting them would
-- break the audit trail that is the point of the feature.
--
-- `requested_by` is TEXT NOT NULL with no FK — there is no `users` table anywhere in this
-- schema; matches the existing custom_reports.created_by / agent_runs.user_id convention.
-- `compared_against_brief_id` references org_crystal_briefs, NOT self-referencing (that would
-- be parent_checkpoint_id's job on org_crystal_briefs — this table optionally points at the
-- nearest automated brief for delta context instead, per Decision 16 item 12).

CREATE TABLE IF NOT EXISTS org_custom_summaries (
  id                        UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                    TEXT         NOT NULL,
  date_range_start          DATE         NOT NULL,
  date_range_end            DATE         NOT NULL,
  status                    TEXT         NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  brief_text                TEXT,                          -- NULL until completed
  recommendations           JSONB        NOT NULL DEFAULT '[]',  -- same shape as org_crystal_briefs
  requested_by              TEXT         NOT NULL,
  requested_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  generated_at              TIMESTAMPTZ,
  model_version             TEXT,
  input_snapshot            JSONB,
  error_message             TEXT,
  compared_against_brief_id UUID         REFERENCES org_crystal_briefs(id),  -- nullable
  CONSTRAINT org_custom_summaries_range_valid CHECK (date_range_end >= date_range_start)
);

CREATE INDEX IF NOT EXISTS org_custom_summaries_org_requested_idx
  ON org_custom_summaries (org_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS org_custom_summaries_org_range_idx
  ON org_custom_summaries (org_id, date_range_start DESC, date_range_end DESC);
CREATE INDEX IF NOT EXISTS org_custom_summaries_pending_idx
  ON org_custom_summaries (status) WHERE status = 'pending';

-- ROLLBACK:
-- DROP TABLE IF EXISTS org_custom_summaries;
