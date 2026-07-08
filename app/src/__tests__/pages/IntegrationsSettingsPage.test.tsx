import { render, screen, waitFor, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// jsdom in this project's vitest config doesn't wire up a real localStorage
// backing store (no existing test in this codebase relies on it) — the
// dismiss-banner persistence test needs one, so a minimal in-memory polyfill
// is installed here rather than pulling in a new dependency.
class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length() { return this.store.size; }
  clear() { this.store.clear(); }
  getItem(key: string) { return this.store.has(key) ? this.store.get(key)! : null; }
  key(index: number) { return Array.from(this.store.keys())[index] ?? null; }
  removeItem(key: string) { this.store.delete(key); }
  setItem(key: string, value: string) { this.store.set(key, String(value)); }
}
Object.defineProperty(window, 'localStorage', { value: new MemoryStorage(), configurable: true });

vi.mock('../../hooks/useApi', () => ({ useApi: vi.fn(), default: vi.fn() }));
vi.mock('../../lib/permissions', () => ({ usePermissions: vi.fn() }));
vi.mock('../../lib/i18n', () => ({
  useTranslation: () => ({
    t: (k: string, vars?: Record<string, unknown>) => {
      // Resolve the couple of nested-object lookups the card grid uses directly
      // (connector label/description), mirroring the real i18n layer's ability
      // to return non-string values as-is.
      const CONNECTORS: Record<string, { label: string; description: string }> = {
        jira: { label: 'Jira', description: 'Create and update issues from workflow actions' },
        salesforce: { label: 'Salesforce', description: 'Update contact records when a workflow runs' },
        servicenow: { label: 'ServiceNow', description: 'Create incidents from workflow actions' },
        zendesk: { label: 'Zendesk', description: 'Create support tickets from workflow actions' },
        slack: { label: 'Slack', description: 'Post automation notifications to a channel' },
      };
      const m = k.match(/^integrationsSettings\.connectors\.(\w+)$/);
      if (m) return CONNECTORS[m[1]];
      if (vars) return k.replace(/\{(\w+)\}/g, (_, key) => String(vars[key] ?? ''));
      return k;
    },
  }),
}));
vi.mock('../../contexts/pageTitle', () => ({ useSetPageTitle: vi.fn() }));
vi.mock('framer-motion', () => ({
  motion: new Proxy({}, { get: () => (props: Record<string, unknown>) => {
    const { children, ...rest } = props as { children?: React.ReactNode };
    return <div {...(rest as Record<string, unknown>)}>{children}</div>;
  } }),
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { useApi } from '../../hooks/useApi';
import { usePermissions } from '../../lib/permissions';
import { IntegrationsSettingsPage } from '../../pages/settings/IntegrationsSettingsPage';
import type { WorkflowConnectorEntry } from '../../types';

function makeApi(overrides: Record<string, unknown> = {}) {
  return {
    listWorkflowCredentials: vi.fn().mockResolvedValue([]),
    setWorkflowCredentials: vi.fn().mockResolvedValue({ connector: 'jira', configured: true }),
    deleteWorkflowCredentials: vi.fn().mockResolvedValue(undefined),
    testWorkflowCredentials: vi.fn().mockResolvedValue({ success: true }),
    ...overrides,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  vi.mocked(usePermissions).mockReturnValue({ isAdmin: true, isAnalyst: true, isViewer: true, role: 'org:admin', can: () => true });
  vi.mocked(useApi).mockReturnValue(makeApi() as unknown as ReturnType<typeof useApi>);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('IntegrationsSettingsPage — access gate', () => {
  it('shows an access-denied message for non-admins', async () => {
    vi.mocked(usePermissions).mockReturnValue({ isAdmin: false, isAnalyst: false, isViewer: true, role: 'org:viewer', can: () => false });
    render(<MemoryRouter><IntegrationsSettingsPage /></MemoryRouter>);
    expect(screen.getByText('integrationsSettings.accessDenied')).toBeInTheDocument();
  });

  it('renders the card grid for admins', async () => {
    render(<MemoryRouter><IntegrationsSettingsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('integration-card-jira')).toBeInTheDocument());
  });
});

describe('IntegrationsSettingsPage — card status rendering', () => {
  it('renders all 5 connector cards (jira/salesforce/servicenow/zendesk/slack), excluding webhook', async () => {
    render(<MemoryRouter><IntegrationsSettingsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('integration-card-jira')).toBeInTheDocument());
    expect(screen.getByTestId('integration-card-salesforce')).toBeInTheDocument();
    expect(screen.getByTestId('integration-card-servicenow')).toBeInTheDocument();
    expect(screen.getByTestId('integration-card-zendesk')).toBeInTheDocument();
    expect(screen.getByTestId('integration-card-slack')).toBeInTheDocument();
    expect(screen.queryByTestId('integration-card-webhook')).not.toBeInTheDocument();
  });

  it('shows "Not connected" and a Connect button when status is none', async () => {
    render(<MemoryRouter><IntegrationsSettingsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('integration-card-jira')).toBeInTheDocument());
    const card = screen.getByTestId('integration-card-jira');
    expect(card).toHaveTextContent('integrationsSettings.status.notConnected');
    expect(card).toHaveTextContent('integrationsSettings.actions.connect');
  });

  it('shows "Connected" and an Edit button when status is org', async () => {
    const entries: WorkflowConnectorEntry[] = [{ connector: 'jira', status: 'org', updatedAt: '2026-06-28T00:00:00Z' }];
    vi.mocked(useApi).mockReturnValue(makeApi({ listWorkflowCredentials: vi.fn().mockResolvedValue(entries) }) as unknown as ReturnType<typeof useApi>);
    render(<MemoryRouter><IntegrationsSettingsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('integration-card-jira')).toBeInTheDocument());
    const card = screen.getByTestId('integration-card-jira');
    expect(card).toHaveTextContent('integrationsSettings.status.connected');
    expect(card).toHaveTextContent('integrationsSettings.actions.edit');
  });

  it('shows "Using shared default" copy when status is shared', async () => {
    const entries: WorkflowConnectorEntry[] = [{ connector: 'salesforce', status: 'shared' }];
    vi.mocked(useApi).mockReturnValue(makeApi({ listWorkflowCredentials: vi.fn().mockResolvedValue(entries) }) as unknown as ReturnType<typeof useApi>);
    render(<MemoryRouter><IntegrationsSettingsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('integration-card-salesforce')).toBeInTheDocument());
    const card = screen.getByTestId('integration-card-salesforce');
    expect(card).toHaveTextContent('integrationsSettings.status.connected');
    expect(card).toHaveTextContent('integrationsSettings.status.sharedDefault');
    // A shared-default connector has no org-specific vault row to edit yet — the
    // primary action is "Connect" (create an org-specific override), not "Edit".
    expect(card).toHaveTextContent('integrationsSettings.actions.connect');
  });

  it('shows a "Connection error" state (client-side signal) after a failed Test Connection in the modal, and a Reconnect action', async () => {
    const entries: WorkflowConnectorEntry[] = [{ connector: 'jira', status: 'org', updatedAt: '2026-06-28T00:00:00Z' }];
    vi.mocked(useApi).mockReturnValue(makeApi({
      listWorkflowCredentials: vi.fn().mockResolvedValue(entries),
      testWorkflowCredentials: vi.fn().mockResolvedValue({ success: false, message: 'Invalid credentials' }),
    }) as unknown as ReturnType<typeof useApi>);
    const user = userEvent.setup();
    render(<MemoryRouter><IntegrationsSettingsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('integration-card-jira')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /integrationsSettings\.actions\.edit/i }));
    await waitFor(() => expect(screen.getByTestId('test-connection-button')).toBeInTheDocument());

    // Non-secret fields start blank on Edit too (the vault never returns
    // decrypted OR non-secret values) — they must be filled before Test
    // Connection enables, even though the secret (apiToken) stays locked.
    await user.type(screen.getByTestId('field-baseUrl'), 'https://acme.atlassian.net');
    await user.type(screen.getByTestId('field-email'), 'me@acme.com');
    await user.type(screen.getByTestId('field-projectKey'), 'ENG');
    await waitFor(() => expect(screen.getByTestId('test-connection-button')).not.toBeDisabled());

    await user.click(screen.getByTestId('test-connection-button'));
    await waitFor(() => expect(screen.getByTestId('test-failure-banner')).toBeInTheDocument());
    await user.click(screen.getByText('integrationsSettings.actions.cancel'));

    await waitFor(() => {
      const card = screen.getByTestId('integration-card-jira');
      expect(card).toHaveTextContent('integrationsSettings.status.connectionError');
      expect(card).toHaveTextContent('integrationsSettings.actions.reconnect');
    });
  });
});

describe('IntegrationsSettingsPage — empty-state banner', () => {
  it('shows the empty-state banner when zero connectors are connected', async () => {
    render(<MemoryRouter><IntegrationsSettingsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('empty-state-banner')).toBeInTheDocument());
  });

  it('does not show the empty-state banner when at least one connector is connected', async () => {
    const entries: WorkflowConnectorEntry[] = [{ connector: 'jira', status: 'org' }];
    vi.mocked(useApi).mockReturnValue(makeApi({ listWorkflowCredentials: vi.fn().mockResolvedValue(entries) }) as unknown as ReturnType<typeof useApi>);
    render(<MemoryRouter><IntegrationsSettingsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('integration-card-jira')).toBeInTheDocument());
    expect(screen.queryByTestId('empty-state-banner')).not.toBeInTheDocument();
  });

  it('dismissing the banner persists across a reload (localStorage)', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<MemoryRouter><IntegrationsSettingsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('empty-state-banner')).toBeInTheDocument());
    await user.click(screen.getByLabelText('integrationsSettings.actions.cancel'));
    await waitFor(() => expect(screen.queryByTestId('empty-state-banner')).not.toBeInTheDocument());
    unmount();

    render(<MemoryRouter><IntegrationsSettingsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('integration-card-jira')).toBeInTheDocument());
    expect(screen.queryByTestId('empty-state-banner')).not.toBeInTheDocument();
  });
});

describe('IntegrationsSettingsPage — vault-unconfigured banner', () => {
  it('shows the vault-unconfigured banner and reloads after a 503 on save', async () => {
    vi.mocked(useApi).mockReturnValue(makeApi({
      setWorkflowCredentials: vi.fn().mockRejectedValue(new Error('Credentials vault is not configured on this deployment')),
    }) as unknown as ReturnType<typeof useApi>);
    const user = userEvent.setup();
    render(<MemoryRouter><IntegrationsSettingsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('integration-card-jira')).toBeInTheDocument());

    await user.click(within(screen.getByTestId('integration-card-jira')).getByRole('button'));
    await user.type(screen.getByTestId('field-baseUrl'), 'https://acme.atlassian.net');
    await user.type(screen.getByTestId('field-email'), 'me@acme.com');
    await user.type(screen.getByTestId('field-apiToken'), 'tok123');
    await user.type(screen.getByTestId('field-projectKey'), 'ENG');
    await waitFor(() => expect(screen.getByTestId('save-button')).not.toBeDisabled());
    await user.click(screen.getByTestId('save-button'));

    await waitFor(() => expect(screen.getByTestId('vault-unconfigured-banner')).toBeInTheDocument());
  });
});

describe('IntegrationsSettingsPage — save + reload flow', () => {
  it('reloads the connector list after a successful save', async () => {
    const listWorkflowCredentials = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ connector: 'jira', status: 'org', updatedAt: '2026-06-30T00:00:00Z' }]);
    vi.mocked(useApi).mockReturnValue(makeApi({ listWorkflowCredentials }) as unknown as ReturnType<typeof useApi>);
    const user = userEvent.setup();
    render(<MemoryRouter><IntegrationsSettingsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('integration-card-jira')).toBeInTheDocument());

    await user.click(within(screen.getByTestId('integration-card-jira')).getByRole('button'));
    await user.type(screen.getByTestId('field-baseUrl'), 'https://acme.atlassian.net');
    await user.type(screen.getByTestId('field-email'), 'me@acme.com');
    await user.type(screen.getByTestId('field-apiToken'), 'tok123');
    await user.type(screen.getByTestId('field-projectKey'), 'ENG');
    await waitFor(() => expect(screen.getByTestId('save-button')).not.toBeDisabled());
    await user.click(screen.getByTestId('save-button'));

    await waitFor(() => expect(listWorkflowCredentials).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId('integration-card-jira')).toHaveTextContent('integrationsSettings.status.connected'));
  });
});
