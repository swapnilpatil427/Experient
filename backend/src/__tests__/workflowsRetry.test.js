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
const REG_PATH    = _require.resolve(resolve(__dirname, '../lib/workflowRegistry'));
const ROUTER_PATH = _require.resolve(resolve(__dirname, '../routes/workflows'));

let dbQuery, runWorkflowMock;
function fakeMod(id, exports) { return { id, filename: id, loaded: true, exports, children: [] }; }
function buildApp() {
  _require.cache[AUTH_PATH] = fakeMod(AUTH_PATH, {
    requireAuth: (req, res, next) => { req.orgId = 'o1'; req.userId = 'u1'; next(); },
  });
  // routes/workflows.ts now gates every route with requirePermission('workflows:manage')
  // (see workflowsRoutesPermissions.test.js for dedicated allow/deny coverage) — pass
  // through here so this file's tests exercise route logic, not RBAC.
  _require.cache[PERM_PATH] = fakeMod(PERM_PATH, {
    requirePermission: () => (req, res, next) => next(), invalidatePermissionCache: vi.fn(),
  });
  _require.cache[DB_PATH] = fakeMod(DB_PATH, { query: dbQuery, default: { query: dbQuery } });
  _require.cache[ENGINE_PATH] = fakeMod(ENGINE_PATH, { runWorkflow: runWorkflowMock });
  _require.cache[REG_PATH] = fakeMod(REG_PATH, { registry: () => ({ triggers: [], conditionFields: [], conditionOperators: [], actions: [] }) });
  delete _require.cache[ROUTER_PATH];
  const router = _require(ROUTER_PATH);
  const app = express(); app.use(express.json()); app.use('/api/workflows', router.default || router);
  return app;
}
async function api(app, method, url) {
  const res = await inject(app, { method, url });
  return { status: res.statusCode, body: res.json() };
}

beforeEach(() => {
  dbQuery = vi.fn(async () => ({ rows: [] }));
  runWorkflowMock = vi.fn(async () => ({ executionId: 'e2', status: 'completed' }));
});

describe('POST /api/workflows/executions/:id/retry (DLQ)', () => {
  it('re-runs a failed execution', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('FROM workflow_executions')) return { rows: [{ id: 'e1', status: 'failed', workflow_id: 'w1', trigger_payload: { nps: 3 } }] };
      if (text.includes('FROM workflows')) return { rows: [{ id: 'w1', nodes: [] }] };
      return { rows: [] };
    });
    const { status, body } = await api(buildApp(), 'POST', '/api/workflows/executions/e1/retry');
    expect(status).toBe(200);
    expect(body.result.status).toBe('completed');
    // Manual DLQ replay bypasses cooldown (explicit human action), matching the
    // existing idempotency-bypass convention — see runWorkflow's bypassCooldown doc.
    expect(runWorkflowMock).toHaveBeenCalledWith(expect.objectContaining({ id: 'w1' }), { nps: 3 }, { orgId: 'o1', bypassCooldown: true });
  });

  it('409s when the execution is not in a failed state', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('FROM workflow_executions')) return { rows: [{ id: 'e1', status: 'completed', workflow_id: 'w1' }] };
      return { rows: [] };
    });
    const { status } = await api(buildApp(), 'POST', '/api/workflows/executions/e1/retry');
    expect(status).toBe(409);
  });

  it('404s when the execution is unknown', async () => {
    dbQuery = vi.fn(async () => ({ rows: [] }));
    const { status } = await api(buildApp(), 'POST', '/api/workflows/executions/x/retry');
    expect(status).toBe(404);
  });
});
