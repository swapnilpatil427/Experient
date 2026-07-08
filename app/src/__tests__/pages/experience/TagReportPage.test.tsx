import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
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
  return { ...actual, useNavigate: () => mockNavigate, useParams: () => ({ tagId: 'tag-1', runId: mockRunIdParam.value }) };
});

const mockRunIdParam: { value: string | undefined } = { value: 'run-1' };

vi.mock('../../../hooks/useApi', () => ({
  useApi: () => ({ getTagSurveys: vi.fn().mockResolvedValue({ tag: { id: 'tag-1', name: 'Onboarding' }, surveys: [] }) }),
}));

vi.mock('../../../contexts/pageTitle', () => ({ useSetPageTitle: vi.fn() }));
const mockSetCrystalCtx = vi.fn();
vi.mock('../../../contexts/crystalPanel', () => ({ useCrystalPanel: () => ({ setCrystalCtx: mockSetCrystalCtx }) }));

vi.mock('../../../components/tag-report/PipelineVisualization', () => ({
  PipelineVisualization: ({ collapsed }: { collapsed?: boolean }) => <div data-testid="viz" data-collapsed={String(collapsed)} />,
}));
vi.mock('../../../components/tag-report/DisclosureBanner', () => ({
  DisclosureBanner: () => <div data-testid="disclosure-banner" />,
}));
vi.mock('../../../components/tag-report/MetricHeadlineCard', () => ({
  MetricHeadlineCard: ({ track }: { track: { metric_key: string } }) => <div data-testid={`metric-${track.metric_key}`} />,
}));
vi.mock('../../../components/tag-report/ComparisonWaveCard', () => ({
  ComparisonWaveCard: ({ track }: { track: { metric_key: string } }) => <div data-testid={`comparison-${track.metric_key}`} />,
}));
vi.mock('../../../components/tag-report/TrailEntryPoint', () => ({
  TrailEntryPoint: () => <div data-testid="trail-entry" />,
}));
vi.mock('../../../components/tag-report/InFlightRunBanner', () => ({
  InFlightRunBanner: () => <div data-testid="inflight-banner" />,
}));

const mockUseTagReport = vi.fn();
vi.mock('../../../hooks/useTagReport', () => ({ useTagReport: (...args: unknown[]) => mockUseTagReport(...args) }));

import { TagReportPage } from '../../../pages/experience/TagReportPage';

afterEach(cleanup);

function baseHookState(overrides: Record<string, unknown> = {}) {
  return {
    run: null,
    metricTracks: [],
    sources: [],
    poolSize: 0,
    examinedCount: 0,
    includedCount: 0,
    backfillOccurred: false,
    loading: false,
    error: null,
    inFlightNotice: null,
    dismissInFlightNotice: vi.fn(),
    reload: vi.fn(),
    generate: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  mockNavigate.mockReset();
  mockRunIdParam.value = 'run-1';
  mockSetCrystalCtx.mockReset();
});

function renderPage() {
  return render(<MemoryRouter><TagReportPage /></MemoryRouter>);
}

/** Renders with an initial router entry carrying navigation `state` — mirrors
 * how TagReportNewPage forwards inFlightNotice via `navigate(path, {state})`
 * after a fresh generate() call (fixed 2026-07-03). */
function renderPageWithLocationState(state: unknown) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: '/app/experience/tags/tag-1/report/run-1', state }]}>
      <TagReportPage />
    </MemoryRouter>,
  );
}

describe('TagReportPage', () => {
  it('shows a loading spinner while the run resolves', () => {
    mockUseTagReport.mockReturnValue(baseHookState({ loading: true }));
    const { container } = renderPage();
    expect(container.querySelector('.animate-spin')).toBeInTheDocument();
  });

  it('shows an error banner when the hook reports an error', () => {
    mockUseTagReport.mockReturnValue(baseHookState({ error: 'network down' }));
    renderPage();
    expect(screen.getByText('network down')).toBeInTheDocument();
  });

  it('shows a "generate a report" CTA when no run exists for the tag', () => {
    mockUseTagReport.mockReturnValue(baseHookState({ run: null }));
    renderPage();
    expect(screen.getByText('tagReport.new.noRunsYet')).toBeInTheDocument();
    expect(screen.getByText('tagReport.new.manualCta')).toBeInTheDocument();
  });

  it('clicking the CTA navigates to TAG_REPORT_NEW', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    mockUseTagReport.mockReturnValue(baseHookState({ run: null }));
    renderPage();
    await userEvent.setup().click(screen.getByText('tagReport.new.manualCta'));
    expect(mockNavigate).toHaveBeenCalledWith('/app/experience/tags/tag-1/report/new');
  });

  it('renders the pipeline visualization expanded (not collapsed) while streaming', () => {
    mockUseTagReport.mockReturnValue(baseHookState({
      run: { id: 'run-1', status: 'running', run_mode: 'manual', stream_events: [], trigger: 'manual', created_at: 't' },
    }));
    renderPage();
    expect(screen.getByTestId('viz')).toHaveAttribute('data-collapsed', 'false');
    // Report content is not shown while streaming
    expect(screen.queryByTestId('disclosure-banner')).not.toBeInTheDocument();
  });

  it('renders the full report (collapsed viz + disclosure + metric cards + trail) once completed', () => {
    mockUseTagReport.mockReturnValue(baseHookState({
      run: { id: 'run-1', status: 'completed', run_mode: 'manual', stream_events: [], trigger: 'manual', created_at: 't' },
      metricTracks: [{ metric_key: 'nps', single_survey_sourced: false }, { metric_key: 'csat', single_survey_sourced: false }],
    }));
    renderPage();
    expect(screen.getByTestId('viz')).toHaveAttribute('data-collapsed', 'true');
    expect(screen.getByTestId('disclosure-banner')).toBeInTheDocument();
    expect(screen.getByTestId('metric-nps')).toBeInTheDocument();
    expect(screen.getByTestId('metric-csat')).toBeInTheDocument();
    expect(screen.getByTestId('trail-entry')).toBeInTheDocument();
    // Manual mode — no comparison cards
    expect(screen.queryByTestId('comparison-nps')).not.toBeInTheDocument();
  });

  it('sets the page title/H1 to the Tag Report string, not the borrowed Group Report one (regression test, 2026-07-03)', async () => {
    const { useSetPageTitle } = await import('../../../contexts/pageTitle');
    mockUseTagReport.mockReturnValue(baseHookState({
      run: { id: 'run-1', status: 'completed', run_mode: 'manual', stream_events: [], trigger: 'manual', created_at: 't' },
      metricTracks: [{ metric_key: 'nps', single_survey_sourced: false }],
    }));
    renderPage();
    await waitFor(() => {
      expect(useSetPageTitle).toHaveBeenCalledWith('tagReport.page.title:{"name":"Onboarding"}');
    });
    expect(useSetPageTitle).not.toHaveBeenCalledWith(expect.stringContaining('groups.groupReportTitle'));
    await waitFor(() => {
      expect(screen.getByText('tagReport.page.title:{"name":"Onboarding"}')).toBeInTheDocument();
    });
    expect(screen.queryByText(/groups\.groupReportTitle/)).not.toBeInTheDocument();
  });

  it('renders comparison cards only for custom_range mode', () => {
    mockUseTagReport.mockReturnValue(baseHookState({
      run: { id: 'run-1', status: 'completed', run_mode: 'custom_range', stream_events: [], trigger: 'manual', created_at: 't' },
      metricTracks: [{ metric_key: 'nps', single_survey_sourced: false }],
    }));
    renderPage();
    expect(screen.getByTestId('comparison-nps')).toBeInTheDocument();
  });

  it('sorts single-survey-sourced metric tracks first (R-T2a prominence rule)', () => {
    mockUseTagReport.mockReturnValue(baseHookState({
      run: { id: 'run-1', status: 'completed', run_mode: 'manual', stream_events: [], trigger: 'manual', created_at: 't' },
      metricTracks: [
        { metric_key: 'nps', single_survey_sourced: false },
        { metric_key: 'ces', single_survey_sourced: true },
      ],
    }));
    const { container } = renderPage();
    const testIds = Array.from(container.querySelectorAll('[data-testid^="metric-"]')).map((el) => el.getAttribute('data-testid'));
    expect(testIds).toEqual(['metric-ces', 'metric-nps']);
  });

  it('shows the in-flight banner when the hook reports one', () => {
    mockUseTagReport.mockReturnValue(baseHookState({
      run: { id: 'run-1', status: 'completed', run_mode: 'manual', stream_events: [], trigger: 'manual', created_at: 't' },
      inFlightNotice: { startedAt: 't', trigger: 'manual' },
    }));
    renderPage();
    expect(screen.getByTestId('inflight-banner')).toBeInTheDocument();
  });

  it('shows the in-flight banner from router navigation state even when the hook itself reports none (regression test, 2026-07-03 — fixes "InFlightRunBanner unreachable": TagReportNewPage\'s hook instance is discarded on navigation, so this page must be able to learn about an in-flight run purely from the navigation state TagReportNewPage forwarded)', () => {
    mockUseTagReport.mockReturnValue(baseHookState({
      run: { id: 'run-1', status: 'completed', run_mode: 'manual', stream_events: [], trigger: 'manual', created_at: 't' },
      inFlightNotice: null, // this page's OWN hook instance never called generate() — always null
    }));
    renderPageWithLocationState({ inFlightNotice: { startedAt: '2026-07-03T00:00:00Z', trigger: 'manual' } });
    expect(screen.getByTestId('inflight-banner')).toBeInTheDocument();
  });

  it('shows no in-flight banner on a normal page visit with no navigation state (not every visit should show a stale banner)', () => {
    mockUseTagReport.mockReturnValue(baseHookState({
      run: { id: 'run-1', status: 'completed', run_mode: 'manual', stream_events: [], trigger: 'manual', created_at: 't' },
      inFlightNotice: null,
    }));
    renderPage(); // no location state at all
    expect(screen.queryByTestId('inflight-banner')).not.toBeInTheDocument();
  });

  it('shows a failure banner and suppresses report content when the run failed', () => {
    mockUseTagReport.mockReturnValue(baseHookState({
      run: {
        id: 'run-1', status: 'failed', run_mode: 'manual', trigger: 'manual', created_at: 't',
        stream_events: [{ ts: 't', run_id: 'run-1', event: 'run_failed', node: 'resolve_and_gate_batch', error: 'DB timeout' }],
      },
    }));
    renderPage();
    expect(screen.getByText('DB timeout')).toBeInTheDocument();
    expect(screen.queryByTestId('disclosure-banner')).not.toBeInTheDocument();
  });

  it('canonicalizes the URL from TAG_REPORT_LATEST to the resolved run id', () => {
    mockRunIdParam.value = undefined;
    mockUseTagReport.mockReturnValue(baseHookState({
      run: { id: 'run-resolved', status: 'completed', run_mode: 'manual', stream_events: [], trigger: 'manual', created_at: 't' },
    }));
    renderPage();
    expect(mockNavigate).toHaveBeenCalledWith('/app/experience/tags/tag-1/report/run-resolved', { replace: true });
  });

  describe('Crystal auto-scoping', () => {
    it('scopes Crystal to this tag via setCrystalCtx (not setScope) on mount, then again once the tag name resolves', async () => {
      mockUseTagReport.mockReturnValue(baseHookState({ run: null }));
      renderPage();

      // Fires immediately with the tag id (name not yet resolved).
      expect(mockSetCrystalCtx).toHaveBeenCalledWith({ focused_tag_id: 'tag-1', focused_tag_name: undefined });

      // Fires again once getTagSurveys resolves the tag's display name.
      await waitFor(() => {
        expect(mockSetCrystalCtx).toHaveBeenCalledWith({ focused_tag_id: 'tag-1', focused_tag_name: 'Onboarding' });
      });
    });

    it('clears crystalCtx on unmount so leaving the tag page drops Crystal focus', async () => {
      mockUseTagReport.mockReturnValue(baseHookState({ run: null }));
      const { unmount } = renderPage();

      await waitFor(() => {
        expect(mockSetCrystalCtx).toHaveBeenCalledWith({ focused_tag_id: 'tag-1', focused_tag_name: 'Onboarding' });
      });

      mockSetCrystalCtx.mockClear();
      unmount();
      expect(mockSetCrystalCtx).toHaveBeenCalledWith({});
    });
  });
});
