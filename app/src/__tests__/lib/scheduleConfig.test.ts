import { describe, it, expect } from 'vitest';
import {
  buildCronFromConfig,
  buildScheduleDescription,
  getNextRunFromCron,
  defaultScheduleConfig,
  weeklyDigestDefaultConfig,
  type ScheduleConfigState,
} from '../../lib/scheduleConfig';
import { cronMatches } from '../../../../backend/src/lib/cron';

// ── fixtures ─────────────────────────────────────────────────────────────────
function baseConfig(overrides: Partial<ScheduleConfigState> = {}): ScheduleConfigState {
  return { ...defaultScheduleConfig(), timezone: 'UTC', useBrowserTimezone: false, ...overrides };
}

// Returns the next Date (local time) that falls on `weekday` (0=Sunday..6=Saturday),
// today included only if today already is that weekday.
function nextLocalWeekday(weekday: number): Date {
  const d = new Date();
  const diff = (weekday - d.getDay() + 7) % 7;
  d.setDate(d.getDate() + diff);
  return d;
}

describe('scheduleConfig — buildCronFromConfig', () => {
  it('Weekly Digest repro: frequency=weekly, weeklyDays=[1], 9:00 AM produces "0 9 * * 1" exactly', () => {
    const config = weeklyDigestDefaultConfig();
    config.timezone = 'UTC';
    expect(buildCronFromConfig(config)).toBe('0 9 * * 1');
  });

  it('daily at 9:00 AM produces "0 9 * * *"', () => {
    const config = baseConfig({ frequency: 'daily' });
    expect(buildCronFromConfig(config)).toBe('0 9 * * *');
  });

  it('weekly with multiple days sorts them ascending', () => {
    const config = baseConfig({ frequency: 'weekly', weeklyDays: [5, 1, 3] });
    expect(buildCronFromConfig(config)).toBe('0 9 * * 1,3,5');
  });

  it('12:00 AM (midnight) maps to hour 0', () => {
    const config = baseConfig({ frequency: 'daily', time: { hour12: 12, minute: 0, meridiem: 'AM' } });
    expect(buildCronFromConfig(config)).toBe('0 0 * * *');
  });

  it('12:00 PM (noon) maps to hour 12', () => {
    const config = baseConfig({ frequency: 'daily', time: { hour12: 12, minute: 30, meridiem: 'PM' } });
    expect(buildCronFromConfig(config)).toBe('30 12 * * *');
  });

  it('monthly "1st day of the month" produces "0 <hh> 1 * *"', () => {
    const config = baseConfig({ frequency: 'monthly', monthly: { variant: 'day_of_month', dayOfMonth: 1 } });
    expect(buildCronFromConfig(config)).toBe('0 9 1 * *');
  });

  it('monthly day 29 is representable (literal spec: offer 1-31, show skip warning in UI)', () => {
    const config = baseConfig({ frequency: 'monthly', monthly: { variant: 'day_of_month', dayOfMonth: 29 } });
    expect(buildCronFromConfig(config)).toBe('0 9 29 * *');
  });

  it('monthly "first Monday" produces a DOW-restricted cron (ordinal filtering happens in getNextRunFromCron)', () => {
    const config = baseConfig({ frequency: 'monthly', monthly: { variant: 'ordinal_weekday', ordinal: 'first', ordinalWeekday: 1 } });
    expect(buildCronFromConfig(config)).toBe('0 9 * * 1');
  });

  it('custom interval "every 2 weeks starting next Monday" produces a weekly-Monday cron', () => {
    const config = baseConfig({ frequency: 'custom', customInterval: { count: 2, unit: 'weeks', startingWeekday: 1 } });
    expect(buildCronFromConfig(config)).toBe('0 9 * * 1');
  });

  it('custom interval hours produces "*/n" in the hour field', () => {
    const config = baseConfig({ frequency: 'custom', customInterval: { count: 3, unit: 'hours' } });
    expect(buildCronFromConfig(config)).toBe('0 */3 * * *');
  });

  it('rawCronOverride bypasses the picker mapping entirely', () => {
    const config = baseConfig({ frequency: 'daily', rawCronOverride: '*/15 9-17 * * 1-5' });
    expect(buildCronFromConfig(config)).toBe('*/15 9-17 * * 1-5');
  });

  it('produced cron is real-world valid against the backend cronMatches() for a known matching instant', () => {
    // backend/src/lib/cron.ts's cronMatches() reads Date's LOCAL getHours/getDate/etc
    // (it is timezone-naive — matches server-local time), so this test constructs
    // local-time Dates rather than UTC ones to fairly exercise that function,
    // independent of whatever timezone the test runner's machine is in.
    const config = weeklyDigestDefaultConfig();
    config.timezone = 'UTC';
    const cron = buildCronFromConfig(config); // "0 9 * * 1"
    // Find the next local Monday and set it to 09:00 local time.
    const monday = nextLocalWeekday(1);
    monday.setHours(9, 0, 0, 0);
    expect(cronMatches(cron, monday)).toBe(true);
    const tuesday = new Date(monday);
    tuesday.setDate(tuesday.getDate() + 1);
    expect(cronMatches(cron, tuesday)).toBe(false);
  });
});

describe('scheduleConfig — buildScheduleDescription', () => {
  it('describes the Weekly Digest schedule in plain English', () => {
    const config = weeklyDigestDefaultConfig();
    config.timezone = 'UTC';
    expect(buildScheduleDescription(config)).toBe('every Monday at 9:00 AM UTC');
  });

  it('describes multiple weekly days with "and"', () => {
    const config = baseConfig({ frequency: 'weekly', weeklyDays: [1, 3] });
    expect(buildScheduleDescription(config)).toBe('every Monday and Wednesday at 9:00 AM UTC');
  });

  it('describes the first-Monday-of-month monthly variant', () => {
    const config = baseConfig({ frequency: 'monthly', monthly: { variant: 'ordinal_weekday', ordinal: 'first', ordinalWeekday: 1 } });
    expect(buildScheduleDescription(config)).toBe('the first Monday of each month at 9:00 AM UTC');
  });

  it('describes the day-of-month monthly variant with an ordinal suffix', () => {
    const config = baseConfig({ frequency: 'monthly', monthly: { variant: 'day_of_month', dayOfMonth: 1 } });
    expect(buildScheduleDescription(config)).toBe('the 1st day of the month at 9:00 AM UTC');
  });

  it('describes a custom interval in months starting the current month', () => {
    const config = baseConfig({ frequency: 'custom', customInterval: { count: 3, unit: 'months' } });
    expect(buildScheduleDescription(config)).toMatch(/^every 3 months starting \w+ at 9:00 AM UTC$/);
  });

  it('shows the literal fallback string for a raw cron that is not picker-representable', () => {
    const config = baseConfig({ frequency: 'daily', rawCronOverride: '*/15 9-17 * * 1-5' });
    expect(buildScheduleDescription(config)).toBe('Custom expression (not representable in picker)');
  });

  it('does NOT show the fallback string when rawCronOverride happens to equal the picker-derived cron', () => {
    const config = baseConfig({ frequency: 'daily', time: { hour12: 9, minute: 0, meridiem: 'AM' }, rawCronOverride: '0 9 * * *' });
    expect(buildScheduleDescription(config)).toBe('every day at 9:00 AM UTC');
  });
});

describe('scheduleConfig — getNextRunFromCron', () => {
  it('returns null for a malformed (non-5-field) cron rather than throwing', () => {
    expect(getNextRunFromCron('not a cron', 'UTC')).toBeNull();
    expect(getNextRunFromCron('* * *', 'UTC')).toBeNull();
  });

  it('computes the next Monday 9:00 AM UTC occurrence from a known Sunday', () => {
    const from = new Date(Date.UTC(2026, 0, 4, 8, 0)); // Sunday Jan 4 2026, 08:00 UTC
    const next = getNextRunFromCron('0 9 * * 1', 'UTC', from);
    expect(next).not.toBeNull();
    expect(next!.toISOString()).toBe('2026-01-05T09:00:00.000Z'); // Monday Jan 5
  });

  it('computes the next occurrence when already past the time on the matching day', () => {
    const from = new Date(Date.UTC(2026, 0, 5, 10, 0)); // Monday Jan 5 2026, 10:00 UTC (past 9am)
    const next = getNextRunFromCron('0 9 * * 1', 'UTC', from);
    expect(next!.toISOString()).toBe('2026-01-12T09:00:00.000Z'); // following Monday
  });

  it('correctly skips non-first-Monday weeks for the "first Monday of month" ordinal variant', () => {
    const config = baseConfig({ frequency: 'monthly', monthly: { variant: 'ordinal_weekday', ordinal: 'first', ordinalWeekday: 1 }, time: { hour12: 6, minute: 0, meridiem: 'AM' } });
    const cron = buildCronFromConfig(config);
    const from = new Date(Date.UTC(2026, 0, 6, 0, 0)); // Jan 6 2026 (already past first Monday Jan 5)
    const next = getNextRunFromCron(cron, 'UTC', from, config);
    expect(next).not.toBeNull();
    // First Monday of February 2026 is Feb 2.
    expect(next!.toISOString()).toBe('2026-02-02T06:00:00.000Z');
  });

  it('day-of-month 29-31 correctly skips February in a leap-year-aware way', () => {
    const config = baseConfig({ frequency: 'monthly', monthly: { variant: 'day_of_month', dayOfMonth: 31 }, time: { hour12: 6, minute: 0, meridiem: 'AM' } });
    const cron = buildCronFromConfig(config);
    const from = new Date(Date.UTC(2026, 0, 31, 7, 0)); // just after Jan 31 2026 fire
    const next = getNextRunFromCron(cron, 'UTC', from, config);
    expect(next).not.toBeNull();
    // 2026 Feb has 28 days (not leap) — day 31 doesn't exist, skips to Mar 31.
    expect(next!.toISOString()).toBe('2026-03-31T06:00:00.000Z');
  });

  it('"every 2 weeks starting next Monday" fires exactly 14 days after the anchor, not 7 or 13', () => {
    const config = baseConfig({ frequency: 'custom', customInterval: { count: 2, unit: 'weeks', startingWeekday: 1 }, time: { hour12: 9, minute: 0, meridiem: 'AM' } });
    const cron = buildCronFromConfig(config);
    const from = new Date(Date.UTC(2026, 0, 4, 0, 0)); // Sunday before Monday Jan 5
    const first = getNextRunFromCron(cron, 'UTC', from, config);
    expect(first!.toISOString()).toBe('2026-01-05T09:00:00.000Z'); // anchor: first Monday found

    const second = getNextRunFromCron(cron, 'UTC', first!, config);
    expect(second).not.toBeNull();
    const diffDays = (second!.getTime() - first!.getTime()) / 86400000;
    expect(diffDays).toBe(14);
  });

  it('developer-mode custom cron next-run agrees with backend cronMatches() for the same instant', () => {
    // Use the local timezone (Intl default) on both sides so cron.ts's
    // timezone-naive local-time reads and getNextRunFromCron()'s Intl-based
    // wall-clock reads agree on the same instant.
    const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const cron = '*/15 9-17 * * 1-5';
    const monday = nextLocalWeekday(1);
    monday.setHours(8, 50, 0, 0);
    const next = getNextRunFromCron(cron, localTz, monday);
    expect(next).not.toBeNull();
    expect(cronMatches(cron, next!)).toBe(true);
  });
});

describe('scheduleConfig — card summary + panel preview parity', () => {
  it('the card title/summary and panel preview are driven by the same two pure functions (no drift possible)', () => {
    const config = weeklyDigestDefaultConfig();
    config.timezone = 'UTC';
    const cron = buildCronFromConfig(config);
    const description = buildScheduleDescription(config);
    const next = getNextRunFromCron(cron, config.timezone, new Date(Date.UTC(2026, 0, 1)));
    expect(description).toBe('every Monday at 9:00 AM UTC');
    expect(next).not.toBeNull();
  });
});
