/**
 * Tests for the scheduler service (src/scheduler/*).
 * Verifies due-job selection, per-job run isolation (success/failure), and the
 * expire-stale-broadcasts job. DB + logger are injected; metrics use the real registry.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);

const DB_PATH       = _require.resolve(resolve(__dirname, '../lib/db'));
const LOGGER_PATH   = _require.resolve(resolve(__dirname, '../lib/logger'));
const NOTIF_PATH    = _require.resolve(resolve(__dirname, '../lib/notifications'));
const RUNNER_PATH   = _require.resolve(resolve(__dirname, '../scheduler/runner'));
const LEADER_PATH   = _require.resolve(resolve(__dirname, '../scheduler/leader'));
const EXPIRE_PATH   = _require.resolve(resolve(__dirname, '../scheduler/jobs/expireStaleBroadcasts'));
const RECON_PATH    = _require.resolve(resolve(__dirname, '../scheduler/jobs/reconciliation'));
const COSTDOWN_PATH = _require.resolve(resolve(__dirname, '../scheduler/jobs/costDownDividend'));
const LEDGER_MAINT_PATH = _require.resolve(resolve(__dirname, '../scheduler/jobs/creditLedgerMaintenance'));
const CRED_HEALTH_PATH  = _require.resolve(resolve(__dirname, '../scheduler/jobs/credentialHealth'));
const RENOTIFY_PATH     = _require.resolve(resolve(__dirname, '../scheduler/jobs/reNotifyStaleApprovals'));
const RESUME_DELAY_PATH = _require.resolve(resolve(__dirname, '../scheduler/jobs/resumeDelayedExecutions'));
const ENGINE_PATH       = _require.resolve(resolve(__dirname, '../lib/workflowEngine'));
const PAYMENTS_PATH     = _require.resolve(resolve(__dirname, '../lib/payments'));
const REGISTRY_PATH = _require.resolve(resolve(__dirname, '../scheduler/registry'));

function fakeMod(id, exports) { return { id, filename: id, loaded: true, exports, children: [] }; }

let dbQuery, clientQuery, createNotificationMock;

function injectDeps() {
  const client = { query: (...a) => clientQuery(...a), release: vi.fn() };
  const pool = { connect: vi.fn(async () => client) };
  _require.cache[DB_PATH] = fakeMod(DB_PATH, { query: dbQuery, pool, default: { query: dbQuery, pool } });
  _require.cache[LOGGER_PATH] = fakeMod(LOGGER_PATH, {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  });
  _require.cache[NOTIF_PATH] = fakeMod(NOTIF_PATH, { createNotification: createNotificationMock });
}

function loadRunner()  { injectDeps(); delete _require.cache[RUNNER_PATH];   return _require(RUNNER_PATH); }
function loadLeader()  { injectDeps(); delete _require.cache[LEADER_PATH];   return _require(LEADER_PATH); }
function loadExpire()  { injectDeps(); delete _require.cache[EXPIRE_PATH];   return _require(EXPIRE_PATH); }
function loadRecon()   { injectDeps(); delete _require.cache[RECON_PATH];    return _require(RECON_PATH); }
function loadCostDown(){ injectDeps(); delete _require.cache[COSTDOWN_PATH]; return _require(COSTDOWN_PATH); }
function loadLedgerMaint(){ injectDeps(); delete _require.cache[LEDGER_MAINT_PATH]; return _require(LEDGER_MAINT_PATH); }
function loadCredHealth(){ injectDeps(); delete _require.cache[CRED_HEALTH_PATH]; return _require(CRED_HEALTH_PATH); }
function loadReNotify(){ injectDeps(); delete _require.cache[RENOTIFY_PATH]; return _require(RENOTIFY_PATH); }

let resumeDelayedExecutionMock;
function loadResumeDelayed() {
  injectDeps();
  _require.cache[ENGINE_PATH] = fakeMod(ENGINE_PATH, { resumeDelayedExecution: resumeDelayedExecutionMock });
  delete _require.cache[RESUME_DELAY_PATH];
  return _require(RESUME_DELAY_PATH);
}

beforeEach(() => {
  dbQuery = vi.fn(async () => ({ rows: [] }));
  clientQuery = vi.fn(async () => ({ rows: [{ locked: false }] }));
  createNotificationMock = vi.fn(async () => ({ id: 'n1' }));
  resumeDelayedExecutionMock = vi.fn(async () => ({ status: 'completed' }));
});
afterAll(() => {
  for (const p of [DB_PATH, LOGGER_PATH, NOTIF_PATH, RUNNER_PATH, LEADER_PATH, EXPIRE_PATH, RECON_PATH, COSTDOWN_PATH, LEDGER_MAINT_PATH, CRED_HEALTH_PATH, RENOTIFY_PATH, RESUME_DELAY_PATH, ENGINE_PATH, PAYMENTS_PATH, REGISTRY_PATH]) {
    delete _require.cache[p];
  }
});

describe('dueJobs', () => {
  it('selects enabled jobs whose interval has elapsed', () => {
    const { dueJobs } = loadRunner();
    const jobs = [
      { name: 'a', enabled: true,  intervalSec: 60, handler: async () => {} },
      { name: 'b', enabled: false, intervalSec: 60, handler: async () => {} },
      { name: 'c', enabled: true,  intervalSec: 60, handler: async () => {} },
    ];
    const now = 1_000_000;
    const last = { a: now - 61_000, c: now - 10_000 }; // a due, c not due, b disabled
    const due = dueJobs(jobs, last, now).map((j) => j.name);
    expect(due).toEqual(['a']);
  });

  it('treats a never-run job as due', () => {
    const { dueJobs } = loadRunner();
    const jobs = [{ name: 'x', enabled: true, intervalSec: 300, handler: async () => {} }];
    expect(dueJobs(jobs, {}, Date.now()).map((j) => j.name)).toEqual(['x']);
  });
});

describe('runJob', () => {
  it('returns success when the handler resolves', async () => {
    const { runJob } = loadRunner();
    const handler = vi.fn(async () => ({ affected: 2 }));
    const result = await runJob({ name: 'ok-job', enabled: true, intervalSec: 60, handler });
    expect(result).toBe('success');
    expect(handler).toHaveBeenCalled();
  });

  it('isolates failures — returns failure, does not throw', async () => {
    const { runJob } = loadRunner();
    const handler = vi.fn(async () => { throw new Error('boom'); });
    const result = await runJob({ name: 'bad-job', enabled: true, intervalSec: 60, handler });
    expect(result).toBe('failure');
  });
});

describe('expireStaleBroadcasts', () => {
  it('calls the DB function and returns the affected count', async () => {
    dbQuery = vi.fn(async () => ({ rows: [{ expire_stale_broadcasts: 3 }] }));
    const { expireStaleBroadcasts } = loadExpire();
    const res = await expireStaleBroadcasts();
    expect(res).toEqual({ affected: 3 });
    expect(dbQuery).toHaveBeenCalledWith(expect.stringContaining('expire_stale_broadcasts()'));
  });

  it('defaults to 0 when the function returns nothing', async () => {
    dbQuery = vi.fn(async () => ({ rows: [] }));
    const { expireStaleBroadcasts } = loadExpire();
    expect(await expireStaleBroadcasts()).toEqual({ affected: 0 });
  });
});

describe('reNotifyStaleApprovals — approval TTL (simple expiry + re-notify, never auto-reject)', () => {
  it('re-notifies the workflow owner for a pending approval past the threshold and stamps last_notified_at', async () => {
    const updates = [];
    dbQuery = vi.fn(async (text, params) => {
      if (text.includes('FROM workflow_approvals')) {
        return { rows: [{
          id: 'appr-1', execution_id: 'exec-1', org_id: 'o1', workflow_id: 'w1',
          requested_at: new Date(Date.now() - 80 * 3_600_000).toISOString(),
          notification_count: 0, workflow_name: 'NPS Drop Alert', created_by: 'u1',
        }] };
      }
      if (text.includes('UPDATE workflow_approvals')) { updates.push(params); return { rows: [] }; }
      return { rows: [] };
    });
    const { reNotifyStaleApprovals } = loadReNotify();
    const res = await reNotifyStaleApprovals();
    expect(res).toEqual({ affected: 1 });
    expect(createNotificationMock).toHaveBeenCalledTimes(1);
    const call = createNotificationMock.mock.calls[0][0];
    expect(call.orgId).toBe('o1');
    expect(call.userId).toBe('u1');
    expect(call.entityId).toBe('exec-1');
    expect(call.title).toContain('NPS Drop Alert');
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual(['appr-1']);
  });

  it('does not call createNotification when the approval has no workflow owner, but still stamps last_notified_at (so it is not re-queried forever)', async () => {
    const updates = [];
    dbQuery = vi.fn(async (text, params) => {
      if (text.includes('FROM workflow_approvals')) {
        return { rows: [{
          id: 'appr-2', execution_id: 'exec-2', org_id: 'o1', workflow_id: 'w2',
          requested_at: new Date(Date.now() - 80 * 3_600_000).toISOString(),
          notification_count: 1, workflow_name: 'Orphaned Workflow', created_by: null,
        }] };
      }
      if (text.includes('UPDATE workflow_approvals')) { updates.push(params); return { rows: [] }; }
      return { rows: [] };
    });
    const { reNotifyStaleApprovals } = loadReNotify();
    const res = await reNotifyStaleApprovals();
    expect(res).toEqual({ affected: 1 });
    expect(createNotificationMock).not.toHaveBeenCalled();
    expect(updates).toHaveLength(1);
  });

  it('never approves, rejects, or touches workflow_executions — only reads/updates workflow_approvals', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('FROM workflow_approvals')) {
        return { rows: [{
          id: 'appr-3', execution_id: 'exec-3', org_id: 'o1', workflow_id: 'w3',
          requested_at: new Date(Date.now() - 80 * 3_600_000).toISOString(),
          notification_count: 0, workflow_name: 'Refund Approval', created_by: 'u2',
        }] };
      }
      return { rows: [] };
    });
    const { reNotifyStaleApprovals } = loadReNotify();
    await reNotifyStaleApprovals();
    const allSql = dbQuery.mock.calls.map((c) => c[0]);
    expect(allSql.some((sql) => sql.includes('workflow_executions'))).toBe(false);
    expect(allSql.every((sql) => !/SET\s+status\s*=\s*'approved'|SET\s+status\s*=\s*'rejected'/i.test(sql))).toBe(true);
  });

  it('is a no-op when there are no stale pending approvals', async () => {
    dbQuery = vi.fn(async () => ({ rows: [] }));
    const { reNotifyStaleApprovals } = loadReNotify();
    expect(await reNotifyStaleApprovals()).toEqual({ affected: 0 });
    expect(createNotificationMock).not.toHaveBeenCalled();
  });

  it('the SQL predicate only selects status=pending rows past the (env-overridable) threshold', async () => {
    dbQuery = vi.fn(async () => ({ rows: [] }));
    const { reNotifyStaleApprovals } = loadReNotify();
    await reNotifyStaleApprovals();
    const [sql, params] = dbQuery.mock.calls[0];
    expect(sql).toContain("status = 'pending'");
    expect(sql).toContain('last_notified_at');
    expect(params).toEqual(['72']); // default WORKFLOW_APPROVAL_RENOTIFY_HOURS
  });

  // Wave 11 disjointness regression (Priya, DEEP_AUDIT_UX_FINDINGS.md W-1):
  // reNotifyStaleApprovals must never match/touch a flow.delay-type waiting
  // execution. Its query only ever reads workflow_approvals (status='pending')
  // — it never references workflow_executions.wait_reason at all — so a
  // flow.delay wait (which never creates a workflow_approvals row in the first
  // place, see workflowEngine.ts's persistPause) is structurally invisible to
  // this job. Asserted explicitly per this wave's "prove disjointness, don't
  // assume it" bar.
  it('REGRESSION (Wave 11): never queries workflow_executions or wait_reason — cannot match a flow.delay wait', async () => {
    dbQuery = vi.fn(async () => ({ rows: [] }));
    const { reNotifyStaleApprovals } = loadReNotify();
    await reNotifyStaleApprovals();
    const allSql = dbQuery.mock.calls.map((c) => c[0]);
    expect(allSql.every((sql) => !sql.includes('workflow_executions'))).toBe(true);
    expect(allSql.every((sql) => !sql.includes('wait_reason'))).toBe(true);
  });
});

describe('resumeDelayedExecutions job (Wave 11, DEEP_AUDIT_UX_FINDINGS.md W-1)', () => {
  it('finds due flow.delay waits and resumes each via workflowEngine.resumeDelayedExecution', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('FROM workflow_executions')) {
        return { rows: [{ id: 'exec-1' }, { id: 'exec-2' }] };
      }
      return { rows: [] };
    });
    const { resumeDelayedExecutions } = loadResumeDelayed();
    const res = await resumeDelayedExecutions();
    expect(res).toEqual({ affected: 2 });
    expect(resumeDelayedExecutionMock).toHaveBeenCalledTimes(2);
    expect(resumeDelayedExecutionMock).toHaveBeenCalledWith('exec-1');
    expect(resumeDelayedExecutionMock).toHaveBeenCalledWith('exec-2');
  });

  it('the SQL predicate only selects wait_reason=flow.delay waiting rows past resume_at', async () => {
    dbQuery = vi.fn(async () => ({ rows: [] }));
    const { resumeDelayedExecutions } = loadResumeDelayed();
    await resumeDelayedExecutions();
    const [sql] = dbQuery.mock.calls[0];
    expect(sql).toContain("status = 'waiting'");
    expect(sql).toContain("wait_reason = 'flow.delay'");
    expect(sql).toContain('resume_at');
  });

  it('is a no-op when there are no due delays', async () => {
    dbQuery = vi.fn(async () => ({ rows: [] }));
    const { resumeDelayedExecutions } = loadResumeDelayed();
    expect(await resumeDelayedExecutions()).toEqual({ affected: 0 });
    expect(resumeDelayedExecutionMock).not.toHaveBeenCalled();
  });

  it('does not count a row already claimed elsewhere (resumeDelayedExecution returns null) as affected', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('FROM workflow_executions')) return { rows: [{ id: 'exec-1' }] };
      return { rows: [] };
    });
    resumeDelayedExecutionMock = vi.fn(async () => null); // already claimed by another tick/replica
    const { resumeDelayedExecutions } = loadResumeDelayed();
    const res = await resumeDelayedExecutions();
    expect(res).toEqual({ affected: 0 });
  });

  it('isolates one execution\'s failure from the rest of the sweep', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('FROM workflow_executions')) return { rows: [{ id: 'exec-bad' }, { id: 'exec-good' }] };
      return { rows: [] };
    });
    resumeDelayedExecutionMock = vi.fn(async (id) => {
      if (id === 'exec-bad') throw new Error('boom');
      return { status: 'completed' };
    });
    const { resumeDelayedExecutions } = loadResumeDelayed();
    const res = await resumeDelayedExecutions();
    expect(res).toEqual({ affected: 1 }); // only exec-good counted
  });

  // Wave 11 disjointness regression: this job's query must never match/touch a
  // flow.approval-type waiting execution — the exact inverse of
  // reNotifyStaleApprovals' own scope.
  it('REGRESSION (Wave 11): the query explicitly scopes to wait_reason=flow.delay, never flow.approval', async () => {
    dbQuery = vi.fn(async () => ({ rows: [] }));
    const { resumeDelayedExecutions } = loadResumeDelayed();
    await resumeDelayedExecutions();
    const [sql] = dbQuery.mock.calls[0];
    expect(sql).not.toContain('flow.approval');
    expect(sql).toContain('flow.delay');
  });

  // ── Wave 11 Phase 3 (Kenji, fault-tolerance gate): crash-recovery / catch-up ──
  //
  // Scenario: the scheduler is down (deploy, crash, leader-election gap) for
  // longer than several tick intervals while flow.delay waits keep expiring.
  // Two distinct risks: (1) does the FIRST tick after recovery correctly find
  // and resume ALL of the backlog, not just the most-recently-due row or a
  // silently-truncated subset; (2) is there a bound on how much of that
  // backlog one tick will attempt synchronously, so an unusually large
  // backlog can't make a single tick run for an unbounded amount of time.
  it('a query with no LIMIT would try to load the entire backlog — this job caps it and orders oldest-due-first', async () => {
    dbQuery = vi.fn(async () => ({ rows: [] }));
    const { resumeDelayedExecutions } = loadResumeDelayed();
    await resumeDelayedExecutions();
    const [sql, params] = dbQuery.mock.calls[0];
    expect(sql).toMatch(/LIMIT \$1/);
    expect(sql).toMatch(/ORDER BY resume_at ASC/);
    expect(params).toEqual([200]); // DEFAULT batch size when unconfigured
  });

  it('the batch size is overridable via WORKFLOW_RESUME_DELAYED_BATCH_SIZE', async () => {
    dbQuery = vi.fn(async () => ({ rows: [] }));
    const prev = process.env.WORKFLOW_RESUME_DELAYED_BATCH_SIZE;
    process.env.WORKFLOW_RESUME_DELAYED_BATCH_SIZE = '5';
    try {
      const { resumeDelayedExecutions } = loadResumeDelayed();
      await resumeDelayedExecutions();
      const [, params] = dbQuery.mock.calls[0];
      expect(params).toEqual([5]);
    } finally {
      if (prev === undefined) delete process.env.WORKFLOW_RESUME_DELAYED_BATCH_SIZE;
      else process.env.WORKFLOW_RESUME_DELAYED_BATCH_SIZE = prev;
    }
  });

  it('MULTI-TICK BACKLOG: a backlog larger than one batch is fully, correctly drained across successive ticks — nothing dropped, nothing double-resumed', async () => {
    // Simulate a scheduler outage: 5 executions' resume_at all passed while it
    // was down, but the batch size (mocked to 2/tick) means one tick can only
    // claim 2 of them. Oldest-due-first ordering (see the query's ORDER BY)
    // means each tick drains from the front of the backlog.
    process.env.WORKFLOW_RESUME_DELAYED_BATCH_SIZE = '2';
    const backlog = ['exec-1', 'exec-2', 'exec-3', 'exec-4', 'exec-5']; // oldest-due-first order
    const resumedOrder = [];
    resumeDelayedExecutionMock = vi.fn(async (id) => {
      resumedOrder.push(id);
      return { status: 'completed' };
    });
    try {
      dbQuery = vi.fn(async (text, params) => {
        if (text.includes('FROM workflow_executions')) {
          const limit = params[0];
          // Models the real SQL: LIMIT caps how many of the remaining
          // (still-waiting) backlog rows this tick's SELECT returns.
          return { rows: backlog.slice(0, limit).map((id) => ({ id })) };
        }
        return { rows: [] };
      });

      // Tick 1: claims/resumes the first 2, "removing" them from the backlog
      // (mirrors the real UPDATE...RETURNING claim flipping status away from
      // 'waiting' so the next tick's SELECT no longer matches them).
      const { resumeDelayedExecutions } = loadResumeDelayed();
      const tick1 = await resumeDelayedExecutions();
      expect(tick1).toEqual({ affected: 2 });
      backlog.splice(0, 2);

      // Tick 2: same job, backlog now has 3 left, still capped at 2/tick.
      const tick2 = await resumeDelayedExecutions();
      expect(tick2).toEqual({ affected: 2 });
      backlog.splice(0, 2);

      // Tick 3: final straggler, well under the batch cap.
      const tick3 = await resumeDelayedExecutions();
      expect(tick3).toEqual({ affected: 1 });
      backlog.splice(0, 1);

      // Backlog fully drained, every execution resumed exactly once, in the
      // correct oldest-due-first order — no execution silently dropped, none
      // double-resumed across tick boundaries.
      expect(backlog).toHaveLength(0);
      expect(resumedOrder).toEqual(['exec-1', 'exec-2', 'exec-3', 'exec-4', 'exec-5']);
      expect(resumeDelayedExecutionMock).toHaveBeenCalledTimes(5);
    } finally {
      delete process.env.WORKFLOW_RESUME_DELAYED_BATCH_SIZE;
    }
  });
});

describe('leader election', () => {
  it('becomes leader when it acquires the advisory lock', async () => {
    clientQuery = vi.fn(async () => ({ rows: [{ locked: true }] }));
    const { ensureLeadership } = loadLeader();
    expect(await ensureLeadership()).toBe(true);
  });

  it('stands by when another instance holds the lock', async () => {
    clientQuery = vi.fn(async () => ({ rows: [{ locked: false }] }));
    const { ensureLeadership, currentlyLeader } = loadLeader();
    expect(await ensureLeadership()).toBe(false);
    expect(currentlyLeader()).toBe(false);
  });
});

describe('reconciliation job', () => {
  it('reports zero violations on a clean ledger', async () => {
    dbQuery = vi.fn(async () => ({ rows: [{ neg_allowance: '0', neg_pack: '0', over_allowance: '0', neg_overage: '0', total: '12' }] }));
    const { reconciliation } = loadRecon();
    const res = await reconciliation();
    expect(res.affected).toBe(0);
  });

  it('counts invariant violations', async () => {
    dbQuery = vi.fn(async () => ({ rows: [{ neg_allowance: '1', neg_pack: '0', over_allowance: '2', neg_overage: '0', total: '12' }] }));
    const { reconciliation } = loadRecon();
    const res = await reconciliation();
    expect(res.affected).toBe(3);
  });
});

describe('cost-down-dividend job', () => {
  it('computes COGS per credit and stays in dry-run', async () => {
    dbQuery = vi.fn(async () => ({ rows: [{ cost_usd: '10', credits: '1000' }] }));
    const { costDownDividend } = loadCostDown();
    const res = await costDownDividend();
    expect(res.note).toContain('cogs_per_credit=0.010000');
    expect(res.note).toContain('dry_run=true');
  });

  it('handles missing ai_operation_logs gracefully (0 COGS)', async () => {
    dbQuery = vi.fn(async () => { throw new Error('relation "ai_operation_logs" does not exist'); });
    const { costDownDividend } = loadCostDown();
    const res = await costDownDividend();
    expect(res.note).toContain('cogs_per_credit=0.000000');
  });
});

describe('credit-ledger-maintenance job', () => {
  it('provisions partitions ahead and applies retention', async () => {
    const calls = [];
    dbQuery = vi.fn(async (sql, params) => {
      calls.push(String(sql));
      if (String(sql).includes('drop_old_credit_ledger_partitions')) return { rows: [{ dropped: 2 }] };
      return { rows: [{}] };
    });
    const { creditLedgerMaintenance } = loadLedgerMaint();
    const res = await creditLedgerMaintenance();
    expect(res.affected).toBe(2);
    // three create_credit_ledger_partition calls + one retention call
    expect(calls.filter((s) => s.includes('create_credit_ledger_partition'))).toHaveLength(3);
    expect(calls.some((s) => s.includes('drop_old_credit_ledger_partitions'))).toBe(true);
  });
});

describe('credential-health job', () => {
  const probe = (integration, configured, result) => ({
    integration,
    configured: () => configured,
    check: typeof result === 'function' ? result : async () => result,
  });

  it('no-ops when no integrations are configured', async () => {
    const { credentialHealth } = loadCredHealth();
    const res = await credentialHealth([
      probe('stripe', false, { status: 'ok' }),
      probe('openrouter', false, { status: 'ok' }),
    ]);
    expect(res.affected).toBe(0);
    expect(res.note).toContain('no configured integrations');
  });

  it('counts only configured probes and reports invalid ones', async () => {
    const { credentialHealth } = loadCredHealth();
    const res = await credentialHealth([
      probe('stripe', true, { status: 'ok' }),
      probe('openrouter', true, { status: 'invalid', detail: 'HTTP 401' }),
      probe('clerk', false, { status: 'ok' }), // not configured → skipped
    ]);
    expect(res.affected).toBe(1);
    expect(res.note).toContain('probed 2 integration(s)');
  });

  it('treats a thrown probe (network error) as invalid', async () => {
    const { credentialHealth } = loadCredHealth();
    const res = await credentialHealth([
      probe('stripe', true, async () => { throw new Error('ECONNRESET'); }),
    ]);
    expect(res.affected).toBe(1);
  });

  it('counts provider errors (non-200, non-auth) as affected', async () => {
    const { credentialHealth } = loadCredHealth();
    const res = await credentialHealth([
      probe('openrouter', true, { status: 'error', detail: 'HTTP 503' }),
      probe('stripe', true, { status: 'ok' }),
    ]);
    expect(res.affected).toBe(1);
    expect(res.note).toContain('probed 2 integration(s)');
  });

  it('records days-to-expiry without counting a valid key as invalid', async () => {
    const { credentialHealth } = loadCredHealth();
    const soon = new Date(Date.now() + 3 * 86_400_000); // expires in 3 days
    const res = await credentialHealth([
      probe('stripe', true, { status: 'ok', expiresAt: soon }),
    ]);
    expect(res.affected).toBe(0); // valid even though expiring soon (alert fires off the gauge)
  });

  it('DEFAULT_PROBES skips stripe when the payments rail is not operational', () => {
    injectDeps();
    _require.cache[PAYMENTS_PATH] = fakeMod(PAYMENTS_PATH, { isStripeConfigured: () => false });
    delete _require.cache[CRED_HEALTH_PATH];
    const { DEFAULT_PROBES } = _require(CRED_HEALTH_PATH);
    const stripe = DEFAULT_PROBES.find((p) => p.integration === 'stripe');
    expect(stripe.configured()).toBe(false);
    delete _require.cache[PAYMENTS_PATH];
    delete _require.cache[CRED_HEALTH_PATH];
  });
});
