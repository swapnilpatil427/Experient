// Regression coverage for routes/workflows.ts's requirePermission('workflows:manage')
// gate (added by Nina, 2026-07-01, following the coordinator's follow-up to the Wave 1b
// review). Before this fix, every route in routes/workflows.ts used requireAuth only —
// any authenticated org member (not just an admin) could create/edit/delete/disable/
// test-run/retry any workflow in their org, and read the trigger/action registry,
// templates, run history, and pending approvals — regardless of role. This mirrors the
// permission model routes/alerts.ts already uses: a single `<resource>:manage`
// permission applied uniformly across every route on the resource, including
// read-only/static ones (alerts.ts gates its static `GET /types` taxonomy catalog with
// `alerts:manage` the same way workflows.ts now gates its static `GET /registry`
// catalog with `workflows:manage` — there is no `workflows:read`/`workflows:write`
// split in the permission catalog, so one permission covers the whole router).
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
const ENGINE_PATH  = _require.resolve(resolve(__dirname, '../lib/workflowEngine'));
const REG_PATH     = _require.resolve(resolve(__dirname, '../lib/workflowRegistry'));
const AGENTS_PATH  = _require.resolve(resolve(__dirname, '../lib/agentsClient'));
const ROUTER_PATH  = _require.resolve(resolve(__dirname, '../routes/workflows'));

let dbQuery, runWorkflowMock, resumeWorkflowMock, requirePermissionMock, parseWorkflowNLMock;
function fakeMod(id, exports) { return { id, filename: id, loaded: true, exports, children: [] }; }
class FakeUnparseableWorkflowError extends Error {
  constructor(message, suggestions = []) { super(message); this.suggestions = suggestions; }
}
function buildApp() {
  _require.cache[AUTH_PATH] = fakeMod(AUTH_PATH, {
    requireAuth: (req, res, next) => { req.orgId = 'o1'; req.userId = 'u1'; next(); },
  });
  _require.cache[PERM_PATH] = fakeMod(PERM_PATH, { requirePermission: requirePermissionMock });
  _require.cache[DB_PATH] = fakeMod(DB_PATH, { query: dbQuery, default: { query: dbQuery } });
  _require.cache[ENGINE_PATH] = fakeMod(ENGINE_PATH, { runWorkflow: runWorkflowMock, resumeWorkflow: resumeWorkflowMock });
  _require.cache[REG_PATH] = fakeMod(REG_PATH, { registry: () => ({ triggers: [], conditionFields: [], conditionOperators: [], actions: [] }) });
  _require.cache[AGENTS_PATH] = fakeMod(AGENTS_PATH, {
    parseWorkflowNL: parseWorkflowNLMock,
    UnparseableWorkflowError: FakeUnparseableWorkflowError,
  });
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

// Every route in routes/workflows.ts, in file order.
const ROUTES = [
  { method: 'GET',    url: '/api/workflows/approvals' },
  { method: 'POST',   url: '/api/workflows/approvals/e1', body: { decision: 'approve' } },
  { method: 'GET',    url: '/api/workflows/registry' },
  { method: 'GET',    url: '/api/workflows/templates' },
  { method: 'GET',    url: '/api/workflows/notification-targets' },
  { method: 'GET',    url: '/api/workflows' },
  { method: 'GET',    url: '/api/workflows/w1' },
  { method: 'POST',   url: '/api/workflows/parse-nl', body: { description: 'notify slack on nps drop' } },
  { method: 'POST',   url: '/api/workflows', body: { name: 'wf' } },
  { method: 'PUT',    url: '/api/workflows/w1', body: { name: 'wf' } },
  { method: 'DELETE', url: '/api/workflows/w1' },
  { method: 'POST',   url: '/api/workflows/w1/toggle' },
  { method: 'GET',    url: '/api/workflows/w1/audit-log' },
  { method: 'POST',   url: '/api/workflows/w1/test' },
  { method: 'POST',   url: '/api/workflows/executions/e1/retry' },
  { method: 'GET',    url: '/api/workflows/w1/executions' },
];

beforeEach(() => {
  dbQuery = vi.fn(async () => ({ rows: [] }));
  runWorkflowMock = vi.fn(async () => ({ executionId: 'e2', status: 'completed' }));
  resumeWorkflowMock = vi.fn(async () => ({ executionId: 'e1', status: 'completed' }));
  parseWorkflowNLMock = vi.fn(async () => ({
    name: 'NPS Recovery', description: 'x', triggerType: 'score.nps_drop',
    nodes: [], edges: [], confidence: 0.9, warnings: [],
  }));
});

describe('routes/workflows.ts permission gating (workflows:manage)', () => {
  it('denies every route with 403 when the caller lacks workflows:manage', async () => {
    requirePermissionMock = vi.fn((action) => (req, res) => {
      res.status(403).json({ error: `forbidden: ${action}` });
    });
    const app = buildApp();

    for (const { method, url, body } of ROUTES) {
      const { status } = await api(app, method, url, body);
      expect(status, `${method} ${url} should 403 without workflows:manage`).toBe(403);
    }

    // Every route must request the SAME permission action — one unified gate for the
    // whole resource, matching alerts.ts's convention (no read/write split exists for
    // 'workflows:*' in the permission catalog).
    expect(requirePermissionMock).toHaveBeenCalledTimes(ROUTES.length);
    for (const call of requirePermissionMock.mock.calls) {
      expect(call[0]).toBe('workflows:manage');
    }
  });

  it('allows every route through when the caller has workflows:manage', async () => {
    requirePermissionMock = vi.fn(() => (req, res, next) => next());
    dbQuery = vi.fn(async (text) => {
      if (text.includes('FROM workflow_executions')) return { rows: [{ id: 'e1', status: 'failed', workflow_id: 'w1', trigger_payload: {} }] };
      if (text.includes('FROM workflows')) return { rows: [{ id: 'w1', nodes: [], trigger_type: null }] };
      return { rows: [] };
    });
    const app = buildApp();

    for (const { method, url, body } of ROUTES) {
      const { status } = await api(app, method, url, body);
      expect(status, `${method} ${url} should not 403 with workflows:manage`).not.toBe(403);
    }
  });

  it('applies the gate to static/read-only routes too (registry, templates) — no lighter-touch exception', async () => {
    // GET /registry serves a static in-memory catalog (mirrors alerts.ts's GET /types,
    // which is gated the same way) — confirms we did not carve out an ungated tier for
    // read-only/static routes, following this codebase's existing precedent exactly.
    requirePermissionMock = vi.fn((action) => (req, res) => {
      res.status(403).json({ error: `forbidden: ${action}` });
    });
    const app = buildApp();

    const registryRes = await api(app, 'GET', '/api/workflows/registry');
    expect(registryRes.status).toBe(403);

    const templatesRes = await api(app, 'GET', '/api/workflows/templates');
    expect(templatesRes.status).toBe(403);
  });
});
