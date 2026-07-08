import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../hooks/useApi', () => ({ useApi: vi.fn(), default: vi.fn() }));
vi.mock('../../../lib/i18n', () => ({
  useTranslation: () => ({
    t: (k: string, vars?: Record<string, unknown>) => {
      if (vars) return k.replace(/\{(\w+)\}/g, (_, key) => String(vars[key] ?? '')) ;
      return k;
    },
  }),
}));

import { useApi } from '../../../hooks/useApi';
import { ConnectorModal } from '../../../components/integrations/ConnectorModal';
import { ConnectorTestError } from '../../../lib/api';
import type { WorkflowConnectorEntry } from '../../../types';

function makeApi(overrides: Record<string, unknown> = {}) {
  return {
    testWorkflowCredentials: vi.fn().mockResolvedValue({ success: true, message: 'ok' }),
    setWorkflowCredentials: vi.fn().mockResolvedValue({ connector: 'jira', configured: true }),
    deleteWorkflowCredentials: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    connector: 'jira' as const,
    entry: undefined as WorkflowConnectorEntry | undefined,
    open: true,
    onClose: vi.fn(),
    onSaved: vi.fn(),
    onVaultUnconfigured: vi.fn(),
    onTestOutcome: vi.fn(),
    onDisconnected: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(useApi).mockReturnValue(makeApi() as unknown as ReturnType<typeof useApi>);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });

describe('ConnectorModal — field validation (Connect flow)', () => {
  it('renders all 4 required Jira fields blank on a fresh Connect', () => {
    render(<ConnectorModal {...baseProps()} />);
    expect(screen.getByTestId('field-baseUrl')).toHaveValue('');
    expect(screen.getByTestId('field-email')).toHaveValue('');
    expect(screen.getByTestId('field-apiToken')).toHaveValue('');
    expect(screen.getByTestId('field-projectKey')).toHaveValue('');
  });

  it('Save is disabled until all required fields are filled and valid', async () => {
    const user = userEvent.setup();
    render(<ConnectorModal {...baseProps()} />);
    expect(screen.getByTestId('save-button')).toBeDisabled();

    await user.type(screen.getByTestId('field-baseUrl'), 'https://acme.atlassian.net');
    await user.type(screen.getByTestId('field-email'), 'me@acme.com');
    await user.type(screen.getByTestId('field-apiToken'), 'tok123');
    await user.type(screen.getByTestId('field-projectKey'), 'ENG');

    await waitFor(() => expect(screen.getByTestId('save-button')).not.toBeDisabled());
  });

  it('shows an inline error for an invalid email on blur', async () => {
    const user = userEvent.setup();
    render(<ConnectorModal {...baseProps()} />);
    const emailInput = screen.getByTestId('field-email');
    await user.type(emailInput, 'not-an-email');
    await user.tab();
    await waitFor(() => expect(screen.getByText('integrationsSettings.validation.invalidEmail')).toBeInTheDocument());
  });

  it('shows an inline error for an invalid base URL on blur', async () => {
    const user = userEvent.setup();
    render(<ConnectorModal {...baseProps()} />);
    await user.type(screen.getByTestId('field-baseUrl'), 'not a url');
    await user.tab();
    await waitFor(() => expect(screen.getByText('integrationsSettings.validation.invalidUrl')).toBeInTheDocument());
  });

  it('uppercases the Jira project key on blur', async () => {
    const user = userEvent.setup();
    render(<ConnectorModal {...baseProps()} />);
    const input = screen.getByTestId('field-projectKey');
    await user.type(input, 'eng');
    await user.tab();
    await waitFor(() => expect(input).toHaveValue('ENG'));
  });
});

describe('ConnectorModal — masked secrets on Edit', () => {
  const orgEntry: WorkflowConnectorEntry = { connector: 'jira', status: 'org', createdAt: '2026-06-01', updatedAt: '2026-06-28T00:00:00Z' };

  it('renders secret fields as a locked masked placeholder, not editable text', () => {
    render(<ConnectorModal {...baseProps({ entry: orgEntry })} />);
    expect(screen.getByTestId('field-locked-apiToken')).toBeInTheDocument();
    expect(screen.getByText('••••••••')).toBeInTheDocument();
    expect(screen.queryByTestId('field-apiToken')).not.toBeInTheDocument();
  });

  it('renders non-secret fields as normal empty editable inputs (no prior value to show)', () => {
    render(<ConnectorModal {...baseProps({ entry: orgEntry })} />);
    expect(screen.getByTestId('field-baseUrl')).toHaveValue('');
    expect(screen.getByTestId('field-email')).toHaveValue('');
  });

  it('clicking Replace unlocks the secret field into a normal empty editable input', async () => {
    const user = userEvent.setup();
    render(<ConnectorModal {...baseProps({ entry: orgEntry })} />);
    await user.click(screen.getByText('integrationsSettings.masking.replace'));
    expect(screen.getByTestId('field-apiToken')).toBeInTheDocument();
    expect(screen.getByTestId('field-apiToken')).toHaveValue('');
    expect(screen.queryByTestId('field-locked-apiToken')).not.toBeInTheDocument();
  });

  it('clicking Cancel after Replace reverts the field back to locked', async () => {
    const user = userEvent.setup();
    render(<ConnectorModal {...baseProps({ entry: orgEntry })} />);
    await user.click(screen.getByText('integrationsSettings.masking.replace'));
    await user.click(screen.getByText('integrationsSettings.masking.cancelReplace'));
    expect(screen.getByTestId('field-locked-apiToken')).toBeInTheDocument();
  });

  it('Save is enabled without touching any locked secret field (only non-secret fields need values)', async () => {
    const user = userEvent.setup();
    render(<ConnectorModal {...baseProps({ entry: orgEntry })} />);
    await user.type(screen.getByTestId('field-baseUrl'), 'https://acme.atlassian.net');
    await user.type(screen.getByTestId('field-email'), 'me@acme.com');
    await user.type(screen.getByTestId('field-projectKey'), 'ENG');
    await waitFor(() => expect(screen.getByTestId('save-button')).not.toBeDisabled());
  });
});

describe('ConnectorModal — merge-on-write awareness (PUT payload)', () => {
  const orgEntry: WorkflowConnectorEntry = { connector: 'jira', status: 'org', updatedAt: '2026-06-28T00:00:00Z' };

  it('only sends the fields the user actually changed, never a locked-placeholder field', async () => {
    const setWorkflowCredentials = vi.fn().mockResolvedValue({ connector: 'jira', configured: true });
    vi.mocked(useApi).mockReturnValue(makeApi({ setWorkflowCredentials }) as unknown as ReturnType<typeof useApi>);
    const user = userEvent.setup();
    render(<ConnectorModal {...baseProps({ entry: orgEntry })} />);

    // Only replace the token; leave baseUrl/email/projectKey untouched (locked/blank).
    await user.click(screen.getByText('integrationsSettings.masking.replace'));
    await user.type(screen.getByTestId('field-apiToken'), 'new-token');

    // Save is still gated on non-secret required fields too — fill them so we
    // can exercise the actual save call and assert its payload shape.
    await user.type(screen.getByTestId('field-baseUrl'), 'https://acme.atlassian.net');
    await user.type(screen.getByTestId('field-email'), 'me@acme.com');
    await user.type(screen.getByTestId('field-projectKey'), 'ENG');

    await waitFor(() => expect(screen.getByTestId('save-button')).not.toBeDisabled());
    await user.click(screen.getByTestId('save-button'));

    await waitFor(() => expect(setWorkflowCredentials).toHaveBeenCalledTimes(1));
    const [, payload] = setWorkflowCredentials.mock.calls[0];
    expect(payload).toEqual({
      apiToken: 'new-token',
      baseUrl: 'https://acme.atlassian.net',
      email: 'me@acme.com',
      projectKey: 'ENG',
    });
  });

  it('does not send an apiToken key at all when the secret field is left locked', async () => {
    const setWorkflowCredentials = vi.fn().mockResolvedValue({ connector: 'jira', configured: true });
    vi.mocked(useApi).mockReturnValue(makeApi({ setWorkflowCredentials }) as unknown as ReturnType<typeof useApi>);
    const user = userEvent.setup();
    render(<ConnectorModal {...baseProps({ entry: orgEntry })} />);

    await user.type(screen.getByTestId('field-baseUrl'), 'https://acme.atlassian.net');
    await user.type(screen.getByTestId('field-email'), 'me@acme.com');
    await user.type(screen.getByTestId('field-projectKey'), 'ENG');
    await waitFor(() => expect(screen.getByTestId('save-button')).not.toBeDisabled());
    await user.click(screen.getByTestId('save-button'));

    await waitFor(() => expect(setWorkflowCredentials).toHaveBeenCalledTimes(1));
    const [, payload] = setWorkflowCredentials.mock.calls[0];
    expect(payload).not.toHaveProperty('apiToken');
  });
});

describe('ConnectorModal — Test Connection outcomes', () => {
  async function fillJiraForm(user: ReturnType<typeof userEvent.setup>) {
    await user.type(screen.getByTestId('field-baseUrl'), 'https://acme.atlassian.net');
    await user.type(screen.getByTestId('field-email'), 'me@acme.com');
    await user.type(screen.getByTestId('field-apiToken'), 'tok123');
    await user.type(screen.getByTestId('field-projectKey'), 'ENG');
    await waitFor(() => expect(screen.getByTestId('test-connection-button')).not.toBeDisabled());
  }

  it('success: shows the verified banner and calls onTestOutcome(connector, true)', async () => {
    const onTestOutcome = vi.fn();
    vi.mocked(useApi).mockReturnValue(makeApi({
      testWorkflowCredentials: vi.fn().mockResolvedValue({ success: true, message: 'Connection verified — you can now save.' }),
    }) as unknown as ReturnType<typeof useApi>);
    const user = userEvent.setup();
    render(<ConnectorModal {...baseProps({ onTestOutcome })} />);
    await fillJiraForm(user);
    await user.click(screen.getByTestId('test-connection-button'));
    await waitFor(() => expect(screen.getByTestId('test-success-banner')).toBeInTheDocument());
    expect(onTestOutcome).toHaveBeenCalledWith('jira', true);
  });

  it("failure: shows David's exact error copy in the failure banner and calls onTestOutcome(connector, false)", async () => {
    const onTestOutcome = vi.fn();
    const message = "Invalid email or API token — check that the token hasn't expired in your Atlassian account settings (id.atlassian.com → Security → API tokens).";
    vi.mocked(useApi).mockReturnValue(makeApi({
      testWorkflowCredentials: vi.fn().mockResolvedValue({ success: false, message, failedCheck: 'auth' }),
    }) as unknown as ReturnType<typeof useApi>);
    const user = userEvent.setup();
    render(<ConnectorModal {...baseProps({ onTestOutcome })} />);
    await fillJiraForm(user);
    await user.click(screen.getByTestId('test-connection-button'));
    await waitFor(() => expect(screen.getByTestId('test-failure-banner')).toHaveTextContent(message));
    expect(onTestOutcome).toHaveBeenCalledWith('jira', false);
  });

  it('429 rate-limited: shows a clear "testing too often" message, not a generic failure', async () => {
    vi.mocked(useApi).mockReturnValue(makeApi({
      testWorkflowCredentials: vi.fn().mockRejectedValue(new ConnectorTestError('rate_limited', 429)),
    }) as unknown as ReturnType<typeof useApi>);
    const user = userEvent.setup();
    render(<ConnectorModal {...baseProps()} />);
    await fillJiraForm(user);
    await user.click(screen.getByTestId('test-connection-button'));
    await waitFor(() => expect(screen.getByTestId('test-failure-banner')).toHaveTextContent('integrationsSettings.test.rateLimited'));
  });

  it('Slack test success shows the side-effect-aware "test message sent" copy', async () => {
    vi.mocked(useApi).mockReturnValue(makeApi({
      testWorkflowCredentials: vi.fn().mockResolvedValue({ success: true }),
    }) as unknown as ReturnType<typeof useApi>);
    const user = userEvent.setup();
    render(<ConnectorModal {...baseProps({ connector: 'slack' })} />);
    await user.type(screen.getByTestId('field-webhook_url'), 'https://hooks.slack.com/services/T000/B000/XXXX');
    await waitFor(() => expect(screen.getByTestId('test-connection-button')).not.toBeDisabled());
    await user.click(screen.getByTestId('test-connection-button'));
    await waitFor(() => expect(screen.getByTestId('test-success-banner')).toHaveTextContent('integrationsSettings.test.slackSent'));
  });

  it('Slack button is labeled "Send Test Message" instead of "Test Connection"', () => {
    render(<ConnectorModal {...baseProps({ connector: 'slack' })} />);
    expect(screen.getByTestId('test-connection-button')).toHaveTextContent('integrationsSettings.actions.sendTestMessage');
  });
});

describe('ConnectorModal — Save is never blocked by a failed test', () => {
  it('Save remains enabled and succeeds after a failed Test Connection', async () => {
    const onSaved = vi.fn();
    const setWorkflowCredentials = vi.fn().mockResolvedValue({ connector: 'jira', configured: true });
    vi.mocked(useApi).mockReturnValue(makeApi({
      testWorkflowCredentials: vi.fn().mockResolvedValue({ success: false, message: 'Invalid credentials' }),
      setWorkflowCredentials,
    }) as unknown as ReturnType<typeof useApi>);
    const user = userEvent.setup();
    render(<ConnectorModal {...baseProps({ onSaved })} />);

    await user.type(screen.getByTestId('field-baseUrl'), 'https://acme.atlassian.net');
    await user.type(screen.getByTestId('field-email'), 'me@acme.com');
    await user.type(screen.getByTestId('field-apiToken'), 'tok123');
    await user.type(screen.getByTestId('field-projectKey'), 'ENG');

    await user.click(screen.getByTestId('test-connection-button'));
    await waitFor(() => expect(screen.getByTestId('test-failure-banner')).toBeInTheDocument());

    expect(screen.getByTestId('save-button')).not.toBeDisabled();
    await user.click(screen.getByTestId('save-button'));
    await waitFor(() => expect(setWorkflowCredentials).toHaveBeenCalled());
    expect(onSaved).toHaveBeenCalledWith('jira');
  });

  it('Save works having never run Test Connection at all', async () => {
    const onSaved = vi.fn();
    const setWorkflowCredentials = vi.fn().mockResolvedValue({ connector: 'jira', configured: true });
    vi.mocked(useApi).mockReturnValue(makeApi({ setWorkflowCredentials }) as unknown as ReturnType<typeof useApi>);
    const user = userEvent.setup();
    render(<ConnectorModal {...baseProps({ onSaved })} />);

    await user.type(screen.getByTestId('field-baseUrl'), 'https://acme.atlassian.net');
    await user.type(screen.getByTestId('field-email'), 'me@acme.com');
    await user.type(screen.getByTestId('field-apiToken'), 'tok123');
    await user.type(screen.getByTestId('field-projectKey'), 'ENG');

    await waitFor(() => expect(screen.getByTestId('save-button')).not.toBeDisabled());
    await user.click(screen.getByTestId('save-button'));
    await waitFor(() => expect(setWorkflowCredentials).toHaveBeenCalled());
    expect(onSaved).toHaveBeenCalledWith('jira');
  });
});

describe('ConnectorModal — Disconnect flow', () => {
  const orgEntry: WorkflowConnectorEntry = { connector: 'jira', status: 'org', updatedAt: '2026-06-28T00:00:00Z' };

  it('shows a Disconnect link only when already connected', () => {
    render(<ConnectorModal {...baseProps({ entry: orgEntry })} />);
    expect(screen.getByTestId('open-disconnect-confirm')).toBeInTheDocument();
  });

  it('does not show a Disconnect link on a fresh Connect flow', () => {
    render(<ConnectorModal {...baseProps()} />);
    expect(screen.queryByTestId('open-disconnect-confirm')).not.toBeInTheDocument();
  });

  it('requires confirmation before calling DELETE', async () => {
    const deleteWorkflowCredentials = vi.fn().mockResolvedValue(undefined);
    vi.mocked(useApi).mockReturnValue(makeApi({ deleteWorkflowCredentials }) as unknown as ReturnType<typeof useApi>);
    const user = userEvent.setup();
    render(<ConnectorModal {...baseProps({ entry: orgEntry })} />);

    await user.click(screen.getByTestId('open-disconnect-confirm'));
    expect(deleteWorkflowCredentials).not.toHaveBeenCalled();
    expect(screen.getByText('integrationsSettings.disconnectConfirm.title')).toBeInTheDocument();

    await user.click(screen.getByTestId('confirm-disconnect-button'));
    await waitFor(() => expect(deleteWorkflowCredentials).toHaveBeenCalledWith('jira'));
  });

  it('cancelling the confirm dialog does not call DELETE', async () => {
    const deleteWorkflowCredentials = vi.fn();
    vi.mocked(useApi).mockReturnValue(makeApi({ deleteWorkflowCredentials }) as unknown as ReturnType<typeof useApi>);
    const user = userEvent.setup();
    render(<ConnectorModal {...baseProps({ entry: orgEntry })} />);

    await user.click(screen.getByTestId('open-disconnect-confirm'));
    await user.click(screen.getByText('integrationsSettings.disconnectConfirm.cancelButton'));
    expect(deleteWorkflowCredentials).not.toHaveBeenCalled();
  });

  it('calls onDisconnected with the connector name after confirming', async () => {
    const onDisconnected = vi.fn();
    vi.mocked(useApi).mockReturnValue(makeApi() as unknown as ReturnType<typeof useApi>);
    const user = userEvent.setup();
    render(<ConnectorModal {...baseProps({ entry: orgEntry, onDisconnected })} />);
    await user.click(screen.getByTestId('open-disconnect-confirm'));
    await user.click(screen.getByTestId('confirm-disconnect-button'));
    await waitFor(() => expect(onDisconnected).toHaveBeenCalledWith('jira'));
  });
});

describe('ConnectorModal — vault-unconfigured (503) surfacing', () => {
  it('calls onVaultUnconfigured when Save fails with a vault-not-configured error', async () => {
    const onVaultUnconfigured = vi.fn();
    vi.mocked(useApi).mockReturnValue(makeApi({
      setWorkflowCredentials: vi.fn().mockRejectedValue(new Error('Credentials vault is not configured on this deployment')),
    }) as unknown as ReturnType<typeof useApi>);
    const user = userEvent.setup();
    render(<ConnectorModal {...baseProps({ onVaultUnconfigured })} />);

    await user.type(screen.getByTestId('field-baseUrl'), 'https://acme.atlassian.net');
    await user.type(screen.getByTestId('field-email'), 'me@acme.com');
    await user.type(screen.getByTestId('field-apiToken'), 'tok123');
    await user.type(screen.getByTestId('field-projectKey'), 'ENG');
    await waitFor(() => expect(screen.getByTestId('save-button')).not.toBeDisabled());
    await user.click(screen.getByTestId('save-button'));

    await waitFor(() => expect(onVaultUnconfigured).toHaveBeenCalled());
  });
});
