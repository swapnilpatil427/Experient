// Per-org workflow connector credentials vault.
//
// Today every connector (Jira/Salesforce/ServiceNow/Zendesk) reads SHARED
// process.env vars — one account for the whole deployment. This module lets each
// org configure its OWN credentials, stored encrypted (AES-256-GCM) in the
// `workflow_connector_credentials` table, keyed by WORKFLOW_CREDENTIALS_KEY.
//
// Degrades gracefully like the rest of this codebase's optional infra: if
// WORKFLOW_CREDENTIALS_KEY is absent/malformed in dev, getCredentials/setCredentials
// no-op (return null / throw a clear, caught error) so orgs simply fall back to the
// shared env vars. In production a missing/wrong-length key fails loud at startup
// (see validateWorkflowCredentialsKey, wired into validateEnv.ts-style checks).
import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import { query } from './db';

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

function log(level: LogLevel, obj: Record<string, unknown>, msg: string): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    (require('./logger') as Record<string, (obj: unknown, msg: string) => void>)[level](obj, msg);
  } catch { console.log(`[workflowCredentials] ${msg}`, obj); }
}

export const CONNECTORS = ['jira', 'salesforce', 'servicenow', 'zendesk', 'slack', 'webhook'] as const;
export type ConnectorName = (typeof CONNECTORS)[number];

export function isConnectorName(v: string): v is ConnectorName {
  return (CONNECTORS as readonly string[]).includes(v);
}

const ALGO = 'aes-256-gcm';
const IV_LENGTH = 12;  // recommended GCM nonce size

/**
 * Resolve + validate the encryption key. Returns null when unset (dev-friendly
 * degrade); throws when set but malformed (fail loud rather than silently using
 * a bad key that would make previously-encrypted rows undecryptable).
 */
function resolveKey(): Buffer | null {
  const raw = process.env.WORKFLOW_CREDENTIALS_KEY;
  if (!raw) return null;
  let buf: Buffer;
  // Accept hex (64 chars) or base64 (44 chars incl. padding) — both decode to 32 bytes.
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    buf = Buffer.from(raw, 'hex');
  } else {
    buf = Buffer.from(raw, 'base64');
  }
  if (buf.length !== 32) {
    throw new Error('WORKFLOW_CREDENTIALS_KEY must decode to exactly 32 bytes (hex or base64)');
  }
  return buf;
}

/**
 * Startup validation hook (mirrors validateEnv.ts's fail-loud-in-prod / warn-in-dev
 * pattern). Call from validateStartupConfig() or equivalent.
 */
export function validateWorkflowCredentialsKey(isProd: boolean): { errors: string[]; warns: string[] } {
  const errors: string[] = [];
  const warns: string[] = [];
  try {
    const key = resolveKey();
    if (!key) {
      if (isProd) errors.push('WORKFLOW_CREDENTIALS_KEY is required in production (org credential vault would be unusable)');
      else warns.push('WORKFLOW_CREDENTIALS_KEY not set — per-org workflow credentials vault disabled; connectors fall back to shared env vars');
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`WORKFLOW_CREDENTIALS_KEY is malformed: ${msg}`);
  }
  return { errors, warns };
}

export interface EncryptedBlob {
  iv: string;      // hex
  tag: string;     // hex (GCM auth tag)
  ciphertext: string; // hex
}

/** Encrypt a JSON-serializable credential payload. Exported for isolated unit testing. */
export function encryptCredentials(data: Record<string, unknown>, key: Buffer): EncryptedBlob {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, key, iv);
  const plaintext = Buffer.from(JSON.stringify(data), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: iv.toString('hex'), tag: tag.toString('hex'), ciphertext: ciphertext.toString('hex') };
}

/** Decrypt a blob produced by encryptCredentials. Exported for isolated unit testing. */
export function decryptCredentials(blob: EncryptedBlob, key: Buffer): Record<string, unknown> {
  const decipher = createDecipheriv(ALGO, key, Buffer.from(blob.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(blob.tag, 'hex'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(blob.ciphertext, 'hex')),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString('utf8')) as Record<string, unknown>;
}

interface CredentialRow {
  org_id: string;
  connector: string;
  encrypted_blob: EncryptedBlob;
  created_at: string;
  updated_at: string;
}

/**
 * Fetch + decrypt an org's credentials for a connector. Returns null when:
 *  - the vault key is not configured (dev degrade), or
 *  - no row exists for (org, connector), or
 *  - decryption fails (e.g. key rotated) — logged, never thrown to the caller.
 * Callers (connectors.ts) treat null as "fall back to shared env vars".
 */
export async function getCredentials(orgId: string, connector: ConnectorName): Promise<Record<string, unknown> | null> {
  let key: Buffer | null;
  try {
    key = resolveKey();
  } catch (err: unknown) {
    log('error', { err: err instanceof Error ? err.message : String(err) }, 'workflow credentials key malformed');
    return null;
  }
  if (!key) return null;

  try {
    const { rows } = await query<CredentialRow>(
      `SELECT org_id, connector, encrypted_blob, created_at, updated_at
         FROM workflow_connector_credentials WHERE org_id = $1 AND connector = $2`,
      [orgId, connector]
    );
    const row = rows[0];
    if (!row) return null;
    return decryptCredentials(row.encrypted_blob, key);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log('warn', { event: 'workflow_credentials_decrypt_failed', orgId, connector, err: msg }, 'Failed to load/decrypt org credentials');
    return null;
  }
}

/**
 * Encrypt + upsert an org's credentials for a connector. Throws if the vault key
 * is unset/malformed.
 *
 * MERGES `data` onto the existing stored row rather than replacing it wholesale.
 * This matters because GET never returns decrypted secrets (by design — secrets
 * are write-only), so the natural settings-page edit pattern is "only send the
 * field(s) the user actually changed" (e.g. rotating just `apiToken` on an
 * already-configured Jira connector that also has `baseUrl`/`email`/`projectKey`
 * saved). A naive overwrite would silently null out every field not present in
 * that PUT body — a real data-loss bug the moment an edit-existing-connector UI
 * exists, which is exactly what's being built now. See
 * docs/automation-hub/INTEGRATIONS_BACKEND_REVIEW.md.
 *
 * If the caller genuinely wants to clear a field, they should pass it as an
 * explicit `null`/empty value — merge only ever ADDS/OVERWRITES keys present in
 * `data`, it never drops a key that isn't mentioned.
 */
export async function setCredentials(orgId: string, connector: ConnectorName, data: Record<string, unknown>): Promise<void> {
  const key = resolveKey();
  if (!key) throw new Error('WORKFLOW_CREDENTIALS_KEY is not configured — cannot store org credentials');

  const existing = await getCredentials(orgId, connector).catch(() => null);
  const merged = { ...(existing ?? {}), ...data };

  const blob = encryptCredentials(merged, key);
  await query(
    `INSERT INTO workflow_connector_credentials (org_id, connector, encrypted_blob, created_at, updated_at)
     VALUES ($1, $2, $3::jsonb, NOW(), NOW())
     ON CONFLICT (org_id, connector)
     DO UPDATE SET encrypted_blob = EXCLUDED.encrypted_blob, updated_at = NOW()`,
    [orgId, connector, JSON.stringify(blob)]
  );
}

/** Delete an org's credentials for a connector (hard delete — this table holds secrets, not history). */
export async function deleteCredentials(orgId: string, connector: ConnectorName): Promise<boolean> {
  const { rowCount } = await query(
    `DELETE FROM workflow_connector_credentials WHERE org_id = $1 AND connector = $2`,
    [orgId, connector]
  );
  return (rowCount ?? 0) > 0;
}

/** List which connectors an org has configured (non-secret metadata only — never decrypts). */
export async function listConfiguredConnectors(orgId: string): Promise<Array<{ connector: string; createdAt: string; updatedAt: string }>> {
  const { rows } = await query<{ connector: string; created_at: string; updated_at: string }>(
    `SELECT connector, created_at, updated_at FROM workflow_connector_credentials WHERE org_id = $1 ORDER BY connector`,
    [orgId]
  );
  return rows.map((r) => ({ connector: r.connector, createdAt: r.created_at, updatedAt: r.updated_at }));
}

// Required env vars per connector for the shared-deployment fallback, mirrored
// from connectors.ts's `org?.field || process.env.FIELD` chains (jiraCreateIssue,
// salesforceUpdateContact, servicenowCreateIncident, zendeskCreateTicket). Kept
// here (not re-derived from connectors.ts) because this is a simple presence
// check, not a credential read — connectors.ts intentionally has no single
// "list my env var names" export, and adding one there for a settings-page
// concern would be the wrong layer. `slack` and `webhook` have no env-var-shared
// fallback concept (Slack lives in notification_channels; webhook's vault entry
// is a per-org HMAC secret, not something a deployment shares by default).
const CONNECTOR_ENV_FIELDS: Partial<Record<ConnectorName, string[]>> = {
  jira: ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN', 'JIRA_PROJECT_KEY'],
  salesforce: ['SF_INSTANCE_URL', 'SF_ACCESS_TOKEN'],
  servicenow: ['SERVICENOW_INSTANCE_URL', 'SERVICENOW_USER', 'SERVICENOW_PASSWORD'],
  zendesk: ['ZENDESK_SUBDOMAIN', 'ZENDESK_EMAIL', 'ZENDESK_API_TOKEN'],
};

function hasSharedEnvFallback(connector: ConnectorName): boolean {
  const fields = CONNECTOR_ENV_FIELDS[connector];
  if (!fields) return false;
  return fields.every((name) => !!process.env[name]);
}

export type ConnectorStatus = 'org' | 'shared' | 'none';

export interface ConnectorStatusEntry {
  connector: string;
  status: ConnectorStatus;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Settings-page-ready view: every entry in CONNECTORS (including slack, backed
 * by notification_channels rather than this vault), each resolved to exactly one
 * of three states so the UI can render "Connected (org)" / "Using shared
 * default" / "Not connected" without a second round-trip or client-side merge.
 * See docs/automation-hub/INTEGRATIONS_BACKEND_REVIEW.md §1/§2.
 */
export async function getConnectorStatuses(orgId: string): Promise<ConnectorStatusEntry[]> {
  const vaultRows = await listConfiguredConnectors(orgId);
  const vaultByConnector = new Map(vaultRows.map((r) => [r.connector, r]));

  const { rows: slackRows } = await query<{ created_at: string; updated_at: string }>(
    `SELECT created_at, updated_at FROM notification_channels
      WHERE org_id = $1 AND channel_type = 'slack' AND is_active = TRUE AND deleted_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    [orgId]
  ).catch(() => ({ rows: [] as Array<{ created_at: string; updated_at: string }> }));
  const slackRow = slackRows[0];

  return CONNECTORS.map((connector): ConnectorStatusEntry => {
    if (connector === 'slack') {
      return slackRow
        ? { connector, status: 'org', createdAt: slackRow.created_at, updatedAt: slackRow.updated_at }
        : { connector, status: 'none' };
    }
    const vaultRow = vaultByConnector.get(connector);
    if (vaultRow) return { connector, status: 'org', createdAt: vaultRow.createdAt, updatedAt: vaultRow.updatedAt };
    return { connector, status: hasSharedEnvFallback(connector) ? 'shared' : 'none' };
  });
}
