import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('../../../lib/i18n', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

import { ReducedMotionStepper } from '../../../components/tag-report/ReducedMotionStepper';
import { deriveTagReportProgress } from '../../../lib/tagReportProgress';
import type { TagReportStreamEvent } from '../../../types/tagReport';

afterEach(cleanup);

function progressFrom(events: TagReportStreamEvent[]) {
  return deriveTagReportProgress(events);
}

describe('ReducedMotionStepper', () => {
  it('renders all 6 stage labels', () => {
    render(<ReducedMotionStepper progress={progressFrom([])} />);
    expect(screen.getByText('tagReport.stream.stageLabel.discovery')).toBeInTheDocument();
    expect(screen.getByText('tagReport.stream.stageLabel.checkpoint')).toBeInTheDocument();
    expect(screen.getByText('tagReport.stream.stageLabel.comparison')).toBeInTheDocument();
    expect(screen.getByText('tagReport.stream.stageLabel.gating')).toBeInTheDocument();
    expect(screen.getByText('tagReport.stream.stageLabel.merge')).toBeInTheDocument();
    expect(screen.getByText('tagReport.stream.stageLabel.narrative')).toBeInTheDocument();
  });

  it('shows the backfill note on the active stage when a backfill is in progress', () => {
    const progress = progressFrom([
      { ts: 't', run_id: 'r', event: 'survey_selected', survey_id: 's1', position: 0, title: 'S1', created_at: '2026-01-01' },
      { ts: 't', run_id: 'r', event: 'survey_excluded', survey_id: 's1', reason: 'no_checkpoint_in_range' },
    ]);
    render(<ReducedMotionStepper progress={progress} />);
    expect(screen.getByText('tagReport.stream.backfillNote')).toBeInTheDocument();
  });

  it('lists surveys with excluded ones struck-through and labeled with their reason', () => {
    const progress = progressFrom([
      { ts: 't', run_id: 'r', event: 'survey_selected', survey_id: 's1', position: 0, title: 'Included Survey', created_at: '2026-01-01' },
      { ts: 't', run_id: 'r', event: 'survey_excluded', survey_id: 's1', reason: 'excluded_by_recency_cap' },
    ]);
    render(<ReducedMotionStepper progress={progress} />);
    expect(screen.getByText('Included Survey')).toBeInTheDocument();
    expect(screen.getByText(/tagReport\.stream\.excludedReason\.excluded_by_recency_cap/)).toBeInTheDocument();
  });

  it('shows a backfill badge on surveys selected after the first exclusion', () => {
    const progress = progressFrom([
      { ts: 't', run_id: 'r', event: 'survey_selected', survey_id: 's1', position: 0, title: 'S1', created_at: '2026-01-01' },
      { ts: 't', run_id: 'r', event: 'survey_excluded', survey_id: 's1', reason: 'no_checkpoint_in_range' },
      { ts: 't', run_id: 'r', event: 'survey_selected', survey_id: 's2', position: 1, title: 'S2', created_at: '2026-01-02' },
    ]);
    render(<ReducedMotionStepper progress={progress} />);
    expect(screen.getByText('tagReport.stepper.backfillBadge')).toBeInTheDocument();
  });

  it('renders confidence tier per metric track once merge_resolved has fired', () => {
    const progress = progressFrom([
      { ts: 't', run_id: 'r', event: 'merge_resolved', metric_key: 'nps', merged_delta: 3, agreement_count: 2, confidence_tier: 'high' },
    ]);
    render(<ReducedMotionStepper progress={progress} />);
    expect(screen.getByText(/tagReport\.metricCard\.confidence\.high/)).toBeInTheDocument();
  });

  it('has an accessible label for the whole stepper region', () => {
    render(<ReducedMotionStepper progress={progressFrom([])} />);
    expect(screen.getByLabelText('tagReport.stepper.ariaLabel')).toBeInTheDocument();
  });
});
