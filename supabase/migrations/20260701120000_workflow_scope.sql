-- Workflow scope — the structurally important gap flagged by the direct user
-- complaint "how would i select which survey?" (see docs/automation-hub/
-- BUILDER_REDESIGN_V2_SCOPE.md §2 and BUILDER_REDESIGN_V2_CONCEPT.md §3).
--
-- Confirmed before this migration: NO scope concept exists anywhere in the schema.
-- Every workflow today is implicitly org-wide — `runWorkflowsForEvent` in
-- workflowEngine.ts matches purely on (org_id, trigger_type), with zero survey
-- dimension. This migration adds the column-level capability; the matching
-- workflowEngine.ts changes in this same commit are what make it real rather than
-- cosmetic (a scope column with no matching-logic change would let a
-- "survey-scoped" workflow still fire for every survey's events).
--
-- ── Data model choice: TWO typed nullable columns, not one polymorphic scope_id ──
-- Rohan's concept doc (BUILDER_REDESIGN_V2_CONCEPT.md §3) proposed a single
-- `scope_id UUID` whose meaning is conditional on `scope_type` (FK'd to either
-- `surveys.id` or `survey_tags.id` depending on which). Maya's scope doc
-- (BUILDER_REDESIGN_V2_SCOPE.md §2) proposed two separate nullable columns
-- instead. Chose Maya's shape (`scope_survey_id` + `scope_tag_id`) because:
--   1. Every existing FK-to-surveys or FK-to-survey_tags column in this schema
--      (see e.g. 20240101000000_initial.sql, 20240516000000_insights.sql,
--      alert_rules.survey_id, survey_tag_mappings.tag_id/survey_id) is a plain
--      typed `UUID REFERENCES <table>(id)` column — this codebase has no existing
--      precedent for a polymorphic id+type pair anywhere in its schema.
--   2. A single `scope_id` column cannot carry a real FK constraint (Postgres has
--      no conditional/polymorphic FK) — it would need to be a bare UUID with
--      integrity enforced only in application code. Two typed columns keep a real
--      `REFERENCES` constraint on each, so an orphaned scope (deleted survey/tag)
--      is caught by the database, not just assumed correct by the API layer.
--   3. `survey_tags.id` and `surveys.id` are both UUIDs from disjoint id spaces
--      (confirmed: 20260622000001_survey_groups.sql's survey_tags/survey_tag_mappings
--      use UUID `id`/`tag_id`, not a name/slug identity) — there's no natural
--      "single id space" argument for collapsing them, unlike e.g. a
--      polymorphic owner_id pattern where the two referenced tables share a
--      natural union type.
-- CHECK constraint below enforces exactly one of the two is set, matching the
-- `scope_type` value — so the two-column shape doesn't reopen the "which one is
-- authoritative" ambiguity a polymorphic column would have avoided.
ALTER TABLE workflows
  ADD COLUMN IF NOT EXISTS scope_type       TEXT NOT NULL DEFAULT 'org',
  ADD COLUMN IF NOT EXISTS scope_survey_id  UUID REFERENCES surveys(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS scope_tag_id     UUID REFERENCES survey_tags(id) ON DELETE CASCADE;

-- Default 'org' for every existing row is implicit via the column default above
-- (backward compatible — org-wide is the current de facto behavior for every
-- workflow that exists today; this migration changes no existing workflow's
-- runtime behavior by itself).

ALTER TABLE workflows
  ADD CONSTRAINT workflows_scope_type_check
  CHECK (scope_type IN ('org', 'survey', 'tag'));

-- Enforce the two-column shape stays internally consistent: org-scoped has
-- neither id set, survey-scoped has exactly scope_survey_id, tag-scoped has
-- exactly scope_tag_id. Mirrors the same validation the API layer performs
-- (schemas/workflows.ts) — belt-and-suspenders, not a substitute for it (the API
-- gives a much better error message; this is the last line of defense against a
-- direct DB write bypassing the API).
ALTER TABLE workflows
  ADD CONSTRAINT workflows_scope_consistency_check
  CHECK (
    (scope_type = 'org'    AND scope_survey_id IS NULL     AND scope_tag_id IS NULL) OR
    (scope_type = 'survey' AND scope_survey_id IS NOT NULL AND scope_tag_id IS NULL) OR
    (scope_type = 'tag'    AND scope_survey_id IS NULL     AND scope_tag_id IS NOT NULL)
  );

-- Engine query index — runWorkflowsForEvent's WHERE clause becomes
-- (org_id, trigger_type, status, deleted_at) with an added application-level
-- scope filter (see workflowEngine.ts). Extends the existing idx_workflows_trigger
-- shape (org_id, trigger_type) partial index rather than replacing it, adding
-- scope_type/scope_survey_id/scope_tag_id so the engine's candidate-fetch query
-- can filter scope in the same index scan instead of a second lookup per row.
DROP INDEX IF EXISTS idx_workflows_trigger;
CREATE INDEX IF NOT EXISTS idx_workflows_trigger_scope
  ON workflows(org_id, trigger_type, scope_type, scope_survey_id, scope_tag_id)
  WHERE status = 'active' AND deleted_at IS NULL;

-- Lookup index for "which workflows are scoped to survey X" (list-page filter,
-- per BUILDER_REDESIGN_V2_CONCEPT.md §2's "By survey" filter chip) and for
-- cascading concerns (e.g. confirming no workflow still references a survey
-- before a hard-delete elsewhere, though surveys are soft-deleted today).
CREATE INDEX IF NOT EXISTS idx_workflows_scope_survey
  ON workflows(scope_survey_id) WHERE scope_survey_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workflows_scope_tag
  ON workflows(scope_tag_id) WHERE scope_tag_id IS NOT NULL;
