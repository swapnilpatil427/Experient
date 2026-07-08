// Read-only "Test Connection" calls for workflow connectors. Deliberately
// SEPARATE from connectors.ts's action-executing functions (jiraCreateIssue,
// etc.) even though they share credential-resolution helpers: these functions
// have a fundamentally different contract — no side effects, safe to call
// repeatedly, callable with EITHER saved credentials or ad-hoc unsaved values a
// user just typed into a settings-page form (test-before-save). Mixing them into
// connectors.ts would blur "this creates a Jira issue" vs. "this only checks
// auth" at a glance.
//
// Design/rationale: docs/automation-hub/INTEGRATIONS_BACKEND_REVIEW.md §3.
// Per-connector call choice and error copy cross-checked against David Mensah's
// docs/automation-hub/INTEGRATIONS_CONNECTOR_SPEC.md (§1-5) — no conflicts found.
import {
  CONNECTOR_FETCH_TIMEOUT_MS,
  resolveJiraFields, resolveSalesforceFields, resolveServicenowFields, resolveZendeskFields,
  type JiraFields, type SalesforceFields, type ServicenowFields, type ZendeskFields,
} from './connectors';
import { query } from './db';

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

function log(level: LogLevel, obj: Record<string, unknown>, msg: string): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    (require('./logger') as Record<string, (obj: unknown, msg: string) => void>)[level](obj, msg);
  } catch { console.log(`[connectorTest] ${msg}`, obj); }
}

export interface ConnectorTestResult {
  success: boolean;
  message?: string;
  checks?: Record<string, string>;
  failedCheck?: string;
}

// Never log the raw field values — connector name + outcome only, mirrors
// connectors.ts's existing log('warn', { event, status }) discipline exactly.
// See INTEGRATIONS_BACKEND_REVIEW.md §4.
function logTestFailure(connector: string, detail: Record<string, unknown>): void {
  log('warn', { event: 'connector_test_failed', connector, ...detail }, `${connector} test connection failed`);
}

/**
 * Map a failed HTTP response / thrown error to a human-readable message.
 * Centralizes the 401/403/404/timeout/network/429 mapping shared across
 * connectors; callers pass connector-specific wording for the cases David's
 * spec calls out (e.g. Jira's "check id.atlassian.com" vs Zendesk's "check
 * Admin Center").
 */
export function mapConnectorTestError(
  connectorLabel: string,
  status: number | 'timeout' | 'network' | null,
  overrides: Partial<Record<'401' | '403' | '404' | '429' | 'timeout' | 'network' | 'default', string>> = {}
): string {
  if (status === 'timeout') {
    return overrides.timeout || `Connection to ${connectorLabel} timed out after ${CONNECTOR_FETCH_TIMEOUT_MS / 1000} seconds.`;
  }
  if (status === 'network' || status === null) {
    return overrides.network || `Couldn't connect to ${connectorLabel} at all — double check the URL.`;
  }
  if (status === 401) return overrides['401'] || `Invalid credentials for ${connectorLabel}.`;
  if (status === 403) return overrides['403'] || `This account doesn't have permission to access the ${connectorLabel} API.`;
  if (status === 404) return overrides['404'] || `Resource not found — check your ${connectorLabel} configuration.`;
  if (status === 429) return overrides['429'] || `${connectorLabel} rate-limited this request — wait a minute and try again.`;
  return overrides.default || `${connectorLabel} returned an unexpected error (HTTP ${status}).`;
}

/** Shared fetch wrapper: bounds every test call to CONNECTOR_FETCH_TIMEOUT_MS and
 * normalizes thrown errors (timeout vs. network) to the same status vocabulary
 * mapConnectorTestError expects, so per-connector code never handles raw
 * AbortError/TypeError distinctions itself. */
async function testFetch(url: string, init: RequestInit): Promise<{ status: number | 'timeout' | 'network'; body: unknown }> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(CONNECTOR_FETCH_TIMEOUT_MS) });
    const body = await res.json().catch(() => ({}));
    return { status: res.ok ? res.status : res.status, body };
  } catch (err: unknown) {
    const name = err instanceof Error ? err.name : '';
    const status = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' as const : 'network' as const;
    return { status, body: null };
  }
}

// ── Jira ──────────────────────────────────────────────────────────────────────
export async function testJira(orgId: string, data?: JiraFields | null): Promise<ConnectorTestResult> {
  const { baseUrl, email, apiToken, projectKey } = await resolveJiraFields(orgId, data);
  if (!baseUrl || !email || !apiToken || !projectKey) {
    return { success: false, message: 'Jira is not configured — baseUrl, email, apiToken, and projectKey are all required.', failedCheck: 'not_configured' };
  }
  const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');
  const headers = { Authorization: `Basic ${auth}`, Accept: 'application/json' };

  const me = await testFetch(`${baseUrl.replace(/\/$/, '')}/rest/api/3/myself`, { headers });
  if (me.status !== 200) {
    logTestFailure('jira', { status: me.status });
    const message = mapConnectorTestError('Jira', me.status, {
      '401': "Invalid email or API token — check that the token hasn't expired in your Atlassian account settings (id.atlassian.com → Security → API tokens).",
      '403': "This Jira account doesn't have permission to access the API. Check the account's site permissions.",
      '404': "Couldn't reach a Jira site at that URL — check the base URL (should look like https://yourorg.atlassian.net).",
      timeout: `Connection to Jira timed out after ${CONNECTOR_FETCH_TIMEOUT_MS / 1000} seconds — check the base URL is correct and reachable.`,
      network: "Couldn't connect to that Jira URL at all — double check the domain.",
      '429': 'Jira rate-limited this request — wait a minute and try again.',
    });
    return { success: false, message, failedCheck: 'auth' };
  }

  const proj = await testFetch(`${baseUrl.replace(/\/$/, '')}/rest/api/3/project/${encodeURIComponent(projectKey)}`, { headers });
  if (proj.status !== 200) {
    logTestFailure('jira', { status: proj.status, check: 'project' });
    const message = proj.status === 404
      ? `Project key "${projectKey}" doesn't exist or isn't visible to this account.`
      : mapConnectorTestError('Jira', proj.status, { timeout: `Connection to Jira timed out after ${CONNECTOR_FETCH_TIMEOUT_MS / 1000} seconds.` });
    return { success: false, message, failedCheck: 'project' };
  }

  return { success: true, checks: { auth: 'ok', project: 'ok' } };
}

// ── Salesforce ────────────────────────────────────────────────────────────────
export async function testSalesforce(orgId: string, data?: SalesforceFields | null): Promise<ConnectorTestResult> {
  const { instanceUrl, accessToken } = await resolveSalesforceFields(orgId, data);
  if (!instanceUrl || !accessToken) {
    return { success: false, message: 'Salesforce is not configured — instanceUrl and accessToken are both required.', failedCheck: 'not_configured' };
  }
  const result = await testFetch(`${instanceUrl.replace(/\/$/, '')}/services/data/v59.0/sobjects/Contact/describe`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (result.status !== 200) {
    logTestFailure('salesforce', { status: result.status });
    const message = mapConnectorTestError('Salesforce', result.status, {
      '401': 'Invalid or expired access token — Salesforce access tokens are short-lived; generate a new one from your connected app.',
      '404': "Couldn't reach a Salesforce org at that instance URL — check it matches exactly what's in your Salesforce org's My Domain settings.",
      '403': "This token doesn't have permission to read the Contact object — check the connected app's OAuth scopes.",
      timeout: `Connection to Salesforce timed out after ${CONNECTOR_FETCH_TIMEOUT_MS / 1000} seconds.`,
      network: "That doesn't look like a reachable URL — check for typos.",
    });
    return { success: false, message, failedCheck: 'auth' };
  }
  return { success: true };
}

// ── ServiceNow ────────────────────────────────────────────────────────────────
export async function testServicenow(orgId: string, data?: ServicenowFields | null): Promise<ConnectorTestResult> {
  const { instanceUrl, user, password } = await resolveServicenowFields(orgId, data);
  if (!instanceUrl || !user || !password) {
    return { success: false, message: 'ServiceNow is not configured — instanceUrl, user, and password are all required.', failedCheck: 'not_configured' };
  }
  const auth = Buffer.from(`${user}:${password}`).toString('base64');
  const result = await testFetch(`${instanceUrl.replace(/\/$/, '')}/api/now/table/sys_user?sysparm_limit=1`, {
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
  });
  if (result.status !== 200) {
    logTestFailure('servicenow', { status: result.status });
    const message = mapConnectorTestError('ServiceNow', result.status, {
      '401': 'Invalid username or password for this ServiceNow instance.',
      '403': 'This account doesn\'t have permission to read the sys_user table — check its roles (needs at least `itil` or equivalent read access).',
      '404': "Couldn't find a ServiceNow instance at that URL — check the instance URL.",
      timeout: `Connection to ServiceNow timed out after ${CONNECTOR_FETCH_TIMEOUT_MS / 1000} seconds.`,
      '429': 'ServiceNow rate-limited this request — wait and try again.',
    });
    return { success: false, message, failedCheck: 'auth' };
  }
  return { success: true };
}

// ── Zendesk ───────────────────────────────────────────────────────────────────
export async function testZendesk(orgId: string, data?: ZendeskFields | null): Promise<ConnectorTestResult> {
  const { subdomain, email, apiToken } = await resolveZendeskFields(orgId, data);
  if (!subdomain || !email || !apiToken) {
    return { success: false, message: 'Zendesk is not configured — subdomain, email, and apiToken are all required.', failedCheck: 'not_configured' };
  }
  const auth = Buffer.from(`${email}/token:${apiToken}`).toString('base64');
  const result = await testFetch(`https://${subdomain}.zendesk.com/api/v2/users/me.json`, {
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
  });
  if (result.status !== 200) {
    logTestFailure('zendesk', { status: result.status });
    const message = mapConnectorTestError('Zendesk', result.status, {
      '401': "Invalid email or API token — check the token hasn't been revoked in Zendesk Admin Center.",
      '404': 'No Zendesk account found at that subdomain — check for typos (just the subdomain, e.g. "yourorg", not the full URL).',
      '403': 'This Zendesk account doesn\'t have API access enabled — check Admin Center → Apps and integrations → APIs.',
      timeout: `Connection to Zendesk timed out after ${CONNECTOR_FETCH_TIMEOUT_MS / 1000} seconds.`,
      '429': 'Zendesk rate-limited this request — wait a minute and try again.',
      network: 'No Zendesk account found at that subdomain — check for typos.',
    });
    return { success: false, message, failedCheck: 'auth' };
  }
  return { success: true };
}

// ── Slack ─────────────────────────────────────────────────────────────────────
// No side-effect-free auth-check verb exists for Slack incoming webhooks (POST is
// the only supported verb) — this sends a real, visible test message by design.
// See INTEGRATIONS_BACKEND_REVIEW.md §3 "Slack — decision".
// `webhook_url` (snake_case) matches the field name notification_channels.config
// and PUT /api/notification-channels already use for Slack — kept consistent
// rather than introducing a camelCase alias just for this endpoint.
export async function testSlack(orgId: string, data?: { webhook_url?: string } | null): Promise<ConnectorTestResult> {
  let webhookUrl = data?.webhook_url;
  if (!webhookUrl) {
    const { rows } = await query(
      `SELECT config FROM notification_channels
        WHERE org_id = $1 AND channel_type = 'slack' AND is_active = TRUE AND deleted_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
      [orgId]
    ).catch(() => ({ rows: [] as unknown[] }));
    webhookUrl = (rows[0] as { config?: { webhook_url?: string } } | undefined)?.config?.webhook_url;
  }
  if (!webhookUrl) {
    return { success: false, message: 'Slack is not configured — no webhook URL saved for this org.', failedCheck: 'not_configured' };
  }
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '✅ Test message from Xperiq — your Slack integration is working.' }),
      signal: AbortSignal.timeout(CONNECTOR_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      logTestFailure('slack', { status: res.status });
      const message = res.status === 404
        ? 'This webhook URL is no longer valid — it may have been deleted or revoked in Slack. Generate a new one from Slack\'s Incoming Webhooks app config.'
        : res.status === 400
          ? 'Slack rejected the request — double-check the webhook URL was copied correctly.'
          : "Couldn't deliver a test message to Slack — check the webhook URL is correct and hasn't expired.";
      return { success: false, message, failedCheck: 'delivery' };
    }
    return { success: true, message: 'Test message sent — check your Slack channel.' };
  } catch (err: unknown) {
    const name = err instanceof Error ? err.name : '';
    const timedOut = name === 'TimeoutError' || name === 'AbortError';
    logTestFailure('slack', { status: timedOut ? 'timeout' : 'network' });
    return {
      success: false,
      message: timedOut
        ? `Connection to Slack timed out after ${CONNECTOR_FETCH_TIMEOUT_MS / 1000} seconds.`
        : "Couldn't deliver a test message to Slack — check the webhook URL is correct and hasn't expired.",
      failedCheck: 'network',
    };
  }
}
