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
let queryMock;
// Default fixtures for the surveys/tags queries the /parse-nl route now runs
// to build the extended registry payload (Wave 12). Individual tests can
// override via `queryMock.mockImplementation(...)`.
let surveysFixture;
let tagsFixture;

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
  queryMock = vi.fn(async (sql) => {
    if (/FROM surveys/i.test(sql))     return { rows: surveysFixture };
    if (/FROM survey_tags/i.test(sql)) return { rows: tagsFixture };
    return { rows: [] };
  });
  _require.cache[DB_PATH] = fakeMod(DB_PATH, { query: queryMock, default: { query: queryMock } });
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
  surveysFixture = [{ id: 's1', name: 'Q3 NPS Survey' }];
  tagsFixture = [{ id: 't1', name: 'Onboarding' }];
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
    expect(registryArg).toEqual({
      triggers: [{ type: 'score.nps_drop', category: 'Score', label: 'NPS dropped' }],
      conditionFields: [],
      conditionOperators: [],
      actions: [],
      surveys: [{ id: 's1', name: 'Q3 NPS Survey' }],
      tags: [{ id: 't1', name: 'Onboarding' }],
    });
    expect(orgId).toBe('o1');
  });

  // Wave 12 (docs/automation-hub/BUILDER_REDESIGN_V2_SCOPE.md) — this pipeline
  // previously had zero concept of scope, silently forcing every NL-created
  // workflow org-wide. These tests cover the additive plumbing: the extended
  // registry payload sent to CrystalOS, and passing scope fields through when
  // CrystalOS returns them (or not).

  it('builds the extended registry payload with the org\'s surveys and tags (reusing the surveys/survey_tags queries, not a new fetch mechanism)', async () => {
    surveysFixture = [
      { id: 's1', name: 'Q3 NPS Survey' },
      { id: 's2', name: 'Onboarding CSAT' },
    ];
    tagsFixture = [
      { id: 't1', name: 'Onboarding' },
      { id: 't2', name: 'Churn Risk' },
    ];
    const app = buildApp();
    const { status } = await api(app, 'POST', '/api/workflows/parse-nl', { description: 'For the Q3 NPS Survey, notify Slack on NPS drop' });
    expect(status).toBe(200);

    const [, registryArg] = parseWorkflowNLMock.mock.calls[0];
    expect(registryArg.surveys).toEqual(surveysFixture);
    expect(registryArg.tags).toEqual(tagsFixture);

    // Confirms the same underlying queries GET /api/surveys and
    // GET /api/survey-tags run — org-scoped, not a new data-fetch mechanism.
    const surveysCall = queryMock.mock.calls.find(([sql]) => /FROM surveys/i.test(sql));
    const tagsCall = queryMock.mock.calls.find(([sql]) => /FROM survey_tags/i.test(sql));
    expect(surveysCall[0]).toMatch(/org_id = \$1/);
    expect(surveysCall[0]).toMatch(/deleted_at IS NULL/);
    expect(surveysCall[1]).toEqual(['o1']);
    expect(tagsCall[0]).toMatch(/org_id = \$1/);
    expect(tagsCall[1]).toEqual(['o1']);
  });

  it('passes scopeType/scopeSurveyId/scopeTagId through unchanged when CrystalOS returns a matched scope', async () => {
    parseWorkflowNLMock = vi.fn(async () => ({
      name: 'Q3 NPS Recovery',
      description: 'Notify support when Q3 NPS Survey NPS drops below 30',
      triggerType: 'score.nps_drop',
      nodes: [{ id: 'n1', type: 'trigger' }],
      edges: [],
      confidence: 0.9,
      warnings: [],
      scopeType: 'survey',
      scopeSurveyId: 's1',
    }));
    const app = buildApp();
    const { status, body } = await api(app, 'POST', '/api/workflows/parse-nl', { description: 'When the Q3 NPS Survey NPS drops below 30, notify support on Slack' });
    expect(status).toBe(200);
    expect(body.scopeType).toBe('survey');
    expect(body.scopeSurveyId).toBe('s1');
    expect(body.scopeTagId).toBeUndefined();
  });

  it('backward compatibility: a CrystalOS response that omits scope fields entirely (old/lagging deploy) still works exactly as before', async () => {
    // No scopeType/scopeSurveyId/scopeTagId at all — simulates a CrystalOS
    // deploy that predates Amara's Wave 12 change / hasn't rolled out yet.
    parseWorkflowNLMock = vi.fn(async () => ({
      name: 'NPS Recovery',
      description: 'Notify support when NPS drops below 30',
      triggerType: 'score.nps_drop',
      nodes: [{ id: 'n1', type: 'trigger' }],
      edges: [],
      confidence: 0.92,
      warnings: [],
    }));
    const app = buildApp();
    const { status, body } = await api(app, 'POST', '/api/workflows/parse-nl', { description: 'When NPS drops below 30, notify support on Slack' });
    expect(status).toBe(200);
    // Byte-identical to pre-Wave-12 behavior: no scope keys leak into the
    // response, and none of the existing fields are disturbed.
    expect(body).toEqual({
      name: 'NPS Recovery',
      description: 'Notify support when NPS drops below 30',
      triggerType: 'score.nps_drop',
      nodes: [{ id: 'n1', type: 'trigger' }],
      edges: [],
      confidence: 0.92,
      warnings: [],
    });
    expect(body.scopeType).toBeUndefined();
    expect(body.scopeSurveyId).toBeUndefined();
    expect(body.scopeTagId).toBeUndefined();
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
