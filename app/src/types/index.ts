// ── Question types ────────────────────────────────────────────────────────────

export type QuestionType =
  | 'nps' | 'csat' | 'rating' | 'slider'
  | 'multiple_choice' | 'checkbox' | 'dropdown' | 'ranking'
  | 'open_text' | 'short_text'
  | 'matrix' | 'date' | 'statement';

export interface SkipLogicCondition {
  operator: 'eq' | 'neq' | 'lt' | 'gt' | 'lte' | 'gte' | 'contains' | 'answered' | 'not_answered';
  value?: string | number | null;
}

export interface SkipLogicRule {
  id: string;
  condition: SkipLogicCondition;
  destination: string;   // question ID or "END_SURVEY"
}

export interface DisplayLogic {
  sourceQuestionId: string;
  operator: string;
  value?: string | number | null;
}

export interface BaseQuestion {
  id: string;
  type: QuestionType;
  question: string;
  required: boolean;
  skipLogic?: SkipLogicRule[];
  displayLogic?: DisplayLogic | null;
}

export interface NpsQuestion extends BaseQuestion { type: 'nps'; labelLow?: string; labelHigh?: string; }
export interface CsatQuestion extends BaseQuestion { type: 'csat'; csatStyle?: 'emoji' | 'stars' | 'numbers'; }
export interface RatingQuestion extends BaseQuestion { type: 'rating'; scaleMax?: number; ratingStyle?: 'stars' | 'numbers'; labelLow?: string; labelHigh?: string; }
export interface SliderQuestion extends BaseQuestion { type: 'slider'; min?: number; max?: number; step?: number; showValue?: boolean; labelLow?: string; labelHigh?: string; }
export interface ChoiceQuestion extends BaseQuestion { type: 'multiple_choice' | 'checkbox' | 'dropdown' | 'ranking'; options?: string[]; allowOther?: boolean; randomize?: boolean; maxSelections?: number | null; placeholder?: string; }
export interface TextQuestion extends BaseQuestion { type: 'open_text' | 'short_text'; placeholder?: string; maxLength?: number | null; validation?: 'email' | 'url' | 'number' | 'phone' | null; }
export interface MatrixQuestion extends BaseQuestion { type: 'matrix'; rows?: string[]; columns?: string[]; matrixType?: 'radio' | 'checkbox'; }
export interface DateQuestion extends BaseQuestion { type: 'date'; dateType?: 'date' | 'time' | 'datetime'; }
export interface StatementQuestion extends BaseQuestion { type: 'statement'; isStatement?: boolean; }

export type Question =
  | NpsQuestion | CsatQuestion | RatingQuestion | SliderQuestion
  | ChoiceQuestion | TextQuestion | MatrixQuestion | DateQuestion
  | StatementQuestion;

// ── Survey ────────────────────────────────────────────────────────────────────

export type SurveyStatus = 'draft' | 'active' | 'paused' | 'closed';

export interface Survey {
  id: string;
  org_id: string;
  title: string;
  description?: string | null;
  status: SurveyStatus;
  questions: Question[];
  survey_type_id?: string | null;
  template_id?: string | null;
  intent?: string | null;
  thank_you_message?: string | null;
  nps_score?: number | null;
  max_responses?: number | null;
  auto_close_at?: string | null;
  allow_multiple_responses?: boolean;
  password_protected?: boolean;
  publish_token?: string | null;
  response_count?: number;
  avg_csat?: number | null;
  sparkline?: number[];
  created_by?: string;
  updated_by?: string | null;
  created_at: string;
  updated_at: string;
  published_at?: string | null;
  paused_at?: string | null;
  closed_at?: string | null;
  deleted_at?: string | null;
}

// ── Answer / Response ─────────────────────────────────────────────────────────

export interface Answer {
  questionId: string;
  type?: string;
  value: unknown;
}

export interface SurveyResponse {
  id: string;
  survey_id: string;
  org_id: string;
  answers: Answer[];
  nps_score?: number | null;
  submitted_at: string;
  // AI enrichment
  ai_sentiment?: 'positive' | 'negative' | 'neutral' | 'mixed' | null;
  ai_sentiment_score?: number | null;
  ai_emotion?: string | null;
  ai_effort_score?: number | null;
  ai_topics?: string[] | null;
  // Device / metadata
  country?: string | null;
  city?: string | null;
  device_type?: string | null;
  browser?: string | null;
  os?: string | null;
  completion_time_s?: number | null;
}

// ── Template ──────────────────────────────────────────────────────────────────

export interface Template {
  id: string;
  orgId?: string;
  label: string;
  shortLabel?: string;
  description?: string;
  category?: string;
  icon?: string;
  color?: string;
  bg?: string;
  metrics?: string[];
  tags?: string[];
  recommended?: boolean;
  estimatedMinutes?: number;
  questionCount?: string;
  questions?: Question[];
  scoring?: Record<string, unknown> | null;
  intelligence?: Record<string, unknown> | null;
  isSystem?: boolean;
  status?: string;
  createdBy?: string;
  clonedFromId?: string | null;
  version?: number;
  createdAt?: string;
  updatedAt?: string;
}

// ── Workflow ──────────────────────────────────────────────────────────────────

export interface WorkflowCondition {
  field?: string;
  operator?: string;
  value?: unknown;
}

export interface WorkflowAction {
  type?: string;
  config?: Record<string, unknown>;
}

export type WorkflowStatus = 'draft' | 'active' | 'paused' | 'archived' | 'error';

// Scope (docs/automation-hub/BUILDER_REDESIGN_V2_SCOPE.md §2 / Nina's Wave 6
// backend pass) — 'org' default for backward compat with every pre-scope row.
export type WorkflowScopeType = 'org' | 'survey' | 'tag';

// Mirrors backend/src/lib/workflowEngine.ts::computeCooldownStatus()'s exact
// return shape (CooldownStatus) — snake_case, not camelCase, since it's
// attached server-side via withCooldownStatus() and returned as-is on
// GET /api/workflows and GET /api/workflows/:id.
export interface WorkflowCooldownStatus {
  in_cooldown: boolean;
  cooldown_minutes: number;
  last_fired_at: string | null;
  cooldown_resets_at: string | null;
}

export interface Workflow {
  id: string;
  org_id?: string;
  name: string;
  description?: string | null;
  // Legacy single-rule shape (still used by the "quick create" modal + builder pages).
  condition?: WorkflowCondition;
  action?: WorkflowAction;
  // Graph shape (trigger/condition/action nodes) — what the registry-backed
  // builder + canvas pages and the real backend rows use.
  trigger_type?: string | null;
  nodes?: unknown[];
  edges?: unknown[];
  status: WorkflowStatus;
  trigger_count?: number;
  run_count?: number;
  success_count?: number;
  last_run_at?: string | null;
  last_status?: string | null;
  created_by?: string;
  created_at?: string;
  updated_at?: string;
  // Cooldown (Wave 5, BUILDER_REBUILD_SPEC.md §5.3) — proper typed fields
  // replacing the `as unknown as {...}` cast that previously lived in
  // WorkflowBuilderPage.tsx (Wave 5 follow-up item, closed in Wave 6).
  cooldown_minutes?: number | null;
  cooldown_status?: WorkflowCooldownStatus | null;
  // Scope (Wave 6, BUILDER_REDESIGN_V2_SCOPE.md §2) — defaults to 'org' server-side
  // when omitted; every pre-existing row is implicitly org-wide.
  scope_type?: WorkflowScopeType;
  scope_survey_id?: string | null;
  scope_tag_id?: string | null;
  // Optimistic-locking counter (Wave 11, Nina — TRACKER.md Wave 11 Part 2,
  // backend/src/routes/workflows.ts). Present on every GET response (default
  // 1, incremented on every successful PUT/toggle). Optional here only
  // because pre-Wave-11 test fixtures/mocks may omit it — the backend always
  // sends it on real rows.
  version?: number;
  updated_by?: string | null;
}

// ── Insights ──────────────────────────────────────────────────────────────────

export interface InsightTopic {
  name: string;
  sentiment: 'positive' | 'neutral' | 'negative';
  volume: number;
  phrases?: string[];
}

export interface SentimentBreakdown {
  positive: number;
  neutral: number;
  negative: number;
}

/** @deprecated Use AgenticInsight instead */
export interface LegacyInsight {
  id?: string;
  survey_id?: string;
  org_id?: string;
  summary: string;
  nps_score?: number | null;
  topics?: InsightTopic[];
  sentiment_breakdown?: SentimentBreakdown;
  top_phrases?: string[];
  response_count?: number;
  triggered_by?: string;
  created_at?: string;
}

/** Backward-compat alias */
export type Insight = LegacyInsight;

// ── New Insight types (v2 — per-survey agentic insights) ──────────────────────

export interface InsightMetric {
  name:    string;
  value:   number | null;
  ci_low?: number | null;
  ci_high?: number | null;
  unit?:   string;
  scale?:  number;
  distribution?: Record<string, number>;
  dominant_sentiment?: 'positive' | 'neutral' | 'negative';
}

export interface InsightCitation {
  response_id: string;
  quote:       string;
  sentiment:   'positive' | 'neutral' | 'negative';
  relevance:   number;
  emotion:     string;
}

export interface InsightTrust {
  statistical:  number;
  coverage:     number;
  consistency:  number;
  grounding:    number;
  below_minimum_sample: boolean;
  sample_size:  number;
}

export interface InsightRecommendedAction {
  type:              string;
  label:             string;
  target?:           string;
  estimated_impact?: string;
  time_horizon?:     string;
  priority?:         'high' | 'medium' | 'low' | string;
}

export interface InsightAudit {
  model:           string;
  embedding_model: string;
  temperature:     number;
  seed:            number;
  verifier_pass:   boolean;
  verifier_notes:  string;
  prompt_hash:     string;
  run_id:          string;
}

export interface AgenticInsight {
  id:            string;
  survey_id:     string;
  org_id:        string;
  run_id:        string;
  layer:         'descriptive' | 'diagnostic' | 'predictive' | 'prescriptive';
  category:      string;
  question_type?: string;
  segment_json?:  Record<string, unknown>;
  headline:      string;
  narrative:     string;
  recommended_action?: InsightRecommendedAction | null;
  metric_json?:  InsightMetric | null;
  citations_json: InsightCitation[];
  trust_score:   number;
  trust_json:    InsightTrust | null;
  priority:      number;
  insight_hash:  string;
  audit_json:    InsightAudit;
  user_state_json: {
    pinned?:    boolean;
    dismissed?: boolean;
    thumbs?:    'up' | 'down' | null;
  };
  generated_at: string;
  superseded_at?: string | null;
}

// ── Insight Pipeline v2 — Phase 0.5 checkpoint trajectory ────────────────────
// The investigation tracking layer: each automated/manual checkpoint records a
// delta from the prior checkpoint so the UI can show "what changed".

/** Topic lifecycle changes between two checkpoints. */
export interface CheckpointTopicChanges {
  emerged:   string[];
  resolved:  string[];
  persisted: string[];
}

/** Phase 0.5 delta schema — the diff from the prior checkpoint. NUMERICs coerced. */
export interface CheckpointDelta {
  nps_delta:             number | null;
  csat_delta:            number | null;
  response_count_delta:  number;
  topic_changes:         CheckpointTopicChanges;
  trend_direction:       'up' | 'down' | 'stable';
  trend_persistence:     string;
}

/** The latest checkpoint summary returned by GET /api/insights/:surveyId/list. */
export interface LatestCheckpoint {
  number:     number;
  nps:        number | null;
  delta:      CheckpointDelta | null;
  meaningful: boolean;
  created_at: string;
  /** Optional provenance fields the backend may include. */
  trigger?:        string | null;
  new_responses?:  number | null;
  csat?:           number | null;
  ces?:            number | null;
  model?:          string | null;
}

/** One point in the recent-checkpoints trail used for the drawer sparkline. */
export interface RecentCheckpointPoint {
  number:     number;
  nps:        number | null;
  created_at: string;
}

// ── Insight Pipeline v2 — Phase 3 (Manual runs) + Phase 4 (Insight Trail) ────

/** Manual-run mode selector — drives depth, sampling, and cost. */
export type ManualRunMode = 'expert' | 'quick' | 'refresh';

/** Which timeline a checkpoint belongs to. */
export type TrailLane = 'automated' | 'manual';

/** Body for POST /api/insights/:surveyId/runs (trigger a manual run). */
export interface ManualRunRequest {
  mode:          ManualRunMode;
  window_start?: string | null;
  window_end?:   string | null;
  label?:        string | null;
}

/** 202 response from POST /api/insights/:surveyId/runs. */
export interface ManualRunResponse {
  run_id:     string;
  status:     string;        // 'started'
  report_id?: string | null;
}

/** Body for POST /api/insights/:surveyId/runs/preview. */
export interface ManualRunPreviewRequest {
  mode:          ManualRunMode;
  window_start?: string | null;
  window_end?:   string | null;
}

/** Preview estimate for a manual run (NUMERICs coerced to numbers). */
export interface ManualRunPreview {
  estimated_cost:           number | null;
  corpus_size:              number | null;
  estimated_duration_label: string;
  sample_size:              number | null;
}

/** One node in the Insight Trail timeline (NUMERICs coerced). */
export interface TrailCheckpoint {
  id:            string;
  number:        number;
  lane:          TrailLane;
  run_mode:      string | null;
  trigger:       string | null;
  nps:           number | null;
  csat:          number | null;
  ces:           number | null;
  delta:         CheckpointDelta | null;
  meaningful:    boolean;
  created_at:    string;
  created_by:    string | null;
  report_label:  string | null;
  report_id?:    string | null;
  window_start:  string | null;
  window_end:    string | null;
  response_count?: number | null;
  tier_label?:     'first_voices' | 'early_signals' | 'growing_picture' | 'full_report' | null;
}

/** A report row surfaced in the trail (manual run or custom analysis). */
export interface TrailReport {
  id:                   string;
  label:                string | null;
  name?:                string | null;
  mode:                 string | null;
  report_type:          'manual' | 'custom';
  created_at:           string;
  created_by:           string | null;
  window_start:         string | null;
  window_end:           string | null;
  // Custom analysis fields (present when report_type === 'custom')
  trust_score_avg?:     number | null;
  corpus_coverage_pct?: number | null;
  sample_size?:         number | null;
  slug?:                string | null;
}

/** GET /api/insights/:surveyId/trail response. */
export interface InsightTrailResult {
  checkpoints: TrailCheckpoint[];
  reports:     TrailReport[];
  next_cursor: string | null;
}

/** Lineage info returned by the checkpoint detail endpoint. */
export interface CheckpointDetail {
  checkpoint:    TrailCheckpoint;
  /** Raw lineage JSON from the DB (pipeline_version, prior_checkpoint_refs, run_mode, etc.) */
  lineage_json?: Record<string, unknown> | null;
  delta:         CheckpointDelta | null;
  blob_ref?:     string | null;
  /** Inline blob document (dev / local only). */
  document?:     unknown;
  /** Signed read URL for the report blob (production). */
  blob_url?:     string | null;
  /** v2 | legacy — which table the row came from. */
  source?:       'v2' | 'legacy';
}

/** GET /api/insights/:surveyId/trail/:a/compare/:b response. */
export interface CheckpointComparison {
  a:             TrailCheckpoint;
  b:             TrailCheckpoint;
  metric_deltas: { nps: number | null; csat: number | null; ces: number | null };
  topic_diff:    { added: string[]; removed: string[] };
}

/** A persisted insight report document + optional rendered body. */
export interface InsightReport {
  report:    Record<string, unknown>;
  document?: Record<string, unknown> | null;
}

// ── Insight Pipeline v2 — Phase 5 (Settings) ──────────────────────────────────

/** The effective merged insight settings + each layer + provenance. */
export interface InsightSettings {
  survey_id:        string;
  effective:        Record<string, unknown>;
  survey_overrides: Record<string, unknown>;
  org_defaults:     Record<string, unknown>;
  config_hash:      string | null;
  config_version:   number | null;
  /** True when the requester may PATCH (admin or survey owner). */
  editable:         boolean;
}

/** Response from PATCH /api/insights/:surveyId/settings. */
export interface InsightSettingsPatchResult {
  survey_overrides: Record<string, unknown>;
  config_version:   number | null;
  config_hash:      string | null;
}

/** Org-level insight defaults (admin-editable template). */
export interface OrgInsightDefaults {
  org_id:     string;
  defaults:   Record<string, unknown>;
  updated_at: string | null;
  updated_by: string | null;
}

// ── Insight Pipeline v2 — Phase 6 (Custom Analysis) ───────────────────────────

/** Filter spec for a custom analysis run. */
export interface CustomReportFilterSpec {
  date_from?:     string | null;
  date_to?:       string | null;
  segments?:      string[];
  topics?:        string[];
  metric_types?:  string[];
  narrative_depth?: 'brief' | 'standard' | 'deep' | string;
}

/** Body for POST /api/reports/custom. */
export interface CustomReportRequest {
  survey_id:   string;
  name:        string;
  filter_spec: CustomReportFilterSpec;
}

/** 202 response from POST /api/reports/custom. */
export interface CustomReportResponse {
  report_id: string;
  run_id:    string;
  status:    'pending' | string;
  slug:      string;
}

/** Body for POST /api/reports/custom/preview. */
export interface CustomReportPreviewRequest {
  survey_id:   string;
  filter_spec: CustomReportFilterSpec;
}

/** Preview estimate for a custom analysis run (NUMERICs coerced). */
export interface CustomReportPreview {
  estimated_cost: number | null;
  corpus_size:    number | null;
  sample_size:    number | null;
  low_confidence: boolean;
}

/** A custom report row (list + detail header). */
export interface CustomReport {
  id:           string;
  survey_id:    string;
  name:         string;
  slug:         string | null;
  status:       'pending' | 'running' | 'completed' | 'failed' | string;
  filter_spec:  CustomReportFilterSpec;
  filter_label: string | null;
  corpus_size:  number | null;
  sample_size:  number | null;
  low_confidence: boolean;
  created_at:   string;
  created_by:   string | null;
  completed_at: string | null;
}

/** One custom_report_insights row surfaced in the result view. */
export interface CustomReportInsight {
  id:           string;
  layer:        'descriptive' | 'diagnostic' | 'predictive' | 'prescriptive' | string;
  category:     string | null;
  headline:     string;
  narrative:    string | null;
  trust_score:  number | null;
  filter_label: string | null;
  sample_size:  number | null;
}

/** GET /api/reports/custom/:reportId response. */
export interface CustomReportDetail {
  report:    CustomReport;
  insights:  CustomReportInsight[];
  document?: Record<string, unknown> | null;
}

export interface InsightRunStatus {
  run_id:    string;
  status:    'running' | 'completed' | 'failed';
  progress?: number;
  stream_events: Array<{ event: string; agent: string; data: Record<string, unknown>; timestamp: string }>;
  insights_count?: number;
}

// ── Org Profile ───────────────────────────────────────────────────────────────

export interface OrgProfile {
  id?: number;
  org_id?: string;
  industry?: string | null;
  sub_vertical?: string | null;
  company_size?: string | null;
  use_case?: string | null;
  primary_use_case?: string | null;
  target_audience?: string | null;
  website?: string | null;
  brand_description?: string | null;
  brand_name?: string | null;
  product_name?: string | null;
  region?: string | null;
  logo_url?: string | null;
  brand_colors?: Record<string, string>;
  brand_fonts?: Record<string, string>;
  created_at?: string;
  updated_at?: string;
}

// ── Org & Members ─────────────────────────────────────────────────────────────

export interface Org {
  orgId: string;
  name: string | null;
  logoUrl?: string | null;
}

export interface OrgMember {
  userId: string;
  identifier: string;
  firstName?: string | null;
  lastName?: string | null;
  role: string;
  joinedAt: string;
}

// ── API client ────────────────────────────────────────────────────────────────

export interface ListSurveysParams {
  q?: string;
  status?: SurveyStatus[];
  survey_type_id?: string[];
  sort_by?: string;
  sort_order?: 'asc' | 'desc';
  page?: number;
  limit?: number;
}

export interface ListSurveysResult {
  surveys: Survey[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
  stats: {
    total_surveys: number;
    active_surveys: number;
    total_responses: number;
    avg_nps: number | null;
  };
}

// ── Survey Topics ─────────────────────────────────────────────────────────────

export interface SurveyTopic {
  id: string;
  name: string;
  aliases: string[];
  is_new: boolean;
  volume: number;
  sentiment_score: number | null;    // -1 to 1
  dominant_emotion: string | null;
  effort_score: number | null;       // 1-7
  // Volume direction — are more people talking about this?
  trending: 'up' | 'down' | 'stable' | 'new' | null;
  // Sentiment direction — is it getting better or worse?
  sentiment_momentum: 'improving' | 'worsening' | 'stable' | null;
  // Composite priority score: abs(sentiment) × √volume × (effort/7)
  urgency_score: number | null;
  // Volume change since last pipeline run
  volume_delta: number | null;
  volume_delta_pct: number | null;
  // True when topic has been negative for 3+ consecutive runs
  chronic: boolean;
  first_seen_at: string;
  last_seen_at?: string;
  nps_avg?: number | null;
  nps_correlation?: number | null;   // Pearson r vs NPS score (-1 to 1)
  positive_pct?: number | null;
  negative_pct?: number | null;
  neutral_pct?:  number | null;
  // Hierarchy
  parent_topic_id?: string | null;
  hierarchy_level?: number;          // 0=root topic, 1=subtopic
  sub_topic_count?: number;
  theme?: string | null;             // theme group (e.g. "Checkout Experience")
  // Specialist
  keyword_list?: string[];
  // Extended XM signal fingerprint
  health_label?:         string | null;                   // 'healthy' | 'stable' | 'at-risk'
  confidence_level?:     string | null;                   // 'high' | 'medium' | 'low'
  velocity_pct?:         number | null;                   // response velocity change %
  driver_score?:         number | null;                   // point-biserial correlation (-1 to 1)
  net_sentiment?:        number | null;                   // positive_pct − negative_pct
  nps_impact?:           number | null;                   // topic NPS impact in pts
  promoter_pct?:         number | null;
  detractor_pct?:        number | null;
  passive_pct?:          number | null;
  avg_csat?:             number | null;
  csat_impact?:          number | null;
  avg_effort_score?:     number | null;
  top_verbatims?:        string[] | null;
  emotion_distribution?: Record<string, number> | null;
}

export interface TopicTheme {
  name: string;
  volume: number;
  sentiment_avg: number | null;
  topics: Array<SurveyTopic & { subtopics?: SurveyTopic[] }>;
}

export interface TopicTrendPoint {
  day: string;
  volume: number;
  avg_nps: number | null;
  promoters: number;
  detractors: number;
}

export interface TopicDetail {
  trend_series: TopicTrendPoint[];
  co_occurring: Array<{ name: string; co_count: number; lift?: number | null }>;
  subtopics: SurveyTopic[];
}

export interface TopicVerbatim {
  response_id: string;
  text: string;
  all_texts?: string[];
  nps_score: number | null;
  sentiment: string | null;
  sentiment_score: number | null;
  submitted_at: string;
  topics: string[];
}

export interface TopicDriver {
  id: string;
  name: string;
  volume: number;
  tagged_count: number;
  topic_avg_nps: number | null;
  nps_delta: number | null;       // topic NPS minus overall NPS
  impact_score: number;
  sentiment_score: number | null;
  effort_score: number | null;
  trending: 'up' | 'down' | 'stable' | 'new' | null;
  positive_pct: number | null;
  negative_pct: number | null;
  direction: 'positive' | 'negative' | 'neutral';
}

// ── Copilot ───────────────────────────────────────────────────────────────────

export interface CopilotChange {
  question_id?:  string;
  what_changed?: string;
  action?:       string;  // "added" | "removed" | "edited"
}

// ── Breakpoint ────────────────────────────────────────────────────────────────

export type Breakpoint = 'mobile' | 'tablet' | 'desktop';

// ── Action Proposals (from Crystal action tools + action-recommender skill) ───

export type ActionProposalType =
  | 'create_survey'
  | 'edit_survey'
  | 'distribute'
  | 'workflow'
  | 'template'
  | 'schedule_rerun'
  | 'export_insights'
  // Internal proposal_type aliases from action tool executors
  | 'create_followup_survey'
  | 'edit_survey_questions'
  | 'distribute_to_segment'
  | 'create_workflow'
  | 'create_alert'
  | 'view_template'
  // Tier 3 — Closed-Loop Action Platform
  | 'create_case'
  | 'assign_owner'
  | 'send_slack_alert'
  // Insight Pipeline v2 — Phase 6 (report-related proposals)
  | 'view_report'
  | 'trigger_manual_insight_run'
  | 'generate_intelligence_report';

export interface ActionProposal {
  id:                    string;               // kebab-case unique ID
  type:                  ActionProposalType;
  priority:              'critical' | 'high' | 'medium' | 'low';
  title:                 string;               // imperative label, max 60 chars
  description:           string;               // what + why
  cta_label?:            string;               // button label, default "Apply"
  params:                Record<string, unknown>; // execution params for frontend API
  estimated_time?:       string;
  business_rationale?:   string;
  confidence?:           number;
  tags?:                 string[];
  requires_confirmation: boolean;              // always true — safety guarantee
}

export interface ActionRecommendations {
  actions:       ActionProposal[];
  urgency_level: 'immediate' | 'this_week' | 'this_month' | 'strategic' | null;
  summary:       string | null;
  generated_at:  string | null;
}

// ── Contacts (Tier 3) ────────────────────────────────────────────────────────
export interface Contact {
  id: string;
  org_id: string;
  external_id?: string | null;
  email?: string | null;         // masked if user lacks data:pii
  name?: string | null;          // masked if user lacks data:pii
  phone?: string | null;         // masked if user lacks data:pii
  account_id?: string | null;
  account_name?: string | null;
  segment_attrs: Record<string, string>;
  consent_given: boolean;
  consent_at?: string | null;
  anonymized_at?: string | null;
  data_region: string;
  import_source?: string | null;
  created_at: string;
  updated_at: string;
}

// ── CX Cases (Tier 3) ────────────────────────────────────────────────────────
export type CaseStatus = 'open' | 'in_progress' | 'escalated' | 'resolved' | 'closed';
export type CaseSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface CxCase {
  id: string;
  org_id: string;
  contact_id?: string | null;
  contact?: Contact | null;      // joined
  response_id?: string | null;
  survey_id?: string | null;
  insight_id?: string | null;
  driver_ref?: string | null;
  proposal_id?: string | null;
  title: string;
  description?: string | null;
  category: string;
  status: CaseStatus;
  severity: CaseSeverity;
  owner_user_id?: string | null;
  owner_label?: string | null;
  owner_role?: string | null;
  ack_due_at?: string | null;
  resolve_due_at?: string | null;
  acked_at?: string | null;
  sla_breached: boolean;
  escalation_tier: number;
  external_refs: Record<string, string>;
  resolved_at?: string | null;
  resolution_note?: string | null;
  created_at: string;
  updated_at: string;
  created_by: string;
  audit_log: CaseAuditEntry[];
}

export interface CaseAuditEntry {
  ts: string;
  actor: string;
  action: string;
  from_status?: string | null;
  to_status?: string | null;
  note?: string | null;
}

// ── Ownership Routing (Tier 3) ───────────────────────────────────────────────
export interface OwnershipRoute {
  id: string;
  org_id: string;
  dimension: 'segment' | 'account' | 'touchpoint' | 'driver' | 'survey' | 'category';
  match_value: string;
  match_type: 'exact' | 'prefix' | 'contains' | 'regex';
  owner_user_id: string;
  owner_label?: string | null;
  owner_email?: string | null;
  escalation_user_id?: string | null;
  escalation_label?: string | null;
  priority: number;
  role_label?: string | null;
  created_at: string;
}

// ── Ontology (Tier 3) ─────────────────────────────────────────────────────────
export interface OntologyNode {
  id: string;
  org_id: string;
  category: 'entity' | 'metric' | 'signal' | 'risk' | 'action' | 'concept';
  label: string;
  description?: string | null;
  definition?: string | null;
  synonyms: string[];
  x_data_ref?: string | null;
  x_data_range?: Record<string, number> | null;
  o_data_ref?: string | null;
  platform_node: boolean;
  parent_id?: string | null;
}

// ── Contact Segments (Tier 3) ─────────────────────────────────────────────────
export interface FilterCondition {
  field: string;
  operator: 'eq' | 'neq' | 'contains' | 'starts_with' | 'ends_with' | 'in' | 'before' | 'after' | 'within_days';
  value: string;
}

export interface FilterDef {
  logic: 'AND' | 'OR';
  conditions: FilterCondition[];
}

export interface ContactSegment {
  id: string;
  org_id: string;
  name: string;
  description?: string | null;
  color: string;
  is_dynamic: boolean;
  filter_def: FilterDef;
  contact_count: number;
  last_evaluated_at?: string | null;
  created_by?: string | null;
  created_at: string;
  updated_at: string;
}

// ── CRM Sync (Tier 3) ─────────────────────────────────────────────────────────
export type SyncProvider = 'hubspot' | 'salesforce' | 'webhook' | 'csv_url';

export interface FieldMapping { source: string; dest: string; }

export interface SyncConfig {
  id: string;
  org_id: string;
  name: string;
  provider: SyncProvider;
  config: Record<string, string>;
  field_mappings: FieldMapping[];
  sync_schedule?: 'manual' | 'hourly' | 'daily' | 'weekly' | null;
  is_active: boolean;
  last_synced_at?: string | null;
  last_sync_status?: 'running' | 'completed' | 'failed' | null;
  created_at: string;
  updated_at: string;
}

export interface SyncLog {
  id: string;
  sync_config_id: string;
  status: 'running' | 'completed' | 'failed';
  contacts_fetched: number;
  contacts_created: number;
  contacts_updated: number;
  contacts_failed: number;
  error_detail?: string | null;
  started_at: string;
  completed_at?: string | null;
}

// ── Workflow Credentials / Integrations Settings ──────────────────────────────
// Backend shape per docs/automation-hub/INTEGRATIONS_BACKEND_REVIEW.md — one
// GET call reports all 6 CONNECTORS entries (incl. slack, unified server-side;
// webhook excluded from the settings-page card grid — see IntegrationsSettingsPage).
export type WorkflowConnectorName = 'jira' | 'salesforce' | 'servicenow' | 'zendesk' | 'slack' | 'webhook';

export type WorkflowConnectorStatus = 'org' | 'shared' | 'none';

export interface WorkflowConnectorEntry {
  connector: WorkflowConnectorName;
  status: WorkflowConnectorStatus;
  createdAt?: string;
  updatedAt?: string;
}

export interface ConnectorTestResult {
  success: boolean;
  message?: string;
  checks?: Record<string, string>;
  failedCheck?: string;
}

// ── Activity Timeline (Tier 3) ────────────────────────────────────────────────
export interface ActivityItem {
  type: 'response' | 'case';
  source?: string;
  ts: string;
  id: string;
  survey_id?: string;
  survey_title?: string;
  status?: string;
  severity?: string;
  title?: string;
  linked_by?: string;
}
