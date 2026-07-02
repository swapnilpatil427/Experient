// Regression coverage for POST /api/workflows/approvals/:executionId's decision
// parsing (Nina, 2026-07-01, DEEP_AUDIT_PM_FINDINGS.md §7c). Previously ANYTHING
// that wasn't literally 'reject'/'rejected' was silently treated as 'approved' —
// a fail-OPEN bug for a route that gates consequential actions. Now: only an
// exact (case-insensitive) 'approved'/'approve' or 'rejected'/'reject' string is
// accepted; anything else is a 400, never a silent approval.
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

let dbQuery, resumeWorkflowMock;
function fakeMod(id, exports) { return { id, filename: id, loaded: true, exports, children: [] }; }
function buildApp() {
  _require.cache[AUTH_PATH] = fakeMod(AUTH_PATH, {
    requireAuth: (req, res, next) => { req.orgId = 'o1'; req.userId = 'u1'; next(); },
  });
  _require.cache[PERM_PATH] = fakeMod(PERM_PATH, {
    requirePermission: () => (req, res, next) => next(), invalidatePermissionCache: vi.fn(),
  });
  _require.cache[DB_PATH] = fakeMod(DB_PATH, { query: dbQuery, default: { query: dbQuery } });
  _require.cache[ENGINE_PATH] = fakeMod(ENGINE_PATH, {
    runWorkflow: vi.fn(), resumeWorkflow: resumeWorkflowMock, computeCooldownStatus: () => null,
  });
  _require.cache[REG_PATH] = fakeMod(REG_PATH, { registry: () => ({ triggers: [], conditionFields: [], conditionOperators: [], actions: [] }) });
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

beforeEach(() => {
  dbQuery = vi.fn(async () => ({ rows: [] }));
  resumeWorkflowMock = vi.fn(async () => ({ status: 'completed' }));
});

describe('POST /api/workflows/approvals/:executionId — decision validation (fail-closed)', () => {
  it('accepts "approved" and resumes with approved', async () => {
    const { status, body } = await api(buildApp(), 'POST', '/api/workflows/approvals/e1', { decision: 'approved' });
    expect(status).toBe(200);
    expect(body).toEqual({ result: { status: 'completed' } });
    expect(resumeWorkflowMock).toHaveBeenCalledWith('e1', 'o1', 'approved', 'u1');
  });

  it('accepts "approve" (short form) and resumes with approved', async () => {
    const { status } = await api(buildApp(), 'POST', '/api/workflows/approvals/e1', { decision: 'approve' });
    expect(status).toBe(200);
    expect(resumeWorkflowMock).toHaveBeenCalledWith('e1', 'o1', 'approved', 'u1');
  });

  it('accepts "rejected" and resumes with rejected', async () => {
    const { status } = await api(buildApp(), 'POST', '/api/workflows/approvals/e1', { decision: 'rejected' });
    expect(status).toBe(200);
    expect(resumeWorkflowMock).toHaveBeenCalledWith('e1', 'o1', 'rejected', 'u1');
  });

  it('accepts "reject" (short form) and resumes with rejected', async () => {
    const { status } = await api(buildApp(), 'POST', '/api/workflows/approvals/e1', { decision: 'reject' });
    expect(status).toBe(200);
    expect(resumeWorkflowMock).toHaveBeenCalledWith('e1', 'o1', 'rejected', 'u1');
  });

  it('is case-insensitive ("APPROVED"/"Rejected")', async () => {
    await api(buildApp(), 'POST', '/api/workflows/approvals/e1', { decision: 'APPROVED' });
    expect(resumeWorkflowMock).toHaveBeenCalledWith('e1', 'o1', 'approved', 'u1');
    resumeWorkflowMock.mockClear();
    await api(buildApp(), 'POST', '/api/workflows/approvals/e1', { decision: 'Rejected' });
    expect(resumeWorkflowMock).toHaveBeenCalledWith('e1', 'o1', 'rejected', 'u1');
  });

  it('REGRESSION: a malformed decision (typo) is rejected with 400, NOT silently approved', async () => {
    const { status, body } = await api(buildApp(), 'POST', '/api/workflows/approvals/e1', { decision: 'aprove' });
    expect(status).toBe(400);
    expect(body.error).toMatch(/approved.*rejected/i);
    expect(resumeWorkflowMock).not.toHaveBeenCalled();
  });

  it('REGRESSION: a missing decision field is rejected with 400, NOT silently approved', async () => {
    const { status } = await api(buildApp(), 'POST', '/api/workflows/approvals/e1', {});
    expect(status).toBe(400);
    expect(resumeWorkflowMock).not.toHaveBeenCalled();
  });

  it('REGRESSION: a non-string decision (e.g. boolean true) is rejected with 400, NOT silently approved', async () => {
    const { status } = await api(buildApp(), 'POST', '/api/workflows/approvals/e1', { decision: true });
    expect(status).toBe(400);
    expect(resumeWorkflowMock).not.toHaveBeenCalled();
  });

  it('REGRESSION: an unrelated string value is rejected with 400, NOT silently approved', async () => {
    const { status } = await api(buildApp(), 'POST', '/api/workflows/approvals/e1', { decision: 'yes please' });
    expect(status).toBe(400);
    expect(resumeWorkflowMock).not.toHaveBeenCalled();
  });

  it('still 404s when resumeWorkflow finds no pending approval, for a validly-shaped decision', async () => {
    resumeWorkflowMock = vi.fn(async () => null);
    const { status } = await api(buildApp(), 'POST', '/api/workflows/approvals/missing', { decision: 'approved' });
    expect(status).toBe(404);
  });
});
