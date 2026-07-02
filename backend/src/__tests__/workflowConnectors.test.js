import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHmac } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);

const DB_PATH    = _require.resolve(resolve(__dirname, '../lib/db'));
const CREDS_PATH = _require.resolve(resolve(__dirname, '../lib/workflowCredentials'));
const CONN_PATH  = _require.resolve(resolve(__dirname, '../lib/connectors'));

let dbQuery;
function fakeMod(id, exports) { return { id, filename: id, loaded: true, exports, children: [] }; }

// Load connectors.ts with a real (non-mocked) workflowCredentials — used for tests
// that exercise the org-credentials-first / env-fallback behavior end to end.
function loadConnectorsWithRealCredentials() {
  _require.cache[DB_PATH] = fakeMod(DB_PATH, { query: dbQuery, default: { query: dbQuery } });
  delete _require.cache[CREDS_PATH];
  delete _require.cache[CONN_PATH];
  return _require(CONN_PATH);
}

const ENV_KEYS = [
  'ZENDESK_SUBDOMAIN', 'ZENDESK_EMAIL', 'ZENDESK_API_TOKEN',
  'JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN', 'JIRA_PROJECT_KEY',
  'SERVICENOW_INSTANCE_URL', 'SERVICENOW_USER', 'SERVICENOW_PASSWORD',
  'WORKFLOW_CREDENTIALS_KEY',
];

beforeEach(() => {
  dbQuery = vi.fn(async () => ({ rows: [] })); // no org credentials by default
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ENV_KEYS) delete process.env[k];
});

// ── Zendesk connector ─────────────────────────────────────────────────────────
describe('zendeskCreateTicket', () => {
  it('is skipped (graceful) when unconfigured', async () => {
    const { zendeskCreateTicket } = loadConnectorsWithRealCredentials();
    const r = await zendeskCreateTicket({}, { orgId: 'o1', event: {}, vars: {} });
    expect(r.status).toBe('skipped');
    expect(r.output).toEqual({ connector: 'zendesk', reason: 'not_configured' });
  });

  it('creates a ticket with tags + templated requester email when configured', async () => {
    process.env.ZENDESK_SUBDOMAIN = 'acme';
    process.env.ZENDESK_EMAIL = 'agent@acme.com';
    process.env.ZENDESK_API_TOKEN = 'tok-123';
    const fetchMock = vi.fn(async () => ({ ok: true, status: 201, json: async () => ({ ticket: { id: 42 } }) }));
    vi.stubGlobal('fetch', fetchMock);

    const { zendeskCreateTicket } = loadConnectorsWithRealCredentials();
    const r = await zendeskCreateTicket(
      { tags: ['xperiq', 'detractor'], requesterEmail: '{{email}}', subject: 'NPS drop: {{title}}' },
      { orgId: 'o1', event: { title: 'Big account', email: 'user@customer.com' }, vars: {} }
    );

    expect(r.status).toBe('completed');
    expect(r.output).toEqual({ connector: 'zendesk', ticketId: 42, status: 201 });

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://acme.zendesk.com/api/v2/tickets.json');
    expect(opts.method).toBe('POST');
    const expectedAuth = `Basic ${Buffer.from('agent@acme.com/token:tok-123').toString('base64')}`;
    expect(opts.headers.Authorization).toBe(expectedAuth);
    const body = JSON.parse(opts.body);
    expect(body.ticket.tags).toEqual(['xperiq', 'detractor']);
    expect(body.ticket.requester).toEqual({ email: 'user@customer.com' });
    expect(body.ticket.subject).toBe('NPS drop: Big account');
  });

  it('reports failed status on a Zendesk API error (e.g. 401 auth failure)', async () => {
    process.env.ZENDESK_SUBDOMAIN = 'acme';
    process.env.ZENDESK_EMAIL = 'agent@acme.com';
    process.env.ZENDESK_API_TOKEN = 'bad-token';
    const fetchMock = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ error: 'Couldn’t authenticate you' }) }));
    vi.stubGlobal('fetch', fetchMock);

    const { zendeskCreateTicket } = loadConnectorsWithRealCredentials();
    const r = await zendeskCreateTicket({}, { orgId: 'o1', event: {}, vars: {} });
    expect(r.status).toBe('failed');
    expect(r.output.status).toBe(401);
  });

  it('reports failed status on a 429 rate-limit response', async () => {
    process.env.ZENDESK_SUBDOMAIN = 'acme';
    process.env.ZENDESK_EMAIL = 'agent@acme.com';
    process.env.ZENDESK_API_TOKEN = 'tok-123';
    const fetchMock = vi.fn(async () => ({ ok: false, status: 429, json: async () => ({ error: 'Too Many Requests' }) }));
    vi.stubGlobal('fetch', fetchMock);

    const { zendeskCreateTicket } = loadConnectorsWithRealCredentials();
    const r = await zendeskCreateTicket({}, { orgId: 'o1', event: {}, vars: {} });
    expect(r.status).toBe('failed');
    expect(r.output.status).toBe(429);
  });

  it('reports failed (not throws) on a network error', async () => {
    process.env.ZENDESK_SUBDOMAIN = 'acme';
    process.env.ZENDESK_EMAIL = 'agent@acme.com';
    process.env.ZENDESK_API_TOKEN = 'tok-123';
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET'); }));

    const { zendeskCreateTicket } = loadConnectorsWithRealCredentials();
    const r = await zendeskCreateTicket({}, { orgId: 'o1', event: {}, vars: {} });
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/ECONNRESET/);
  });
});

// ── Per-org credentials override shared env vars ──────────────────────────────
describe('connectors prefer per-org vaulted credentials over shared env vars', () => {
  it('jiraCreateIssue uses org credentials when configured, ignoring env', async () => {
    process.env.JIRA_BASE_URL = 'https://env-shared.atlassian.net';
    process.env.JIRA_EMAIL = 'shared@env.com';
    process.env.JIRA_API_TOKEN = 'env-token';
    process.env.JIRA_PROJECT_KEY = 'ENV';
    process.env.WORKFLOW_CREDENTIALS_KEY = randomBytes(32).toString('hex');

    // Build an encrypted row the same way workflowCredentials.encryptCredentials would.
    const { encryptCredentials } = _require(CREDS_PATH);
    const key = Buffer.from(process.env.WORKFLOW_CREDENTIALS_KEY, 'hex');
    const blob = encryptCredentials({ baseUrl: 'https://acme.atlassian.net', email: 'org@acme.com', apiToken: 'org-token', projectKey: 'ACME' }, key);
    dbQuery = vi.fn(async (text) => {
      if (text.includes('FROM workflow_connector_credentials')) {
        return { rows: [{ encrypted_blob: blob }] };
      }
      return { rows: [] };
    });

    const fetchMock = vi.fn(async () => ({ ok: true, status: 201, json: async () => ({ key: 'ACME-1' }) }));
    vi.stubGlobal('fetch', fetchMock);

    const { jiraCreateIssue } = loadConnectorsWithRealCredentials();
    const r = await jiraCreateIssue({}, { orgId: 'o1', event: {}, vars: {} });
    expect(r.status).toBe('completed');
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain('acme.atlassian.net');
    const expectedAuth = `Basic ${Buffer.from('org@acme.com:org-token').toString('base64')}`;
    expect(opts.headers.Authorization).toBe(expectedAuth);
  });

  it('falls back to shared env vars when no org credentials row exists', async () => {
    process.env.JIRA_BASE_URL = 'https://env-shared.atlassian.net';
    process.env.JIRA_EMAIL = 'shared@env.com';
    process.env.JIRA_API_TOKEN = 'env-token';
    process.env.JIRA_PROJECT_KEY = 'ENV';
    process.env.WORKFLOW_CREDENTIALS_KEY = randomBytes(32).toString('hex');
    dbQuery = vi.fn(async () => ({ rows: [] })); // no org row

    const fetchMock = vi.fn(async () => ({ ok: true, status: 201, json: async () => ({ key: 'ENV-1' }) }));
    vi.stubGlobal('fetch', fetchMock);

    const { jiraCreateIssue } = loadConnectorsWithRealCredentials();
    const r = await jiraCreateIssue({}, { orgId: 'o1', event: {}, vars: {} });
    expect(r.status).toBe('completed');
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('env-shared.atlassian.net');
  });

  it('falls back to shared env vars when WORKFLOW_CREDENTIALS_KEY is unset (dev degrade)', async () => {
    process.env.SERVICENOW_INSTANCE_URL = 'https://env.service-now.com';
    process.env.SERVICENOW_USER = 'env-user';
    process.env.SERVICENOW_PASSWORD = 'env-pass';
    // WORKFLOW_CREDENTIALS_KEY intentionally unset.
    const fetchMock = vi.fn(async () => ({ ok: true, status: 201, json: async () => ({ result: { sys_id: 's1' } }) }));
    vi.stubGlobal('fetch', fetchMock);

    const { servicenowCreateIncident } = loadConnectorsWithRealCredentials();
    const r = await servicenowCreateIncident({}, { orgId: 'o1', event: {}, vars: {} });
    expect(r.status).toBe('completed');
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('env.service-now.com');
  });
});

// ── HMAC webhook signature ────────────────────────────────────────────────────
describe('signWebhookPayload', () => {
  it('produces the same signature the receiver would compute independently', () => {
    const { signWebhookPayload } = loadConnectorsWithRealCredentials();
    const body = JSON.stringify({ event: { type: 'score.nps_drop', nps: 3 } });
    const secret = 'whsec_test_secret';
    const sig = signWebhookPayload(body, secret);
    const expected = createHmac('sha256', secret).update(body, 'utf8').digest('hex');
    expect(sig).toBe(expected);
    expect(sig).toMatch(/^[0-9a-f]{64}$/); // sha256 hex digest length
  });

  it('produces different signatures for different secrets or bodies', () => {
    const { signWebhookPayload } = loadConnectorsWithRealCredentials();
    const body = JSON.stringify({ a: 1 });
    const sigA = signWebhookPayload(body, 'secret-a');
    const sigB = signWebhookPayload(body, 'secret-b');
    const sigC = signWebhookPayload(JSON.stringify({ a: 2 }), 'secret-a');
    expect(sigA).not.toBe(sigB);
    expect(sigA).not.toBe(sigC);
  });
});

// ── Credentials vault encrypt/decrypt round-trip ──────────────────────────────
describe('workflowCredentials encrypt/decrypt round-trip', () => {
  it('round-trips a credential payload', () => {
    delete _require.cache[CREDS_PATH];
    const { encryptCredentials, decryptCredentials } = _require(CREDS_PATH);
    const key = randomBytes(32);
    const data = { apiToken: 'super-secret-token', email: 'org@acme.com' };
    const blob = encryptCredentials(data, key);
    expect(blob).toHaveProperty('iv');
    expect(blob).toHaveProperty('tag');
    expect(blob).toHaveProperty('ciphertext');
    expect(blob.ciphertext).not.toContain('super-secret-token'); // never plaintext on the wire/at rest
    const decrypted = decryptCredentials(blob, key);
    expect(decrypted).toEqual(data);
  });

  it('fails to decrypt with the wrong key (auth tag mismatch)', () => {
    delete _require.cache[CREDS_PATH];
    const { encryptCredentials, decryptCredentials } = _require(CREDS_PATH);
    const blob = encryptCredentials({ secret: 'x' }, randomBytes(32));
    expect(() => decryptCredentials(blob, randomBytes(32))).toThrow();
  });

  it('getCredentials/setCredentials round-trip through a mocked db row', async () => {
    process.env.WORKFLOW_CREDENTIALS_KEY = randomBytes(32).toString('hex');
    delete _require.cache[CREDS_PATH];
    let storedBlob = null;
    dbQuery = vi.fn(async (text, params) => {
      if (text.includes('INSERT INTO workflow_connector_credentials')) {
        storedBlob = JSON.parse(params[2]);
        return { rows: [] };
      }
      if (text.includes('FROM workflow_connector_credentials')) {
        return storedBlob ? { rows: [{ encrypted_blob: storedBlob }] } : { rows: [] };
      }
      return { rows: [] };
    });
    _require.cache[DB_PATH] = fakeMod(DB_PATH, { query: dbQuery, default: { query: dbQuery } });
    const { setCredentials, getCredentials } = _require(CREDS_PATH);

    await setCredentials('org-1', 'zendesk', { subdomain: 'acme', email: 'a@acme.com', apiToken: 'tkn' });
    const out = await getCredentials('org-1', 'zendesk');
    expect(out).toEqual({ subdomain: 'acme', email: 'a@acme.com', apiToken: 'tkn' });
  });

  it('getCredentials returns null (not throw) when the vault key is unset', async () => {
    delete _require.cache[CREDS_PATH];
    dbQuery = vi.fn(async () => ({ rows: [] }));
    _require.cache[DB_PATH] = fakeMod(DB_PATH, { query: dbQuery, default: { query: dbQuery } });
    const { getCredentials } = _require(CREDS_PATH);
    const out = await getCredentials('org-1', 'jira');
    expect(out).toBeNull();
  });

  it('setCredentials throws a clear error when the vault key is unset', async () => {
    delete _require.cache[CREDS_PATH];
    const { setCredentials } = _require(CREDS_PATH);
    await expect(setCredentials('org-1', 'jira', { apiToken: 'x' })).rejects.toThrow(/WORKFLOW_CREDENTIALS_KEY/);
  });
});
