// Derives a renderable "progress" snapshot from a Tag Report run's
// `stream_events` array (docs/tag-report/TRACKER.md §2 streaming event
// contract). This is the single source of truth consumed by BOTH the
// Three.js pipeline visualization and its `prefers-reduced-motion` text
// fallback, so the two surfaces can never drift out of sync and so this
// logic is unit-testable without touching WebGL/canvas at all.

import type {
  TagReportStreamEvent, TagReportStage, MetricKey, BracketPosition,
  ExclusionReason, ConfidenceTier, TrendDirection,
} from '../types/tagReport';
import { TAG_REPORT_STAGES } from '../types/tagReport';

const EVENT_STAGE: Record<TagReportStreamEvent['event'], TagReportStage> = {
  run_started: 'discovery',
  batch_fetched: 'discovery',
  survey_selected: 'discovery',
  checkpoint_resolved: 'checkpoint',
  survey_excluded: 'gating',
  batch_loop_resolved: 'gating',
  bracket_delta_computed: 'comparison',
  metric_track_gated: 'gating',
  merge_vote: 'merge',
  merge_resolved: 'merge',
  corroboration_detected: 'merge',
  comparability_warning: 'gating',
  narration_started: 'narrative',
  narration_complete: 'narrative',
  citations_merged: 'narrative',
  run_complete: 'narrative',
  run_failed: 'narrative',
};

export interface SurveyNodeState {
  survey_id: string;
  title: string;
  position: number;
  selected: boolean;
  excluded: boolean;
  excludedReason?: ExclusionReason | string;
  excludedDetail?: string;
  isBackfill: boolean;
  checkpoints: Partial<Record<BracketPosition, { date: string; offsetDays: number }>>;
  trendEligible?: boolean;
}

export interface MetricTrackProgress {
  metric_key: MetricKey;
  eligibleSurveyIds: string[];
  excludedSurveyIds: string[];
  votes: Array<{ survey_id: string; weight: number; trust_score: number; response_count: number; delta_value: number }>;
  mergedDelta: number | null;
  agreementCount: number;
  confidenceTier: ConfidenceTier | null;
  narrationStarted: boolean;
  headline: string | null;
}

export interface TagReportProgress {
  stage: TagReportStage;
  stageIndex: number;
  totalStages: number;
  surveys: SurveyNodeState[];
  backfillActive: boolean;
  loopStopReason: 'target_reached' | 'ceiling_hit' | 'pool_exhausted' | null;
  metricTracks: Partial<Record<MetricKey, MetricTrackProgress>>;
  corroborations: Array<{ tracks: MetricKey[]; direction: TrendDirection }>;
  llmCallCount: number;
  done: boolean;
  failed: boolean;
  errorMessage?: string;
  targetN: number | null;
  ceilingN: number | null;
}

function emptyTrack(metric_key: MetricKey): MetricTrackProgress {
  return {
    metric_key,
    eligibleSurveyIds: [],
    excludedSurveyIds: [],
    votes: [],
    mergedDelta: null,
    agreementCount: 0,
    confidenceTier: null,
    narrationStarted: false,
    headline: null,
  };
}

/** Pure reducer over a run's `stream_events`. Safe to call with an empty array. */
export function deriveTagReportProgress(events: TagReportStreamEvent[]): TagReportProgress {
  const surveysById = new Map<string, SurveyNodeState>();
  const metricTracks: Partial<Record<MetricKey, MetricTrackProgress>> = {};
  const corroborations: TagReportProgress['corroborations'] = [];

  let stage: TagReportStage = 'discovery';
  let firstExclusionSeen = false;
  let loopStopReason: TagReportProgress['loopStopReason'] = null;
  let llmCallCount = 0;
  let done = false;
  let failed = false;
  let errorMessage: string | undefined;
  let targetN: number | null = null;
  let ceilingN: number | null = null;

  for (const evt of events) {
    stage = EVENT_STAGE[evt.event] ?? stage;

    switch (evt.event) {
      case 'run_started':
        targetN = evt.target_n;
        ceilingN = evt.ceiling_n;
        break;
      case 'survey_selected':
        surveysById.set(evt.survey_id, {
          survey_id: evt.survey_id,
          title: evt.title,
          position: evt.position,
          selected: true,
          excluded: false,
          isBackfill: firstExclusionSeen,
          checkpoints: {},
        });
        break;
      case 'checkpoint_resolved': {
        const node = surveysById.get(evt.survey_id);
        if (node) {
          node.checkpoints[evt.bracket_position] = { date: evt.checkpoint_date, offsetDays: evt.offset_days };
        }
        break;
      }
      case 'survey_excluded': {
        firstExclusionSeen = true;
        const existing = surveysById.get(evt.survey_id);
        if (existing) {
          existing.excluded = true;
          existing.excludedReason = evt.reason;
          existing.excludedDetail = evt.detail;
        } else {
          surveysById.set(evt.survey_id, {
            survey_id: evt.survey_id,
            title: evt.survey_id,
            position: surveysById.size,
            selected: true,
            excluded: true,
            excludedReason: evt.reason,
            excludedDetail: evt.detail,
            isBackfill: false,
            checkpoints: {},
          });
        }
        break;
      }
      case 'batch_loop_resolved':
        loopStopReason = evt.loop_stop_reason;
        break;
      case 'metric_track_gated': {
        const track = metricTracks[evt.metric_key] ?? emptyTrack(evt.metric_key);
        track.eligibleSurveyIds = evt.eligible_survey_ids;
        track.excludedSurveyIds = evt.excluded_survey_ids;
        metricTracks[evt.metric_key] = track;
        for (const sid of evt.eligible_survey_ids) {
          const node = surveysById.get(sid);
          if (node) node.trendEligible = true;
        }
        break;
      }
      case 'merge_vote': {
        const track = metricTracks[evt.metric_key] ?? emptyTrack(evt.metric_key);
        track.votes.push({
          survey_id: evt.survey_id,
          weight: evt.weight,
          trust_score: evt.trust_score,
          response_count: evt.response_count,
          delta_value: evt.delta_value,
        });
        metricTracks[evt.metric_key] = track;
        break;
      }
      case 'merge_resolved': {
        const track = metricTracks[evt.metric_key] ?? emptyTrack(evt.metric_key);
        track.mergedDelta = evt.merged_delta;
        track.agreementCount = evt.agreement_count;
        track.confidenceTier = evt.confidence_tier;
        metricTracks[evt.metric_key] = track;
        break;
      }
      case 'corroboration_detected':
        corroborations.push({ tracks: evt.tracks, direction: evt.direction });
        break;
      case 'narration_started': {
        const track = metricTracks[evt.metric_key] ?? emptyTrack(evt.metric_key);
        track.narrationStarted = true;
        metricTracks[evt.metric_key] = track;
        break;
      }
      case 'narration_complete': {
        const track = metricTracks[evt.metric_key] ?? emptyTrack(evt.metric_key);
        track.headline = evt.headline;
        metricTracks[evt.metric_key] = track;
        break;
      }
      case 'run_complete':
        done = true;
        llmCallCount = evt.llm_call_count;
        break;
      case 'run_failed':
        failed = true;
        errorMessage = evt.error;
        break;
      default:
        break;
    }
  }

  const stageIndex = TAG_REPORT_STAGES.indexOf(stage);

  return {
    stage,
    stageIndex: stageIndex === -1 ? 0 : stageIndex,
    totalStages: TAG_REPORT_STAGES.length,
    surveys: Array.from(surveysById.values()).sort((a, b) => a.position - b.position),
    backfillActive: firstExclusionSeen && !done,
    loopStopReason,
    metricTracks,
    corroborations,
    llmCallCount,
    done,
    failed,
    errorMessage,
    targetN,
    ceilingN,
  };
}
