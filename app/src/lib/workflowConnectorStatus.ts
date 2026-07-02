// Maps a connector-backed workflow action to its real per-org credential
// status (Kenji finding 1 / Maya DEEP_AUDIT_PM_FINDINGS.md 6c / Rohan
// DEEP_AUDIT_UX_FINDINGS.md I-1). Before this fix, the builder's readiness dot
// for jira.create_issue/salesforce.*/servicenow.*/zendesk.* was a static
// registry constant (`live: 'env'`) — identical for every org regardless of
// whether that org has actually connected the integration on the Integrations
// Settings page (GET /api/workflow-credentials, Wave 8). This module is the
// single seam between that real per-org data and the builder's tile/config UI.
import type { WorkflowConnectorEntry, WorkflowConnectorName } from '../types';

// Only these 4 connectors have a "will this action actually fire" credential
// dependency the vault tracks — 'slack'/'webhook' are excluded here the same
// way IntegrationsSettingsPage.tsx's CATEGORY_CONNECTORS excludes 'webhook'
// (a per-workflow-action secret, not an org-level credential), and Slack
// actions use `notify.slack`'s channel config, not the vault's connector
// status, as their readiness signal.
const ACTION_PREFIX_TO_CONNECTOR: Record<string, WorkflowConnectorName> = {
  jira: 'jira',
  salesforce: 'salesforce',
  servicenow: 'servicenow',
  zendesk: 'zendesk',
};

/** e.g. 'jira.create_issue' -> 'jira'; 'notify.slack' -> null (not connector-backed). */
export function connectorForAction(action: string): WorkflowConnectorName | null {
  const [prefix] = action.split('.');
  return ACTION_PREFIX_TO_CONNECTOR[prefix] ?? null;
}

export type CredentialStatus = 'connected' | 'disconnected';

/**
 * Resolve the real per-org credential status for a given action, given the
 * `GET /api/workflow-credentials` response. Returns `undefined` for actions
 * that aren't connector-backed at all (nothing to override) — callers should
 * fall back to the registry's static `live` tier in that case.
 */
export function credentialStatusForAction(
  action: string,
  entries: WorkflowConnectorEntry[],
): CredentialStatus | undefined {
  const connector = connectorForAction(action);
  if (!connector) return undefined;
  const entry = entries.find((e) => e.connector === connector);
  const status = entry?.status ?? 'none';
  return status === 'org' || status === 'shared' ? 'connected' : 'disconnected';
}
