import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../../lib/i18n', () => ({
  useTranslation: () => ({ t: (k: string, opts?: Record<string, unknown>) => (opts ? `${k}:${JSON.stringify(opts)}` : k) }),
}));

vi.mock('framer-motion', () => ({
  motion: {
    div: (p: React.ComponentProps<'div'>) => <div {...p} />,
  },
}));

vi.mock('../../../contexts/pageTitle', () => ({ useSetPageTitle: vi.fn() }));
vi.mock('../../../lib/permissions', () => ({ usePermissions: () => ({ isAdmin: true }) }));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

const mockListTags = vi.fn();
vi.mock('../../../hooks/useApi', () => ({
  useApi: () => ({ listTags: mockListTags, deleteTag: vi.fn(), createTag: vi.fn() }),
}));

import { TagsSettingsPage } from '../../../pages/settings/TagsSettingsPage';

afterEach(cleanup);

const tags = [
  { id: 'tag-1', name: 'Onboarding', slug: 'onboarding', color: '#2a4bd9', survey_count: 3, created_at: '2026-01-01T00:00:00Z' },
];

beforeEach(() => {
  mockNavigate.mockReset();
  mockListTags.mockReset();
  mockListTags.mockResolvedValue({ tags });
});

describe('TagsSettingsPage — dead-link fix', () => {
  it('clicking a tag card navigates to the new Tag Report route, not the old unmounted GROUP_REPORT route', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><TagsSettingsPage /></MemoryRouter>);

    await waitFor(() => expect(screen.getByText('Onboarding')).toBeInTheDocument());
    await user.click(screen.getByText('Onboarding'));

    expect(mockNavigate).toHaveBeenCalledWith('/app/experience/tags/tag-1/report');
    expect(mockNavigate).not.toHaveBeenCalledWith(expect.stringContaining('/app/groups/'));
  });
});
