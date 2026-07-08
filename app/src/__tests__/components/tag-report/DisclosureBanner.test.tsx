import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../../lib/i18n', () => ({
  useTranslation: () => ({
    t: (k: string, vars?: Record<string, unknown>) => (vars ? `${k}:${JSON.stringify(vars)}` : k),
  }),
}));

vi.mock('framer-motion', () => ({
  motion: { div: (p: React.ComponentProps<'div'>) => <div {...p} /> },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../../../pages/insights/shared', () => ({
  GlassCard: ({ children, className, style }: React.ComponentProps<'div'>) => (
    <div className={className} style={style}>{children}</div>
  ),
}));

import { DisclosureBanner } from '../../../components/tag-report/DisclosureBanner';
import type { TagReportRunSource } from '../../../types/tagReport';

afterEach(cleanup);

function makeSource(overrides: Partial<TagReportRunSource> = {}): TagReportRunSource {
  return {
    id: 'src-1',
    run_id: 'run-1',
    survey_id: 'survey-1',
    survey_title: 'Onboarding Q1',
    checkpoint_id: 'ckpt-1',
    bracket_position: 'single',
    source_mode: 'latest',
    matched_checkpoint_window_start: null,
    matched_checkpoint_window_end: null,
    boundary_offset_interval: null,
    trend_eligible: true,
    response_count_at_generation: 120,
    exclusion_reason: null,
    created_at: '2026-07-01T00:00:00Z',
    ...overrides,
  };
}

describe('DisclosureBanner', () => {
  it('renders the collapsed summary line with examined/pool/included counts', () => {
    render(<DisclosureBanner poolSize={12} examinedCount={8} includedCount={5} backfillOccurred={false} sources={[]} />);
    expect(screen.getByText('tagReport.disclosure.examined:{"examined":8,"pool":12,"included":5}')).toBeInTheDocument();
  });

  it('does not show the backfill note when backfillOccurred is false', () => {
    render(<DisclosureBanner poolSize={12} examinedCount={8} includedCount={5} backfillOccurred={false} sources={[]} />);
    expect(screen.queryByText(/backfillNote/)).not.toBeInTheDocument();
  });

  it('shows the backfill note when backfillOccurred is true', () => {
    render(<DisclosureBanner poolSize={12} examinedCount={8} includedCount={5} backfillOccurred sources={[]} />);
    expect(screen.getByText(/tagReport\.disclosure\.backfillNote/)).toBeInTheDocument();
  });

  it('is collapsed by default — included/excluded lists are not shown', () => {
    render(
      <DisclosureBanner
        poolSize={2} examinedCount={2} includedCount={1} backfillOccurred={false}
        sources={[makeSource(), makeSource({ id: 'src-2', checkpoint_id: null, exclusion_reason: 'no_checkpoint_in_range' })]}
      />
    );
    expect(screen.queryByText('Onboarding Q1')).not.toBeInTheDocument();
  });

  it('expands to show included and excluded surveys on click', async () => {
    const user = userEvent.setup();
    render(
      <DisclosureBanner
        poolSize={2} examinedCount={2} includedCount={1} backfillOccurred={false}
        sources={[
          makeSource({ id: 'src-1', survey_title: 'Included Survey' }),
          makeSource({ id: 'src-2', survey_title: 'Excluded Survey', checkpoint_id: null, exclusion_reason: 'no_checkpoint_in_range' }),
        ]}
      />
    );

    await user.click(screen.getByRole('button', { expanded: false }));

    expect(screen.getByText('Included Survey')).toBeInTheDocument();
    expect(screen.getByText('Excluded Survey')).toBeInTheDocument();
    expect(screen.getByText('tagReport.stream.excludedReason.no_checkpoint_in_range')).toBeInTheDocument();
  });

  it('shows the "no exclusions" message when every source was included', async () => {
    const user = userEvent.setup();
    render(
      <DisclosureBanner poolSize={1} examinedCount={1} includedCount={1} backfillOccurred={false} sources={[makeSource()]} />
    );
    await user.click(screen.getByRole('button', { expanded: false }));
    expect(screen.getByText('tagReport.disclosure.noExclusions')).toBeInTheDocument();
  });

  it('flags an included-but-below-statistical-floor survey distinctly from a trend-eligible one (R-T1, regression test 2026-07-03)', async () => {
    // Regression test: this list previously rendered every included survey
    // identically regardless of trend_eligible, even though the raw field was
    // already available — a below-floor survey's numbers were shown, but with
    // no visual/textual distinction from a trend-eligible survey's.
    const user = userEvent.setup();
    render(
      <DisclosureBanner
        poolSize={2} examinedCount={2} includedCount={2} backfillOccurred={false}
        sources={[
          makeSource({ id: 'src-1', survey_title: 'Reliable Survey', trend_eligible: true }),
          makeSource({ id: 'src-2', survey_title: 'Thin Sample Survey', trend_eligible: false, response_count_at_generation: 4 }),
        ]}
      />
    );

    await user.click(screen.getByRole('button', { expanded: false }));

    const reliableRow = screen.getByText('Reliable Survey').closest('li')!;
    const thinRow = screen.getByText('Thin Sample Survey').closest('li')!;
    expect(reliableRow.textContent).not.toMatch(/belowStatFloor/);
    expect(thinRow.textContent).toMatch(/tagReport\.disclosure\.belowStatFloor/);
  });
});
