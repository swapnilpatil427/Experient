// Regression coverage for POST /api/experience/:scope/crystal/stream — Wave 15
// (docs/automation-hub/TRACKER.md "Wave 15 — Wire the workflow-builder Crystal
// icon into the existing workflow-analyst skill"). This route is the SHARED
// Crystal proxy called by EVERY Crystal conversation in the app (Insights
// pages, org portfolio, group insights, AND the workflow builder's Crystal
// icon) — so the top priority here is proving the change is byte-identical
// for every caller that doesn't opt into builder context, exactly like the
// Wave 12 "omitted scope fields" precedent in workflowsParseNl.test.js.
//
// Builder context is signalled by two additive, optional body fields:
//   - `surface: 'workflow_builder'`     — the presence/detection trigger
//   - `builder_draft: <BuilderDraftSummary>` — relayed to CrystalOS unchanged
// When present, this route reuses the exact routes/workflows.ts POST /parse-nl
// query pattern (Wave 12) to attach `workflow_registry` to the forwarded body.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import inject from 'light-my-request';
import express from 'express';
import { PassThrough } from 'node:stream';

const __dirname = dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);

const AUTH_PATH   = _require.resolve(resolve(__dirname, '../middleware/auth'));
const DB_PATH     = _require.resolve(resolve(__dirname, '../lib/db'));
const LOGGER_PATH = _require.resolve(resolve(__dirname, '../lib/logger'));
const CREDITS_PATH = _require.resolve(resolve(__dirname, '../lib/creditLedger'));
const REG_PATH    = _require.resolve(resolve(__dirname, '../lib/workflowRegistry'));
const FETCH_PATH  = _require.resolve('node-fetch');
const ROUTER_PATH = _require.resolve(resolve(__dirname, '../routes/experience'));

function fakeMod(id, exports) { return { id, filename: id, loaded: true, exports, children: [] }; }

let queryMock;
let checkCreditsMock;
let debitCreditsMock;
let fetchMock;
// insights/topics/metrics/survey rows returned by loadCrystalContext's queries —
// kept empty by default so agentBody's context-derived fields are predictable.
let insightsFixture, topicsFixture, metricsFixture, surveyRowFixture;
let surveysFixture, tagsFixture;

function makeAgentStreamResponse() {
  const body = new PassThrough();
  body.end();
  return { ok: true, body };
}

function buildApp() {
  _require.cache[AUTH_PATH] = fakeMod(AUTH_PATH, {
    requireAuth: (req, res, next) => { req.orgId = 'o1'; req.userId = 'u1'; next(); },
  });
  queryMock = vi.fn(async (sql) => {
    if (/FROM insights/i.test(sql))          return { rows: insightsFixture };
    if (/FROM survey_topics/i.test(sql))     return { rows: topicsFixture };
    if (/FROM survey_metric_snapshots/i.test(sql)) return { rows: metricsFixture };
    if (/FROM surveys s WHERE id/i.test(sql)) return { rows: surveyRowFixture };
    if (/FROM surveys WHERE org_id/i.test(sql)) return { rows: surveysFixture };
    if (/FROM survey_tags/i.test(sql))       return { rows: tagsFixture };
    return { rows: [] };
  });
  _require.cache[DB_PATH] = fakeMod(DB_PATH, { query: queryMock, default: { query: queryMock } });
  _require.cache[LOGGER_PATH] = fakeMod(LOGGER_PATH, {
    info:  vi.fn(),
    error: vi.fn(),
    warn:  vi.fn(),
    debug: vi.fn(),
  });
  checkCreditsMock = vi.fn(async () => ({ ok: true, required: 1, available: 100 }));
  debitCreditsMock = vi.fn(async () => {});
  _require.cache[CREDITS_PATH] = fakeMod(CREDITS_PATH, {
    checkCredits: checkCreditsMock,
    debitCredits: debitCreditsMock,
  });
  _require.cache[REG_PATH] = fakeMod(REG_PATH, {
    registry: () => ({
      triggers: [{ type: 'score.nps_drop', category: 'Score', label: 'NPS dropped' }],
      conditionFields: [],
      conditionOperators: [],
      actions: [],
    }),
  });
  fetchMock = vi.fn(async () => makeAgentStreamResponse());
  _require.cache[FETCH_PATH] = fakeMod(FETCH_PATH, { default: fetchMock, __esModule: true });

  delete _require.cache[ROUTER_PATH];
  const router = _require(ROUTER_PATH);
  const app = express();
  app.use(express.json());
  app.use('/api/experience', router.default || router);
  return app;
}

async function api(app, method, url, body = null) {
  const opts = { method, url };
  if (body !== null) { opts.payload = JSON.stringify(body); opts.headers = { 'content-type': 'application/json' }; }
  return inject(app, opts);
}

beforeEach(() => {
  insightsFixture = [];
  topicsFixture = [];
  metricsFixture = [];
  surveyRowFixture = [];
  surveysFixture = [{ id: 's1', name: 'Q3 NPS Survey' }];
  tagsFixture = [{ id: 't1', name: 'Onboarding' }];
});

describe('POST /api/experience/:scope/crystal/stream — Wave 15 builder context', () => {
  it('byte-identical regression: a request WITHOUT builder-context fields (every existing caller today) produces the exact same agentBody sent to CrystalOS as before this change', async () => {
    const app = buildApp();
    const reqBody = { message: 'What is our NPS trend?', survey_id: '', insights: [], topics: [], metrics: {} };
    const res = await api(app, 'POST', '/api/experience/org/crystal/stream', reqBody);
    expect(res.statusCode).toBe(200);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8001/insights/crystal/stream');
    const sentBody = JSON.parse(opts.body);

    // Exactly the pre-Wave-15 shape: no workflow_registry, no builder_draft key present
    // at all (not even `undefined` — Object.keys must not include them).
    expect(Object.prototype.hasOwnProperty.call(sentBody, 'workflow_registry')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(sentBody, 'builder_draft')).toBe(false);
    expect(sentBody).toEqual({
      message: 'What is our NPS trend?',
      survey_id: '',
      insights: [],
      topics: [],
      // Org-scope loadCrystalContext always shapes metrics as { portfolio: [...] }
      // (see experience.ts's org branch) — empty here since no survey rows are fixtured.
      metrics: { portfolio: [] },
      org_id: 'o1',
      user_id: 'u1',
      scope: 'org',
      survey_title: '',
      survey_response_count: 0,
    });
  });

  it('with builder-context fields present, attaches workflow_registry (registry() + surveys/tags) and relays builder_draft unchanged', async () => {
    surveysFixture = [
      { id: 's1', name: 'Q3 NPS Survey' },
      { id: 's2', name: 'Onboarding CSAT' },
    ];
    tagsFixture = [{ id: 't1', name: 'Onboarding' }];
    const app = buildApp();
    const builderDraft = { nodes: [{ id: 'n1', type: 'trigger' }], edges: [], triggerType: 'score.nps_drop' };
    const reqBody = {
      message: 'Help me finish this workflow',
      surface: 'workflow_builder',
      builder_draft: builderDraft,
    };
    const res = await api(app, 'POST', '/api/experience/org/crystal/stream', reqBody);
    expect(res.statusCode).toBe(200);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, opts] = fetchMock.mock.calls[0];
    const sentBody = JSON.parse(opts.body);

    expect(sentBody.builder_draft).toEqual(builderDraft);
    expect(sentBody.workflow_registry).toEqual({
      triggers: [{ type: 'score.nps_drop', category: 'Score', label: 'NPS dropped' }],
      conditionFields: [],
      conditionOperators: [],
      actions: [],
      surveys: surveysFixture,
      tags: tagsFixture,
    });
    expect(sentBody.surface).toBe('workflow_builder');

    // Assert on the actual DB query calls — same org-scoped shape as parse-nl's Wave 12 queries.
    const surveysCall = queryMock.mock.calls.find(([sql]) => /FROM surveys WHERE org_id/i.test(sql));
    const tagsCall = queryMock.mock.calls.find(([sql]) => /FROM survey_tags/i.test(sql));
    expect(surveysCall[0]).toMatch(/org_id = \$1/);
    expect(surveysCall[0]).toMatch(/deleted_at IS NULL/);
    expect(surveysCall[1]).toEqual(['o1']);
    expect(tagsCall[0]).toMatch(/org_id = \$1/);
    expect(tagsCall[1]).toEqual(['o1']);
  });

  it('does NOT run the surveys/tags queries when builder context is absent (cheap no-op proof via call-count, not just output)', async () => {
    const app = buildApp();
    const res = await api(app, 'POST', '/api/experience/survey/crystal/stream', { message: 'hi', survey_id: 'sv1' });
    expect(res.statusCode).toBe(200);

    const surveysCall = queryMock.mock.calls.find(([sql]) => /FROM surveys WHERE org_id/i.test(sql));
    const tagsCall = queryMock.mock.calls.find(([sql]) => /FROM survey_tags/i.test(sql));
    expect(surveysCall).toBeUndefined();
    expect(tagsCall).toBeUndefined();

    // Only the loadCrystalContext queries ran (insights/topics/metrics/survey-row) —
    // confirms no extra registry-fetch query snuck in for a non-builder call.
    const ranSql = queryMock.mock.calls.map(([sql]) => sql);
    expect(ranSql.some(sql => /FROM insights/i.test(sql))).toBe(true);
    expect(ranSql.every(sql => !/FROM survey_tags/i.test(sql))).toBe(true);
  });

  it('credit metering (checkCredits) still runs identically regardless of builder context — same cost, not bypassed or double-charged', async () => {
    const app = buildApp();
    await api(app, 'POST', '/api/experience/org/crystal/stream', { message: 'plain call' });
    expect(checkCreditsMock).toHaveBeenCalledTimes(1);
    const [orgIdArg1, costArg1, typeArg1] = checkCreditsMock.mock.calls[0];
    expect(orgIdArg1).toBe('o1');
    expect(typeArg1).toBe('crystal_turn');

    checkCreditsMock.mockClear();
    debitCreditsMock.mockClear();
    const app2 = buildApp();
    await api(app2, 'POST', '/api/experience/org/crystal/stream', {
      message: 'builder call', surface: 'workflow_builder', builder_draft: {},
    });
    expect(checkCreditsMock).toHaveBeenCalledTimes(1);
    const [orgIdArg2, costArg2, typeArg2] = checkCreditsMock.mock.calls[0];
    expect(orgIdArg2).toBe('o1');
    expect(costArg2).toBe(costArg1);
    expect(typeArg2).toBe('crystal_turn');
  });

  it('returns 402 INSUFFICIENT_CREDITS before ever touching builder-context queries when the org is out of credits', async () => {
    const app = buildApp();
    checkCreditsMock.mockImplementationOnce(async () => ({ ok: false, required: 1, available: 0 }));
    const res = await api(app, 'POST', '/api/experience/org/crystal/stream', {
      message: 'builder call', surface: 'workflow_builder', builder_draft: {},
    });
    expect(res.statusCode).toBe(402);
    expect(res.json().code).toBe('INSUFFICIENT_CREDITS');
    expect(fetchMock).not.toHaveBeenCalled();
    const surveysCall = queryMock.mock.calls.find(([sql]) => /FROM surveys WHERE org_id/i.test(sql));
    expect(surveysCall).toBeUndefined();
  });
});

// Wave 18c (docs/automation-hub/TRACKER.md "Wave 18c — Full org registry for the
// message-content force route") — closes the gap Amara flagged in Wave 18: her
// CrystalOS-side `_is_workflow_taxonomy_question` detector force-routes
// trigger/action/condition REFERENCE questions to `workflow-analyst` from ANY
// page (not just the workflow builder), but this Node proxy only ever attached
// `workflow_registry` when `surface === 'workflow_builder'` — so a taxonomy
// question from, say, the Insights page reached the skill with no live registry
// and CrystalOS substituted its smaller, code-defined `FALLBACK_REGISTRY`.
//
// Fix: `mentionsWorkflowTaxonomy` (routes/experience.ts) is a deliberately
// narrow, conservative TypeScript mirror of Amara's Python regex allowlist —
// not a call into it (Node can't reach the CrystalOS process). Its precision
// bar is much lower than hers: a false positive here just costs 2 extra cheap,
// indexed, read-only queries, never a wrong answer (unlike her detector, which
// decides ROUTING). So it intentionally trades precision for simplicity/recall
// relative to her allowlist.
describe('POST /api/experience/:scope/crystal/stream — Wave 18c message-content registry attach', () => {
  it('a workflow-taxonomy-shaped message from a NON-workflow_builder surface now DOES get workflow_registry attached (the literal Wave 18c fix)', async () => {
    surveysFixture = [{ id: 's1', name: 'Q3 NPS Survey' }];
    tagsFixture = [{ id: 't1', name: 'Onboarding' }];
    const app = buildApp();
    // No `surface` field at all — mirrors a real Insights-page caller, exactly
    // the reported bug's origin (Wave 18's tracker entry).
    const res = await api(app, 'POST', '/api/experience/org/crystal/stream', {
      message: 'What types of trigger exists?',
    });
    expect(res.statusCode).toBe(200);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, opts] = fetchMock.mock.calls[0];
    const sentBody = JSON.parse(opts.body);

    expect(sentBody.workflow_registry).toEqual({
      triggers: [{ type: 'score.nps_drop', category: 'Score', label: 'NPS dropped' }],
      conditionFields: [],
      conditionOperators: [],
      actions: [],
      surveys: surveysFixture,
      tags: tagsFixture,
    });
    // builder_draft is still correctly NOT relayed — this request never claimed
    // to be in builder context, only that the message references the taxonomy.
    expect(Object.prototype.hasOwnProperty.call(sentBody, 'builder_draft')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(sentBody, 'surface')).toBe(false);

    const surveysCall = queryMock.mock.calls.find(([sql]) => /FROM surveys WHERE org_id/i.test(sql));
    const tagsCall = queryMock.mock.calls.find(([sql]) => /FROM survey_tags/i.test(sql));
    expect(surveysCall).toBeDefined();
    expect(tagsCall).toBeDefined();
  });

  it('a normal survey-data question from a non-builder surface does NOT trigger the extra registry queries', async () => {
    const app = buildApp();
    const res = await api(app, 'POST', '/api/experience/org/crystal/stream', {
      message: 'Why did NPS drop?',
    });
    expect(res.statusCode).toBe(200);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, opts] = fetchMock.mock.calls[0];
    const sentBody = JSON.parse(opts.body);

    expect(Object.prototype.hasOwnProperty.call(sentBody, 'workflow_registry')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(sentBody, 'builder_draft')).toBe(false);

    const surveysCall = queryMock.mock.calls.find(([sql]) => /FROM surveys WHERE org_id/i.test(sql));
    const tagsCall = queryMock.mock.calls.find(([sql]) => /FROM survey_tags/i.test(sql));
    expect(surveysCall).toBeUndefined();
    expect(tagsCall).toBeUndefined();
  });

  it('a workflow_builder surface call is unaffected by the new message-content condition (still gets the registry via isBuilderContext, still relays builder_draft)', async () => {
    const app = buildApp();
    const builderDraft = { nodes: [], edges: [], triggerType: null };
    const res = await api(app, 'POST', '/api/experience/org/crystal/stream', {
      message: 'help me build this',
      surface: 'workflow_builder',
      builder_draft: builderDraft,
    });
    expect(res.statusCode).toBe(200);
    const [, opts] = fetchMock.mock.calls[0];
    const sentBody = JSON.parse(opts.body);
    expect(sentBody.workflow_registry).toBeDefined();
    expect(sentBody.builder_draft).toEqual(builderDraft);
  });

  it('does not choke on a non-string message (e.g. absent/undefined) when deciding whether to attach the registry', async () => {
    const app = buildApp();
    const res = await api(app, 'POST', '/api/experience/survey/crystal/stream', { survey_id: 'sv1' });
    expect(res.statusCode).toBe(200);
    const [, opts] = fetchMock.mock.calls[0];
    const sentBody = JSON.parse(opts.body);
    expect(Object.prototype.hasOwnProperty.call(sentBody, 'workflow_registry')).toBe(false);
  });
});
