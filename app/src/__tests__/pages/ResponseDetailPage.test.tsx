import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../lib/i18n', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate, useParams: () => ({ surveyId: 'survey-1', responseId: 'resp-1' }) };
});

const mockGetSurvey = vi.fn();
const mockGetSurveyResponse = vi.fn();
vi.mock('../../hooks/useApi', () => ({
  useApi: () => ({ getSurvey: mockGetSurvey, getSurveyResponse: mockGetSurveyResponse }),
}));
vi.mock('../../contexts/pageTitle', () => ({ useSetPageTitle: vi.fn() }));
vi.mock('../insights/shared', () => ({
  GlassCard: ({ children, className }: React.ComponentProps<'div'>) => <div className={className}>{children}</div>,
  SENTIMENT_BORDER: { positive: '#16a34a', negative: '#dc2626', neutral: '#94a3b8' },
}));

import { ResponseDetailPage } from '../../pages/ResponseDetailPage';

afterEach(cleanup);
beforeEach(() => {
  mockNavigate.mockReset();
  mockGetSurvey.mockReset();
  mockGetSurveyResponse.mockReset();
});

function renderPage() {
  return render(<MemoryRouter><ResponseDetailPage /></MemoryRouter>);
}

describe('ResponseDetailPage', () => {
  it('renders the response answers with question context once loaded', async () => {
    mockGetSurvey.mockResolvedValue({ survey: { id: 'survey-1', title: 'Q1 Survey', questions: [{ id: 'q1', type: 'open_text', question: 'How was your experience?', required: false }] } });
    mockGetSurveyResponse.mockResolvedValue({
      response: {
        id: 'resp-1', survey_id: 'survey-1', org_id: 'org-1',
        answers: [{ questionId: 'q1', value: 'It was great!' }],
        submitted_at: '2026-07-01T00:00:00Z',
        ai_sentiment: 'positive', ai_emotion: 'joy',
      },
    });

    renderPage();

    await waitFor(() => expect(screen.getByText('How was your experience?')).toBeInTheDocument());
    expect(screen.getByText('It was great!')).toBeInTheDocument();
  });

  it('shows the graceful "unavailable" state when the response cannot be found (soft-deleted or 404)', async () => {
    mockGetSurvey.mockResolvedValue({ survey: { id: 'survey-1', title: 'Q1 Survey', questions: [] } });
    mockGetSurveyResponse.mockResolvedValue(null);

    renderPage();

    await waitFor(() => expect(screen.getByText('tagReport.responseDetail.unavailable')).toBeInTheDocument());
  });

  it('provides a back-to-survey action from the unavailable state', async () => {
    mockGetSurvey.mockResolvedValue({ survey: { id: 'survey-1', title: 'Q1 Survey', questions: [] } });
    mockGetSurveyResponse.mockResolvedValue(null);

    renderPage();

    await waitFor(() => expect(screen.getByText('tagReport.responseDetail.backToSurvey')).toBeInTheDocument());
  });
});
