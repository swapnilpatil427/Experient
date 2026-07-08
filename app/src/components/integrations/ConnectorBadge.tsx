import type { WorkflowConnectorName } from '../../types';

// New, separate badge map from SettingsConnectionsPage's PROVIDER_META — per
// Rohan's spec §1, this page's Salesforce integration (workflow-action
// credentials) is unrelated to the CRM-sync page's Salesforce integration
// (contact sync), even though the badge may render identically. Coupling their
// color constants would be an accidental dependency between unrelated features.
export const CONNECTOR_META: Record<WorkflowConnectorName, { label: string; description: string; initials: string; bg: string; text: string }> = {
  jira:       { label: 'Jira',       description: 'Create and update issues from workflow actions',      initials: 'JR', bg: '#0052cc', text: '#fff' },
  salesforce: { label: 'Salesforce', description: 'Update contact records when a workflow runs',          initials: 'SF', bg: '#00a1e0', text: '#fff' },
  servicenow: { label: 'ServiceNow', description: 'Create incidents from workflow actions',                initials: 'SN', bg: '#04a76b', text: '#fff' },
  zendesk:    { label: 'Zendesk',    description: 'Create support tickets from workflow actions',          initials: 'ZD', bg: '#03363d', text: '#fff' },
  slack:      { label: 'Slack',      description: 'Post automation notifications to a channel',            initials: 'SL', bg: '#611f69', text: '#fff' },
  webhook:    { label: 'Webhook',    description: 'Sign outbound webhook payloads from workflow actions',  initials: 'WH', bg: '#64748b', text: '#fff' },
};

export function ConnectorBadge({ connector }: { connector: WorkflowConnectorName }) {
  const meta = CONNECTOR_META[connector];
  return (
    <div
      className="w-9 h-9 rounded-xl flex items-center justify-center text-xs font-black shrink-0"
      style={{ background: meta.bg, color: meta.text }}
    >
      {meta.initials}
    </div>
  );
}
