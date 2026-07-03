import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../../lib/i18n', () => ({
  useTranslation: () => ({
    t: (k: string, vars?: Record<string, unknown>) => (vars ? `${k}:${JSON.stringify(vars)}` : k),
  }),
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate, useParams: () => ({ tagId: 'tag-1' }) };
});

const mockGetTagReportHistory = vi.fn();
vi.mock('../../../hooks/useApi', () => ({
  useApi: () => ({ getTagReportHistory: mockGetTagReportHistory }),
}));
vi.mock('../../../contexts/pageTitle', () => ({ useSetPageTitle: vi.fn() }));
vi.mock('../../../pages/insights/shared', () => ({
  GlassCard: ({ children, className }: React.ComponentProps<'div'>) => <div className={className}>{children}</div>,
}));

const mockUseTagReportTrail = vi.fn();
vi.mock('../../../hooks/useTagReport', () => ({
  useTagReportTrail: (...args: unknown[]) => mockUseTagReportTrail(...args),
}));

import { TagReportTrailPage } from '../../../pages/experience/TagReportTrailPage';

afterEach(cleanup);
beforeEach(() => {
  mockNavigate.mockReset();
  mockGetTagReportHistory.mockReset();
});

function renderPage() {
  return render(<MemoryRouter><TagReportTrailPage /></MemoryRouter>);
}

describe('TagReportTrailPage', () => {
  it('shows the "no runs" state when the tag has never generated a report', async () => {
    mockGetTagReportHistory.mockResolvedValue({ runs: [], total: 0 });
    mockUseTagReportTrail.mockReturnValue({ tagId: null, tagName: null, runs: [], sources: [], loading: false, error: null });

    renderPage();

    await waitFor(() => expect(screen.getByText('tagReport.trailPage.noRuns')).toBeInTheDocument());
  });

  it('renders run history and sources once resolved', async () => {
    mockGetTagReportHistory.mockResolvedValue({ runs: [{ run_id: 'run-1', run_mode: 'manual', trigger: 'manual', created_at: '2026-07-01T00:00:00Z', metric_tracks_narrated: 2 }], total: 1 });
    mockUseTagReportTrail.mockReturnValue({
      tagId: 'tag-1',
      tagName: 'Onboarding',
      runs: [{ run_id: 'run-1', run_mode: 'manual', trigger: 'manual', created_at: '2026-07-01T00:00:00Z', metric_tracks_narrated: 2 }],
      sources: [{
        id: 'src-1', run_id: 'run-1', survey_id: 's1', survey_title: 'Q1 Survey', checkpoint_id: 'c1',
        bracket_position: 'single', source_mode: 'latest', matched_checkpoint_window_start: null,
        matched_checkpoint_window_end: null, boundary_offset_interval: null, trend_eligible: true,
        response_count_at_generation: 50, exclusion_reason: null, created_at: '2026-07-01T00:00:00Z',
      }],
      loading: false,
      error: null,
    });

    renderPage();

    await waitFor(() => expect(mockGetTagReportHistory).toHaveBeenCalledWith('tag-1', { limit: 1 }));
    expect(screen.getByText('Q1 Survey')).toBeInTheDocument();
  });

  it('shows an error banner when the trail hook reports an error', async () => {
    mockGetTagReportHistory.mockResolvedValue({ runs: [{ run_id: 'run-1', run_mode: 'manual', trigger: 'manual', created_at: 't', metric_tracks_narrated: 0 }], total: 1 });
    mockUseTagReportTrail.mockReturnValue({ tagId: null, tagName: null, runs: [], sources: [], loading: false, error: 'boom' });

    renderPage();

    await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument());
  });
});
