/**
 * Tests for the Crystal action proposal outcome-tracking routes in routes/insights.ts
 *
 *   POST /api/insights/:surveyId/crystal/proposals  — UPSERT proposal outcome
 *   GET  /api/insights/:surveyId/crystal/proposals  — list recent proposals
 *
 * Uses the fakeMod/cache-injection pattern (see survey-groups.test.js) so no real
 * DB or agents service connection is needed. The router is mounted at /api/insights
 * per index.ts convention.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import inject from 'light-my-request';
import express from 'express';

const __dirname = dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);

const AUTH_PATH   = _require.resolve(resolve(__dirname, '../middleware/auth'));
const DB_PATH     = _require.resolve(resolve(__dirname, '../lib/db'));
const AGENTS_PATH = _require.resolve(resolve(__dirname, '../lib/agentsClient'));
const LOGGER_PATH = _require.resolve(resolve(__dirname, '../lib/logger'));
const ROUTER_PATH = _require.resolve(resolve(__dirname, '../routes/insights'));

let dbQuery;

function fakeMod(id, exports) {
  return { id, filename: id, loaded: true, exports, children: [] };
}

function buildApp() {
  _require.cache[AUTH_PATH] = fakeMod(AUTH_PATH, {
    requireAuth: (req, res, next) => {
      req.orgId  = 'o1';
      req.userId = 'u1';
      next();
    },
  });
  _require.cache[DB_PATH] = fakeMod(DB_PATH, {
    query: dbQuery,
    default: { query: dbQuery },
  });
  _require.cache[AGENTS_PATH] = fakeMod(AGENTS_PATH, {
    triggerInsightGeneration: vi.fn(async () => {}),
    default: { triggerInsightGeneration: vi.fn(async () => {}) },
  });
  _require.cache[LOGGER_PATH] = fakeMod(LOGGER_PATH, {
    info:  vi.fn(),
    warn:  vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  });

  delete _require.cache[ROUTER_PATH];
  const router = _require(ROUTER_PATH);
  const app = express();
  app.use(express.json());
  app.use('/api/insights', router.default || router);
  return app;
}

// Simulates the real Postgres upsert contract of the fixed INSERT ... ON CONFLICT
// (org_id, survey_id, proposal_key) DO UPDATE in routes/insights.ts, so the tests
// below exercise the actual lifecycle-guard *behaviour* — not just the SQL text —
// without needing a live database. Keyed by (org_id, survey_id, proposal_key),
// matching the new partial unique index (migration 20260806000001).
function makeFakeProposalsStore() {
  const TERMINAL = new Set(['succeeded', 'failed', 'dismissed']);
  const rowsByKey = new Map();
  let nextId = 1;

  return vi.fn(async (sql, params) => {
    if (!sql.includes('crystal_action_proposals') || !sql.includes('INSERT INTO')) {
      return { rows: [] };
    }
    const [orgId, brandId, surveyId, proposalKey, type, , priority, businessRationale, confidence, status, outcomeRef, errorDetail] = params;
    const key = `${orgId}|${surveyId}|${proposalKey}`;
    const existing = rowsByKey.get(key);

    if (!existing) {
      const row = {
        id: `p-${nextId++}`,
        org_id: orgId,
        brand_id: brandId,
        survey_id: surveyId,
        proposal_key: proposalKey,
        type,
        priority,
        business_rationale: businessRationale,
        confidence,
        status,
        outcome_ref: outcomeRef,
        error_detail: errorDetail,
        emitted_at: '2026-08-06T00:00:00.000Z',
        updated_at: '2026-08-06T00:00:00.000Z',
      };
      rowsByKey.set(key, row);
      return { rows: [row] };
    }

    // Lifecycle guard: a terminal status is never regressed by a non-terminal one.
    const blocked = TERMINAL.has(existing.status) && !TERMINAL.has(status);
    const merged = blocked
      ? existing
      : {
          ...existing,
          status,
          outcome_ref: outcomeRef ?? existing.outcome_ref,
          error_detail: errorDetail,
          updated_at: '2026-08-06T00:05:00.000Z',
        };
    rowsByKey.set(key, merged);
    return { rows: [merged] };
  });
}

describe('POST /api/insights/:surveyId/crystal/proposals', () => {
  beforeEach(() => {
    dbQuery = vi.fn();
  });

  // G1 funnel fix (2026-08-06, docs/assistant-ui-migration/MIGRATION_PLAN.md §4
  // item 4 / §6). Replaces the test that used to pin the defect: the conflict
  // target now includes survey_id, so the same proposal_key on two different
  // surveys in one org no longer collapses onto a single row.
  it('scopes the upsert to (org_id, survey_id, proposal_key) — same proposalKey on two surveys does not collapse', async () => {
    dbQuery = makeFakeProposalsStore();
    const app = buildApp();

    const body = JSON.stringify({
      proposalKey: 'pk-1',
      type: 'create_workflow',
      params: { foo: 'bar' },
      priority: 'high',
      businessRationale: 'Reduce churn',
      confidence: 0.8,
      status: 'emitted',
    });

    const resS1 = await inject(app, {
      method: 'POST',
      url: '/api/insights/s1/crystal/proposals',
      headers: { 'content-type': 'application/json' },
      body,
    });
    const resS2 = await inject(app, {
      method: 'POST',
      url: '/api/insights/s2/crystal/proposals',
      headers: { 'content-type': 'application/json' },
      body,
    });

    expect(resS1.statusCode).toBe(200);
    expect(resS2.statusCode).toBe(200);
    const rowS1 = resS1.json();
    const rowS2 = resS2.json();
    // Two distinct rows, not one row overwriting the other.
    expect(rowS1.id).not.toBe(rowS2.id);
    expect(rowS1.survey_id).toBe('s1');
    expect(rowS2.survey_id).toBe('s2');

    // Assert the SQL itself carries the fixed conflict target, so a future
    // regression that widens/narrows it again is caught even if the fake
    // store's behaviour happens to still look right.
    const sawInsert = [];
    const spySql = vi.fn(async (sql, params) => {
      sawInsert.push(sql);
      return makeFakeProposalsStore()(sql, params);
    });
    dbQuery = spySql;
    await inject(buildApp(), {
      method: 'POST',
      url: '/api/insights/s3/crystal/proposals',
      headers: { 'content-type': 'application/json' },
      body,
    });
    const proposalSql = sawInsert.find((sql) => sql.includes('crystal_action_proposals'));
    expect(proposalSql).toContain('ON CONFLICT (org_id, survey_id, proposal_key)');
  });

  it('inserts a new proposal then updates the same proposalKey on the same survey (upsert path)', async () => {
    dbQuery = makeFakeProposalsStore();
    const app = buildApp();

    const res1 = await inject(app, {
      method: 'POST',
      url: '/api/insights/s1/crystal/proposals',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        proposalKey: 'pk-1',
        type: 'create_workflow',
        params: { foo: 'bar' },
        priority: 'high',
        businessRationale: 'Reduce churn',
        confidence: 0.8,
        status: 'emitted',
      }),
    });

    expect(res1.statusCode).toBe(200);
    expect(res1.json()).toMatchObject({ status: 'emitted' });
    const proposalId = res1.json().id;

    const res2 = await inject(app, {
      method: 'POST',
      url: '/api/insights/s1/crystal/proposals',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        proposalKey: 'pk-1',
        type: 'create_workflow',
        status: 'succeeded',
        outcomeRef: 'wf-9',
      }),
    });

    expect(res2.statusCode).toBe(200);
    // Same row (id unchanged), status + outcome_ref now updated.
    expect(res2.json()).toMatchObject({ id: proposalId, status: 'succeeded', outcome_ref: 'wf-9' });
  });

  // This is the rewrite of the test that used to PIN the defect (a later status
  // silently overwriting an earlier terminal one). The red-then-green here is the
  // point: this exact scenario — `succeeded` recorded, then a late `accepted`
  // arrives (the same-tick race described in MIGRATION_TEST_PLAN.md §4.1 item h,
  // now also fixed client-side by awaiting every track() call in CrystalPanel.tsx)
  // — must NOT regress the row back to a non-terminal status.
  it('lifecycle guard: a terminal status cannot be overwritten by a late non-terminal status', async () => {
    dbQuery = makeFakeProposalsStore();
    const app = buildApp();

    const emit = (body) => inject(app, {
      method: 'POST',
      url: '/api/insights/s1/crystal/proposals',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    await emit({ proposalKey: 'pk-1', type: 'create_workflow', status: 'emitted' });
    const succeeded = await emit({ proposalKey: 'pk-1', type: 'create_workflow', status: 'succeeded', outcomeRef: 'wf-9' });
    expect(succeeded.json().status).toBe('succeeded');

    // Simulates `accepted` arriving after `succeeded` — the exact race the old
    // fire-and-forget `track()` calls could produce.
    const lateAccepted = await emit({ proposalKey: 'pk-1', type: 'create_workflow', status: 'accepted' });
    expect(lateAccepted.statusCode).toBe(200);
    expect(lateAccepted.json().status).toBe('succeeded');
    expect(lateAccepted.json().outcome_ref).toBe('wf-9');
  });

  it('emitted_at is set once on INSERT and is never part of the DO UPDATE SET clause', async () => {
    let proposalSql = null;
    dbQuery = vi.fn(async (sql, params) => {
      if (sql.includes('crystal_action_proposals') && sql.includes('INSERT INTO')) {
        proposalSql = sql;
        return { rows: [{ id: 'p-1', status: params[9] }] };
      }
      return { rows: [] };
    });

    const res = await inject(buildApp(), {
      method: 'POST',
      url: '/api/insights/s1/crystal/proposals',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proposalKey: 'pk-1', type: 'create_workflow', status: 'emitted' }),
    });

    expect(res.statusCode).toBe(200);
    // emitted_at is in the INSERT column/VALUES list (set once, at first emit) ...
    expect(proposalSql).toMatch(/emitted_at\)[\s\S]*?VALUES[\s\S]*?NOW\(\)/);
    // ... and absent from the DO UPDATE SET clause (never clobbered on update).
    const setClause = proposalSql.slice(proposalSql.indexOf('DO UPDATE SET'), proposalSql.indexOf('RETURNING'));
    expect(setClause).not.toContain('emitted_at');
  });

  it('returns 400 when status is not a recognized value', async () => {
    const proposalCalls = [];
    dbQuery = vi.fn(async (sql) => {
      if (sql.includes('crystal_action_proposals')) proposalCalls.push(sql);
      return { rows: [] };
    });
    const res = await inject(buildApp(), {
      method: 'POST',
      url: '/api/insights/s1/crystal/proposals',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proposalKey: 'pk-1', type: 'create_workflow', status: 'bogus' }),
    });
    expect(res.statusCode).toBe(400);
    expect(proposalCalls).toHaveLength(0);
  });

  it('returns 400 when type is missing', async () => {
    const proposalCalls = [];
    dbQuery = vi.fn(async (sql) => {
      if (sql.includes('crystal_action_proposals')) proposalCalls.push(sql);
      return { rows: [] };
    });
    const res = await inject(buildApp(), {
      method: 'POST',
      url: '/api/insights/s1/crystal/proposals',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proposalKey: 'pk-1', status: 'emitted' }),
    });
    expect(res.statusCode).toBe(400);
    // Validation rejects before touching the DB
    expect(proposalCalls).toHaveLength(0);
  });

  it('returns 400 when status is missing', async () => {
    dbQuery = vi.fn(async () => ({ rows: [] }));
    const res = await inject(buildApp(), {
      method: 'POST',
      url: '/api/insights/s1/crystal/proposals',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proposalKey: 'pk-1', type: 'create_workflow' }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 500 on a DB error', async () => {
    dbQuery = vi.fn(async () => { throw new Error('db down'); });
    const res = await inject(buildApp(), {
      method: 'POST',
      url: '/api/insights/s1/crystal/proposals',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proposalKey: 'pk-1', type: 'create_workflow', status: 'emitted' }),
    });
    expect(res.statusCode).toBe(500);
  });
});

describe('GET /api/insights/:surveyId/crystal/proposals', () => {
  beforeEach(() => {
    dbQuery = vi.fn();
  });

  it('lists proposals scoped to the org', async () => {
    dbQuery = vi.fn(async (sql, params) => {
      if (!sql.includes('crystal_action_proposals')) return { rows: [] };
      expect(sql).toContain('FROM crystal_action_proposals');
      expect(sql).toContain('WHERE org_id = $1');
      expect(sql).toContain('AND survey_id = $2');
      expect(params).toEqual(['o1', 's1']);
      return { rows: [{ id: 'p-1', status: 'emitted' }, { id: 'p-2', status: 'succeeded' }] };
    });

    const res = await inject(buildApp(), {
      method: 'GET',
      url: '/api/insights/s1/crystal/proposals',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().proposals).toHaveLength(2);
  });

  it('filters by status when provided', async () => {
    dbQuery = vi.fn(async (sql, params) => {
      if (!sql.includes('crystal_action_proposals')) return { rows: [] };
      expect(sql).toContain('AND status = $3');
      expect(params).toEqual(['o1', 's1', 'succeeded']);
      return { rows: [{ id: 'p-2', status: 'succeeded' }] };
    });

    const res = await inject(buildApp(), {
      method: 'GET',
      url: '/api/insights/s1/crystal/proposals?status=succeeded',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().proposals).toHaveLength(1);
  });

  it('returns an empty list on a DB error (graceful fallback)', async () => {
    dbQuery = vi.fn(async () => { throw new Error('boom'); });
    const res = await inject(buildApp(), {
      method: 'GET',
      url: '/api/insights/s1/crystal/proposals',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().proposals).toEqual([]);
  });
});
