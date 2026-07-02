// Reliability / chaos test suite for Xperiq Actions async execution.
//
// Owner: Kenji Watanabe (QA/Reliability). Scope: gaps NOT already covered by
// workflowQueue.test.js, workflowEngine.test.js, workflowConnectors.test.js,
// workflowCredentialsRoutes.test.js, workflowsRetry.test.js — see
// docs/automation-hub/ADR_EXECUTION_ARCHITECTURE.md §3 ("What Kenji needs to
// test") for the scenario list this file is written against.
//
// Every test here uses the same require.cache DB-mock injection pattern already
// established in workflowEngine.test.js / workflowQueue.test.js — no real
// Postgres/Redis instance is used or required.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);

const DB_PATH     = _require.resolve(resolve(__dirname, '../lib/db'));
const NOTIF_PATH  = _require.resolve(resolve(__dirname, '../lib/notifications'));
const CH_PATH     = _require.resolve(resolve(__dirname, '../lib/channels'));
const REDIS_PATH  = _require.resolve(resolve(__dirname, '../lib/redis'));
const CREDS_PATH  = _require.resolve(resolve(__dirname, '../lib/workflowCredentials'));
const CONN_PATH   = _require.resolve(resolve(__dirname, '../lib/connectors'));
const ENGINE_PATH = _require.resolve(resolve(__dirname, '../lib/workflowEngine'));
const QUEUE_PATH  = _require.resolve(resolve(__dirname, '../lib/workflowQueue'));

function fakeMod(id, exports) { return { id, filename: id, loaded: true, exports, children: [] }; }

let dbQuery, createNotificationMock, sendSlackMock, sendEmailMock, redisClient;

// Load workflowEngine.ts fresh with the current mocks (mirrors workflowEngine.test.js).
function loadEngine() {
  _require.cache[DB_PATH] = fakeMod(DB_PATH, { query: dbQuery, default: { query: dbQuery } });
  _require.cache[NOTIF_PATH] = fakeMod(NOTIF_PATH, { createNotification: createNotificationMock, serialize: (r) => r });
  _require.cache[CH_PATH] = fakeMod(CH_PATH, { sendSlack: sendSlackMock, sendEmail: sendEmailMock });
  delete _require.cache[CONN_PATH];
  delete _require.cache[CREDS_PATH];
  delete _require.cache[ENGINE_PATH];
  delete _require.cache[QUEUE_PATH]; // finalizeExecution lazy-requires this; keep it real (not mocked)
  return _require(ENGINE_PATH);
}

// Load workflowQueue.ts fresh with mocked redis/db/engine (mirrors workflowQueue.test.js).
function loadQueue(runWorkflowsForEventMock) {
  _require.cache[REDIS_PATH] = fakeMod(REDIS_PATH, { getRedisClient: () => redisClient, getRedisBlockingClient: () => redisClient });
  _require.cache[DB_PATH] = fakeMod(DB_PATH, { query: dbQuery, default: { query: dbQuery } });
  _require.cache[ENGINE_PATH] = fakeMod(ENGINE_PATH, { runWorkflowsForEvent: runWorkflowsForEventMock });
  delete _require.cache[QUEUE_PATH];
  return _require(QUEUE_PATH);
}

beforeEach(() => {
  dbQuery = vi.fn(async (text) => {
    if (text.startsWith('INSERT INTO workflow_executions')) return { rows: [{ id: 'exec-1' }] };
    return { rows: [] };
  });
  createNotificationMock = vi.fn(async () => ({ id: 'n1' }));
  sendSlackMock = vi.fn(async () => ({ channel: 'slack', delivered: true }));
  sendEmailMock = vi.fn(async () => ({ channel: 'email', delivered: true }));
  redisClient = null;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// ── 1. Exact backoff schedule (ADR §2.3 / §3) ─────────────────────────────────
describe('backoffMs exact schedule (30s/60s/120s/240s, attempt 5 dead-letters)', () => {
  it('matches the documented ADR schedule for attempts 1 through 5, precisely', () => {
    const { backoffMs, MAX_ATTEMPTS } = loadQueue(vi.fn());
    // ADR §2.3: 30s, 60s, 120s, 240s before attempts 2..5; defaults RETRY_BASE_MS=30000, RETRY_FACTOR=2.
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(2)).toBe(60_000);
    expect(backoffMs(3)).toBe(120_000);
    expect(backoffMs(4)).toBe(240_000);
    expect(backoffMs(5)).toBe(480_000); // computed value; attempt 5 itself dead-letters (see below), this delay is never scheduled
    expect(MAX_ATTEMPTS).toBe(5);
  });
});

// ── 2. Off-by-one at the dead-letter boundary (ADR: "the classic bug here") ──
describe('dead-letter boundary is exact (no 6th attempt scheduled)', () => {
  const failingWf = { id: 'w1', nodes: [{ id: 'a1', type: 'action', action: 'notify.webhook', config: { url: 'https://x.test' } }] };

  it('attempt_count reaching exactly MAX_ATTEMPTS (5) dead-letters, not schedules a 6th attempt', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.startsWith('INSERT INTO workflow_executions')) return { rows: [{ id: 'exec-1' }] };
      if (text.startsWith('SELECT attempt_count')) return { rows: [{ attempt_count: 4 }] }; // about to become the 5th attempt
      return { rows: [] };
    });
    global.fetch = vi.fn(async () => { throw new Error('network down'); });
    const { runWorkflow } = loadEngine();
    await runWorkflow(failingWf, {}, { orgId: 'o1' });
    const updateCall = dbQuery.mock.calls.find(([text]) => text.includes('attempt_count = $4'));
    const [, params] = updateCall;
    const [, , , attempt, nextRetryAt, deadLetter] = params;
    expect(attempt).toBe(5);
    expect(deadLetter).toBe(true);
    expect(nextRetryAt).toBeNull(); // no 6th attempt scheduled
  });

  it('attempt_count at MAX_ATTEMPTS - 1 (4) still schedules one more retry, not a dead-letter', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.startsWith('INSERT INTO workflow_executions')) return { rows: [{ id: 'exec-1' }] };
      if (text.startsWith('SELECT attempt_count')) return { rows: [{ attempt_count: 3 }] }; // about to become the 4th attempt
      return { rows: [] };
    });
    global.fetch = vi.fn(async () => { throw new Error('network down'); });
    const { runWorkflow } = loadEngine();
    await runWorkflow(failingWf, {}, { orgId: 'o1' });
    const updateCall = dbQuery.mock.calls.find(([text]) => text.includes('attempt_count = $4'));
    const [, params] = updateCall;
    const [, , , attempt, nextRetryAt, deadLetter] = params;
    expect(attempt).toBe(4);
    expect(deadLetter).toBe(false);
    expect(nextRetryAt).not.toBeNull();
  });

  it('sweepDueRetries dead-letters (does not republish) a due row already at MAX_ATTEMPTS', async () => {
    const xadd = vi.fn(async () => '99-0');
    redisClient = { status: 'ready', xadd };
    dbQuery = vi.fn(async (text) => {
      if (text.includes('SET dead_letter = TRUE')) {
        return { rows: [{ id: 'e-exhausted', workflow_id: 'w1', org_id: 'o1', trigger_type: 't', trigger_payload: {} }] };
      }
      // The "due, non-exhausted" SELECT explicitly filters attempt_count < MAX_ATTEMPTS,
      // so an exhausted row must never appear here.
      return { rows: [] };
    });
    const { sweepDueRetries } = loadQueue(vi.fn());
    const result = await sweepDueRetries(new Date());
    expect(result.deadLettered).toBe(1);
    expect(result.republished).toBe(0);
    expect(xadd).not.toHaveBeenCalled(); // exhausted row never republished onto the stream
  });
});

// ── 3. Duplicate trigger dedup: two different stream entry IDs, same idempotency key ──
describe('duplicate trigger dedup (XAUTOCLAIM redelivery simulation)', () => {
  const wf = { id: 'w1', org_id: 'o1', nodes: [{ id: 'a1', type: 'action', action: 'notify.in_app', config: { userIds: ['u1'] } }] };

  it('two different stream entry IDs resolving to the same idempotency key produce exactly one execution row and one side effect', async () => {
    // Simulate a durable executions table: first INSERT with a given idempotency_key
    // succeeds (returns a row); a second INSERT with the SAME key is what
    // `ON CONFLICT (idempotency_key) DO NOTHING` would do in real Postgres — return
    // no row. We model that server-side behavior explicitly here since this is a
    // mocked db, not a real unique index.
    const seenKeys = new Set();
    dbQuery = vi.fn(async (text, params) => {
      if (text.includes('FROM workflows')) return { rows: [wf] };
      if (text.startsWith('INSERT INTO workflow_executions')) {
        const key = params[4]; // idempotency_key param position (see runWorkflow's parameterized INSERT)
        if (seenKeys.has(key)) return { rows: [] }; // ON CONFLICT DO NOTHING → no row
        seenKeys.add(key);
        return { rows: [{ id: 'exec-1' }] };
      }
      return { rows: [] };
    });
    const { runWorkflowsForEvent } = loadEngine();

    // Two distinct Redis Streams entry IDs for what the ADR calls "an XAUTOCLAIM
    // redelivery of a message that was already fully processed" — same logical
    // trigger (same responseId), different stream entry ids.
    const first = await runWorkflowsForEvent('o1', 'survey.response_filtered', { responseId: 'r1' }, 'stream-100');
    const second = await runWorkflowsForEvent('o1', 'survey.response_filtered', { responseId: 'r1' }, 'stream-200-redelivered');

    expect(first).toHaveLength(1);   // first delivery actually executed
    expect(second).toHaveLength(0);  // redelivery filtered out as a duplicate, not pushed as null

    const insertCalls = dbQuery.mock.calls.filter(([text]) => text.startsWith('INSERT INTO workflow_executions'));
    expect(insertCalls).toHaveLength(2); // both INSERTs attempted...
    // ...but only ONE actually created a row (the idempotency key was identical for both,
    // since it's derived from responseId, not the stream entry id).
    expect(insertCalls[0][1][4]).toBe(insertCalls[1][1][4]);
    expect(insertCalls[0][1][4]).toBe('o1:w1:survey.response_filtered:r1');

    // Exactly ONE side effect (one notification), not two.
    expect(createNotificationMock).toHaveBeenCalledTimes(1);
  });
});

// ── 4. Retry sweep correctness: republish clears next_retry_at, second sweep doesn't re-fire ──
describe('retry sweep correctness across two consecutive sweep calls', () => {
  it('a second sweepDueRetries call does not republish the same execution after next_retry_at was cleared', async () => {
    const xadd = vi.fn(async () => '30-0');
    redisClient = { status: 'ready', xadd };

    // Model a single mutable row so the second sweep call sees the effect of the
    // first sweep's `UPDATE ... SET next_retry_at = NULL` (this is the exact bug
    // shape the ADR calls out: a same-row double-republish before the retried
    // attempt re-stamps it).
    const row = { id: 'e1', workflow_id: 'w1', org_id: 'o1', trigger_type: 'score.nps_drop', trigger_payload: { nps: 3 }, attempt_count: 1, next_retry_at: '2026-07-01T00:00:00Z' };

    dbQuery = vi.fn(async (text, params) => {
      if (text.includes('SET dead_letter = TRUE')) return { rows: [] };
      if (text.includes('SELECT id, workflow_id, org_id, trigger_type, trigger_payload, attempt_count')) {
        return row.next_retry_at ? { rows: [{ ...row }] } : { rows: [] };
      }
      if (text.includes('SET next_retry_at = NULL')) {
        expect(params[0]).toBe('e1');
        row.next_retry_at = null; // simulate the real UPDATE clearing the column
        return { rows: [] };
      }
      return { rows: [] };
    });

    const { sweepDueRetries } = loadQueue(vi.fn());
    const now = new Date('2026-07-01T00:05:00Z');

    const first = await sweepDueRetries(now);
    expect(first.republished).toBe(1);
    expect(xadd).toHaveBeenCalledTimes(1);

    const second = await sweepDueRetries(now); // same instant, called again immediately
    expect(second.republished).toBe(0); // next_retry_at was cleared — row no longer "due"
    expect(xadd).toHaveBeenCalledTimes(1); // still only ever published once
  });
});

// ── 5. Partial action failure recovery: action 2 of 3 fails ─────────────────
describe('partial action failure (no rollback semantics — documents actual runNodes behavior)', () => {
  it('action 1 completes, action 2 fails, action 3 is never attempted; execution status is failed', async () => {
    const stepLog = [];
    dbQuery = vi.fn(async (text, params) => {
      if (text.startsWith('INSERT INTO workflow_executions')) return { rows: [{ id: 'exec-1' }] };
      if (text.startsWith('INSERT INTO workflow_step_executions')) {
        // (execution_id, node_id, node_type, status, output, error_message)
        stepLog.push({ nodeId: params[1], status: params[3] });
        return { rows: [] };
      }
      return { rows: [] };
    });
    // action 2 uses notify.webhook with no config.url -> would be 'skipped', so
    // instead force a hard failure via a thrown fetch for a webhook action, which
    // executeAction's catch converts to status: 'failed'.
    global.fetch = vi.fn(async () => { throw new Error('third-party unreachable'); });

    const wf = {
      id: 'w1',
      nodes: [
        { id: 't', type: 'trigger' },
        { id: 'a1', type: 'action', action: 'notify.in_app', config: { userIds: ['u1'] } },
        { id: 'a2', type: 'action', action: 'notify.webhook', config: { url: 'https://third-party.test/hook' } },
        { id: 'a3', type: 'action', action: 'notify.slack', config: {} },
      ],
    };
    const { runWorkflow } = loadEngine();
    const r = await runWorkflow(wf, { userId: 'u1' }, { orgId: 'o1' });

    expect(r.status).toBe('failed');
    // Action 1's effect (notification) already happened and is NOT rolled back —
    // this engine has no transactional multi-action semantics. That is the real,
    // confirmed behavior of runNodes (see workflowEngine.ts: a 'failed' action
    // result short-circuits the loop via `return`, but nothing undoes prior
    // completed steps).
    expect(createNotificationMock).toHaveBeenCalledTimes(1);
    // Action 3 (slack) must never be attempted once action 2 fails.
    expect(sendSlackMock).not.toHaveBeenCalled();

    // Step-execution log shows exactly: a1 completed, a2 failed, a3 absent.
    expect(stepLog).toEqual([
      { nodeId: 'a1', status: 'completed' },
      { nodeId: 'a2', status: 'failed' },
    ]);
    expect(stepLog.find((s) => s.nodeId === 'a3')).toBeUndefined();
  });

  it('same partial-failure short-circuit holds for graph (branching) workflows via runGraph', async () => {
    const stepLog = [];
    dbQuery = vi.fn(async (text, params) => {
      if (text.startsWith('INSERT INTO workflow_executions')) return { rows: [{ id: 'exec-1' }] };
      if (text.startsWith('INSERT INTO workflow_step_executions')) {
        stepLog.push({ nodeId: params[1], status: params[3] });
        return { rows: [] };
      }
      return { rows: [] };
    });
    global.fetch = vi.fn(async () => { throw new Error('third-party unreachable'); });

    const graphWf = {
      id: 'w2',
      nodes: [
        { id: 't', type: 'trigger' },
        { id: 'a1', type: 'action', action: 'notify.in_app', config: { userIds: ['u1'] } },
        { id: 'a2', type: 'action', action: 'notify.webhook', config: { url: 'https://third-party.test/hook' } },
        { id: 'a3', type: 'action', action: 'notify.slack', config: {} },
      ],
      edges: [
        { from: 't', to: 'a1' },
        { from: 'a1', to: 'a2' },
        { from: 'a2', to: 'a3' },
        { from: 'a2', to: 'a3', branch: 'true' }, // marks graph mode (isGraphWorkflow checks for a branch edge)
      ],
    };
    const { runWorkflow } = loadEngine();
    const r = await runWorkflow(graphWf, { userId: 'u1' }, { orgId: 'o1' });

    expect(r.status).toBe('failed');
    expect(createNotificationMock).toHaveBeenCalledTimes(1); // a1 ran, not rolled back
    expect(sendSlackMock).not.toHaveBeenCalled();             // a3 never attempted
    expect(stepLog.map((s) => s.nodeId)).toEqual(['a1', 'a2']);
  });
});

// ── 6. Concurrent execution safety: two "simultaneous" runWorkflow calls, same idempotency key ──
describe('concurrent execution safety (shared idempotency key, only one INSERT wins)', () => {
  const wf = { id: 'w1', nodes: [{ id: 'a1', type: 'action', action: 'notify.in_app', config: { userIds: ['u1'] } }] };

  it('Promise.all of two runWorkflow calls with the same idempotency key: only one executes actions', async () => {
    // Model the ON CONFLICT DO NOTHING race: the mock DB only allows the FIRST
    // INSERT for a given idempotency_key to "win" (return a row); every
    // subsequent concurrent INSERT for the same key returns no row, exactly like
    // a real unique-index conflict under concurrent writers.
    let winnerClaimed = false;
    dbQuery = vi.fn(async (text) => {
      if (text.startsWith('INSERT INTO workflow_executions')) {
        if (winnerClaimed) return { rows: [] };
        winnerClaimed = true;
        return { rows: [{ id: 'exec-1' }] };
      }
      return { rows: [] };
    });
    const { runWorkflow } = loadEngine();

    const key = 'o1:w1:score.nps_drop:r1';
    const [resA, resB] = await Promise.all([
      runWorkflow(wf, { userId: 'u1' }, { orgId: 'o1', idempotencyKey: key }),
      runWorkflow(wf, { userId: 'u1' }, { orgId: 'o1', idempotencyKey: key }),
    ]);

    const results = [resA, resB];
    const executed = results.filter((r) => r !== null);
    const deduped = results.filter((r) => r === null);
    expect(executed).toHaveLength(1);
    expect(deduped).toHaveLength(1);
    // Exactly one side effect fired — no double-charge-shaped bug (ADR §3 chaos scenario).
    expect(createNotificationMock).toHaveBeenCalledTimes(1);
  });
});

// ── 7. Third-party timeout: a live connector under a hanging/rejecting fetch ──
describe('third-party timeout does not crash the process (surfaces as failed status)', () => {
  it('zendesk.create_ticket surfaces a fetch rejection (simulated timeout) as a failed ActionResult, not an unhandled rejection', async () => {
    process.env.ZENDESK_SUBDOMAIN = 'acme';
    process.env.ZENDESK_EMAIL = 'agent@acme.com';
    process.env.ZENDESK_API_TOKEN = 'tok-123';

    // Simulate a hung/timed-out third party: fetch's returned promise rejects
    // with an AbortError-shaped error, as it would from an AbortController-based
    // timeout wrapper. We assert this resolves to a normal return value, not a
    // thrown/unhandled rejection that would crash the event loop.
    const timeoutError = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    global.fetch = vi.fn(async () => { throw timeoutError; });

    const { executeAction } = loadEngine();
    let threw = false;
    let result;
    try {
      result = await executeAction(
        { type: 'action', action: 'zendesk.create_ticket', config: {} },
        { orgId: 'o1', workflowId: 'w1', event: { title: 'Timeout scenario' }, vars: {} }
      );
    } catch {
      threw = true;
    }

    expect(threw).toBe(false); // executeAction must never throw for a connector-level failure
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/aborted/i);

    delete process.env.ZENDESK_SUBDOMAIN;
    delete process.env.ZENDESK_EMAIL;
    delete process.env.ZENDESK_API_TOKEN;
  });

  it('a full runWorkflow through a hanging third-party webhook action finalizes as failed, not a rejected promise', async () => {
    global.fetch = vi.fn(async () => { throw Object.assign(new Error('timeout'), { name: 'AbortError' }); });
    dbQuery = vi.fn(async (text) => {
      if (text.startsWith('INSERT INTO workflow_executions')) return { rows: [{ id: 'exec-1' }] };
      if (text.startsWith('SELECT attempt_count')) return { rows: [{ attempt_count: 0 }] };
      return { rows: [] };
    });
    const wf = { id: 'w1', nodes: [{ id: 'a1', type: 'action', action: 'notify.webhook', config: { url: 'https://slow-third-party.test/hook' } }] };
    const { runWorkflow } = loadEngine();

    // runWorkflow itself must resolve (not reject) even though the underlying
    // connector's fetch rejected — the engine's job is to convert that into a
    // 'failed' execution status the retry/DLQ machinery can act on.
    await expect(runWorkflow(wf, {}, { orgId: 'o1' })).resolves.toEqual(
      expect.objectContaining({ status: 'failed' })
    );
  });

  it('workflowQueue.handleTrigger path (via processBatch) survives a downstream timeout without throwing out of the batch', async () => {
    // Exercises the queue-level isolation: even if runWorkflowsForEvent's engine
    // work throws all the way up (e.g. a DB lookup failure caused by a hung
    // downstream call), processBatch must still ACK and continue, per the
    // "no poison-message loop" contract already asserted for generic errors in
    // workflowQueue.test.js. Here we specifically use a timeout-shaped rejection.
    const runWorkflowsForEventMock = vi.fn(async () => {
      throw Object.assign(new Error('upstream timeout'), { name: 'AbortError' });
    });
    const xack = vi.fn(async () => 1);
    redisClient = {
      status: 'ready', xack,
      xreadgroup: vi.fn(async () => ([
        ['workflow:triggers', [['50-0', ['org_id', 'o1', 'trigger_type', 'x', 'event', '{}']]]],
      ])),
    };
    const { processBatch } = loadQueue(runWorkflowsForEventMock);
    const handled = await processBatch(redisClient, 'c1', { block: 0 });
    expect(handled).toBe(1);
    expect(xack).toHaveBeenCalledWith('workflow:triggers', 'workflow-processor', '50-0');
  });
});

// ── Regression: 4 bugs found by Kenji's chaos pass, fixed by Priya 2026-07-01 ──
// (see docs/automation-hub/RUNBOOKS.md §1 and §3 "root-cause follow-up" for the
// original characterization of each; Nina separately fixed a 5th bug — the
// retry-sweep idempotency-key collision — directly in finalizeExecution, not
// covered here since it's not one of Kenji's 4).

// ── Bug 1: no connector-level fetch timeouts ─────────────────────────────────
describe('bug 1: outbound fetch calls are bounded by an AbortSignal timeout', () => {
  it('connectors.ts exports a named, tunable CONNECTOR_FETCH_TIMEOUT_MS constant', async () => {
    _require.cache[CREDS_PATH] = fakeMod(CREDS_PATH, { getCredentials: vi.fn(async () => null) });
    delete _require.cache[CONN_PATH];
    const { CONNECTOR_FETCH_TIMEOUT_MS } = _require(CONN_PATH);
    expect(CONNECTOR_FETCH_TIMEOUT_MS).toBe(10_000);
  });

  it('jiraCreateIssue passes an AbortSignal to fetch (would bound a hung TCP connection)', async () => {
    process.env.JIRA_BASE_URL = 'https://jira.test';
    process.env.JIRA_EMAIL = 'a@b.com';
    process.env.JIRA_API_TOKEN = 'tok';
    process.env.JIRA_PROJECT_KEY = 'X';
    _require.cache[CREDS_PATH] = fakeMod(CREDS_PATH, { getCredentials: vi.fn(async () => null) });
    delete _require.cache[CONN_PATH];
    const { jiraCreateIssue } = _require(CONN_PATH);

    const fetchMock = vi.fn(async () => ({ ok: true, status: 201, json: async () => ({ key: 'X-1' }) }));
    vi.stubGlobal('fetch', fetchMock);

    await jiraCreateIssue({}, { orgId: 'o1', event: {}, vars: {} });
    expect(fetchMock).toHaveBeenCalled();
    const [, init] = fetchMock.mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);

    delete process.env.JIRA_BASE_URL; delete process.env.JIRA_EMAIL;
    delete process.env.JIRA_API_TOKEN; delete process.env.JIRA_PROJECT_KEY;
  });

  it('notify.webhook (workflowEngine.ts) passes an AbortSignal to fetch using the same shared timeout', async () => {
    _require.cache[CREDS_PATH] = fakeMod(CREDS_PATH, { getCredentials: vi.fn(async () => null) });
    const { executeAction } = loadEngine();

    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await executeAction(
      { type: 'action', action: 'notify.webhook', config: { url: 'https://x.test/hook' } },
      { orgId: 'o1', workflowId: 'w1', event: {}, vars: {} }
    );
    expect(fetchMock).toHaveBeenCalled();
    const [, init] = fetchMock.mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('a real AbortSignal.timeout(1) firing surfaces as a failed ActionResult, not a hang or crash', async () => {
    _require.cache[CREDS_PATH] = fakeMod(CREDS_PATH, { getCredentials: vi.fn(async () => null) });
    const { executeAction } = loadEngine();

    // Simulate what a real hung connection looks like once AbortSignal.timeout
    // actually fires: fetch's promise rejects with a DOMException/AbortError.
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new DOMException('This operation was aborted', 'TimeoutError');
    }));

    const result = await executeAction(
      { type: 'action', action: 'notify.webhook', config: { url: 'https://slow.test/hook' } },
      { orgId: 'o1', workflowId: 'w1', event: {}, vars: {} }
    );
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/aborted/i);
  });
});

// ── Bug 2: logStep failures must not affect the action's own success/failure ─
describe('bug 2: a logStep (step-audit) DB failure does not mis-record a successful action as failed', () => {
  it('runNodes: action completes successfully even when its own step-log INSERT throws', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.startsWith('INSERT INTO workflow_executions')) return { rows: [{ id: 'exec-1' }] };
      if (text.startsWith('INSERT INTO workflow_step_executions')) throw new Error('Postgres write failure (transient)');
      return { rows: [] };
    });
    const { runWorkflow } = loadEngine();
    const wf = { id: 'w1', nodes: [{ id: 'a1', type: 'action', action: 'notify.in_app', config: { userIds: ['u1'] } }] };

    const r = await runWorkflow(wf, { userId: 'u1' }, { orgId: 'o1' });

    // The action itself (createNotification) succeeded — a logging blip must not
    // retroactively turn this into a 'failed' execution and feed the retry path.
    expect(createNotificationMock).toHaveBeenCalledTimes(1);
    expect(r.status).toBe('completed');
  });

  it('runGraph: same guarantee holds for branching workflows', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.startsWith('INSERT INTO workflow_executions')) return { rows: [{ id: 'exec-1' }] };
      if (text.startsWith('INSERT INTO workflow_step_executions')) throw new Error('Postgres write failure (transient)');
      return { rows: [] };
    });
    const { runWorkflow } = loadEngine();
    const graphWf = {
      id: 'w1',
      nodes: [
        { id: 't', type: 'trigger' },
        { id: 'c', type: 'condition', conditions: { rules: [{ field: 'nps', op: 'lte', value: 6 }] } },
        { id: 'a1', type: 'action', action: 'notify.in_app', config: { userIds: ['u1'] } },
      ],
      edges: [{ from: 't', to: 'c' }, { from: 'c', to: 'a1', branch: 'true' }],
    };

    const r = await runWorkflow(graphWf, { nps: 3 }, { orgId: 'o1' });

    expect(createNotificationMock).toHaveBeenCalledTimes(1);
    expect(r.status).toBe('completed');
  });

  it('a genuine action failure is still correctly reported as failed (logStep fix does not mask real failures)', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.startsWith('INSERT INTO workflow_executions')) return { rows: [{ id: 'exec-1' }] };
      if (text.startsWith('SELECT attempt_count')) return { rows: [{ attempt_count: 0 }] };
      if (text.startsWith('INSERT INTO workflow_step_executions')) throw new Error('Postgres write failure (transient)');
      return { rows: [] };
    });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    const { runWorkflow } = loadEngine();
    const wf = { id: 'w1', nodes: [{ id: 'a1', type: 'action', action: 'notify.webhook', config: { url: 'https://x.test' } }] };

    const r = await runWorkflow(wf, {}, { orgId: 'o1' });
    expect(r.status).toBe('failed'); // the action really did fail — not masked
  });
});

// ── Bug 3: no reaper for rows stuck in 'executing' ───────────────────────────
describe('bug 3: reapStuckExecutions transitions stale executing rows into the retry/DLQ path', () => {
  it('force-fails a row stuck in executing past EXECUTING_TIMEOUT_MIN, stamping attempt_count/next_retry_at', async () => {
    const stuckRow = { id: 'exec-stuck', workflow_id: 'w1', attempt_count: 0 };
    dbQuery = vi.fn(async (text) => {
      if (text.includes("status = 'executing'")) return { rows: [stuckRow] };
      return { rows: [] };
    });
    const { reapStuckExecutions, EXECUTING_TIMEOUT_MIN } = loadQueue(vi.fn());
    expect(EXECUTING_TIMEOUT_MIN).toBe(5);

    const reaped = await reapStuckExecutions(new Date());
    expect(reaped).toBe(1);

    const updateCall = dbQuery.mock.calls.find(([text]) => text.includes("SET status = 'failed'"));
    expect(updateCall).toBeTruthy();
    const [, params] = updateCall;
    const [execId, attempt, nextRetryAt, deadLetter] = params;
    expect(execId).toBe('exec-stuck');
    expect(attempt).toBe(1);
    expect(deadLetter).toBe(false);
    expect(nextRetryAt).not.toBeNull();
  });

  it('dead-letters a stuck row that has already exhausted MAX_ATTEMPTS', async () => {
    const stuckRow = { id: 'exec-stuck', workflow_id: 'w1', attempt_count: 4 }; // 5th attempt = MAX_ATTEMPTS
    dbQuery = vi.fn(async (text) => {
      if (text.includes("status = 'executing'")) return { rows: [stuckRow] };
      return { rows: [] };
    });
    const { reapStuckExecutions } = loadQueue(vi.fn());
    await reapStuckExecutions(new Date());

    const updateCall = dbQuery.mock.calls.find(([text]) => text.includes("SET status = 'failed'"));
    const [, params] = updateCall;
    const [, attempt, nextRetryAt, deadLetter] = params;
    expect(attempt).toBe(5);
    expect(deadLetter).toBe(true);
    expect(nextRetryAt).toBeNull();
  });

  it('the SELECT filters on the configured cutoff (does not touch recently-started executions)', async () => {
    dbQuery = vi.fn(async (text, params) => {
      if (text.includes("status = 'executing'")) {
        // Second param is the cutoff timestamp — assert it is indeed in the past
        // relative to `now` by roughly EXECUTING_TIMEOUT_MIN minutes.
        expect(new Date(params[0]).getTime()).toBeLessThan(Date.now());
        return { rows: [] };
      }
      return { rows: [] };
    });
    const { reapStuckExecutions } = loadQueue(vi.fn());
    const reaped = await reapStuckExecutions(new Date());
    expect(reaped).toBe(0);
  });

  it('a reap failure for one row does not prevent other stuck rows from being reaped', async () => {
    const rows = [
      { id: 'exec-bad', workflow_id: 'w1', attempt_count: 0 },
      { id: 'exec-good', workflow_id: 'w1', attempt_count: 0 },
    ];
    dbQuery = vi.fn(async (text, params) => {
      if (text.includes("status = 'executing'") && !text.startsWith('UPDATE')) return { rows };
      if (text.startsWith('UPDATE') && params?.[0] === 'exec-bad') throw new Error('write conflict');
      return { rows: [] };
    });
    const { reapStuckExecutions } = loadQueue(vi.fn());
    const reaped = await reapStuckExecutions(new Date());
    expect(reaped).toBe(1); // only exec-good succeeded; exec-bad's failure was isolated
  });

  // Wave 11 disjointness regression (Priya, DEEP_AUDIT_UX_FINDINGS.md W-1):
  // flow.delay introduces a second wait type ('waiting' + wait_reason='flow.delay'),
  // alongside the pre-existing flow.approval wait ('waiting' + wait_reason=
  // 'flow.approval'). reapStuckExecutions only ever matches status='executing' —
  // structurally distinct from 'waiting' — so it should be trivially unaffected
  // by either wait type. Asserted explicitly rather than assumed, per this
  // wave's safety framing.
  it("REGRESSION (Wave 11): the SELECT only ever matches status='executing' — a 'waiting' row (either wait_reason) is structurally never selected", async () => {
    let selectSql = null;
    dbQuery = vi.fn(async (text) => {
      if (text.includes("status = 'executing'") && !text.startsWith('UPDATE')) { selectSql = text; return { rows: [] }; }
      return { rows: [] };
    });
    const { reapStuckExecutions } = loadQueue(vi.fn());
    const reaped = await reapStuckExecutions(new Date());
    expect(reaped).toBe(0);
    expect(selectSql).toContain("status = 'executing'");
    expect(selectSql).not.toMatch(/waiting|wait_reason/);
  });
});

// ── Bug 4: sweepDueRetries's top-level queries aren't individually wrapped ──
describe('bug 4: sweepDueRetries isolates its two top-level queries from each other', () => {
  it('a DB error on the dead-letter UPDATE does not also suppress the due-retry republish pass', async () => {
    const xadd = vi.fn(async () => '60-0');
    redisClient = { status: 'ready', xadd };
    dbQuery = vi.fn(async (text) => {
      if (text.includes('SET dead_letter = TRUE')) throw new Error('DB blip on dead-letter query');
      if (text.includes('SELECT id, workflow_id, org_id, trigger_type, trigger_payload, attempt_count')) {
        return { rows: [{ id: 'e1', workflow_id: 'w1', org_id: 'o1', trigger_type: 't', trigger_payload: {}, attempt_count: 1 }] };
      }
      return { rows: [] };
    });
    const { sweepDueRetries } = loadQueue(vi.fn());
    const result = await sweepDueRetries(new Date());

    // The due-retry republish still ran and succeeded despite the dead-letter
    // query throwing — previously an unwrapped throw here would abort the whole
    // function and skip republishing entirely.
    expect(result.republished).toBe(1);
    expect(xadd).toHaveBeenCalledTimes(1);
    expect(result.deadLettered).toBe(0); // that query failed, so 0 — but didn't crash the tick
  });

  it('a DB error on the due-retry SELECT does not also suppress the dead-letter pass', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('SET dead_letter = TRUE')) {
        return { rows: [{ id: 'e-exhausted', workflow_id: 'w1', org_id: 'o1', trigger_type: 't', trigger_payload: {} }] };
      }
      if (text.includes('SELECT id, workflow_id, org_id, trigger_type, trigger_payload, attempt_count')) {
        throw new Error('DB blip on due-retry query');
      }
      return { rows: [] };
    });
    const { sweepDueRetries } = loadQueue(vi.fn());
    const result = await sweepDueRetries(new Date());

    // Dead-lettering still completed despite the due-retry SELECT throwing.
    expect(result.deadLettered).toBe(1);
    expect(result.republished).toBe(0); // that query failed, so 0 — but didn't crash the tick
  });

  it('sweepDueRetries never throws even when both top-level queries fail (next tick retries safely)', async () => {
    dbQuery = vi.fn(async () => { throw new Error('Postgres is down'); });
    const { sweepDueRetries } = loadQueue(vi.fn());
    await expect(sweepDueRetries(new Date())).resolves.toEqual({ republished: 0, deadLettered: 0 });
  });
});
