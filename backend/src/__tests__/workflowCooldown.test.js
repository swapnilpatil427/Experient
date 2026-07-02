// Cooldown enforcement (C-004) — genuinely new engine behavior, see
// docs/automation-hub/BUILDER_REBUILD_SPEC.md §5.3 and
// supabase/migrations/20260701100000_workflow_cooldown.sql for the contract/schema
// this exercises. Covers: cooldown blocks a second automatic fire within the
// window and records a distinguishable 'cooldown' execution status; cooldown
// allows a fire once the window elapses; cooldown_minutes null/0 preserves
// existing (unthrottled) behavior; manual bypass; time.schedule exemption;
// computeCooldownStatus's in/out-of-cooldown and time.schedule->null cases.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);

const DB_PATH    = _require.resolve(resolve(__dirname, '../lib/db'));
const NOTIF_PATH = _require.resolve(resolve(__dirname, '../lib/notifications'));
const CH_PATH    = _require.resolve(resolve(__dirname, '../lib/channels'));
const MOD_PATH   = _require.resolve(resolve(__dirname, '../lib/workflowEngine'));
const CREDS_PATH = _require.resolve(resolve(__dirname, '../lib/workflowCredentials'));
const CONN_PATH  = _require.resolve(resolve(__dirname, '../lib/connectors'));

let dbQuery, createNotificationMock, sendSlackMock, sendEmailMock;
function fakeMod(id, exports) { return { id, filename: id, loaded: true, exports, children: [] }; }
function load() {
  _require.cache[DB_PATH] = fakeMod(DB_PATH, { query: dbQuery, default: { query: dbQuery } });
  _require.cache[NOTIF_PATH] = fakeMod(NOTIF_PATH, { createNotification: createNotificationMock, serialize: (r) => r });
  _require.cache[CH_PATH] = fakeMod(CH_PATH, { sendSlack: sendSlackMock, sendEmail: sendEmailMock });
  delete _require.cache[CONN_PATH];
  delete _require.cache[CREDS_PATH];
  delete _require.cache[MOD_PATH];
  return _require(MOD_PATH);
}

beforeEach(() => {
  dbQuery = vi.fn(async (text) => {
    if (text.startsWith('INSERT INTO workflow_executions')) return { rows: [{ id: 'exec-1' }] };
    return { rows: [] };
  });
  createNotificationMock = vi.fn(async () => ({ id: 'n1' }));
  sendSlackMock = vi.fn(async () => ({ channel: 'slack', delivered: true }));
  sendEmailMock = vi.fn(async () => ({ channel: 'email', delivered: true }));
});

const baseWorkflow = () => ({
  id: 'w1',
  trigger_type: 'score.nps_drop',
  nodes: [{ id: 'a1', type: 'action', action: 'notify.in_app', config: { title: 'NPS dropped' } }],
});

describe('runWorkflow cooldown gate', () => {
  it('blocks a second automatic fire within the cooldown window and records a distinct "cooldown" status without executing actions', async () => {
    const { runWorkflow } = load();
    const wf = {
      ...baseWorkflow(),
      cooldown_minutes: 60,
      cooldown_last_fired_at: new Date(Date.now() - 30 * 60_000).toISOString(), // 30 min ago, still within 60m window
    };
    const r = await runWorkflow(wf, { userId: 'u1', nps: 3 }, { orgId: 'o1' });

    expect(r.status).toBe('cooldown');
    expect(createNotificationMock).not.toHaveBeenCalled(); // actions never ran

    const insertCall = dbQuery.mock.calls.find(([text]) => text.startsWith('INSERT INTO workflow_executions'));
    expect(insertCall[0]).toContain("'cooldown'");
    expect(insertCall[0]).not.toContain('idempotency_key'); // cooldown short-circuit predates the idempotency INSERT
  });

  it('allows a fire once the cooldown window has fully elapsed', async () => {
    const { runWorkflow } = load();
    const wf = {
      ...baseWorkflow(),
      cooldown_minutes: 60,
      cooldown_last_fired_at: new Date(Date.now() - 61 * 60_000).toISOString(), // 61 min ago, window elapsed
    };
    const r = await runWorkflow(wf, { userId: 'u1', nps: 3 }, { orgId: 'o1' });

    expect(r.status).toBe('completed');
    expect(createNotificationMock).toHaveBeenCalled();
  });

  it('never blocks a workflow that has never fired before (cooldown_last_fired_at null), regardless of cooldown_minutes', async () => {
    const { runWorkflow } = load();
    const wf = { ...baseWorkflow(), cooldown_minutes: 240, cooldown_last_fired_at: null };
    const r = await runWorkflow(wf, { userId: 'u1', nps: 3 }, { orgId: 'o1' });

    expect(r.status).toBe('completed');
    expect(createNotificationMock).toHaveBeenCalled();
  });

  it.each([null, 0, undefined])('cooldown_minutes=%s means no throttling — fires every time (existing/default behavior preserved)', async (cooldownMinutes) => {
    const { runWorkflow } = load();
    const wf = {
      ...baseWorkflow(),
      cooldown_minutes: cooldownMinutes,
      cooldown_last_fired_at: new Date().toISOString(), // fired one second ago
    };
    const r = await runWorkflow(wf, { userId: 'u1', nps: 3 }, { orgId: 'o1' });

    expect(r.status).toBe('completed');
    expect(createNotificationMock).toHaveBeenCalled();
  });

  it('a workflow with no cooldown_minutes field at all behaves exactly as before this feature existed', async () => {
    const { runWorkflow } = load();
    const wf = baseWorkflow(); // no cooldown_minutes / cooldown_last_fired_at keys present
    const r = await runWorkflow(wf, { userId: 'u1', nps: 3 }, { orgId: 'o1' });

    expect(r.status).toBe('completed');
    expect(createNotificationMock).toHaveBeenCalled();
  });

  it('manual invocations (bypassCooldown: true) fire even while in cooldown, matching the idempotency-bypass convention', async () => {
    const { runWorkflow } = load();
    const wf = {
      ...baseWorkflow(),
      cooldown_minutes: 60,
      cooldown_last_fired_at: new Date().toISOString(), // just fired — would be blocked automatically
    };
    const r = await runWorkflow(wf, { userId: 'u1', nps: 3 }, { orgId: 'o1', bypassCooldown: true });

    expect(r.status).toBe('completed');
    expect(createNotificationMock).toHaveBeenCalled();
  });

  it('time.schedule triggers are never subject to cooldown regardless of cooldown_minutes/last-fired', async () => {
    const { runWorkflow } = load();
    const wf = {
      id: 'w1',
      trigger_type: 'time.schedule',
      nodes: [{ id: 'a1', type: 'action', action: 'notify.in_app', config: {} }],
      cooldown_minutes: 60,
      cooldown_last_fired_at: new Date().toISOString(), // just fired
    };
    const r = await runWorkflow(wf, { type: 'time.schedule', userId: 'u1' }, { orgId: 'o1' });

    expect(r.status).toBe('completed'); // not suppressed, despite being "in window"
    expect(createNotificationMock).toHaveBeenCalled();
  });

  it('stamps cooldown_last_fired_at on the workflows row when a run actually fires (conditions passed)', async () => {
    const { runWorkflow } = load();
    const wf = baseWorkflow();
    await runWorkflow(wf, { userId: 'u1', nps: 3 }, { orgId: 'o1' });

    const rollup = dbQuery.mock.calls.find(([text]) => text.includes('UPDATE workflows SET run_count'));
    expect(rollup).toBeTruthy();
    expect(rollup[0]).toContain('cooldown_last_fired_at');
    // conditionsPassed param (5th bind value: workflowId, successInc, status, conditionsPassed)
    expect(rollup[1]).toEqual(['w1', 1, 'completed', true]);
  });

  it('does NOT stamp cooldown_last_fired_at when a run is skipped because a business condition was false (never actually fired)', async () => {
    const { runWorkflow } = load();
    const wf = {
      id: 'w1',
      nodes: [
        { id: 'c', type: 'condition', conditions: { rules: [{ field: 'nps', op: 'lte', value: 6 }] } },
        { id: 'a1', type: 'action', action: 'notify.in_app', config: {} },
      ],
    };
    const r = await runWorkflow(wf, { userId: 'u1', nps: 9 }, { orgId: 'o1' }); // condition fails (9 > 6)

    expect(r.status).toBe('skipped');
    expect(r.conditionsPassed).toBe(false);
    const rollup = dbQuery.mock.calls.find(([text]) => text.includes('UPDATE workflows SET run_count'));
    expect(rollup[1]).toEqual(['w1', 0, 'skipped', false]); // conditionsPassed=false -> CASE branch is a no-op
  });
});

describe('computeCooldownStatus', () => {
  it('returns null when trigger_type is time.schedule, regardless of cooldown_minutes', () => {
    const { computeCooldownStatus } = load();
    const status = computeCooldownStatus({ trigger_type: 'time.schedule', cooldown_minutes: 60, cooldown_last_fired_at: new Date().toISOString() });
    expect(status).toBeNull();
  });

  it('returns null when cooldown_minutes is null/0/undefined', () => {
    const { computeCooldownStatus } = load();
    expect(computeCooldownStatus({ trigger_type: 'score.nps_drop', cooldown_minutes: null })).toBeNull();
    expect(computeCooldownStatus({ trigger_type: 'score.nps_drop', cooldown_minutes: 0 })).toBeNull();
    expect(computeCooldownStatus({ trigger_type: 'score.nps_drop' })).toBeNull();
  });

  it('returns in_cooldown: false with no resets_at when the workflow has never fired', () => {
    const { computeCooldownStatus } = load();
    const status = computeCooldownStatus({ trigger_type: 'score.nps_drop', cooldown_minutes: 60, cooldown_last_fired_at: null });
    expect(status).toEqual({ in_cooldown: false, cooldown_minutes: 60, last_fired_at: null, cooldown_resets_at: null });
  });

  it('returns in_cooldown: true with a computed cooldown_resets_at when still within the window', () => {
    const { computeCooldownStatus } = load();
    const now = new Date('2026-07-01T12:00:00.000Z');
    const lastFiredAt = new Date('2026-07-01T11:30:00.000Z');
    const status = computeCooldownStatus({ trigger_type: 'score.nps_drop', cooldown_minutes: 60, cooldown_last_fired_at: lastFiredAt.toISOString() }, now);
    expect(status.in_cooldown).toBe(true);
    expect(status.last_fired_at).toBe(lastFiredAt.toISOString());
    expect(status.cooldown_resets_at).toBe(new Date('2026-07-01T12:30:00.000Z').toISOString());
  });

  it('returns in_cooldown: false with cooldown_resets_at null once the window has elapsed', () => {
    const { computeCooldownStatus } = load();
    const now = new Date('2026-07-01T13:00:00.000Z');
    const lastFiredAt = new Date('2026-07-01T11:30:00.000Z'); // 90 min ago, window was 60m
    const status = computeCooldownStatus({ trigger_type: 'score.nps_drop', cooldown_minutes: 60, cooldown_last_fired_at: lastFiredAt.toISOString() }, now);
    expect(status.in_cooldown).toBe(false);
    expect(status.cooldown_resets_at).toBeNull();
    expect(status.last_fired_at).toBe(lastFiredAt.toISOString());
  });
});
