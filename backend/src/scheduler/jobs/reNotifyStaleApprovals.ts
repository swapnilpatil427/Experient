import { query } from '../../lib/db';
import { createNotification } from '../../lib/notifications';

/**
 * Approval TTL — simple expiry + re-notify (Nina, 2026-07-01,
 * DEEP_AUDIT_PM_FINDINGS.md §7a — confirmed no scheduled job anywhere touched
 * `workflow_approvals`/`status='waiting'`; the existing stuck-execution reaper
 * (workflowQueue.ts::reapStuckExecutions) only matches `status='executing'`).
 *
 * User-confirmed product decision: this is a NUDGE, not an auto-reject. A
 * `workflow_approvals` row stuck at `status='pending'` past `thresholdHours`
 * (default 72h, `WORKFLOW_APPROVAL_RENOTIFY_HOURS`) gets the exact same
 * notification mechanism reused (createNotification — the same primitive
 * notify.in_app already uses in workflowEngine.ts) re-sent to the workflow's
 * owner (`workflows.created_by` — there is no dedicated `approver_user_id`
 * column on `workflow_approvals` today; the workflow's creator is the closest
 * existing "who owns this" signal, matching the already-tracked but unbuilt
 * `created_by` surfacing ask in DEEP_AUDIT_PM_FINDINGS.md §1f). The execution
 * stays `'waiting'` and the approval stays `'pending'` — nothing here ever
 * approves, rejects, or expires anything; a human must still act.
 *
 * Mirrors expireStaleBroadcasts.ts's shape (own file, pure `{ affected }`
 * return, registered in scheduler/registry.ts) but needs application-level
 * logic (resolve the recipient, call createNotification) rather than a single
 * DB function, since there's no existing `renotify_stale_approvals()` SQL
 * function to call — the notification side effect can't live purely in SQL.
 *
 * Re-notify cadence: once per `thresholdHours` window until a human decides,
 * not once per scheduler tick — `last_notified_at` is stamped on every
 * successful notify and the WHERE clause only selects rows whose last notify
 * (or original request, if never notified) is older than the threshold. This
 * job runs on a much shorter tick (default: hourly) than the notify cadence
 * itself; the SQL predicate is what prevents spam, not the job's own interval.
 */
export interface ReNotifyResult { affected: number }

const DEFAULT_THRESHOLD_HOURS = 72;

function thresholdHours(): number {
  const n = Number(process.env.WORKFLOW_APPROVAL_RENOTIFY_HOURS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_THRESHOLD_HOURS;
}

interface StaleApprovalRow {
  id: string;
  execution_id: string;
  org_id: string;
  workflow_id: string;
  requested_at: string;
  notification_count: number;
  workflow_name: string;
  created_by: string | null;
}

export async function reNotifyStaleApprovals(): Promise<ReNotifyResult> {
  const hours = thresholdHours();
  const { rows } = await query<StaleApprovalRow>(
    `SELECT a.id, a.execution_id, a.org_id, a.workflow_id, a.requested_at,
            a.notification_count, w.name AS workflow_name, w.created_by
       FROM workflow_approvals a
       JOIN workflows w ON w.id = a.workflow_id
      WHERE a.status = 'pending'
        AND (a.last_notified_at IS NULL OR a.last_notified_at < NOW() - ($1 || ' hours')::interval)
        AND a.requested_at < NOW() - ($1 || ' hours')::interval`,
    [String(hours)]
  );

  let affected = 0;
  for (const row of rows) {
    // No approver/owner to notify (e.g. a since-deleted user) — still stamp
    // last_notified_at so this row doesn't get re-queried every tick forever;
    // the approval remains visible/actionable via GET /api/workflows/approvals
    // regardless (that endpoint doesn't depend on notification delivery).
    if (row.created_by) {
      await createNotification({
        orgId: row.org_id,
        userId: row.created_by,
        type: 'workflow.approval_pending',
        priority: 'warning',
        title: `Approval still waiting: "${row.workflow_name}"`,
        body: `An action in "${row.workflow_name}" has been waiting for your approval since ${new Date(row.requested_at).toLocaleString()}. Review it to let this run continue.`,
        entityType: 'workflow_execution',
        entityId: row.execution_id,
      });
    }
    await query(
      `UPDATE workflow_approvals
          SET last_notified_at = NOW(), notification_count = notification_count + 1
        WHERE id = $1`,
      [row.id]
    );
    affected++;
  }

  return { affected };
}
