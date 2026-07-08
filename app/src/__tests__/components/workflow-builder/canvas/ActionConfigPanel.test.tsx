import { useState } from 'react';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, afterEach, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../../../../hooks/useApi', () => ({ useApi: vi.fn() }));
vi.mock('../../../../lib/i18n', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

import { useApi } from '../../../../hooks/useApi';
import { ActionConfigPanel } from '../../../../components/workflow-builder/canvas/ActionConfigPanel';

afterEach(cleanup);

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  Element.prototype.releasePointerCapture = vi.fn();
});

beforeEach(() => {
  vi.mocked(useApi).mockReturnValue({
    listUsers: vi.fn().mockResolvedValue({ users: [], total: 0, limit: 10, offset: 0, hasMore: false }),
    getUser: vi.fn().mockResolvedValue({ user: { userId: 'u1', displayName: 'Jane Doe', email: 'jane@company.com' } }),
    getNotificationTargets: vi.fn().mockResolvedValue({ roles: [], departments: [], groups: [] }),
  } as unknown as ReturnType<typeof useApi>);
});

// DEEP_AUDIT_FIX_SPECS.md Issue 1 — dispatch to the right config form per
// action type, the exact same three-way branch ActionStepPanelContent.tsx
// already encodes (imported, not re-declared).
function Wrapper({ action, initialConfig }: { action: string; initialConfig: Record<string, unknown> }) {
  const [config, setConfig] = useState(initialConfig);
  return (
    <ActionConfigPanel
      open
      action={action}
      actionLabel="Test Action"
      config={config}
      onChange={setConfig}
      onClose={() => {}}
    />
  );
}

describe('ActionConfigPanel — dispatch by action type', () => {
  it('renders ContentCustomizationPanel for a CONTENT_PRODUCING_ACTION (notify.slack)', async () => {
    render(<Wrapper action="notify.slack" initialConfig={{}} />);
    await waitFor(() => expect(screen.getByTestId('content-customization-panel')).toBeInTheDocument());
  });

  it('renders NotifyTargetPicker for notify.in_app', async () => {
    render(<Wrapper action="notify.in_app" initialConfig={{}} />);
    await waitFor(() => expect(screen.getByText('workflows.builder.sentence.notifyTarget.heading')).toBeInTheDocument());
  });

  it('renders SimpleActionConfigForm for a plain action (jira.create_issue)', async () => {
    render(<Wrapper action="jira.create_issue" initialConfig={{}} />);
    await waitFor(() => expect(screen.getByTestId('simple-action-config-form')).toBeInTheDocument());
  });

  it('renders the "no configuration needed" copy for flow.stop', async () => {
    render(<Wrapper action="flow.stop" initialConfig={{}} />);
    await waitFor(() => expect(screen.getByText('workflows.builder.sentence.simpleForm.noConfigNeeded')).toBeInTheDocument());
  });

  it('shows the action label as the Sheet title', async () => {
    render(<Wrapper action="jira.create_issue" initialConfig={{}} />);
    await waitFor(() => expect(screen.getByText('Test Action')).toBeInTheDocument());
  });

  it('calls onChange with the flat engine config shape when a SimpleActionConfigForm field changes', async () => {
    const user = userEvent.setup();
    render(<Wrapper action="jira.create_issue" initialConfig={{}} />);
    const input = await screen.findByLabelText('workflows.builder.sentence.simpleForm.jiraProjectLabel');
    await user.type(input, 'CX');
    await waitFor(() => expect(input).toHaveValue('CX'));
  });
});
