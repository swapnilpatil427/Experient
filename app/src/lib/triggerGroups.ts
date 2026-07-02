// Grouped Trigger Picker data (C-001, BUILDER_REBUILD_SPEC.md §4). Maps the
// real 13-entry backend/src/lib/workflowRegistry.ts TRIGGERS catalog onto the
// 5-group structure CUSTOMER_REVIEW.md's C-001 specifies (Alerts / Thresholds
// / AI Signals / Scheduled / Events), using the actual registry `type` strings
// — never the aspirational canonical vocabulary (see spec §0.1).
//
// Group membership is a plain lookup table so drift between this file and
// workflowRegistry.ts's TRIGGERS array is easy to detect in review (and is
// asserted by src/__tests__/lib/triggerGroups.test.ts against the live
// registry import) — if a trigger is ever added to the registry without a
// matching group entry here, that test fails.

export type TriggerGroupKey = 'alerts' | 'thresholds' | 'aiSignals' | 'scheduled' | 'events';

export interface TriggerGroupMember {
  type: string;
  icon: string; // Material Symbols name
  isCrystal: boolean;
}

export const TRIGGER_GROUPS: Record<TriggerGroupKey, TriggerGroupMember[]> = {
  alerts: [
    { type: 'score.nps_drop', icon: 'speed', isCrystal: false },
    { type: 'score.nps_rise', icon: 'speed', isCrystal: false },
    { type: 'crystal.sentiment_spike', icon: 'monitor_heart', isCrystal: true },
    { type: 'crystal.anomaly_detected', icon: 'warning', isCrystal: true },
    { type: 'crystal.verbatim_escalation', icon: 'flag', isCrystal: true },
    { type: 'alert.fired', icon: 'campaign', isCrystal: false },
  ],
  thresholds: [
    { type: 'survey.milestone', icon: 'flag_circle', isCrystal: false },
  ],
  aiSignals: [
    { type: 'crystal.new_theme_detected', icon: 'auto_awesome', isCrystal: true },
    { type: 'crystal.insight_ready', icon: 'auto_awesome', isCrystal: true },
  ],
  scheduled: [
    { type: 'time.schedule', icon: 'schedule', isCrystal: false },
  ],
  events: [
    { type: 'survey.response_received', icon: 'inbox', isCrystal: false },
    { type: 'survey.response_filtered', icon: 'filter_alt', isCrystal: false },
    { type: 'external.webhook', icon: 'webhook', isCrystal: false },
  ],
};

export const TRIGGER_GROUP_ORDER: TriggerGroupKey[] = ['alerts', 'thresholds', 'aiSignals', 'scheduled', 'events'];

// Flat set of every trigger `type` tagged [Crystal] — used to render the
// badge without re-deriving it from group membership at every call site.
export const CRYSTAL_TRIGGER_TYPES = new Set(
  Object.values(TRIGGER_GROUPS).flatMap((members) => members.filter((m) => m.isCrystal).map((m) => m.type)),
);

export function groupForTrigger(type: string): TriggerGroupKey | null {
  for (const key of TRIGGER_GROUP_ORDER) {
    if (TRIGGER_GROUPS[key].some((m) => m.type === type)) return key;
  }
  return null;
}

// Cooldown suggestion mapping (C-004, spec §5.1) — same grouping used for the
// Workflow Settings panel's "Suggested defaults by trigger type" hint.
export type CooldownSuggestion = { minutes: number | null; labelKey: string } | null;

const COOLDOWN_4H = new Set(['score.nps_drop', 'score.nps_rise', 'crystal.sentiment_spike']);
const COOLDOWN_24H = new Set([
  'crystal.new_theme_detected', 'crystal.anomaly_detected', 'crystal.verbatim_escalation', 'crystal.insight_ready',
]);
const COOLDOWN_NONE = new Set(['survey.response_received', 'survey.response_filtered']);

export function suggestedCooldownMinutes(triggerType: string | null | undefined): number | null | 'not_applicable' {
  if (!triggerType) return null;
  if (triggerType === 'time.schedule') return 'not_applicable';
  if (COOLDOWN_4H.has(triggerType)) return 240;
  if (COOLDOWN_24H.has(triggerType)) return 1440;
  if (COOLDOWN_NONE.has(triggerType)) return 0;
  return null;
}
