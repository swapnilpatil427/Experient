// Regression coverage for GET /api/workflows/:id/executions (Nina, 2026-07-01,
// DEEP_AUDIT_PM_FINDINGS.md §4/§9a, DEEP_AUDIT_UX_FINDINGS.md §3.5 finding
// R-1/R-2). Previously this endpoint returned only a bare `step_count` per
// execution — never per-step `output`/`error_message`/`status`, and
// `error_message` was a raw, untranslated exception string. Now: a `steps` array
// per execution (node_id/node_type/status/output/humanized error_message) plus
// dead-letter/retry columns, and both execution- and step-level error_message
// are humanized objects ({ raw, message, matched }) at the response boundary
// (the DB value itself is never mutated — see lib/humanizeExecutionError.ts).
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
  _require.cache[ENGINE_PATH] = fakeMod(ENGINE_PATH, { runWorkflow: vi.fn(), resumeWorkflow: vi.fn(), computeCooldownStatus: () => null });
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
});

describe('GET /api/workflows/:id/executions', () => {
  it('returns dead-letter/retry columns and a steps array per execution, with humanized error_message', async () => {
    dbQuery = vi.fn(async (text, params) => {
      if (text.includes('FROM workflow_executions e')) {
        return { rows: [{
          id: 'exec-1', trigger_type: 'score.nps_drop', status: 'failed',
          triggered_at: '2026-07-01T00:00:00Z', completed_at: '2026-07-01T00:00:05Z', duration_ms: 5000,
          error_message: 'Request failed with status code 401',
          attempt_count: 2, next_retry_at: '2026-07-01T01:00:00Z', dead_letter: false,
          step_count: 2,
        }] };
      }
      if (text.includes('FROM workflow_step_executions') && text.includes('ANY')) {
        expect(params[0]).toEqual(['exec-1']);
        return { rows: [
          { execution_id: 'exec-1', node_id: 'a1', node_type: 'notify.in_app', status: 'skipped', output: { reason: 'role_has_no_members' }, error_message: null, created_at: '2026-07-01T00:00:01Z' },
          { execution_id: 'exec-1', node_id: 'a2', node_type: 'jira.create_issue', status: 'failed', output: {}, error_message: 'Request failed with status code 401', created_at: '2026-07-01T00:00:02Z' },
        ] };
      }
      return { rows: [] };
    });
    const { status, body } = await api(buildApp(), 'GET', '/api/workflows/w1/executions');
    expect(status).toBe(200);
    expect(body.executions).toHaveLength(1);
    const exec = body.executions[0];

    // Dead-letter/retry columns now surfaced (audit §9a).
    expect(exec.attempt_count).toBe(2);
    expect(exec.next_retry_at).toBe('2026-07-01T01:00:00Z');
    expect(exec.dead_letter).toBe(false);

    // Execution-level error_message is humanized, raw preserved.
    expect(exec.error_message.raw).toBe('Request failed with status code 401');
    expect(exec.error_message.matched).toBe(true);
    expect(exec.error_message.message).toMatch(/credentials/i);

    // Per-step detail now present (was previously only a bare step_count).
    expect(exec.steps).toHaveLength(2);
    expect(exec.steps[0]).toEqual({
      nodeId: 'a1', nodeType: 'notify.in_app', status: 'skipped',
      output: { reason: 'role_has_no_members' }, errorMessage: null,
    });
    expect(exec.steps[1].nodeId).toBe('a2');
    expect(exec.steps[1].status).toBe('failed');
    expect(exec.steps[1].errorMessage.raw).toBe('Request failed with status code 401');
    expect(exec.steps[1].errorMessage.matched).toBe(true);
  });

  it('a skipped step with no error_message gets a null errorMessage (not a humanized-null object)', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('FROM workflow_executions e')) {
        return { rows: [{ id: 'exec-2', trigger_type: 'time.schedule', status: 'completed', triggered_at: 't', completed_at: 't2', duration_ms: 10, error_message: null, attempt_count: 0, next_retry_at: null, dead_letter: false, step_count: 1 }] };
      }
      if (text.includes('FROM workflow_step_executions')) {
        return { rows: [{ execution_id: 'exec-2', node_id: 'a1', node_type: 'notify.in_app', status: 'skipped', output: { reason: 'no_recipient_configured' }, error_message: null, created_at: 't' }] };
      }
      return { rows: [] };
    });
    const { body } = await api(buildApp(), 'GET', '/api/workflows/w1/executions');
    expect(body.executions[0].error_message).toBeNull();
    expect(body.executions[0].steps[0].errorMessage).toBeNull();
    expect(body.executions[0].steps[0].output).toEqual({ reason: 'no_recipient_configured' });
  });

  it('returns an empty steps array (not undefined) for an execution with zero steps', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('FROM workflow_executions e')) {
        return { rows: [{ id: 'exec-3', trigger_type: 'time.schedule', status: 'cooldown', triggered_at: 't', completed_at: 't', duration_ms: 0, error_message: 'Suppressed by cooldown', attempt_count: 0, next_retry_at: null, dead_letter: false, step_count: 0 }] };
      }
      return { rows: [] }; // no step rows at all — execIds query still runs but returns nothing
    });
    const { body } = await api(buildApp(), 'GET', '/api/workflows/w1/executions');
    expect(body.executions[0].steps).toEqual([]);
  });

  it('does not run the batched per-step query at all when there are zero executions', async () => {
    // The executions query's own step_count subquery legitimately mentions
    // "FROM workflow_step_executions" — the thing under test is the SEPARATE,
    // batched `WHERE execution_id = ANY(...)` query, which should never fire
    // when execIds is empty (matches on "ANY" to distinguish the two).
    dbQuery = vi.fn(async (text) => {
      if (text.includes('FROM workflow_executions e')) return { rows: [] };
      return { rows: [] };
    });
    const app = buildApp();
    await api(app, 'GET', '/api/workflows/w1/executions');
    expect(dbQuery.mock.calls.some(([sql]) => sql.includes('FROM workflow_step_executions') && sql.includes('ANY'))).toBe(false);
    expect(dbQuery.mock.calls).toHaveLength(1); // only the executions query ran
  });

  it('still returns an empty executions array (not a 500) when the table does not exist yet (42P01)', async () => {
    dbQuery = vi.fn(async () => { const e = new Error('relation "workflow_executions" does not exist'); e.code = '42P01'; throw e; });
    const { status, body } = await api(buildApp(), 'GET', '/api/workflows/w1/executions');
    expect(status).toBe(200);
    expect(body.executions).toEqual([]);
  });
});
