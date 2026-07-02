-- Response tags — real persistence for the `data.tag_responses` workflow action.
--
-- XM_VERIFICATION_REPORT.md Priority 3 (Kenji, verification pass): the registry
-- marks `data.tag_responses` `live: true` and it's in workflowEngine.ts's
-- LIVE_ACTIONS set, but executeAction's case for it never issued a query at all —
-- it returned a fake `status: 'completed'` shape with zero DB write. Confirmed no
-- existing mechanism to delegate to: no `tags`/`tag_ids` column on `responses` in
-- any prior migration, no `response_tags` table. `survey_tags`/`survey_tag_mappings`
-- (20260622000001_survey_groups.sql) tag SURVEYS, not individual RESPONSES — a
-- different concept (the Program/tag-scoping mechanism for workflow scope), so
-- this is a new, disjoint table, not an extension of that one.
--
-- Shape choice: normalized junction table, matching this codebase's existing
-- convention for many-to-many tagging (see survey_tag_mappings) rather than an
-- array/JSONB column directly on `responses` — consistent with the precedent set
-- by 20260701120000_workflow_scope.sql's reasoning for typed FK columns over
-- polymorphic/denormalized shapes where a normalized alternative exists.
CREATE TABLE IF NOT EXISTS response_tags (
  response_id  UUID        NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
  tag          TEXT        NOT NULL CHECK (char_length(tag) BETWEEN 1 AND 100),
  org_id       TEXT        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (response_id, tag)
);

-- Org-scoped lookup ("all responses tagged X for this org") and per-response
-- lookup (response detail view listing its tags) are the two access patterns;
-- the UNIQUE constraint above already covers the per-response-id lookup.
CREATE INDEX IF NOT EXISTS response_tags_org_tag_idx ON response_tags(org_id, tag);
