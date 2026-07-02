// Regression coverage for Wave 11 Part 1 (audit trail) + Part 2 (optimistic
// locking) on routes/workflows.ts (Nina, 2026-07-02, DEEP_AUDIT_PM_FINDINGS.md
// §10a/§10b, TRACKER.md Wave 11). Both features are additive/backward-compatible
// by design — see routes/workflows.ts and lib/workflowAuditLog.ts for the
// detailed rationale comments this file's tests are proving out.
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
const AUDIT_PATH  = _require.resolve(resolve(__dirname, '../lib/workflowAuditLog'));
const ROUTER_PATH = _require.resolve(resolve(__dirname, '../routes/workflows'));

let dbQuery, writeWorkflowAuditLogMock;
function fakeMod(id, exports) { return { id, filename: id, loaded: true, exports, children: [] }; }
function buildApp() {
  _require.cache[AUTH_PATH] = fakeMod(AUTH_PATH, {
    requireAuth: (req, res, next) => { req.orgId = 'o1'; req.userId = 'u1'; next(); },
  });
  _require.cache[PERM_PATH] = fakeMod(PERM_PATH, {
    requirePermission: () => (req, res, next) => next(), invalidatePermissionCache: vi.fn(),
  });
  _require.cache[DB_PATH] = fakeMod(DB_PATH, { query: dbQuery, default: { query: dbQuery } });
  const computeCooldownStatus = () => null; // not under test here
  _require.cache[ENGINE_PATH] = fakeMod(ENGINE_PATH, { runWorkflow: vi.fn(), resumeWorkflow: vi.fn(), computeCooldownStatus });
  _require.cache[REG_PATH] = fakeMod(REG_PATH, { registry: () => ({ triggers: [], conditionFields: [], conditionOperators: [], actions: [] }) });
  // Real diffChangedFields (pure, no I/O) is used as-is; only the DB-writing
  // half (writeWorkflowAuditLog) is mocked, so these tests assert on WHAT gets
  // logged without needing a real Postgres connection.
  const real = _require(AUDIT_PATH);
  _require.cache[AUDIT_PATH] = fakeMod(AUDIT_PATH, {
    writeWorkflowAuditLog: writeWorkflowAuditLogMock,
    diffChangedFields: real.diffChangedFields,
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

beforeEach(() => {
  dbQuery = vi.fn(async () => ({ rows: [] }));
  writeWorkflowAuditLogMock = vi.fn(async () => {});
});

// ── Part 2 — optimistic locking ─────────────────────────────────────────────

describe('PUT /api/workflows/:id — optimistic locking (version)', () => {
  it('[MOST IMPORTANT] a normal PUT without `version` succeeds exactly as before — zero regression for every existing caller', async () => {
    const existing = { id: 'w1', org_id: 'o1', name: 'Old name', version: 5 };
    const updated  = { id: 'w1', org_id: 'o1', name: 'New name', version: 6 };
    let updateCall = null;
    dbQuery = vi.fn(async (text, params) => {
      if (text.startsWith('UPDATE workflows')) { updateCall = [text, params]; return { rows: [updated] }; }
      if (text.includes('FROM workflows WHERE id = $1 AND org_id = $2')) return { rows: [existing] };
      return { rows: [] };
    });
    const { status, body } = await api(buildApp(), 'PUT', '/api/workflows/w1', { name: 'New name' });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    // No `version` in the request body at all — the conflict check must never
    // fire, and the UPDATE must proceed unconditionally.
    expect(updateCall).toBeTruthy();
    expect(updateCall[0]).toContain('version = version + 1');
  });

  it('a PUT with a stale `version` gets 409 and does NOT mutate the row', async () => {
    const existing = { id: 'w1', org_id: 'o1', name: 'Current name', version: 5 };
    let updateCalled = false;
    dbQuery = vi.fn(async (text) => {
      if (text.startsWith('UPDATE workflows')) { updateCalled = true; return { rows: [{ id: 'w1' }] }; }
      if (text.includes('FROM workflows WHERE id = $1 AND org_id = $2')) return { rows: [existing] };
      return { rows: [] };
    });
    const { status, body } = await api(buildApp(), 'PUT', '/api/workflows/w1', { name: 'Attempted change', version: 3 });
    expect(status).toBe(409);
    expect(body.error).toMatch(/changed by someone else/i);
    // Server-side current state is returned so a future frontend can render a
    // "someone else edited this" comparison dialog.
    expect(body.workflow).toMatchObject({ id: 'w1', name: 'Current name', version: 5 });
    expect(updateCalled).toBe(false);
  });

  it('a PUT with the current, correct `version` succeeds and increments it', async () => {
    const existing = { id: 'w1', org_id: 'o1', name: 'Old name', version: 5 };
    const updated  = { id: 'w1', org_id: 'o1', name: 'New name', version: 6 };
    let updateCall = null;
    dbQuery = vi.fn(async (text, params) => {
      if (text.startsWith('UPDATE workflows')) { updateCall = [text, params]; return { rows: [updated] }; }
      if (text.includes('FROM workflows WHERE id = $1 AND org_id = $2')) return { rows: [existing] };
      return { rows: [] };
    });
    const { status, body } = await api(buildApp(), 'PUT', '/api/workflows/w1', { name: 'New name', version: 5 });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.version).toBe(6);
    expect(updateCall[0]).toContain('version = version + 1');
  });

  it('two sequential PUTs each with correct incrementing versions both succeed (non-conflicting case)', async () => {
    let currentVersion = 1;
    let currentName = 'Start';
    dbQuery = vi.fn(async (text, params) => {
      if (text.includes('FROM workflows WHERE id = $1 AND org_id = $2')) {
        return { rows: [{ id: 'w1', org_id: 'o1', name: currentName, version: currentVersion }] };
      }
      if (text.startsWith('UPDATE workflows')) {
        currentVersion += 1;
        // name is the first SET value in this request's `vals` (no condition/
        // action/status sent), so params[0] is the new name.
        currentName = params[0];
        return { rows: [{ id: 'w1', org_id: 'o1', name: currentName, version: currentVersion }] };
      }
      return { rows: [] };
    });
    const app = buildApp();

    const first = await api(app, 'PUT', '/api/workflows/w1', { name: 'Edit 1', version: 1 });
    expect(first.status).toBe(200);
    expect(first.body.version).toBe(2);

    const second = await api(app, 'PUT', '/api/workflows/w1', { name: 'Edit 2', version: 2 });
    expect(second.status).toBe(200);
    expect(second.body.version).toBe(3);
  });

  it('omitting `version` from the schema is still valid (not a required field)', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.startsWith('UPDATE workflows')) return { rows: [{ id: 'w1', version: 2 }] };
      return { rows: [] };
    });
    const { status } = await api(buildApp(), 'PUT', '/api/workflows/w1', { name: 'No version at all' });
    expect(status).toBe(200);
  });
});

// ── Part 1 — audit trail ─────────────────────────────────────────────────────

describe('POST /api/workflows — audit trail on create', () => {
  it('writes a "created" audit row with the new workflow id', async () => {
    const created = { id: 'w9', org_id: 'o1', name: 'New workflow', status: 'draft', trigger_type: 'score.nps_drop' };
    dbQuery = vi.fn(async (text) => {
      if (text.startsWith('INSERT INTO workflows')) return { rows: [created] };
      return { rows: [] };
    });
    const { status } = await api(buildApp(), 'POST', '/api/workflows', { name: 'New workflow', triggerType: 'score.nps_drop' });
    expect(status).toBe(201);
    await vi.waitFor(() => expect(writeWorkflowAuditLogMock).toHaveBeenCalledTimes(1));
    const call = writeWorkflowAuditLogMock.mock.calls[0][0];
    expect(call).toMatchObject({ workflowId: 'w9', orgId: 'o1', actorUserId: 'u1', action: 'created' });
  });
});

describe('PUT /api/workflows/:id — audit trail on update', () => {
  it('sets updated_by and writes an "updated" audit row with a before/after diff of only the changed fields', async () => {
    const existing = { id: 'w1', org_id: 'o1', name: 'Old name', description: 'unchanged', version: 1 };
    const updated  = { id: 'w1', org_id: 'o1', name: 'New name', description: 'unchanged', version: 2 };
    let updateParams = null;
    dbQuery = vi.fn(async (text, params) => {
      if (text.includes('FROM workflows WHERE id = $1 AND org_id = $2')) return { rows: [existing] };
      if (text.startsWith('UPDATE workflows')) { updateParams = params; return { rows: [updated] }; }
      return { rows: [] };
    });
    const { status } = await api(buildApp(), 'PUT', '/api/workflows/w1', { name: 'New name', version: 1 });
    expect(status).toBe(200);
    // updated_by is set to the acting user on every successful PUT.
    expect(updateParams).toContain('u1');
    await vi.waitFor(() => expect(writeWorkflowAuditLogMock).toHaveBeenCalledTimes(1));
    const call = writeWorkflowAuditLogMock.mock.calls[0][0];
    expect(call).toMatchObject({ workflowId: 'w1', orgId: 'o1', actorUserId: 'u1', action: 'updated' });
    // Only `name` changed — description must not appear in the diff summary.
    expect(call.summary).toEqual({ name: { before: 'Old name', after: 'New name' } });
  });

  it('records a "status_changed" action (not "updated") when the PUT touches status', async () => {
    const existing = { id: 'w1', org_id: 'o1', name: 'Same', status: 'draft', version: 1 };
    const updated  = { id: 'w1', org_id: 'o1', name: 'Same', status: 'active', version: 2 };
    dbQuery = vi.fn(async (text) => {
      if (text.includes('FROM workflows WHERE id = $1 AND org_id = $2')) return { rows: [existing] };
      if (text.startsWith('UPDATE workflows')) return { rows: [updated] };
      return { rows: [] };
    });
    const { status } = await api(buildApp(), 'PUT', '/api/workflows/w1', { status: 'active', version: 1 });
    expect(status).toBe(200);
    await vi.waitFor(() => expect(writeWorkflowAuditLogMock).toHaveBeenCalledTimes(1));
    expect(writeWorkflowAuditLogMock.mock.calls[0][0].action).toBe('status_changed');
  });

  it('does not throw / still returns success when the audit write itself fails', async () => {
    const existing = { id: 'w1', org_id: 'o1', name: 'Old', version: 1 };
    const updated  = { id: 'w1', org_id: 'o1', name: 'New', version: 2 };
    dbQuery = vi.fn(async (text) => {
      if (text.includes('FROM workflows WHERE id = $1 AND org_id = $2')) return { rows: [existing] };
      if (text.startsWith('UPDATE workflows')) return { rows: [updated] };
      return { rows: [] };
    });
    writeWorkflowAuditLogMock = vi.fn(async () => { throw new Error('boom, audit db down'); });
    const { status, body } = await api(buildApp(), 'PUT', '/api/workflows/w1', { name: 'New', version: 1 });
    // The route calls writeWorkflowAuditLog() without awaiting it (fire-and-
    // forget), so a rejection there must never surface as a 500 on the PUT
    // response — this mirrors workflowEngine.ts's logStep() precedent.
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });
});

describe('POST /api/workflows/:id/toggle — audit trail', () => {
  it('writes a "status_changed" audit row and sets updated_by/version', async () => {
    let updateParams = null;
    dbQuery = vi.fn(async (text, params) => {
      if (text.startsWith('UPDATE workflows')) { updateParams = params; return { rows: [{ status: 'active' }] }; }
      return { rows: [] };
    });
    const { status } = await api(buildApp(), 'POST', '/api/workflows/w1/toggle');
    expect(status).toBe(200);
    expect(updateParams).toEqual(['w1', 'o1', 'u1']);
    await vi.waitFor(() => expect(writeWorkflowAuditLogMock).toHaveBeenCalledTimes(1));
    expect(writeWorkflowAuditLogMock.mock.calls[0][0]).toMatchObject({ workflowId: 'w1', action: 'status_changed' });
  });

  it('does not write an audit row when the workflow does not exist', async () => {
    dbQuery = vi.fn(async () => ({ rows: [] }));
    const { status } = await api(buildApp(), 'POST', '/api/workflows/nope/toggle');
    expect(status).toBe(404);
    expect(writeWorkflowAuditLogMock).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/workflows/:id — audit trail', () => {
  it('writes a "deleted" audit row capturing the row as it looked at deletion time', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.startsWith('DELETE FROM workflows')) {
        return { rows: [{ id: 'w1', org_id: 'o1', name: 'Doomed workflow', status: 'active' }] };
      }
      return { rows: [] };
    });
    const { status } = await api(buildApp(), 'DELETE', '/api/workflows/w1');
    expect(status).toBe(200);
    await vi.waitFor(() => expect(writeWorkflowAuditLogMock).toHaveBeenCalledTimes(1));
    const call = writeWorkflowAuditLogMock.mock.calls[0][0];
    expect(call).toMatchObject({ workflowId: 'w1', orgId: 'o1', actorUserId: 'u1', action: 'deleted' });
    expect(call.summary).toMatchObject({ name: 'Doomed workflow', status: 'active' });
  });

  it('does not write an audit row when nothing was actually deleted (already gone / cross-org)', async () => {
    dbQuery = vi.fn(async () => ({ rows: [] }));
    const { status } = await api(buildApp(), 'DELETE', '/api/workflows/does-not-exist');
    expect(status).toBe(200); // pre-existing behavior: DELETE is always a 200 no-op-or-not
    expect(writeWorkflowAuditLogMock).not.toHaveBeenCalled();
  });
});

// ── GET /:id/audit-log ────────────────────────────────────────────────────

describe('GET /api/workflows/:id/audit-log', () => {
  it('returns paginated audit events for the workflow, matching routes/auditLogs.ts\'s pagination shape', async () => {
    const events = [
      { id: 'a2', workflow_id: 'w1', org_id: 'o1', actor_user_id: 'u1', action: 'updated', summary: { name: { before: 'A', after: 'B' } }, created_at: '2026-07-02T00:00:00Z' },
      { id: 'a1', workflow_id: 'w1', org_id: 'o1', actor_user_id: 'u1', action: 'created', summary: {}, created_at: '2026-07-01T00:00:00Z' },
    ];
    dbQuery = vi.fn(async (text, params) => {
      if (text.includes('SELECT id FROM workflows WHERE id = $1 AND org_id = $2')) return { rows: [{ id: 'w1' }] };
      if (text.includes('FROM workflow_audit_log') && text.includes('SELECT id, workflow_id')) {
        expect(params).toEqual(['w1', 'o1', 50, 0]);
        return { rows: events };
      }
      if (text.includes('COUNT(*)::int AS count FROM workflow_audit_log')) return { rows: [{ count: 2 }] };
      return { rows: [] };
    });
    const { status, body } = await api(buildApp(), 'GET', '/api/workflows/w1/audit-log');
    expect(status).toBe(200);
    expect(body.total).toBe(2);
    expect(body.page).toBe(1);
    expect(body.limit).toBe(50);
    expect(body.pages).toBe(1);
    expect(body.events).toHaveLength(2);
    expect(body.events[0]).toMatchObject({ id: 'a2', workflowId: 'w1', action: 'updated' });
  });

  it('respects page/limit query params', async () => {
    dbQuery = vi.fn(async (text, params) => {
      if (text.includes('SELECT id FROM workflows WHERE id = $1 AND org_id = $2')) return { rows: [{ id: 'w1' }] };
      if (text.includes('FROM workflow_audit_log') && text.includes('SELECT id, workflow_id')) {
        expect(params).toEqual(['w1', 'o1', 10, 10]);
        return { rows: [] };
      }
      if (text.includes('COUNT(*)::int AS count FROM workflow_audit_log')) return { rows: [{ count: 25 }] };
      return { rows: [] };
    });
    const { status, body } = await api(buildApp(), 'GET', '/api/workflows/w1/audit-log?page=2&limit=10');
    expect(status).toBe(200);
    expect(body.page).toBe(2);
    expect(body.limit).toBe(10);
    expect(body.pages).toBe(3);
  });

  it('404s when the workflow does not exist / belongs to another org', async () => {
    dbQuery = vi.fn(async () => ({ rows: [] }));
    const { status } = await api(buildApp(), 'GET', '/api/workflows/nope/audit-log');
    expect(status).toBe(404);
  });
});
