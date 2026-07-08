import { describe, it, expect } from 'vitest';
import { SCOPE_UNSUPPORTED_TRIGGER_TYPES } from '../../lib/scopeRules';

describe('scopeRules — mirrors backend SCOPE_UNSUPPORTED_TRIGGER_TYPES', () => {
  it('contains exactly external.webhook', () => {
    expect(SCOPE_UNSUPPORTED_TRIGGER_TYPES).toEqual(new Set(['external.webhook']));
  });

  it('does not flag a survey-scopable trigger type', () => {
    expect(SCOPE_UNSUPPORTED_TRIGGER_TYPES.has('score.nps_drop')).toBe(false);
    expect(SCOPE_UNSUPPORTED_TRIGGER_TYPES.has('crystal.anomaly_detected')).toBe(false);
  });

  it('allows survey/tag scope for time.schedule (drives scheduled-digest data-fetch, not event-matching)', () => {
    expect(SCOPE_UNSUPPORTED_TRIGGER_TYPES.has('time.schedule')).toBe(false);
  });
});
