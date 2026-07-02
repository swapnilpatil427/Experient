// Regression coverage for POST /api/workflows/parse-nl (Nina, Wave 3 — see
// docs/automation-hub/BUILDER_SPEC_WAVE2.md §2.1 and
// docs/automation-hub/WORKFLOW_SIGNAL_CONTRACT.md). This is a thin proxy to
// CrystalOS's NL workflow parser via agentsClient.parseWorkflowNL — mocked here
// so this suite verifies routing/mapping/validation, not the LLM call itself.
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
const AGENTS_PATH = _require.resolve(resolve(__dirname, '../lib/agentsClient'));
const ROUTER_PATH = _require.resolve(resolve(__dirname, '../routes/workflows'));

class FakeUnparseableWorkflowError extends Error {
  constructor(message, suggestions = []) {
    super(message);
    this.name = 'UnparseableWorkflowError';
    this.suggestions = suggestions;
  }
}

let parseWorkflowNLMock;
let requirePermissionGranted;

function fakeMod(id, exports) { return { id, filename: id, loaded: true, exports, children: [] }; }

function buildApp() {
  _require.cache[AUTH_PATH] = fakeMod(AUTH_PATH, {
    requireAuth: (req, res, next) => { req.orgId = 'o1'; req.userId = 'u1'; next(); },
  });
  _require.cache[PERM_PATH] = fakeMod(PERM_PATH, {
    requirePermission: () => (req, res, next) => {
      if (!requirePermissionGranted) { res.status(403).json({ error: 'forbidden' }); return; }
      next();
    },
    invalidatePermissionCache: vi.fn(),
  });
  _require.cache[DB_PATH] = fakeMod(DB_PATH, { query: vi.fn(async () => ({ rows: [] })), default: { query: vi.fn(async () => ({ rows: [] })) } });
  _require.cache[ENGINE_PATH] = fakeMod(ENGINE_PATH, { runWorkflow: vi.fn(), resumeWorkflow: vi.fn() });
  _require.cache[REG_PATH] = fakeMod(REG_PATH, {
    registry: () => ({ triggers: [{ type: 'score.nps_drop', category: 'Score', label: 'NPS dropped' }], conditionFields: [], conditionOperators: [], actions: [] }),
  });
  _require.cache[AGENTS_PATH] = fakeMod(AGENTS_PATH, {
    parseWorkflowNL: parseWorkflowNLMock,
    UnparseableWorkflowError: FakeUnparseableWorkflowError,
  });
  delete _require.cache[ROUTER_PATH];
  const router = _require(ROUTER_PATH);
  const app = express();
  app.use(express.json());
  app.use('/api/workflows', router.default || router);
  return app;
}

async function api(app, method, url, body = null) {
  const opts = { method, url };
  if (body !== null) { opts.payload = JSON.stringify(body); opts.headers = { 'content-type': 'application/json' }; }
  const res = await inject(app, opts);
  return { status: res.statusCode, body: res.json() };
}

beforeEach(() => {
  requirePermissionGranted = true;
  parseWorkflowNLMock = vi.fn(async () => ({
    name: 'NPS Recovery',
    description: 'Notify support when NPS drops below 30',
    triggerType: 'score.nps_drop',
    nodes: [{ id: 'n1', type: 'trigger' }],
    edges: [],
    confidence: 0.92,
    warnings: [],
  }));
});

describe('POST /api/workflows/parse-nl', () => {
  it('requires workflows:manage — 403 when denied', async () => {
    requirePermissionGranted = false;
    const { status } = await api(buildApp(), 'POST', '/api/workflows/parse-nl', { description: 'when nps drops notify slack' });
    expect(status).toBe(403);
    expect(parseWorkflowNLMock).not.toHaveBeenCalled();
  });

  it('validates the request body — 400 on empty description', async () => {
    const { status, body } = await api(buildApp(), 'POST', '/api/workflows/parse-nl', { description: '' });
    expect(status).toBe(400);
    expect(body.error).toBeTruthy();
    expect(parseWorkflowNLMock).not.toHaveBeenCalled();
  });

  it('validates the request body — 400 when description exceeds 1000 characters', async () => {
    const { status } = await api(buildApp(), 'POST', '/api/workflows/parse-nl', { description: 'x'.repeat(1001) });
    expect(status).toBe(400);
    expect(parseWorkflowNLMock).not.toHaveBeenCalled();
  });

  it('validates the request body — 400 when description is missing entirely', async () => {
    const { status } = await api(buildApp(), 'POST', '/api/workflows/parse-nl', {});
    expect(status).toBe(400);
  });

  it('maps CrystalOS success straight through on 200, passing the registry catalog + orgId', async () => {
    const app = buildApp();
    const { status, body } = await api(app, 'POST', '/api/workflows/parse-nl', { description: 'When NPS drops below 30, notify support on Slack' });
    expect(status).toBe(200);
    expect(body).toEqual({
      name: 'NPS Recovery',
      description: 'Notify support when NPS drops below 30',
      triggerType: 'score.nps_drop',
      nodes: [{ id: 'n1', type: 'trigger' }],
      edges: [],
      confidence: 0.92,
      warnings: [],
    });

    expect(parseWorkflowNLMock).toHaveBeenCalledTimes(1);
    const [description, registryArg, orgId] = parseWorkflowNLMock.mock.calls[0];
    expect(description).toBe('When NPS drops below 30, notify support on Slack');
    expect(registryArg).toEqual({ triggers: [{ type: 'score.nps_drop', category: 'Score', label: 'NPS dropped' }], conditionFields: [], conditionOperators: [], actions: [] });
    expect(orgId).toBe('o1');
  });

  it('maps an UnparseableWorkflowError to 422 with { error, message, suggestions }', async () => {
    parseWorkflowNLMock = vi.fn(async () => {
      throw new FakeUnparseableWorkflowError('Crystal could not turn that into a workflow', ['Try: when NPS drops below 30, notify Slack']);
    });
    const { status, body } = await api(buildApp(), 'POST', '/api/workflows/parse-nl', { description: 'do something vague' });
    expect(status).toBe(422);
    expect(body).toEqual({
      error: 'unparseable',
      message: 'Crystal could not turn that into a workflow',
      suggestions: ['Try: when NPS drops below 30, notify Slack'],
    });
  });

  it('maps a CrystalOS/agentsClient timeout (AbortError) to 504', async () => {
    parseWorkflowNLMock = vi.fn(async () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    });
    const { status, body } = await api(buildApp(), 'POST', '/api/workflows/parse-nl', { description: 'when nps drops notify slack' });
    expect(status).toBe(504);
    expect(body.error).toMatch(/timed out/i);
  });

  it('maps a generic agentsClient failure to 500 via serverError (no raw error leaked)', async () => {
    parseWorkflowNLMock = vi.fn(async () => {
      throw new Error('Agents service error 500: internal boom');
    });
    const { status, body } = await api(buildApp(), 'POST', '/api/workflows/parse-nl', { description: 'when nps drops notify slack' });
    expect(status).toBe(500);
    expect(body.error).not.toMatch(/internal boom/);
  });
});
