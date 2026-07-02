import { describe, it, expect } from 'vitest';
import { connectorForAction, credentialStatusForAction } from '../../lib/workflowConnectorStatus';
import type { WorkflowConnectorEntry } from '../../types';

// Kenji finding 1 / Maya DEEP_AUDIT_PM_FINDINGS.md 6c / Rohan
// DEEP_AUDIT_UX_FINDINGS.md I-1 — the seam between GET /api/workflow-credentials'
// real per-org connector status and the builder's per-action readiness dot.
describe('connectorForAction', () => {
  it('maps connector-backed actions to their connector name', () => {
    expect(connectorForAction('jira.create_issue')).toBe('jira');
    expect(connectorForAction('salesforce.update_contact')).toBe('salesforce');
    expect(connectorForAction('servicenow.create_incident')).toBe('servicenow');
    expect(connectorForAction('zendesk.create_ticket')).toBe('zendesk');
  });

  it('returns null for actions with no connector-credential dependency', () => {
    expect(connectorForAction('notify.slack')).toBeNull();
    expect(connectorForAction('notify.email')).toBeNull();
    expect(connectorForAction('flow.stop')).toBeNull();
  });
});

describe('credentialStatusForAction', () => {
  const entries: WorkflowConnectorEntry[] = [
    { connector: 'jira', status: 'org' },
    { connector: 'salesforce', status: 'none' },
  ];

  it('returns "connected" when the org has an org-level credential', () => {
    expect(credentialStatusForAction('jira.create_issue', entries)).toBe('connected');
  });

  it('returns "connected" for a shared credential too', () => {
    const withShared: WorkflowConnectorEntry[] = [{ connector: 'zendesk', status: 'shared' }];
    expect(credentialStatusForAction('zendesk.create_ticket', withShared)).toBe('connected');
  });

  it('returns "disconnected" when the connector has no configured credential', () => {
    expect(credentialStatusForAction('salesforce.update_contact', entries)).toBe('disconnected');
  });

  it('returns "disconnected" when the connector is entirely absent from the response', () => {
    expect(credentialStatusForAction('servicenow.create_incident', entries)).toBe('disconnected');
  });

  it('returns undefined for a non-connector-backed action (nothing to override)', () => {
    expect(credentialStatusForAction('notify.slack', entries)).toBeUndefined();
  });
});
