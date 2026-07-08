-- Wave 11 — audit trail + concurrent-edit protection (Nina, 2026-07-02,
-- DEEP_AUDIT_PM_FINDINGS.md §10a/§10b, TRACKER.md Wave 11). Additive-only:
-- no existing column, constraint, or row is touched or renamed.
--
-- §10b — "no updated_by, no history table, an admin can't answer 'who changed
-- this workflow's recipient last week'":
--   * workflows.updated_by mirrors created_by's existing type/semantics exactly
--     (nullable TEXT — Clerk user id string, no FK, same as created_by). Set on
--     every successful PUT; created_by's own semantics are completely untouched.
--   * workflow_audit_log is a new, append-only table capturing create/update/
--     status-toggle/delete with a before/after JSONB summary of just the fields
--     that changed (human-readable accountability, not a generic deep-diff/
--     event-sourcing log — see routes/workflows.ts for what gets written).
--
-- §10a — "concurrent edits are last-write-wins, silently, no version/etag
-- exists": workflows.version is a plain integer optimistic-lock counter,
-- default 1, incremented on every successful PUT. Backward compatible by
-- construction: the column defaults to 1 for every existing row, and
-- PUT /api/workflows/:id treats an absent `version` field in the request body
-- as "skip the conflict check" (see routes/workflows.ts) — every caller that
-- predates this migration keeps working unmodified.
ALTER TABLE workflows
  ADD COLUMN IF NOT EXISTS updated_by TEXT,
  ADD COLUMN IF NOT EXISTS version    INTEGER NOT NULL DEFAULT 1;

-- Deliberately NO foreign key on workflow_id (unlike workflow_executions'
-- REFERENCES workflows(id) ON DELETE CASCADE). This table must survive its
-- parent workflow's deletion — a 'deleted' audit row is the ONLY record that a
-- workflow ever existed and who removed it; an ON DELETE CASCADE FK would let
-- the DELETE handler's own audit entry (and every prior history row) evaporate
-- the instant the row it describes is removed, defeating the whole point of an
-- append-only trail for exactly the one action ("who deleted this") that most
-- needs to survive. workflow_id is still indexed and always populated; org_id
-- is carried redundantly (not just derivable via a join) so history remains
-- queryable/scoped after the workflow row is gone.
CREATE TABLE IF NOT EXISTS workflow_audit_log (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id    UUID        NOT NULL,
  org_id         TEXT        NOT NULL,
  actor_user_id  TEXT,
  action         VARCHAR(32) NOT NULL
                 CHECK (action IN ('created', 'updated', 'status_changed', 'deleted')),
  summary        JSONB       NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Read pattern is always "this workflow's history, newest first" (the new
-- GET /:id/audit-log endpoint) and, secondarily, "this org's history" for a
-- future cross-workflow compliance view — mirrors idx_wf_exec_workflow /
-- idx_wf_exec_org's two-index shape in 20260603000018_workflows_v2.sql.
CREATE INDEX IF NOT EXISTS idx_wf_audit_workflow ON workflow_audit_log(workflow_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wf_audit_org      ON workflow_audit_log(org_id, created_at DESC);
