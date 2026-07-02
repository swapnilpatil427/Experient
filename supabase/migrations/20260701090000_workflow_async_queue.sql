-- Async workflow queue support (Redis Streams — see lib/workflowQueue.ts and
-- docs/automation-hub/ADR_EXECUTION_ARCHITECTURE.md). Adds idempotency (dedup
-- of at-least-once XAUTOCLAIM redeliveries) and retry/dead-letter bookkeeping
-- to the existing workflow_executions table. No new tables — a dead letter is
-- just a workflow_executions row with dead_letter = TRUE, queryable directly.

ALTER TABLE workflow_executions
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS attempt_count   INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_retry_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dead_letter     BOOLEAN NOT NULL DEFAULT FALSE;

-- Dedup: a duplicate publish/redelivery of the same (org, workflow, trigger,
-- dedup-field) tuple is a no-op via INSERT ... ON CONFLICT DO NOTHING.
-- Nullable + UNIQUE: rows created without an idempotency_key (manual test/retry
-- runs, resumed approvals) are exempt from the constraint (multiple NULLs are
-- allowed under a standard unique index/constraint in Postgres).
CREATE UNIQUE INDEX IF NOT EXISTS uq_wf_exec_idempotency_key
  ON workflow_executions(idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Due-retry sweep: `WHERE status='failed' AND dead_letter=FALSE AND next_retry_at <= now()`.
CREATE INDEX IF NOT EXISTS idx_wf_exec_due_retry
  ON workflow_executions(next_retry_at)
  WHERE status = 'failed' AND dead_letter = FALSE AND next_retry_at IS NOT NULL;

-- Dead-letter queue browsing (ops/QA): `WHERE dead_letter = TRUE`.
CREATE INDEX IF NOT EXISTS idx_wf_exec_dead_letter
  ON workflow_executions(org_id, triggered_at DESC)
  WHERE dead_letter = TRUE;
