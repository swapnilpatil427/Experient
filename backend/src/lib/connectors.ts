// Workflow integration connectors. Real HTTP integrations (Jira REST, generic
// webhook) via built-in fetch — no new dependency. Credentials come from the
// per-org workflow_connector_credentials vault (workflowCredentials.ts) FIRST,
// falling back to shared env vars when no org-level credentials are configured
// (keeps today's env-var-only orgs working — zero breaking change). Each connector
// degrades to a graceful "not_configured" no-op so dev/tests work without keys.
//
// Crystal actions are deterministic here (templated) so they're offline-capable;
// an LLM upgrade can replace the body behind the same return shape.
import { createHmac } from 'crypto';
import { getCredentials } from './workflowCredentials';

// Shared outbound-fetch timeout for every connector call (Jira/Salesforce/
// ServiceNow/Zendesk) and workflowEngine.ts's notify.webhook action. A hung TCP
// connection otherwise has no bounded failure time, which defeats the
// retry/backoff design (lib/workflowQueue.ts) — an action can hang forever
// instead of failing and entering the retry path. See
// docs/automation-hub/RUNBOOKS.md §1 "root-cause follow-up". Exported so tests
// can assert the exact value and so it's tunable without touching call sites.
export const CONNECTOR_FETCH_TIMEOUT_MS = Number(process.env.WORKFLOW_CONNECTOR_TIMEOUT_MS) || 10_000;

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

function log(level: LogLevel, obj: Record<string, unknown>, msg: string): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    (require('./logger') as Record<string, (obj: unknown, msg: string) => void>)[level](obj, msg);
  } catch { console.log(`[connectors] ${msg}`, obj); }
}

/**
 * Sign a webhook payload with HMAC-SHA256, Stripe/GitHub/Segment-style. `body` must
 * be the EXACT raw string sent as the request body (sign after JSON.stringify, not
 * the object) so the receiver can verify byte-for-byte. Returns the hex digest —
 * callers send it as `X-Experient-Signature: sha256=<digest>`.
 */
export function signWebhookPayload(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

export interface ConnectorContext {
  orgId: string;
  workflowId?: string;
  event: Record<string, unknown>;
  vars: Record<string, unknown>;
}

export interface ConnectorResult {
  status: 'completed' | 'failed' | 'skipped';
  output: Record<string, unknown>;
  error?: string;
  vars?: Record<string, unknown>;
}

// ── Credential resolution (org vault → shared env var fallback) ──────────────
// Extracted so both the real action functions below AND the read-only test-
// connection endpoint (routes/workflowCredentials.ts's POST .../test, via
// connectorTest.ts) resolve credentials through the exact same precedence,
// rather than two copies that could silently drift. See
// docs/automation-hub/INTEGRATIONS_BACKEND_REVIEW.md §3/§6.
export interface JiraFields { baseUrl?: string; email?: string; apiToken?: string; projectKey?: string; }
export interface SalesforceFields { instanceUrl?: string; accessToken?: string; }
export interface ServicenowFields { instanceUrl?: string; user?: string; password?: string; }
export interface ZendeskFields { subdomain?: string; email?: string; apiToken?: string; }

/** Resolve Jira fields: explicit `data` (test-before-save) → org vault → shared env vars. */
export async function resolveJiraFields(orgId: string, data?: JiraFields | null): Promise<JiraFields> {
  const org = data ?? (await getCredentials(orgId, 'jira').catch(() => null) as JiraFields | null);
  return {
    baseUrl: org?.baseUrl || process.env.JIRA_BASE_URL,
    email: org?.email || process.env.JIRA_EMAIL,
    apiToken: org?.apiToken || process.env.JIRA_API_TOKEN,
    projectKey: org?.projectKey || process.env.JIRA_PROJECT_KEY,
  };
}

/** Resolve Salesforce fields: explicit `data` → org vault → shared env vars. */
export async function resolveSalesforceFields(orgId: string, data?: SalesforceFields | null): Promise<SalesforceFields> {
  const org = data ?? (await getCredentials(orgId, 'salesforce').catch(() => null) as SalesforceFields | null);
  return {
    instanceUrl: org?.instanceUrl || process.env.SF_INSTANCE_URL,
    accessToken: org?.accessToken || process.env.SF_ACCESS_TOKEN,
  };
}

/** Resolve ServiceNow fields: explicit `data` → org vault → shared env vars. */
export async function resolveServicenowFields(orgId: string, data?: ServicenowFields | null): Promise<ServicenowFields> {
  const org = data ?? (await getCredentials(orgId, 'servicenow').catch(() => null) as ServicenowFields | null);
  return {
    instanceUrl: org?.instanceUrl || process.env.SERVICENOW_INSTANCE_URL,
    user: org?.user || process.env.SERVICENOW_USER,
    password: org?.password || process.env.SERVICENOW_PASSWORD,
  };
}

/** Resolve Zendesk fields: explicit `data` → org vault → shared env vars. */
export async function resolveZendeskFields(orgId: string, data?: ZendeskFields | null): Promise<ZendeskFields> {
  const org = data ?? (await getCredentials(orgId, 'zendesk').catch(() => null) as ZendeskFields | null);
  return {
    subdomain: org?.subdomain || process.env.ZENDESK_SUBDOMAIN,
    email: org?.email || process.env.ZENDESK_EMAIL,
    apiToken: org?.apiToken || process.env.ZENDESK_API_TOKEN,
  };
}

// ── Jira ────────────────────────────────────────────────────────────────────
export async function jiraCreateIssue(config: Record<string, unknown>, ctx: ConnectorContext): Promise<ConnectorResult> {
  const org = await getCredentials(ctx.orgId, 'jira').catch(() => null) as Partial<{
    baseUrl: string; email: string; apiToken: string; projectKey: string;
  }> | null;
  const baseUrl = org?.baseUrl || process.env.JIRA_BASE_URL;
  const email = org?.email || process.env.JIRA_EMAIL;
  const token = org?.apiToken || process.env.JIRA_API_TOKEN;
  const projectKey = (config.projectKey as string | undefined) || org?.projectKey || process.env.JIRA_PROJECT_KEY;
  if (!baseUrl || !email || !token || !projectKey) {
    return { status: 'skipped', output: { connector: 'jira', reason: 'not_configured' } };
  }
  try {
    const auth = Buffer.from(`${email}:${token}`).toString('base64');
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/rest/api/3/issue`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        fields: {
          project: { key: projectKey },
          summary: config.summary || ctx.event.title || 'Experient workflow',
          description: config.description || ctx.event.body || '',
          issuetype: { name: config.issueType || 'Task' },
          // XM_VERIFICATION_REPORT.md Priority 4: Jira's REST API v3 expects
          // fields.priority.name (an object keyed by name), NOT a flat string like
          // Zendesk/ServiceNow use — and priority scheme names are configurable
          // per-instance (commonly Highest/High/Medium/Low/Lowest, but not
          // guaranteed universal). config.priority is used verbatim when provided
          // so an org can pass whatever scheme name matches their actual instance.
          priority: { name: config.priority || (ctx.event.severity === 'critical' ? 'High' : 'Medium') },
        },
      }),
      signal: AbortSignal.timeout(CONNECTOR_FETCH_TIMEOUT_MS),
    });
    const ok = res.ok;
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (!ok) log('warn', { event: 'jira_create_failed', status: res.status }, 'Jira create failed');
    return { status: ok ? 'completed' : 'failed', output: { connector: 'jira', key: body.key, status: res.status } };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log('warn', { event: 'jira_create_error', err: msg }, 'Jira create error');
    return { status: 'failed', output: { connector: 'jira' }, error: msg };
  }
}

// ── Salesforce ────────────────────────────────────────────────────────────────
export async function salesforceUpdateContact(config: Record<string, unknown>, ctx: ConnectorContext): Promise<ConnectorResult> {
  const org = await getCredentials(ctx.orgId, 'salesforce').catch(() => null) as Partial<{
    instanceUrl: string; accessToken: string;
  }> | null;
  const instanceUrl = org?.instanceUrl || process.env.SF_INSTANCE_URL;
  const token = org?.accessToken || process.env.SF_ACCESS_TOKEN;
  const contactId = render(config.contactId as string | undefined, ctx) || (ctx.event.contactId as string | undefined);
  if (!instanceUrl || !token || !contactId) {
    return { status: 'skipped', output: { connector: 'salesforce', reason: 'not_configured' } };
  }
  try {
    const fields = renderFields((config.fields as Record<string, string> | undefined) || { Description: '{{title}}' }, ctx);
    const res = await fetch(`${instanceUrl.replace(/\/$/, '')}/services/data/v59.0/sobjects/Contact/${encodeURIComponent(contactId)}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
      signal: AbortSignal.timeout(CONNECTOR_FETCH_TIMEOUT_MS),
    });
    const ok = res.ok; // Salesforce PATCH returns 204 No Content on success
    if (!ok) log('warn', { event: 'salesforce_update_failed', status: res.status }, 'Salesforce update failed');
    return { status: ok ? 'completed' : 'failed', output: { connector: 'salesforce', contactId, status: res.status } };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log('warn', { event: 'salesforce_update_error', err: msg }, 'Salesforce update error');
    return { status: 'failed', output: { connector: 'salesforce' }, error: msg };
  }
}

// ── ServiceNow ────────────────────────────────────────────────────────────────
export async function servicenowCreateIncident(config: Record<string, unknown>, ctx: ConnectorContext): Promise<ConnectorResult> {
  const org = await getCredentials(ctx.orgId, 'servicenow').catch(() => null) as Partial<{
    instanceUrl: string; user: string; password: string;
  }> | null;
  const instanceUrl = org?.instanceUrl || process.env.SERVICENOW_INSTANCE_URL;
  const user = org?.user || process.env.SERVICENOW_USER;
  const password = org?.password || process.env.SERVICENOW_PASSWORD;
  if (!instanceUrl || !user || !password) {
    return { status: 'skipped', output: { connector: 'servicenow', reason: 'not_configured' } };
  }
  try {
    const auth = Buffer.from(`${user}:${password}`).toString('base64');
    const res = await fetch(`${instanceUrl.replace(/\/$/, '')}/api/now/table/incident`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        short_description: render(config.shortDescription as string | undefined || (ctx.event.title as string | undefined) || 'Experient alert', ctx),
        description: render(config.description as string | undefined || (ctx.event.body as string | undefined) || '', ctx),
        urgency: config.urgency || (ctx.event.severity === 'critical' ? '1' : '3'),
        impact: config.impact || '2',
      }),
      signal: AbortSignal.timeout(CONNECTOR_FETCH_TIMEOUT_MS),
    });
    const ok = res.ok;
    const body = await res.json().catch(() => ({})) as { result?: { sys_id?: string } };
    if (!ok) log('warn', { event: 'servicenow_create_failed', status: res.status }, 'ServiceNow create failed');
    return { status: ok ? 'completed' : 'failed', output: { connector: 'servicenow', sysId: body?.result?.sys_id, status: res.status } };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log('warn', { event: 'servicenow_create_error', err: msg }, 'ServiceNow create error');
    return { status: 'failed', output: { connector: 'servicenow' }, error: msg };
  }
}

// ── Zendesk ───────────────────────────────────────────────────────────────────
// config.tags: string[] injected onto the ticket. config.requesterEmail: templated
// ({{var}}) email used to look up/create the requester (Zendesk resolves by email).
export async function zendeskCreateTicket(config: Record<string, unknown>, ctx: ConnectorContext): Promise<ConnectorResult> {
  const org = await getCredentials(ctx.orgId, 'zendesk').catch(() => null) as Partial<{
    subdomain: string; email: string; apiToken: string;
  }> | null;
  const subdomain = org?.subdomain || process.env.ZENDESK_SUBDOMAIN;
  const email = org?.email || process.env.ZENDESK_EMAIL;
  const token = org?.apiToken || process.env.ZENDESK_API_TOKEN;
  if (!subdomain || !email || !token) {
    return { status: 'skipped', output: { connector: 'zendesk', reason: 'not_configured' } };
  }
  try {
    const auth = Buffer.from(`${email}/token:${token}`).toString('base64');
    const tags = Array.isArray(config.tags) ? (config.tags as unknown[]).map((t) => String(t)) : undefined;
    const requesterEmail = render(config.requesterEmail as string | undefined, ctx) || undefined;
    const res = await fetch(`https://${subdomain}.zendesk.com/api/v2/tickets.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        ticket: {
          subject: render(config.subject as string | undefined || (ctx.event.title as string | undefined) || 'Experient workflow', ctx),
          comment: { body: render(config.description as string | undefined || (ctx.event.body as string | undefined) || '', ctx) },
          priority: config.priority || (ctx.event.severity === 'critical' ? 'urgent' : 'normal'),
          ...(tags ? { tags } : {}),
          ...(requesterEmail ? { requester: { email: requesterEmail } } : {}),
        },
      }),
      signal: AbortSignal.timeout(CONNECTOR_FETCH_TIMEOUT_MS),
    });
    const ok = res.ok;
    const body = await res.json().catch(() => ({})) as { ticket?: { id?: number } };
    if (!ok) log('warn', { event: 'zendesk_create_failed', status: res.status }, 'Zendesk create failed');
    return { status: ok ? 'completed' : 'failed', output: { connector: 'zendesk', ticketId: body?.ticket?.id, status: res.status } };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log('warn', { event: 'zendesk_create_error', err: msg }, 'Zendesk create error');
    return { status: 'failed', output: { connector: 'zendesk' }, error: msg };
  }
}

// Minimal {{var}} templating shared by connectors (mirrors workflowEngine.render).
export function render(tpl: string | null | undefined, ctx: ConnectorContext): string {
  if (tpl == null) return '';
  return String(tpl).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => {
    const v = key.split('.').reduce((o: unknown, k: string) => (o == null ? o : (o as Record<string, unknown>)[k]), { ...ctx.event, ...ctx.vars });
    return v == null ? '' : String(v);
  });
}

// Render every value in a flat field map.
function renderFields(fields: Record<string, string>, ctx: ConnectorContext): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) out[k] = render(v, ctx);
  return out;
}

// ── Crystal (deterministic; LLM upgrade later) ────────────────────────────────
export function crystalSummarize(ctx: ConnectorContext): ConnectorResult {
  const e = ctx.event || {};
  const bits: string[] = [];
  if (e.title) bits.push(String(e.title));
  if (e.nps != null) bits.push(`NPS ${e.nps}`);
  if (e.sentiment) bits.push(`${e.sentiment} sentiment`);
  const summary = bits.length ? `Crystal summary: ${bits.join(' · ')}.` : 'Crystal summary: event received.';
  return { status: 'completed', output: { summary }, vars: { crystalSummary: summary } };
}

export function crystalClassify(ctx: ConnectorContext): ConnectorResult {
  const e = ctx.event || {};
  let severity = 'low';
  if (e.severity) severity = String(e.severity);
  else if (e.nps != null) severity = Number(e.nps) <= 3 ? 'critical' : Number(e.nps) <= 6 ? 'high' : 'low';
  return { status: 'completed', output: { severity }, vars: { crystalSeverity: severity } };
}
