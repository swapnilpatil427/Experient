// Types for the Tag Report feature — cross-survey AI insight rollups.
//
// These mirror the streaming event contract (docs/tag-report/TRACKER.md §2,
// "CrystalOS Implementation Plan") and the API response shapes (§1, "Backend
// Implementation Plan — Endpoints") exactly. The backend endpoints and the
// CrystalOS SSE stream described here do not exist yet as of this writing —
// Tag Report's frontend is built against this documented contract as typed
// interfaces so component logic/rendering is real and unit-testable now.
// Wiring to the live endpoints is a separate integration task.

export type TagReportRunMode = 'manual' | 'automated' | 'custom_range';
export type TagReportTrigger = 'manual' | 'scheduled' | 'api';
export type TagReportRunStatus = 'pending' | 'running' | 'completed' | 'failed';
export type MetricKey = 'nps' | 'csat' | 'ces';
export type BracketPosition = 'single' | 'start' | 'end';
export type SourceMode = 'latest' | 'bracket_pair';
export type ExclusionReason = 'no_checkpoint_in_range' | 'excluded_by_recency_cap';
// R-C2's hybrid absolute/ratio confidence tiering; 'insufficient' is the R-T2
// agreement-floor outcome (fewer than 2 trend-eligible surveys agree).
export type ConfidenceTier = 'high' | 'medium' | 'low' | 'severe' | 'insufficient';
export type TrendDirection = 'up' | 'down';

// ── Streaming event contract (TRACKER.md §2) ────────────────────────────────
// Common envelope: {"event": "<type>", "ts": "<iso8601>", "run_id": "<run_id>", ...}

interface TagReportStreamEnvelope {
  ts: string;
  run_id: string;
}

export interface RunStartedEvent extends TagReportStreamEnvelope {
  event: 'run_started';
  tag_id: string;
  report_mode: TagReportRunMode;
  target_n: number;
  ceiling_n: number;
}

export interface BatchFetchedEvent extends TagReportStreamEnvelope {
  event: 'batch_fetched';
  batch_index: number;
  survey_ids: string[];
  cursor: number;
  pool_size: number;
}

export interface SurveySelectedEvent extends TagReportStreamEnvelope {
  event: 'survey_selected';
  survey_id: string;
  // Stable across the run — index in the full candidate pool.
  position: number;
  title: string;
  created_at: string;
}

export interface CheckpointResolvedEvent extends TagReportStreamEnvelope {
  event: 'checkpoint_resolved';
  survey_id: string;
  bracket_position: BracketPosition;
  checkpoint_date: string;
  // Signed — negative means the checkpoint is before the requested boundary.
  offset_days: number;
}

export interface SurveyExcludedEvent extends TagReportStreamEnvelope {
  event: 'survey_excluded';
  survey_id: string;
  reason: ExclusionReason | string;
  detail?: string;
}

export interface BatchLoopResolvedEvent extends TagReportStreamEnvelope {
  event: 'batch_loop_resolved';
  included_count: number;
  target_n: number;
  loop_stop_reason: 'target_reached' | 'ceiling_hit' | 'pool_exhausted';
}

export interface BracketDeltaComputedEvent extends TagReportStreamEnvelope {
  event: 'bracket_delta_computed';
  survey_id: string;
  nps_delta: number | null;
  csat_delta: number | null;
  ces_delta: number | null;
  start_checkpoint_id: string;
  end_checkpoint_id: string;
}

export interface MetricTrackGatedEvent extends TagReportStreamEnvelope {
  event: 'metric_track_gated';
  metric_key: MetricKey;
  eligible_survey_ids: string[];
  excluded_survey_ids: string[];
}

export interface MergeVoteEvent extends TagReportStreamEnvelope {
  event: 'merge_vote';
  metric_key: MetricKey;
  survey_id: string;
  // Pre-normalized to sum to 1.0 across all voting surveys for this metric_key.
  weight: number;
  trust_score: number;
  response_count: number;
  delta_value: number;
}

export interface MergeResolvedEvent extends TagReportStreamEnvelope {
  event: 'merge_resolved';
  metric_key: MetricKey;
  merged_delta: number;
  agreement_count: number;
  confidence_tier: ConfidenceTier;
}

export interface CorroborationDetectedEvent extends TagReportStreamEnvelope {
  event: 'corroboration_detected';
  tracks: MetricKey[];
  direction: TrendDirection;
  overlap_surveys: string[];
  window_overlap_pct: number;
}

export interface ComparabilityWarningEvent extends TagReportStreamEnvelope {
  event: 'comparability_warning';
  scope: string;
  warning_type: string;
  distortion_score: number;
  confidence_tier: ConfidenceTier;
  affected_survey_ids: string[];
}

export interface NarrationStartedEvent extends TagReportStreamEnvelope {
  event: 'narration_started';
  metric_key: MetricKey;
}

export interface NarrationCompleteEvent extends TagReportStreamEnvelope {
  event: 'narration_complete';
  metric_key: MetricKey;
  headline: string;
  confidence: ConfidenceTier;
}

export interface CitationsMergedEvent extends TagReportStreamEnvelope {
  event: 'citations_merged';
  citation_count: number;
  survey_count: number;
}

export interface RunCompleteEvent extends TagReportStreamEnvelope {
  event: 'run_complete';
  metric_tracks_narrated: number;
  llm_call_count: number;
  total_surveys_scanned: number;
  total_surveys_included: number;
  duration_ms: number;
}

export interface RunFailedEvent extends TagReportStreamEnvelope {
  event: 'run_failed';
  node: string;
  error: string;
}

export type TagReportStreamEvent =
  | RunStartedEvent
  | BatchFetchedEvent
  | SurveySelectedEvent
  | CheckpointResolvedEvent
  | SurveyExcludedEvent
  | BatchLoopResolvedEvent
  | BracketDeltaComputedEvent
  | MetricTrackGatedEvent
  | MergeVoteEvent
  | MergeResolvedEvent
  | CorroborationDetectedEvent
  | ComparabilityWarningEvent
  | NarrationStartedEvent
  | NarrationCompleteEvent
  | CitationsMergedEvent
  | RunCompleteEvent
  | RunFailedEvent;

/** The 6 pipeline-visualization stages, in order (Part A of the UX spec). */
export const TAG_REPORT_STAGES = [
  'discovery',
  'checkpoint',
  'comparison',
  'gating',
  'merge',
  'narrative',
] as const;
export type TagReportStage = (typeof TAG_REPORT_STAGES)[number];

// ── API response shapes (TRACKER.md §1 "Endpoints") ─────────────────────────

/** Mirrors `group_insight_run_sources` (DESIGN.md Appendix A.1.2) joined with survey title. */
export interface TagReportRunSource {
  id: string;
  run_id: string;
  survey_id: string;
  survey_title?: string;
  checkpoint_id: string | null;
  bracket_position: BracketPosition;
  source_mode: SourceMode;
  matched_checkpoint_window_start: string | null;
  matched_checkpoint_window_end: string | null;
  boundary_offset_interval: string | null;
  trend_eligible: boolean;
  response_count_at_generation: number;
  exclusion_reason: ExclusionReason | null;
  created_at: string;
}

/**
 * DESIGN.md §4.5 AC-1 — every citation must resolve to a specific insight row,
 * not just a checkpoint: `survey_id`, `response_id`, AND `source_insight_id`.
 */
export interface CitationRef {
  survey_id: string;
  response_id: string;
  source_insight_id: string;
  quote: string;
  sentiment: 'positive' | 'neutral' | 'negative';
  relevance: number;
}

export interface ComparabilityWarning {
  scope: string;
  warning_type: string;
  distortion_score: number;
  confidence_tier: ConfidenceTier;
  affected_survey_ids: string[];
}

/** One row per qualifying metric track — `group_insights.metric_key` partitioning. */
export interface TagReportMetricTrack {
  metric_key: MetricKey;
  headline: string;
  narrative: string;
  trust_score: number | null;
  eligible_survey_count: number;
  agreement_count: number;
  confidence_tier: ConfidenceTier;
  merged_delta: number | null;
  direction: TrendDirection | null;
  /** R-T2 / R-T2a fallback — true when the agreement floor (≥2 surveys) isn't met. */
  single_survey_sourced: boolean;
  single_survey_name?: string;
  warnings: ComparabilityWarning[];
  citations: CitationRef[];
  corroborated_with?: MetricKey[];
  /**
   * Custom Range only — per-survey bracket deltas backing the Comparison/Wave
   * Card's expandable breakdown (sorted highest-trust-first by the renderer).
   */
  survey_breakdown?: Array<{
    survey_id: string;
    survey_title?: string;
    trust_score: number;
    delta: number | null;
    no_comparison_available: boolean; // R-C1's degenerate-bracket case
    requested_window_start?: string;
    requested_window_end?: string;
    actual_window_start?: string;
    actual_window_end?: string;
  }>;
}

export interface TagReportRun {
  id: string;
  org_id: string;
  tag_id: string;
  tag_ids: string[];
  run_mode: TagReportRunMode;
  trigger: TagReportTrigger;
  status: TagReportRunStatus;
  window_start: string | null;
  window_end: string | null;
  parent_run_id: string | null;
  stream_events: TagReportStreamEvent[];
  result_json?: Record<string, unknown>;
  created_at: string;
  completed_at?: string;
}

/** `GET /api/survey-groups/insights/tag-report/:runId` */
export interface TagReportRunResponse {
  run: TagReportRun;
  metric_tracks: TagReportMetricTrack[];
  sources: TagReportRunSource[];
  /** Total candidate surveys under the tag (R-M2's "of 12"). */
  pool_size: number;
  /** How many of the pool were actually examined before the backfill loop stopped. */
  examined_count: number;
  /** How many ended up qualifying / usable in the final report. */
  included_count: number;
  backfill_occurred: boolean;
}

/** A row from `GET /api/survey-tags/:id/tag-report-history` — powers the Trail page's Run History list. */
export interface TagReportTrailEntry {
  run_id: string;
  run_mode: TagReportRunMode;
  trigger: TagReportTrigger;
  created_at: string;
  metric_tracks_narrated: number;
}

interface TagReportLineageEntry {
  id: string;
  run_mode: TagReportRunMode;
  trigger: TagReportTrigger;
  status: string;
  parent_run_id: string | null;
  created_at: string;
  completed_at: string | null;
}

/**
 * `GET /api/group-insights/tag-report/:runId/trail` — provenance + the
 * bounded parent_run_id lineage walk for ONE run (not a tag's full history;
 * that's `tag-report-history` above). Fixed 2026-07-03 (customer-journey
 * review finding, severe): this previously declared `tag_id`/`tag_name`/`runs`,
 * none of which the real endpoint returns — a hard shape mismatch that meant
 * `runs.map(...)` in TagReportTrailPage threw on every real visit.
 */
export interface TagReportTrailResponse {
  run_id: string;
  lineage: TagReportLineageEntry[];
  sources: TagReportRunSource[];
  /** True if the parent_run_id chain is longer than the ~10-hop walk cap. */
  truncated: boolean;
}

export interface TagReportsIndexItem {
  tag_id: string;
  tag_name: string;
  tag_color: string;
  survey_count: number;
  latest_run: {
    mode: TagReportRunMode;
    created_at: string;
    has_active_warning: boolean;
  } | null;
  automated_enabled?: boolean;
}

/** `GET /api/survey-groups/insights/tag-reports` */
export interface TagReportsIndexResponse {
  reports: TagReportsIndexItem[];
  total: number;
}

export interface TagReportGenerateRequest {
  tag_id: string;
  run_mode: 'manual' | 'custom_range';
  window_start?: string;
  window_end?: string;
  parent_run_id?: string;
}

export interface TagReportGenerateResponse {
  run_id: string;
  // Fixed 2026-07-03 (customer-journey review finding): the backend's manual/
  // custom-range endpoints already return these two fields — the AUTHORITATIVE
  // signal from insertGroupInsightRunWithConcurrencyGuard's real DB-level
  // concurrency check (a 23505 conflict, not a guess) — but the frontend
  // previously discarded them and re-derived a fragile timestamp/trigger
  // heuristic from a second, separate API call instead. Declaring them here so
  // callers use the real signal directly.
  attached_to_existing: boolean;
  created_at: string;
}
