// Regression coverage: Growth-tier enforcement for Crystal Signal triggers at
// SAVE time (Nina, 2026-07-01, DEEP_AUDIT_PM_FINDINGS.md §6d). Previously
// "Crystal Signals require a Growth plan" was pure locale-string marketing copy
// with zero backing enforcement — POST/PUT /api/workflows accepted
// crystal.anomaly_detected/sentiment_spike/new_theme_detected on ANY plan,
// including Free. Execution-time re-check (defense in depth for a plan
// downgrade) is covered separately in workflowEngine.test.js.
//
// Uses the REAL workflowRegistry.ts (not a stub) so `minPlanTier: 'growth'` on
// the three Crystal Signal triggers is exercised as shipped — only `lib/db` is
// mocked, to control the org's plan_tier.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import inject from 'light-my-request';
import express from 'express';

const __dirname = dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);

const AUTH_PATH   = _require.resolve(resolve(__dirname, '../middleware/auth'));
const PERM_PATH   = _require.resolve(resolve(__dirname, '../middleware/requirePermission'));
const DB_PATH     = _require.resolve(resolve(__dirname, '../lib/db'));
const ENGINE_PATH = _require.resolve(resolve(__dirname, '../lib/workflowEngine'));
const PLANGATE_PATH = _require.resolve(resolve(__dirname, '../lib/planGating'));
const ROUTER_PATH = _require.resolve(resolve(__dirname, '../routes/workflows'));

let dbQuery;
function fakeMod(id, exports) { return { id, filename: id, loaded: true, exports, children: [] }; }
function buildApp() {
  _require.cache[AUTH_PATH] = fakeMod(AUTH_PATH, {
    requireAuth: (req, res, next) => { req.orgId = 'o1'; req.userId = 'u1'; next(); },
  });
  _require.cache[PERM_PATH] = fakeMod(PERM_PATH, {
    requirePermission: () => (req, res, next) => next(), invalidatePermissionCache: vi.fn(),
  });
  _require.cache[DB_PATH] = fakeMod(DB_PATH, { query: dbQuery, default: { query: dbQuery } });
  _require.cache[ENGINE_PATH] = fakeMod(ENGINE_PATH, { runWorkflow: vi.fn(), resumeWorkflow: vi.fn(), computeCooldownStatus: () => null });
  // REG_PATH deliberately NOT stubbed — real registry, real minPlanTier values.
  // planGating.ts closes over `./db` at require-time (like connectors.ts /
  // workflowCredentials.ts in workflowEngine.test.js) — evict it every call so it
  // always picks up the CURRENT dbQuery mock, not a prior test case's stale one.
  delete _require.cache[PLANGATE_PATH];
  delete _require.cache[ROUTER_PATH];
  const router = _require(ROUTER_PATH);
  const app = express(); app.use(express.json()); app.use('/api/workflows', router.default || router);
  return app;
}
async function api(app, method, url, body = null) {
  const opts = { method, url };
  if (body !== null) { opts.payload = JSON.stringify(body); opts.headers = { 'content-type': 'application/json' }; }
  const res = await inject(app, opts);
  return { status: res.statusCode, body: res.json() };
}

function dbWithPlan(planTier) {
  return vi.fn(async (text, params) => {
    if (text.includes('plan_tier FROM org_profiles')) return { rows: planTier ? [{ plan_tier: planTier }] : [] };
    if (text.startsWith('INSERT INTO workflows')) return { rows: [{ id: 'w1', org_id: 'o1', ...paramsToRow(params) }] };
    return { rows: [] };
  });
}
function paramsToRow() { return {}; }

describe('POST /api/workflows — Growth-tier gate on Crystal Signal triggers', () => {
  it('rejects crystal.anomaly_detected with 403 + upgrade message when org is on free', async () => {
    dbQuery = dbWithPlan('free');
    const { status, body } = await api(buildApp(), 'POST', '/api/workflows', {
      name: 'Anomaly Alert', triggerType: 'crystal.anomaly_detected',
    });
    expect(status).toBe(403);
    expect(body.error).toMatch(/growth/i);
    expect(body.error).toMatch(/upgrade/i);
  });

  it('rejects crystal.sentiment_spike with 403 when org is on starter', async () => {
    dbQuery = dbWithPlan('starter');
    const { status } = await api(buildApp(), 'POST', '/api/workflows', {
      name: 'Sentiment Alert', triggerType: 'crystal.sentiment_spike',
    });
    expect(status).toBe(403);
  });

  it('allows crystal.new_theme_detected when org is on growth', async () => {
    dbQuery = dbWithPlan('growth');
    const { status } = await api(buildApp(), 'POST', '/api/workflows', {
      name: 'Theme Alert', triggerType: 'crystal.new_theme_detected',
    });
    expect(status).toBe(201);
  });

  it('allows crystal.anomaly_detected when org is on enterprise (above growth)', async () => {
    dbQuery = dbWithPlan('enterprise');
    const { status } = await api(buildApp(), 'POST', '/api/workflows', {
      name: 'Anomaly Alert', triggerType: 'crystal.anomaly_detected',
    });
    expect(status).toBe(201);
  });

  it('never gates an ungated trigger (alert.fired) — no plan check needed, works on free', async () => {
    dbQuery = dbWithPlan('free');
    const { status } = await api(buildApp(), 'POST', '/api/workflows', {
      name: 'Critical Alert', triggerType: 'alert.fired',
    });
    expect(status).toBe(201);
  });

  it('defaults to the free plan when org_profiles has no row, and still gates', async () => {
    dbQuery = dbWithPlan(null);
    const { status } = await api(buildApp(), 'POST', '/api/workflows', {
      name: 'Anomaly Alert', triggerType: 'crystal.anomaly_detected',
    });
    expect(status).toBe(403);
  });
});

describe('PUT /api/workflows/:id — Growth-tier gate on Crystal Signal triggers', () => {
  it('rejects setting triggerType to a gated type on a sub-Growth plan', async () => {
    dbQuery = dbWithPlan('free');
    const { status, body } = await api(buildApp(), 'PUT', '/api/workflows/w1', {
      triggerType: 'crystal.anomaly_detected',
    });
    expect(status).toBe(403);
    expect(body.error).toMatch(/growth/i);
  });

  it('allows setting a gated triggerType when the org qualifies', async () => {
    dbQuery = dbWithPlan('growth');
    const { status } = await api(buildApp(), 'PUT', '/api/workflows/w1', {
      triggerType: 'crystal.anomaly_detected',
    });
    expect(status).toBe(200);
  });

  it('does not gate a PUT that does not touch triggerType at all (e.g. renaming a workflow), regardless of plan', async () => {
    dbQuery = dbWithPlan('free');
    const { status } = await api(buildApp(), 'PUT', '/api/workflows/w1', {
      name: 'Renamed workflow',
    });
    expect(status).toBe(200);
    // No plan_tier lookup should have happened — this PUT never touches triggerType.
    expect(dbQuery.mock.calls.some(([sql]) => sql.includes('plan_tier FROM org_profiles'))).toBe(false);
  });
});
