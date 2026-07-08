import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Regression coverage for the "Uncategorized" bucket (added 2026-07-15):
// lib/topic_backfill.py flags a response ai_topics_pending when it can't be
// matched or clustered after real attempts. The Data page's Topics column
// must show a distinct "Uncategorized" badge for that state, not the plain
// "—" empty state used for a response that simply hasn't been tagged yet.

vi.mock('../../lib/i18n', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
vi.mock('framer-motion', () => ({
  motion: {
    div: (p: React.ComponentProps<'div'>) => React.createElement('div', p),
    span: (p: React.ComponentProps<'span'>) => React.createElement('span', p),
    tr: (p: React.ComponentProps<'tr'>) => React.createElement('tr', p),
  },
  AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../../contexts/pageTitle', () => ({ useSetPageTitle: vi.fn() }));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

const mockListSurveys  = vi.fn();
const mockGetSurvey    = vi.fn();
const mockGetResponses = vi.fn();
vi.mock('../../hooks/useApi', () => ({
  useApi: () => ({
    listSurveys:  mockListSurveys,
    getSurvey:    mockGetSurvey,
    getResponses: mockGetResponses,
  }),
}));

import { DataPage } from '../../pages/DataPage';

const SURVEY = { id: 's1', title: 'FIFA world cup reviews', questions: [] };

afterEach(cleanup);
beforeEach(() => {
  mockListSurveys.mockReset().mockResolvedValue({ surveys: [SURVEY] });
  mockGetSurvey.mockReset().mockResolvedValue({ survey: SURVEY });
  mockGetResponses.mockReset();
});

function renderPage() {
  return render(<MemoryRouter><DataPage /></MemoryRouter>);
}

function baseResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: 'r1', survey_id: 's1', org_id: 'o1', answers: [],
    submitted_at: '2026-07-01T00:00:00Z',
    ...overrides,
  };
}

describe('DataPage — Topics column', () => {
  it('renders real ai_topics as topic chips', async () => {
    mockGetResponses.mockResolvedValue({
      responses: [baseResponse({ ai_topics: ['Wait Time', 'Refunds'] })],
      total: 1,
    });

    renderPage();

    await waitFor(() => expect(screen.getByText('Wait Time')).toBeInTheDocument());
    expect(screen.getByText('Refunds')).toBeInTheDocument();
    expect(screen.queryByText('data.topicUncategorized')).not.toBeInTheDocument();
  });

  it('shows the "Uncategorized" badge for a response flagged ai_topics_pending with no real topics yet', async () => {
    mockGetResponses.mockResolvedValue({
      responses: [baseResponse({ ai_topics: null, ai_topics_pending: true })],
      total: 1,
    });

    renderPage();

    await waitFor(() => expect(screen.getByText('data.topicUncategorized')).toBeInTheDocument());
  });

  it('prefers a real topic over a stale ai_topics_pending flag', async () => {
    // A response that was flagged pending, then later successfully clustered
    // — ai_topics now has a real value. The badge must show the real topic,
    // not "Uncategorized", even if ai_topics_pending hasn't been cleared yet.
    mockGetResponses.mockResolvedValue({
      responses: [baseResponse({ ai_topics: ['Shipping Delays'], ai_topics_pending: true })],
      total: 1,
    });

    renderPage();

    await waitFor(() => expect(screen.getByText('Shipping Delays')).toBeInTheDocument());
    expect(screen.queryByText('data.topicUncategorized')).not.toBeInTheDocument();
  });

  it('falls back to the plain empty state for a response with no topics and not pending', async () => {
    mockGetResponses.mockResolvedValue({
      responses: [baseResponse({ ai_topics: null, ai_topics_pending: false })],
      total: 1,
    });

    renderPage();

    await waitFor(() => expect(mockGetResponses).toHaveBeenCalled());
    expect(screen.queryByText('data.topicUncategorized')).not.toBeInTheDocument();
  });
});
