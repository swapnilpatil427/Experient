import { describe, it, expect } from 'vitest';
import { TRIGGERS } from '../../../../backend/src/lib/workflowRegistry';
import { TRIGGER_GROUPS, TRIGGER_GROUP_ORDER, CRYSTAL_TRIGGER_TYPES, groupForTrigger } from '../../lib/triggerGroups';

const ALL_GROUPED_TYPES = TRIGGER_GROUP_ORDER.flatMap((k) => TRIGGER_GROUPS[k].map((m) => m.type));

describe('triggerGroups — drift guard against the live registry', () => {
  it('the real registry has exactly 13 triggers (spec §0.1/§Summary point 3 — trust the source file)', () => {
    expect(TRIGGERS.length).toBe(13);
  });

  it('every registry trigger type appears in exactly one group', () => {
    const registryTypes = TRIGGERS.map((t) => t.type).sort();
    const groupedTypes = [...ALL_GROUPED_TYPES].sort();
    expect(groupedTypes).toEqual(registryTypes);
  });

  it('no trigger type is duplicated across groups', () => {
    const seen = new Set<string>();
    for (const type of ALL_GROUPED_TYPES) {
      expect(seen.has(type)).toBe(false);
      seen.add(type);
    }
  });

  it('matches the exact 6/1/2/1/3 group-size split from BUILDER_REBUILD_SPEC.md §4', () => {
    expect(TRIGGER_GROUPS.alerts).toHaveLength(6);
    expect(TRIGGER_GROUPS.thresholds).toHaveLength(1);
    expect(TRIGGER_GROUPS.aiSignals).toHaveLength(2);
    expect(TRIGGER_GROUPS.scheduled).toHaveLength(1);
    expect(TRIGGER_GROUPS.events).toHaveLength(3);
  });

  it('[Crystal] badge appears on exactly the 5 Crystal-origin triggers and no others', () => {
    const expected = new Set([
      'crystal.sentiment_spike', 'crystal.anomaly_detected', 'crystal.verbatim_escalation',
      'crystal.new_theme_detected', 'crystal.insight_ready',
    ]);
    expect(CRYSTAL_TRIGGER_TYPES).toEqual(expected);
  });

  it('groupForTrigger resolves each registry type to its documented group', () => {
    expect(groupForTrigger('score.nps_drop')).toBe('alerts');
    expect(groupForTrigger('alert.fired')).toBe('alerts');
    expect(groupForTrigger('survey.milestone')).toBe('thresholds');
    expect(groupForTrigger('crystal.insight_ready')).toBe('aiSignals');
    expect(groupForTrigger('time.schedule')).toBe('scheduled');
    expect(groupForTrigger('survey.response_filtered')).toBe('events');
    expect(groupForTrigger('not.a.real.trigger')).toBeNull();
  });
});
