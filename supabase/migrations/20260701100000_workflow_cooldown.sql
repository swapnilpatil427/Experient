-- Workflow cooldown enforcement (C-004 — see docs/automation-hub/CUSTOMER_REVIEW.md,
-- docs/automation-hub/BUILDER_REBUILD_SPEC.md §5, docs/automation-hub/BUILDER_REBUILD_SCOPE.md §2.3).
--
-- Genuinely net-new: no cooldown/rate-limiting concept existed anywhere in this schema
-- before this migration (confirmed against 20260603000018_workflows_v2.sql and
-- 20260701090000_workflow_async_queue.sql — neither has cooldown_minutes, cooldown_until,
-- or a 'cooldown' status value). See workflowEngine.ts's cooldown gate in runWorkflow().
--
-- ── Column semantics (read before touching this) ────────────────────────────────
-- `cooldown_minutes` — nullable/0 = "no cooldown, fire every time" (existing behavior
--   for every workflow that doesn't opt in; this MUST NOT change behavior for any
--   workflow that leaves it unset).
-- `cooldown_last_fired_at` — deliberately a NEW column, not a reuse of the pre-existing
--   `last_run_at`. `last_run_at` (set in workflowEngine.ts::finalizeExecution) updates on
--   EVERY terminal outcome — including a run that was skipped because a *condition*
--   evaluated false and never reached an action. Keying cooldown off `last_run_at` would
--   arm the cooldown clock on a run that never actually fired, incorrectly suppressing a
--   later run that would have been the workflow's first real fire in the window. This
--   column instead is stamped only when a run's conditions passed and it actually reached
--   action execution (`conditionsPassed === true` in the engine's RunResult) — regardless
--   of whether the action(s) then succeeded, failed, or paused for approval. That is what
--   "this workflow fired" means for throttling purposes.
ALTER TABLE workflows
  ADD COLUMN IF NOT EXISTS cooldown_minutes       INTEGER,
  ADD COLUMN IF NOT EXISTS cooldown_last_fired_at  TIMESTAMPTZ;

-- Extend workflow_executions.status to add 'cooldown' — a distinct, first-class outcome
-- so the run history can show "N fires suppressed by cooldown" instead of those events
-- vanishing with no trace (spec's explicit requirement) and so a future UI can tell
-- "skipped because a condition was false" (status='skipped') apart from "skipped because
-- of cooldown" (status='cooldown').
ALTER TABLE workflow_executions DROP CONSTRAINT IF EXISTS workflow_executions_status_check;
ALTER TABLE workflow_executions
  ADD CONSTRAINT workflow_executions_status_check
  CHECK (status IN ('triggered','evaluating','executing','waiting','completed','failed','skipped','timed_out','cooldown'));

-- Cooldown-status lookups on the workflow card / run history ("N fires suppressed this week").
CREATE INDEX IF NOT EXISTS idx_wf_exec_cooldown
  ON workflow_executions(workflow_id, triggered_at DESC)
  WHERE status = 'cooldown';
