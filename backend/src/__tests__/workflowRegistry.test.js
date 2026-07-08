// Regression coverage for the Wave 3 registry gap fix flagged by Rohan
// (BUILDER_SPEC_WAVE2.md §3) and Amara/TEAM.md: workflowRegistry.ts's TRIGGERS
// catalog was missing sentiment_spike and new_theme_detected (only
// crystal.anomaly_detected existed). See docs/automation-hub/WORKFLOW_SIGNAL_CONTRACT.md.
import { describe, it, expect } from 'vitest';
import { registry, TRIGGERS, ACTIONS } from '../lib/workflowRegistry';

describe('workflowRegistry TRIGGERS — Wave 3 AI trigger gap fix', () => {
  it('includes crystal.sentiment_spike', () => {
    const t = TRIGGERS.find((x) => x.type === 'crystal.sentiment_spike');
    expect(t).toBeTruthy();
    expect(t.category).toBe('Crystal');
    expect(t.label).toBeTruthy();
  });

  it('includes crystal.new_theme_detected', () => {
    const t = TRIGGERS.find((x) => x.type === 'crystal.new_theme_detected');
    expect(t).toBeTruthy();
    expect(t.category).toBe('Crystal');
    expect(t.label).toBeTruthy();
  });

  it('keeps crystal.anomaly_detected as a distinct, unrenamed entry', () => {
    const t = TRIGGERS.find((x) => x.type === 'crystal.anomaly_detected');
    expect(t).toBeTruthy();
  });

  it('registry() surfaces all three Crystal AI triggers', () => {
    const { triggers } = registry();
    const crystalTypes = triggers.filter((t) => t.category === 'Crystal').map((t) => t.type);
    expect(crystalTypes).toEqual(expect.arrayContaining([
      'crystal.insight_ready',
      'crystal.anomaly_detected',
      'crystal.verbatim_escalation',
      'crystal.sentiment_spike',
      'crystal.new_theme_detected',
    ]));
  });
});

// Growth-tier gating for Crystal Signal triggers (Nina, 2026-07-01,
// DEEP_AUDIT_PM_FINDINGS.md §6d — "Crystal Signals require a Growth plan" was
// previously pure marketing copy with zero backing `minPlanTier`/enforcement
// anywhere). Enforcement itself is tested in workflowTierGating.test.js /
// workflowEngine.test.js — this file only asserts the registry declares the
// requirement correctly, since lib/planGating.ts reads it via registry().
describe('workflowRegistry TRIGGERS — Growth-plan gating (minPlanTier)', () => {
  it('crystal.anomaly_detected requires the growth plan', () => {
    const t = TRIGGERS.find((x) => x.type === 'crystal.anomaly_detected');
    expect(t.minPlanTier).toBe('growth');
  });
  it('crystal.sentiment_spike requires the growth plan', () => {
    const t = TRIGGERS.find((x) => x.type === 'crystal.sentiment_spike');
    expect(t.minPlanTier).toBe('growth');
  });
  it('crystal.new_theme_detected requires the growth plan', () => {
    const t = TRIGGERS.find((x) => x.type === 'crystal.new_theme_detected');
    expect(t.minPlanTier).toBe('growth');
  });
  it('non-Crystal-Signal triggers are ungated (no minPlanTier)', () => {
    for (const type of ['time.schedule', 'alert.fired', 'survey.milestone', 'crystal.insight_ready', 'crystal.verbatim_escalation']) {
      const t = TRIGGERS.find((x) => x.type === type);
      expect(t.minPlanTier).toBeUndefined();
    }
  });
});

// Trigger readiness signal (finding 2c / T-1, DEEP_AUDIT_PM_FINDINGS.md +
// DEEP_AUDIT_UX_FINDINGS.md, independently corroborated and verified with a
// failing test by Kenji in TriggerActionTile.test.tsx): `ActionDef` already had
// a `live` readiness field; `WorkflowTriggerDef` had none, so a no-producer
// trigger was indistinguishable from a working one in the builder. Every entry
// re-verified fresh against its real producer call site, not carried over from
// a stale audit-doc claim.
describe('workflowRegistry TRIGGERS — live (producer-backed) field', () => {
  it('every trigger declares a boolean live field', () => {
    for (const t of TRIGGERS) {
      expect(typeof t.live).toBe('boolean');
    }
  });

  it('flags the 7 currently producer-less triggers as live: false', () => {
    const noProducer = [
      'survey.response_received', 'survey.response_filtered', 'score.nps_drop',
      'score.nps_rise', 'crystal.insight_ready', 'crystal.verbatim_escalation',
      'external.webhook',
    ];
    for (const type of noProducer) {
      expect(TRIGGERS.find((x) => x.type === type).live).toBe(false);
    }
  });

  it('flags the 6 producer-backed triggers as live: true', () => {
    const hasProducer = [
      'survey.milestone', 'crystal.anomaly_detected', 'crystal.sentiment_spike',
      'crystal.new_theme_detected', 'alert.fired', 'time.schedule',
    ];
    for (const type of hasProducer) {
      expect(TRIGGERS.find((x) => x.type === type).live).toBe(true);
    }
  });

  it('registry() passes the live field through to the API response shape', () => {
    const { triggers } = registry();
    const t = triggers.find((x) => x.type === 'score.nps_drop');
    expect(t.live).toBe(false);
  });
});

// Wave 11 (Priya, DEEP_AUDIT_UX_FINDINGS.md W-1): flow.delay — a second, timer-
// based Flow pause primitive alongside the existing flow.approval/flow.stop.
describe('workflowRegistry ACTIONS — flow.delay (Wave 11)', () => {
  it('registers flow.delay as a live Flow-category action', () => {
    const a = ACTIONS.find((x) => x.action === 'flow.delay');
    expect(a).toBeTruthy();
    expect(a.category).toBe('Flow');
    expect(a.live).toBe(true);
    expect(a.label).toBeTruthy();
  });

  it('does not disturb the existing flow.approval/flow.stop entries', () => {
    const approval = ACTIONS.find((x) => x.action === 'flow.approval');
    const stop = ACTIONS.find((x) => x.action === 'flow.stop');
    expect(approval).toEqual({ action: 'flow.approval', category: 'Flow', label: 'Require approval', live: true });
    expect(stop).toEqual({ action: 'flow.stop', category: 'Flow', label: 'Stop workflow', live: true });
  });

  it('registry() surfaces flow.delay in the actions list', () => {
    const { actions } = registry();
    expect(actions.some((a) => a.action === 'flow.delay')).toBe(true);
  });
});
