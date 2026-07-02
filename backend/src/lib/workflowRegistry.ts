// Workflow registry — the catalog of triggers, condition operators, and actions
// the no-code builder exposes and the engine understands. A representative,
// extensible subset of the full taxonomy (docs/workflows §3–5).

import type { PlanTier } from './creditPlans';

export interface WorkflowTriggerDef {
  type: string;
  category: string;
  label: string;
  // Minimum plan tier required to USE this trigger in a saved/firing workflow
  // (Nina, 2026-07-01, DEEP_AUDIT_PM_FINDINGS.md §6d/§6c: "Crystal Signals require
  // a Growth plan" was previously pure locale-string marketing copy with zero
  // backing enforcement anywhere in the code). Omitted/undefined = no gating
  // (available on every plan, including free). Enforced in two places (defense in
  // depth, see lib/planGating.ts's header comment for why both are needed):
  //   1. Save time — POST/PUT /api/workflows rejects with 403 if the org's plan
  //      doesn't meet this bar (routes/workflows.ts).
  //   2. Execution time — the engine re-checks live on every fire (workflowEngine.ts's
  //      runWorkflow), so a plan downgrade takes effect immediately for existing
  //      workflows too, matching the existing precedent in this codebase for
  //      plan-tier checks (lib/seats.ts::checkSeatLimit reads org_profiles.plan_tier
  //      fresh on every call — a downgrade is never "grandfathered" for currently
  //      running usage).
  minPlanTier?: PlanTier;
  // Whether a real backend producer currently publishes this exact event type
  // (Elias/Kenji, 2026-07-01, DEEP_AUDIT_PM_FINDINGS.md finding 2c /
  // DEEP_AUDIT_UX_FINDINGS.md finding T-1: `ActionDef.live` already gives actions
  // a readiness signal — triggers had none at all, so a no-producer trigger was
  // visually indistinguishable from a working one). Mirrors `ActionDef.live`'s
  // boolean shape (no triggers are currently stub/env-gated, so no need for the
  // 3-value union actions use). Verified fresh against every producer call site,
  // not carried over from stale audit-doc claims — see the per-entry comments below.
  live: boolean;
}

export interface ConditionFieldDef {
  field: string;
  label: string;
  kind: 'number' | 'string';
}

export interface ActionDef {
  action: string;
  category: string;
  label: string;
  live: boolean | 'stub' | 'env';
}

// NOTE (Nina, 2026-07-01, XM_VERIFICATION_REPORT.md Priority 2; re-verified fresh
// against every producer call site on 2026-07-01 for the `live` field below): 7 of
// the 13 trigger types have no producer and will never fire — `live: false` below,
// so the frontend's readiness dot (mirroring `ActionDef.live`'s existing pattern)
// can warn a customer before they build around a dead trigger, closing finding 2c/
// T-1. Fixing the underlying gap (wiring a real producer, or removing the trigger)
// is separate, larger follow-up work — this field only makes the existing gap
// visible instead of silent.
export const TRIGGERS: WorkflowTriggerDef[] = [
  { type: 'survey.response_received', category: 'Survey', label: 'Response received', live: false },
  { type: 'survey.response_filtered', category: 'Survey', label: 'Filtered response (power trigger)', live: false },
  // RENAMED (Nina, 2026-07-01, XM_VERIFICATION_REPORT.md Priority 2): was
  // 'survey.milestone_reached', which never matched the real producer
  // (routes/responses.ts::maybeEmitResponseMilestone publishes 'survey.milestone').
  // Renamed to match the producer — the producer is the live, shipped side; the
  // registry string was the one with zero backing implementation to change.
  { type: 'survey.milestone', category: 'Survey', label: 'Milestone reached', live: true },
  { type: 'score.nps_drop', category: 'Score', label: 'NPS dropped', live: false },
  { type: 'score.nps_rise', category: 'Score', label: 'NPS rose', live: false },
  { type: 'crystal.insight_ready', category: 'Crystal', label: 'Insight ready', live: false },
  // Crystal Signal trigger — Growth-plan gated (see WorkflowTriggerDef.minPlanTier
  // doc comment above; enforcement lives in routes/workflows.ts + workflowEngine.ts,
  // not here — this registry only declares the requirement).
  { type: 'crystal.anomaly_detected', category: 'Crystal', label: 'Anomaly detected', minPlanTier: 'growth', live: true },
  { type: 'crystal.verbatim_escalation', category: 'Crystal', label: 'Verbatim escalation', live: false },
  // Wave 3 AI triggers (Amara/CrystalOS, TEAM.md's Amara Osei mandate + TRACKER Phase 3).
  // Gap flagged by Rohan in BUILDER_SPEC_WAVE2.md §3 and confirmed by Nina's Phase 3 seam
  // review (docs/automation-hub/WORKFLOW_SIGNAL_CONTRACT.md): these are distinct signal
  // types from `crystal.anomaly_detected`, not a rename/alias of it — CrystalOS's insight
  // pipeline can emit any of the three independently (see the contract doc's `signal_type`
  // enum), so `crystal.anomaly_detected` stays as-is and these two are net-new entries.
  // Both are Crystal Signal triggers — Growth-plan gated, same as crystal.anomaly_detected.
  { type: 'crystal.sentiment_spike', category: 'Crystal', label: 'Sentiment spike detected', minPlanTier: 'growth', live: true },
  { type: 'crystal.new_theme_detected', category: 'Crystal', label: 'New theme detected', minPlanTier: 'growth', live: true },
  { type: 'alert.fired', category: 'Alerts', label: 'Alert fired', live: true },
  { type: 'time.schedule', category: 'Time', label: 'On a schedule (cron)', live: true },
  // Correction to an earlier claim that the inbound webhook route
  // (routes/contact-sync.ts) wires this up — it doesn't call runWorkflowsForEvent/
  // publishWorkflowTrigger at all (verified by Kenji's full-repo grep sweep).
  { type: 'external.webhook', category: 'External', label: 'Inbound webhook', live: false },
];

// Condition operators understood by evaluateConditions.
export const CONDITION_OPERATORS: string[] = ['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'between', 'contains', 'not_contains', 'in', 'not_in'];

// Fields that can be referenced in conditions (resolved from the trigger context).
export const CONDITION_FIELDS: ConditionFieldDef[] = [
  { field: 'nps', label: 'NPS score', kind: 'number' },
  { field: 'csat', label: 'CSAT score', kind: 'number' },
  { field: 'sentiment', label: 'Crystal sentiment', kind: 'string' },
  { field: 'text', label: 'Response text', kind: 'string' },
  { field: 'topic', label: 'Crystal topic', kind: 'string' },
  { field: 'severity', label: 'Alert/Crystal severity', kind: 'string' },
  { field: 'completion_time', label: 'Completion time (s)', kind: 'number' },
  { field: 'channel', label: 'Channel', kind: 'string' },
];

// Actions the engine can execute. `live:true` = wired now; others are stubs/roadmap.
export const ACTIONS: ActionDef[] = [
  { action: 'notify.in_app', category: 'Notify', label: 'In-app notification', live: true },
  { action: 'notify.slack', category: 'Notify', label: 'Slack message', live: true },
  { action: 'notify.email', category: 'Notify', label: 'Email', live: true },
  { action: 'notify.webhook', category: 'Notify', label: 'Webhook', live: true },
  { action: 'data.tag_responses', category: 'Data', label: 'Tag responses', live: true },
  { action: 'crystal.summarize', category: 'Crystal', label: 'Crystal summary', live: 'stub' },
  { action: 'crystal.classify', category: 'Crystal', label: 'Crystal classify', live: 'stub' },
  { action: 'crystal.write', category: 'Crystal', label: 'Crystal writes content', live: 'stub' },
  { action: 'jira.create_issue', category: 'Integration', label: 'Create Jira issue', live: 'env' },
  { action: 'salesforce.update_contact', category: 'Integration', label: 'Update Salesforce contact', live: 'env' },
  { action: 'servicenow.create_incident', category: 'Integration', label: 'Create ServiceNow incident', live: 'env' },
  { action: 'zendesk.create_ticket', category: 'Integration', label: 'Create Zendesk ticket', live: 'env' },
  { action: 'flow.approval', category: 'Flow', label: 'Require approval', live: true },
  { action: 'flow.stop', category: 'Flow', label: 'Stop workflow', live: true },
  // Wave 11 (Priya, 2026-07-02, DEEP_AUDIT_UX_FINDINGS.md W-1): a second, distinct
  // pause primitive alongside flow.approval — a timer-based wait rather than a
  // human-gated one, so "notify Slack, then if unresolved after 24h escalate" is
  // expressible. Config shape `{ delay_minutes: number }` — kept as this exact
  // field name because Rohan's duration-picker UI (spec, not yet built) converts
  // its friendly input to this wire shape.
  { action: 'flow.delay', category: 'Flow', label: 'Wait before continuing', live: true },
];

export const ACTION_SET = new Set(ACTIONS.map((a) => a.action));

export interface RegistryResult {
  triggers: WorkflowTriggerDef[];
  conditionFields: ConditionFieldDef[];
  conditionOperators: string[];
  actions: ActionDef[];
}

export function registry(): RegistryResult {
  return { triggers: TRIGGERS, conditionFields: CONDITION_FIELDS, conditionOperators: CONDITION_OPERATORS, actions: ACTIONS };
}
