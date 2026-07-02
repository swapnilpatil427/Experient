import type { WorkflowConnectorName } from '../../types';

// Connectors rendered as cards in the "Workflow Actions" category section.
// `webhook` is excluded per Rohan's spec §1 (it's an HMAC-signing secret with
// no fixed endpoint — a per-workflow-action config, not an org credential with
// a settings-page need) and per Nina's backend review §3 (POST .../webhook/test
// returns 400, it has no test).
export const CATEGORY_CONNECTORS: WorkflowConnectorName[] = ['jira', 'salesforce', 'servicenow', 'zendesk', 'slack'];

export type FieldType = 'text' | 'email' | 'url' | 'password';

export interface ConnectorFieldSpec {
  key: string;
  labelKey: string;
  type: FieldType;
  placeholder?: string;
  secret?: boolean;
  helpTextKey?: string;
  // uppercase-on-blur (Jira projectKey)
  uppercaseOnBlur?: boolean;
}

// Exact field lists + vault keys per David's INTEGRATIONS_CONNECTOR_SPEC.md —
// do not rename these keys, connectors.ts destructures them with no aliasing.
export const CONNECTOR_FIELDS: Record<WorkflowConnectorName, ConnectorFieldSpec[]> = {
  jira: [
    { key: 'baseUrl', labelKey: 'integrationsSettings.fields.baseUrl', type: 'url', placeholder: 'https://yourcompany.atlassian.net' },
    { key: 'email', labelKey: 'integrationsSettings.fields.jiraEmail', type: 'email', placeholder: 'you@yourcompany.com' },
    { key: 'apiToken', labelKey: 'integrationsSettings.fields.apiToken', type: 'password', secret: true, helpTextKey: 'integrationsSettings.helpText.jiraApiToken' },
    { key: 'projectKey', labelKey: 'integrationsSettings.fields.projectKey', type: 'text', placeholder: 'ENG', uppercaseOnBlur: true },
  ],
  salesforce: [
    { key: 'instanceUrl', labelKey: 'integrationsSettings.fields.instanceUrl', type: 'url', placeholder: 'https://yourorg.my.salesforce.com' },
    { key: 'accessToken', labelKey: 'integrationsSettings.fields.accessToken', type: 'password', secret: true, helpTextKey: 'integrationsSettings.helpText.salesforceTokenExpiry' },
  ],
  servicenow: [
    { key: 'instanceUrl', labelKey: 'integrationsSettings.fields.instanceUrl', type: 'url', placeholder: 'https://yourinstance.service-now.com' },
    { key: 'user', labelKey: 'integrationsSettings.fields.user', type: 'text' },
    { key: 'password', labelKey: 'integrationsSettings.fields.password', type: 'password', secret: true },
  ],
  zendesk: [
    { key: 'subdomain', labelKey: 'integrationsSettings.fields.subdomain', type: 'text', placeholder: 'yourcompany' },
    { key: 'email', labelKey: 'integrationsSettings.fields.zendeskEmail', type: 'email', placeholder: 'you@yourcompany.com' },
    { key: 'apiToken', labelKey: 'integrationsSettings.fields.apiToken', type: 'password', secret: true, helpTextKey: 'integrationsSettings.helpText.zendeskApiToken' },
  ],
  slack: [
    { key: 'webhook_url', labelKey: 'integrationsSettings.fields.webhookUrl', type: 'url', placeholder: 'https://hooks.slack.com/services/...' },
  ],
  webhook: [],
};

/** Per-field client-side validation. Returns an i18n key for the error, or null if valid. */
export function validateField(connector: WorkflowConnectorName, key: string, value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return 'integrationsSettings.validation.required';

  if (key === 'baseUrl' || key === 'instanceUrl') {
    if (!isValidUrl(trimmed)) return 'integrationsSettings.validation.invalidUrl';
  }
  if (key === 'email') {
    if (!isValidEmail(trimmed)) return 'integrationsSettings.validation.invalidEmail';
  }
  if (key === 'projectKey') {
    if (!/^[A-Z][A-Z0-9]{1,9}$/.test(trimmed.toUpperCase())) return 'integrationsSettings.validation.invalidProjectKey';
  }
  if (key === 'subdomain') {
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(trimmed) || trimmed.includes('.') || trimmed.includes('/')) {
      return 'integrationsSettings.validation.invalidSubdomain';
    }
  }
  if (connector === 'slack' && key === 'webhook_url') {
    if (!trimmed.startsWith('https://hooks.slack.com/services/')) return 'integrationsSettings.validation.invalidSlackWebhook';
  }
  return null;
}

export function isValidUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/** Strip a trailing slash — mirrors connectors.ts's server-side `.replace(/\/$/, '')`. */
export function stripTrailingSlash(value: string): string {
  return value.replace(/\/$/, '');
}

/** All fields for a connector must be non-empty and pass validation before Save/Test enable. */
export function isFormValid(connector: WorkflowConnectorName, values: Record<string, string>): boolean {
  const fields = CONNECTOR_FIELDS[connector];
  return fields.every((f) => !validateField(connector, f.key, values[f.key] ?? ''));
}
