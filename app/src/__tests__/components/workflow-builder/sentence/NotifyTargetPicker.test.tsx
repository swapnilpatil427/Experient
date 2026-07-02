import { useState } from 'react';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, afterEach, beforeAll, beforeEach, vi } from 'vitest';

vi.mock('../../../../hooks/useApi', () => ({ useApi: vi.fn() }));
vi.mock('../../../../lib/i18n', () => ({
  useTranslation: () => ({
    t: (k: string, vars?: Record<string, unknown>) => {
      if (vars) return k.replace(/\{(\w+)\}/g, () => '') + Object.entries(vars).map(([key, v]) => ` ${key}:${v}`).join('');
      return k;
    },
  }),
}));

import { useApi } from '../../../../hooks/useApi';
import { NotifyTargetPicker } from '../../../../components/workflow-builder/sentence/NotifyTargetPicker';
import type { NotifyTarget } from '../../../../lib/api';

afterEach(cleanup);

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  Element.prototype.releasePointerCapture = vi.fn();
});

const TARGETS_RESPONSE = {
  roles: [{ id: 'role-1', name: 'Support', memberCount: 5 }, { id: 'role-empty', name: 'Ghost Role', memberCount: 0 }],
  departments: [{ id: 'dept-1', name: 'Customer Success', memberCount: 8 }],
  groups: [{ id: 'group-1', name: 'On-call', memberCount: 3 }],
};

function makeApi(overrides: Record<string, unknown> = {}) {
  return {
    listUsers: vi.fn().mockResolvedValue({
      users: [{ userId: 'u1', displayName: 'Jane Doe', email: 'jane@company.com' }],
      total: 1, limit: 10, offset: 0, hasMore: false,
    }),
    getUser: vi.fn().mockResolvedValue({ user: { userId: 'u1', displayName: 'Jane Doe', email: 'jane@company.com' } }),
    getNotificationTargets: vi.fn().mockResolvedValue(TARGETS_RESPONSE),
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(useApi).mockReturnValue(makeApi() as unknown as ReturnType<typeof useApi>);
});

function Wrapper({ initial }: { initial?: NotifyTarget }) {
  const [value, setValue] = useState<NotifyTarget | undefined>(initial);
  return <NotifyTargetPicker value={value} onChange={setValue} />;
}

describe('NotifyTargetPicker — mode selector', () => {
  it('renders all 4 modes, defaulting to "Specific people"', () => {
    render(<Wrapper />);
    expect(screen.getByTestId('notify-target-mode-users')).toBeInTheDocument();
    expect(screen.getByTestId('notify-target-mode-role')).toBeInTheDocument();
    expect(screen.getByTestId('notify-target-mode-department')).toBeInTheDocument();
    expect(screen.getByTestId('notify-target-mode-group')).toBeInTheDocument();
    expect(screen.getByTestId('notify-target-people-search')).toBeInTheDocument();
  });

  it('switching to "A role" mode fetches and renders the role dropdown', async () => {
    const user = userEvent.setup();
    render(<Wrapper />);
    await user.click(screen.getByTestId('notify-target-mode-role'));
    await waitFor(() => expect(screen.getByTestId('notify-target-role-select')).toBeInTheDocument());
  });

  it('switching to "A department" mode renders the department dropdown', async () => {
    const user = userEvent.setup();
    render(<Wrapper />);
    await user.click(screen.getByTestId('notify-target-mode-department'));
    await waitFor(() => expect(screen.getByTestId('notify-target-department-select')).toBeInTheDocument());
  });

  it('switching to "A group" mode renders the group dropdown', async () => {
    const user = userEvent.setup();
    render(<Wrapper />);
    await user.click(screen.getByTestId('notify-target-mode-group'));
    await waitFor(() => expect(screen.getByTestId('notify-target-group-select')).toBeInTheDocument());
  });

  it('lazily fetches notification-targets only once a role/department/group mode is selected', async () => {
    const getNotificationTargets = vi.fn().mockResolvedValue(TARGETS_RESPONSE);
    vi.mocked(useApi).mockReturnValue(makeApi({ getNotificationTargets }) as unknown as ReturnType<typeof useApi>);
    render(<Wrapper />);
    expect(getNotificationTargets).not.toHaveBeenCalled();
    const user = userEvent.setup();
    await user.click(screen.getByTestId('notify-target-mode-role'));
    await waitFor(() => expect(getNotificationTargets).toHaveBeenCalledTimes(1));
  });
});

describe('NotifyTargetPicker — "Specific people" mode', () => {
  it('searches, selects a person, renders a chip, and calls onChange with the users shape', async () => {
    const user = userEvent.setup();
    render(<Wrapper />);
    await user.type(screen.getByTestId('notify-target-people-search'), 'Jane');
    await user.click(await screen.findByTestId('notify-target-person-u1'));
    expect(await screen.findByText('Jane Doe')).toBeInTheDocument();
    expect(screen.getByTestId('notify-target-summary')).toHaveTextContent('summaryPeopleOne');
  });

  it('shows the plural summary once 2+ people are selected', async () => {
    const listUsers = vi.fn()
      .mockResolvedValueOnce({ users: [{ userId: 'u1', displayName: 'Jane Doe', email: 'jane@company.com' }], total: 1, limit: 10, offset: 0, hasMore: false })
      .mockResolvedValueOnce({ users: [{ userId: 'u2', displayName: 'Sam Lee', email: 'sam@company.com' }], total: 1, limit: 10, offset: 0, hasMore: false });
    vi.mocked(useApi).mockReturnValue(makeApi({ listUsers }) as unknown as ReturnType<typeof useApi>);
    const user = userEvent.setup();
    render(<Wrapper />);

    await user.type(screen.getByTestId('notify-target-people-search'), 'Jane');
    await user.click(await screen.findByTestId('notify-target-person-u1'));
    await user.type(screen.getByTestId('notify-target-people-search'), 'Sam');
    await user.click(await screen.findByTestId('notify-target-person-u2'));

    expect(screen.getByTestId('notify-target-summary')).toHaveTextContent('summaryPeopleOther count:2');
  });

  it('removing a chip drops that user from the target', async () => {
    const user = userEvent.setup();
    render(<Wrapper />);
    await user.type(screen.getByTestId('notify-target-people-search'), 'Jane');
    await user.click(await screen.findByTestId('notify-target-person-u1'));
    expect(await screen.findByText('Jane Doe')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /removePersonAria/i }));
    await waitFor(() => expect(screen.queryByText('Jane Doe')).not.toBeInTheDocument());
    expect(screen.queryByTestId('notify-target-summary')).not.toBeInTheDocument();
  });
});

describe('NotifyTargetPicker — role/department/group summary counts', () => {
  it('shows the role member count from the notification-targets response as-is', async () => {
    const user = userEvent.setup();
    render(<Wrapper initial={{ targetType: 'role', roleId: 'role-1' }} />);
    await waitFor(() => expect(screen.getByTestId('notify-target-role-select')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('notify-target-summary')).toHaveTextContent('summaryRole count:5'));
  });

  it('shows a zero-count warning variant when a role has no members', async () => {
    render(<Wrapper initial={{ targetType: 'role', roleId: 'role-empty' }} />);
    await waitFor(() => expect(screen.getByTestId('notify-target-summary')).toHaveTextContent('summaryZeroRole'));
  });

  it('shows the department member count', async () => {
    render(<Wrapper initial={{ targetType: 'department', departmentId: 'dept-1' }} />);
    await waitFor(() => expect(screen.getByTestId('notify-target-summary')).toHaveTextContent('summaryDepartment count:8'));
  });

  it('shows the group member count', async () => {
    render(<Wrapper initial={{ targetType: 'group', groupId: 'group-1' }} />);
    await waitFor(() => expect(screen.getByTestId('notify-target-summary')).toHaveTextContent('summaryGroup count:3'));
  });
});

describe('NotifyTargetPicker — backward compatibility', () => {
  it('loads a legacy single-userId target into "Specific people" mode with that user shown', async () => {
    render(<Wrapper initial={{ targetType: 'users', userIds: ['u1'] }} />);
    expect(screen.getByTestId('notify-target-people-search')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Jane Doe')).toBeInTheDocument());
  });
});

describe('NotifyTargetPicker — permission-denied degradation', () => {
  it('shows an inline message instead of crashing when notification-targets 403s', async () => {
    const getNotificationTargets = vi.fn().mockRejectedValue(new Error('403'));
    vi.mocked(useApi).mockReturnValue(makeApi({ getNotificationTargets }) as unknown as ReturnType<typeof useApi>);
    const user = userEvent.setup();
    render(<Wrapper />);
    await user.click(screen.getByTestId('notify-target-mode-role'));
    await waitFor(() => expect(screen.getByTestId('notify-target-permission-denied')).toBeInTheDocument());
  });
});

// A-3 (DEEP_AUDIT_UX_FINDINGS.md §8, Wave 11) — the 4-way mode toggle had no
// aria-pressed at all, unlike ActionTile.tsx's already-correct pattern.
describe('NotifyTargetPicker — A-3 aria-pressed on mode toggle', () => {
  it('marks the active mode button aria-pressed=true and the others false', async () => {
    const user = userEvent.setup();
    render(<Wrapper />);
    expect(screen.getByTestId('notify-target-mode-users')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('notify-target-mode-role')).toHaveAttribute('aria-pressed', 'false');
    await user.click(screen.getByTestId('notify-target-mode-role'));
    expect(screen.getByTestId('notify-target-mode-role')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('notify-target-mode-users')).toHaveAttribute('aria-pressed', 'false');
  });
});

// A-2 (DEEP_AUDIT_UX_FINDINGS.md §8, Wave 11) — the "Specific people" search
// had zero ARIA combobox semantics. These tests prove the minimal WAI-ARIA
// pattern (role=combobox/listbox/option, aria-expanded, aria-activedescendant)
// plus keyboard navigation (arrows/Enter/Escape) all work.
describe('NotifyTargetPicker — A-2 combobox semantics + keyboard nav', () => {
  it('the search input exposes combobox ARIA attributes wired to the results listbox', async () => {
    const user = userEvent.setup();
    render(<Wrapper />);
    const input = screen.getByTestId('notify-target-people-search');
    expect(input).toHaveAttribute('role', 'combobox');
    expect(input).toHaveAttribute('aria-expanded', 'false');
    await user.type(input, 'Jane');
    await screen.findByTestId('notify-target-person-u1');
    expect(input).toHaveAttribute('aria-expanded', 'true');
    expect(input).toHaveAttribute('aria-controls', 'notify-target-people-listbox');
    expect(screen.getByTestId('notify-target-people-results')).toHaveAttribute('role', 'listbox');
    expect(screen.getByTestId('notify-target-person-u1')).toHaveAttribute('role', 'option');
  });

  it('ArrowDown highlights the first result and sets aria-activedescendant', async () => {
    const user = userEvent.setup();
    render(<Wrapper />);
    const input = screen.getByTestId('notify-target-people-search');
    await user.type(input, 'Jane');
    await screen.findByTestId('notify-target-person-u1');
    // Result set defaults to the first row highlighted (activeIndex resets to 0).
    expect(input).toHaveAttribute('aria-activedescendant', 'notify-target-option-u1');
    expect(screen.getByTestId('notify-target-person-u1')).toHaveAttribute('aria-selected', 'true');
  });

  it('Enter commits the highlighted option, same as a click', async () => {
    const user = userEvent.setup();
    render(<Wrapper />);
    const input = screen.getByTestId('notify-target-people-search');
    await user.type(input, 'Jane');
    await screen.findByTestId('notify-target-person-u1');
    await user.type(input, '{Enter}');
    expect(await screen.findByText('Jane Doe')).toBeInTheDocument();
  });

  it('Escape closes the listbox', async () => {
    const user = userEvent.setup();
    render(<Wrapper />);
    const input = screen.getByTestId('notify-target-people-search');
    await user.type(input, 'Jane');
    await screen.findByTestId('notify-target-people-results');
    await user.type(input, '{Escape}');
    await waitFor(() => expect(screen.queryByTestId('notify-target-people-results')).not.toBeInTheDocument());
  });
});

// V-2 (DEEP_AUDIT_UX_FINDINGS.md §8, Wave 11) — literal "Loading…" text
// replaced with the spinner pattern used elsewhere; the string is retained
// only as an sr-only label for accessibility.
describe('NotifyTargetPicker — V-2 spinner instead of literal loading text', () => {
  it('shows a spinner (not visible "Loading…" text) while the role/department/group targets fetch is in flight', async () => {
    let resolveTargets: (v: typeof TARGETS_RESPONSE) => void = () => {};
    const getNotificationTargets = vi.fn(() => new Promise<typeof TARGETS_RESPONSE>((resolve) => { resolveTargets = resolve; }));
    vi.mocked(useApi).mockReturnValue(makeApi({ getNotificationTargets }) as unknown as ReturnType<typeof useApi>);
    const user = userEvent.setup();
    render(<Wrapper />);
    await user.click(screen.getByTestId('notify-target-mode-role'));
    // No visible "Loading…" text node — only an sr-only label plus a spinner.
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
    expect(document.querySelector('.animate-spin')).toBeInTheDocument();
    resolveTargets(TARGETS_RESPONSE);
    await waitFor(() => expect(screen.getByTestId('notify-target-role-select')).toBeInTheDocument());
  });
});
