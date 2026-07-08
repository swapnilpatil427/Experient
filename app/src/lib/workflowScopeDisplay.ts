// Scope → rail color / chip text resolution shared by WorkflowListCard's rail
// + chip and the ScopeFilterBar (BUILDER_REDESIGN_V2_CONCEPT.md §2). Colors are
// brand-reactive CSS var names (per app/CLAUDE.md's three-layer cascade) — never
// hardcoded hex, so a brand-theme override still applies to scope rails.
import type { Workflow, WorkflowScopeType } from '../types';

export function scopeRailColorVar(scopeType: WorkflowScopeType | undefined): string {
  if (scopeType === 'survey') return 'var(--color-primary)';
  if (scopeType === 'tag') return 'var(--color-tertiary)';
  return 'var(--color-outline)'; // org (default/quietest — see concept doc §2)
}

export interface ResolvedScopeNames {
  surveyNameById: Map<string, string>;
  tagNameById: Map<string, { name: string; survey_count?: number; program_config?: Record<string, unknown> }>;
}

export function scopeChipKey(wf: Pick<Workflow, 'scope_type'>): WorkflowScopeType {
  return wf.scope_type ?? 'org';
}
