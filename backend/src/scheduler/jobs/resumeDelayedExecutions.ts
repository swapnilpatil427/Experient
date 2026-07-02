import { query } from '../../lib/db';
import { resumeDelayedExecution } from '../../lib/workflowEngine';

/**
 * Auto-resume flow.delay-type waiting executions (Priya, Wave 11,
 * DEEP_AUDIT_UX_FINDINGS.md W-1). Mirrors reNotifyStaleApprovals.ts's shape
 * (own file, pure `{ affected }` return, registered in scheduler/registry.ts)
 * but is NOT a nudge — unlike that job, this one actively continues execution,
 * because flow.delay is a timer that "approves itself" once due, with no
 * human in the loop at all.
 *
 * Disjointness (hard requirement this wave, see workflowEngine.ts's
 * persistPause/resumeWorkflow doc comments for the full design): the SELECT
 * below matches ONLY wait_reason = 'flow.delay' rows — it must never select
 * (and therefore never resume) a flow.approval-type waiting execution, the
 * exact inverse of reNotifyStaleApprovals' own status='pending' (workflow_
 * approvals) scope, which never touches wait_reason='flow.delay' rows either.
 * Each wait type has its own resume path; a scheduler job in this file must
 * never became a second way to resolve an approval.
 *
 * Per-execution work is delegated entirely to workflowEngine.ts's
 * resumeDelayedExecution, which does the actual atomic claim (UPDATE ...
 * WHERE status='waiting' ... RETURNING *) — the double-resume/double-execute
 * guard lives there, not here, so it's exercised identically whether called
 * from this job or directly from a test. This job's own responsibility is
 * just "find candidates, resume each, don't let one candidate's failure abort
 * the sweep" — the same isolation pattern runWorkflowsForEvent/
 * runScheduledWorkflows already use in workflowEngine.ts.
 */
export interface ResumeDelayedResult { affected: number }

interface DueDelayRow {
  id: string;
}

export async function resumeDelayedExecutions(): Promise<ResumeDelayedResult> {
  const { rows } = await query<DueDelayRow>(
    `SELECT id FROM workflow_executions
      WHERE status = 'waiting' AND wait_reason = 'flow.delay'
        AND resume_at IS NOT NULL AND resume_at <= NOW()`
  );

  let affected = 0;
  for (const row of rows) {
    try {
      const result = await resumeDelayedExecution(row.id);
      // A null result means another tick/replica already claimed this row
      // between the SELECT above and this call — not a failure, just a race
      // this job's own idempotent claim mechanism already resolved correctly.
      if (result) affected++;
    } catch {
      // One execution's failure must not abort the rest of the sweep (mirrors
      // runWorkflowsForEvent/runScheduledWorkflows's per-item isolation).
    }
  }

  return { affected };
}
