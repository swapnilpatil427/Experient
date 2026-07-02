// Shared content-section model for ContentCustomizationPanel (SectionChecklist +
// LivePreviewMock). Kept in its own module so it's importable by both the
// component and its tests without a circular dependency.
import type { NotifyTarget } from '../../../lib/api';

export type { NotifyTarget };

export interface SectionState {
  crystalSummary: boolean;
  keyMetrics: boolean;
  topVerbatims: boolean;
  trendChart: boolean;
  recommendedActions: boolean;
  rawResponseCount: boolean;
}

export type SectionPreset = 'standard' | 'metricsOnly' | 'fullDetail' | 'custom';

export const SECTION_KEYS: Array<keyof SectionState> = [
  'crystalSummary', 'keyMetrics', 'topVerbatims', 'trendChart', 'recommendedActions', 'rawResponseCount',
];

// "Standard Digest" default per BUILDER_REDESIGN_V2_CONCEPT.md §6 Screen 4:
// Crystal AI Summary + Key Metrics + Trend Chart checked, rest off.
export function standardDigestSections(): SectionState {
  return {
    crystalSummary: true,
    keyMetrics: true,
    topVerbatims: false,
    trendChart: true,
    recommendedActions: false,
    rawResponseCount: false,
  };
}

export function metricsOnlySections(): SectionState {
  return {
    crystalSummary: false,
    keyMetrics: true,
    topVerbatims: false,
    trendChart: false,
    recommendedActions: false,
    rawResponseCount: false,
  };
}

export function fullDetailSections(): SectionState {
  return {
    crystalSummary: true,
    keyMetrics: true,
    topVerbatims: true,
    trendChart: true,
    recommendedActions: true,
    rawResponseCount: true,
  };
}

export function sectionsForPreset(preset: Exclude<SectionPreset, 'custom'>): SectionState {
  if (preset === 'metricsOnly') return metricsOnlySections();
  if (preset === 'fullDetail') return fullDetailSections();
  return standardDigestSections();
}

// True if `sections` exactly matches one of the 3 canned presets — used to
// decide whether the preset dropdown should still show that preset's label
// or fall back to displaying "Custom" after an individual checkbox edit.
export function matchingPreset(sections: SectionState): SectionPreset {
  const presets: Array<[Exclude<SectionPreset, 'custom'>, SectionState]> = [
    ['standard', standardDigestSections()],
    ['metricsOnly', metricsOnlySections()],
    ['fullDetail', fullDetailSections()],
  ];
  for (const [name, shape] of presets) {
    if (SECTION_KEYS.every((k) => sections[k] === shape[k])) return name;
  }
  return 'custom';
}

export interface ActionContentConfig {
  sections: SectionState;
  preset: SectionPreset;
  target?: NotifyTarget;
  channel?: string;
  subject?: string;
}

export function defaultActionContentConfig(): ActionContentConfig {
  return { sections: standardDigestSections(), preset: 'standard' };
}

// Nina's backend contract (Wave 9, TRACKER.md) persists targeting as FLAT
// fields directly on the action's config — `{ targetType, userIds?, roleId?,
// departmentId?, groupId?, ...restOfConfig }` — not nested under a `target`
// key. The frontend keeps `target: NotifyTarget` as a single nested
// convenience field on ActionContentConfig so the picker/serializer have one
// clean discriminated union to work with; these two helpers are the seam
// between that frontend convenience shape and the backend's real flat wire
// shape. Every read of a persisted config and every write back to one must
// go through these, so the two shapes never drift.

// Wire → frontend: pull whichever id field is present (flat, on `config`
// itself) into a NotifyTarget. Also the backward-compat path: a workflow
// saved before targeting existed has `config.userId: string` (notify.email,
// singular) or `config.userIds: string[]` (notify.in_app, plural) with no
// `targetType` at all — treated as `targetType: 'users'` so the picker loads
// into "Specific people" mode showing that legacy user, not an empty/broken
// state.
export function extractNotifyTarget(config: Record<string, unknown> | undefined): NotifyTarget | undefined {
  if (!config) return undefined;
  const targetType = config.targetType as NotifyTarget['targetType'] | undefined;
  if (targetType === 'role' && typeof config.roleId === 'string') return { targetType: 'role', roleId: config.roleId };
  if (targetType === 'department' && typeof config.departmentId === 'string') return { targetType: 'department', departmentId: config.departmentId };
  if (targetType === 'group' && typeof config.groupId === 'string') return { targetType: 'group', groupId: config.groupId };
  if (targetType === 'users' && Array.isArray(config.userIds)) return { targetType: 'users', userIds: config.userIds as string[] };
  // Legacy, no targetType at all.
  const userIds = Array.isArray(config.userIds) ? (config.userIds as string[]) : undefined;
  if (userIds && userIds.length > 0) return { targetType: 'users', userIds };
  const userId = typeof config.userId === 'string' ? config.userId : undefined;
  if (userId) return { targetType: 'users', userIds: [userId] };
  return undefined;
}

/** @deprecated use extractNotifyTarget — kept as an alias during the Wave 9 rollout. */
export const hydrateLegacyNotifyTarget = extractNotifyTarget;

// Frontend → wire: spread a NotifyTarget into the flat id fields the backend
// expects, alongside the rest of an action's config.
export function flattenNotifyTarget(target: NotifyTarget | undefined): Record<string, unknown> {
  if (!target) return {};
  if (target.targetType === 'users') return { targetType: 'users', userIds: target.userIds };
  if (target.targetType === 'role') return { targetType: 'role', roleId: target.roleId };
  if (target.targetType === 'department') return { targetType: 'department', departmentId: target.departmentId };
  return { targetType: 'group', groupId: target.groupId };
}
