import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);

const REDIS_PATH     = _require.resolve(resolve(__dirname, '../lib/redis'));
const DB_PATH        = _require.resolve(resolve(__dirname, '../lib/db'));
const ENGINE_PATH    = _require.resolve(resolve(__dirname, '../lib/workflowEngine'));
const SCHEDULER_PATH = _require.resolve(resolve(__dirname, '../lib/tagReportScheduler'));
const QUEUE_PATH     = _require.resolve(resolve(__dirname, '../lib/workflowQueue'));

let redisClient, dbQuery, runWorkflowsForEventMock, handleTagReportDueTriggerMock;
function fakeMod(id, exports) { return { id, filename: id, loaded: true, exports, children: [] }; }

function redisExports() {
  return { getRedisClient: () => redisClient, getRedisBlockingClient: () => redisClient };
}
function loadQueue() {
  _require.cache[REDIS_PATH] = fakeMod(REDIS_PATH, redisExports());
  _require.cache[DB_PATH] = fakeMod(DB_PATH, { query: dbQuery, default: { query: dbQuery } });
  _require.cache[ENGINE_PATH] = fakeMod(ENGINE_PATH, { runWorkflowsForEvent: runWorkflowsForEventMock });
  // Tag Report's Automated-mode due-tags sweep dispatch (TRACKER.md §1 Task 15) —
  // isolated from tagReportScheduler.ts's real implementation/dependency tree here.
  _require.cache[SCHEDULER_PATH] = fakeMod(SCHEDULER_PATH, {
    TAG_REPORT_DUE_TRIGGER_TYPE: 'tag_report.automated_due',
    handleTagReportDueTrigger: handleTagReportDueTriggerMock,
  });
  delete _require.cache[QUEUE_PATH];
  return _require(QUEUE_PATH);
}

beforeEach(() => {
  redisClient = null;
  dbQuery = vi.fn(async () => ({ rows: [] }));
  runWorkflowsForEventMock = vi.fn(async () => ([{ executionId: 'e1', status: 'completed' }]));
  handleTagReportDueTriggerMock = vi.fn(async () => {});
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('publishWorkflowTrigger', () => {
  it('XADDs the trigger event onto the workflow:triggers stream', async () => {
    const xadd = vi.fn(async () => '1-0');
    redisClient = { status: 'ready', xadd };
    const { publishWorkflowTrigger } = loadQueue();
    const id = await publishWorkflowTrigger({
      orgId: 'o1', triggerType: 'survey.response_filtered', event: { nps: 3 },
    });
    expect(id).toBe('1-0');
    const args = xadd.mock.calls[0];
    expect(args[0]).toBe('workflow:triggers');
    expect(args).toContain('o1');
    expect(args).toContain('survey.response_filtered');
    expect(args).toContain(JSON.stringify({ nps: 3 }));
  });

  it('returns null when Redis is unavailable', async () => {
    redisClient = null;
    const { publishWorkflowTrigger } = loadQueue();
    expect(await publishWorkflowTrigger({ orgId: 'o1', triggerType: 'x', event: {} })).toBeNull();
  });

  it('throws when orgId or triggerType is missing', async () => {
    redisClient = { status: 'ready', xadd: vi.fn() };
    const { publishWorkflowTrigger } = loadQueue();
    await expect(publishWorkflowTrigger({ orgId: '', triggerType: 'x', event: {} })).rejects.toThrow();
    await expect(publishWorkflowTrigger({ orgId: 'o1', triggerType: '', event: {} })).rejects.toThrow();
  });
});

describe('parseTriggerFields round-trip', () => {
  it('parses a flat field array into a trigger event object', () => {
    const { parseTriggerFields } = loadQueue();
    const ev = parseTriggerFields([
      'org_id', 'o1', 'trigger_type', 'score.nps_drop', 'event', '{"nps":3,"userId":"u1"}',
    ]);
    expect(ev).toEqual({ orgId: 'o1', triggerType: 'score.nps_drop', event: { nps: 3, userId: 'u1' } });
  });

  it('falls back to {} for malformed event JSON', () => {
    const { parseTriggerFields } = loadQueue();
    const ev = parseTriggerFields(['org_id', 'o1', 'trigger_type', 'x', 'event', 'not-json']);
    expect(ev.event).toEqual({});
  });
});

describe('idempotencyKey', () => {
  it('derives a stable key from responseId when present', () => {
    const { idempotencyKey } = loadQueue();
    const k1 = idempotencyKey('o1', 'w1', 'survey.response_filtered', { responseId: 'r1' }, 'stream-1');
    const k2 = idempotencyKey('o1', 'w1', 'survey.response_filtered', { responseId: 'r1' }, 'stream-2');
    expect(k1).toBe(k2); // same logical trigger dedups regardless of stream entry id
    expect(k1).toBe('o1:w1:survey.response_filtered:r1');
  });

  it('falls back to entityId, then event.id, then the stream id', () => {
    const { idempotencyKey } = loadQueue();
    expect(idempotencyKey('o1', 'w1', 't', { entityId: 'e1' })).toBe('o1:w1:t:e1');
    expect(idempotencyKey('o1', 'w1', 't', { id: 'i1' })).toBe('o1:w1:t:i1');
    expect(idempotencyKey('o1', 'w1', 't', {}, 'stream-9')).toBe('o1:w1:t:stream-9');
  });

  it('differs per workflow so one trigger event fans out to distinct keys', () => {
    const { idempotencyKey } = loadQueue();
    const k1 = idempotencyKey('o1', 'w1', 't', { responseId: 'r1' });
    const k2 = idempotencyKey('o1', 'w2', 't', { responseId: 'r1' });
    expect(k1).not.toBe(k2);
  });
});

describe('backoffMs', () => {
  it('computes exponential backoff from RETRY_BASE_MS/RETRY_FACTOR', () => {
    const { backoffMs, RETRY_BASE_MS, RETRY_FACTOR } = loadQueue();
    expect(backoffMs(1)).toBe(RETRY_BASE_MS);
    expect(backoffMs(2)).toBe(RETRY_BASE_MS * RETRY_FACTOR);
    expect(backoffMs(3)).toBe(RETRY_BASE_MS * RETRY_FACTOR * RETRY_FACTOR);
  });

  it('defaults to base=30000, factor=2, maxAttempts=5', () => {
    const { RETRY_BASE_MS, RETRY_FACTOR, MAX_ATTEMPTS } = loadQueue();
    expect(RETRY_BASE_MS).toBe(30000);
    expect(RETRY_FACTOR).toBe(2);
    expect(MAX_ATTEMPTS).toBe(5);
  });

  it('clamps attempt below 1 to attempt 1', () => {
    const { backoffMs, RETRY_BASE_MS } = loadQueue();
    expect(backoffMs(0)).toBe(RETRY_BASE_MS);
    expect(backoffMs(-1)).toBe(RETRY_BASE_MS);
  });
});

describe('processBatch', () => {
  it('calls runWorkflowsForEvent with orgId/triggerType/event/streamId and ACKs', async () => {
    const xack = vi.fn(async () => 1);
    redisClient = {
      status: 'ready', xack,
      xreadgroup: vi.fn(async () => ([
        ['workflow:triggers', [
          ['10-0', ['org_id', 'o1', 'trigger_type', 'score.nps_drop', 'event', '{"nps":3}']],
        ]],
      ])),
    };
    const proc = loadQueue();
    const handled = await proc.processBatch(redisClient, 'c1', { block: 0, count: 10 });
    expect(handled).toBe(1);
    expect(runWorkflowsForEventMock).toHaveBeenCalledWith('o1', 'score.nps_drop', { nps: 3 }, '10-0');
    expect(xack).toHaveBeenCalledWith('workflow:triggers', 'workflow-processor', '10-0');
  });

  it('ACKs even when the handler throws (no poison-message loop)', async () => {
    runWorkflowsForEventMock = vi.fn(async () => { throw new Error('boom'); });
    const xack = vi.fn(async () => 1);
    redisClient = {
      status: 'ready', xack,
      xreadgroup: vi.fn(async () => ([
        ['workflow:triggers', [['11-0', ['org_id', 'o1', 'trigger_type', 'x', 'event', '{}']]]],
      ])),
    };
    const proc = loadQueue();
    const handled = await proc.processBatch(redisClient, 'c1', { block: 0 });
    expect(handled).toBe(1);
    expect(xack).toHaveBeenCalledWith('workflow:triggers', 'workflow-processor', '11-0');
  });

  it('dispatches tag_report.automated_due to handleTagReportDueTrigger, not runWorkflowsForEvent (TRACKER.md §1 Task 15)', async () => {
    const xack = vi.fn(async () => 1);
    redisClient = {
      status: 'ready', xack,
      xreadgroup: vi.fn(async () => ([
        ['workflow:triggers', [
          ['12-0', ['org_id', 'o1', 'trigger_type', 'tag_report.automated_due', 'event', '{"entityId":"tag-1"}']],
        ]],
      ])),
    };
    const proc = loadQueue();
    const handled = await proc.processBatch(redisClient, 'c1', { block: 0, count: 10 });
    expect(handled).toBe(1);
    expect(handleTagReportDueTriggerMock).toHaveBeenCalledWith('o1', 'tag-1');
    expect(runWorkflowsForEventMock).not.toHaveBeenCalled();
    expect(xack).toHaveBeenCalledWith('workflow:triggers', 'workflow-processor', '12-0');
  });

  it('returns 0 when the stream is empty', async () => {
    redisClient = { status: 'ready', xack: vi.fn(), xreadgroup: vi.fn(async () => null) };
    const proc = loadQueue();
    expect(await proc.processBatch(redisClient, 'c1', { block: 0 })).toBe(0);
  });
});

describe('reclaimStale', () => {
  it('re-handles and ACKs entries claimed from a dead consumer', async () => {
    const xack = vi.fn(async () => 1);
    redisClient = {
      status: 'ready', xack,
      xautoclaim: vi.fn(async () => (['0-0', [
        ['12-0', ['org_id', 'o1', 'trigger_type', 'x', 'event', '{}']],
      ]])),
    };
    const proc = loadQueue();
    const n = await proc.reclaimStale(redisClient, 'c1', 30000);
    expect(n).toBe(1);
    expect(runWorkflowsForEventMock).toHaveBeenCalledWith('o1', 'x', {}, '12-0');
    expect(xack).toHaveBeenCalledWith('workflow:triggers', 'workflow-processor', '12-0');
  });

  it('returns 0 on redis error', async () => {
    redisClient = { status: 'ready', xautoclaim: vi.fn(async () => { throw new Error('nope'); }) };
    const proc = loadQueue();
    expect(await proc.reclaimStale(redisClient, 'c1')).toBe(0);
  });
});

describe('sweepDueRetries', () => {
  it('republishes due, non-exhausted failed executions and clears next_retry_at', async () => {
    const xadd = vi.fn(async () => '20-0');
    redisClient = { status: 'ready', xadd };
    dbQuery = vi.fn(async (text) => {
      if (text.includes('SET dead_letter = TRUE')) return { rows: [] };
      if (text.includes('SELECT id, workflow_id, org_id, trigger_type, trigger_payload, attempt_count')) {
        return { rows: [{ id: 'e1', workflow_id: 'w1', org_id: 'o1', trigger_type: 'score.nps_drop', trigger_payload: { nps: 3 }, attempt_count: 1 }] };
      }
      return { rows: [] };
    });
    const proc = loadQueue();
    const result = await proc.sweepDueRetries(new Date('2026-07-01T00:00:00Z'));
    expect(result.republished).toBe(1);
    expect(xadd).toHaveBeenCalled();
    const clearCall = dbQuery.mock.calls.find(([text]) => text.includes('SET next_retry_at = NULL'));
    expect(clearCall).toBeTruthy();
    expect(clearCall[1]).toEqual(['e1']);
  });

  it('dead-letters executions that reached MAX_ATTEMPTS and does not republish them', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('SET dead_letter = TRUE')) {
        return { rows: [{ id: 'e2', workflow_id: 'w1', org_id: 'o1', trigger_type: 't', trigger_payload: {} }] };
      }
      return { rows: [] }; // no due (non-exhausted) rows
    });
    const proc = loadQueue();
    const result = await proc.sweepDueRetries(new Date());
    expect(result.deadLettered).toBe(1);
    expect(result.republished).toBe(0);
  });

  it('is a no-op when nothing is due', async () => {
    dbQuery = vi.fn(async () => ({ rows: [] }));
    const proc = loadQueue();
    const result = await proc.sweepDueRetries(new Date());
    expect(result).toEqual({ republished: 0, deadLettered: 0 });
  });
});
