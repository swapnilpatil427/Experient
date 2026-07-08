import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import inject from 'light-my-request';
import express from 'express';
import { randomBytes } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);

const AUTH_PATH   = _require.resolve(resolve(__dirname, '../middleware/auth'));
const PERM_PATH   = _require.resolve(resolve(__dirname, '../middleware/requirePermission'));
const RATE_PATH   = _require.resolve(resolve(__dirname, '../middleware/rateLimiter'));
const DB_PATH     = _require.resolve(resolve(__dirname, '../lib/db'));
const CREDS_PATH  = _require.resolve(resolve(__dirname, '../lib/workflowCredentials'));
const CONN_PATH   = _require.resolve(resolve(__dirname, '../lib/connectors'));
const TEST_PATH   = _require.resolve(resolve(__dirname, '../lib/connectorTest'));
const ROUTER_PATH = _require.resolve(resolve(__dirname, '../routes/workflowCredentials'));

let dbQuery;
let requirePermissionMock;
function fakeMod(id, exports) { return { id, filename: id, loaded: true, exports, children: [] }; }
function buildApp() {
  _require.cache[AUTH_PATH] = fakeMod(AUTH_PATH, {
    requireAuth: (req, res, next) => { req.orgId = 'o1'; req.userId = 'u1'; next(); },
  });
  _require.cache[PERM_PATH] = fakeMod(PERM_PATH, { requirePermission: requirePermissionMock });
  // connectorTestLimiter is a pass-through in these tests — rate-limiter behavior
  // itself is covered by rateLimiter.test.js; here we only need the route wiring.
  _require.cache[RATE_PATH] = fakeMod(RATE_PATH, {
    apiLimiter: (req, res, next) => next(),
    aiLimiter: (req, res, next) => next(),
    connectorTestLimiter: (req, res, next) => next(),
  });
  _require.cache[DB_PATH] = fakeMod(DB_PATH, { query: dbQuery, default: { query: dbQuery } });
  delete _require.cache[CREDS_PATH];
  delete _require.cache[CONN_PATH];
  delete _require.cache[TEST_PATH];
  delete _require.cache[ROUTER_PATH];
  const router = _require(ROUTER_PATH);
  const app = express(); app.use(express.json()); app.use('/api/workflow-credentials', router.default || router);
  return app;
}
async function api(app, method, url, payload) {
  const res = await inject(app, { method, url, payload });
  return { status: res.statusCode, body: res.json() };
}

beforeEach(() => {
  dbQuery = vi.fn(async () => ({ rows: [] }));
  process.env.WORKFLOW_CREDENTIALS_KEY = randomBytes(32).toString('hex');
  // Default: allow, mirroring the pass-through mock used by other org-settings route
  // tests (e.g. departments.test.js) — individual tests below override to assert deny.
  requirePermissionMock = vi.fn(() => (req, res, next) => next());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Regression test: this route stores/serves per-org third-party integration secrets
// (Jira/Zendesk/Slack/webhook tokens) and MUST be gated the same way every other
// org-settings/secrets route in this codebase is (see notificationChannels.ts,
// scimTokens.ts, roles.ts, etc.) — requireAuth alone is not enough, because any
// authenticated org member (not just an admin) would otherwise be able to read which
// connectors are configured, or overwrite/delete an org's live integration credentials.
describe('workflow-credentials permission gating', () => {
  it('enforces requirePermission("workflows:manage") on every route, including /test', async () => {
    dbQuery = vi.fn(async () => ({ rows: [] }));
    // A denying requirePermission implementation should short-circuit every route.
    requirePermissionMock = vi.fn((action) => (req, res) => {
      res.status(403).json({ error: `forbidden: ${action}` });
    });
    const app = buildApp();

    const getRes = await api(app, 'GET', '/api/workflow-credentials');
    expect(getRes.status).toBe(403);

    const putRes = await api(app, 'PUT', '/api/workflow-credentials/zendesk', { data: { apiToken: 'x' } });
    expect(putRes.status).toBe(403);

    const delRes = await api(app, 'DELETE', '/api/workflow-credentials/zendesk');
    expect(delRes.status).toBe(403);

    const testRes = await api(app, 'POST', '/api/workflow-credentials/zendesk/test', { data: { apiToken: 'x' } });
    expect(testRes.status).toBe(403);

    expect(requirePermissionMock).toHaveBeenCalledWith('workflows:manage');
  });
});

describe('GET /api/workflow-credentials', () => {
  it('reports status org|shared|none for every connector, never returning decrypted secrets', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('FROM workflow_connector_credentials')) {
        return { rows: [{ connector: 'zendesk', created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z' }] };
      }
      if (text.includes('FROM notification_channels')) {
        return { rows: [] }; // no Slack channel configured
      }
      return { rows: [] };
    });
    const { status, body } = await api(buildApp(), 'GET', '/api/workflow-credentials');
    expect(status).toBe(200);
    expect(body.connectors).toEqual([
      { connector: 'jira', status: 'none' },
      { connector: 'salesforce', status: 'none' },
      { connector: 'servicenow', status: 'none' },
      { connector: 'zendesk', status: 'org', createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-01T00:00:00Z' },
      { connector: 'slack', status: 'none' },
      { connector: 'webhook', status: 'none' },
    ]);
    expect(JSON.stringify(body)).not.toMatch(/token|secret|password/i);
  });

  it('reports "shared" for a connector with no vault row but complete shared env vars', async () => {
    process.env.ZENDESK_SUBDOMAIN = 'acme';
    process.env.ZENDESK_EMAIL = 'agent@acme.com';
    process.env.ZENDESK_API_TOKEN = 'tok-123';
    dbQuery = vi.fn(async () => ({ rows: [] }));
    const { body } = await api(buildApp(), 'GET', '/api/workflow-credentials');
    const zendesk = body.connectors.find((c) => c.connector === 'zendesk');
    expect(zendesk).toEqual({ connector: 'zendesk', status: 'shared' });
    delete process.env.ZENDESK_SUBDOMAIN;
    delete process.env.ZENDESK_EMAIL;
    delete process.env.ZENDESK_API_TOKEN;
  });

  it('reports "none" (not "shared") when only some of a connector\'s env vars are set', async () => {
    process.env.JIRA_BASE_URL = 'https://acme.atlassian.net';
    // JIRA_EMAIL / JIRA_API_TOKEN / JIRA_PROJECT_KEY intentionally left unset
    dbQuery = vi.fn(async () => ({ rows: [] }));
    const { body } = await api(buildApp(), 'GET', '/api/workflow-credentials');
    const jira = body.connectors.find((c) => c.connector === 'jira');
    expect(jira).toEqual({ connector: 'jira', status: 'none' });
    delete process.env.JIRA_BASE_URL;
  });

  it('includes Slack (backed by notification_channels) as status "org" in the same response', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('FROM notification_channels')) {
        return { rows: [{ created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z' }] };
      }
      return { rows: [] };
    });
    const { body } = await api(buildApp(), 'GET', '/api/workflow-credentials');
    const slack = body.connectors.find((c) => c.connector === 'slack');
    expect(slack).toEqual({ connector: 'slack', status: 'org', createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-01T00:00:00Z' });
  });
});

describe('PUT /api/workflow-credentials/:connector', () => {
  it('rejects an unknown connector', async () => {
    const { status, body } = await api(buildApp(), 'PUT', '/api/workflow-credentials/notarealconnector', { data: { x: 1 } });
    expect(status).toBe(400);
    expect(body.error).toMatch(/Unknown connector/);
  });

  it('encrypts and stores credentials for a known connector', async () => {
    let insertedBlob = null;
    dbQuery = vi.fn(async (text, params) => {
      if (text.includes('INSERT INTO workflow_connector_credentials')) {
        insertedBlob = JSON.parse(params[2]);
        return { rows: [] };
      }
      return { rows: [] };
    });
    const { status, body } = await api(buildApp(), 'PUT', '/api/workflow-credentials/zendesk', {
      data: { subdomain: 'acme', email: 'a@acme.com', apiToken: 'tkn-secret' },
    });
    expect(status).toBe(200);
    expect(body).toEqual({ connector: 'zendesk', configured: true });
    expect(insertedBlob).toHaveProperty('ciphertext');
    expect(insertedBlob.ciphertext).not.toContain('tkn-secret');
  });

  it('returns 503 when the credentials vault key is not configured', async () => {
    delete process.env.WORKFLOW_CREDENTIALS_KEY;
    const { status, body } = await api(buildApp(), 'PUT', '/api/workflow-credentials/jira', { data: { apiToken: 'x' } });
    expect(status).toBe(503);
    expect(body.error).toMatch(/not configured/i);
  });

  // Regression test: setCredentials used to REPLACE the stored row wholesale.
  // Since GET never returns decrypted secrets (write-only by design), the natural
  // settings-page edit flow is "only send the field(s) the user changed" — e.g.
  // rotating just apiToken on an already-configured Jira connector. A naive
  // overwrite would silently null out baseUrl/email/projectKey. setCredentials
  // must MERGE the incoming fields onto the existing decrypted row instead.
  it('merges a partial update onto existing stored fields instead of replacing them', async () => {
    // Import the REAL encrypt/decrypt so this test exercises true round-trip
    // behavior, not a mocked stand-in.
    delete _require.cache[CREDS_PATH];
    const { encryptCredentials, decryptCredentials } = _require(CREDS_PATH);
    const key = Buffer.from(process.env.WORKFLOW_CREDENTIALS_KEY, 'hex');
    const existingBlob = encryptCredentials(
      { baseUrl: 'https://acme.atlassian.net', email: 'old@acme.com', apiToken: 'old-token', projectKey: 'SUP' },
      key
    );

    let insertedBlob = null;
    dbQuery = vi.fn(async (text, params) => {
      if (text.includes('SELECT org_id, connector, encrypted_blob')) {
        return { rows: [{ org_id: 'o1', connector: 'jira', encrypted_blob: existingBlob }] };
      }
      if (text.includes('INSERT INTO workflow_connector_credentials')) {
        insertedBlob = JSON.parse(params[2]);
        return { rows: [] };
      }
      return { rows: [] };
    });

    const { status, body } = await api(buildApp(), 'PUT', '/api/workflow-credentials/jira', {
      data: { apiToken: 'new-token' }, // only the rotated field
    });

    expect(status).toBe(200);
    expect(body).toEqual({ connector: 'jira', configured: true });

    const merged = decryptCredentials(insertedBlob, key);
    expect(merged).toEqual({
      baseUrl: 'https://acme.atlassian.net',
      email: 'old@acme.com',
      apiToken: 'new-token', // updated
      projectKey: 'SUP',     // preserved, not wiped
    });
  });
});

describe('DELETE /api/workflow-credentials/:connector', () => {
  it('404s when nothing is configured for that connector', async () => {
    dbQuery = vi.fn(async () => ({ rowCount: 0, rows: [] }));
    const { status } = await api(buildApp(), 'DELETE', '/api/workflow-credentials/jira');
    expect(status).toBe(404);
  });

  it('deletes an existing credential row', async () => {
    dbQuery = vi.fn(async () => ({ rowCount: 1, rows: [] }));
    const { status, body } = await api(buildApp(), 'DELETE', '/api/workflow-credentials/jira');
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  it('rejects an unknown connector', async () => {
    const { status } = await api(buildApp(), 'DELETE', '/api/workflow-credentials/notarealconnector');
    expect(status).toBe(400);
  });
});

describe('POST /api/workflow-credentials/:connector/test', () => {
  it('rejects an unknown connector', async () => {
    const { status, body } = await api(buildApp(), 'POST', '/api/workflow-credentials/notarealconnector/test', { data: {} });
    expect(status).toBe(400);
    expect(body.error).toMatch(/Unknown connector/);
  });

  it('reports success:false (not a 5xx) when nothing resolves — no data, no vault row, no env fallback', async () => {
    const { status, body } = await api(buildApp(), 'POST', '/api/workflow-credentials/zendesk/test');
    expect(status).toBe(200);
    expect(body.success).toBe(false);
    expect(body.message).toMatch(/not configured/i);
    expect(body.failedCheck).toBe('not_configured');
  });

  it('rejects webhook — no fixed endpoint to test', async () => {
    const { status, body } = await api(buildApp(), 'POST', '/api/workflow-credentials/webhook/test', { data: { secret: 'x' } });
    expect(status).toBe(400);
    expect(body.error).toMatch(/no fixed endpoint/i);
  });

  it('tests candidate (not-yet-saved) Jira credentials against the real /myself and /project endpoints', async () => {
    const fetchMock = vi.fn(async (url) => {
      if (url.endsWith('/rest/api/3/myself')) return { ok: true, status: 200, json: async () => ({ accountId: 'a1' }) };
      if (url.includes('/rest/api/3/project/')) return { ok: true, status: 200, json: async () => ({ key: 'SUP' }) };
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { status, body } = await api(buildApp(), 'POST', '/api/workflow-credentials/jira/test', {
      data: { baseUrl: 'https://acme.atlassian.net', email: 'a@acme.com', apiToken: 'candidate-token', projectKey: 'SUP' },
    });

    expect(status).toBe(200);
    expect(body).toEqual({ success: true, checks: { auth: 'ok', project: 'ok' } });
    // Never persisted — no INSERT/UPDATE call was made to the vault table.
    expect(dbQuery).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO workflow_connector_credentials'), expect.anything());
  });

  it('maps a 401 from Jira to a human-readable "invalid credentials" style message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })));
    const { status, body } = await api(buildApp(), 'POST', '/api/workflow-credentials/jira/test', {
      data: { baseUrl: 'https://acme.atlassian.net', email: 'a@acme.com', apiToken: 'bad', projectKey: 'SUP' },
    });
    expect(status).toBe(200); // test-connection result is a 200 envelope; success:false signals failure
    expect(body.success).toBe(false);
    expect(body.message).toMatch(/invalid email or api token/i);
    expect(body.failedCheck).toBe('auth');
  });

  it('maps a network timeout to a clear message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      const err = new Error('The operation was aborted');
      err.name = 'TimeoutError';
      throw err;
    }));
    const { body } = await api(buildApp(), 'POST', '/api/workflow-credentials/zendesk/test', {
      data: { subdomain: 'acme', email: 'a@acme.com', apiToken: 'x' },
    });
    expect(body.success).toBe(false);
    expect(body.message).toMatch(/timed out/i);
  });

  it('falls back to the saved vault row when no data is sent in the test request', async () => {
    delete _require.cache[CREDS_PATH];
    const { encryptCredentials } = _require(CREDS_PATH);
    const key = Buffer.from(process.env.WORKFLOW_CREDENTIALS_KEY, 'hex');
    const blob = encryptCredentials({ subdomain: 'acme', email: 'agent@acme.com', apiToken: 'saved-token' }, key);
    dbQuery = vi.fn(async (text) => {
      if (text.includes('SELECT org_id, connector, encrypted_blob')) {
        return { rows: [{ org_id: 'o1', connector: 'zendesk', encrypted_blob: blob }] };
      }
      return { rows: [] };
    });
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ id: 1 }) }));
    vi.stubGlobal('fetch', fetchMock);

    const { status, body } = await api(buildApp(), 'POST', '/api/workflow-credentials/zendesk/test');
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers.Authorization).toBe(`Basic ${Buffer.from('agent@acme.com/token:saved-token').toString('base64')}`);
  });

  it('sends a real Slack test message and reports success', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);
    const { status, body } = await api(buildApp(), 'POST', '/api/workflow-credentials/slack/test', {
      data: { webhook_url: 'https://hooks.slack.com/services/T000/B000/XXXX' },
    });
    expect(status).toBe(200);
    expect(body).toEqual({ success: true, message: expect.stringMatching(/test message sent/i) });
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://hooks.slack.com/services/T000/B000/XXXX');
    const sentBody = JSON.parse(opts.body);
    expect(sentBody.text).toMatch(/test message/i);
  });

  // Security review requirement (INTEGRATIONS_BACKEND_REVIEW.md §4): the test
  // endpoint accepts raw, possibly-unsaved credentials in the request body —
  // confirm the response body and any warn-level logging never echo them back.
  it('never logs or echoes the raw candidate credential values on failure', async () => {
    const logger = _require(_require.resolve(resolve(__dirname, '../lib/logger'))).default;
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })));
    const secretToken = 'sk-super-secret-value-should-never-appear-anywhere';
    const { status, body } = await api(buildApp(), 'POST', '/api/workflow-credentials/zendesk/test', {
      data: { subdomain: 'acme', email: 'a@acme.com', apiToken: secretToken },
    });

    expect(status).toBe(200);
    expect(JSON.stringify(body)).not.toContain(secretToken);

    for (const call of warnSpy.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(secretToken);
    }
    warnSpy.mockRestore();
  });
});
