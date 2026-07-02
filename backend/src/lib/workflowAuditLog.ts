// Workflow config-change audit trail (Nina, 2026-07-02, DEEP_AUDIT_PM_FINDINGS.md
// §10b, TRACKER.md Wave 11 Part 1). Distinct from lib/auditLog.ts (which writes
// user_audit_log — a general people/access-management compliance log with a
// different shape: actor_type, target_user_id, ip_address, etc.). This module is
// purpose-built for the narrower "who changed this workflow, and what changed"
// question §10b asks: workflow_id, an action enum, and a human-readable
// before/after summary of just the fields that actually changed — not a generic
// deep-diff/event-sourcing log.
//
// Transactional-coupling decision (documented per Wave 11 Part 1 instructions):
// this file's writeWorkflowAuditLog() is called from routes/workflows.ts AFTER
// the workflow mutation's own query has already been issued, using the same
// lib/db.ts `query()` pool (no explicit BEGIN/COMMIT wrapping either call).
// True same-transaction coupling would require introducing a pool.connect()/
// client-based transaction helper that does not exist anywhere in this codebase
// today (lib/db.ts exports only a single auto-committing `query()`) — adding one
// just for this feature would be a much bigger, riskier change to a live,
// heavily-tested route than this wave's "additive, not a rewrite" mandate calls
// for. Instead this mirrors workflowEngine.ts's logStep() precedent exactly (see
// its comment): the audit INSERT is wrapped in try/catch and NEVER allowed to
// throw into the caller. A Postgres blip here can only produce an incomplete
// audit trail for that one mutation — it can never retroactively fail, revert,
// or double-apply the workflow mutation it's describing. This is the documented
// tradeoff: slightly weaker durability of the audit record in the rare case of a
// concurrent DB failure, in exchange for zero risk of the audit subsystem ever
// taking down or corrupting the live CRUD surface it observes.
import { query } from './db';
import logger from './logger';

export type WorkflowAuditAction = 'created' | 'updated' | 'status_changed' | 'deleted';

interface WorkflowAuditLogParams {
  workflowId: string;
  orgId: string;
  actorUserId?: string | null;
  action: WorkflowAuditAction;
  summary?: Record<string, unknown>;
}

/**
 * Append one row to workflow_audit_log. Never throws — a write failure here
 * must never undo or block the workflow mutation it's recording (see file
 * header for the full rationale, mirroring workflowEngine.ts's logStep()).
 */
export async function writeWorkflowAuditLog({
  workflowId,
  orgId,
  actorUserId = null,
  action,
  summary = {},
}: WorkflowAuditLogParams): Promise<void> {
  try {
    await query(
      `INSERT INTO workflow_audit_log (workflow_id, org_id, actor_user_id, action, summary)
       VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [workflowId, orgId, actorUserId, action, JSON.stringify(summary)]
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      { event: 'workflow_audit_log_write_failed', workflowId, orgId, action, err: msg },
      'workflow audit log write failed'
    );
  }
}

// Bookkeeping columns that change on literally every PUT (by this same route's
// own design — see routes/workflows.ts) and so would show up as "changed" on
// every single diff regardless of what the caller actually edited. Excluding
// them keeps the summary meaningful for the "what did the human actually
// change" question this table exists to answer, rather than drowning every
// entry in `updated_at`/`version` noise.
const AUDIT_DIFF_IGNORE_KEYS = new Set(['updated_at', 'updated_by', 'version']);

/**
 * Build a human-readable before/after summary of only the fields that changed.
 * Deliberately shallow (top-level field diff, not a generic deep-diff library —
 * this table is for human accountability, not event-sourcing). Values are
 * included as-is; callers pass already-serializable (JSON-safe) field values.
 * Always-changing bookkeeping columns (updated_at/updated_by/version) are
 * excluded — see AUDIT_DIFF_IGNORE_KEYS.
 */
export function diffChangedFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>
): Record<string, { before: unknown; after: unknown }> {
  const changed: Record<string, { before: unknown; after: unknown }> = {};
  for (const key of Object.keys(after)) {
    if (AUDIT_DIFF_IGNORE_KEYS.has(key)) continue;
    const beforeVal = before[key];
    const afterVal = after[key];
    const beforeJson = JSON.stringify(beforeVal);
    const afterJson = JSON.stringify(afterVal);
    if (beforeJson !== afterJson) {
      changed[key] = { before: beforeVal, after: afterVal };
    }
  }
  return changed;
}
