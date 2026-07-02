// Regression coverage for workflow scope (docs/automation-hub/BUILDER_REDESIGN_V2_SCOPE.md §2 /
// BUILDER_REDESIGN_V2_CONCEPT.md §3) — the structurally important gap the user flagged
// ("how would i select which survey?"). Before this, there was no scope concept anywhere
// in the product: no column, no schema field, no engine matching logic. This file covers
// the schema-validation layer and the API round-trip (create/update/list/detail); the
// engine's actual trigger-matching behavior (the load-bearing part — a scope column alone
// would be cosmetic without it) is covered separately in workflowEngine.test.js's
// "runWorkflowsForEvent — scope filtering" describe block.
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
const SCHEMA_PATH = _require.resolve(resolve(__dirname, '../schemas/workflows'));

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
  const computeCooldownStatus = (wf) => (wf.cooldown_minutes ? null : null); // not under test here
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
  delete _require.cache[SCHEMA_PATH];
});

const SURVEY_ID = '11111111-1111-4111-8111-111111111111';
const TAG_ID    = '22222222-2222-4222-8222-222222222222';

describe('createWorkflowSchema — scope validation', () => {
  function schema() { return _require(SCHEMA_PATH).createWorkflowSchema; }

  it('defaults to org scope when no scope fields are given (backward compatible)', () => {
    const r = schema().safeParse({ name: 'X' });
    expect(r.success).toBe(true);
    expect(r.data.scopeType).toBeUndefined(); // route layer defaults the DB column to 'org'
  });

  it('accepts org scope explicitly with no ids', () => {
    const r = schema().safeParse({ name: 'X', scopeType: 'org' });
    expect(r.success).toBe(true);
  });

  it('rejects org scope with a scopeSurveyId set', () => {
    const r = schema().safeParse({ name: 'X', scopeType: 'org', scopeSurveyId: SURVEY_ID });
    expect(r.success).toBe(false);
  });

  it('accepts survey scope with scopeSurveyId', () => {
    const r = schema().safeParse({ name: 'X', scopeType: 'survey', scopeSurveyId: SURVEY_ID });
    expect(r.success).toBe(true);
  });

  it('rejects survey scope with no scopeSurveyId', () => {
    const r = schema().safeParse({ name: 'X', scopeType: 'survey' });
    expect(r.success).toBe(false);
    expect(r.error.issues.some((i) => i.path.includes('scopeSurveyId'))).toBe(true);
  });

  it('rejects survey scope with both scopeSurveyId and scopeTagId set', () => {
    const r = schema().safeParse({ name: 'X', scopeType: 'survey', scopeSurveyId: SURVEY_ID, scopeTagId: TAG_ID });
    expect(r.success).toBe(false);
  });

  it('accepts tag scope with scopeTagId', () => {
    const r = schema().safeParse({ name: 'X', scopeType: 'tag', scopeTagId: TAG_ID });
    expect(r.success).toBe(true);
  });

  it('rejects tag scope with no scopeTagId', () => {
    const r = schema().safeParse({ name: 'X', scopeType: 'tag' });
    expect(r.success).toBe(false);
    expect(r.error.issues.some((i) => i.path.includes('scopeTagId'))).toBe(true);
  });

  it('rejects a non-UUID scopeSurveyId', () => {
    const r = schema().safeParse({ name: 'X', scopeType: 'survey', scopeSurveyId: 'not-a-uuid' });
    expect(r.success).toBe(false);
  });

  it('allows survey scope for time.schedule (scope drives what a scheduled digest summarizes, not event matching)', () => {
    const r = schema().safeParse({ name: 'X', triggerType: 'time.schedule', scopeType: 'survey', scopeSurveyId: SURVEY_ID });
    expect(r.success).toBe(true);
  });

  it('allows tag scope for time.schedule (e.g. a quarterly digest across a tagged survey program)', () => {
    const r = schema().safeParse({ name: 'X', triggerType: 'time.schedule', scopeType: 'tag', scopeTagId: TAG_ID });
    expect(r.success).toBe(true);
  });

  it('rejects tag scope for external.webhook (no natural survey dimension)', () => {
    const r = schema().safeParse({ name: 'X', triggerType: 'external.webhook', scopeType: 'tag', scopeTagId: TAG_ID });
    expect(r.success).toBe(false);
  });

  it('allows org scope for time.schedule (the only scope that makes sense for it)', () => {
    const r = schema().safeParse({ name: 'X', triggerType: 'time.schedule', scopeType: 'org' });
    expect(r.success).toBe(true);
  });

  it('allows survey scope for a survey-relevant trigger type (score.nps_drop)', () => {
    const r = schema().safeParse({ name: 'X', triggerType: 'score.nps_drop', scopeType: 'survey', scopeSurveyId: SURVEY_ID });
    expect(r.success).toBe(true);
  });
});

describe('updateWorkflowSchema — scope validation', () => {
  function schema() { return _require(SCHEMA_PATH).updateWorkflowSchema; }

  it('allows a partial update that does not touch scope at all', () => {
    const r = schema().safeParse({ name: 'Renamed' });
    expect(r.success).toBe(true);
  });

  it('requires scopeType when scopeSurveyId is sent alone (ambiguous otherwise)', () => {
    const r = schema().safeParse({ scopeSurveyId: SURVEY_ID });
    expect(r.success).toBe(false);
    expect(r.error.issues.some((i) => i.path.includes('scopeType'))).toBe(true);
  });

  it('accepts a full scope change to survey', () => {
    const r = schema().safeParse({ scopeType: 'survey', scopeSurveyId: SURVEY_ID });
    expect(r.success).toBe(true);
  });

  it('accepts switching scope back to org (clears any prior id fields on the client side)', () => {
    const r = schema().safeParse({ scopeType: 'org' });
    expect(r.success).toBe(true);
  });

  it('allows survey scope combined with triggerType time.schedule in the same request', () => {
    const r = schema().safeParse({ triggerType: 'time.schedule', scopeType: 'survey', scopeSurveyId: SURVEY_ID });
    expect(r.success).toBe(true);
  });

  it('rejects tag scope combined with triggerType external.webhook in the same request', () => {
    const r = schema().safeParse({ triggerType: 'external.webhook', scopeType: 'tag', scopeTagId: TAG_ID });
    expect(r.success).toBe(false);
  });
});

describe('POST /api/workflows — scope round-trip', () => {
  it('persists scope_type=org by default and returns it on the created row', async () => {
    const created = { id: 'w1', org_id: 'o1', name: 'Org workflow', scope_type: 'org', scope_survey_id: null, scope_tag_id: null };
    let insertParams = null;
    dbQuery = vi.fn(async (text, params) => {
      if (text.startsWith('INSERT INTO workflows')) { insertParams = params; return { rows: [created] }; }
      return { rows: [] };
    });
    const { status, body } = await api(buildApp(), 'POST', '/api/workflows', { name: 'Org workflow' });
    expect(status).toBe(201);
    expect(insertParams).toContain('org');
    expect(body.workflow.scope_type).toBe('org');
  });

  it('persists survey scope end to end', async () => {
    const created = { id: 'w2', org_id: 'o1', name: 'Survey workflow', scope_type: 'survey', scope_survey_id: SURVEY_ID, scope_tag_id: null };
    let insertParams = null;
    dbQuery = vi.fn(async (text, params) => {
      if (text.startsWith('INSERT INTO workflows')) { insertParams = params; return { rows: [created] }; }
      return { rows: [] };
    });
    const { status, body } = await api(buildApp(), 'POST', '/api/workflows', {
      name: 'Survey workflow', triggerType: 'score.nps_drop', scopeType: 'survey', scopeSurveyId: SURVEY_ID,
    });
    expect(status).toBe(201);
    expect(insertParams).toContain('survey');
    expect(insertParams).toContain(SURVEY_ID);
    expect(body.workflow.scope_type).toBe('survey');
    expect(body.workflow.scope_survey_id).toBe(SURVEY_ID);
  });

  it('persists tag scope end to end', async () => {
    const created = { id: 'w3', org_id: 'o1', name: 'Tag workflow', scope_type: 'tag', scope_survey_id: null, scope_tag_id: TAG_ID };
    let insertParams = null;
    dbQuery = vi.fn(async (text, params) => {
      if (text.startsWith('INSERT INTO workflows')) { insertParams = params; return { rows: [created] }; }
      return { rows: [] };
    });
    const { status, body } = await api(buildApp(), 'POST', '/api/workflows', {
      name: 'Tag workflow', triggerType: 'score.nps_drop', scopeType: 'tag', scopeTagId: TAG_ID,
    });
    expect(status).toBe(201);
    expect(insertParams).toContain('tag');
    expect(insertParams).toContain(TAG_ID);
    expect(body.workflow.scope_type).toBe('tag');
    expect(body.workflow.scope_tag_id).toBe(TAG_ID);
  });

  it('400s at the schema layer for an invalid scope/trigger-type combination (never reaches the DB)', async () => {
    const { status, body } = await api(buildApp(), 'POST', '/api/workflows', {
      name: 'Bad', triggerType: 'external.webhook', scopeType: 'tag', scopeTagId: TAG_ID,
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/no survey dimension/);
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it('persists a tag-scoped time.schedule digest end to end (the Executive/Quarterly Digest pattern)', async () => {
    const created = { id: 'w4', org_id: 'o1', name: 'Weekly Digest', scope_type: 'tag', scope_survey_id: null, scope_tag_id: TAG_ID };
    let insertParams = null;
    dbQuery = vi.fn(async (text, params) => {
      if (text.startsWith('INSERT INTO workflows')) { insertParams = params; return { rows: [created] }; }
      return { rows: [] };
    });
    const { status, body } = await api(buildApp(), 'POST', '/api/workflows', {
      name: 'Weekly Digest', triggerType: 'time.schedule', scopeType: 'tag', scopeTagId: TAG_ID,
    });
    expect(status).toBe(201);
    expect(insertParams).toContain('tag');
    expect(insertParams).toContain(TAG_ID);
    expect(body.workflow.scope_type).toBe('tag');
    expect(body.workflow.scope_tag_id).toBe(TAG_ID);
  });
});

describe('PUT /api/workflows/:id — scope round-trip', () => {
  it('writes all three scope columns together when scopeType is present', async () => {
    let updateCall = null;
    dbQuery = vi.fn(async (text, params) => {
      if (text.startsWith('UPDATE workflows')) { updateCall = [text, params]; return { rows: [] }; }
      return { rows: [] };
    });
    const { status } = await api(buildApp(), 'PUT', '/api/workflows/w1', { scopeType: 'survey', scopeSurveyId: SURVEY_ID });
    expect(status).toBe(200);
    const [sql, params] = updateCall;
    expect(sql).toContain('scope_type = $');
    expect(sql).toContain('scope_survey_id = $');
    expect(sql).toContain('scope_tag_id = $');
    // Wave 11 (Nina, 2026-07-02, §10a/§10b): updated_by is always appended too.
    expect(params).toEqual(['survey', SURVEY_ID, null, 'u1', 'w1', 'o1']);
  });

  it('switching back to org scope nulls out both id columns', async () => {
    let updateCall = null;
    dbQuery = vi.fn(async (text, params) => {
      if (text.startsWith('UPDATE workflows')) { updateCall = [text, params]; return { rows: [] }; }
      return { rows: [] };
    });
    await api(buildApp(), 'PUT', '/api/workflows/w1', { scopeType: 'org' });
    const [, params] = updateCall;
    expect(params).toEqual(['org', null, null, 'u1', 'w1', 'o1']);
  });

  it('omits scope columns from the SET list entirely when the request does not touch scope', async () => {
    let updateCall = null;
    dbQuery = vi.fn(async (text, params) => {
      if (text.startsWith('UPDATE workflows')) { updateCall = [text, params]; return { rows: [] }; }
      return { rows: [] };
    });
    await api(buildApp(), 'PUT', '/api/workflows/w1', { name: 'Just a rename' });
    const [sql] = updateCall;
    expect(sql).not.toContain('scope_type');
    expect(sql).not.toContain('scope_survey_id');
    expect(sql).not.toContain('scope_tag_id');
  });

  it('400s when setting tag scope on a workflow whose EXISTING trigger_type has no survey dimension', async () => {
    // Wave 11 (Nina, 2026-07-02): the scope/triggerType cross-check now reuses a
    // single `SELECT * FROM workflows WHERE id = $1 AND org_id = $2` pre-fetch
    // (also used for the optimistic-lock version check and audit diff), rather
    // than its own ad-hoc `SELECT trigger_type ...` — see routes/workflows.ts.
    dbQuery = vi.fn(async (text, params) => {
      if (text.includes('FROM workflows WHERE id = $1 AND org_id = $2')) {
        expect(params).toEqual(['w1', 'o1']);
        return { rows: [{ id: 'w1', trigger_type: 'external.webhook' }] };
      }
      if (text.startsWith('UPDATE workflows')) return { rows: [] };
      return { rows: [] };
    });
    const { status, body } = await api(buildApp(), 'PUT', '/api/workflows/w1', { scopeType: 'tag', scopeTagId: TAG_ID });
    expect(status).toBe(400);
    expect(body.error).toMatch(/no survey dimension/);
  });

  it('allows setting survey scope on a workflow whose EXISTING trigger_type is time.schedule', async () => {
    dbQuery = vi.fn(async (text, params) => {
      if (text.includes('SELECT trigger_type FROM workflows')) {
        expect(params).toEqual(['w1', 'o1']);
        return { rows: [{ trigger_type: 'time.schedule' }] };
      }
      if (text.startsWith('UPDATE workflows')) return { rows: [] };
      return { rows: [] };
    });
    const { status } = await api(buildApp(), 'PUT', '/api/workflows/w1', { scopeType: 'survey', scopeSurveyId: SURVEY_ID });
    expect(status).toBe(200);
  });

  it('allows setting survey scope + triggerType together in the same PUT even if the row was previously time.schedule', async () => {
    let updateCall = null;
    dbQuery = vi.fn(async (text, params) => {
      if (text.startsWith('UPDATE workflows')) { updateCall = [text, params]; return { rows: [] }; }
      return { rows: [] };
    });
    const { status } = await api(buildApp(), 'PUT', '/api/workflows/w1', {
      triggerType: 'score.nps_drop', scopeType: 'survey', scopeSurveyId: SURVEY_ID,
    });
    expect(status).toBe(200);
    expect(updateCall).toBeTruthy();
  });
});

describe('GET /api/workflows and GET /api/workflows/:id — scope fields present without extra fetches', () => {
  it('GET / (list) returns scope_type/scope_survey_id/scope_tag_id per row from the base SELECT *', async () => {
    const rows = [
      { id: 'w1', org_id: 'o1', scope_type: 'org', scope_survey_id: null, scope_tag_id: null },
      { id: 'w2', org_id: 'o1', scope_type: 'survey', scope_survey_id: SURVEY_ID, scope_tag_id: null },
      { id: 'w3', org_id: 'o1', scope_type: 'tag', scope_survey_id: null, scope_tag_id: TAG_ID },
    ];
    dbQuery = vi.fn(async (text) => {
      if (text.includes('FROM workflows WHERE org_id')) return { rows };
      return { rows: [] };
    });
    const { status, body } = await api(buildApp(), 'GET', '/api/workflows');
    expect(status).toBe(200);
    expect(body.workflows.map((w) => w.scope_type)).toEqual(['org', 'survey', 'tag']);
    expect(body.workflows[1].scope_survey_id).toBe(SURVEY_ID);
    expect(body.workflows[2].scope_tag_id).toBe(TAG_ID);
  });

  it('GET /:id returns scope fields on the detail row', async () => {
    const row = { id: 'w1', org_id: 'o1', scope_type: 'survey', scope_survey_id: SURVEY_ID, scope_tag_id: null };
    dbQuery = vi.fn(async (text) => {
      if (text.includes('FROM workflows WHERE id = $1 AND org_id = $2')) return { rows: [row] };
      return { rows: [] };
    });
    const { status, body } = await api(buildApp(), 'GET', '/api/workflows/w1');
    expect(status).toBe(200);
    expect(body.workflow.scope_type).toBe('survey');
    expect(body.workflow.scope_survey_id).toBe(SURVEY_ID);
  });
});
