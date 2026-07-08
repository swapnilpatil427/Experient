import { useState } from 'react';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, afterEach, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../../../../hooks/useApi', () => ({ useApi: vi.fn() }));
vi.mock('../../../../lib/i18n', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

import { useApi } from '../../../../hooks/useApi';
import {
  AdvancedFieldsDisclosure, type AdvancedFieldsValue,
} from '../../../../components/workflow-builder/sentence/AdvancedFieldsDisclosure';

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

function Wrapper({ actionType, initial }: { actionType: string; initial?: AdvancedFieldsValue }) {
  const [value, setValue] = useState<AdvancedFieldsValue>(initial ?? {});
  return <AdvancedFieldsDisclosure actionType={actionType} value={value} onChange={setValue} />;
}

describe('AdvancedFieldsDisclosure — notify.email', () => {
  it('renders the NotifyTargetPicker (not a free-text recipients field) once expanded', async () => {
    const user = userEvent.setup();
    render(<Wrapper actionType="notify.email" />);
    await user.click(screen.getByText('workflows.builder.sentence.content.advancedFieldsHeading'));
    expect(await screen.findByTestId('notify-target-picker')).toBeInTheDocument();
    expect(screen.queryByLabelText(/recipients/i)).not.toBeInTheDocument();
  });

  it('still renders the subject field alongside the picker', async () => {
    const user = userEvent.setup();
    render(<Wrapper actionType="notify.email" />);
    await user.click(screen.getByText('workflows.builder.sentence.content.advancedFieldsHeading'));
    expect(await screen.findByLabelText(/subject/i)).toBeInTheDocument();
  });
});

describe('AdvancedFieldsDisclosure — notify.slack is unchanged', () => {
  it('renders only the channel field — no NotifyTargetPicker, no subject field', async () => {
    const user = userEvent.setup();
    render(<Wrapper actionType="notify.slack" />);
    await user.click(screen.getByText('workflows.builder.sentence.content.advancedFieldsHeading'));
    expect(await screen.findByLabelText(/channel/i)).toBeInTheDocument();
    expect(screen.queryByTestId('notify-target-picker')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/subject/i)).not.toBeInTheDocument();
  });

  it('typing in the channel field updates value.channel only', async () => {
    const user = userEvent.setup();
    render(<Wrapper actionType="notify.slack" />);
    await user.click(screen.getByText('workflows.builder.sentence.content.advancedFieldsHeading'));
    const channelInput = await screen.findByLabelText(/channel/i);
    await user.type(channelInput, '#cx-team');
    await waitFor(() => expect(channelInput).toHaveValue('#cx-team'));
  });
});

describe('AdvancedFieldsDisclosure — other action types', () => {
  it('renders nothing for a non-notify action', () => {
    render(<Wrapper actionType="data.tag_responses" />);
    expect(screen.queryByText('workflows.builder.sentence.content.advancedFieldsHeading')).not.toBeInTheDocument();
  });
});
