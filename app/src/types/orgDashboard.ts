// Types for the Org Intelligence Dashboard ("Command Center") feature.
//
// Mirrors ARCHITECTURE.md's "API Design" section, reconciled against
// docs/org-dashboard/IMPLEMENTATION_SPEC.md (this doc wins on conflicts):
//   - `tags: OrgDashboardTag[]` replaces ARCHITECTURE.md's singular
//     `tagGroupId`/`tagGroupName` — a survey can carry 0-5 `survey_tags` rows.
//   - No WebSocket message types here — real-time delivery is SSE
//     (`useOrgDashboardLive.ts` wraps `EventSource`), per Decision 22.
//
// The backend endpoints described here are owned by a parallel Backend
// Engineer agent and did not exist as literal routes at the time this file
// was written — this file is the typed contract the frontend is built
// against, matching the pattern already used by `types/tagReport.ts`.

export type HealthStatus = 'healthy' | 'attention' | 'critical';
export type SentimentTrend = 'improving' | 'stable' | 'declining';
export type AlertSeverity = 'critical' | 'warning' | 'info' | 'success';
export type AlertStatus = 'active' | 'acknowledged' | 'snoozed' | 'resolved';
export type ActionType = 'investigate' | 'review' | 'celebrate' | 'monitor';
export type BriefSource = 'scheduled' | 'manual';
export type TrendRange = '7d' | '30d' | '90d' | '1y';
export type TrendGranularity = 'daily' | 'weekly';

// ── Tags (survey_tags, many-to-many via survey_tag_mappings) ────────────────
export interface OrgDashboardTag {
  id: string;
  name: string;
  color: string;
}

// ── GET /api/org/dashboard ───────────────────────────────────────────────────
export interface OrgHealthComponents {
  nps: number;         // 0-1
  sentiment: number;   // 0-1
  velocity: number;    // 0-1
  anomalyFree: number; // 0-1
}

export interface OrgHealthScore {
  total: number; // 0-100
  components: OrgHealthComponents;
  computedAt: string;
}

export interface OrgDashboardKpis {
  activeSurveys: number;
  activeSurveysDelta?: number | null;
  totalResponses: number;
  responsesToday: number;
  avgNps: number;
  npsWowDelta: number;
  avgSentiment: number; // -1.0 to 1.0
  sentimentTrend: SentimentTrend;
}

export interface CrystalBriefRecommendation {
  rank: number;
  action: string;
  rationale: string;
  surveyId: string | null;
  // Canonical field is `tagId` (a `survey_tags` row — "tag group" = a tag,
  // there is no separate tag_groups table), resolved during integration
  // after `org_brief_graph.py` and this file were built independently
  // against two different names (`tag_id` vs. `tag_group_id`) for the same
  // concept. See org-metrics.service.ts's `mapRecommendation`.
  tagId: string | null;
  actionType: ActionType;
  // Empty array is itself meaningful provenance (numbers-only recommendation,
  // no supporting insight) — never absent. See ARCHITECTURE.md Addendum 2's
  // "Citation mechanism"; gated off in production today by
  // ORG_BRIEF_ENABLE_INSIGHT_CITATIONS (Decision 24), so this is always []
  // until that flag flips, but the field must exist so the UI doesn't need
  // a second contract change when it does.
  sourceInsightIds: string[];
}

// Progressive-disclosure trust fields (Decision 16) — optional/nullable
// because the trust score can arrive asynchronously after the rest of the
// brief (see `brief_trust_score_ready` SSE event, Decision 21 item 3).
export type TrustVerdict = 'pass' | 'flag' | 'fail';

export interface CrystalBrief {
  id: string;
  briefText: string;
  recommendations: CrystalBriefRecommendation[];
  generatedAt: string;
  dateRangeStart: string;
  dateRangeEnd: string;
  trustVerdict?: TrustVerdict | null;
  trustScore?: number | null; // 0-100, only meaningful with a hover/expand — never shown as a raw label
  parentCheckpointId?: string | null; // null => "Compare to previous" never renders
}

// `GET /api/org/dashboard/crystal-brief`'s actual response shape — ALWAYS this
// wrapper, never a bare `CrystalBrief` and never bare `null`. Eligibility
// ("Crystal needs at least 2 weeks of data from 3 programs") is a sibling of
// `brief`, not a field nested inside it, because it must be knowable even
// when `brief` itself is null (the common "no brief yet" case) — drives
// `CrystalBriefCard`'s/`WeeklyBriefTeaserCard`'s `minDataMet` empty-state copy.
export interface CrystalBriefResponse {
  brief: CrystalBrief | null;
  minDataMet: boolean;
}

export interface OrgDashboardPayload {
  org: { id: string; name: string };
  healthScore: OrgHealthScore;
  kpis: OrgDashboardKpis;
  crystalBrief: CrystalBrief | null;
  // Sibling of `crystalBrief` for the same reason as `CrystalBriefResponse`
  // above — must be knowable even when `crystalBrief` is null.
  briefMinDataMet: boolean;
  dataFreshnessAt: string;
}

// ── GET /api/org/dashboard/trends ────────────────────────────────────────────
export interface OrgTrendPoint {
  date: string;
  avgNps: number;
  totalResponses: number;
  avgSentiment: number;
}

export interface OrgTrendSurveySeries {
  surveyId: string;
  surveyTitle: string;
  points: Array<{ date: string; nps: number }>;
}

export interface OrgTrendsResponse {
  series: OrgTrendPoint[];
  bySurvey?: OrgTrendSurveySeries[];
  benchmark: { nps: number | null; source: string | null };
}

// ── GET /api/org/dashboard/programs ──────────────────────────────────────────
export interface ProgramRow {
  surveyId: string;
  surveyTitle: string;
  tags: OrgDashboardTag[];
  responses7d: number;
  lastNps: number;
  sentimentTrend: SentimentTrend;
  velocityScore: number; // 0-3x
  healthStatus: HealthStatus;
  lastActivityAt: string;
  sparkline: number[]; // last 7 NPS daily values
}

export interface ProgramsPagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface ProgramsResponse {
  programs: ProgramRow[];
  pagination: ProgramsPagination;
}

export type ProgramsSortKey = 'health' | 'nps' | 'responses' | 'lastActivity' | 'name';
export type SortOrder = 'asc' | 'desc';

export interface ProgramsQuery {
  page?: number;
  pageSize?: 10 | 25 | 50;
  sort?: ProgramsSortKey;
  order?: SortOrder;
  tagId?: string;
  status?: HealthStatus;
}

// ── GET /api/org/dashboard/topics ────────────────────────────────────────────
export interface OrgTopic {
  topicLabel: string;
  frequency: number;
  avgSentiment: number; // -1.0 to 1.0
  isNewThisWeek: boolean;
  frequencyChangePct: number | null;
  rank: number;
  surveyIds: string[];
}

export interface OrgTopicsResponse {
  weekStart: string;
  topics: OrgTopic[];
}

export interface OrgTopicBreakdown {
  topicLabel: string;
  frequency: number;
  bySurvey: Array<{ surveyId: string; surveyTitle: string; count: number }>;
  sampleQuotes: string[];
}

// ── GET /api/org/dashboard/alerts ────────────────────────────────────────────
export interface OrgAlert {
  id: string;
  surveyId: string | null;
  surveyTitle: string | null;
  description: string;
  severity: AlertSeverity;
  detectedAt: string;
  resolvedAt: string | null;
  isAcknowledged: boolean;
}

export interface OrgAlertsResponse {
  alerts: OrgAlert[];
  totalUnresolved: number;
}

// ── GET /api/org/health-score ────────────────────────────────────────────────
export interface OrgHealthScoreComponentDetail {
  score: number;
  weight: number;
  contribution: number;
}

export interface OrgHealthScoreDetail {
  totalScore: number;
  status: HealthStatus;
  components: {
    nps: OrgHealthScoreComponentDetail;
    sentiment: OrgHealthScoreComponentDetail;
    responseVelocity: OrgHealthScoreComponentDetail;
    anomalyFree: OrgHealthScoreComponentDetail;
  };
  history: Array<{ date: string; totalScore: number }>;
  computedAt: string;
}

// ── GET /api/org/dashboard/briefs (Brief Archive) ────────────────────────────
export interface BriefHistoryEntry {
  id: string;
  dateRangeStart: string;
  dateRangeEnd: string;
  briefText: string;
  recommendationCount: number;
  hasCriticalSignal: boolean;
  generatedAt: string;
  modelVersion: string;
  source: BriefSource;
  healthStatusAtTime?: HealthStatus;
  parentCheckpointId?: string | null;
  requestedByName?: string | null; // manual only, shown on hover per DESIGN.md
}

export interface BriefsResponse {
  briefs: BriefHistoryEntry[];
  pagination: ProgramsPagination;
}

// ── GET /api/org/dashboard/briefs/:id/compare/:otherId ───────────────────────
export interface CheckpointCompareSide {
  id: string;
  dateRangeLabel: string;
  verdict: string; // single-word verdict, e.g. "Improving" / "Declining" / "Stable"
  metrics: { nps: number | null; sentiment: number | null; responses: number | null };
}

export interface CheckpointComparisonDelta {
  key: 'nps' | 'sentiment' | 'responses';
  label: string;
  delta: number;
  positive: boolean;
}

export interface CheckpointComparisonResult {
  previous: CheckpointCompareSide;
  current: CheckpointCompareSide;
  deltas: CheckpointComparisonDelta[];
}

// ── GET /api/org/dashboard/briefs/:briefId (Brief Provenance trail) ─────────
// `inputSnapshot`/`trustJson` are raw JSONB pass-through from
// `crystalos/graphs/org_brief_graph.py` / `crystalos/lib/org_brief_verify.py`
// respectively — snake_case, unlike the rest of this API's camelCase
// convention, because the backend forwards these objects verbatim rather
// than re-encoding them field-by-field.
export interface OrgBriefTopTopicSnapshot {
  topic_label: string;
  frequency: number;
  avg_sentiment: number;
  is_new_this_week: boolean;
  frequency_change_pct: number | null;
}

export interface OrgBriefInputSnapshot {
  org_id: string;
  period_type: string;
  week_start: string;
  date_range_start: string;
  date_range_end: string;
  total_responses: number;
  avg_nps: number;
  avg_sentiment: number;
  nps_wow_delta: number | null;
  responses_wow_delta: number | null;
  sentiment_wow_delta: number | null;
  active_surveys: number;
  // Weekly-brief-only field — custom-range (manual) summaries never populate
  // this, so it must be treated as absent, not just empty. Confirmed crash
  // site: `BriefProvenancePanel.tsx`'s `WhatCrystalLookedAt` unconditionally
  // accessed `.length` on this before this fix.
  top_topics?: OrgBriefTopTopicSnapshot[];
  no_comparable_prior_period: boolean;
}

export interface OrgBriefGroundingFailure {
  clause: string;
  reason: string;
}

export interface OrgBriefTrustJson {
  pass_1_2_numeric_and_llm_grounding: {
    score: number;
    verdict: TrustVerdict;
    issues: string[];
    deterministic_score: number;
    llm_score: number;
  };
  pass_3_grounding_completeness: {
    grounding_failures: OrgBriefGroundingFailure[];
  };
  cited_insight_count: number;
}

export interface OrgBriefDetail {
  id: string;
  dateRangeStart: string;
  dateRangeEnd: string;
  briefText: string | null;
  recommendations: CrystalBriefRecommendation[];
  generatedAt: string | null;
  modelVersion: string | null;
  inputSnapshot: OrgBriefInputSnapshot | null;
  trustJson: OrgBriefTrustJson | null;
  hallucinationScore: number | null;
  parentCheckpointId: string | null;
  source: BriefSource;
}

// ── Tag-scoped aggregates (GET /api/org/dashboard/tags) ──────────────────────
export interface TagMetric {
  tagId: string;
  tagName: string;
  color: string;
  surveyCount: number;
  aggregateNps: number | null;
  topTopic: string | null;
  healthStatus: HealthStatus;
  sparkline14d: number[];
  responses: number;
}

export interface TagMetricsResponse {
  tags: TagMetric[];
}

// ── Manual Summary Generator ──────────────────────────────────────────────────
export interface SummaryPreviewRequest {
  dateRangeStart: string;
  dateRangeEnd: string;
}

export interface SummaryPreviewResponse {
  estimatedCost: number;
  responseCount: number;
  programsIncluded: number;
  dateRangeDays: number;
  lowConfidence: boolean;
  exceedsMaxRange: boolean;
}

export type OrgSummaryStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface OrgSummary {
  id: string;
  dateRangeStart: string;
  dateRangeEnd: string;
  label: string | null;
  status: OrgSummaryStatus;
  runId: string | null;
  briefText: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface CreateSummaryRequest {
  dateRangeStart: string;
  dateRangeEnd: string;
  label?: string;
}

export interface CreateSummaryResponse {
  summaryId: string;
  runId: string;
  status: 'pending';
}

// ── Real-time (SSE, `GET /api/org/dashboard/stream`) — Decision 22 ──────────
// A new Redis-backed SSE endpoint, org-scoped, distinct from the app-wide
// `/api/notifications/stream` used for generation-completion/trust-score
// events (those ride the existing notification stream per Decision 21).
export interface OrgLiveResponseReceivedPayload {
  surveyId: string;
  orgId: string;
  npsScore: number;
  sentimentScore: number;
  submittedAt: string;
  orgTotals: {
    responsesToday: number;
    avgNps: number;
    avgSentiment: number;
  };
}

export interface OrgLiveAnomalyDetectedPayload {
  alertId: string;
  surveyId: string | null;
  severity: AlertSeverity;
  title: string;
  description: string;
  detectedAt: string;
  // Present when payload is already a normalized REST `OrgAlert` row.
  id?: string;
  surveyTitle?: string | null;
  resolvedAt?: string | null;
  isAcknowledged?: boolean;
}

// Real completion signal for the "Regenerate" button — previously a bare 202
// with no further feedback (see `useOrgCrystalBrief`'s `regenerate()`).
export interface OrgLiveCrystalBriefReadyPayload {
  success: boolean;
  error?: string;
}

export type OrgDashboardLiveEvent =
  | { type: 'response_received'; payload: OrgLiveResponseReceivedPayload }
  | { type: 'anomaly_detected'; payload: OrgLiveAnomalyDetectedPayload }
  | { type: 'crystal_brief_ready'; payload: OrgLiveCrystalBriefReadyPayload };

export type OrgDashboardConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'polling' | 'disconnected';
