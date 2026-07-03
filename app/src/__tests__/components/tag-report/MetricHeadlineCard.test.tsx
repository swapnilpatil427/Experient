import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../../lib/i18n', () => ({
  useTranslation: () => ({
    t: (k: string, vars?: Record<string, unknown>) => (vars ? `${k}:${JSON.stringify(vars)}` : k),
  }),
}));

vi.mock('../../../pages/insights/shared', () => ({
  GlassCard: ({ children, className, style }: React.ComponentProps<'div'>) => (
    <div className={className} style={style}>{children}</div>
  ),
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

import { MetricHeadlineCard } from '../../../components/tag-report/MetricHeadlineCard';
import type { TagReportMetricTrack } from '../../../types/tagReport';

afterEach(cleanup);
beforeEach(() => mockNavigate.mockReset());

function makeTrack(overrides: Partial<TagReportMetricTrack> = {}): TagReportMetricTrack {
  return {
    metric_key: 'nps',
    headline: 'NPS is trending up across 3 surveys',
    narrative: 'Detailed narrative text goes here.',
    trust_score: 82,
    eligible_survey_count: 3,
    agreement_count: 3,
    confidence_tier: 'high',
    merged_delta: 4.2,
    direction: 'up',
    single_survey_sourced: false,
    warnings: [],
    citations: [],
    ...overrides,
  };
}

describe('MetricHeadlineCard', () => {
  it('renders the metric label, headline, and narrative', () => {
    render(<MemoryRouter><MetricHeadlineCard track={makeTrack()} tagId="tag-1" /></MemoryRouter>);
    expect(screen.getByText('tagReport.metricCard.metricLabel.nps')).toBeInTheDocument();
    expect(screen.getByText('NPS is trending up across 3 surveys')).toBeInTheDocument();
    expect(screen.getByText('Detailed narrative text goes here.')).toBeInTheDocument();
  });

  it('shows the single-survey-sourced chip and name when the agreement floor is not met (R-T2/R-T2a)', () => {
    render(
      <MemoryRouter>
        <MetricHeadlineCard
          track={makeTrack({ single_survey_sourced: true, single_survey_name: 'Q1 Pulse', confidence_tier: 'insufficient' })}
          tagId="tag-1"
        />
      </MemoryRouter>
    );
    expect(screen.getByText('tagReport.metricCard.singleSurveySourced')).toBeInTheDocument();
    expect(screen.getByText('tagReport.metricCard.singleSurveyNamed:{"name":"Q1 Pulse"}')).toBeInTheDocument();
  });

  it('does not show single-survey chip when the agreement floor is met', () => {
    render(<MemoryRouter><MetricHeadlineCard track={makeTrack()} tagId="tag-1" /></MemoryRouter>);
    expect(screen.queryByText('tagReport.metricCard.singleSurveySourced')).not.toBeInTheDocument();
  });

  it('renders warning chips for comparability warnings', () => {
    render(
      <MemoryRouter>
        <MetricHeadlineCard
          track={makeTrack({ warnings: [{ scope: 'survey-1', warning_type: 'scale_mismatch', distortion_score: 0.6, confidence_tier: 'low', affected_survey_ids: ['s1'] }] })}
          tagId="tag-1"
        />
      </MemoryRouter>
    );
    expect(screen.getByText('scale_mismatch')).toBeInTheDocument();
  });

  it('renders a corroboration note when corroborated_with is present', () => {
    render(
      <MemoryRouter>
        <MetricHeadlineCard track={makeTrack({ corroborated_with: ['csat'] })} tagId="tag-1" />
      </MemoryRouter>
    );
    expect(screen.getByText(/tagReport\.metricCard\.corroboratedWith/)).toBeInTheDocument();
  });

  it('renders a clickable citation for citations with survey_id, and navigates to Response Detail on click', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <MetricHeadlineCard
          track={makeTrack({ citations: [{ survey_id: 'survey-1', response_id: 'resp-1', source_insight_id: 'ins-1', quote: 'Great!', sentiment: 'positive', relevance: 0.9 }] })}
          tagId="tag-1"
        />
      </MemoryRouter>
    );
    const citationBtn = screen.getByText('tagReport.citation.viewResponse');
    await user.click(citationBtn);
    expect(mockNavigate).toHaveBeenCalledWith('/app/surveys/survey-1/responses/resp-1');
  });

  it('renders a legacy citation missing survey_id as non-clickable plain text (Task 16 fallback)', () => {
    render(
      <MemoryRouter>
        <MetricHeadlineCard
          track={makeTrack({ citations: [{ survey_id: '', response_id: 'resp-2', source_insight_id: '', quote: 'Legacy quote', sentiment: 'neutral', relevance: 0.5 }] })}
          tagId="tag-1"
        />
      </MemoryRouter>
    );
    expect(screen.getByText('"Legacy quote"')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Legacy quote/ })).not.toBeInTheDocument();
  });

  it('navigates to the trail page when "View Full Audit Trail" is clicked', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><MetricHeadlineCard track={makeTrack()} tagId="tag-42" /></MemoryRouter>);
    await user.click(screen.getByText('tagReport.trailEntry.cta'));
    expect(mockNavigate).toHaveBeenCalledWith('/app/experience/tags/tag-42/report/trail');
  });

  it('applies an amber top-edge accent style when single_survey_sourced is true', () => {
    const { container } = render(
      <MemoryRouter><MetricHeadlineCard track={makeTrack({ single_survey_sourced: true })} tagId="tag-1" /></MemoryRouter>
    );
    const card = container.firstElementChild as HTMLElement;
    expect(card.getAttribute('style')).toContain('border-top');
  });
});
