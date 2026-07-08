import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../../lib/i18n', () => ({
  useTranslation: () => ({
    t: (k: string, vars?: Record<string, unknown>) => (vars ? `${k}:${JSON.stringify(vars)}` : k),
  }),
}));

vi.mock('../../../pages/insights/shared', () => ({
  GlassCard: ({ children, className }: React.ComponentProps<'div'>) => <div className={className}>{children}</div>,
}));

vi.mock('recharts', () => ({
  LineChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Line: () => <div data-testid="line" />,
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  YAxis: () => <div />,
}));

import { ComparisonWaveCard } from '../../../components/tag-report/ComparisonWaveCard';
import type { TagReportMetricTrack } from '../../../types/tagReport';

afterEach(cleanup);

function makeTrack(overrides: Partial<TagReportMetricTrack> = {}): TagReportMetricTrack {
  return {
    metric_key: 'nps',
    headline: 'headline',
    narrative: 'narrative',
    trust_score: 80,
    eligible_survey_count: 2,
    agreement_count: 2,
    confidence_tier: 'high',
    merged_delta: 5,
    direction: 'up',
    single_survey_sourced: false,
    warnings: [],
    citations: [],
    ...overrides,
  };
}

describe('ComparisonWaveCard', () => {
  it('renders the merged delta badge when a comparison exists', () => {
    render(<ComparisonWaveCard track={makeTrack({ merged_delta: 4.2 })} />);
    expect(screen.getByText('+4.2')).toBeInTheDocument();
    expect(screen.getByTestId('comparison-sparkline')).toBeInTheDocument();
  });

  it('renders "no comparison available" and skips the sparkline for the degenerate bracket case (R-C1)', () => {
    render(<ComparisonWaveCard track={makeTrack({ merged_delta: null })} />);
    expect(screen.getByText('tagReport.comparisonCard.noComparisonAvailable')).toBeInTheDocument();
    expect(screen.queryByTestId('comparison-sparkline')).not.toBeInTheDocument();
  });

  it('shows the per-survey breakdown toggle only when survey_breakdown data exists', () => {
    render(<ComparisonWaveCard track={makeTrack({ survey_breakdown: undefined })} />);
    expect(screen.queryByText('tagReport.comparisonCard.perSurveyBreakdown')).not.toBeInTheDocument();
  });

  it('expands the per-survey breakdown, sorted highest-trust-first', async () => {
    const user = userEvent.setup();
    render(
      <ComparisonWaveCard
        track={makeTrack({
          survey_breakdown: [
            { survey_id: 's1', survey_title: 'Low Trust', trust_score: 40, delta: 1, no_comparison_available: false },
            { survey_id: 's2', survey_title: 'High Trust', trust_score: 95, delta: 6, no_comparison_available: false },
          ],
        })}
      />
    );
    await user.click(screen.getByText('tagReport.comparisonCard.perSurveyBreakdown'));
    const items = screen.getAllByText(/Trust$/);
    expect(items[0]).toHaveTextContent('High Trust');
    expect(items[1]).toHaveTextContent('Low Trust');
  });

  it('shows "no comparison available" per-survey when that survey has no second data point', async () => {
    const user = userEvent.setup();
    render(
      <ComparisonWaveCard
        track={makeTrack({
          survey_breakdown: [
            { survey_id: 's1', survey_title: 'Flat Survey', trust_score: 70, delta: null, no_comparison_available: true },
          ],
        })}
      />
    );
    await user.click(screen.getByText('tagReport.comparisonCard.perSurveyBreakdown'));
    // one instance for the card-level state, one for the per-survey row
    expect(screen.getAllByText('tagReport.comparisonCard.noComparisonAvailable').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Flat Survey')).toBeInTheDocument();
  });
});
