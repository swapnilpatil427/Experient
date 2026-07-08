import { describe, it, expect } from 'vitest';
import { deriveTagReportProgress } from '../../lib/tagReportProgress';
import type { TagReportStreamEvent } from '../../types/tagReport';

function evt<T extends TagReportStreamEvent>(partial: T): T {
  return { ts: '2026-07-02T00:00:00Z', run_id: 'run-1', ...partial };
}

describe('deriveTagReportProgress', () => {
  it('returns the discovery stage with no surveys for an empty event list', () => {
    const progress = deriveTagReportProgress([]);
    expect(progress.stage).toBe('discovery');
    expect(progress.stageIndex).toBe(0);
    expect(progress.surveys).toEqual([]);
    expect(progress.done).toBe(false);
    expect(progress.failed).toBe(false);
  });

  it('captures target_n/ceiling_n from run_started', () => {
    const progress = deriveTagReportProgress([
      evt({ event: 'run_started', tag_id: 't1', report_mode: 'manual', target_n: 5, ceiling_n: 20 }),
    ]);
    expect(progress.targetN).toBe(5);
    expect(progress.ceilingN).toBe(20);
  });

  it('adds a survey node on survey_selected and advances stage to discovery', () => {
    const progress = deriveTagReportProgress([
      evt({ event: 'survey_selected', survey_id: 's1', position: 0, title: 'NPS Q1', created_at: '2026-01-01' }),
    ]);
    expect(progress.surveys).toHaveLength(1);
    expect(progress.surveys[0]).toMatchObject({ survey_id: 's1', title: 'NPS Q1', selected: true, excluded: false, isBackfill: false });
    expect(progress.stage).toBe('discovery');
  });

  it('records checkpoint_resolved onto the matching survey node and advances to checkpoint stage', () => {
    const progress = deriveTagReportProgress([
      evt({ event: 'survey_selected', survey_id: 's1', position: 0, title: 'NPS Q1', created_at: '2026-01-01' }),
      evt({ event: 'checkpoint_resolved', survey_id: 's1', bracket_position: 'single', checkpoint_date: '2026-01-05', offset_days: -3 }),
    ]);
    expect(progress.stage).toBe('checkpoint');
    expect(progress.surveys[0].checkpoints.single).toEqual({ date: '2026-01-05', offsetDays: -3 });
  });

  it('marks surveys selected after the first exclusion as backfill', () => {
    const progress = deriveTagReportProgress([
      evt({ event: 'survey_selected', survey_id: 's1', position: 0, title: 'Survey 1', created_at: '2026-01-01' }),
      evt({ event: 'survey_excluded', survey_id: 's1', reason: 'no_checkpoint_in_range' }),
      evt({ event: 'survey_selected', survey_id: 's2', position: 1, title: 'Survey 2', created_at: '2026-01-02' }),
    ]);
    const s1 = progress.surveys.find((s) => s.survey_id === 's1')!;
    const s2 = progress.surveys.find((s) => s.survey_id === 's2')!;
    expect(s1.excluded).toBe(true);
    expect(s1.excludedReason).toBe('no_checkpoint_in_range');
    expect(s1.isBackfill).toBe(false);
    expect(s2.isBackfill).toBe(true);
    expect(progress.backfillActive).toBe(true);
  });

  it('creates a placeholder survey node if survey_excluded fires without a prior survey_selected', () => {
    const progress = deriveTagReportProgress([
      evt({ event: 'survey_excluded', survey_id: 's9', reason: 'excluded_by_recency_cap', detail: 'too old' }),
    ]);
    expect(progress.surveys).toHaveLength(1);
    expect(progress.surveys[0]).toMatchObject({ survey_id: 's9', excluded: true, excludedReason: 'excluded_by_recency_cap', excludedDetail: 'too old' });
  });

  it('captures the loop_stop_reason from batch_loop_resolved', () => {
    const progress = deriveTagReportProgress([
      evt({ event: 'batch_loop_resolved', included_count: 5, target_n: 5, loop_stop_reason: 'target_reached' }),
    ]);
    expect(progress.loopStopReason).toBe('target_reached');
  });

  it('builds a metric track from metric_track_gated and flags eligible surveys trend-eligible', () => {
    const progress = deriveTagReportProgress([
      evt({ event: 'survey_selected', survey_id: 's1', position: 0, title: 'S1', created_at: '2026-01-01' }),
      evt({ event: 'metric_track_gated', metric_key: 'nps', eligible_survey_ids: ['s1'], excluded_survey_ids: ['s2'] }),
    ]);
    expect(progress.metricTracks.nps?.eligibleSurveyIds).toEqual(['s1']);
    expect(progress.metricTracks.nps?.excludedSurveyIds).toEqual(['s2']);
    expect(progress.surveys.find((s) => s.survey_id === 's1')?.trendEligible).toBe(true);
  });

  it('accumulates merge_vote entries per metric_key and captures merge_resolved outcome', () => {
    const progress = deriveTagReportProgress([
      evt({ event: 'merge_vote', metric_key: 'nps', survey_id: 's1', weight: 0.6, trust_score: 90, response_count: 120, delta_value: 4 }),
      evt({ event: 'merge_vote', metric_key: 'nps', survey_id: 's2', weight: 0.4, trust_score: 70, response_count: 80, delta_value: 2 }),
      evt({ event: 'merge_resolved', metric_key: 'nps', merged_delta: 3.2, agreement_count: 2, confidence_tier: 'high' }),
    ]);
    const track = progress.metricTracks.nps!;
    expect(track.votes).toHaveLength(2);
    expect(track.mergedDelta).toBe(3.2);
    expect(track.agreementCount).toBe(2);
    expect(track.confidenceTier).toBe('high');
    expect(progress.stage).toBe('merge');
  });

  it('captures corroboration_detected events', () => {
    const progress = deriveTagReportProgress([
      evt({ event: 'corroboration_detected', tracks: ['nps', 'csat'], direction: 'up', overlap_surveys: ['s1'], window_overlap_pct: 80 }),
    ]);
    expect(progress.corroborations).toEqual([{ tracks: ['nps', 'csat'], direction: 'up' }]);
  });

  it('records narration_started and narration_complete onto the same track', () => {
    const progress = deriveTagReportProgress([
      evt({ event: 'narration_started', metric_key: 'csat' }),
      evt({ event: 'narration_complete', metric_key: 'csat', headline: 'CSAT is up', confidence: 'medium' }),
    ]);
    const track = progress.metricTracks.csat!;
    expect(track.narrationStarted).toBe(true);
    expect(track.headline).toBe('CSAT is up');
    expect(progress.stage).toBe('narrative');
  });

  it('sets done=true and llmCallCount on run_complete', () => {
    const progress = deriveTagReportProgress([
      evt({ event: 'run_complete', metric_tracks_narrated: 2, llm_call_count: 2, total_surveys_scanned: 8, total_surveys_included: 5, duration_ms: 900 }),
    ]);
    expect(progress.done).toBe(true);
    expect(progress.llmCallCount).toBe(2);
    expect(progress.backfillActive).toBe(false); // done overrides backfillActive
  });

  it('sets failed=true and errorMessage on run_failed', () => {
    const progress = deriveTagReportProgress([
      evt({ event: 'run_failed', node: 'resolve_and_gate_batch', error: 'DB timeout' }),
    ]);
    expect(progress.failed).toBe(true);
    expect(progress.errorMessage).toBe('DB timeout');
  });

  it('sorts surveys by their stable `position` field regardless of event order', () => {
    const progress = deriveTagReportProgress([
      evt({ event: 'survey_selected', survey_id: 's2', position: 1, title: 'Second', created_at: '2026-01-02' }),
      evt({ event: 'survey_selected', survey_id: 's1', position: 0, title: 'First', created_at: '2026-01-01' }),
    ]);
    expect(progress.surveys.map((s) => s.survey_id)).toEqual(['s1', 's2']);
  });

  it('never mutates merged_metric_deltas when corroboration_detected fires (annotation only)', () => {
    const progress = deriveTagReportProgress([
      evt({ event: 'merge_resolved', metric_key: 'nps', merged_delta: 5, agreement_count: 3, confidence_tier: 'high' }),
      evt({ event: 'corroboration_detected', tracks: ['nps', 'ces'], direction: 'up', overlap_surveys: [], window_overlap_pct: 50 }),
    ]);
    expect(progress.metricTracks.nps?.mergedDelta).toBe(5);
  });
});
