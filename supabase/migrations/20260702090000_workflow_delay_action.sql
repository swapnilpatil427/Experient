-- flow.delay action (Priya, 2026-07-02, Wave 11, DEEP_AUDIT_UX_FINDINGS.md W-1):
-- a second, timer-based pause primitive alongside the existing human-gated
-- flow.approval. A workflow_executions row already carries status='waiting' for
-- an approval pause (workflow_graph_resume.sql / workflows_v2.sql); this adds
-- what's new for a delay-type pause:
--   - wait_reason: disambiguates WHICH kind of wait a 'waiting' row represents,
--     so the approval-only surfaces (workflow_approvals table, the approve/reject
--     endpoint, reNotifyStaleApprovals) and the new delay-resume scheduler job
--     can each query ONLY their own wait type and never accidentally touch the
--     other's rows. NULL for every pre-existing waiting row (all of which are
--     approval pauses, backfilled explicitly below) and for every non-waiting row.
--   - resume_at: when a delay-type wait should be auto-resumed. Real, indexed
--     column rather than a JSONB expression (output->>'resumeAt') — the resume
--     scheduler job runs frequently (every tick, mirroring reNotifyStaleApprovals'
--     hourly cadence but designed to run much tighter, e.g. every minute, since a
--     delay is a promise to resume near-exactly on time, not "eventually within a
--     day") and must cheaply answer "which executions are due", the same shape of
--     query idx_wf_exec_due_retry already exists to serve for retry sweeps. A
--     partial B-tree index on (resume_at) WHERE status='waiting' AND
--     wait_reason='flow.delay' keeps that scan tiny and sargable even as
--     workflow_executions grows into the millions of rows — a JSONB expression
--     index would work too but a plain timestamptz column is simpler to reason
--     about, cheaper to index, and consistent with this table's own established
--     pattern (attempt_count/next_retry_at/dead_letter are all real columns, not
--     JSONB, for the exact same "the scheduler needs to scan this efficiently"
--     reason — see workflow_async_queue.sql).

ALTER TABLE workflow_executions
  ADD COLUMN IF NOT EXISTS wait_reason TEXT,
  ADD COLUMN IF NOT EXISTS resume_at   TIMESTAMPTZ;

-- Backfill: every existing 'waiting' row predates flow.delay and is therefore an
-- approval pause. Making this explicit (rather than leaving wait_reason NULL for
-- old rows) means reNotifyStaleApprovals and the approvals endpoint can filter on
-- wait_reason = 'flow.approval' directly instead of needing a
-- "wait_reason IS NULL OR wait_reason = 'flow.approval'" fallback everywhere.
UPDATE workflow_executions SET wait_reason = 'flow.approval' WHERE status = 'waiting' AND wait_reason IS NULL;

-- Delay-resume sweep: `WHERE status='waiting' AND wait_reason='flow.delay' AND resume_at <= now()`.
CREATE INDEX IF NOT EXISTS idx_wf_exec_due_delay
  ON workflow_executions(resume_at)
  WHERE status = 'waiting' AND wait_reason = 'flow.delay';
