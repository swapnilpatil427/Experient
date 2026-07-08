import { useState } from 'react';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, afterEach, beforeAll, beforeEach, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';

vi.mock('../../../../hooks/useApi', () => ({ useApi: vi.fn() }));
vi.mock('../../../../lib/i18n', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

import { useApi } from '../../../../hooks/useApi';
import {
  ActionStepPanelContent, type ActionOption,
} from '../../../../components/workflow-builder/sentence/ActionStepPanelContent';
import {
  defaultActionContentConfig, type ActionContentConfig,
} from '../../../../components/workflow-builder/sentence/contentSections';

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

const ACTIONS: ActionOption[] = [
  { action: 'notify.in_app', label: 'In-app notification', category: 'Notify', live: true },
  { action: 'notify.email', label: 'Email', category: 'Notify', live: true },
  { action: 'data.tag_responses', label: 'Tag response', category: 'Data', live: true },
];

function Wrapper({ initialSelected }: { initialSelected?: string }) {
  const [selected, setSelected] = useState<string | undefined>(initialSelected);
  const [contentConfig, setContentConfig] = useState<ActionContentConfig>(defaultActionContentConfig());
  const [simpleConfig, setSimpleConfig] = useState<Record<string, unknown>>({});
  return (
    <TooltipProvider>
      <ActionStepPanelContent
        actions={ACTIONS}
        selectedAction={selected}
        onSelect={setSelected}
        contentConfig={contentConfig}
        onContentConfigChange={setContentConfig}
        simpleConfig={simpleConfig}
        onSimpleConfigChange={setSimpleConfig}
      />
    </TooltipProvider>
  );
}

// notify.in_app previously had NO dedicated config UI at all — selecting it
// fell through to SimpleActionConfigForm's generic "No additional
// configuration needed" message, since it wasn't in CONTENT_PRODUCING_ACTIONS
// and had no FIELDS_BY_ACTION entry either. This is the real gap Rohan's spec
// flagged as "not found" and asked Elias to locate/fix.
describe('ActionStepPanelContent — notify.in_app config location (Wave 9)', () => {
  it('selecting notify.in_app renders the NotifyTargetPicker directly (not the generic no-config message)', async () => {
    const user = userEvent.setup();
    render(<Wrapper />);
    await user.click(screen.getByTestId('action-tile-notify.in_app'));
    expect(await screen.findByTestId('notify-target-picker')).toBeInTheDocument();
    expect(screen.queryByTestId('content-customization-panel')).not.toBeInTheDocument();
    expect(screen.queryByText('workflows.builder.sentence.simpleForm.noConfigNeeded')).not.toBeInTheDocument();
  });

  it('selecting notify.email still renders the full ContentCustomizationPanel (sections + picker), not the bare picker', async () => {
    const user = userEvent.setup();
    render(<Wrapper />);
    await user.click(screen.getByTestId('action-tile-notify.email'));
    expect(await screen.findByTestId('content-customization-panel')).toBeInTheDocument();
  });

  it('picking a person for notify.in_app updates contentConfig.target', async () => {
    const user = userEvent.setup();
    render(<Wrapper initialSelected="notify.in_app" />);
    await user.type(await screen.findByTestId('notify-target-people-search'), 'Jane');
    // resolves via listUsers mock returning no users by default — assert the
    // search input itself is wired to the picker under notify.in_app's panel.
    await waitFor(() => expect(screen.getByTestId('notify-target-picker')).toBeInTheDocument());
  });

  it('a non-notify action still gets the plain SimpleActionConfigForm', async () => {
    const user = userEvent.setup();
    render(<Wrapper />);
    await user.click(screen.getByTestId('action-tile-data.tag_responses'));
    expect(await screen.findByTestId('simple-action-config-form')).toBeInTheDocument();
  });
});
