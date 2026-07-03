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

// Bounded batch size per tick (Kenji, Wave 11 Phase 3 fault-tolerance gate).
//
// Neither this job nor its precedent (reNotifyStaleApprovals.ts) previously
// capped how many rows a single tick could pull — confirmed by direct
// comparison, this is genuinely unprecedented in this codebase's scheduler
// (expireStaleBroadcasts.ts delegates to a single bulk SQL UPDATE, which is a
// different risk profile: one round trip vs. this job's one full
// resumeDelayedExecution() call per row, each of which can execute real
// downstream actions — Slack/webhook/email network calls, DB writes — not just
// flip a status column).
//
// Why this matters here specifically: if the scheduler is down (deploy,
// crash, leader-election gap) for longer than several tick intervals while
// delays keep expiring, the backlog is unbounded by the time it comes back.
// Without a cap, one tick would try to resume the ENTIRE backlog synchronously
// in a single `for` loop — a large backlog could make one job invocation run
// for a very long wall-clock time with zero forward-progress visibility until
// it finishes, and a single hung downstream action (e.g. a slow
// notify.webhook fetch) stalls every row still queued behind it in that same
// loop. This does not overlap with or block OTHER jobs (runner.ts's tick loop
// fires jobs via `void runJob(job)`, not awaited), but it does mean this one
// job's own progress is throttled to whatever fits per tick.
//
// Fix: cap each tick's SELECT with LIMIT, oldest-due-first (ORDER BY
// resume_at ASC) so the longest-overdue executions are always resumed before
// newer ones. A backlog larger than the cap is NOT dropped — leftover rows
// simply remain `status='waiting'` and get picked up on the NEXT tick (60s
// later by default), each tick chipping away at the backlog in bounded time
// until it's fully drained. Overridable via env for ops tuning without a
// redeploy, matching this file's existing `intSec`-style convention in
// registry.ts.
const DEFAULT_BATCH_SIZE = 200;
function batchSize(): number {
  const n = Number(process.env.WORKFLOW_RESUME_DELAYED_BATCH_SIZE);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : DEFAULT_BATCH_SIZE;
}

export async function resumeDelayedExecutions(): Promise<ResumeDelayedResult> {
  const { rows } = await query<DueDelayRow>(
    `SELECT id FROM workflow_executions
      WHERE status = 'waiting' AND wait_reason = 'flow.delay'
        AND resume_at IS NOT NULL AND resume_at <= NOW()
      ORDER BY resume_at ASC
      LIMIT $1`,
    [batchSize()]
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
