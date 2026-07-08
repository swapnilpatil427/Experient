import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);

const REDIS_PATH = _require.resolve(resolve(__dirname, '../lib/redis'));
const DB_PATH    = _require.resolve(resolve(__dirname, '../lib/db'));
const NOTIF_PATH = _require.resolve(resolve(__dirname, '../lib/notifications'));
const EVENTS_PATH = _require.resolve(resolve(__dirname, '../lib/notificationEvents'));
const WQ_PATH    = _require.resolve(resolve(__dirname, '../lib/workflowQueue'));
const PROC_PATH  = _require.resolve(resolve(__dirname, '../eventEngine/processor'));

let redisClient, dbQuery, createNotificationMock, publishWorkflowTriggerMock;
function fakeMod(id, exports) { return { id, filename: id, loaded: true, exports, children: [] }; }

function redisExports() {
  return { getRedisClient: () => redisClient, getRedisBlockingClient: () => redisClient };
}
function loadEvents() {
  _require.cache[REDIS_PATH] = fakeMod(REDIS_PATH, redisExports());
  delete _require.cache[EVENTS_PATH];
  return _require(EVENTS_PATH);
}
function loadProcessor() {
  _require.cache[REDIS_PATH] = fakeMod(REDIS_PATH, redisExports());
  _require.cache[DB_PATH] = fakeMod(DB_PATH, { query: dbQuery, default: { query: dbQuery } });
  _require.cache[NOTIF_PATH] = fakeMod(NOTIF_PATH, { createNotification: createNotificationMock, serialize: (r) => r });
  _require.cache[WQ_PATH] = fakeMod(WQ_PATH, { publishWorkflowTrigger: publishWorkflowTriggerMock });
  delete _require.cache[EVENTS_PATH];        // ensure processor uses fresh deps
  delete _require.cache[PROC_PATH];
  return _require(PROC_PATH);
}

beforeEach(() => {
  redisClient = null;
  dbQuery = vi.fn(async () => ({ rows: [] }));
  createNotificationMock = vi.fn(async () => ({ id: 'n1' }));
  publishWorkflowTriggerMock = vi.fn(async () => 'wq-1-0');
});

describe('publishNotificationEvent', () => {
  it('XADDs the event with all fields ($ stream)', async () => {
    const xadd = vi.fn(async () => '1-0');
    redisClient = { status: 'ready', xadd };
    const { publishNotificationEvent } = loadEvents();
    const id = await publishNotificationEvent({
      type: 'survey.milestone', orgId: 'o1', targetUserIds: ['u1'],
      entityType: 'survey', entityId: 's1', payload: { milestone: 100 },
    });
    expect(id).toBe('1-0');
    const args = xadd.mock.calls[0];
    expect(args[0]).toBe('notifications:events');
    expect(args).toContain('survey.milestone');
    expect(args).toContain('o1');
    expect(args).toContain(JSON.stringify(['u1']));
  });

  it('returns null when Redis is unavailable', async () => {
    redisClient = null;
    const { publishNotificationEvent } = loadEvents();
    expect(await publishNotificationEvent({ type: 'x', orgId: 'o1' })).toBeNull();
  });
});

describe('processor.parseEventFields round-trip', () => {
  it('parses a flat field array into an event object', () => {
    const { parseEventFields } = loadEvents();
    const ev = parseEventFields([
      'type', 'score.nps_drop', 'org_id', 'o1', 'target_user_ids', '["u1","u2"]',
      'priority', 'critical', 'entity_id', 's1', 'payload', '{"drop":12}', 'dedup_window_ms', '3600000',
    ]);
    expect(ev).toMatchObject({ type: 'score.nps_drop', orgId: 'o1', priority: 'critical', entityId: 's1', dedupWindowMs: 3600000 });
    expect(ev.targetUserIds).toEqual(['u1', 'u2']);
    expect(ev.payload).toEqual({ drop: 12 });
  });
});

describe('processBatch', () => {
  it('creates a notification per recipient and ACKs the message', async () => {
    const xack = vi.fn(async () => 1);
    redisClient = {
      status: 'ready', xack,
      xreadgroup: vi.fn(async () => ([
        ['notifications:events', [
          ['10-0', ['type', 'survey.milestone', 'org_id', 'o1', 'target_user_ids', '["u1","u2"]', 'payload', '{}']],
        ]],
      ])),
    };
    const proc = loadProcessor();
    const handled = await proc.processBatch(redisClient, 'c1', { block: 0, count: 10 });
    expect(handled).toBe(1);
    expect(createNotificationMock).toHaveBeenCalledTimes(2); // u1 + u2
    expect(xack).toHaveBeenCalledWith('notifications:events', 'notification-processor', '10-0');
  });

  it('falls back to org admins when no target users are given', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes("default_permissions->>'users:manage'")) return { rows: [{ user_id: 'admin1' }] };
      return { rows: [] };
    });
    redisClient = {
      status: 'ready', xack: vi.fn(async () => 1),
      xreadgroup: vi.fn(async () => ([
        ['notifications:events', [
          ['11-0', ['type', 'system.pipeline_error', 'org_id', 'o1', 'target_user_ids', '[]', 'payload', '{}']],
        ]],
      ])),
    };
    const proc = loadProcessor();
    await proc.processBatch(redisClient, 'c1', { block: 0 });
    expect(createNotificationMock).toHaveBeenCalledWith(expect.objectContaining({ userId: 'admin1', orgId: 'o1' }));
  });

  it('ACKs even when the handler throws (no poison-message loop)', async () => {
    createNotificationMock = vi.fn(async () => { throw new Error('boom'); });
    const xack = vi.fn(async () => 1);
    redisClient = {
      status: 'ready', xack,
      xreadgroup: vi.fn(async () => ([
        ['notifications:events', [['12-0', ['type', 'x', 'org_id', 'o1', 'target_user_ids', '["u1"]', 'payload', '{}']]]],
      ])),
    };
    const proc = loadProcessor();
    const handled = await proc.processBatch(redisClient, 'c1', { block: 0 });
    expect(handled).toBe(1);
    expect(xack).toHaveBeenCalledWith('notifications:events', 'notification-processor', '12-0');
  });

  it('returns 0 when the stream is empty', async () => {
    redisClient = { status: 'ready', xack: vi.fn(), xreadgroup: vi.fn(async () => null) };
    const proc = loadProcessor();
    expect(await proc.processBatch(redisClient, 'c1', { block: 0 })).toBe(0);
  });
});

describe('handleEvent → workflow trigger publish (decoupled from notification delivery)', () => {
  it('enqueues onto the workflow queue instead of running workflows inline', async () => {
    redisClient = {
      status: 'ready', xack: vi.fn(async () => 1),
      xreadgroup: vi.fn(async () => ([
        ['notifications:events', [
          ['13-0', ['type', 'score.nps_drop', 'org_id', 'o1', 'target_user_ids', '["u1"]', 'payload', '{"nps":3}']],
        ]],
      ])),
    };
    const proc = loadProcessor();
    await proc.processBatch(redisClient, 'c1', { block: 0 });
    expect(publishWorkflowTriggerMock).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'o1', triggerType: 'score.nps_drop' })
    );
  });

  it('ACKs the notification event even when the workflow publish fails (best-effort)', async () => {
    publishWorkflowTriggerMock = vi.fn(async () => { throw new Error('redis down'); });
    const xack = vi.fn(async () => 1);
    redisClient = {
      status: 'ready', xack,
      xreadgroup: vi.fn(async () => ([
        ['notifications:events', [
          ['14-0', ['type', 'score.nps_drop', 'org_id', 'o1', 'target_user_ids', '["u1"]', 'payload', '{}']],
        ]],
      ])),
    };
    const proc = loadProcessor();
    const handled = await proc.processBatch(redisClient, 'c1', { block: 0 });
    expect(handled).toBe(1);
    expect(createNotificationMock).toHaveBeenCalled(); // notification delivery unaffected
    expect(xack).toHaveBeenCalledWith('notifications:events', 'notification-processor', '14-0');
  });
});
