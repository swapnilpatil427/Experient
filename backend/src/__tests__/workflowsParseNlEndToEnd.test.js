// Wave 12 Phase 3 (Kenji, TRACKER.md) — end-to-end SEAM regression for
// POST /api/workflows/parse-nl.
//
// Why this file exists alongside workflowsParseNl.test.js: that file (Nina's,
// Phase 1) mocks `lib/agentsClient` wholesale, so it proves the ROUTE's own
// mapping logic is correct assuming agentsClient hands it a well-shaped
// object — it never actually exercises agentsClient.ts's own response-shape
// mapping code (the JSON body -> ParseWorkflowNLSuccess cast, the 422
// re-parsing branch). Two independently-correct layers can still disagree at
// the wire boundary (key naming, null vs. absent, camelCase vs. snake_case)
// in exactly the code this file mocks away.
//
// This file instead fakes ONLY the true external boundary — `node-fetch`,
// the one thing agentsClient.ts itself imports to talk to CrystalOS — so the
// REAL `agentsClient.parseWorkflowNL` and the REAL route handler both run,
// end to end, against a raw HTTP-shaped response exactly as CrystalOS's
// `POST /workflows/parse-nl` endpoint would actually produce it (see
// crystalos/main.py's `parse_workflow_nl_endpoint` return dict / 422
// JSONResponse body).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import inject from 'light-my-request';
import express from 'express';

const __dirname = dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);

const AUTH_PATH    = _require.resolve(resolve(__dirname, '../middleware/auth'));
const PERM_PATH    = _require.resolve(resolve(__dirname, '../middleware/requirePermission'));
const DB_PATH      = _require.resolve(resolve(__dirname, '../lib/db'));
const ENGINE_PATH  = _require.resolve(resolve(__dirname, '../lib/workflowEngine'));
const REG_PATH     = _require.resolve(resolve(__dirname, '../lib/workflowRegistry'));
const FETCH_PATH   = _require.resolve('node-fetch');
const AGENTS_PATH  = _require.resolve(resolve(__dirname, '../lib/agentsClient'));
const ROUTER_PATH  = _require.resolve(resolve(__dirname, '../routes/workflows'));

function fakeMod(id, exports) { return { id, filename: id, loaded: true, exports, children: [] }; }

let queryMock;
let surveysFixture;
let tagsFixture;
// Controls what the faked node-fetch call returns — this is the ONLY seam
// faked in this file, standing in for CrystalOS's actual HTTP response.
let crystalOsResponse;

function buildApp() {
  _require.cache[AUTH_PATH] = fakeMod(AUTH_PATH, {
    requireAuth: (req, res, next) => { req.orgId = 'o1'; req.userId = 'u1'; next(); },
  });
  _require.cache[PERM_PATH] = fakeMod(PERM_PATH, {
    requirePermission: () => (req, res, next) => next(),
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

  // Fake node-fetch: the real transport boundary. `crystalOsResponse` fully
  // controls status/body, exactly like a real fetch() Response.
  const fetchMock = vi.fn(async () => ({
    ok: crystalOsResponse.status >= 200 && crystalOsResponse.status < 300,
    status: crystalOsResponse.status,
    json: async () => crystalOsResponse.body,
    text: async () => JSON.stringify(crystalOsResponse.body),
  }));
  _require.cache[FETCH_PATH] = fakeMod(FETCH_PATH, { default: fetchMock, __esModule: true });

  // Real agentsClient.ts loaded fresh against the faked node-fetch above —
  // its own response-shape mapping code genuinely executes.
  delete _require.cache[AGENTS_PATH];
  delete _require.cache[ROUTER_PATH];
  const router = _require(ROUTER_PATH);
  const app = express();
  app.use(express.json());
  app.use('/api/workflows', router.default || router);
  return { app, fetchMock };
}

async function api(app, method, url, body = null) {
  const opts = { method, url };
  if (body !== null) { opts.payload = JSON.stringify(body); opts.headers = { 'content-type': 'application/json' }; }
  const res = await inject(app, opts);
  return { status: res.statusCode, body: res.json() };
}

beforeEach(() => {
  surveysFixture = [{ id: 's1', name: 'Q3 NPS Survey' }];
  tagsFixture = [{ id: 't1', name: 'Onboarding' }];
  crystalOsResponse = {
    status: 200,
    body: {
      name: 'NPS Recovery',
      description: 'Notify support when NPS drops below 30',
      triggerType: 'score.nps_drop',
      nodes: [{ id: 'n1', type: 'trigger' }],
      edges: [],
      confidence: 0.92,
      warnings: [],
      scopeType: 'org',
      scopeSurveyId: null,
      scopeTagId: null,
    },
  };
});

describe('POST /api/workflows/parse-nl — real agentsClient + real route, faked node-fetch only', () => {
  it('sends the exact wire shape agentsClient.parseWorkflowNL constructs (org_id/description/registry) to CrystalOS', async () => {
    const { app, fetchMock } = buildApp();
    await api(app, 'POST', '/api/workflows/parse-nl', { description: 'When NPS drops below 30, notify support on Slack' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/workflows\/parse-nl$/);
    const sentBody = JSON.parse(opts.body);
    // Field-for-field: this is EXACTLY what crystalos/main.py's
    // parse_workflow_nl_endpoint reads via body.get("org_id")/body.get("description")/body.get("registry").
    expect(Object.keys(sentBody).sort()).toEqual(['description', 'org_id', 'registry']);
    expect(sentBody.org_id).toBe('o1');
    expect(sentBody.description).toBe('When NPS drops below 30, notify support on Slack');
    expect(sentBody.registry.surveys).toEqual(surveysFixture);
    expect(sentBody.registry.tags).toEqual(tagsFixture);
    // Auth: the internal key header CrystalOS's require_internal_key expects.
    expect(opts.headers['X-Internal-Key']).toBeTruthy();
  });

  it('round-trips a real CrystalOS-shaped 200 body (camelCase scope fields) to the frontend unchanged', async () => {
    crystalOsResponse = {
      status: 200,
      body: {
        name: 'Q3 NPS Recovery',
        description: 'Notify support when Q3 NPS Survey NPS drops below 30',
        triggerType: 'score.nps_drop',
        nodes: [{ id: 'n1', type: 'trigger' }],
        edges: [],
        confidence: 0.9,
        warnings: [],
        scopeType: 'survey',
        scopeSurveyId: 's1',
        scopeTagId: null,
      },
    };
    const { app } = buildApp();
    const { status, body } = await api(app, 'POST', '/api/workflows/parse-nl', { description: 'When the Q3 NPS Survey NPS drops below 30, notify support on Slack' });
    expect(status).toBe(200);
    expect(body.scopeType).toBe('survey');
    expect(body.scopeSurveyId).toBe('s1');
    // CrystalOS sent an explicit `null`, not an absent key — confirms the
    // route doesn't need to special-case null vs. undefined; both must land
    // as "no tag" to the frontend, never a hard-coded string "null".
    expect(body.scopeTagId).toBeNull();
  });

  it('THE critical test: a CrystalOS 200 body that omits scopeType/scopeSurveyId/scopeTagId entirely (old/lagging deploy mid-rollout) produces a response genuinely indistinguishable from pre-Wave-12', async () => {
    // No scope keys at all on the wire — not null, not undefined-but-present,
    // literally absent from the JSON CrystalOS sent. This is the exact
    // shape an old CrystalOS instance mid-deploy would send, since it has
    // never heard of scope_type/scope_survey_id/scope_tag_id.
    crystalOsResponse = {
      status: 200,
      body: {
        name: 'NPS Recovery',
        description: 'Notify support when NPS drops below 30',
        triggerType: 'score.nps_drop',
        nodes: [{ id: 'n1', type: 'trigger' }],
        edges: [],
        confidence: 0.92,
        warnings: [],
        // scopeType/scopeSurveyId/scopeTagId deliberately absent.
      },
    };
    const { app } = buildApp();
    const { status, body } = await api(app, 'POST', '/api/workflows/parse-nl', { description: 'When NPS drops below 30, notify support on Slack' });
    expect(status).toBe(200);
    // Byte-identical to the pre-Wave-12 response shape: exactly these 7 keys,
    // nothing added, nothing missing.
    expect(Object.keys(body).sort()).toEqual(
      ['confidence', 'description', 'edges', 'name', 'nodes', 'triggerType', 'warnings'].sort()
    );
    expect(body).toEqual({
      name: 'NPS Recovery',
      description: 'Notify support when NPS drops below 30',
      triggerType: 'score.nps_drop',
      nodes: [{ id: 'n1', type: 'trigger' }],
      edges: [],
      confidence: 0.92,
      warnings: [],
    });
    expect('scopeType' in body).toBe(false);
    expect('scopeSurveyId' in body).toBe(false);
    expect('scopeTagId' in body).toBe(false);
  });

  it('maps a real CrystalOS 422 body (FLAT, not detail-wrapped) through agentsClient\'s re-parse to the frontend unparseable shape', async () => {
    // Exactly the shape crystalos/main.py's JSONResponse(status_code=422, ...)
    // produces — flat top-level keys, per that endpoint's explicit comment
    // about NOT using HTTPException (which FastAPI would wrap under "detail").
    crystalOsResponse = {
      status: 422,
      body: {
        error: 'unparseable',
        message: "Crystal wasn't able to match that to a valid trigger and action.",
        suggestions: ['"When NPS score drops, send a Slack message"'],
      },
    };
    const { app } = buildApp();
    const { status, body } = await api(app, 'POST', '/api/workflows/parse-nl', { description: 'do something vague' });
    expect(status).toBe(422);
    expect(body).toEqual({
      error: 'unparseable',
      message: "Crystal wasn't able to match that to a valid trigger and action.",
      suggestions: ['"When NPS score drops, send a Slack message"'],
    });
  });

  it('a real CrystalOS 422 body that were ever detail-wrapped (defensive check) would degrade to a generic message, not crash — confirms the documented risk is handled, not just avoided', async () => {
    // If a future change accidentally reintroduced HTTPException(422, detail={...}),
    // FastAPI would wrap the body as {"detail": {...}}. agentsClient's re-parse
    // expects top-level message/suggestions, so this must degrade gracefully
    // (generic message, empty suggestions) rather than throwing an unhandled error.
    crystalOsResponse = {
      status: 422,
      body: { detail: { error: 'unparseable', message: 'nested, not top-level', suggestions: ['x'] } },
    };
    const { app } = buildApp();
    const { status, body } = await api(app, 'POST', '/api/workflows/parse-nl', { description: 'do something vague' });
    expect(status).toBe(422);
    expect(body.error).toBe('unparseable');
    expect(body.message).toBe('Crystal could not turn that into a workflow');
    expect(body.suggestions).toEqual([]);
  });
});
