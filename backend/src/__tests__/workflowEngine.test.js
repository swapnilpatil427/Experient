import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHmac } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);

const DB_PATH    = _require.resolve(resolve(__dirname, '../lib/db'));
const NOTIF_PATH = _require.resolve(resolve(__dirname, '../lib/notifications'));
const CH_PATH    = _require.resolve(resolve(__dirname, '../lib/channels'));
const MOD_PATH   = _require.resolve(resolve(__dirname, '../lib/workflowEngine'));
const CREDS_PATH = _require.resolve(resolve(__dirname, '../lib/workflowCredentials'));
const CONN_PATH  = _require.resolve(resolve(__dirname, '../lib/connectors'));
const PLANGATE_PATH = _require.resolve(resolve(__dirname, '../lib/planGating'));

let dbQuery, createNotificationMock, sendSlackMock, sendEmailMock;
function fakeMod(id, exports) { return { id, filename: id, loaded: true, exports, children: [] }; }
function load() {
  _require.cache[DB_PATH] = fakeMod(DB_PATH, { query: dbQuery, default: { query: dbQuery } });
  _require.cache[NOTIF_PATH] = fakeMod(NOTIF_PATH, { createNotification: createNotificationMock, serialize: (r) => r });
  _require.cache[CH_PATH] = fakeMod(CH_PATH, { sendSlack: sendSlackMock, sendEmail: sendEmailMock });
  // connectors.ts + workflowCredentials.ts + planGating.ts all close over `./db` —
  // evict them too so each load() picks up the CURRENT dbQuery mock (they cache
  // the db module's exports object at require-time, so a stale cached copy would
  // keep pointing at an old mock). planGating.ts also reads the REAL
  // workflowRegistry.ts (not mocked in this file) for each trigger's minPlanTier.
  delete _require.cache[CONN_PATH];
  delete _require.cache[CREDS_PATH];
  delete _require.cache[PLANGATE_PATH];
  delete _require.cache[MOD_PATH];
  return _require(MOD_PATH);
}

beforeEach(() => {
  dbQuery = vi.fn(async (text) => {
    if (text.startsWith('INSERT INTO workflow_executions')) return { rows: [{ id: 'exec-1' }] };
    return { rows: [] };
  });
  createNotificationMock = vi.fn(async () => ({ id: 'n1' }));
  sendSlackMock = vi.fn(async () => ({ channel: 'slack', delivered: true }));
  sendEmailMock = vi.fn(async () => ({ channel: 'email', delivered: true }));
});

describe('evaluateConditions', () => {
  it('AND requires all rules to pass', () => {
    const { evaluateConditions } = load();
    const conds = { operator: 'AND', rules: [{ field: 'nps', op: 'lte', value: 6 }, { field: 'sentiment', op: 'eq', value: 'negative' }] };
    expect(evaluateConditions(conds, { nps: 4, sentiment: 'negative' })).toBe(true);
    expect(evaluateConditions(conds, { nps: 9, sentiment: 'negative' })).toBe(false);
  });
  it('OR requires any rule', () => {
    const { evaluateConditions } = load();
    const conds = { operator: 'OR', rules: [{ field: 'nps', op: 'lte', value: 6 }, { field: 'text', op: 'contains', value: 'cancel' }] };
    expect(evaluateConditions(conds, { nps: 9, text: 'I want to cancel' })).toBe(true);
    expect(evaluateConditions(conds, { nps: 9, text: 'all good' })).toBe(false);
  });
  it('empty conditions pass', () => {
    const { evaluateConditions } = load();
    expect(evaluateConditions(null, {})).toBe(true);
    expect(evaluateConditions({ rules: [] }, {})).toBe(true);
  });
  it('supports between/in operators', () => {
    const { evaluateConditions } = load();
    expect(evaluateConditions({ rules: [{ field: 'nps', op: 'between', value: [0, 6] }] }, { nps: 3 })).toBe(true);
    expect(evaluateConditions({ rules: [{ field: 'channel', op: 'in', value: ['email', 'qr'] }] }, { channel: 'email' })).toBe(true);
  });

  // Finding: Maya DEEP_AUDIT_PM_FINDINGS.md 2d — the canvas builder's
  // ConditionNode field input (WorkflowCanvasPage.tsx) is raw free text, not a
  // <select> populated from the registry's declared condition fields (verified
  // directly: `<Input className="h-7 text-xs flex-1" value={data.field || ''}
  // onChange={(e) => data.patch?.(id, { field: e.target.value })} />` — no
  // dropdown, no options list, no validation). A customer typing the field key
  // from memory can trivially typo it (e.g. 'NPS' instead of the real 'nps'),
  // and the engine's `evaluateConditions`/`compare` (above) has no field-name
  // validation step: an unknown key resolves to `undefined` via the plain
  // `context[r.field]` lookup and silently compares as false forever, with the
  // typo indistinguishable from a legitimately-false real match.
  //
  // Fixed: `evaluateConditions` now validates `field` against
  // `workflowRegistry.ts`'s `CONDITION_FIELD_SET` and throws instead of
  // silently evaluating false. Run-time only (matches this test's scope) —
  // the canvas builder's free-text field input (WorkflowCanvasPage.tsx) is a
  // separate, save-time/UX half of finding 2d, not addressed here.
  it('rejects a condition rule whose field is not a known registry field', () => {
    const { evaluateConditions } = load();
    // Customer meant `nps` (the real field the registry declares) but typed `NPS`.
    const conds = { rules: [{ field: 'NPS', op: 'lt', value: 7 }] };
    const realEventPayload = { nps: 3, sentiment: 'negative', text: 'this is bad' };
    // A fixed implementation would throw (or return a distinguishable
    // validation-error result) for an unrecognized field name rather than
    // silently evaluating it as `undefined < 7` → false. Today it does neither
    // — it returns `false` with no error — so this assertion fails.
    expect(() => evaluateConditions(conds, realEventPayload)).toThrow(/unknown field|invalid field|not a valid field/i);
  });
});

// Table-driven coverage of every operator `compare`/evaluateConditions declares
// (workflowRegistry.ts's CONDITION_OPERATORS: eq/neq/gt/lt/gte/lte/between/
// contains/not_contains/in/not_in). The pre-existing evaluateConditions tests
// above only ever exercised eq/lte/contains/between/in — neq/gt/gte/
// not_contains/not_in had zero direct assertions anywhere in this suite before
// this table, so a regression in any of those five specific operators could
// have silently drifted with no test catching it. Each row asserts BOTH the
// true and false side of the operator against realistic sample data (not just
// the truthy case), matching Kenji's Wave-15-era re-verification standard: a
// fresh test proving current behavior, not an assumption from the operator's name.
describe('compare — every registry-declared operator, both outcomes', () => {
  it.each([
    ['eq',           4,           4,            true],
    ['eq',           4,           5,            false],
    ['neq',          4,           5,            true],
    ['neq',          4,           4,            false],
    ['gt',           8,           6,            true],
    ['gt',           4,           6,            false],
    ['lt',           4,           6,            true],
    ['lt',           8,           6,            false],
    ['gte',          6,           6,            true],
    ['gte',          5,           6,            false],
    ['lte',          6,           6,            true],
    ['lte',          7,           6,            false],
    ['between',      3,           [0, 6],       true],
    ['between',      9,           [0, 6],       false],
    ['contains',     'I want to cancel', 'cancel', true],
    ['contains',     'all good',  'cancel',     false],
    ['not_contains', 'all good',  'cancel',     true],
    ['not_contains', 'I want to cancel', 'cancel', false],
    ['in',           'email',     ['email', 'qr'], true],
    ['in',           'sms',       ['email', 'qr'], false],
    ['not_in',       'sms',       ['email', 'qr'], true],
    ['not_in',       'email',     ['email', 'qr'], false],
  ])('%s(%j, %j) === %s', (op, actual, value, expected) => {
    const { compare } = load();
    expect(compare(op, actual, value)).toBe(expected);
  });

  it('every operator in workflowRegistry.CONDITION_OPERATORS is exercised above (catalog/table drift guard)', () => {
    const { CONDITION_OPERATORS } = _require(_require.resolve(resolve(__dirname, '../lib/workflowRegistry')));
    const exercised = new Set(['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'between', 'contains', 'not_contains', 'in', 'not_in']);
    for (const op of CONDITION_OPERATORS) {
      expect(exercised.has(op)).toBe(true);
    }
  });

  it('an unrecognized operator returns false rather than throwing (documented default, distinct from the field-typo gap above)', () => {
    const { compare } = load();
    expect(compare('startswith', 'hello world', 'hello')).toBe(false);
  });
});

describe('executeAction', () => {
  it('notify.in_app creates a notification', async () => {
    const { executeAction } = load();
    const r = await executeAction(
      { type: 'action', action: 'notify.in_app', config: { priority: 'warning', title: 'Hi {{nps}}' } },
      { orgId: 'o1', workflowId: 'w1', event: { userId: 'u1', nps: 4 }, vars: {} }
    );
    expect(r.status).toBe('completed');
    expect(createNotificationMock).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'o1', userId: 'u1', priority: 'warning', title: 'Hi 4' }));
  });
  it('notify.slack delegates to the slack sender', async () => {
    const { executeAction } = load();
    const r = await executeAction({ type: 'action', action: 'notify.slack', config: {} }, { orgId: 'o1', event: { title: 'X' }, vars: {} });
    expect(r.status).toBe('completed');
    expect(sendSlackMock).toHaveBeenCalled();
  });
  it('flow.stop signals termination', async () => {
    const { executeAction } = load();
    const r = await executeAction({ type: 'action', action: 'flow.stop' }, { orgId: 'o1', event: {}, vars: {} });
    expect(r.stop).toBe(true);
  });

  // Wave 11 (Priya, DEEP_AUDIT_UX_FINDINGS.md W-1): flow.delay — a second,
  // timer-based pause primitive. Mirrors flow.approval's { status:'waiting',
  // pause:true } contract exactly, so runNodes/runGraph's generic pause
  // handling (unchanged by this wave) picks it up with zero new logic there.
  it('flow.delay pauses (mirrors flow.approval\'s waiting/pause contract) and computes a resumeAt', async () => {
    const { executeAction } = load();
    const before = Date.now();
    const r = await executeAction(
      { type: 'action', action: 'flow.delay', config: { delay_minutes: 30 } },
      { orgId: 'o1', event: {}, vars: {} }
    );
    expect(r.status).toBe('waiting');
    expect(r.pause).toBe(true);
    expect(r.waitReason).toBe('flow.delay');
    expect(r.resumeAt).toBeInstanceOf(Date);
    const expectedMs = before + 30 * 60_000;
    expect(r.resumeAt.getTime()).toBeGreaterThanOrEqual(expectedMs - 1000);
    expect(r.resumeAt.getTime()).toBeLessThanOrEqual(expectedMs + 5000);
    expect(r.output.waitReason).toBe('flow.delay');
    expect(typeof r.output.resumeAt).toBe('string'); // ISO string in the JSONB output too
  });

  it('flow.delay treats a missing/invalid delay_minutes as an immediate (0-minute) resume rather than throwing', async () => {
    const { executeAction } = load();
    const r = await executeAction({ type: 'action', action: 'flow.delay', config: {} }, { orgId: 'o1', event: {}, vars: {} });
    expect(r.status).toBe('waiting');
    expect(r.resumeAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });
  it('jira.create_issue is skipped (graceful) when unconfigured', async () => {
    delete process.env.JIRA_BASE_URL;
    const { executeAction } = load();
    const r = await executeAction({ type: 'action', action: 'jira.create_issue', config: {} }, { orgId: 'o1', event: {}, vars: {} });
    expect(r.status).toBe('skipped');
    expect(r.output.reason).toBe('not_configured');
  });

  it('crystal.summarize produces a summary and exposes it to downstream vars', async () => {
    const { executeAction } = load();
    const ctx = { orgId: 'o1', event: { title: 'NPS drop', nps: 3, sentiment: 'negative' }, vars: {} };
    const r = await executeAction({ type: 'action', action: 'crystal.summarize' }, ctx);
    expect(r.status).toBe('completed');
    expect(r.output.summary).toMatch(/Crystal summary/);
    expect(ctx.vars.crystalSummary).toBeTruthy();
  });

  it('crystal.classify derives severity from NPS', async () => {
    const { executeAction } = load();
    const ctx = { orgId: 'o1', event: { nps: 2 }, vars: {} };
    const r = await executeAction({ type: 'action', action: 'crystal.classify' }, ctx);
    expect(r.output.severity).toBe('critical');
    expect(ctx.vars.crystalSeverity).toBe('critical');
  });

  it('salesforce.update_contact is skipped (graceful) when unconfigured', async () => {
    delete process.env.SF_INSTANCE_URL; delete process.env.SF_ACCESS_TOKEN;
    const { executeAction } = load();
    const r = await executeAction({ type: 'action', action: 'salesforce.update_contact', config: {} }, { orgId: 'o1', event: { contactId: 'c1' }, vars: {} });
    expect(r.status).toBe('skipped');
    expect(r.output.connector).toBe('salesforce');
  });

  it('servicenow.create_incident is skipped (graceful) when unconfigured', async () => {
    delete process.env.SERVICENOW_INSTANCE_URL;
    const { executeAction } = load();
    const r = await executeAction({ type: 'action', action: 'servicenow.create_incident', config: {} }, { orgId: 'o1', event: {}, vars: {} });
    expect(r.status).toBe('skipped');
    expect(r.output.connector).toBe('servicenow');
  });

  it('zendesk.create_ticket is wired and skipped (graceful) when unconfigured', async () => {
    delete process.env.ZENDESK_SUBDOMAIN; delete process.env.ZENDESK_EMAIL; delete process.env.ZENDESK_API_TOKEN;
    const { executeAction } = load();
    const r = await executeAction({ type: 'action', action: 'zendesk.create_ticket', config: {} }, { orgId: 'o1', event: {}, vars: {} });
    expect(r.status).toBe('skipped');
    expect(r.output.connector).toBe('zendesk');
  });

  it('zendesk.create_ticket calls the Zendesk API when configured', async () => {
    process.env.ZENDESK_SUBDOMAIN = 'acme';
    process.env.ZENDESK_EMAIL = 'agent@acme.com';
    process.env.ZENDESK_API_TOKEN = 'tok';
    const fetchMock = vi.fn(async () => ({ ok: true, status: 201, json: async () => ({ ticket: { id: 7 } }) }));
    vi.stubGlobal('fetch', fetchMock);
    const { executeAction } = load();
    const r = await executeAction({ type: 'action', action: 'zendesk.create_ticket', config: { tags: ['vip'] } }, { orgId: 'o1', event: { title: 'Escalation' }, vars: {} });
    expect(r.status).toBe('completed');
    expect(r.output).toEqual({ connector: 'zendesk', ticketId: 7, status: 201 });
    vi.unstubAllGlobals();
    delete process.env.ZENDESK_SUBDOMAIN; delete process.env.ZENDESK_EMAIL; delete process.env.ZENDESK_API_TOKEN;
  });

  it('truly-unwired actions are skipped, not failed', async () => {
    const { executeAction } = load();
    const r = await executeAction({ type: 'action', action: 'integration.unknown' }, { orgId: 'o1', event: {}, vars: {} });
    expect(r.status).toBe('skipped');
  });
});

describe('notify.webhook (HMAC-signed payload)', () => {
  it('sends an unsigned request when no secret is configured (config.secret unset, no org vault entry)', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { executeAction } = load();
    const r = await executeAction(
      { type: 'action', action: 'notify.webhook', config: { url: 'https://example.com/hook' } },
      { orgId: 'o1', event: { type: 'score.nps_drop' }, vars: {} }
    );
    expect(r.status).toBe('completed');
    expect(r.output.signed).toBe(false);
    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers['X-Experient-Signature']).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it('signs the exact raw JSON body with HMAC-SHA256 using config.secret', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { executeAction, } = load();
    const secret = 'whsec_abc123';
    const payload = { hello: 'world' };
    const r = await executeAction(
      { type: 'action', action: 'notify.webhook', config: { url: 'https://example.com/hook', secret, payload } },
      { orgId: 'o1', event: {}, vars: {} }
    );
    expect(r.status).toBe('completed');
    expect(r.output.signed).toBe(true);
    const [, opts] = fetchMock.mock.calls[0];
    const expectedSig = createHmac('sha256', secret).update(opts.body, 'utf8').digest('hex');
    expect(opts.headers['X-Experient-Signature']).toBe(`sha256=${expectedSig}`);
    // The body used to compute the signature must be the exact bytes sent.
    expect(opts.body).toBe(JSON.stringify(payload));
    vi.unstubAllGlobals();
  });

  it('falls back to the org-vaulted webhook secret when config.secret is absent', async () => {
    process.env.WORKFLOW_CREDENTIALS_KEY = randomBytes(32).toString('hex');
    const { encryptCredentials } = _require(CREDS_PATH);
    const key = Buffer.from(process.env.WORKFLOW_CREDENTIALS_KEY, 'hex');
    const blob = encryptCredentials({ secret: 'org-vault-secret' }, key);
    dbQuery = vi.fn(async (text) => {
      if (text.startsWith('INSERT INTO workflow_executions')) return { rows: [{ id: 'exec-1' }] };
      if (text.includes('FROM workflow_connector_credentials')) return { rows: [{ encrypted_blob: blob }] };
      return { rows: [] };
    });
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { executeAction } = load();
    const r = await executeAction(
      { type: 'action', action: 'notify.webhook', config: { url: 'https://example.com/hook', payload: { a: 1 } } },
      { orgId: 'o1', event: {}, vars: {} }
    );
    expect(r.output.signed).toBe(true);
    const [, opts] = fetchMock.mock.calls[0];
    const expectedSig = createHmac('sha256', 'org-vault-secret').update(opts.body, 'utf8').digest('hex');
    expect(opts.headers['X-Experient-Signature']).toBe(`sha256=${expectedSig}`);
    vi.unstubAllGlobals();
    delete process.env.WORKFLOW_CREDENTIALS_KEY;
  });

  it('config.secret takes precedence over the org-vaulted secret', async () => {
    process.env.WORKFLOW_CREDENTIALS_KEY = randomBytes(32).toString('hex');
    const { encryptCredentials } = _require(CREDS_PATH);
    const key = Buffer.from(process.env.WORKFLOW_CREDENTIALS_KEY, 'hex');
    const blob = encryptCredentials({ secret: 'org-vault-secret' }, key);
    dbQuery = vi.fn(async (text) => {
      if (text.startsWith('INSERT INTO workflow_executions')) return { rows: [{ id: 'exec-1' }] };
      if (text.includes('FROM workflow_connector_credentials')) return { rows: [{ encrypted_blob: blob }] };
      return { rows: [] };
    });
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { executeAction } = load();
    const r = await executeAction(
      { type: 'action', action: 'notify.webhook', config: { url: 'https://example.com/hook', secret: 'per-workflow-secret', payload: { a: 1 } } },
      { orgId: 'o1', event: {}, vars: {} }
    );
    const [, opts] = fetchMock.mock.calls[0];
    const expectedSig = createHmac('sha256', 'per-workflow-secret').update(opts.body, 'utf8').digest('hex');
    expect(opts.headers['X-Experient-Signature']).toBe(`sha256=${expectedSig}`);
    vi.unstubAllGlobals();
    delete process.env.WORKFLOW_CREDENTIALS_KEY;
  });
});

describe('runGraph (branching)', () => {
  // Condition fans out into true/false branches; only the matching branch runs.
  const branchWf = {
    id: 'w1', org_id: 'o1',
    nodes: [
      { id: 't', type: 'trigger' },
      { id: 'c', type: 'condition', conditions: { rules: [{ field: 'nps', op: 'lte', value: 6 }] } },
      { id: 'detractor', type: 'action', action: 'notify.in_app', config: { title: 'Detractor', userIds: ['u1'] } },
      { id: 'promoter', type: 'action', action: 'notify.slack', config: {} },
    ],
    edges: [
      { from: 't', to: 'c' },
      { from: 'c', to: 'detractor', branch: 'true' },
      { from: 'c', to: 'promoter', branch: 'false' },
    ],
  };

  it('follows the true branch when the condition passes', async () => {
    const { runWorkflow } = load();
    const r = await runWorkflow(branchWf, { userId: 'u1', nps: 3 }, { orgId: 'o1' });
    expect(r.status).toBe('completed');
    expect(createNotificationMock).toHaveBeenCalled();   // in_app (true branch) ran
    expect(sendSlackMock).not.toHaveBeenCalled();          // slack (false branch) skipped
  });

  it('follows the false branch when the condition fails', async () => {
    const { runWorkflow } = load();
    const r = await runWorkflow(branchWf, { userId: 'u1', nps: 9 }, { orgId: 'o1' });
    expect(r.status).toBe('completed');
    expect(sendSlackMock).toHaveBeenCalled();              // slack (false branch) ran
    expect(createNotificationMock).not.toHaveBeenCalled(); // in_app (true branch) skipped
  });

  it('isGraphWorkflow detects branch edges', () => {
    const { isGraphWorkflow } = load();
    expect(isGraphWorkflow(branchWf)).toBe(true);
    expect(isGraphWorkflow({ edges: [{ from: 'a', to: 'b' }] })).toBe(false);
    expect(isGraphWorkflow({ nodes: [] })).toBe(false);
  });

  it('pauses a branching workflow at an approval node and resumes from the next node', async () => {
    const approvalGraph = {
      id: 'w2', org_id: 'o1',
      nodes: [
        { id: 't', type: 'trigger' },
        { id: 'appr', type: 'action', action: 'flow.approval' },
        { id: 'after', type: 'action', action: 'notify.in_app', config: { title: 'Go', userIds: ['u1'] } },
      ],
      edges: [
        { from: 't', to: 'appr' },
        { from: 'appr', to: 'after' },
        { from: 't', to: 'appr', branch: 'true' }, // marks graph mode
      ],
    };
    let resumeNode = null;
    dbQuery = vi.fn(async (text, params) => {
      if (text.startsWith('INSERT INTO workflow_executions')) return { rows: [{ id: 'exec-2' }] };
      if (text.startsWith('UPDATE workflow_executions SET status') && /resume_node_id/.test(text)) { resumeNode = params[3]; return { rows: [] }; }
      return { rows: [] };
    });
    const { runWorkflow } = load();
    const r = await runWorkflow(approvalGraph, { userId: 'u1' }, { orgId: 'o1' });
    expect(r.status).toBe('waiting');
    expect(resumeNode).toBe('after');                 // resumes at the post-approval node
    expect(createNotificationMock).not.toHaveBeenCalled();
  });
});

describe('approval state machine', () => {
  const approvalWf = {
    id: 'w1', org_id: 'o1', nodes: [
      { id: 't', type: 'trigger' },
      { id: 'appr', type: 'action', action: 'flow.approval' },
      { id: 'a1', type: 'action', action: 'notify.in_app', config: { title: 'Approved!', userIds: ['u1'] } },
    ],
  };

  it('pauses at a flow.approval node and records a pending approval', async () => {
    const inserts = [];
    dbQuery = vi.fn(async (text) => {
      if (text.startsWith('INSERT INTO workflow_executions')) return { rows: [{ id: 'exec-1' }] };
      if (text.startsWith('INSERT INTO workflow_approvals')) { inserts.push('approval'); return { rows: [] }; }
      return { rows: [] };
    });
    const { runWorkflow } = load();
    const r = await runWorkflow(approvalWf, { userId: 'u1' }, { orgId: 'o1' });
    expect(r.status).toBe('waiting');
    expect(inserts).toContain('approval');         // pending approval created
    expect(createNotificationMock).not.toHaveBeenCalled(); // post-approval action not yet run
  });

  it('resumes and runs remaining actions on approval', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('FROM workflow_executions')) return { rows: [{ id: 'exec-1', workflow_id: 'w1', resume_index: 2, trigger_payload: { userId: 'u1' } }] };
      if (text.includes('FROM workflows')) return { rows: [approvalWf] };
      return { rows: [] };
    });
    const { resumeWorkflow } = load();
    const r = await resumeWorkflow('exec-1', 'o1', 'approved', 'admin');
    expect(r.status).toBe('completed');
    expect(createNotificationMock).toHaveBeenCalled(); // the post-approval notify ran
  });

  it('aborts (skipped) on rejection without running remaining actions', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('FROM workflow_executions')) return { rows: [{ id: 'exec-1', workflow_id: 'w1', resume_index: 2, trigger_payload: {} }] };
      return { rows: [] };
    });
    const { resumeWorkflow } = load();
    const r = await resumeWorkflow('exec-1', 'o1', 'rejected', 'admin');
    expect(r.status).toBe('rejected');
    expect(createNotificationMock).not.toHaveBeenCalled();
  });

  it('returns null when there is no waiting execution', async () => {
    dbQuery = vi.fn(async () => ({ rows: [] }));
    const { resumeWorkflow } = load();
    expect(await resumeWorkflow('missing', 'o1', 'approved', 'admin')).toBeNull();
  });

  // REGRESSION (Wave 11 safety gate): resumeWorkflow's SELECT now carries a
  // wait_reason filter (added alongside flow.delay) — this proves it still
  // matches a legacy/pre-flow.delay-shaped waiting row (wait_reason NULL) so
  // no existing approval never regresses because of the new filter.
  it('REGRESSION: still resumes a legacy waiting row with no wait_reason column value (defensive NULL fallback)', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('FROM workflow_executions')) {
        return { rows: [{ id: 'exec-1', workflow_id: 'w1', resume_index: 2, trigger_payload: { userId: 'u1' }, wait_reason: null }] };
      }
      if (text.includes('FROM workflows')) return { rows: [approvalWf] };
      return { rows: [] };
    });
    const { resumeWorkflow } = load();
    const r = await resumeWorkflow('exec-1', 'o1', 'approved', 'admin');
    expect(r.status).toBe('completed');
  });
});

// Wave 11 disjointness regression tests (Priya, DEEP_AUDIT_UX_FINDINGS.md
// W-1 + this wave's explicit "very safe integration" bar): flow.approval and
// flow.delay pauses must never cross-contaminate each other's bookkeeping.
describe('flow.delay vs flow.approval — disjointness regressions', () => {
  const delayWf = {
    id: 'w-delay', org_id: 'o1', nodes: [
      { id: 't', type: 'trigger' },
      { id: 'd', type: 'action', action: 'flow.delay', config: { delay_minutes: 60 } },
      { id: 'a1', type: 'action', action: 'notify.in_app', config: { title: 'After delay', userIds: ['u1'] } },
    ],
  };
  const approvalWf2 = {
    id: 'w-appr', org_id: 'o1', nodes: [
      { id: 't', type: 'trigger' },
      { id: 'appr', type: 'action', action: 'flow.approval' },
      { id: 'a1', type: 'action', action: 'notify.in_app', config: { title: 'Approved!', userIds: ['u1'] } },
    ],
  };

  it('MOST IMPORTANT: a flow.approval pause still creates a workflow_approvals row exactly as before (unchanged behavior)', async () => {
    const approvalInserts = [];
    let statusUpdateParams = null;
    dbQuery = vi.fn(async (text, params) => {
      if (text.startsWith('INSERT INTO workflow_executions')) return { rows: [{ id: 'exec-appr' }] };
      if (text.startsWith('INSERT INTO workflow_approvals')) { approvalInserts.push(params); return { rows: [] }; }
      if (text.startsWith('UPDATE workflow_executions SET status')) { statusUpdateParams = params; return { rows: [] }; }
      return { rows: [] };
    });
    const { runWorkflow } = load();
    const r = await runWorkflow(approvalWf2, { userId: 'u1' }, { orgId: 'o1' });
    expect(r.status).toBe('waiting');
    expect(approvalInserts).toHaveLength(1);
    expect(approvalInserts[0]).toEqual(['exec-appr', 'o1', 'w-appr', 'appr']);
    // wait_reason column stamped 'flow.approval', resume_at left null (no timer)
    expect(statusUpdateParams[4]).toBe('flow.approval');
    expect(statusUpdateParams[5]).toBeNull();
  });

  it('a flow.delay pause does NOT create a workflow_approvals row', async () => {
    const approvalInserts = [];
    let statusUpdateParams = null;
    dbQuery = vi.fn(async (text, params) => {
      if (text.startsWith('INSERT INTO workflow_executions')) return { rows: [{ id: 'exec-delay' }] };
      if (text.startsWith('INSERT INTO workflow_approvals')) { approvalInserts.push(params); return { rows: [] }; }
      if (text.startsWith('UPDATE workflow_executions SET status')) { statusUpdateParams = params; return { rows: [] }; }
      return { rows: [] };
    });
    const { runWorkflow } = load();
    const r = await runWorkflow(delayWf, { userId: 'u1' }, { orgId: 'o1' });
    expect(r.status).toBe('waiting');
    expect(approvalInserts).toHaveLength(0); // the critical assertion
    expect(statusUpdateParams[4]).toBe('flow.delay');
    expect(statusUpdateParams[5]).toBeInstanceOf(Date); // resume_at populated
  });

  it('resumeWorkflow (human decision endpoint) refuses to resume a flow.delay-type waiting execution', async () => {
    let selectSql = null;
    dbQuery = vi.fn(async (text) => {
      if (text.includes('FROM workflow_executions')) { selectSql = text; return { rows: [] }; } // real DB would also filter it out via WHERE
      return { rows: [] };
    });
    const { resumeWorkflow } = load();
    const r = await resumeWorkflow('exec-delay', 'o1', 'approved', 'admin');
    expect(r).toBeNull();
    expect(selectSql).toMatch(/wait_reason/);
  });

  it('resumeDelayedExecution (scheduler path) does not touch workflow_approvals at all', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('RETURNING *')) {
        // the atomic claim UPDATE
        return { rows: [{ id: 'exec-delay', org_id: 'o1', workflow_id: 'w-delay', resume_index: 2, trigger_payload: { userId: 'u1' } }] };
      }
      if (text.includes('FROM workflows')) return { rows: [delayWf] };
      return { rows: [] };
    });
    const { resumeDelayedExecution } = load();
    const r = await resumeDelayedExecution('exec-delay');
    expect(r.status).toBe('completed');
    const allSql = dbQuery.mock.calls.map((c) => c[0]);
    expect(allSql.some((sql) => sql.includes('workflow_approvals'))).toBe(false);
    expect(createNotificationMock).toHaveBeenCalled(); // post-delay action ran
  });

  // CONCURRENCY / IDEMPOTENCY (this wave's core safety requirement): proves the
  // atomic-claim guard actually prevents a double-resume when two callers race
  // for the same execution — the exact same class of problem as Stripe webhook
  // idempotency. The fake DB below models real Postgres row-locking semantics
  // for `UPDATE ... WHERE status = 'waiting' ... RETURNING *`: the FIRST caller
  // to reach the claim query flips the in-memory row's status away from
  // 'waiting', so the SECOND caller's WHERE clause (re-evaluated against the
  // now-current row, exactly like Postgres re-checks WHERE after acquiring the
  // row lock) matches zero rows and gets an empty RETURNING set — never both.
  it('CONCURRENCY: two concurrent resumeDelayedExecution calls for the same execution id only resume/execute once', async () => {
    const execRow = {
      id: 'exec-race', org_id: 'o1', workflow_id: 'w-delay', status: 'waiting',
      wait_reason: 'flow.delay', resume_at: new Date(Date.now() - 1000).toISOString(),
      resume_index: 2, trigger_payload: { userId: 'u1' },
    };
    dbQuery = vi.fn(async (text) => {
      if (text.includes('RETURNING *')) {
        // Models Postgres: only the first caller to reach this statement sees
        // status='waiting' still true; simulate the row-lock serialization by
        // synchronously flipping status here, before any awaiting caller can
        // "observe" the pre-claim state again.
        if (execRow.status !== 'waiting') return { rows: [] }; // already claimed — real DB semantics
        execRow.status = 'executing';
        return { rows: [{ ...execRow }] };
      }
      if (text.includes('FROM workflows')) return { rows: [delayWf] };
      return { rows: [] };
    });
    const { resumeDelayedExecution } = load();
    // Fire both concurrently — this is the scenario an overlapping scheduler
    // tick or a second scaled-out replica would produce.
    const [r1, r2] = await Promise.all([
      resumeDelayedExecution('exec-race'),
      resumeDelayedExecution('exec-race'),
    ]);
    const results = [r1, r2];
    const claimed = results.filter((r) => r !== null);
    const rejected = results.filter((r) => r === null);
    expect(claimed).toHaveLength(1);   // exactly one caller wins the claim
    expect(rejected).toHaveLength(1);  // the other gets null, does no downstream work
    expect(claimed[0].status).toBe('completed');
    // The downstream action (notify.in_app, the workflow's actual side effect)
    // fired exactly once — not twice — proving no double-execution occurred.
    expect(createNotificationMock).toHaveBeenCalledTimes(1);
  });

  it('CONCURRENCY: a second resume attempt after the first already completed is a clean no-op (no error, no double-fire)', async () => {
    const execRow = {
      id: 'exec-seq', org_id: 'o1', workflow_id: 'w-delay', status: 'waiting',
      wait_reason: 'flow.delay', resume_at: new Date(Date.now() - 1000).toISOString(),
      resume_index: 2, trigger_payload: { userId: 'u1' },
    };
    dbQuery = vi.fn(async (text) => {
      if (text.includes('RETURNING *')) {
        if (execRow.status !== 'waiting') return { rows: [] };
        execRow.status = 'executing';
        return { rows: [{ ...execRow }] };
      }
      if (text.includes('FROM workflows')) return { rows: [delayWf] };
      return { rows: [] };
    });
    const { resumeDelayedExecution } = load();
    const first = await resumeDelayedExecution('exec-seq');
    const second = await resumeDelayedExecution('exec-seq'); // quick-succession retry (e.g. next tick)
    expect(first.status).toBe('completed');
    expect(second).toBeNull();
    expect(createNotificationMock).toHaveBeenCalledTimes(1);
  });
});

describe('runScheduledWorkflows', () => {
  it('runs time.schedule workflows whose cron matches now', async () => {
    const wf = {
      id: 'w1', org_id: 'o1', trigger_type: 'time.schedule',
      nodes: [
        { id: 't', type: 'trigger', trigger: 'time.schedule', config: { cron: '* * * * *' } },
        { id: 'a1', type: 'action', action: 'notify.in_app', config: { title: 'Digest', userIds: ['u1'] } },
      ],
    };
    dbQuery = vi.fn(async (text) => {
      if (text.includes("trigger_type = 'time.schedule'")) return { rows: [wf] };
      if (text.startsWith('INSERT INTO workflow_executions')) return { rows: [{ id: 'exec-1' }] };
      return { rows: [] };
    });
    const { runScheduledWorkflows } = load();
    const ran = await runScheduledWorkflows(new Date());
    expect(ran).toHaveLength(1);
    expect(createNotificationMock).toHaveBeenCalled();
  });

  it('skips workflows whose cron does not match', async () => {
    const wf = {
      id: 'w1', org_id: 'o1', trigger_type: 'time.schedule',
      nodes: [{ id: 't', type: 'trigger', config: { cron: '0 0 1 1 *' } }], // midnight Jan 1
    };
    dbQuery = vi.fn(async (text) => {
      if (text.includes("trigger_type = 'time.schedule'")) return { rows: [wf] };
      return { rows: [] };
    });
    const { runScheduledWorkflows } = load();
    const ran = await runScheduledWorkflows(new Date(2026, 5, 8, 8, 0)); // Jun 8 08:00 — no match
    expect(ran).toHaveLength(0);
  });
});

describe('runWorkflow', () => {
  it('runs trigger→condition→actions and completes', async () => {
    const { runWorkflow } = load();
    const wf = {
      id: 'w1', trigger_type: 'survey.response_filtered',
      nodes: [
        { id: 't', type: 'trigger' },
        { id: 'c', type: 'condition', conditions: { operator: 'AND', rules: [{ field: 'nps', op: 'lte', value: 6 }] } },
        { id: 'a1', type: 'action', action: 'notify.in_app', config: { title: 'Detractor' } },
      ],
    };
    const r = await runWorkflow(wf, { userId: 'u1', nps: 3 }, { orgId: 'o1' });
    expect(r.status).toBe('completed');
    expect(r.conditionsPassed).toBe(true);
    expect(createNotificationMock).toHaveBeenCalled();
  });

  it('skips actions when conditions fail', async () => {
    const { runWorkflow } = load();
    const wf = {
      id: 'w1', nodes: [
        { id: 'c', type: 'condition', conditions: { rules: [{ field: 'nps', op: 'lte', value: 6 }] } },
        { id: 'a1', type: 'action', action: 'notify.in_app', config: {} },
      ],
    };
    const r = await runWorkflow(wf, { userId: 'u1', nps: 9 }, { orgId: 'o1' });
    expect(r.status).toBe('skipped');
    expect(createNotificationMock).not.toHaveBeenCalled();
  });
});

// Trigger-to-action execution ordering (Kenji, foundational-rules re-verification):
// workflowReliability.test.js's "partial action failure" describe already proves
// ordering + halt-on-HARD-FAILURE (action 2 throws, action 3 never runs). What was
// NOT covered anywhere in the suite: (a) a clean, all-succeeding multi-action chain
// actually executes strictly in `nodes`/`edges` order (not just "the right count of
// actions ran"), and (b) flow.stop — a deliberate, non-error stop, distinct from a
// hard failure — actually halts a MULTI-action chain when reached mid-sequence, not
// just in the isolated single-node executeAction unit test above ("flow.stop
// signals termination"). Both gaps closed here against the real runNodes/runGraph
// integration path (real runWorkflow call, not calling executeAction directly).
describe('trigger-to-action execution ordering (sequential chain + flow.stop halts remaining actions)', () => {
  it('executes 4 actions strictly in nodes-array order on a full success path (runNodes/linear)', async () => {
    const order = [];
    createNotificationMock.mockImplementation(async () => { order.push('notify.in_app'); return { id: 'n1' }; });
    sendSlackMock.mockImplementation(async () => { order.push('notify.slack'); return { channel: 'slack', delivered: true }; });
    sendEmailMock.mockImplementation(async () => { order.push('notify.email'); return { channel: 'email', delivered: true }; });
    global.fetch = vi.fn(async () => { order.push('notify.webhook'); return { ok: true, status: 200 }; });

    const wf = {
      id: 'w1',
      nodes: [
        { id: 't', type: 'trigger' },
        { id: 'a1', type: 'action', action: 'notify.in_app', config: { userIds: ['u1'] } },
        { id: 'a2', type: 'action', action: 'notify.slack', config: {} },
        { id: 'a3', type: 'action', action: 'notify.email', config: { userIds: ['u1'] } },
        { id: 'a4', type: 'action', action: 'notify.webhook', config: { url: 'https://third-party.test/hook' } },
      ],
    };
    const { runWorkflow } = load();
    const r = await runWorkflow(wf, { userId: 'u1' }, { orgId: 'o1' });

    expect(r.status).toBe('completed');
    expect(order).toEqual(['notify.in_app', 'notify.slack', 'notify.email', 'notify.webhook']);
  });

  it('the same 4-action chain executes in the identical order via runGraph (branching/edges path)', async () => {
    const order = [];
    createNotificationMock.mockImplementation(async () => { order.push('notify.in_app'); return { id: 'n1' }; });
    sendSlackMock.mockImplementation(async () => { order.push('notify.slack'); return { channel: 'slack', delivered: true }; });
    sendEmailMock.mockImplementation(async () => { order.push('notify.email'); return { channel: 'email', delivered: true }; });
    global.fetch = vi.fn(async () => { order.push('notify.webhook'); return { ok: true, status: 200 }; });

    const wf = {
      id: 'w2',
      nodes: [
        { id: 't', type: 'trigger' },
        { id: 'a1', type: 'action', action: 'notify.in_app', config: { userIds: ['u1'] } },
        { id: 'a2', type: 'action', action: 'notify.slack', config: {} },
        { id: 'a3', type: 'action', action: 'notify.email', config: { userIds: ['u1'] } },
        { id: 'a4', type: 'action', action: 'notify.webhook', config: { url: 'https://third-party.test/hook' } },
      ],
      edges: [
        { from: 't', to: 'a1' },
        { from: 'a1', to: 'a2' },
        { from: 'a2', to: 'a3' },
        { from: 'a3', to: 'a4', branch: 'true' }, // any branch edge marks this a graph workflow (isGraphWorkflow)
      ],
    };
    const { runWorkflow } = load();
    const r = await runWorkflow(wf, { userId: 'u1' }, { orgId: 'o1' });

    expect(r.status).toBe('completed');
    expect(order).toEqual(['notify.in_app', 'notify.slack', 'notify.email', 'notify.webhook']);
  });

  it('flow.stop mid-chain halts all subsequent actions (linear/runNodes) — a clean stop, not a failure', async () => {
    const wf = {
      id: 'w3',
      nodes: [
        { id: 't', type: 'trigger' },
        { id: 'a1', type: 'action', action: 'notify.in_app', config: { userIds: ['u1'] } },
        { id: 'a2', type: 'action', action: 'flow.stop' },
        { id: 'a3', type: 'action', action: 'notify.slack', config: {} },
      ],
    };
    const { runWorkflow } = load();
    const r = await runWorkflow(wf, { userId: 'u1' }, { orgId: 'o1' });

    expect(r.status).toBe('completed'); // flow.stop is a clean, successful halt — not a failure
    expect(createNotificationMock).toHaveBeenCalledTimes(1); // a1 ran
    expect(sendSlackMock).not.toHaveBeenCalled(); // a3, after the stop, never runs
  });

  it('flow.stop mid-chain halts all subsequent actions (branching/runGraph)', async () => {
    const wf = {
      id: 'w4',
      nodes: [
        { id: 't', type: 'trigger' },
        { id: 'a1', type: 'action', action: 'notify.in_app', config: { userIds: ['u1'] } },
        { id: 'a2', type: 'action', action: 'flow.stop' },
        { id: 'a3', type: 'action', action: 'notify.slack', config: {} },
      ],
      edges: [
        { from: 't', to: 'a1' },
        { from: 'a1', to: 'a2' },
        { from: 'a2', to: 'a3', branch: 'true' }, // branch edge marks graph mode
      ],
    };
    const { runWorkflow } = load();
    const r = await runWorkflow(wf, { userId: 'u1' }, { orgId: 'o1' });

    expect(r.status).toBe('completed');
    expect(createNotificationMock).toHaveBeenCalledTimes(1);
    expect(sendSlackMock).not.toHaveBeenCalled();
  });
});

// Growth-tier enforcement, EXECUTION-time defense in depth (Nina, 2026-07-01,
// DEEP_AUDIT_PM_FINDINGS.md §6d/§10c). routes/workflows.ts (see
// workflowTierGating.test.js) already blocks SAVING a Growth-gated trigger on a
// sub-Growth plan, but a plan can be downgraded after the workflow was already
// saved while on Growth — this re-check (mirroring lib/seats.ts::checkSeatLimit's
// existing "read plan_tier live, never grandfather" precedent) makes a downgrade
// take effect on the very next trigger, without requiring a re-save.
describe('runWorkflow — Growth-tier gate (execution-time, defense in depth)', () => {
  it('skips a Crystal Signal trigger when the org is on a sub-Growth plan, records a clean skipped execution', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('plan_tier FROM org_profiles')) return { rows: [{ plan_tier: 'free' }] };
      if (text.startsWith('INSERT INTO workflow_executions')) return { rows: [{ id: 'exec-gated' }] };
      return { rows: [] };
    });
    const { runWorkflow } = load();
    const wf = {
      id: 'w1', trigger_type: 'crystal.anomaly_detected',
      nodes: [
        { id: 't', type: 'trigger' },
        { id: 'a1', type: 'action', action: 'notify.in_app', config: {} },
      ],
    };
    const r = await runWorkflow(wf, { type: 'crystal.anomaly_detected' }, { orgId: 'o1' });
    expect(r.status).toBe('skipped');
    expect(r.executionId).toBe('exec-gated');
    expect(createNotificationMock).not.toHaveBeenCalled(); // never reached action execution
    const insertCall = dbQuery.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO workflow_executions'));
    expect(insertCall[0]).toContain("'skipped'"); // status is a literal in the SQL, not a bound param
    expect(insertCall[1].some((p) => typeof p === 'string' && /growth/i.test(p))).toBe(true);
  });

  it('runs a Crystal Signal trigger normally when the org is on Growth or above', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('plan_tier FROM org_profiles')) return { rows: [{ plan_tier: 'growth' }] };
      if (text.startsWith('INSERT INTO workflow_executions')) return { rows: [{ id: 'exec-ok' }] };
      return { rows: [] };
    });
    const { runWorkflow } = load();
    const wf = {
      id: 'w1', trigger_type: 'crystal.sentiment_spike',
      nodes: [
        { id: 't', type: 'trigger' },
        { id: 'a1', type: 'action', action: 'notify.in_app', config: {} },
      ],
    };
    const r = await runWorkflow(wf, { type: 'crystal.sentiment_spike', userId: 'u1' }, { orgId: 'o1' });
    expect(r.status).toBe('completed');
    expect(createNotificationMock).toHaveBeenCalled();
  });

  it('never gates a non-Crystal-Signal trigger, regardless of plan', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('plan_tier FROM org_profiles')) return { rows: [{ plan_tier: 'free' }] };
      if (text.startsWith('INSERT INTO workflow_executions')) return { rows: [{ id: 'exec-ok2' }] };
      return { rows: [] };
    });
    const { runWorkflow } = load();
    const wf = {
      id: 'w1', trigger_type: 'alert.fired',
      nodes: [
        { id: 't', type: 'trigger' },
        { id: 'a1', type: 'action', action: 'notify.in_app', config: {} },
      ],
    };
    const r = await runWorkflow(wf, { type: 'alert.fired', userId: 'u1' }, { orgId: 'o1' });
    expect(r.status).toBe('completed');
  });

  it('REGRESSION: a downgraded org (was Growth at save time, now Free) stops firing a saved Crystal Signal workflow on the very next trigger', async () => {
    // Simulates a workflow that was validly saved while the org was on Growth,
    // then the org downgraded to Free — no re-save happened, but the very next
    // execution attempt must still be gated (this is the whole point of checking
    // live at execution time instead of only at save time).
    dbQuery = vi.fn(async (text) => {
      if (text.includes('plan_tier FROM org_profiles')) return { rows: [{ plan_tier: 'free' }] };
      if (text.startsWith('INSERT INTO workflow_executions')) return { rows: [{ id: 'exec-downgraded' }] };
      return { rows: [] };
    });
    const { runWorkflow } = load();
    const wf = { id: 'w-already-saved', trigger_type: 'crystal.new_theme_detected', status: 'active', nodes: [{ id: 't', type: 'trigger' }] };
    const r = await runWorkflow(wf, { type: 'crystal.new_theme_detected' }, { orgId: 'o1' });
    expect(r.status).toBe('skipped');
  });
});

// ── Async queue integration: idempotency + retry/DLQ (lib/workflowQueue.ts) ──
describe('runWorkflow idempotency (duplicate publish/redelivery)', () => {
  const wf = { id: 'w1', nodes: [{ id: 'a1', type: 'action', action: 'notify.in_app', config: {} }] };

  it('inserts with idempotency_key and ON CONFLICT DO NOTHING when a key is given', async () => {
    const { runWorkflow } = load();
    await runWorkflow(wf, { userId: 'u1' }, { orgId: 'o1', idempotencyKey: 'o1:w1:t:r1' });
    const insertCall = dbQuery.mock.calls.find(([text]) => text.startsWith('INSERT INTO workflow_executions'));
    expect(insertCall[0]).toContain('idempotency_key');
    expect(insertCall[0]).toContain('ON CONFLICT (idempotency_key) DO NOTHING');
    expect(insertCall[1]).toEqual(['w1', 'o1', 'manual', JSON.stringify({ userId: 'u1' }), 'o1:w1:t:r1']);
  });

  it('returns null and runs no actions when the INSERT is a no-op conflict (duplicate)', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.startsWith('INSERT INTO workflow_executions')) return { rows: [] }; // ON CONFLICT DO NOTHING → no row
      return { rows: [] };
    });
    const { runWorkflow } = load();
    const r = await runWorkflow(wf, { userId: 'u1' }, { orgId: 'o1', idempotencyKey: 'o1:w1:t:r1' });
    expect(r).toBeNull();
    expect(createNotificationMock).not.toHaveBeenCalled(); // duplicate never executes
  });

  it('omits idempotency_key and always creates a fresh execution for manual calls (no key given)', async () => {
    const { runWorkflow } = load();
    const r = await runWorkflow(wf, { userId: 'u1' }, { orgId: 'o1' });
    expect(r).not.toBeNull();
    const insertCall = dbQuery.mock.calls.find(([text]) => text.startsWith('INSERT INTO workflow_executions'));
    expect(insertCall[0]).not.toContain('idempotency_key');
  });

  it('runWorkflowsForEvent derives a per-workflow idempotency key from streamId and skips duplicates', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('FROM workflows')) return { rows: [wf] };
      if (text.startsWith('INSERT INTO workflow_executions')) return { rows: [] }; // duplicate
      return { rows: [] };
    });
    const { runWorkflowsForEvent } = load();
    const results = await runWorkflowsForEvent('o1', 'survey.response_filtered', { responseId: 'r1' }, 'stream-42');
    expect(results).toHaveLength(0); // duplicate filtered out, not pushed as null
    const insertCall = dbQuery.mock.calls.find(([text]) => text.startsWith('INSERT INTO workflow_executions'));
    expect(insertCall[1][4]).toBe('o1:w1:survey.response_filtered:r1'); // idempotency key param
  });

  it('runWorkflowsForEvent omits idempotency_key when no streamId is given', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('FROM workflows')) return { rows: [wf] };
      if (text.startsWith('INSERT INTO workflow_executions')) return { rows: [{ id: 'exec-1' }] };
      return { rows: [] };
    });
    const { runWorkflowsForEvent } = load();
    const results = await runWorkflowsForEvent('o1', 'survey.response_filtered', { responseId: 'r1' });
    expect(results).toHaveLength(1);
    const insertCall = dbQuery.mock.calls.find(([text]) => text.startsWith('INSERT INTO workflow_executions'));
    expect(insertCall[0]).not.toContain('idempotency_key');
  });
});

// ── Scope matching (docs/automation-hub/BUILDER_REDESIGN_V2_SCOPE.md §2) ──────
//
// The structural fix: before this, runWorkflowsForEvent matched purely on
// (org_id, trigger_type) — a workflow "scoped" to survey A would still fire for
// survey B's events, since nothing ever checked. These tests are the actual
// regression guard against a real customer-trust bug (an NPS alert for Survey A
// firing because of Survey B's responses).
describe('resolveEventSurveyId', () => {
  it('prefers event.surveyId when present', () => {
    const { resolveEventSurveyId } = load();
    expect(resolveEventSurveyId({ surveyId: 's1', payload: { survey_id: 's2' } })).toBe('s1');
  });
  it('falls back to payload.survey_id (crystal.* / workflow_signal shape)', () => {
    const { resolveEventSurveyId } = load();
    expect(resolveEventSurveyId({ payload: { survey_id: 's1' } })).toBe('s1');
  });
  it('falls back to payload.surveyId (alert.fired shape)', () => {
    const { resolveEventSurveyId } = load();
    expect(resolveEventSurveyId({ payload: { surveyId: 's1' } })).toBe('s1');
  });
  it('returns null when no survey id is resolvable anywhere', () => {
    const { resolveEventSurveyId } = load();
    expect(resolveEventSurveyId({})).toBeNull();
    expect(resolveEventSurveyId({ payload: { surveyId: null } })).toBeNull();
    expect(resolveEventSurveyId({ payload: {} })).toBeNull();
  });
});

describe('matchesScope', () => {
  it('org-scoped always matches, regardless of event survey id', () => {
    const { matchesScope } = load();
    expect(matchesScope({ scope_type: 'org' }, 's1', () => undefined)).toBe(true);
    expect(matchesScope({ scope_type: 'org' }, null, () => undefined)).toBe(true);
  });
  it('defaults to org-scope (matches) when scope_type is absent — backward compat for pre-scope rows', () => {
    const { matchesScope } = load();
    expect(matchesScope({}, null, () => undefined)).toBe(true);
  });
  it('survey-scoped matches only the exact survey id', () => {
    const { matchesScope } = load();
    expect(matchesScope({ scope_type: 'survey', scope_survey_id: 's1' }, 's1', () => undefined)).toBe(true);
    expect(matchesScope({ scope_type: 'survey', scope_survey_id: 's1' }, 's2', () => undefined)).toBe(false);
  });
  it('survey-scoped never matches when the event carries no survey id', () => {
    const { matchesScope } = load();
    expect(matchesScope({ scope_type: 'survey', scope_survey_id: 's1' }, null, () => undefined)).toBe(false);
  });
  it('tag-scoped matches when the event survey is in the tag\'s survey set', () => {
    const { matchesScope } = load();
    const set = new Set(['s1', 's2']);
    expect(matchesScope({ scope_type: 'tag', scope_tag_id: 't1' }, 's1', () => set)).toBe(true);
    expect(matchesScope({ scope_type: 'tag', scope_tag_id: 't1' }, 's3', () => set)).toBe(false);
  });
  it('tag-scoped never matches when the event carries no survey id', () => {
    const { matchesScope } = load();
    expect(matchesScope({ scope_type: 'tag', scope_tag_id: 't1' }, null, () => new Set(['s1']))).toBe(false);
  });
});

describe('runWorkflowsForEvent — scope filtering (end to end)', () => {
  const orgWf     = { id: 'w-org',    org_id: 'o1', trigger_type: 'score.nps_drop', scope_type: 'org', nodes: [] };
  const surveyAWf = { id: 'w-surv-a', org_id: 'o1', trigger_type: 'score.nps_drop', scope_type: 'survey', scope_survey_id: 'survey-a', nodes: [] };
  const surveyBWf = { id: 'w-surv-b', org_id: 'o1', trigger_type: 'score.nps_drop', scope_type: 'survey', scope_survey_id: 'survey-b', nodes: [] };
  const tagWf     = { id: 'w-tag',    org_id: 'o1', trigger_type: 'score.nps_drop', scope_type: 'tag', scope_tag_id: 'tag-1', nodes: [] };

  function mockDb({ workflows, tagMappings = [] }) {
    return vi.fn(async (text, params) => {
      if (text.includes('FROM workflows') && text.includes('WHERE org_id')) return { rows: workflows };
      if (text.includes('FROM survey_tag_mappings') && text.includes('tag_id = ANY')) {
        const tagIds = params[0];
        return { rows: tagMappings.filter((m) => tagIds.includes(m.tag_id)) };
      }
      if (text.startsWith('INSERT INTO workflow_executions')) return { rows: [{ id: `exec-${Math.random()}` }] };
      return { rows: [] };
    });
  }

  it('an org-scoped workflow fires for every survey\'s events (regression: must not break existing workflows)', async () => {
    dbQuery = mockDb({ workflows: [orgWf] });
    const { runWorkflowsForEvent } = load();
    const forA = await runWorkflowsForEvent('o1', 'score.nps_drop', { surveyId: 'survey-a', nps: 3 });
    const forB = await runWorkflowsForEvent('o1', 'score.nps_drop', { surveyId: 'survey-b', nps: 3 });
    expect(forA).toHaveLength(1);
    expect(forB).toHaveLength(1);
  });

  it('a survey-scoped workflow fires ONLY for its own survey\'s events and is silent for other surveys', async () => {
    dbQuery = mockDb({ workflows: [surveyAWf] });
    const { runWorkflowsForEvent } = load();
    const forA = await runWorkflowsForEvent('o1', 'score.nps_drop', { surveyId: 'survey-a', nps: 3 });
    const forB = await runWorkflowsForEvent('o1', 'score.nps_drop', { surveyId: 'survey-b', nps: 3 });
    expect(forA).toHaveLength(1); // fires for its own survey
    expect(forB).toHaveLength(0); // silent for a different survey — the core bug this fixes
  });

  it('a survey-scoped workflow does not fire when the event carries no survey id at all', async () => {
    dbQuery = mockDb({ workflows: [surveyAWf] });
    const { runWorkflowsForEvent } = load();
    const results = await runWorkflowsForEvent('o1', 'score.nps_drop', { nps: 3 });
    expect(results).toHaveLength(0);
  });

  it('multiple survey-scoped workflows for different surveys never cross-fire on the same event batch', async () => {
    dbQuery = mockDb({ workflows: [surveyAWf, surveyBWf] });
    const { runWorkflowsForEvent } = load();
    const results = await runWorkflowsForEvent('o1', 'score.nps_drop', { surveyId: 'survey-a', nps: 3 });
    expect(results).toHaveLength(1); // only survey-a's workflow ran, not survey-b's
  });

  it('a tag-scoped workflow fires for every survey carrying that tag and no others', async () => {
    dbQuery = mockDb({
      workflows: [tagWf],
      tagMappings: [{ tag_id: 'tag-1', survey_id: 'survey-a' }, { tag_id: 'tag-1', survey_id: 'survey-b' }],
    });
    const { runWorkflowsForEvent } = load();
    const forA = await runWorkflowsForEvent('o1', 'score.nps_drop', { surveyId: 'survey-a', nps: 3 });
    const forC = await runWorkflowsForEvent('o1', 'score.nps_drop', { surveyId: 'survey-c', nps: 3 }); // not tagged
    expect(forA).toHaveLength(1);
    expect(forC).toHaveLength(0);
  });

  it('resolves survey id from event.payload.survey_id (crystal.* trigger shape) for scope matching', async () => {
    dbQuery = mockDb({ workflows: [surveyAWf] });
    const { runWorkflowsForEvent } = load();
    const results = await runWorkflowsForEvent('o1', 'score.nps_drop', { payload: { survey_id: 'survey-a' } });
    expect(results).toHaveLength(1);
  });

  it('resolves survey id from event.payload.surveyId (alert.fired shape) for scope matching', async () => {
    dbQuery = mockDb({ workflows: [surveyAWf] });
    const { runWorkflowsForEvent } = load();
    const results = await runWorkflowsForEvent('o1', 'score.nps_drop', { payload: { surveyId: 'survey-a' } });
    expect(results).toHaveLength(1);
  });

  it('mixed org + survey + tag workflows in one batch each match independently, correctly', async () => {
    dbQuery = mockDb({
      workflows: [orgWf, surveyAWf, surveyBWf, tagWf],
      tagMappings: [{ tag_id: 'tag-1', survey_id: 'survey-c' }],
    });
    const { runWorkflowsForEvent } = load();
    const results = await runWorkflowsForEvent('o1', 'score.nps_drop', { surveyId: 'survey-c', nps: 3 });
    // org (always) + tag-1 (survey-c is tagged) match; survey-a/survey-b do not.
    expect(results).toHaveLength(2);
  });
});

describe('finalizeExecution retry/backoff + dead-letter transition (on failure)', () => {
  const failingWf = { id: 'w1', nodes: [{ id: 'a1', type: 'action', action: 'notify.webhook', config: { url: 'https://x.test' } }] };

  it('stamps attempt_count=1 and a future next_retry_at on first failure (not dead-lettered)', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.startsWith('INSERT INTO workflow_executions')) return { rows: [{ id: 'exec-1' }] };
      if (text.startsWith('SELECT attempt_count')) return { rows: [{ attempt_count: 0 }] };
      return { rows: [] };
    });
    // Force a hard failure by making the action throw (fetch is unavailable/undefined in this env
    // for an https URL with no network — executeAction's catch turns it into status: 'failed').
    global.fetch = vi.fn(async () => { throw new Error('network down'); });
    const { runWorkflow } = load();
    const r = await runWorkflow(failingWf, {}, { orgId: 'o1' });
    expect(r.status).toBe('failed');
    const updateCall = dbQuery.mock.calls.find(([text]) => text.includes('attempt_count = $4'));
    expect(updateCall).toBeTruthy();
    const [, params] = updateCall;
    const [, , , attempt, nextRetryAt, deadLetter] = params;
    expect(attempt).toBe(1);
    expect(deadLetter).toBe(false);
    expect(new Date(nextRetryAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('dead-letters on the MAX_ATTEMPTS-th failure (next_retry_at NULL, dead_letter true)', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.startsWith('INSERT INTO workflow_executions')) return { rows: [{ id: 'exec-1' }] };
      if (text.startsWith('SELECT attempt_count')) return { rows: [{ attempt_count: 4 }] }; // 5th attempt = MAX_ATTEMPTS
      return { rows: [] };
    });
    global.fetch = vi.fn(async () => { throw new Error('network down'); });
    const { runWorkflow } = load();
    await runWorkflow(failingWf, {}, { orgId: 'o1' });
    const updateCall = dbQuery.mock.calls.find(([text]) => text.includes('attempt_count = $4'));
    const [, params] = updateCall;
    const [, , , attempt, nextRetryAt, deadLetter] = params;
    expect(attempt).toBe(5);
    expect(deadLetter).toBe(true);
    expect(nextRetryAt).toBeNull();
  });

  // Regression (Nina, 2026-07-01): idempotencyKey() derives the SAME key for a
  // retry-sweep republish as the original failed row (it prefers event.responseId/
  // entityId/id over the stream entry id — see workflowQueue.ts). If the failed
  // row's idempotency_key isn't cleared when a retry will follow, the retried
  // attempt's `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING` collides with
  // the still-present original row and silently no-ops — automatic retry would
  // never actually re-execute. finalizeExecution must null the key on any
  // attempt that will be retried, and must NOT null it on the terminal
  // dead-lettered attempt (no further retry will happen; keeping the key intact
  // preserves that row's audit trail).
  it('clears idempotency_key on a failure that will be retried (so the retried attempt can claim a fresh row)', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.startsWith('INSERT INTO workflow_executions')) return { rows: [{ id: 'exec-1' }] };
      if (text.startsWith('SELECT attempt_count')) return { rows: [{ attempt_count: 0 }] };
      return { rows: [] };
    });
    global.fetch = vi.fn(async () => { throw new Error('network down'); });
    const { runWorkflow } = load();
    await runWorkflow(failingWf, {}, { orgId: 'o1', idempotencyKey: 'o1:w1:survey.response_filtered:r1' });
    const updateCall = dbQuery.mock.calls.find(([text]) => text.includes('attempt_count = $4'));
    expect(updateCall[0]).toContain('idempotency_key = CASE WHEN $7 THEN NULL ELSE idempotency_key END');
    const [, params] = updateCall;
    expect(params[6]).toBe(true); // willRetry
  });

  it('preserves idempotency_key on the terminal dead-lettered attempt', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.startsWith('INSERT INTO workflow_executions')) return { rows: [{ id: 'exec-1' }] };
      if (text.startsWith('SELECT attempt_count')) return { rows: [{ attempt_count: 4 }] }; // 5th attempt = MAX_ATTEMPTS
      return { rows: [] };
    });
    global.fetch = vi.fn(async () => { throw new Error('network down'); });
    const { runWorkflow } = load();
    await runWorkflow(failingWf, {}, { orgId: 'o1', idempotencyKey: 'o1:w1:survey.response_filtered:r1' });
    const updateCall = dbQuery.mock.calls.find(([text]) => text.includes('attempt_count = $4'));
    const [, params] = updateCall;
    expect(params[6]).toBe(false); // willRetry=false on the dead-lettering attempt — key preserved
  });
});
