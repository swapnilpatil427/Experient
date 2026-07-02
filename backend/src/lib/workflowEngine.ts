// Workflow execution engine.
//
// A workflow is a graph of nodes (trigger → conditions → actions). On a matching
// trigger event we evaluate conditions, then run actions sequentially, logging an
// execution + per-step rows. Actions reuse the notification/Slack/webhook senders
// and the alert/notification bus already built. Crystal/integration actions are
// stubs (recorded as skipped) until their SDKs are wired (deploy-dependent).
//
// Engine runs in the backend or the standalone Event Engine (both share this lib).
import { query } from './db';
import { createNotification, serialize } from './notifications';
import { sendSlack, sendEmail } from './channels';
import { jiraCreateIssue, salesforceUpdateContact, servicenowCreateIncident, zendeskCreateTicket, crystalSummarize, crystalClassify, signWebhookPayload, CONNECTOR_FETCH_TIMEOUT_MS } from './connectors';
import { getCredentials } from './workflowCredentials';
import { cronMatches } from './cron';
import { resolveRecipients, type RecipientTarget } from './recipientResolver';
import { checkTriggerTierGate } from './planGating';

function log(level: 'info' | 'warn' | 'error', obj: Record<string, unknown>, msg: string): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    (require('./logger') as Record<string, (obj: Record<string, unknown>, msg: string) => void>)[level](obj, msg);
  } catch {
    console.log(`[workflow-engine] ${msg}`, obj);
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WorkflowNode {
  id?: string;
  type: 'trigger' | 'condition' | 'action';
  action?: string;
  config?: Record<string, unknown>;
  conditions?: ConditionSet;
  [key: string]: unknown;
}

export interface WorkflowEdge {
  from: string;
  to: string;
  branch?: 'true' | 'false' | null;
}

export interface WorkflowRecord {
  id: string;
  org_id: string;
  trigger_type?: string;
  nodes?: WorkflowNode[];
  edges?: WorkflowEdge[];
  status?: string;
  scope_type?: 'org' | 'survey' | 'tag';
  scope_survey_id?: string | null;
  scope_tag_id?: string | null;
  [key: string]: unknown;
}

export interface TriggerEvent {
  type?: string;
  userId?: string | null;
  targetUserIds?: string[];
  title?: string | null;
  body?: string | null;
  actionUrl?: string | null;
  responseId?: string | null;
  contactId?: string | null;
  // Resolvable survey identifier for survey-relevant trigger types, so scope
  // filtering (see resolveEventSurveyId below) can match without a DB round trip
  // when the publisher already knows it. Optional: not every trigger type has a
  // survey dimension (time.schedule, external.webhook), and some publishers only
  // know it indirectly (see resolveEventSurveyId's payload.survey_id/payload.surveyId
  // fallbacks for the crystal.*/alert.fired producers that predate this field).
  surveyId?: string | null;
  severity?: string;
  payload?: Record<string, unknown>;
  scheduledAt?: string;
  [key: string]: unknown;
}

interface ExecutionContext {
  orgId: string;
  workflowId: string;
  event: TriggerEvent;
  vars: Record<string, unknown>;
  recipientUserIds?: string[];
}

interface ConditionRule {
  field: string;
  op: string;
  value: unknown;
}

interface ConditionSet {
  operator?: 'AND' | 'OR';
  rules?: ConditionRule[];
}

interface ActionResult {
  status: 'completed' | 'failed' | 'skipped' | 'waiting';
  output?: Record<string, unknown>;
  error?: string;
  stop?: boolean;
  pause?: boolean;
  vars?: Record<string, unknown>;
  // Set only by pause-causing actions that are NOT the human-gated flow.approval
  // (today: only flow.delay). runNodes/runGraph pass this through unchanged —
  // they stay action-type-agnostic — so runWorkflow/resumeWorkflow's tail can
  // branch on "was this pause caused by a delay?" without inspecting the node
  // itself. Undefined/omitted means "flow.approval-shaped pause" (the default,
  // pre-existing behavior, preserved exactly).
  waitReason?: 'flow.delay';
  resumeAt?: Date;
}

interface RunResult {
  status: 'completed' | 'failed' | 'skipped' | 'waiting';
  conditionsPassed: boolean;
  pauseIndex?: number;
  resumeNodeId?: string | null;
  waitReason?: 'flow.delay';
  resumeAt?: Date;
}

// ── Condition evaluation ──────────────────────────────────────────────────────

export function compare(op: string, actual: unknown, value: unknown): boolean {
  switch (op) {
    case 'eq':  return actual == value;             // eslint-disable-line eqeqeq
    case 'neq': return actual != value;             // eslint-disable-line eqeqeq
    case 'gt':  return Number(actual) > Number(value);
    case 'lt':  return Number(actual) < Number(value);
    case 'gte': return Number(actual) >= Number(value);
    case 'lte': return Number(actual) <= Number(value);
    case 'between': return Array.isArray(value) && Number(actual) >= Number(value[0]) && Number(actual) <= Number(value[1]);
    case 'contains':     return String(actual ?? '').toLowerCase().includes(String(value).toLowerCase());
    case 'not_contains': return !String(actual ?? '').toLowerCase().includes(String(value).toLowerCase());
    case 'in':     return Array.isArray(value) && value.includes(actual);
    case 'not_in': return Array.isArray(value) && !value.includes(actual);
    default: return false;
  }
}

/**
 * Evaluate a condition set against a flat context object.
 * @param conditions  { operator?: 'AND'|'OR', rules: Array<{field, op, value}> }
 * @param context     e.g. { nps: 4, sentiment: 'negative', text: '...' }
 */
export function evaluateConditions(conditions: ConditionSet | null | undefined, context: Record<string, unknown> = {}): boolean {
  if (!conditions || !Array.isArray(conditions.rules) || conditions.rules.length === 0) return true;
  const op = (conditions.operator || 'AND').toUpperCase();
  const results = conditions.rules.map((r) => compare(r.op, context[r.field], r.value));
  return op === 'OR' ? results.some(Boolean) : results.every(Boolean);
}

// ── Action execution ──────────────────────────────────────────────────────────

export const LIVE_ACTIONS = new Set(['notify.in_app', 'notify.slack', 'notify.email', 'notify.webhook', 'data.tag_responses', 'flow.stop']);

// Content-customization section keys the frontend's ContentCustomizationPanel
// persists as `config.sections.<key>` (app/src/components/workflow-builder/
// sentence/contentSections.ts's SECTION_KEYS). Kept as a local mirror (not an
// import — backend/app are separate deploys) since only `crystalSummary` maps to
// a var the engine actually renders today (ctx.vars.crystalSummary, set by the
// crystal.summarize action); the rest are frontend-preview-only concepts with no
// backend var equivalent yet. Listed in full so a future var (e.g. `keyMetrics`)
// only needs adding to this map, not new gating logic.
const SECTION_KEY_TO_VAR: Record<string, string> = {
  crystalSummary: 'crystalSummary',
};

/**
 * Execute a notify.email/notify.slack action's title/subject/body templates
 * through `render()`, but first strip out any section-gated var whose
 * `config.sections.<key>` is explicitly `false` (Nina, 2026-07-01,
 * XM_VERIFICATION_REPORT.md Priority 6). Without this, a compliance-conscious
 * workflow that unchecks "Crystal AI Summary" in ContentCustomizationPanel still
 * leaks `ctx.vars.crystalSummary` into the real outbound payload whenever the
 * template literally contains `{{crystalSummary}}` — the persisted config says
 * "off" but render() has no awareness of `config.sections` at all. We blank the
 * var for this render call only (a shallow-copied ctx — never mutate the shared
 * ctx.vars, which other actions in the same run may still need un-redacted).
 */
function renderGated(tpl: string, ctx: ExecutionContext, config: Record<string, unknown>): string {
  const sections = config.sections as Record<string, boolean> | undefined;
  if (!sections) return render(tpl, ctx);
  const gatedVars: Record<string, unknown> = {};
  let anyGated = false;
  for (const [sectionKey, varName] of Object.entries(SECTION_KEY_TO_VAR)) {
    if (sections[sectionKey] === false && varName in ctx.vars) {
      gatedVars[varName] = '';
      anyGated = true;
    }
  }
  if (!anyGated) return render(tpl, ctx);
  return render(tpl, { ...ctx, vars: { ...ctx.vars, ...gatedVars } });
}

/**
 * Resolve a notify.* action's config to a recipient user-id list via the
 * shared recipientResolver (role/department/group/explicit-users), or `null`
 * when the config carries none of the new targeting fields AND no legacy
 * `userId`/`userIds` — i.e. "not configured at all" (distinct from "resolved
 * to zero people", which callers surface as a specific `*_has_no_members`
 * reason instead of the generic `no_recipient_configured`).
 *
 * Precedence (documented in recipientResolver.ts's resolveRecipients):
 * explicit `config.targetType` wins if present; otherwise legacy detection —
 * `config.userIds`/`config.userId` first, then roleId, then departmentId,
 * then groupId. This keeps every already-saved workflow (which only ever set
 * `userId` or `userIds`) resolving identically to before this change.
 */
async function resolveNotifyTarget(
  orgId: string,
  config: Record<string, unknown>,
  legacySingularKey?: 'userId'
): Promise<{ userIds: string[]; emptyReason?: string } | null> {
  const legacyUserIds = (config.userIds as string[] | undefined)
    || (legacySingularKey && config[legacySingularKey] ? [config[legacySingularKey] as string] : undefined);

  const target: RecipientTarget = {
    targetType: config.targetType as RecipientTarget['targetType'] | undefined,
    userIds: legacyUserIds,
    roleId: config.roleId as string | undefined,
    departmentId: config.departmentId as string | undefined,
    groupId: config.groupId as string | undefined,
  };

  const hasAnyTargeting = !!(target.targetType || target.userIds?.length || target.roleId || target.departmentId || target.groupId);
  if (!hasAnyTargeting) return null;

  const resolved = await resolveRecipients(orgId, target);
  return { userIds: resolved.userIds, emptyReason: resolved.emptyReason };
}

/**
 * Execute one action node. Returns { status, output, error?, stop? }.
 * `ctx` carries orgId, the trigger event, and accumulated variables.
 */
export async function executeAction(node: WorkflowNode, ctx: ExecutionContext): Promise<ActionResult> {
  const action = node.action ?? '';
  const config = (node.config || {}) as Record<string, unknown>;
  try {
    switch (action) {
      case 'notify.in_app': {
        // Targeting precedence: config.targetType/roleId/departmentId/groupId
        // (new, resolved via recipientResolver) > config.userIds (legacy,
        // unchanged) > ctx.recipientUserIds > ctx.event.targetUserIds > a
        // last-resort single-user fallback to ctx.event.userId — that last
        // fallback is pre-existing behavior for notify.in_app specifically
        // (unlike notify.email, in_app never carried the Priority 1
        // misdirection risk: an in-app notification is only ever visible to
        // the account it's addressed to, there's no "wrong external party
        // receives a sensitive email" vector) and is preserved as-is.
        const target = await resolveNotifyTarget(ctx.orgId, config);
        let userList: string[];
        let emptyReason: string | undefined;
        if (target) {
          userList = target.userIds;
          emptyReason = target.emptyReason;
        } else {
          const recipients = ctx.recipientUserIds || (ctx.event.targetUserIds || []);
          userList = recipients.length ? recipients : ([ctx.event.userId].filter(Boolean) as string[]);
        }
        if (target && userList.length === 0) {
          return { status: 'skipped', output: { reason: emptyReason || 'no_recipient_configured' } };
        }
        let made = 0;
        for (const userId of userList) {
          const row = await createNotification({
            orgId: ctx.orgId, userId, type: ctx.event.type || 'workflow.action',
            priority: config.priority as string | undefined || 'info',
            title: render(config.title as string | undefined || 'Workflow notification', ctx),
            body: render(config.body as string | undefined || ctx.event.title || '', ctx),
            actionUrl: config.actionUrl as string | undefined || ctx.event.actionUrl as string | undefined || null,
            entityType: 'workflow', entityId: ctx.workflowId,
          });
          if (row) made++;
        }
        return { status: 'completed', output: { notifications: made } };
      }
      case 'notify.slack': {
        // SAFETY CHECK (Nina, 2026-07-01, XM_VERIFICATION_REPORT.md Priority 1):
        // ctx.event.userId does flow into sendSlack's 2nd param, but inspection of
        // sendSlack (lib/channels.ts) confirms it is inert for delivery — the
        // webhook URL is resolved purely by org_id from notification_channels, and
        // userId is never read again (not in the lookup, not in the posted payload).
        // Slack's actual delivery target is always the org-wide webhook, so there is
        // no per-user misdirection vector here to fix (unlike notify.email below).
        const r = await sendSlack(ctx.orgId, ctx.event.userId || null, {
          id: ctx.workflowId,
          type: ctx.event.type || 'workflow.action',
          title: renderGated(config.title as string | undefined || ctx.event.title || 'Workflow alert', ctx, config),
          body: renderGated(config.body as string | undefined || '', ctx, config),
          priority: config.priority as string | undefined || 'info',
          actionUrl: ctx.event.actionUrl as string | undefined || null,
        });
        return { status: r.delivered ? 'completed' : 'skipped', output: r as unknown as Record<string, unknown> };
      }
      case 'notify.email': {
        // SECURITY (Nina, 2026-07-01, XM_VERIFICATION_REPORT.md Priority 1): do NOT
        // fall back to ctx.event.userId when no recipient is configured. That
        // fallback silently addresses the email to whoever happens to be on the
        // triggering event (e.g. the subject of a manager-effectiveness alert),
        // indistinguishable in the execution log from a correctly configured
        // recipient — a real misdirection risk for sensitive alerts. A workflow
        // author must explicitly configure a recipient (now: an explicit user list,
        // OR a role/department/group — resolved via recipientResolver, never derived
        // from the triggering event); if they haven't, skip cleanly (consistent with
        // connectors.ts's `not_configured` pattern) rather than guessing. This
        // extension to role/department/group targeting does NOT reopen that risk —
        // resolution is always driven by explicit workflow config, never by
        // ctx.event fields.
        const target = await resolveNotifyTarget(ctx.orgId, config, 'userId');
        if (!target) {
          return { status: 'skipped', output: { reason: 'no_recipient_configured' } };
        }
        if (target.userIds.length === 0) {
          // A role/department/group resolved to zero people TODAY (e.g. an empty
          // HRBP role) is a distinct, diagnosable condition from "no target
          // configured" — surfaced via emptyReason rather than silently no-oping
          // indistinguishably from a successful send.
          return { status: 'skipped', output: { reason: target.emptyReason || 'no_recipient_configured' } };
        }
        // Loop once per resolved recipient (matches notify.in_app's existing
        // per-user loop convention rather than pluralizing sendEmail itself).
        const results = [];
        for (const recipientUserId of target.userIds) {
          const r = await sendEmail(ctx.orgId, recipientUserId, {
            id: ctx.workflowId,
            type: ctx.event.type || 'workflow.action',
            title: renderGated(config.subject as string | undefined || ctx.event.title || 'Workflow', ctx, config),
            body: renderGated(config.body as string | undefined || '', ctx, config),
            actionUrl: ctx.event.actionUrl as string | undefined || null,
          });
          results.push(r);
        }
        const deliveredCount = results.filter((r) => r.delivered).length;
        return {
          status: deliveredCount > 0 ? 'completed' : 'skipped',
          output: { recipients: target.userIds.length, delivered: deliveredCount, results },
        };
      }
      case 'notify.webhook': {
        if (!config.url) return { status: 'skipped', output: { reason: 'no_url' } };
        const body = JSON.stringify(config.payload || { event: ctx.event });
        const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(config.headers as Record<string, string> || {}) };
        // HMAC-SHA256 signed payload (Stripe/GitHub/Segment convention). Secret precedence:
        // per-workflow config.secret, then the org's vaulted 'webhook' credential, so a
        // workflow author can override the default org-wide signing secret per-endpoint.
        const orgWebhookCreds = await getCredentials(ctx.orgId, 'webhook').catch(() => null) as { secret?: string } | null;
        const secret = (config.secret as string | undefined) || orgWebhookCreds?.secret;
        if (secret) {
          headers['X-Experient-Signature'] = `sha256=${signWebhookPayload(body, secret)}`;
        }
        const res = await fetch(config.url as string, {
          method: config.method as string || 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(CONNECTOR_FETCH_TIMEOUT_MS),
        });
        return { status: res.ok ? 'completed' : 'failed', output: { status: res.status, signed: !!secret } };
      }
      case 'data.tag_responses': {
        // XM_VERIFICATION_REPORT.md Priority 3 (Kenji): this case used to return a
        // fake 'completed' shape with zero DB write despite being marked live:true.
        // Real persistence: response_tags junction table (migration
        // 20260701130000_response_tags.sql), org-scoped, idempotent on
        // (response_id, tag) via ON CONFLICT DO NOTHING so re-tagging the same
        // response with the same tag (e.g. a re-fired workflow) is a no-op, not an
        // error.
        const responseId = ctx.event.responseId as string | undefined;
        const tag = config.tag as string | undefined;
        if (!responseId || !tag) return { status: 'skipped', output: { reason: 'missing_target' } };
        await query(
          `INSERT INTO response_tags (response_id, tag, org_id) VALUES ($1, $2, $3)
           ON CONFLICT (response_id, tag) DO NOTHING`,
          [responseId, tag, ctx.orgId]
        );
        return { status: 'completed', output: { tagged: responseId, tag } };
      }
      case 'flow.stop':
        return { status: 'completed', output: {}, stop: true };
      case 'flow.approval':
        return { status: 'waiting', output: { approvalRequired: true }, pause: true };
      case 'flow.delay': {
        // Wave 11 (Priya, DEEP_AUDIT_UX_FINDINGS.md W-1): a timer-based pause,
        // analogous to flow.approval's human-gated pause but auto-resumed by
        // resumeDelayedExecutions (scheduler job) rather than a decision
        // endpoint. Reuses the exact same { status:'waiting', pause:true }
        // contract runNodes/runGraph already handle generically — no changes
        // needed to either — so the only new plumbing is in runWorkflow (which
        // must NOT create a workflow_approvals row for this wait type) and the
        // new scheduler job (which resumes it without a human decision).
        const rawMinutes = Number((config as { delay_minutes?: unknown }).delay_minutes);
        const delayMinutes = Number.isFinite(rawMinutes) && rawMinutes > 0 ? rawMinutes : 0;
        const resumeAt = new Date(Date.now() + delayMinutes * 60_000);
        return {
          status: 'waiting',
          output: { waitReason: 'flow.delay', resumeAt: resumeAt.toISOString(), delayMinutes },
          pause: true,
          waitReason: 'flow.delay',
          resumeAt,
        };
      }
      case 'jira.create_issue':
        return jiraCreateIssue(config, { orgId: ctx.orgId, event: ctx.event as Record<string, unknown>, vars: ctx.vars });
      case 'salesforce.update_contact':
        return salesforceUpdateContact(config, { orgId: ctx.orgId, event: ctx.event as Record<string, unknown>, vars: ctx.vars });
      case 'servicenow.create_incident':
        return servicenowCreateIncident(config, { orgId: ctx.orgId, event: ctx.event as Record<string, unknown>, vars: ctx.vars });
      case 'zendesk.create_ticket':
        return zendeskCreateTicket(config, { orgId: ctx.orgId, event: ctx.event as Record<string, unknown>, vars: ctx.vars });
      case 'crystal.summarize': {
        const r = crystalSummarize({ orgId: ctx.orgId, event: ctx.event as Record<string, unknown>, vars: ctx.vars });
        if (r.vars) Object.assign(ctx.vars, r.vars);
        return r;
      }
      case 'crystal.classify': {
        const r = crystalClassify({ orgId: ctx.orgId, event: ctx.event as Record<string, unknown>, vars: ctx.vars });
        if (r.vars) Object.assign(ctx.vars, r.vars);
        return r;
      }
      default:
        return { status: 'skipped', output: { reason: 'not_wired', action } };
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 'failed', error: msg };
  }
}

// Minimal {{var}} templating from the context (event fields).
export function render(tpl: string, ctx: ExecutionContext): string {
  return String(tpl).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => {
    const v = key.split('.').reduce(
      (o: unknown, k: string) => (o == null ? o : (o as Record<string, unknown>)[k]),
      { ...ctx.event, ...ctx.vars }
    );
    return v == null ? '' : String(v);
  });
}

// ── Workflow run ──────────────────────────────────────────────────────────────

// Execute nodes from `startIndex`. Returns { status, conditionsPassed, pauseIndex? }.
export async function runNodes(nodes: WorkflowNode[], startIndex: number, ctx: ExecutionContext, execId: string): Promise<RunResult> {
  let conditionsPassed = true;
  for (let i = startIndex; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.type === 'trigger') continue;
    if (node.type === 'condition') {
      conditionsPassed = evaluateConditions(node.conditions, { ...ctx.event, ...(ctx.event.payload || {}) });
      await logStep(execId, node, conditionsPassed ? 'completed' : 'skipped', { passed: conditionsPassed });
      if (!conditionsPassed) return { status: 'skipped', conditionsPassed };
      continue;
    }
    if (node.type === 'action') {
      const result = await executeAction(node, ctx);
      await logStep(execId, node, result.status, result.output, result.error);
      if (result.status === 'failed') return { status: 'failed', conditionsPassed };
      if (result.pause) return { status: 'waiting', conditionsPassed, pauseIndex: i, waitReason: result.waitReason, resumeAt: result.resumeAt };
      if (result.stop) return { status: 'completed', conditionsPassed };
    }
  }
  return { status: 'completed', conditionsPassed };
}

// ── Graph (branching) execution ────────────────────────────────────────────────

export function isGraphWorkflow(workflow: WorkflowRecord): boolean {
  return Array.isArray(workflow.edges) && (workflow.edges as WorkflowEdge[]).some((e) => e.branch === 'true' || e.branch === 'false');
}

// Outgoing-edge adjacency keyed by source node id.
function buildAdjacency(edges: WorkflowEdge[]): Map<string, WorkflowEdge[]> {
  const out = new Map<string, WorkflowEdge[]>();
  for (const e of edges) {
    if (!out.has(e.from)) out.set(e.from, []);
    out.get(e.from)!.push(e);
  }
  return out;
}

function nextEdge(edges: WorkflowEdge[] | undefined, branch: string | null): WorkflowEdge | null {
  if (!edges || edges.length === 0) return null;
  if (branch != null) {
    return edges.find((e) => e.branch === branch) || edges.find((e) => e.branch == null) || null;
  }
  return edges.find((e) => e.branch == null) || edges[0];
}

export async function runGraph(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  ctx: ExecutionContext,
  execId: string,
  startNodeId: string | null
): Promise<RunResult> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const adj = buildAdjacency(edges);
  let conditionsPassed = true;
  let currentId: string | null | undefined = startNodeId || (nodes.find((n) => n.type === 'trigger') || nodes[0] || {}).id;
  const maxSteps = nodes.length * 2 + 2; // cycle guard
  let steps = 0;

  while (currentId != null && steps++ < maxSteps) {
    const node = byId.get(currentId);
    if (!node) break;
    let branch: string | null = null;

    if (node.type === 'condition') {
      conditionsPassed = evaluateConditions(node.conditions, { ...ctx.event, ...(ctx.event.payload || {}) });
      await logStep(execId, node, conditionsPassed ? 'completed' : 'skipped', { passed: conditionsPassed });
      branch = conditionsPassed ? 'true' : 'false';
    } else if (node.type === 'action') {
      const result = await executeAction(node, ctx);
      await logStep(execId, node, result.status, result.output, result.error);
      if (result.status === 'failed') return { status: 'failed', conditionsPassed };
      if (result.pause) {
        const succ = nextEdge(adj.get(currentId), null);
        return { status: 'waiting', conditionsPassed, resumeNodeId: succ ? succ.to : null, waitReason: result.waitReason, resumeAt: result.resumeAt };
      }
      if (result.stop) return { status: 'completed', conditionsPassed };
    }

    const edge = nextEdge(adj.get(currentId), branch);
    if (!edge) {
      if (node.type === 'condition' && !conditionsPassed) return { status: 'skipped', conditionsPassed };
      return { status: 'completed', conditionsPassed };
    }
    currentId = edge.to;
  }
  return { status: 'completed', conditionsPassed };
}

// Finalize an execution + roll up workflow stats (terminal states only).
//
// NOTE (workflowQueue integration): on 'failed', bump attempt_count and stamp
// next_retry_at using the backoff schedule owned by lib/workflowQueue.ts (single
// source of truth for retry constants — see MAX_ATTEMPTS/backoffMs there). Loaded
// via a lazy require (mirroring the existing cross-module pattern in
// eventEngine/processor.ts) to avoid a static circular import — workflowQueue.ts
// imports runWorkflowsForEvent from this module.
//
// `conditionsPassed` (cooldown integration, see docs/automation-hub/BUILDER_REBUILD_SPEC.md
// §5.3): stamps `cooldown_last_fired_at` only when the run actually reached action
// execution (conditions passed) — NOT on every terminal outcome the way `last_run_at`
// is. A run that was skipped because a *condition* evaluated false never fired and must
// not arm the cooldown clock; see the migration comment on `cooldown_last_fired_at` in
// 20260701100000_workflow_cooldown.sql for the full rationale.
async function finalizeExecution(execId: string, workflowId: string, status: string, started: number, conditionsPassed = true): Promise<void> {
  if (status === 'failed') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { backoffMs, MAX_ATTEMPTS } = require('./workflowQueue') as { backoffMs: (n: number) => number; MAX_ATTEMPTS: number };
    const { rows: [row] } = await query('SELECT attempt_count FROM workflow_executions WHERE id = $1', [execId]);
    const attempt = ((row as { attempt_count?: number } | undefined)?.attempt_count ?? 0) + 1;
    const willRetry = attempt < MAX_ATTEMPTS;
    const nextRetryAt = willRetry ? new Date(Date.now() + backoffMs(attempt)) : null;
    // BUG FIX (Nina, 2026-07-01): a retried attempt derives the SAME idempotency
    // key as the original failed row (idempotencyKey() prefers event.responseId/
    // entityId/id over streamId — see workflowQueue.ts — so the sweep's republish
    // collides with the row it's retrying). Without clearing idempotency_key here,
    // runWorkflow's `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING` on the
    // retried attempt always hits the still-present original row and silently
    // no-ops — automatic retry never actually re-executes. Null it out on this
    // (now-superseded) row only when another attempt will follow; leave it in
    // place on the final dead-lettered attempt (nothing will retry it, and
    // keeping the key preserves the audit trail for that terminal row).
    await query(
      `UPDATE workflow_executions
          SET status = $2, completed_at = NOW(), duration_ms = $3,
              attempt_count = $4, next_retry_at = $5, dead_letter = $6,
              idempotency_key = CASE WHEN $7 THEN NULL ELSE idempotency_key END
        WHERE id = $1`,
      [execId, status, Date.now() - started, attempt, nextRetryAt, attempt >= MAX_ATTEMPTS, willRetry]
    );
  } else {
    await query(
      `UPDATE workflow_executions SET status = $2, completed_at = NOW(), duration_ms = $3 WHERE id = $1`,
      [execId, status, Date.now() - started]
    );
  }
  await query(
    `UPDATE workflows SET run_count = run_count + 1,
       success_count = success_count + $2, last_run_at = NOW(), last_status = $3,
       cooldown_last_fired_at = CASE WHEN $4 THEN NOW() ELSE cooldown_last_fired_at END
     WHERE id = $1`,
    [workflowId, status === 'completed' ? 1 : 0, status, conditionsPassed]
  );
}

export interface WorkflowRunResult {
  executionId: string;
  status: string;
  conditionsPassed: boolean;
  durationMs: number;
}

/**
 * Persist a fresh 'waiting' pause (first pause or a re-pause after resuming
 * mid-graph, e.g. approval → approval → approval, or an approval immediately
 * followed by a delay). Shared by runWorkflow, resumeWorkflow, and
 * resumeDelayedExecution so the resume_index/resume_node_id bookkeeping — and
 * the wait-reason branch that decides whether a workflow_approvals row gets
 * created — exists in exactly one place.
 *
 * Always writes `status = 'waiting'` unconditionally (idempotent even when the
 * row is already 'waiting', e.g. resumeWorkflow's approval path) — this also
 * correctly restores 'waiting' after resumeDelayedExecution's claim mechanism
 * transiently flips status to 'executing' while it runs, in case that resumed
 * run immediately re-pauses (e.g. a delay followed by another delay/approval).
 *
 * CRITICAL (backward compatibility): the `workflow_approvals` INSERT — which
 * backs the Pending Approvals UI, the approve/reject endpoint, and
 * reNotifyStaleApprovals — must fire ONLY when `res.waitReason` is unset
 * (flow.approval's default, unset-by-design shape; see ActionResult's doc
 * comment) or explicitly 'flow.approval'. A flow.delay pause (waitReason ===
 * 'flow.delay') must NEVER create one of those rows — none of the three
 * approval-only surfaces above should ever see a delay-type wait.
 */
async function persistPause(
  execId: string,
  orgId: string,
  workflowId: string,
  nodes: WorkflowNode[],
  res: RunResult
): Promise<void> {
  const graph = res.resumeNodeId !== undefined;
  const isDelay = res.waitReason === 'flow.delay';

  await query(
    'UPDATE workflow_executions SET status = $2, resume_index = $3, resume_node_id = $4, wait_reason = $5, resume_at = $6 WHERE id = $1',
    [execId, 'waiting', res.pauseIndex != null ? res.pauseIndex + 1 : null, res.resumeNodeId || null, isDelay ? 'flow.delay' : 'flow.approval', res.resumeAt || null]
  );

  if (isDelay) return; // never create a workflow_approvals row for a delay-type wait

  const approvalNodeId = graph
    ? res.resumeNodeId || 'approval'
    : (nodes[res.pauseIndex ?? 0]?.id || 'approval');
  await query(
    `INSERT INTO workflow_approvals (execution_id, org_id, workflow_id, node_id, status)
     VALUES ($1,$2,$3,$4,'pending')`,
    [execId, orgId, workflowId, approvalNodeId]
  );
}

/**
 * Shared continuation tail: given a fresh RunResult from runNodes/runGraph
 * (either the first run or a resume), either persist a new pause or finalize
 * the execution. Used by both runWorkflow (first run) and resumeWorkflow
 * (approval-decision resume) and resumeDelayedExecutions (timer resume) so
 * the re-pause-vs-finalize branch exists once, not duplicated per caller.
 */
async function continueExecution(
  execId: string,
  orgId: string,
  workflowId: string,
  nodes: WorkflowNode[],
  res: RunResult,
  started: number
): Promise<void> {
  if (res.status === 'waiting') {
    await persistPause(execId, orgId, workflowId, nodes, res);
  } else {
    await finalizeExecution(execId, workflowId, res.status, started, res.conditionsPassed);
  }
}

export interface CooldownStatus {
  in_cooldown: boolean;
  cooldown_minutes: number;
  last_fired_at: string | null;
  cooldown_resets_at: string | null;
}

/**
 * Compute the cooldown status for a workflow row (spec:
 * docs/automation-hub/BUILDER_REBUILD_SPEC.md §5.3). Server-side only — the
 * frontend must never derive `cooldown_resets_at` itself from a raw timestamp
 * (clock-skew risk per the spec's explicit requirement).
 *
 * Returns `null` when cooldown does not apply: `time.schedule` triggers (the
 * schedule itself is the throttle) or when `cooldown_minutes` is unset/0 ("no
 * cooldown" is the default/common case and has no status to render).
 */
export function computeCooldownStatus(
  workflow: Pick<WorkflowRecord, 'trigger_type'> & { cooldown_minutes?: number | null; cooldown_last_fired_at?: string | Date | null },
  now: Date = new Date()
): CooldownStatus | null {
  if (workflow.trigger_type === 'time.schedule') return null;
  const cooldownMinutes = workflow.cooldown_minutes;
  if (!cooldownMinutes) return null; // null/0/undefined = no cooldown configured

  const lastFiredAt = workflow.cooldown_last_fired_at ? new Date(workflow.cooldown_last_fired_at) : null;
  if (!lastFiredAt) {
    return { in_cooldown: false, cooldown_minutes: cooldownMinutes, last_fired_at: null, cooldown_resets_at: null };
  }
  const resetsAt = new Date(lastFiredAt.getTime() + cooldownMinutes * 60_000);
  const inCooldown = resetsAt.getTime() > now.getTime();
  return {
    in_cooldown: inCooldown,
    cooldown_minutes: cooldownMinutes,
    last_fired_at: lastFiredAt.toISOString(),
    cooldown_resets_at: inCooldown ? resetsAt.toISOString() : null,
  };
}

/**
 * Run one workflow against a trigger event. Pauses at flow.approval nodes.
 *
 * `idempotencyKey` (optional): set by the async queue consumer
 * (lib/workflowQueue.ts) so an at-least-once redelivery of the same trigger
 * (e.g. an XAUTOCLAIM reclaim after a crashed consumer) is a no-op instead of a
 * duplicate execution. Manual invocations (routes/workflows.ts test/retry) omit
 * it and always create a fresh execution, which is the desired behavior for an
 * explicit user action. Returns `null` when a duplicate is detected.
 *
 * `bypassCooldown` (optional, default false): set by the manual `/test` and
 * `/executions/:id/retry` routes, matching the existing idempotency-bypass
 * convention already established for explicit human actions — a deliberate
 * manual re-run should never be silently swallowed by the automatic-path
 * throttle. Automatic callers (the async queue consumer, the scheduled-workflow
 * sweep) never set this. `time.schedule` workflows are never subject to
 * cooldown regardless of this flag (the schedule itself is the throttle).
 */
export async function runWorkflow(
  workflow: WorkflowRecord,
  event: TriggerEvent,
  { orgId, idempotencyKey, bypassCooldown }: { orgId: string; idempotencyKey?: string; bypassCooldown?: boolean }
): Promise<WorkflowRunResult | null> {
  const started = Date.now();

  // ── Plan-tier gate (defense in depth) ───────────────────────────────────────
  // Nina, 2026-07-01, DEEP_AUDIT_PM_FINDINGS.md §6d/§10c. routes/workflows.ts
  // already rejects saving a Growth-gated trigger (e.g. crystal.anomaly_detected)
  // on a sub-Growth plan at save time, but a plan can be DOWNGRADED after a
  // workflow was saved while still on Growth — this re-check makes that downgrade
  // take effect immediately (matches lib/seats.ts::checkSeatLimit's existing
  // precedent of reading plan_tier live rather than grandfathering a workflow
  // created under a higher plan). Recorded as a clean 'skipped' execution (not
  // 'failed' — this is expected, policy-driven behavior, not an error) so it
  // reads correctly once Fix 1's skipped/reason UI ships.
  const tierGate = await checkTriggerTierGate(orgId, workflow.trigger_type);
  if (!tierGate.allowed && tierGate.requiredTier) {
    const { rows: [exec] } = await query(
      `INSERT INTO workflow_executions (workflow_id, org_id, trigger_type, trigger_payload, status, completed_at, duration_ms, error_message)
       VALUES ($1,$2,$3,$4::jsonb,'skipped',NOW(),$5,$6) RETURNING id`,
      [
        workflow.id, orgId, event.type || workflow.trigger_type || 'manual', JSON.stringify(event),
        Date.now() - started,
        `Skipped: '${workflow.trigger_type}' requires the ${tierGate.requiredTier} plan or higher (org is on ${tierGate.orgTier}).`,
      ]
    );
    return {
      executionId: (exec as { id: string }).id,
      status: 'skipped',
      conditionsPassed: false,
      durationMs: Date.now() - started,
    };
  }

  // ── Cooldown gate ────────────────────────────────────────────────────────
  // Must happen before action execution (spec's explicit requirement), which in
  // practice means before we even create the 'executing' row — a cooldown-blocked
  // trigger never reaches runNodes/runGraph. Skipped for manual test/retry
  // (bypassCooldown) and for time.schedule triggers (cooldown not applicable).
  if (!bypassCooldown && workflow.trigger_type !== 'time.schedule') {
    const cooldownMinutes = (workflow as { cooldown_minutes?: number | null }).cooldown_minutes;
    if (cooldownMinutes) {
      const status = computeCooldownStatus(workflow as WorkflowRecord & { cooldown_minutes?: number | null; cooldown_last_fired_at?: string | null });
      if (status?.in_cooldown) {
        const { rows: [exec] } = await query(
          `INSERT INTO workflow_executions (workflow_id, org_id, trigger_type, trigger_payload, status, completed_at, duration_ms, error_message)
           VALUES ($1,$2,$3,$4::jsonb,'cooldown',NOW(),$5,$6) RETURNING id`,
          [
            workflow.id, orgId, event.type || workflow.trigger_type || 'manual', JSON.stringify(event),
            Date.now() - started,
            `Suppressed by cooldown: last fired ${status.last_fired_at}, cooldown ${status.cooldown_minutes}m, resets ${status.cooldown_resets_at}`,
          ]
        );
        return {
          executionId: (exec as { id: string }).id,
          status: 'cooldown',
          conditionsPassed: false,
          durationMs: Date.now() - started,
        };
      }
    }
  }

  const { rows: [exec] } = await query(
    idempotencyKey
      ? `INSERT INTO workflow_executions (workflow_id, org_id, trigger_type, trigger_payload, status, idempotency_key)
         VALUES ($1,$2,$3,$4::jsonb,'executing',$5)
         ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`
      : `INSERT INTO workflow_executions (workflow_id, org_id, trigger_type, trigger_payload, status)
         VALUES ($1,$2,$3,$4::jsonb,'executing') RETURNING id`,
    idempotencyKey
      ? [workflow.id, orgId, event.type || workflow.trigger_type || 'manual', JSON.stringify(event), idempotencyKey]
      : [workflow.id, orgId, event.type || workflow.trigger_type || 'manual', JSON.stringify(event)]
  );
  if (!exec) return null; // duplicate publish/redelivery — already executed or in flight
  const execId = (exec as { id: string }).id;
  const ctx: ExecutionContext = { orgId, workflowId: workflow.id, event, vars: {} };
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const graph = isGraphWorkflow(workflow);

  let res: RunResult;
  try {
    res = graph
      ? await runGraph(nodes, workflow.edges || [], ctx, execId, null)
      : await runNodes(nodes, 0, ctx, execId);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    await query('UPDATE workflow_executions SET error_message = $2 WHERE id = $1', [execId, msg]);
    res = { status: 'failed', conditionsPassed: true };
  }

  await continueExecution(execId, orgId, workflow.id, nodes, res, started);
  return { executionId: execId, status: res.status, conditionsPassed: res.conditionsPassed, durationMs: Date.now() - started };
}

/** Approve or reject a waiting execution; resume from resume_index on approval. */
export async function resumeWorkflow(
  executionId: string,
  orgId: string,
  decision: string,
  userId: string
): Promise<{ status: string } | null> {
  const started = Date.now();
  // wait_reason filter (Wave 11): a 'waiting' execution can now be paused for two
  // disjoint reasons — flow.approval (human-gated, resumed here) or flow.delay
  // (timer-gated, resumed only by resumeDelayedExecutions). Pre-flow.delay rows
  // and legacy rows have wait_reason='flow.approval' (backfilled by this wave's
  // migration) or NULL (defensive fallback, should not occur post-backfill) —
  // both are treated as approval-eligible so no existing caller of this human
  // decision endpoint breaks. A flow.delay wait must NEVER be resumable via a
  // human approve/reject decision — it has no pending workflow_approvals row to
  // decide on in the first place, and resuming it early would silently skip the
  // wait the workflow author configured.
  const { rows: [exec] } = await query(
    `SELECT * FROM workflow_executions
      WHERE id = $1 AND org_id = $2 AND status = 'waiting'
        AND (wait_reason IS NULL OR wait_reason = 'flow.approval')`,
    [executionId, orgId]
  );
  if (!exec) return null;

  const execRow = exec as Record<string, unknown>;
  const approved = decision === 'approved' || decision === 'approve';
  await query(
    `UPDATE workflow_approvals SET status = $2, decided_by = $3, decided_at = NOW()
      WHERE execution_id = $1 AND status = 'pending'`,
    [executionId, approved ? 'approved' : 'rejected', userId]
  );

  if (!approved) {
    await finalizeExecution(executionId, execRow.workflow_id as string, 'skipped', started);
    return { status: 'rejected' };
  }

  const { rows: [wf] } = await query('SELECT * FROM workflows WHERE id = $1', [execRow.workflow_id]);
  const wfRow = wf as WorkflowRecord | undefined;
  const nodes = Array.isArray(wfRow?.nodes) ? wfRow.nodes : [];
  const ctx: ExecutionContext = { orgId, workflowId: execRow.workflow_id as string, event: (execRow.trigger_payload as TriggerEvent) || {}, vars: {} };
  const graph = execRow.resume_node_id != null;
  let res: RunResult;
  try {
    res = graph
      ? await runGraph(nodes, Array.isArray(wfRow?.edges) ? wfRow.edges : [], ctx, executionId, execRow.resume_node_id as string)
      : await runNodes(nodes, (execRow.resume_index as number) || 0, ctx, executionId);
  } catch { res = { status: 'failed', conditionsPassed: true }; }

  await continueExecution(executionId, orgId, execRow.workflow_id as string, nodes, res, started);
  return { status: res.status };
}

/**
 * Resume ONE flow.delay-type waiting execution whose resume_at has passed.
 * Called by the resumeDelayedExecutions scheduler job — never by a human
 * decision endpoint (contrast resumeWorkflow above, which requires one).
 *
 * CONCURRENCY / IDEMPOTENCY (Priya, Wave 11): the scheduler could tick again
 * before a previous tick's resume finishes a slow downstream action, or two
 * scheduler replicas could race on the same due row in a scaled deployment.
 * Guarded the same way Stripe-style webhook idempotency/claim rows are: a
 * single atomic `UPDATE ... WHERE status = 'waiting' ... RETURNING *` claims
 * the row by flipping it to a transient 'executing' status in the SAME
 * statement that reads it. Postgres's row-level locking on the UPDATE means
 * only one concurrent caller's WHERE clause can match a given row before the
 * other's (each waits for the row lock, then re-evaluates WHERE against the
 * now-changed status and finds zero rows) — so at most one caller ever gets a
 * non-empty RETURNING set for a given execution id, no matter how many
 * callers race. A caller that claims zero rows (rowCount === 0) treats this as
 * "already claimed/resumed elsewhere" and returns null without doing any
 * downstream work — the double-execution class of bug this guards against.
 */
export async function resumeDelayedExecution(executionId: string): Promise<{ status: string } | null> {
  const started = Date.now();
  const { rows: [claimed] } = await query(
    `UPDATE workflow_executions SET status = 'executing'
      WHERE id = $1 AND status = 'waiting' AND wait_reason = 'flow.delay'
        AND resume_at IS NOT NULL AND resume_at <= NOW()
      RETURNING *`,
    [executionId]
  );
  if (!claimed) return null; // already claimed by another tick/replica, or no longer eligible

  const execRow = claimed as Record<string, unknown>;
  const orgId = execRow.org_id as string;
  const { rows: [wf] } = await query('SELECT * FROM workflows WHERE id = $1', [execRow.workflow_id]);
  const wfRow = wf as WorkflowRecord | undefined;
  const nodes = Array.isArray(wfRow?.nodes) ? wfRow.nodes : [];
  const ctx: ExecutionContext = { orgId, workflowId: execRow.workflow_id as string, event: (execRow.trigger_payload as TriggerEvent) || {}, vars: {} };
  const graph = execRow.resume_node_id != null;
  let res: RunResult;
  try {
    res = graph
      ? await runGraph(nodes, Array.isArray(wfRow?.edges) ? wfRow.edges : [], ctx, executionId, execRow.resume_node_id as string)
      : await runNodes(nodes, (execRow.resume_index as number) || 0, ctx, executionId);
  } catch { res = { status: 'failed', conditionsPassed: true }; }

  await continueExecution(executionId, orgId, execRow.workflow_id as string, nodes, res, started);
  return { status: res.status };
}

// Step-execution audit log. Isolated from the caller's control flow: a Postgres
// blip here must never retroactively convert an already-successful action into
// a 'failed' execution (docs/automation-hub/RUNBOOKS.md §3 "root-cause
// follow-up" — a logStep INSERT failure was previously left uncaught, so it
// propagated out of runNodes/runGraph's node loop, was caught by runWorkflow's
// own try/catch, and mis-recorded a successful action as a failed run — which
// then fed the automatic retry path and risked a genuine duplicate side effect,
// e.g. a second Slack message). Logged-and-swallowed instead: the *audit trail*
// for that one step may be incomplete, but the action's own success/failure
// determination (result.status) is untouched.
async function logStep(execId: string, node: WorkflowNode, status: string, output: Record<string, unknown> = {}, error: string | null = null): Promise<void> {
  try {
    await query(
      `INSERT INTO workflow_step_executions (execution_id, node_id, node_type, status, output, error_message)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
      [execId, node.id || node.action || node.type, node.type, status, JSON.stringify(output), error]
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log('warn', { event: 'workflow_step_log_failed', execId, nodeId: node.id || node.action || node.type, err: msg }, 'workflow step log failed');
  }
}

// ── Scope matching ────────────────────────────────────────────────────────────
//
// See docs/automation-hub/BUILDER_REDESIGN_V2_SCOPE.md §2 for the full finding:
// before this, `runWorkflowsForEvent` matched purely on (org_id, trigger_type) —
// no survey dimension anywhere. A workflow scoped to survey A would have fired
// for survey B's events too, since nothing ever checked. This section is the
// load-bearing fix: a scope COLUMN alone (the migration) is cosmetic without
// this matching logic actually gating which workflows run.
//
// Trigger types with NO natural survey dimension (`time.schedule`,
// `external.webhook`) are rejected at the schema-validation layer for
// survey/tag scope (see schemas/workflows.ts) — they can only ever be org-scoped,
// so no runtime resolution is attempted for them here; org-scoped workflows
// always match regardless of trigger type.

/**
 * Resolve the survey id an event pertains to, for scope matching. Checks the
 * modern `event.surveyId` field first (what new producers should set), then
 * falls back to the shapes real producers use today:
 *   - crystal.* triggers (routes/internal-workflows.ts) nest it as
 *     `event.payload.survey_id` (snake_case, per WORKFLOW_SIGNAL_CONTRACT.md).
 *   - alert.fired (lib/alertEngine.ts::fireAlert) nests it as
 *     `event.payload.surveyId` (camelCase — an org-level alert rule has
 *     `surveyId: null` in the payload, which correctly resolves to "no survey").
 * Returns null when no survey id is resolvable (org-level event, or a producer
 * that hasn't been updated to carry one yet) — callers treat null as "does not
 * match any survey-scoped or tag-scoped workflow", never as a wildcard match.
 */
export function resolveEventSurveyId(event: TriggerEvent): string | null {
  if (event.surveyId) return event.surveyId;
  const payload = event.payload;
  if (payload && typeof payload === 'object') {
    const snake = payload.survey_id;
    if (typeof snake === 'string' && snake) return snake;
    const camel = payload.surveyId;
    if (typeof camel === 'string' && camel) return camel;
  }
  return null;
}

/**
 * Does `workflow` match the event, given its scope? Assumes org_id/trigger_type
 * already matched (the caller's SQL WHERE clause) — this only adds the scope
 * dimension on top.
 *   - org-scoped: always matches (current de facto behavior for every existing
 *     workflow, preserved exactly).
 *   - survey-scoped: matches only if the event resolves to that exact survey id.
 *   - tag-scoped: matches only if the event's survey carries that tag —
 *     `surveyIdsForTag` is a pre-fetched Set (one query per candidate tag per
 *     call, not per workflow) so N tag-scoped workflows sharing a tag don't
 *     re-query survey_tag_mappings N times.
 */
export function matchesScope(
  workflow: Pick<WorkflowRecord, 'scope_type' | 'scope_survey_id' | 'scope_tag_id'>,
  eventSurveyId: string | null,
  surveyIdsForTag: (tagId: string) => Set<string> | undefined
): boolean {
  const scopeType = workflow.scope_type || 'org';
  if (scopeType === 'org') return true;
  if (!eventSurveyId) return false; // scoped workflow, event carries no survey — never matches
  if (scopeType === 'survey') return workflow.scope_survey_id === eventSurveyId;
  if (scopeType === 'tag') {
    const surveyIds = workflow.scope_tag_id ? surveyIdsForTag(workflow.scope_tag_id) : undefined;
    return !!surveyIds?.has(eventSurveyId);
  }
  return false;
}

/**
 * Find active workflows subscribed to a trigger type and run each, filtered by
 * scope (see "Scope matching" above).
 *
 * `streamId` (optional): the originating Redis Streams entry id, passed by the
 * async queue consumer (lib/workflowQueue.ts) to derive a per-workflow
 * idempotency key so an at-least-once redelivery doesn't double-execute. Omit
 * for synchronous/manual callers.
 */
export async function runWorkflowsForEvent(orgId: string, triggerType: string, event: TriggerEvent, streamId?: string): Promise<WorkflowRunResult[]> {
  const { rows } = await query(
    `SELECT * FROM workflows
      WHERE org_id = $1 AND trigger_type = $2 AND status = 'active' AND deleted_at IS NULL`,
    [orgId, triggerType]
  );
  const candidates = rows as WorkflowRecord[];

  const eventSurveyId = resolveEventSurveyId(event);

  // Pre-fetch survey_tag_mappings for every distinct tag any candidate is scoped
  // to, in one query — avoids an N+1 (one query per tag-scoped workflow) when
  // several workflows share the same tag scope.
  const tagIds = Array.from(new Set(
    candidates
      .filter((wf) => (wf.scope_type || 'org') === 'tag' && wf.scope_tag_id)
      .map((wf) => wf.scope_tag_id as string)
  ));
  const tagSurveyMap = new Map<string, Set<string>>();
  if (tagIds.length > 0 && eventSurveyId) {
    const { rows: mappingRows } = await query(
      `SELECT tag_id, survey_id FROM survey_tag_mappings WHERE tag_id = ANY($1::uuid[])`,
      [tagIds]
    );
    for (const row of mappingRows as Array<{ tag_id: string; survey_id: string }>) {
      if (!tagSurveyMap.has(row.tag_id)) tagSurveyMap.set(row.tag_id, new Set());
      tagSurveyMap.get(row.tag_id)!.add(row.survey_id);
    }
  }

  const results: WorkflowRunResult[] = [];
  for (const wf of candidates) {
    if (!matchesScope(wf, eventSurveyId, (tagId) => tagSurveyMap.get(tagId))) continue;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const idempotencyKey = streamId
        ? (require('./workflowQueue') as { idempotencyKey: (orgId: string, workflowId: string, triggerType: string, event: TriggerEvent, streamId?: string) => string })
            .idempotencyKey(orgId, wf.id, triggerType, event, streamId)
        : undefined;
      const result = await runWorkflow(wf, { ...event, type: triggerType }, { orgId, idempotencyKey });
      if (result) results.push(result);
    } catch { /* one workflow's failure must not abort the rest */ }
  }
  return results;
}

/**
 * Aggregate recent metrics (NPS, CSAT, response count) for one or more surveys,
 * for injection into a scheduled workflow's trigger event (see
 * `buildScheduledEventData` below — XM_VERIFICATION_REPORT.md Priority 5).
 *
 * Query shape reused, not invented: this mirrors `routes/dashboard.ts`'s
 * `/operations` handler — latest-per-survey row from `survey_metric_snapshots`
 * via a LATERAL join (the existing "get recent NPS/CSAT for survey X" pattern in
 * this codebase) plus a windowed `COUNT(*)` from `responses`, same table/column
 * names, same "most recent snapshot" semantics. No new tables, no new aggregate
 * shape invented for this fix.
 *
 * Window: fixed 7-day lookback for the response-count figure (documented
 * choice, not derived from the workflow's own cadence) — simplest option that's
 * "cheaply available" per the task's scope; a "since this workflow's last fire"
 * window would need to thread `last_run_at` through every call site for
 * marginal benefit over a fixed window for a digest use case. NPS/CSAT come
 * from the single latest snapshot row regardless of window, matching
 * `/operations`'s own behavior (a snapshot is already a point-in-time rollup,
 * not something to re-average over a window).
 *
 * Multi-survey (tag scope) aggregation: NPS/CSAT are averaged across the
 * resolved surveys' latest snapshots (simple mean, unweighted by survey size —
 * documented as a deliberate simplification, not a rigor claim); response
 * counts are summed. Surveys with no snapshot yet are excluded from the
 * NPS/CSAT average but still contribute to the response-count sum.
 */
async function fetchScheduledSurveyMetrics(surveyIds: string[]): Promise<{
  surveyTitle: string | null;
  nps: number | null;
  csat: number | null;
  responseCount: number;
} | null> {
  if (surveyIds.length === 0) return null;
  const { rows } = await query(
    `SELECT s.id, s.title,
            (SELECT COUNT(*)::int FROM responses r
              WHERE r.survey_id = s.id AND r.submitted_at >= NOW() - INTERVAL '7 days') AS response_count,
            m.nps, m.csat
       FROM surveys s
       LEFT JOIN LATERAL (
         SELECT nps, csat FROM survey_metric_snapshots
          WHERE survey_id = s.id ORDER BY captured_at DESC LIMIT 1
       ) m ON TRUE
      WHERE s.id = ANY($1::uuid[]) AND s.deleted_at IS NULL`,
    [surveyIds]
  );
  if (rows.length === 0) return null;

  type Row = { id: string; title: string; response_count: number; nps: number | string | null; csat: number | string | null };
  const surveyRows = rows as Row[];
  const num = (v: number | string | null) => (v == null ? null : Number(v));
  const npsValues = surveyRows.map((r) => num(r.nps)).filter((v): v is number => v != null);
  const csatValues = surveyRows.map((r) => num(r.csat)).filter((v): v is number => v != null);
  const avg = (vals: number[]) => (vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null);
  const responseCount = surveyRows.reduce((sum, r) => sum + (r.response_count || 0), 0);

  return {
    // Single survey: its own title. Multiple (tag scope): no single natural
    // title, so leave null — crystalSummarize/templating degrade gracefully
    // (title bit just omitted from the summary) rather than picking one
    // arbitrarily or concatenating N titles into a noisy string.
    surveyTitle: surveyRows.length === 1 ? surveyRows[0].title : null,
    nps: avg(npsValues),
    csat: avg(csatValues),
    responseCount,
  };
}

/**
 * Resolve a scheduled workflow's scope to the survey id(s) it should fetch
 * metrics for, then build the extra event fields `runScheduledWorkflows`
 * injects into the trigger event (XM_VERIFICATION_REPORT.md Priority 5 fix).
 *
 *   - survey scope → that one survey.
 *   - tag scope → every survey currently mapped to that tag, via the exact
 *     same `survey_tag_mappings` join `runWorkflowsForEvent` already uses to
 *     resolve tag scope for the non-scheduled path (see the pre-fetch above) —
 *     reused here rather than re-derived, one query per call since a scheduled
 *     sweep runs at most a handful of due workflows per tick (no N+1 concern
 *     on the scale `runWorkflowsForEvent`'s batched pre-fetch exists to avoid).
 *   - org scope → intentionally out of scope for this fix (see module-level
 *     comment on `runScheduledWorkflows`): no data-fetch is attempted, and the
 *     event carries no survey fields, so `crystal.summarize` degrades to its
 *     existing generic fallback exactly as before. This is a documented scope
 *     boundary, not a missed case.
 */
async function buildScheduledEventData(wf: WorkflowRecord): Promise<Partial<TriggerEvent>> {
  const scopeType = wf.scope_type || 'org';
  let surveyIds: string[] = [];
  if (scopeType === 'survey' && wf.scope_survey_id) {
    surveyIds = [wf.scope_survey_id];
  } else if (scopeType === 'tag' && wf.scope_tag_id) {
    const { rows } = await query(
      `SELECT survey_id FROM survey_tag_mappings WHERE tag_id = $1`,
      [wf.scope_tag_id]
    );
    surveyIds = (rows as Array<{ survey_id: string }>).map((r) => r.survey_id);
  } else {
    return {}; // org scope (or a scoped row missing its id) — no data-fetch, graceful degrade
  }

  const metrics = await fetchScheduledSurveyMetrics(surveyIds);
  if (!metrics) return { surveyId: scopeType === 'survey' ? wf.scope_survey_id : undefined };

  return {
    surveyId: scopeType === 'survey' ? wf.scope_survey_id : undefined,
    title: metrics.surveyTitle || undefined,
    nps: metrics.nps ?? undefined,
    csat: metrics.csat ?? undefined,
    responseCount: metrics.responseCount,
  };
}

/**
 * Run all active time.schedule workflows whose cron matches `now`. Called once a
 * minute by the Event Engine. The cron lives on the trigger node's config.cron.
 *
 * Scope note (XM_VERIFICATION_REPORT.md Priority 5): `time.schedule` has no
 * *inherent* survey dimension the way e.g. `alert.fired` does — a cron tick
 * isn't "about" any particular survey on its own — but the workflow's own
 * `scope_survey_id`/`scope_tag_id` (set at authoring time, same columns
 * `matchesScope` uses for the non-scheduled path) tell us what the *digest*
 * should be about. Before this fix, those columns were never consulted here,
 * so every scheduled digest's `crystal.summarize`/`notify.*` templating saw a
 * bare `{ type: 'time.schedule', scheduledAt }` event and produced only the
 * generic fallback. `buildScheduledEventData` resolves scope → survey id(s) →
 * recent metrics and merges the result into the event below, for
 * `scope_type: 'survey'` and `scope_type: 'tag'` rows. `scope_type: 'org'`
 * rows (and legacy rows with no scope set) intentionally get no data-fetch —
 * "summarize the entire org" is a materially bigger aggregate than this fix
 * scopes to solve — and keep exactly the pre-fix bare event, so they still
 * degrade gracefully (no crash, same generic-but-valid summary as before).
 */
export async function runScheduledWorkflows(now: Date = new Date()): Promise<WorkflowRunResult[]> {
  const { rows } = await query(
    `SELECT * FROM workflows
      WHERE trigger_type = 'time.schedule' AND status = 'active' AND deleted_at IS NULL`
  );
  const ran: WorkflowRunResult[] = [];
  for (const wf of rows as WorkflowRecord[]) {
    try {
      const triggerNode = (Array.isArray(wf.nodes) ? wf.nodes : []).find((n) => n.type === 'trigger');
      const cron = (triggerNode?.config as { cron?: string } | undefined)?.cron;
      if (!cron || !cronMatches(cron, now)) continue;
      let eventData: Partial<TriggerEvent> = {};
      try {
        eventData = await buildScheduledEventData(wf);
      } catch (err: unknown) {
        // A metrics-fetch failure must not block the schedule from firing at
        // all — degrade to the bare event (pre-fix behavior) rather than
        // skipping the run outright.
        const msg = err instanceof Error ? err.message : String(err);
        log('warn', { event: 'scheduled_workflow_metrics_fetch_failed', workflowId: wf.id, err: msg }, 'scheduled workflow metrics fetch failed');
      }
      const result = await runWorkflow(wf, { type: 'time.schedule', scheduledAt: now.toISOString(), ...eventData }, { orgId: wf.org_id });
      if (result) ran.push(result);
    } catch { /* one schedule failure must not abort the sweep */ }
  }
  return ran;
}
