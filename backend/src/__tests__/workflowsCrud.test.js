// Regression coverage for GET /api/workflows/:id (new route) and PUT /api/workflows/:id's
// extended field set (description/triggerType/nodes/edges), added 2026-07-01 to unblock
// Wave 2 builder edit-mode (see docs/automation-hub/BUILDER_SPEC_WAVE2.md §0 — Rohan
// flagged both gaps as pre-work blocking Elias's edit-mode implementation).
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
  // computeCooldownStatus: routes/workflows.ts calls this directly on every GET
  // response (withCooldownStatus helper) — mirror its real logic (see
  // workflowEngine.ts) rather than a bare stub so these CRUD tests exercise the
  // actual cooldown_status shape. Kept minimal/inline since workflowEngine.test.js
  // is the source of truth for the function's own correctness.
  const computeCooldownStatus = (wf, now = new Date()) => {
    if (wf.trigger_type === 'time.schedule') return null;
    if (!wf.cooldown_minutes) return null;
    const lastFiredAt = wf.cooldown_last_fired_at ? new Date(wf.cooldown_last_fired_at) : null;
    if (!lastFiredAt) return { in_cooldown: false, cooldown_minutes: wf.cooldown_minutes, last_fired_at: null, cooldown_resets_at: null };
    const resetsAt = new Date(lastFiredAt.getTime() + wf.cooldown_minutes * 60_000);
    const inCooldown = resetsAt.getTime() > now.getTime();
    return { in_cooldown: inCooldown, cooldown_minutes: wf.cooldown_minutes, last_fired_at: lastFiredAt.toISOString(), cooldown_resets_at: inCooldown ? resetsAt.toISOString() : null };
  };
  _require.cache[ENGINE_PATH] = fakeMod(ENGINE_PATH, { runWorkflow: vi.fn(), resumeWorkflow: vi.fn(), computeCooldownStatus });
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
});

describe('GET /api/workflows/:id', () => {
  it('returns the workflow scoped to req.orgId', async () => {
    const row = { id: 'w1', org_id: 'o1', name: 'NPS Recovery', nodes: [], edges: [], trigger_type: 'survey.response_filtered' };
    dbQuery = vi.fn(async (text, params) => {
      if (text.includes('FROM workflows WHERE id = $1 AND org_id = $2')) {
        expect(params).toEqual(['w1', 'o1']);
        return { rows: [row] };
      }
      return { rows: [] };
    });
    const { status, body } = await api(buildApp(), 'GET', '/api/workflows/w1');
    expect(status).toBe(200);
    // cooldown_status is computed on every GET response (C-004) — null here since
    // this row has no cooldown_minutes set (existing behavior, not a regression).
    expect(body).toEqual({ workflow: { ...row, cooldown_status: null } });
  });

  it('404s when the workflow does not exist', async () => {
    dbQuery = vi.fn(async () => ({ rows: [] }));
    const { status, body } = await api(buildApp(), 'GET', '/api/workflows/does-not-exist');
    expect(status).toBe(404);
    expect(body.error).toMatch(/not found/i);
  });

  it('404s (not a cross-org leak) when the workflow belongs to a different org', async () => {
    // The query itself is org-scoped (WHERE id = $1 AND org_id = $2), so a workflow
    // owned by another org simply never matches the row — same 404 as "doesn't exist",
    // which is the correct behavior (no distinguishing signal that would leak existence).
    dbQuery = vi.fn(async (text, params) => {
      if (text.includes('FROM workflows WHERE id = $1 AND org_id = $2')) {
        expect(params).toEqual(['w1', 'o1']); // never queries without the caller's own org_id
        return { rows: [] }; // row exists in the DB, but for org_id != 'o1', so no match
      }
      return { rows: [] };
    });
    const { status } = await api(buildApp(), 'GET', '/api/workflows/w1');
    expect(status).toBe(404);
  });
});

describe('PUT /api/workflows/:id — extended graph fields', () => {
  it('persists description/triggerType/nodes/edges when present, alongside the existing fields', async () => {
    let updateCall = null;
    dbQuery = vi.fn(async (text, params) => {
      if (text.startsWith('UPDATE workflows')) { updateCall = [text, params]; return { rows: [] }; }
      return { rows: [] };
    });
    const payload = {
      name: 'Updated name',
      description: 'Escalates negative NPS to Slack',
      triggerType: 'survey.response_filtered',
      nodes: [{ id: 'n1', type: 'trigger' }],
      edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
      status: 'active',
    };
    const { status, body } = await api(buildApp(), 'PUT', '/api/workflows/w1', payload);
    expect(status).toBe(200);
    expect(body).toEqual({ success: true });

    expect(updateCall).toBeTruthy();
    const [sql, params] = updateCall;
    expect(sql).toContain('name = $');
    expect(sql).toContain('status = $');
    expect(sql).toContain('description = $');
    expect(sql).toContain('trigger_type = $');
    expect(sql).toContain('nodes = $');
    expect(sql).toContain('edges = $');
    expect(sql).toMatch(/nodes = \$\d+::jsonb/);
    expect(sql).toMatch(/edges = \$\d+::jsonb/);
    // Wave 11 (Nina, 2026-07-02, §10a/§10b): every successful PUT now also sets
    // updated_by (audit trail) and increments version (optimistic lock),
    // unconditionally — see routes/workflows.ts.
    expect(sql).toContain('updated_by = $');
    expect(sql).toContain('version = version + 1');
    // vals order mirrors the handler's destructure/sets order:
    // name, condition(absent), action(absent), status, description, triggerType,
    // nodes(json), edges(json), updated_by, id, orgId
    expect(params).toEqual([
      'Updated name',
      'active',
      'Escalates negative NPS to Slack',
      'survey.response_filtered',
      JSON.stringify(payload.nodes),
      JSON.stringify(payload.edges),
      'u1',
      'w1',
      'o1',
    ]);
  });

  it('omits graph fields from the SET list when not present in the request (partial update)', async () => {
    let updateCall = null;
    dbQuery = vi.fn(async (text, params) => {
      if (text.startsWith('UPDATE workflows')) { updateCall = [text, params]; return { rows: [] }; }
      return { rows: [] };
    });
    const { status } = await api(buildApp(), 'PUT', '/api/workflows/w1', { name: 'Just a rename' });
    expect(status).toBe(200);
    const [sql, params] = updateCall;
    expect(sql).not.toContain('description');
    expect(sql).not.toContain('trigger_type');
    expect(sql).not.toContain('nodes');
    expect(sql).not.toContain('edges');
    // updated_by/version are always set regardless of which other fields are
    // present — see the test above.
    expect(params).toEqual(['Just a rename', 'u1', 'w1', 'o1']);
  });

  it('scopes the UPDATE to the caller org (WHERE id = $x AND org_id = $y)', async () => {
    let updateCall = null;
    dbQuery = vi.fn(async (text, params) => {
      if (text.startsWith('UPDATE workflows')) { updateCall = [text, params]; return { rows: [] }; }
      return { rows: [] };
    });
    await api(buildApp(), 'PUT', '/api/workflows/w1', { nodes: [], edges: [] });
    const [sql, params] = updateCall;
    // Wave 11: RETURNING * now follows the WHERE clause (needed for the audit
    // diff / new `version` field in the response) — no longer the literal end
    // of the string, but the WHERE clause itself is unchanged.
    expect(sql).toMatch(/WHERE id = \$\d+ AND org_id = \$\d+ RETURNING \*$/);
    expect(params.slice(-2)).toEqual(['w1', 'o1']);
  });

  it('sends cooldown_minutes explicitly as null to clear an existing cooldown (not omitted)', async () => {
    let updateCall = null;
    dbQuery = vi.fn(async (text, params) => {
      if (text.startsWith('UPDATE workflows')) { updateCall = [text, params]; return { rows: [] }; }
      return { rows: [] };
    });
    const { status } = await api(buildApp(), 'PUT', '/api/workflows/w1', { cooldown_minutes: null });
    expect(status).toBe(200);
    const [sql, params] = updateCall;
    expect(sql).toContain('cooldown_minutes = $');
    expect(params).toEqual([null, 'u1', 'w1', 'o1']);
  });
});

// Cooldown API contract round-trip (C-004) — see
// docs/automation-hub/BUILDER_REBUILD_SPEC.md §5.3 for the exact shape Elias's
// builder UI depends on.
describe('cooldown_minutes / cooldown_status — API contract (C-004)', () => {
  it('POST /api/workflows persists cooldown_minutes and echoes a computed cooldown_status back', async () => {
    const created = {
      id: 'w1', org_id: 'o1', name: 'NPS Alert', nodes: [], edges: [],
      trigger_type: 'score.nps_drop', cooldown_minutes: 240, cooldown_last_fired_at: null,
    };
    let insertParams = null;
    dbQuery = vi.fn(async (text, params) => {
      if (text.startsWith('INSERT INTO workflows')) { insertParams = params; return { rows: [created] }; }
      return { rows: [] };
    });
    const { status, body } = await api(buildApp(), 'POST', '/api/workflows', {
      name: 'NPS Alert', triggerType: 'score.nps_drop', cooldown_minutes: 240,
    });
    expect(status).toBe(201);
    expect(insertParams).toContain(240);
    expect(body.workflow.cooldown_status).toEqual({
      in_cooldown: false, cooldown_minutes: 240, last_fired_at: null, cooldown_resets_at: null,
    });
  });

  it('PUT /api/workflows/:id updates cooldown_minutes via the dynamic SET list, alongside other fields', async () => {
    let updateCall = null;
    dbQuery = vi.fn(async (text, params) => {
      if (text.startsWith('UPDATE workflows')) { updateCall = [text, params]; return { rows: [] }; }
      return { rows: [] };
    });
    const { status } = await api(buildApp(), 'PUT', '/api/workflows/w1', { cooldown_minutes: 90 });
    expect(status).toBe(200);
    const [sql, params] = updateCall;
    expect(sql).toContain('cooldown_minutes = $');
    expect(params).toEqual([90, 'u1', 'w1', 'o1']);
  });

  it('GET /api/workflows/:id computes cooldown_status.in_cooldown: true while inside the window', async () => {
    const row = {
      id: 'w1', org_id: 'o1', name: 'NPS Alert', trigger_type: 'score.nps_drop',
      cooldown_minutes: 60, cooldown_last_fired_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    };
    dbQuery = vi.fn(async (text) => {
      if (text.includes('FROM workflows WHERE id = $1 AND org_id = $2')) return { rows: [row] };
      return { rows: [] };
    });
    const { status, body } = await api(buildApp(), 'GET', '/api/workflows/w1');
    expect(status).toBe(200);
    expect(body.workflow.cooldown_status.in_cooldown).toBe(true);
    expect(body.workflow.cooldown_status.cooldown_resets_at).not.toBeNull();
  });

  it('GET /api/workflows/:id computes cooldown_status.in_cooldown: false once the window has elapsed', async () => {
    const row = {
      id: 'w1', org_id: 'o1', name: 'NPS Alert', trigger_type: 'score.nps_drop',
      cooldown_minutes: 60, cooldown_last_fired_at: new Date(Date.now() - 90 * 60_000).toISOString(),
    };
    dbQuery = vi.fn(async (text) => {
      if (text.includes('FROM workflows WHERE id = $1 AND org_id = $2')) return { rows: [row] };
      return { rows: [] };
    });
    const { body } = await api(buildApp(), 'GET', '/api/workflows/w1');
    expect(body.workflow.cooldown_status).toEqual({
      in_cooldown: false,
      cooldown_minutes: 60,
      last_fired_at: row.cooldown_last_fired_at,
      cooldown_resets_at: null,
    });
  });

  it('GET /api/workflows/:id returns cooldown_status: null for a time.schedule trigger regardless of cooldown_minutes', async () => {
    const row = {
      id: 'w1', org_id: 'o1', name: 'Weekly Digest', trigger_type: 'time.schedule',
      cooldown_minutes: 60, cooldown_last_fired_at: new Date().toISOString(),
    };
    dbQuery = vi.fn(async (text) => {
      if (text.includes('FROM workflows WHERE id = $1 AND org_id = $2')) return { rows: [row] };
      return { rows: [] };
    });
    const { body } = await api(buildApp(), 'GET', '/api/workflows/w1');
    expect(body.workflow.cooldown_status).toBeNull();
  });

  it('GET /api/workflows (list) computes cooldown_status per-row', async () => {
    const rows = [
      { id: 'w1', org_id: 'o1', trigger_type: 'score.nps_drop', cooldown_minutes: null, cooldown_last_fired_at: null },
      { id: 'w2', org_id: 'o1', trigger_type: 'time.schedule', cooldown_minutes: 60, cooldown_last_fired_at: new Date().toISOString() },
    ];
    dbQuery = vi.fn(async (text) => {
      if (text.includes('FROM workflows WHERE org_id')) return { rows };
      return { rows: [] };
    });
    const { status, body } = await api(buildApp(), 'GET', '/api/workflows');
    expect(status).toBe(200);
    expect(body.workflows).toHaveLength(2);
    expect(body.workflows[0].cooldown_status).toBeNull(); // no cooldown configured
    expect(body.workflows[1].cooldown_status).toBeNull(); // time.schedule — not applicable
  });
});
