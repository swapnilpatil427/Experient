-- Approval TTL — simple expiry + re-notify (Nina, 2026-07-01, DEEP_AUDIT_PM_FINDINGS.md
-- §7a / TRACKER.md Wave 10). User-confirmed product decision: a pending approval
-- NEVER auto-rejects and the execution's 'waiting' status is never touched by this —
-- this is purely a "nudge the approver again" mechanism. `last_notified_at` +
-- `notification_count` let the new scheduler job (jobs/reNotifyStaleApprovals.ts)
-- re-notify on a cadence (default 72h) instead of spamming on every tick.
ALTER TABLE workflow_approvals
  ADD COLUMN IF NOT EXISTS last_notified_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS notification_count INT NOT NULL DEFAULT 0;

-- Sweep predicate: `WHERE status='pending' AND (last_notified_at IS NULL OR
-- last_notified_at < now() - interval)`. Partial index keeps the sweep cheap even
-- with a large approvals table, mirroring idx_wf_approvals_pending's shape.
CREATE INDEX IF NOT EXISTS idx_wf_approvals_renotify
  ON workflow_approvals(status, last_notified_at)
  WHERE status = 'pending';
