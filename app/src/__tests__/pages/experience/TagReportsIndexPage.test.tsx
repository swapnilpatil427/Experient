import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../../lib/i18n', () => ({
  useTranslation: () => ({
    t: (k: string, vars?: Record<string, unknown>) => (vars ? `${k}:${JSON.stringify(vars)}` : k),
  }),
}));

vi.mock('framer-motion', () => ({
  motion: { div: (p: React.ComponentProps<'div'>) => <div {...p} /> },
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('../../../contexts/pageTitle', () => ({ useSetPageTitle: vi.fn() }));
vi.mock('../../../pages/insights/shared', () => ({
  GlassCard: ({ children, className }: React.ComponentProps<'div'>) => <div className={className}>{children}</div>,
}));
vi.mock('../../../components/ExperienceSubNav', () => ({
  ExperienceSubNav: () => <div data-testid="sub-nav" />,
}));
vi.mock('../../../components/LoadingStates', () => ({
  TagReportsIndexSkeleton: () => <div data-testid="skeleton" />,
}));

const mockUseTagReportsIndex = vi.fn();
vi.mock('../../../hooks/useTagReport', () => ({
  useTagReportsIndex: (...args: unknown[]) => mockUseTagReportsIndex(...args),
}));

import { TagReportsIndexPage } from '../../../pages/experience/TagReportsIndexPage';

afterEach(cleanup);
beforeEach(() => mockNavigate.mockReset());

function renderPage() {
  return render(<MemoryRouter><TagReportsIndexPage /></MemoryRouter>);
}

describe('TagReportsIndexPage', () => {
  it('shows the skeleton while loading', () => {
    mockUseTagReportsIndex.mockReturnValue({ reports: [], total: 0, loading: true, error: null });
    renderPage();
    expect(screen.getByTestId('skeleton')).toBeInTheDocument();
  });

  it('shows the org-wide empty state when there are zero reports and no active search', () => {
    mockUseTagReportsIndex.mockReturnValue({ reports: [], total: 0, loading: false, error: null });
    renderPage();
    expect(screen.getByText('tagReport.index.emptyOrgWide.heading')).toBeInTheDocument();
  });

  it('shows the zero-search-results state (distinct from org-wide empty) when a search yields nothing', async () => {
    const user = userEvent.setup();
    mockUseTagReportsIndex.mockReturnValue({ reports: [], total: 0, loading: false, error: null });
    renderPage();

    await user.type(screen.getByPlaceholderText('tagReport.index.searchPlaceholder'), 'zzz');

    await waitFor(() => {
      expect(screen.getByText(/tagReport\.index\.emptySearch\.heading/)).toBeInTheDocument();
    }, { timeout: 1000 });
    // Must not conflate with the org-wide empty state's copy
    expect(screen.queryByText('tagReport.index.emptyOrgWide.heading')).not.toBeInTheDocument();
  });

  it('renders a card grid with tag reports, and computes the stats strip from the list', () => {
    mockUseTagReportsIndex.mockReturnValue({
      reports: [
        { tag_id: 't1', tag_name: 'Onboarding', tag_color: '#2a4bd9', survey_count: 3, latest_run: { mode: 'manual', created_at: '2026-07-01', has_active_warning: true }, automated_enabled: true },
        { tag_id: 't2', tag_name: 'Renewal', tag_color: '#059669', survey_count: 5, latest_run: { mode: 'automated', created_at: '2026-07-01', has_active_warning: false }, automated_enabled: true },
      ],
      total: 2,
      loading: false,
      error: null,
    });
    renderPage();

    expect(screen.getByText('Onboarding')).toBeInTheDocument();
    expect(screen.getByText('Renewal')).toBeInTheDocument();
    // needsAttention stat = 1 (only t1 has an active warning); automatedActive stat = 2
    const needsAttentionLabel = screen.getByText('tagReport.index.stats.needsAttention');
    expect(needsAttentionLabel.nextElementSibling).toHaveTextContent('1');
    const automatedLabel = screen.getByText('tagReport.index.stats.automatedActive');
    expect(automatedLabel.nextElementSibling).toHaveTextContent('2');
  });

  it('clicking a card navigates to TAG_REPORT_LATEST for that tag', async () => {
    const user = userEvent.setup();
    mockUseTagReportsIndex.mockReturnValue({
      reports: [{ tag_id: 't1', tag_name: 'Onboarding', tag_color: '#2a4bd9', survey_count: 3, latest_run: null }],
      total: 1,
      loading: false,
      error: null,
    });
    renderPage();

    await user.click(screen.getByText('Onboarding'));
    expect(mockNavigate).toHaveBeenCalledWith('/app/experience/tags/t1/report');
  });

  it('shows an error banner when the hook reports an error', () => {
    mockUseTagReportsIndex.mockReturnValue({ reports: [], total: 0, loading: false, error: 'server error' });
    renderPage();
    expect(screen.getByText('server error')).toBeInTheDocument();
  });
});
