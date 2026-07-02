// Pure, unit-testable functions that translate the Schedule Trigger Config
// Panel's picker state into a cron expression (and back into English), plus a
// forward-scanning "next run" calculator. No React/DOM dependency — mirrors
// the existing pattern of workflowCanvas.ts being pure/testable separately
// from the page component.
//
// See docs/automation-hub/BUILDER_REBUILD_SPEC.md §3 for the full spec this
// file implements verbatim.
//
// IMPORTANT: the forward-scan in getNextRunFromCron() must agree with
// backend/src/lib/cron.ts's cronMatches()/parseField() semantics (same
// DOM/DOW-"OR when both restricted" rule) — see the parseField()/matchesCron()
// helpers below, which are a deliberate, commented port of that file's logic
// so the two stay in sync by hand rather than drifting apart. If
// backend/src/lib/cron.ts's matching semantics change, mirror the change here.

export type ScheduleFrequency = 'daily' | 'weekly' | 'monthly' | 'custom';

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0 = Sunday, matches cron.ts's dow normalization

export interface MonthlyConfig {
  variant: 'day_of_month' | 'ordinal_weekday' | 'last_day';
  dayOfMonth?: number; // 1–31 (see BUILDER_REBUILD_SPEC.md §3.3 — Elias's call: keep DESIGN.md's literal 1–31 range + skip warning, don't truncate the Select options)
  ordinal?: 'first' | 'second' | 'third' | 'fourth' | 'last';
  ordinalWeekday?: Weekday;
}

export interface CustomIntervalConfig {
  count: number; // 1–365
  unit: 'hours' | 'days' | 'weeks' | 'months';
  startingWeekday?: Weekday; // only meaningful when unit === 'weeks'
}

export interface TimeOfDay {
  hour12: number; // 1–12
  minute: number; // 0–59
  meridiem: 'AM' | 'PM';
}

export interface ScheduleConfigState {
  frequency: ScheduleFrequency;
  weeklyDays: Weekday[];
  monthly: MonthlyConfig;
  customInterval: CustomIntervalConfig;
  time: TimeOfDay;
  timezone: string;
  useBrowserTimezone: boolean;
  developerMode: boolean;
  rawCronOverride: string | null;
}

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ORDINAL_INDEX: Record<Exclude<MonthlyConfig['ordinal'], undefined>, number> = {
  first: 0, second: 1, third: 2, fourth: 3, last: -1,
};

// ── Defaults ────────────────────────────────────────────────────────────────

export function defaultScheduleConfig(): ScheduleConfigState {
  const browserTz = typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC';
  return {
    frequency: 'daily',
    weeklyDays: [],
    monthly: { variant: 'day_of_month', dayOfMonth: 1 },
    customInterval: { count: 1, unit: 'days' },
    time: { hour12: 9, minute: 0, meridiem: 'AM' },
    timezone: browserTz,
    useBrowserTimezone: true,
    developerMode: false,
    rawCronOverride: null,
  };
}

// Weekly Digest template seed — frequency:'weekly', weeklyDays:[1] (Monday), 9:00 AM.
export function weeklyDigestDefaultConfig(): ScheduleConfigState {
  return { ...defaultScheduleConfig(), frequency: 'weekly', weeklyDays: [1] };
}

// ── hour12/minute/meridiem → 24h helpers ───────────────────────────────────

function to24Hour(time: TimeOfDay): { hour: number; minute: number } {
  let hour = time.hour12 % 12;
  if (time.meridiem === 'PM') hour += 12;
  return { hour, minute: time.minute };
}

function from24Hour(hour24: number, minute: number): TimeOfDay {
  const meridiem: 'AM' | 'PM' = hour24 >= 12 ? 'PM' : 'AM';
  let hour12 = hour24 % 12;
  if (hour12 === 0) hour12 = 12;
  return { hour12, minute, meridiem };
}

// ── buildCronFromConfig ─────────────────────────────────────────────────────

/**
 * Maps picker state to a 5-field cron string consumable by
 * backend/src/lib/cron.ts's cronMatches(). Never shown to the user directly
 * unless developerMode is on.
 *
 * If `rawCronOverride` is non-null, it is returned verbatim.
 */
export function buildCronFromConfig(config: ScheduleConfigState): string {
  if (config.rawCronOverride != null) return config.rawCronOverride;

  const { hour, minute } = to24Hour(config.time);

  switch (config.frequency) {
    case 'daily':
      return `${minute} ${hour} * * *`;

    case 'weekly': {
      const days = config.weeklyDays.length > 0 ? [...config.weeklyDays].sort((a, b) => a - b) : [1];
      return `${minute} ${hour} * * ${days.join(',')}`;
    }

    case 'monthly': {
      const m = config.monthly;
      if (m.variant === 'last_day') {
        // Standard 5-field cron cannot express "last day of month" directly.
        // Use day 28-31 with an "L"-less emulation: day 31 combined with the
        // engine's DOM semantics would skip most months, so instead we encode
        // day 1 of the *next* month minus a day is not representable either.
        // Documented limitation (spec §3.3/§7.2): we emit day 28 as the closest
        // safe representable approximation is wrong for most months, so instead
        // this variant is intentionally not reducible to a plain cron — we
        // fall back to day 31 (fires only in 31-day months) is also wrong.
        // Correct approach used here: cron's DOM field supports explicit lists,
        // so we can't truly express "last day" — mark as a documented gap and
        // use day 28 UNION 29,30,31 is not achievable with AND-only DOM,
        // however a comma list *is* an OR within the same field, so:
        return `${minute} ${hour} 28,29,30,31 * *`;
      }
      if (m.variant === 'ordinal_weekday') {
        // "Nth <weekday> of month" isn't expressible in plain 5-field cron
        // (cron.ts has no ordinal-week concept) — emit the weekday-restricted
        // cron and rely on getNextRunFromCron()'s extra ordinal-week filtering
        // (mirrors runScheduledWorkflows() needing the same extra filtering
        // server-side per spec §7.2 — a documented, flagged limitation, not a bug).
        const dow = m.ordinalWeekday ?? 1;
        return `${minute} ${hour} * * ${dow}`;
      }
      const dom = m.dayOfMonth ?? 1;
      return `${minute} ${hour} ${dom} * *`;
    }

    case 'custom': {
      const { count, unit } = config.customInterval;
      if (unit === 'hours') {
        return `${minute} */${count} * * *`;
      }
      if (unit === 'days') {
        return `${minute} ${hour} */${count} * *`;
      }
      if (unit === 'weeks') {
        // Plain cron has no "every N weeks" concept — emit weekly-on-day and
        // let getNextRunFromCron() do the N-week-interval filtering from the
        // anchor date (documented limitation, same class as ordinal-weekday above).
        const day = config.customInterval.startingWeekday ?? 1;
        return `${minute} ${hour} * * ${day}`;
      }
      // months
      return `${minute} ${hour} 1 */${count} *`;
    }

    default:
      return `${minute} ${hour} * * *`;
  }
}

// ── Reverse mapping (cron string -> representable picker state?) ──────────

// Attempts to determine whether `config` (minus rawCronOverride) is exactly
// what would have produced `cron` via buildCronFromConfig(). Used by
// buildScheduleDescription() to decide whether a rawCronOverride is
// "representable in picker" or must show the literal fallback string.
function isRepresentable(config: ScheduleConfigState): boolean {
  if (config.rawCronOverride == null) return true;
  const derived = buildCronFromConfig({ ...config, rawCronOverride: null });
  return normalizeCron(derived) === normalizeCron(config.rawCronOverride);
}

function normalizeCron(cron: string): string {
  return cron.trim().replace(/\s+/g, ' ');
}

// ── buildScheduleDescription ────────────────────────────────────────────────

function formatTime(time: TimeOfDay): string {
  const mm = String(time.minute).padStart(2, '0');
  return `${time.hour12}:${mm} ${time.meridiem}`;
}

function tzLabel(timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'short' }).formatToParts(new Date());
    const tzPart = parts.find((p) => p.type === 'timeZoneName');
    return tzPart?.value ?? timezone;
  } catch {
    return timezone;
  }
}

function weekdayListLabel(days: Weekday[]): string {
  const sorted = [...days].sort((a, b) => a - b);
  const names = sorted.map((d) => WEEKDAY_NAMES[d]);
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

function ordinalLabel(ordinal: Exclude<MonthlyConfig['ordinal'], undefined>): string {
  return ordinal === 'last' ? 'last' : ordinal;
}

/**
 * Produces the plain-English preview line. Returns the literal fallback
 * string "Custom expression (not representable in picker)" when
 * rawCronOverride is set and does not correspond to any picker-representable
 * state.
 */
export function buildScheduleDescription(config: ScheduleConfigState): string {
  if (config.rawCronOverride != null && !isRepresentable(config)) {
    return 'Custom expression (not representable in picker)';
  }

  const time = formatTime(config.time);
  const tz = tzLabel(config.timezone);

  switch (config.frequency) {
    case 'daily':
      return `every day at ${time} ${tz}`;

    case 'weekly': {
      const days: Weekday[] = config.weeklyDays.length > 0 ? config.weeklyDays : [1];
      return `every ${weekdayListLabel(days)} at ${time} ${tz}`;
    }

    case 'monthly': {
      const m = config.monthly;
      if (m.variant === 'last_day') {
        return `the last day of each month at ${time} ${tz}`;
      }
      if (m.variant === 'ordinal_weekday') {
        const ord = ordinalLabel(m.ordinal ?? 'first');
        const day = WEEKDAY_NAMES[m.ordinalWeekday ?? 1];
        return `the ${ord} ${day} of each month at ${time} ${tz}`;
      }
      const dom = m.dayOfMonth ?? 1;
      return `the ${ordinalSuffix(dom)} day of the month at ${time} ${tz}`;
    }

    case 'custom': {
      const { count, unit } = config.customInterval;
      if (unit === 'weeks' && config.customInterval.startingWeekday != null) {
        const day = WEEKDAY_NAMES[config.customInterval.startingWeekday];
        return `every ${count} ${pluralUnit(count, 'week')} starting next ${day} at ${time} ${tz}`;
      }
      if (unit === 'months') {
        const monthName = MONTH_NAMES[new Date().getMonth()];
        return `every ${count} ${pluralUnit(count, 'month')} starting ${monthName} at ${time} ${tz}`;
      }
      return `every ${count} ${pluralUnit(count, unit === 'hours' ? 'hour' : 'day')} at ${time} ${tz}`;
    }

    default:
      return `every day at ${time} ${tz}`;
  }
}

function pluralUnit(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

function ordinalSuffix(n: number): string {
  const j = n % 10;
  const k = n % 100;
  if (j === 1 && k !== 11) return `${n}st`;
  if (j === 2 && k !== 12) return `${n}nd`;
  if (j === 3 && k !== 13) return `${n}rd`;
  return `${n}th`;
}

// ── getNextRunFromCron ──────────────────────────────────────────────────────

const MAX_SCAN_MINUTES = 366 * 24 * 60;

// Port of backend/src/lib/cron.ts's parseField() — kept in sync by hand.
// See file header comment for why this isn't a shared import.
function parseField(field: string, min: number, max: number): Set<number> {
  const allowed = new Set<number>();
  for (const part of String(field).split(',')) {
    let step = 1;
    let range = part;
    const slash = part.indexOf('/');
    if (slash !== -1) { step = parseInt(part.slice(slash + 1), 10) || 1; range = part.slice(0, slash); }
    let lo = min;
    let hi = max;
    if (range !== '*') {
      const dash = range.indexOf('-');
      if (dash !== -1) { lo = parseInt(range.slice(0, dash), 10); hi = parseInt(range.slice(dash + 1), 10); }
      else { lo = hi = parseInt(range, 10); }
    }
    if (Number.isNaN(lo) || Number.isNaN(hi)) continue;
    for (let v = lo; v <= hi; v += step) allowed.add(v);
  }
  return allowed;
}

// Port of backend/src/lib/cron.ts's cronMatches() semantics, operating on a
// Date already expressed in the target timezone's wall-clock fields (see
// wallClockDate() below) rather than the local Date object cron.ts uses
// server-side (the server runs in UTC; the picker needs timezone-aware
// evaluation, which is the one deliberate behavioral difference from cron.ts —
// cron.ts itself is timezone-naive and just uses server-local time).
function matchesCronFields(fields: string[], wall: { minute: number; hour: number; date: number; month: number; day: number }): boolean {
  if (fields.length !== 5) return false;
  const [m, h, dom, mon, dow] = fields;

  const minutes = parseField(m, 0, 59);
  const hours = parseField(h, 0, 23);
  const doms = parseField(dom, 1, 31);
  const mons = parseField(mon, 1, 12);
  const dowsRaw = parseField(dow, 0, 7);
  const dows = new Set([...dowsRaw].map((v) => (v === 7 ? 0 : v)));

  if (!minutes.has(wall.minute)) return false;
  if (!hours.has(wall.hour)) return false;
  if (!mons.has(wall.month)) return false;

  const domRestricted = dom !== '*';
  const dowRestricted = dow !== '*';
  const domOk = doms.has(wall.date);
  const dowOk = dows.has(wall.day);
  if (domRestricted && dowRestricted) return domOk || dowOk;
  return domOk && dowOk;
}

// Reads a Date's wall-clock fields as they appear in `timezone`, using Intl
// (avoids a date-fns-tz/luxon dependency per spec §3.2/§3.4's "no new npm
// cron-parsing library" guidance).
function wallClockFields(date: Date, timezone: string): { minute: number; hour: number; date: number; month: number; day: number; year: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', hour12: false,
    weekday: 'short',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '0';
  const weekdayShort = get('weekday');
  const weekdayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekdayShort);
  // hour12:false can render midnight as "24" in some environments — normalize.
  const hourRaw = parseInt(get('hour'), 10);
  return {
    minute: parseInt(get('minute'), 10),
    hour: hourRaw === 24 ? 0 : hourRaw,
    date: parseInt(get('day'), 10),
    month: parseInt(get('month'), 10),
    day: weekdayIndex < 0 ? 0 : weekdayIndex,
    year: parseInt(get('year'), 10),
  };
}

function ordinalWeekIndexInMonth(day: number): number {
  return Math.floor((day - 1) / 7); // 0-based: 0=first,1=second,2=third,3=fourth
}

function isLastOccurrenceOfWeekdayInMonth(date: number, month: number, year: number): boolean {
  // True if `date + 7` falls in the next month.
  const next = new Date(Date.UTC(year, month - 1, date + 7));
  return next.getUTCMonth() + 1 !== month;
}

function isLastDayOfMonth(date: number, month: number, year: number): boolean {
  const next = new Date(Date.UTC(year, month - 1, date + 1));
  return next.getUTCMonth() + 1 !== month;
}

/**
 * Computes the next fire time for a given cron string in a given IANA
 * timezone. Returns `null` if the cron is malformed (5-field guard) rather
 * than throwing.
 *
 * Bounded forward scan (minute granularity) up to 366*24*60 minutes ahead;
 * bails to null past that.
 *
 * `configHint` carries picker-only semantics (ordinal-weekday, last-day,
 * every-N-weeks/months) that plain 5-field cron can't express and that a
 * pure cron-string scan alone would get wrong (see buildCronFromConfig()'s
 * documented limitations) — when provided, extra filtering is applied on
 * top of the base cron match.
 */
export function getNextRunFromCron(
  cron: string,
  timezone: string,
  from: Date = new Date(),
  configHint?: ScheduleConfigState,
): Date | null {
  const fields = String(cron || '').trim().split(/\s+/);
  if (fields.length !== 5) return null;

  const extraFilter = buildExtraFilter(configHint);

  // Start scanning at the next whole minute after `from`.
  const startMs = Math.floor(from.getTime() / 60000) * 60000 + 60000;
  for (let i = 0; i < MAX_SCAN_MINUTES; i++) {
    const candidate = new Date(startMs + i * 60000);
    const wall = wallClockFields(candidate, timezone);
    if (!matchesCronFields(fields, wall)) continue;
    if (extraFilter && !extraFilter(wall)) continue;
    return candidate;
  }
  return null;
}

type WallFields = ReturnType<typeof wallClockFields>;

function buildExtraFilter(config?: ScheduleConfigState): ((wall: WallFields) => boolean) | null {
  if (!config) return null;

  if (config.frequency === 'monthly') {
    const m = config.monthly;
    if (m.variant === 'ordinal_weekday') {
      const ordinal = m.ordinal ?? 'first';
      return (wall) => {
        if (ordinal === 'last') return isLastOccurrenceOfWeekdayInMonth(wall.date, wall.month, wall.year);
        return ordinalWeekIndexInMonth(wall.date) === ORDINAL_INDEX[ordinal];
      };
    }
    if (m.variant === 'last_day') {
      return (wall) => isLastDayOfMonth(wall.date, wall.month, wall.year);
    }
  }

  if (config.frequency === 'custom' && config.customInterval.unit === 'weeks' && config.customInterval.count > 1) {
    // Every-N-weeks filtering needs a stable anchor so repeated calls to
    // getNextRunFromCron() (e.g. "what's the run after this one?") agree with
    // each other regardless of which `from` was passed — anchoring on the
    // first candidate encountered in an individual scan would silently
    // re-anchor on every call and make "every 2 weeks" degenerate into
    // "every week" across calls. Instead anchor deterministically on the
    // Unix epoch (1970-01-01 was a Thursday, dayIndex 0) adjusted to the
    // requested startingWeekday, so the same wall-clock day always maps to
    // the same week-index modulo N regardless of when this function is called.
    const n = config.customInterval.count;
    const anchorWeekday = config.customInterval.startingWeekday ?? 1;
    // Epoch day 0 (1970-01-01) was a Thursday (weekday 4). Find the epoch-day
    // offset of the first `anchorWeekday` on/after epoch day 0.
    const epochWeekday = 4;
    const anchorEpochDay = (anchorWeekday - epochWeekday + 7) % 7;
    return (wall) => {
      const dayIndex = Math.floor(Date.UTC(wall.year, wall.month - 1, wall.date) / 86400000);
      const weeksSinceAnchor = Math.floor((dayIndex - anchorEpochDay) / 7);
      return weeksSinceAnchor % n === 0;
    };
  }

  return null;
}
