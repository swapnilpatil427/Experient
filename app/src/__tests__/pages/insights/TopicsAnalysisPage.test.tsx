import { render, screen, act, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Stable mock refs ──────────────────────────────────────────────────────────

const { mockT, mockOpenCrystal, mockSetCrystalCtx } = vi.hoisted(() => ({
  mockT:            vi.fn((k: string, vars?: Record<string, unknown>) => (vars ? `${k}:${JSON.stringify(vars)}` : k)),
  mockOpenCrystal:  vi.fn(),
  mockSetCrystalCtx: vi.fn(),
}));

// ── Mocks (must precede page import) ─────────────────────────────────────────

vi.mock('../../../hooks/useApi',     () => ({ useApi:     vi.fn() }));
vi.mock('../../../hooks/useSurveys', () => ({ useSurveys: vi.fn() }));
vi.mock('../../../contexts/crystalPanel', () => ({
  useCrystalPanel: () => ({ openCrystal: mockOpenCrystal, setCrystalCtx: mockSetCrystalCtx }),
}));
vi.mock('../../../contexts/pageTitle', () => ({ useSetPageTitle: vi.fn() }));
vi.mock('../../../lib/i18n', () => ({ useTranslation: () => ({ t: mockT }) }));
vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, ...p }: React.HTMLAttributes<HTMLDivElement>) => <div {...p}>{children}</div>,
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../../../components/PageHeader', () => ({
  PageHeader: ({ actions }: { actions?: React.ReactNode }) => <div data-testid="page-header">{actions}</div>,
}));
vi.mock('../../../components/SurveyScopePicker', () => ({ SurveyScopePicker: () => <div /> }));
vi.mock('../../../pages/insights/components/TopicHierarchyTree', () => ({
  TopicHierarchyTree: () => <div data-testid="hierarchy-tree" />,
}));
vi.mock('../../../pages/insights/components/TopicDetailPanel', () => ({
  TopicDetailPanel: () => <div data-testid="topic-detail" />,
}));
vi.mock('../../../pages/insights/components/ImpactScatterChart', () => ({
  ImpactScatterChart: () => <div data-testid="scatter-chart" />,
}));

import { useApi }     from '../../../hooks/useApi';
import { useSurveys } from '../../../hooks/useSurveys';
import { ManualRunError } from '../../../lib/api';
import { TopicsAnalysisPage } from '../../../pages/insights/TopicsAnalysisPage';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SURVEY = { id: 's1', title: 'Q1 NPS', status: 'active' as const, response_count: 5000 };

function buildApi(overrides: Record<string, unknown> = {}) {
  return {
    getTopicHierarchy:        vi.fn().mockResolvedValue({ themes: [] }),
    triggerInsightGeneration: vi.fn().mockResolvedValue({}),
    getActiveTopicBackfillRun: vi.fn().mockResolvedValue(null),
    triggerTopicBackfill:      vi.fn().mockResolvedValue({ run_id: 'run-1', status: 'started' }),
    getRun:                    vi.fn().mockResolvedValue({ id: 'run-1', status: 'running', stream_events: [] }),
    ...overrides,
  };
}

function setupMocks(apiOverrides: Record<string, unknown> = {}) {
  const api = buildApi(apiOverrides);
  vi.mocked(useApi).mockReturnValue(api as unknown as ReturnType<typeof useApi>);
  vi.mocked(useSurveys).mockReturnValue({ surveys: [SURVEY] } as unknown as ReturnType<typeof useSurveys>);
  return api;
}

function renderPage(query = '?survey=s1') {
  return render(
    <MemoryRouter initialEntries={[`/app/insights/topics${query}`]}>
      <TopicsAnalysisPage />
    </MemoryRouter>,
  );
}

function backfillButton() {
  return screen.getByTitle('topicsAnalysis.backfillTaggingHint');
}

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('TopicsAnalysisPage — Backfill Tagging', () => {
  it('renders the backfill button in idle state and starts a job on click', async () => {
    const api = setupMocks();
    renderPage();

    await act(async () => { await Promise.resolve(); });

    const btn = backfillButton();
    expect(btn).toBeInTheDocument();

    await act(async () => { fireEvent.click(btn); });

    expect(api.triggerTopicBackfill).toHaveBeenCalledWith('s1');
    expect(btn).toBeDisabled();
  });

  it('resumes an already-running backfill job on mount instead of starting a new one', async () => {
    const api = setupMocks({ getActiveTopicBackfillRun: vi.fn().mockResolvedValue('existing-run') });
    renderPage();

    await act(async () => { await Promise.resolve(); });

    expect(api.getActiveTopicBackfillRun).toHaveBeenCalledWith('s1');
    expect(backfillButton()).toBeDisabled();
    expect(api.triggerTopicBackfill).not.toHaveBeenCalled();
  });

  it('polls progress and reloads the hierarchy once the job completes', async () => {
    let pollCount = 0;
    const api = setupMocks({
      getRun: vi.fn().mockImplementation(async () => {
        pollCount += 1;
        if (pollCount === 1) {
          return {
            id: 'run-1', status: 'running',
            stream_events: [{ event: 'backfill_progress', data: { total_untagged: 100, processed: 40 } }],
          };
        }
        return {
          id: 'run-1', status: 'completed',
          stream_events: [{ event: 'backfill_progress', data: { total_untagged: 100, processed: 100 } }],
        };
      }),
    });
    renderPage();

    await act(async () => { await Promise.resolve(); });
    await act(async () => { fireEvent.click(backfillButton()); });
    await act(async () => { await Promise.resolve(); }); // first poll fires immediately

    expect(api.getRun).toHaveBeenCalledWith('run-1');
    expect(api.getTopicHierarchy).toHaveBeenCalledTimes(1); // initial load only so far

    await act(async () => { await vi.advanceTimersByTimeAsync(3000); }); // second poll → completed

    expect(api.getTopicHierarchy).toHaveBeenCalledTimes(2); // reloaded after completion
  });

  it('surfaces the already-running message on a 429 from the trigger call', async () => {
    const api = setupMocks({
      triggerTopicBackfill: vi.fn().mockRejectedValue(new ManualRunError('RATE_LIMITED', 'busy', 429)),
    });
    renderPage();

    await act(async () => { await Promise.resolve(); });
    await act(async () => { fireEvent.click(backfillButton()); });

    expect(api.triggerTopicBackfill).toHaveBeenCalled();
    // Button resets to clickable after a failure (not stuck disabled forever).
    await waitFor(() => expect(backfillButton()).not.toBeDisabled());
  });

  it('honestly surfaces quarantined responses instead of a flat "complete" message', async () => {
    // Regression test (2026-07-13, independent review finding): reporting
    // "complete" while silently omitting responses that were permanently
    // quarantined after repeated failures would let a customer trust topic
    // data that's missing real responses with no visible signal.
    const api = setupMocks({
      getRun: vi.fn().mockResolvedValue({
        id: 'run-1', status: 'completed',
        stream_events: [{ event: 'backfill_progress', data: { total_untagged: 100, processed: 95, quarantined: 5 } }],
      }),
    });
    renderPage();

    await act(async () => { await Promise.resolve(); });
    await act(async () => { fireEvent.click(backfillButton()); });
    await act(async () => { await Promise.resolve(); });

    expect(mockT).toHaveBeenCalledWith(
      'topicsAnalysis.backfillCompleteWithQuarantine',
      expect.objectContaining({ processed: 95, quarantined: 5 }),
    );
  });

  it('does nothing when no survey is selected', async () => {
    const api = setupMocks();
    renderPage('');

    await act(async () => { await Promise.resolve(); });

    expect(api.getActiveTopicBackfillRun).not.toHaveBeenCalled();
  });
});
