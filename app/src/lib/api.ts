import axios from 'axios';
import type {
  ListSurveysParams, ListSurveysResult, Survey, SurveyResponse,
  Template, Workflow, Insight, OrgProfile, Question, Org, OrgMember,
  CopilotChange, AgenticInsight, InsightRunStatus, SurveyTopic, TopicDriver,
  TopicTheme, TopicDetail, TopicVerbatim, ActionRecommendations,
  Contact, CxCase, CaseAuditEntry, OwnershipRoute, OntologyNode,
  ContactSegment, FilterDef, SyncConfig, SyncLog, ActivityItem,
  WorkflowConnectorName, WorkflowConnectorEntry, ConnectorTestResult,
  LatestCheckpoint, CheckpointDelta, RecentCheckpointPoint,
  ManualRunRequest, ManualRunResponse, ManualRunPreviewRequest, ManualRunPreview,
  InsightTrailResult, TrailLane, TrailCheckpoint, TrailReport, CheckpointDetail,
  CheckpointComparison, InsightReport,
  InsightSettings, InsightSettingsPatchResult, OrgInsightDefaults,
  CustomReportRequest, CustomReportResponse, CustomReportPreviewRequest,
  CustomReportPreview, CustomReport, CustomReportDetail,
} from '../types';
import type { SavedDashboardConfig, WidgetConfig, DashboardFilters } from '../types/dashboard';
import type {
  PrismConnection, PrismJob, ConnectorMeta as PrismConnectorMeta,
  DiscoveredResource as PrismDiscoveredResource, ResourceRef as PrismResourceRef,
  RecordType as PrismRecordType, FieldMapping as PrismFieldMapping,
  DryRunReport as PrismDryRunReport, ReconReport as PrismReconReport,
  ParityEntry as PrismParityEntry, CreateConnectionRequest as PrismCreateConnectionRequest,
  CreateJobRequest as PrismCreateJobRequest, ConfirmMappingRequest as PrismConfirmMappingRequest,
  ApproveRequest as PrismApproveRequest, PrismMode,
} from '../types/prism';
import type { EngineNode, EngineEdge } from './workflowCanvas';
import type {
  TagReportRunResponse, TagReportTrailResponse, TagReportsIndexResponse,
  TagReportGenerateRequest, TagReportGenerateResponse, TagReportTrailEntry,
} from '../types/tagReport';
import type {
  OrgDashboardPayload, OrgTrendsResponse, ProgramsResponse, ProgramsQuery,
  OrgTopicsResponse, OrgTopicBreakdown, OrgAlertsResponse, OrgHealthScoreDetail,
  BriefsResponse, CheckpointComparisonResult, TagMetricsResponse,
  SummaryPreviewRequest, SummaryPreviewResponse, CreateSummaryRequest,
  CreateSummaryResponse, OrgSummary, CrystalBrief, TrendRange, TrendGranularity,
} from '../types/orgDashboard';

// ── Prism response-shape guards ──────────────────────────────────────────────
// Small defensive helpers so a FE↔BE response-shape mismatch throws ONE clear,
// named error at the API boundary instead of crashing later on `.id`/`.map`.

/** List the top-level keys of a response body for error messages. */
function describeKeys(obj: unknown): string {
  if (obj == null || typeof obj !== 'object') return String(obj);
  const keys = Object.keys(obj as Record<string, unknown>);
  return keys.length ? keys.join(', ') : '(empty object)';
}

/**
 * Normalize a single-entity response to `{ [key]: entity }` where `entity[idKey]`
 * is present. Tolerates the two historical wrapper shapes:
 *   - canonical: `{ connection: {...} }` / `{ job: {...} }`
 *   - legacy id-only: `{ connectionId: 'x' }` / `{ jobId: 'x' }` → `{ id: 'x' }`
 *   - bare entity: `{ id: 'x', ... }` (no wrapper)
 * Throws a clear, named error if no usable id can be found.
 */
function expectEntity<T>(body: unknown, key: string, idKey: string, method: string): T {
  const obj = (body ?? {}) as Record<string, unknown>;

  // 1) canonical wrapper { [key]: { ...idKey } }
  const wrapped = obj[key];
  if (wrapped && typeof wrapped === 'object' && (wrapped as Record<string, unknown>)[idKey] != null) {
    return wrapped as T;
  }

  // 2) legacy id-only sibling, e.g. { connectionId } / { jobId }
  const legacyIdKey = `${key}Id`;
  if (typeof obj[legacyIdKey] === 'string' || typeof obj[legacyIdKey] === 'number') {
    return { [idKey]: obj[legacyIdKey] } as unknown as T;
  }

  // 3) bare entity at the top level, e.g. { id, ... }
  if (obj[idKey] != null) {
    return obj as unknown as T;
  }

  throw new Error(
    `${method}: backend returned no ${key}.${idKey} (got keys: ${describeKeys(body)})`,
  );
}

/** Normalize a list response to `T[]` under `key`; throws if the value isn't an array (when present). */
function expectArray<T>(body: unknown, key: string, method: string): T[] {
  const obj = (body ?? {}) as Record<string, unknown>;
  const v = obj[key];
  if (v == null) return [];
  if (!Array.isArray(v)) {
    throw new Error(`${method}: expected ${key} to be an array (got keys: ${describeKeys(body)})`);
  }
  return v as T[];
}

// ── Copilot types ──────────────────────────────────────────────────────────────
export interface OrgContext {
  industry?: string;
  size?: string;
  use_case?: string;
  target_audience?: string;
  prior_survey_count?: number;
  brand_description?: string;
  region?: string;
}

export interface RunStatus {
  run_id:           string;
  thread_id:        string;
  status:           'running' | 'completed' | 'failed' | 'cancelled' | 'waiting_approval';
  stream_events:    StreamEvent[];
  qc_score?:        number;
  compliance_risk?: string;
  questions?:       Question[];
  recommendations:  Recommendation[];
  credit_summary:   Record<string, unknown>;
  error?:           string;
  error_log?:       string[];
  validation_warnings: string[];
}

export interface StreamEvent {
  event:     string;
  agent:     string;
  data:      Record<string, unknown>;
  timestamp: string;
}

export interface Recommendation {
  action:     string;
  label:      string;
  reason:     string;
  priority:   'high' | 'medium' | 'low';
  cta:        string;
  confidence: number;
}

export interface CopilotRefineResult {
  questions:       Question[];
  explanation:     string;
  response_type:   'edit' | 'answer';
  changes:         CopilotChange[];
  suggestions:     string[];
  recommendations?: Recommendation[];
}

export interface QuestionsResult {
  questions:        Question[];
  message:          string;
  changes:          Record<string, unknown>[];
  recommendations?: Recommendation[];
  compliance_risk?: string;  // "low" | "medium" | "high" — set by check_compliance action
}

export interface Notification {
  id:         string;
  type:       string;
  title:      string;
  body:       string;
  payload:    Record<string, unknown>;
  run_id?:    string;
  read:       boolean;
  created_at: string;
  // v2 additions (optional so existing consumers keep working)
  priority?:   'critical' | 'warning' | 'info' | 'success' | 'digest';
  actionUrl?:  string | null;
  entityType?: string | null;
}

export interface NotificationPreference {
  notificationType: string;
  inAppEnabled: boolean;
  emailEnabled: boolean;
  slackEnabled: boolean;
  thresholdConfig?: Record<string, unknown>;
}

// ── User Directory types ─────────────────────────────────────────────────────

export type PermissionScope = 'ALL' | 'OWNED' | 'SHARED' | 'OWN' | 'NONE';
export type UserStatus = 'active' | 'pending' | 'deactivated';

export interface DirectoryUser {
  userId: string;
  orgId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  phone: string | null;
  employeeId: string | null;
  jobTitle: string | null;
  departmentId: string | null;
  departmentName: string | null;
  managerUserId: string | null;
  costCenter: string | null;
  location: string | null;
  timezone: string | null;
  locale: string | null;
  roleId: string | null;
  roleKey: string | null;
  roleName: string | null;
  seatWeight: number | null;
  isActive: boolean;
  status: UserStatus;
  lastSeenAt: string | null;
  customAttributes: Record<string, unknown>;
  surveySegments: string[];
  provisionedBy: string | null;
  createdAt: string;
  updatedAt: string;
  deprovisionedAt: string | null;
}

export interface DirectoryRole {
  id: string;
  orgId: string;
  name: string;
  description: string | null;
  isBuiltin: boolean;
  builtinKey: string | null;
  permissions: Record<string, PermissionScope>;
  seatWeight: number | null;
  color: string | null;
  assignedCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface ListUsersParams {
  search?: string;
  roleId?: string;
  roleKey?: string;
  departmentId?: string;
  status?: 'active' | 'inactive';
  limit?: number;
  offset?: number;
}

export interface UpdateUserPayload {
  firstName?: string | null;
  lastName?: string | null;
  displayName?: string | null;
  jobTitle?: string | null;
  employeeId?: string | null;
  phone?: string | null;
  costCenter?: string | null;
  location?: string | null;
  departmentId?: string | null;
  managerUserId?: string | null;
  roleId?: string | null;
  isActive?: boolean;
}

export interface WorkflowTemplate {
  slug: string; name: string; description: string; category: string | null;
  trigger_type: string | null; nodes: unknown[]; edges: unknown[]; is_featured: boolean;
}

// notify.email / notify.in_app recipient targeting (Wave 9, see
// docs/automation-hub/TEMPLATE_FLOW_AND_RECIPIENT_TARGETING_SPEC.md §Issue 2 and
// TRACKER.md's Wave 9 section for Nina's real, tested backend contract).
// Discriminated union — `targetType` says which id field is authoritative.
export type NotifyTarget =
  | { targetType: 'users'; userIds: string[] }
  | { targetType: 'role'; roleId: string }
  | { targetType: 'department'; departmentId: string }
  | { targetType: 'group'; groupId: string };

export interface NotificationTargetOption {
  id: string;
  name: string;
  memberCount: number;
}

export interface NotificationTargetsResponse {
  roles: NotificationTargetOption[];
  departments: NotificationTargetOption[];
  groups: NotificationTargetOption[];
}

// Both execution- and step-level `error_message` are now humanized objects
// (Nina, 2026-07-01, backend/src/lib/humanizeExecutionError.ts) — `raw` is the
// original unmodified exception string, `message` is the plain-language
// version (equal to `raw` when no known pattern matched), `matched` says
// whether a known pattern was found. `null` when there was no error at all
// (e.g. a `completed` execution, or a gracefully-`skipped` step whose reason
// lives on `output.reason` instead — see `WorkflowExecutionStep`).
export interface HumanizedExecutionError {
  raw: string;
  message: string;
  matched: boolean;
}

// GET /api/workflows/:id/executions now returns a `steps[]` array per
// execution (previously only a bare `step_count`) — see
// docs/automation-hub/TRACKER.md Wave 10, findings R-1/R-2/§9a.
export interface WorkflowExecutionStep {
  nodeId: string;
  nodeType: string;
  status: string;
  // Graceful-skip reason machine code (e.g. 'role_has_no_members',
  // 'no_recipient_configured', 'no_url') lives here, NOT on errorMessage —
  // a skipped step has a null error_message in the DB by design (it never
  // threw), so humanizeExecutionError(null, ...) always returns null for it.
  output: { reason?: string; [k: string]: unknown } | null;
  errorMessage: HumanizedExecutionError | null;
}

export interface WorkflowExecution {
  id: string; trigger_type: string; status: string; triggered_at: string;
  completed_at: string | null; duration_ms: number | null;
  error_message: HumanizedExecutionError | null;
  step_count: number;
  steps: WorkflowExecutionStep[];
  // Dead-letter/retry columns (audit §9a) — previously captured in the schema
  // but never selected by this endpoint. Only meaningful once a step has
  // actually failed and been queued for retry.
  attempt_count: number;
  next_retry_at: string | null;
  dead_letter: boolean;
}

// GET /api/workflows/:id/audit-log — config-change history (Wave 11, Nina —
// TRACKER.md Wave 11 Part 1, backend/src/routes/workflows.ts). Distinct from
// WorkflowExecution above: this is "who changed the workflow's
// config/status" (create/update/status_changed/delete), not "when did it
// run." Response shape mirrors routes/auditLogs.ts's existing
// page/limit/events/total/pages convention exactly.
export type WorkflowAuditAction = 'created' | 'updated' | 'status_changed' | 'deleted';

export interface WorkflowAuditEvent {
  id: string;
  workflowId: string;
  actorUserId: string | null;
  action: WorkflowAuditAction;
  summary: Record<string, unknown>;
  createdAt: string;
}

export interface WorkflowAuditLogResponse {
  events: WorkflowAuditEvent[];
  total: number;
  page: number;
  limit: number;
  pages: number;
}

// GET /api/workflows/registry — Trigger.live / ActionDef.live are the
// registry's own readiness signals (Wave 10, Kenji findings 1/2 / Maya 2c,6c /
// Rohan T-1,I-1): `live: boolean` on every trigger (real backend producer
// wired up or not), `live: boolean | 'stub' | 'env'` on every action (fully
// wired / stubbed / requires env-level connector config).
export interface WorkflowRegistryTrigger {
  type: string;
  label: string;
  category: string;
  live: boolean;
}

export interface WorkflowRegistryAction {
  action: string;
  label: string;
  category: string;
  live: boolean | 'stub' | 'env';
}

export interface WorkflowRegistryConditionField {
  field: string;
  label: string;
  kind: 'number' | 'string';
}

export interface WorkflowRegistryResponse {
  triggers: WorkflowRegistryTrigger[];
  conditionFields: WorkflowRegistryConditionField[];
  conditionOperators: string[];
  actions: WorkflowRegistryAction[];
}

// POST /api/workflows/parse-nl — Amara's Wave 3 CrystalOS NL parser (not yet built;
// see docs/automation-hub/BUILDER_SPEC_WAVE2.md §2.1). Frontend calls the real
// contract now so no changes are needed once the backend route ships.
export interface ParseWorkflowNLResult {
  name: string;
  description: string;
  triggerType: string;
  nodes: EngineNode[];
  edges: EngineEdge[];
  confidence: number;
  warnings: string[];
  // Scope hint (Wave 12, docs/automation-hub/BUILDER_REDESIGN_V2_SCOPE.md) —
  // populated when Crystal's NL parser confidently matched a survey/tag
  // mentioned in the description against a real org survey/tag. All three are
  // optional/absent when Crystal didn't detect a scope mention (or an older
  // backend/CrystalOS deploy doesn't send them yet) — absence means org-wide
  // scope, identical to pre-Wave-12 behavior. Type-only for now; the
  // consuming confirm-card UI (ScopeSummaryRow) is Phase 2.
  scopeType?: 'org' | 'survey' | 'tag';
  scopeSurveyId?: string;
  scopeTagId?: string;
}

export interface ParseWorkflowNLUnparseableError {
  error: 'unparseable';
  message: string;
  suggestions: string[];
}

export type ParseWorkflowNLErrorCode = 'UNPARSEABLE' | 'TIMEOUT' | 'ABORTED' | 'UNKNOWN';

// Mirrors ManualRunError's pattern: the shared `http` instance's response
// interceptor flattens every failure into a bare Error(message), which loses
// the status code and (for a 422) the `suggestions` array the low-confidence/
// error UI needs to render distinct states. Uses `rawHttp` + this dedicated
// error type instead so callers can branch on `.code`.
export class ParseWorkflowNLError extends Error {
  code: ParseWorkflowNLErrorCode;
  status?: number;
  suggestions?: string[];
  constructor(code: ParseWorkflowNLErrorCode, message: string, status?: number, suggestions?: string[]) {
    super(message);
    this.name = 'ParseWorkflowNLError';
    this.code = code;
    this.status = status;
    this.suggestions = suggestions;
  }
}

function toParseWorkflowNLError(error: unknown): ParseWorkflowNLError {
  const e = error as { code?: string; name?: string; response?: { status?: number; data?: Record<string, unknown> }; message?: string };
  if (e?.code === 'ERR_CANCELED' || e?.name === 'CanceledError') {
    return new ParseWorkflowNLError('ABORTED', 'Request aborted');
  }
  const status = e?.response?.status;
  const data = e?.response?.data ?? {};
  if (status === 422) {
    return new ParseWorkflowNLError(
      'UNPARSEABLE',
      String(data.message ?? 'Crystal could not turn that into a workflow'),
      status,
      Array.isArray(data.suggestions) ? (data.suggestions as string[]) : [],
    );
  }
  if (status === 504) {
    return new ParseWorkflowNLError('TIMEOUT', 'Crystal did not respond in time', status);
  }
  return new ParseWorkflowNLError('UNKNOWN', String(data.message ?? e?.message ?? 'Failed to parse workflow'), status);
}

export interface ChartSpec {
  chartType: 'bar' | 'line' | 'area' | 'pie' | 'scatter';
  x: string;
  y: string;
  aggregate: 'avg' | 'count';
  title: string;
  rationale: string;
  encoding: Record<string, unknown>;
}

export interface DashboardKpis {
  nps: number | null; npsDelta: number | null;
  csat: number | null; csatDelta: number | null;
  responses: number; responsesDelta: number;
  activeSurveys: number;
}
export interface DashboardForecast {
  slope: number; intercept: number; points: number[]; direction: 'up' | 'down' | 'flat'; r2: number;
}
export interface ChartAnomaly { index: number; value: number; z: number; direction: 'up' | 'down' }
export interface DashboardSummary {
  kpis: DashboardKpis;
  topMover: { title: string; npsDelta: number } | null;
  narrative: { headline: string; paragraphs: string[]; sentiment: 'positive' | 'negative' | 'neutral' };
  forecast: DashboardForecast | null;
  anomalies: ChartAnomaly[];
}
export interface DashboardInsights {
  actionItems: Array<{ id: string; alertType: string; severity: string; title: string; description: string; triggeredAt: string }>;
  recentActivity: Array<{ id: string; type: string; priority: string; title: string; createdAt: string }>;
  discoveryCount: number;
}
export interface DashboardOperations {
  surveys: Array<{
    id: string; title: string; status: string; responseCount: number;
    lastResponseAt: string | null; nps: number | null; csat: number | null;
    metricsAt: string | null; freshness: 'fresh' | 'stale' | 'none';
  }>;
  anomalies: Array<{ id: string; alertType: string; severity: string; title: string; triggeredAt: string }>;
}

export type AlertSeverity = 'critical' | 'warning' | 'info' | 'success';
export type AlertStatus = 'active' | 'acknowledged' | 'snoozed' | 'resolved';

export interface AlertTypeDef {
  code: string;
  name: string;
  severity: AlertSeverity;
  evaluator: boolean | 'crystal';
  category: string;
  categoryName: string;
  thresholds: Record<string, unknown>;
}

export interface AlertSubscription {
  alertType: string;
  inAppEnabled: boolean;
  emailEnabled: boolean;
  slackEnabled: boolean;
}

export interface AlertRule {
  id: string;
  orgId: string;
  surveyId: string | null;
  alertType: string;
  name: string;
  description: string | null;
  isActive: boolean;
  isSystem: boolean;
  severity: AlertSeverity;
  thresholdConfig: Record<string, unknown>;
  createdAt: string;
}

export interface AlertEvent {
  id: string;
  ruleId: string;
  surveyId: string | null;
  alertType: string;
  severity: AlertSeverity;
  title: string;
  description: string;
  crystalNarration: string | null;
  crystalAction: string | null;
  metricValue: number | null;
  metricBaseline: number | null;
  metricChange: number | null;
  status: AlertStatus;
  triggeredAt: string;
  snoozedUntil: string | null;
}

export interface SeatBreakdown {
  planTier: 'starter' | 'growth' | 'enterprise';
  seatLimit: number | null;
  billableSeats: number;
  available: number | null;
  gracePeriodEnd: string | null;
  byRole: Array<{ roleName: string; builtinKey: string | null; seatWeight: number; activeUsers: number; billable: number }>;
}

export interface AuditEvent {
  id: string;
  eventType: string;
  actorUserId: string | null;
  actorName: string | null;
  actorEmail: string | null;
  actorType: string;
  targetUserId: string | null;
  targetName: string | null;
  targetResourceType: string | null;
  targetResourceId: string | null;
  ipAddress: string | null;
  occurredAt: string;
}

export interface ScimToken {
  id: string;
  name: string;
  tokenPrefix: string;
  provider: string | null;
  lastUsedAt: string | null;
  lastSyncAt: string | null;
  syncStats: Record<string, unknown> | null;
  isActive: boolean;
  createdAt: string;
  revokedAt: string | null;
}

export type GroupType = 'static' | 'dynamic' | 'scim_synced';

export interface DepartmentNode {
  id: string;
  name: string;
  description: string | null;
  parentDepartmentId: string | null;
  headUserId: string | null;
  headDisplayName: string | null;
  headAvatarUrl: string | null;
  depth: number;
  path: string[] | null;
  color: string | null;
  sortOrder: number;
  directMemberCount: number;
  totalMemberCount?: number;
  children?: DepartmentNode[];
}

export interface DynamicRule { field: string; op: string; value: unknown }
export interface DynamicRuleSet { operator: 'AND' | 'OR'; rules: DynamicRule[] }

export interface UserGroup {
  id: string;
  name: string;
  description: string | null;
  groupType: GroupType;
  dynamicRules: DynamicRuleSet | null;
  scimExternalId: string | null;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface GroupMember {
  userId: string;
  displayName: string | null;
  email: string | null;
  avatarUrl: string | null;
  jobTitle: string | null;
  addedAt: string;
}

// ── Time-series types ──────────────────────────────────────────────────────────

export interface MetricSnapshot {
  captured_at:          string;
  response_count:       number | null;
  nps:                  number | null;
  nps_ci_low:           number | null;
  nps_ci_high:          number | null;
  nps_n:                number | null;
  promoter_pct:         number | null;
  detractor_pct:        number | null;
  passive_pct:          number | null;
  csat:                 number | null;
  completion_rate:      number | null;
  effort_score:         number | null;
  response_velocity_7d: number | null;
  anomaly_flag:         boolean;
}

export interface OrgMetricSnapshot {
  captured_at:          string;
  active_survey_count:  number | null;
  total_responses:      number | null;
  avg_nps:              number | null;
  avg_csat:             number | null;
  avg_completion_rate:  number | null;
  top_urgent_topic:     string | null;
  top_driver_topic:     string | null;
}

export interface TopicWindow {
  window_start:         string;
  window_end:           string;
  response_count:       number;
  avg_sentiment_score:  number | null;
  avg_nps:              number | null;
  health_label:         string | null;
  net_sentiment:        number | null;
  nps_impact:           number | null;
  urgency_score:        number | null;
  velocity_pct:         number | null;
  promoter_pct:         number | null;
  detractor_pct:        number | null;
  emotion_distribution: Record<string, number> | null;
}

export interface TopicTrend {
  topic_id:   string;
  topic_name: string;
  windows:    TopicWindow[];
}

// ── Survey Tag types ──────────────────────────────────────────────────────────

export interface SurveyTag {
  id: string;
  name: string;
  slug: string;
  color: string;
  description?: string;
  program_config?: Record<string, unknown>;
  survey_count?: number;
  created_at: string;
}

export interface GroupInsightRun {
  id: string;
  org_id: string;
  tag_ids: string[];
  survey_ids: string[];
  status: 'pending' | 'running' | 'completed' | 'failed';
  stream_events: Array<{ event: string; data: Record<string, unknown> }>;
  result_json?: Record<string, unknown>;
  created_at: string;
  completed_at?: string;
}

export interface GroupInsight {
  id: string;
  layer: 'descriptive' | 'diagnostic' | 'predictive' | 'prescriptive';
  category: string;
  headline: string;
  narrative: string;
  trust_score?: number;
  priority?: number;
  data_gap_signals?: unknown[];
  suggested_survey_types?: string[];
  suggested_survey_json?: Record<string, unknown>;
}

const BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';

export type GetToken = () => Promise<string | null>;

// ── Manual-run typed errors ──────────────────────────────────────────────────
// The /runs endpoints surface domain failures via HTTP status + a `code` field.
// We rethrow these as a typed error so the ManualRunDialog can branch on `.code`
// (402 → credits, 429 → daily limit) rather than parsing message strings.
export type ManualRunErrorCode =
  | 'INSUFFICIENT_CREDITS'
  | 'RATE_LIMITED'
  | 'INSUFFICIENT_DATA'
  | 'UNKNOWN';

export class ManualRunError extends Error {
  code: ManualRunErrorCode;
  status?: number;
  detail?: Record<string, unknown>;
  constructor(code: ManualRunErrorCode, message: string, status?: number, detail?: Record<string, unknown>) {
    super(message);
    this.name = 'ManualRunError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

// ── Workflow-credentials typed errors ─────────────────────────────────────────
// Test Connection needs the raw status code (specifically 429 from
// connectorTestLimiter — see docs/automation-hub/INTEGRATIONS_BACKEND_REVIEW.md
// §5) so the UI can show a specific "you're testing too often" message instead
// of a generic failure. The default `http` instance's response interceptor
// collapses every error into a bare `Error(message)`, discarding the status —
// so this call goes through `rawHttp` instead (same reasoning as `triggerManualRun`).
export class ConnectorTestError extends Error {
  status?: number;
  rateLimited: boolean;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ConnectorTestError';
    this.status = status;
    this.rateLimited = status === 429;
  }
}

// ── Workflow concurrent-edit conflict (Wave 11, Nina — TRACKER.md Wave 11
// Part 2, backend/src/routes/workflows.ts) ────────────────────────────────
// `PUT /api/workflows/:id` returns 409 + `{ error, workflow }` when the
// caller's `version` is stale — the builder needs both the message AND the
// current server-side workflow snapshot (for "Reload latest"). Same
// reasoning as ConnectorTestError: the default `http` instance's response
// interceptor flattens every error into a bare `Error(message)`, discarding
// both the status code and the response body — so `updateWorkflow` goes
// through `rawHttp` instead.
export class WorkflowConflictError extends Error {
  status?: number;
  isConflict: boolean;
  serverWorkflow?: Workflow;
  constructor(message: string, status?: number, serverWorkflow?: Workflow) {
    super(message);
    this.name = 'WorkflowConflictError';
    this.status = status;
    this.isConflict = status === 409;
    this.serverWorkflow = serverWorkflow;
  }
}

/** Normalize an axios error from a /runs call into a ManualRunError. */
function toManualRunError(error: unknown): ManualRunError {
  const e = error as { response?: { status?: number; data?: Record<string, unknown> }; message?: string };
  const status = e?.response?.status;
  const data = e?.response?.data ?? {};
  const rawCode = String(data.code ?? '').toUpperCase();
  let code: ManualRunErrorCode = 'UNKNOWN';
  if (status === 402 || rawCode === 'INSUFFICIENT_CREDITS') code = 'INSUFFICIENT_CREDITS';
  else if (status === 429 || rawCode === 'RATE_LIMITED') code = 'RATE_LIMITED';
  else if (status === 400 && rawCode === 'INSUFFICIENT_DATA') code = 'INSUFFICIENT_DATA';
  const message = String((data.error as string) ?? (data.message as string) ?? e?.message ?? 'Manual run failed');
  return new ManualRunError(code, message, status, data);
}

function createAxiosInstance(getToken: GetToken) {
  const instance = axios.create({ baseURL: BASE });

  instance.interceptors.request.use(async (config) => {
    const token = await getToken();
    if (token) {
      config.headers = config.headers ?? {};
      config.headers['Authorization'] = `Bearer ${token}`;
    }
    return config;
  });

  instance.interceptors.response.use(
    (response) => response,
    (error) => {
      const message =
        error.response?.data?.error ||
        error.response?.statusText ||
        `HTTP ${error.response?.status}` ||
        error.message;
      return Promise.reject(new Error(message));
    }
  );

  return instance;
}

// ── Admin support pipeline: Postgres snake_case → UI camelCase ───────────────

function mapQueuedDoc(row: Record<string, unknown>): QueuedDoc {
  return {
    id:                  String(row.id ?? ''),
    title:               String(row.title ?? ''),
    docKey:              String(row.key ?? row.docKey ?? ''),
    qualityScore:        Number(row.quality_score ?? row.qualityScore ?? 0),
    status:              String(row.pipeline_status ?? row.status ?? 'queued') as PipelineStatus,
    autoApproveDeadline: (row.auto_approve_deadline ?? row.autoApproveDeadline ?? null) as string | null,
    humanEdited:         Boolean(row.human_edited ?? row.humanEdited ?? false),
    sourceUrl:           (row.source_ref ?? row.sourceUrl ?? null) as string | null,
    version:             Number(row.version ?? 1),
    updatedAt:           String(row.updated_at ?? row.updatedAt ?? ''),
    createdAt:           String(row.created_at ?? row.createdAt ?? ''),
  };
}

function mapPipelineEvent(row: Record<string, unknown>): PipelineEvent {
  return {
    id:         String(row.id ?? ''),
    docId:      String(row.doc_id ?? row.docId ?? ''),
    docTitle:   String(row.doc_title ?? row.docTitle ?? ''),
    eventType:  String(row.event_type ?? row.eventType ?? ''),
    actor:      (row.actor_id ?? row.actor ?? null) as string | null,
    actorType:  String(row.actor_type ?? row.actorType ?? 'system') as PipelineEvent['actorType'],
    occurredAt: String(row.created_at ?? row.occurredAt ?? ''),
  };
}

function qualityBreakdownFromScore(score: number): QualityBreakdown {
  const s = Math.min(1, Math.max(0, score));
  return {
    accuracy:      s,
    completeness:  s * 0.95,
    clarity:       s * 0.9,
    searchability: s * 0.92,
    actionability: s * 0.88,
  };
}

function mapAdminDocDetail(raw: Record<string, unknown>): AdminDocDetail {
  const docRow = (raw.doc ?? {}) as Record<string, unknown>;
  const sectionRows = (raw.sections ?? []) as Record<string, unknown>[];
  const eventRows = (raw.events ?? raw.pipelineHistory ?? []) as Record<string, unknown>[];

  const sections: AdminDocSection[] = sectionRows.map((s) => ({
    key:     String(s.section_key ?? s.key ?? ''),
    heading: String(s.heading ?? s.section_key ?? s.key ?? ''),
    content: String(s.content ?? ''),
  }));

  const locks = sectionRows
    .filter((s) => s.human_locked || s.locked)
    .map((s) => ({
      sectionKey: String(s.section_key ?? s.key ?? ''),
      lockedBy:   String(s.locked_by ?? s.lockedBy ?? 'admin'),
    }));

  const doc = mapQueuedDoc(docRow);
  const score = doc.qualityScore;

  return {
    doc,
    sections,
    oldSections: (raw.oldSections as AdminDocSection[] | undefined) ?? [],
    locks,
    pipelineHistory: eventRows.map(mapPipelineEvent),
    qualityBreakdown: (raw.qualityBreakdown as QualityBreakdown | undefined)
      ?? qualityBreakdownFromScore(score > 1 ? score / 100 : score),
  };
}

function mapDocGap(row: Record<string, unknown>): DocGap {
  return {
    id:              String(row.id ?? ''),
    query:           String(row.query ?? ''),
    feedbackType:    String(row.feedback_type ?? row.feedbackType ?? ''),
    crystalIntent:   (row.crystal_intent ?? row.crystalIntent ?? null) as string | null,
    occurrenceCount: Number(row.occurrence_count ?? row.occurrenceCount ?? 1),
    firstSeenAt:     String(row.first_seen_at ?? row.created_at ?? row.firstSeenAt ?? ''),
    lastSeenAt:      String(row.last_seen_at ?? row.created_at ?? row.lastSeenAt ?? ''),
    resolvedAt:      (row.resolved_at ?? row.resolvedAt ?? null) as string | null,
    resolution:      (row.resolution ?? null) as DocGap['resolution'],
  };
}

function mapPipelineStats(raw: Record<string, unknown>): PipelineStats {
  const byStatus = (raw.byStatus ?? raw.statusDistribution ?? {}) as Record<string, number>;
  return {
    docsLive:            Number(raw.totalLive ?? raw.docsLive ?? 0),
    docsLiveDelta:       Number(raw.docsLiveDelta ?? 0),
    publishedToday:      Number(raw.last24hPublished ?? raw.publishedToday ?? 0),
    publishedTodayDelta: Number(raw.publishedTodayDelta ?? 0),
    gapsOpen:            Number(raw.totalGaps ?? raw.gapsOpen ?? 0),
    avgQualityScore:     Number(raw.avgQualityScore ?? 0),
    statusDistribution:  byStatus as Record<PipelineStatus, number>,
    qualityHistogram:    (raw.qualityHistogram as PipelineStats['qualityHistogram']) ?? [],
  };
}

export function createApiClient(getToken: GetToken) {
  const http = createAxiosInstance(getToken);

  // Auth-injected instance WITHOUT the response interceptor, so callers can read
  // the original `error.response` (status + `code`). Used by the manual-run
  // endpoints which surface 402/429 domain codes the dialog branches on.
  const rawHttp = axios.create({ baseURL: BASE });
  rawHttp.interceptors.request.use(async (config) => {
    const token = await getToken();
    if (token) {
      config.headers = config.headers ?? {};
      config.headers['Authorization'] = `Bearer ${token}`;
    }
    return config;
  });

  return {
    // Surveys
    listSurveys: async (params: ListSurveysParams = {}) => {
      const qs = new URLSearchParams();
      if (params.q)                      qs.set('q',              params.q);
      if (params.status?.length)         qs.set('status',         params.status.join(','));
      if (params.survey_type_id?.length) qs.set('survey_type_id', params.survey_type_id.join(','));
      if (params.sort_by)                qs.set('sort_by',        params.sort_by);
      if (params.sort_order)             qs.set('sort_order',     params.sort_order);
      if (params.page)                   qs.set('page',           String(params.page));
      if (params.limit)                  qs.set('limit',          String(params.limit));
      const query = qs.toString() ? `?${qs}` : '';
      const res = await http.get<ListSurveysResult>(`/api/surveys${query}`);
      return res.data;
    },
    getSurvey: async (id: string) => {
      const res = await http.get<{ survey: Survey }>(`/api/surveys/${id}`);
      return res.data;
    },
    // Response Detail (R-T5 audit-trail terminus, TRACKER.md Task 16). Survey-scoped
    // so the backend can re-check per-survey access on every request; returns null
    // on 404 (soft-deleted or not found) so the page can render a graceful state.
    getSurveyResponse: async (surveyId: string, responseId: string): Promise<{ response: SurveyResponse } | null> => {
      try {
        const res = await http.get<{ response: SurveyResponse }>(`/api/surveys/${surveyId}/responses/${responseId}`);
        return res.data;
      } catch {
        return null;
      }
    },
    createSurvey: async (data: Partial<Survey>) => {
      const res = await http.post<{ survey: Survey }>('/api/surveys', data);
      return res.data;
    },
    updateSurvey: async (id: string, data: Partial<Survey>) => {
      const res = await http.put<{ success: boolean }>(`/api/surveys/${id}`, data);
      return res.data;
    },
    deleteSurvey: async (id: string) => {
      const res = await http.delete<{ success: boolean }>(`/api/surveys/${id}`);
      return res.data;
    },
    publishSurvey: async (id: string, settings?: {
      maxResponses?: number | null;
      autoCloseAt?: string | null;
      allowMultipleResponses?: boolean;
      passwordProtected?: boolean;
      password?: string;
    }) => {
      const res = await http.post<{
        publishToken: string;
        publishedAt: string;
        maxResponses?: number | null;
        autoCloseAt?: string | null;
        allowMultipleResponses?: boolean;
        passwordProtected?: boolean;
      }>(`/api/surveys/${id}/publish`, settings ?? {});
      return res.data;
    },

    updateLaunchSettings: async (id: string, settings: {
      maxResponses?: number | null;
      autoCloseAt?: string | null;
      allowMultipleResponses?: boolean;
      passwordProtected?: boolean;
      password?: string;
    }) => {
      const res = await http.patch<{
        maxResponses?: number | null;
        autoCloseAt?: string | null;
        allowMultipleResponses?: boolean;
        passwordProtected?: boolean;
      }>(`/api/surveys/${id}/launch-settings`, settings);
      return res.data;
    },

    verifyPassword: async (token: string, password: string) => {
      const publicHttp = axios.create({ baseURL: BASE });
      const res = await publicHttp.post<{ valid: boolean }>(
        `/api/public/surveys/${token}/verify-password`,
        { password },
      );
      return res.data;
    },

    generateSampleResponses: async (surveyId: string, opts: {
      count?: number;
      personaMix?: 'realistic' | 'critical' | 'positive' | 'mixed';
    }) => {
      const res = await http.post<{ count: number; message: string }>(
        `/api/surveys/${surveyId}/generate-sample-responses`,
        opts,
      );
      return res.data;
    },

    // Responses
    submitResponse: async (surveyId: string, data: { answers: unknown[]; publishToken: string }) => {
      const publicHttp = axios.create({ baseURL: BASE });
      const res = await publicHttp.post<{ success: boolean; id: string }>(`/api/surveys/${surveyId}/responses`, data);
      return res.data;
    },
    getResponses: async (surveyId: string, params: {
      limit?: number; offset?: number; search?: string;
      sentiment?: string; emotion?: string;
      nps_min?: number; nps_max?: number;
      date_from?: string; date_to?: string;
    } = {}) => {
      const res = await http.get<{
        responses: SurveyResponse[];
        total: number; limit: number; offset: number; hasMore: boolean;
      }>(`/api/surveys/${surveyId}/responses`, { params });
      return res.data;
    },
    getInsights: async (surveyId: string) => {
      const res = await http.get<{ insights: Insight }>(`/api/surveys/${surveyId}/insights`);
      return res.data;
    },

    // AI (legacy direct endpoints)
    generateSurvey: async (intent: string, surveyTypeId?: string) => {
      const res = await http.post<{ questions: Question[] }>('/api/ai/generate-survey', { intent, surveyTypeId });
      return res.data;
    },
    analyzeInsights: async (surveyId: string) => {
      const res = await http.post<{ insights: Insight }>('/api/ai/analyze-insights', { surveyId });
      return res.data;
    },
    refineSurvey: async (questions: Question[], message: string, context: Record<string, unknown>) => {
      const res = await http.post<{ questions: Question[]; explanation?: string }>('/api/ai/refine-survey', { questions, message, context });
      return res.data;
    },

    // ── Copilot Orchestration ──────────────────────────────────────────────────

    /** Start a survey creation run. Returns run_id immediately — poll for results. */
    startRun: async (params: {
      intent: string;
      surveyTypeId?: string;
      sessionId?: string;
      orgContext?: OrgContext;
    }) => {
      const res = await http.post<{ run_id: string; thread_id: string; status: string }>(
        '/api/copilot/orchestrate',
        params,
      );
      return res.data;
    },

    /** Poll a run for status, questions, QC score, recommendations. */
    getRunStatus: async (runId: string): Promise<RunStatus> => {
      const res = await http.get<RunStatus>(`/api/copilot/runs/${runId}/status`);
      return res.data;
    },

    /** Cancel a running orchestration. Interrupts the in-process task and marks DB as cancelled.
     *  Idempotent — safe to call on already-terminal runs. */
    cancelRun: async (runId: string): Promise<{ run_id: string; status: string; task_cancelled: boolean }> => {
      const res = await http.post<{ run_id: string; status: string; task_cancelled: boolean }>(
        `/api/copilot/runs/${runId}/cancel`,
        {},
      );
      return res.data;
    },

    // ── Copilot Chat Edits ─────────────────────────────────────────────────────

    /** Apply a natural-language edit to survey questions ("add skip logic to q3"). */
    copilotRefine: async (runId: string, params: {
      message: string;
      questions: Question[];
      orgContext?: OrgContext;
      surveyTypeId?: string;
      intent?: string;
      conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
    }): Promise<CopilotRefineResult> => {
      const res = await http.post<CopilotRefineResult>(
        `/api/copilot/runs/${runId}/refine`,
        params,
      );
      return res.data;
    },

    /** Add conditional skip/display logic to the survey questions. */
    addSkipLogic: async (runId: string, request: string, orgContext?: OrgContext): Promise<QuestionsResult> => {
      const res = await http.post<QuestionsResult>(
        `/api/copilot/runs/${runId}/skip-logic`,
        { request, orgContext: orgContext ?? {} },
      );
      return res.data;
    },

    // ── Question CRUD ──────────────────────────────────────────────────────────

    addQuestion: async (runId: string, type?: string, afterId?: string): Promise<QuestionsResult> => {
      const res = await http.post<QuestionsResult>(
        `/api/copilot/runs/${runId}/questions`,
        { type: type ?? 'open_text', afterId },
      );
      return res.data;
    },

    removeQuestion: async (runId: string, qId: string): Promise<QuestionsResult> => {
      const res = await http.delete<QuestionsResult>(
        `/api/copilot/runs/${runId}/questions/${qId}`,
      );
      return res.data;
    },

    patchQuestion: async (runId: string, qId: string, fields: Partial<Question>): Promise<QuestionsResult> => {
      const res = await http.patch<QuestionsResult>(
        `/api/copilot/runs/${runId}/questions/${qId}`,
        { fields },
      );
      return res.data;
    },

    reorderQuestions: async (runId: string, order: string[]): Promise<QuestionsResult> => {
      const res = await http.post<QuestionsResult>(
        `/api/copilot/runs/${runId}/reorder`,
        { order },
      );
      return res.data;
    },

    /** Execute a recommendation action (e.g. "add_skip_logic", "refine_question"). */
    applyRecommendation: async (runId: string, actionId: string, params?: {
      parameters?: Record<string, unknown>;
      orgContext?: OrgContext;
      surveyTypeId?: string;
      intent?: string;
    }): Promise<QuestionsResult> => {
      const res = await http.post<QuestionsResult>(
        `/api/copilot/runs/${runId}/apply-recommendation/${actionId}`,
        params ?? {},
      );
      return res.data;
    },

    // ── Notifications ──────────────────────────────────────────────────────────

    getNotifications: async (): Promise<Notification[]> => {
      const res = await http.get<{ notifications: Array<Record<string, unknown>> }>('/api/notifications?limit=50');
      // Map the v2 (camelCase) payload back to the Notification shape the UI uses.
      return (res.data.notifications || []).map((n) => ({
        id: n.id as string,
        type: n.type as string,
        title: n.title as string,
        body: (n.body as string) ?? '',
        payload: (n.payload as Record<string, unknown>) ?? {},
        run_id: (n.runId as string) ?? undefined,
        read: !!n.read,
        created_at: n.createdAt as string,
        priority: n.priority as Notification['priority'],
        actionUrl: (n.actionUrl as string) ?? null,
        entityType: (n.entityType as string) ?? null,
      }));
    },

    getUnreadCount: async (): Promise<number> => {
      const res = await http.get<{ unread: number; critical: number }>('/api/notifications/count');
      return res.data.unread;
    },

    getNotificationCount: async (): Promise<{ unread: number; critical: number }> => {
      const res = await http.get<{ unread: number; critical: number }>('/api/notifications/count');
      return res.data;
    },

    markNotificationRead: async (id: string): Promise<void> => {
      await http.post(`/api/notifications/${id}/read`, {});
    },

    markAllNotificationsRead: async (): Promise<void> => {
      await http.post('/api/notifications/read-all', {});
    },

    dismissNotification: async (id: string): Promise<void> => {
      await http.delete(`/api/notifications/${id}`);
    },

    // ── Visual AI ────────────────────────────────────────────────────────────--
    generateChartSpec: async (request: string): Promise<{ spec: ChartSpec }> => {
      const res = await http.post('/api/visual/chart-spec', { request });
      return res.data;
    },

    // ── Dashboard ──────────────────────────────────────────────────────────────
    getDashboardSummary: async (
      days = 30,
      opts: { surveyId?: string | null; tagId?: string | null; npsSegment?: string } = {},
    ): Promise<DashboardSummary> => {
      const params: Record<string, string> = { days: String(days) };
      if (opts.surveyId) params.surveyId = opts.surveyId;
      if (opts.tagId) params.tagId = opts.tagId;
      if (opts.npsSegment && opts.npsSegment !== 'all') params.npsSegment = opts.npsSegment;
      const res = await http.get('/api/dashboard/summary', { params });
      return res.data;
    },
    getDashboardOperations: async (): Promise<DashboardOperations> => {
      const res = await http.get('/api/dashboard/operations');
      return res.data;
    },
    getDashboardInsights: async (): Promise<DashboardInsights> => {
      const res = await http.get('/api/dashboard/insights');
      return res.data;
    },
    getDashboardConfig: async (): Promise<SavedDashboardConfig | null> => {
      const res = await http.get<{ config: SavedDashboardConfig | null }>('/api/dashboard-configs');
      return res.data.config;
    },
    saveDashboardConfig: async (config: {
      name: string;
      widgets: WidgetConfig[];
      filters: DashboardFilters;
    }): Promise<SavedDashboardConfig> => {
      const res = await http.put<{ config: SavedDashboardConfig }>('/api/dashboard-configs', config);
      return res.data.config;
    },

    // ── Alerts ───────────────────────────────────────────────────────────────--
    listAlertTypes: async (): Promise<{ types: AlertTypeDef[] }> => {
      const res = await http.get('/api/alerts/types');
      return res.data;
    },
    getAlertSubscriptions: async (): Promise<{ subscriptions: AlertSubscription[] }> => {
      const res = await http.get('/api/alerts/subscriptions');
      return res.data;
    },
    updateAlertSubscription: async (data: {
      alertType: string; inAppEnabled?: boolean; emailEnabled?: boolean; slackEnabled?: boolean;
    }): Promise<{ success: boolean }> => {
      const res = await http.put('/api/alerts/subscriptions', data);
      return res.data;
    },
    listAlertRules: async (): Promise<{ rules: AlertRule[] }> => {
      const res = await http.get('/api/alerts');
      return res.data;
    },
    createAlertRule: async (data: {
      alertType: string; name: string; description?: string; surveyId?: string | null;
      severity?: AlertSeverity; thresholdConfig?: Record<string, unknown>;
    }): Promise<{ rule: AlertRule }> => {
      const res = await http.post('/api/alerts', data);
      return res.data;
    },
    updateAlertRule: async (id: string, data: Record<string, unknown>): Promise<{ rule: AlertRule }> => {
      const res = await http.patch(`/api/alerts/rules/${id}`, data);
      return res.data;
    },
    deleteAlertRule: async (id: string): Promise<{ success: boolean }> => {
      const res = await http.delete(`/api/alerts/rules/${id}`);
      return res.data;
    },
    listAlertEvents: async (params: { status?: string; severity?: string } = {}): Promise<{ events: AlertEvent[] }> => {
      const qs = new URLSearchParams();
      if (params.status) qs.set('status', params.status);
      if (params.severity) qs.set('severity', params.severity);
      const res = await http.get(`/api/alerts/events${qs.toString() ? `?${qs}` : ''}`);
      return res.data;
    },
    acknowledgeAlert: async (id: string): Promise<{ event: AlertEvent }> => {
      const res = await http.post(`/api/alerts/events/${id}/acknowledge`, {});
      return res.data;
    },
    resolveAlert: async (id: string): Promise<{ event: AlertEvent }> => {
      const res = await http.post(`/api/alerts/events/${id}/resolve`, {});
      return res.data;
    },
    snoozeAlert: async (id: string, hours: number): Promise<{ event: AlertEvent }> => {
      const res = await http.post(`/api/alerts/events/${id}/snooze`, { hours });
      return res.data;
    },

    getNotificationDigest: async (period: 'day' | 'week' = 'day'): Promise<{
      period: string; total: number; byPriority: Record<string, number>;
      byType: Array<{ type: string; count: number }>; topItems: Notification[];
    }> => {
      const res = await http.get(`/api/notifications/digest?period=${period}`);
      return res.data;
    },

    getNotificationPreferences: async (): Promise<{ preferences: NotificationPreference[] }> => {
      const res = await http.get<{ preferences: NotificationPreference[] }>('/api/notifications/preferences');
      return res.data;
    },

    updateNotificationPreferences: async (preferences: NotificationPreference[]): Promise<{ updated: number }> => {
      const res = await http.put<{ updated: number }>('/api/notifications/preferences', { preferences });
      return res.data;
    },

    getAgentRegistry: async () => {
      // Returns { agents: LegacyAgent[], skills: XosSkill[], total: number }
      // agents = legacy BaseAgent subclasses; skills = XOS SKILL.md-based capabilities
      const res = await http.get<{
        agents: unknown[];
        skills: Array<{ name: string; version: string; description: string; shared: boolean; allowed_tools: string[]; timeout_seconds: number; max_output_tokens: number }>;
        total: number;
      }>('/api/copilot/agents/registry');
      return res.data;
    },

    // Templates
    listTemplates: async () => {
      const res = await http.get<{ templates: Template[] }>('/api/templates');
      return res.data;
    },
    getTemplate: async (id: string) => {
      const res = await http.get<{ template: Template }>(`/api/templates/${id}`);
      return res.data;
    },
    createTemplate: async (data: Partial<Template>) => {
      const res = await http.post<{ template: Template }>('/api/templates', data);
      return res.data;
    },
    updateTemplate: async (id: string, data: Partial<Template>) => {
      const res = await http.put<{ success: boolean }>(`/api/templates/${id}`, data);
      return res.data;
    },
    deleteTemplate: async (id: string) => {
      const res = await http.delete<{ success: boolean }>(`/api/templates/${id}`);
      return res.data;
    },
    cloneTemplate: async (id: string) => {
      const res = await http.post<{ template: Template }>(`/api/templates/${id}/clone`, {});
      return res.data;
    },

    // Org profile (legacy)
    getOrgProfile: async () => {
      const res = await http.get<{ profile: OrgProfile | null }>('/api/org-profile');
      return res.data;
    },
    updateOrgProfile: async (data: Partial<OrgProfile>) => {
      const res = await http.put<{ profile: OrgProfile }>('/api/org-profile', data);
      return res.data;
    },

    // Org (Sprint 1)
    getOrg: async () => {
      const res = await http.get<{ org: Org }>('/api/orgs/me');
      return res.data;
    },
    updateOrg: async (data: { name?: string; logoUrl?: string }) => {
      const res = await http.put<{ org: Org }>('/api/orgs/me', data);
      return res.data;
    },
    uploadLogo: async (file: File) => {
      const form = new FormData();
      form.append('logo', file);
      const res = await http.post<{ logoUrl: string }>('/api/orgs/me/logo', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      return res.data;
    },

    // Members (Sprint 1)
    getMembers: async () => {
      const res = await http.get<{ members: OrgMember[]; total: number }>('/api/orgs/me/members');
      return res.data;
    },
    inviteMember: async (email: string, role?: string) => {
      const res = await http.post<{ success: boolean; invitation?: { id: string; emailAddress: string; status: string } }>('/api/orgs/me/invitations', { email, role });
      return res.data;
    },
    removeMember: async (userId: string) => {
      const res = await http.delete<{ success: boolean }>(`/api/orgs/me/members/${userId}`);
      return res.data;
    },
    updateMemberRole: async (userId: string, role: string) => {
      const res = await http.put<{ success: boolean }>(`/api/orgs/me/members/${userId}/role`, { role });
      return res.data;
    },

    // Workflows
    listWorkflows: async () => {
      const res = await http.get<{ workflows: Workflow[] }>('/api/workflows');
      return res.data;
    },
    getWorkflow: async (id: string) => {
      const res = await http.get<{ workflow: Workflow }>(`/api/workflows/${id}`);
      return res.data;
    },
    createWorkflow: async (data: Partial<Workflow>) => {
      const res = await http.post<{ workflow: Workflow }>('/api/workflows', data);
      return res.data;
    },
    // Wave 11 (Nina — concurrent-edit protection, TRACKER.md Wave 11 Part 2):
    // uses `rawHttp` (not `http`) so a 409 conflict response's body
    // (`{ error, workflow }`) survives to the caller as a typed
    // `WorkflowConflictError` instead of being flattened into a bare
    // `Error(message)` by the default interceptor. `version` is OPTIONAL —
    // omitting it entirely matches the backend's documented force-save path
    // (routes/workflows.ts: absent version skips the conflict check
    // completely), used by both create-mode (no prior version to conflict
    // with) and the builder's explicit "Overwrite anyway" action.
    updateWorkflow: async (id: string, data: Partial<Workflow> & {
      // Graph-shape + scope fields are camelCase on the wire (createWorkflowSchema/
      // updateWorkflowSchema in backend/src/schemas/workflows.ts) even though the
      // GET response returns them snake_case on the Workflow type — this widened
      // signature lets callers send either shape without an unsafe cast.
      triggerType?: string;
      nodes?: unknown[];
      edges?: unknown[];
      scopeType?: 'org' | 'survey' | 'tag';
      scopeSurveyId?: string;
      scopeTagId?: string;
      version?: number;
    }): Promise<{ success: boolean; version?: number }> => {
      try {
        const res = await rawHttp.put<{ success: boolean; version?: number }>(`/api/workflows/${id}`, data);
        return res.data;
      } catch (error) {
        const e = error as { response?: { status?: number; data?: { error?: string; workflow?: Workflow } }; message?: string };
        const status = e?.response?.status;
        const message = e?.response?.data?.error || e?.message || 'Failed to save workflow';
        throw new WorkflowConflictError(message, status, e?.response?.data?.workflow);
      }
    },
    deleteWorkflow: async (id: string) => {
      const res = await http.delete<{ success: boolean }>(`/api/workflows/${id}`);
      return res.data;
    },
    toggleWorkflow: async (id: string) => {
      const res = await http.post<{ status: string }>(`/api/workflows/${id}/toggle`, {});
      return res.data;
    },
    getWorkflowRegistry: async (): Promise<WorkflowRegistryResponse> => {
      const res = await http.get<WorkflowRegistryResponse>('/api/workflows/registry');
      return res.data;
    },
    listWorkflowTemplates: async (): Promise<{ templates: WorkflowTemplate[] }> => {
      const res = await http.get('/api/workflows/templates');
      return res.data;
    },
    createGraphWorkflow: async (data: {
      name: string; description?: string; triggerType: string; nodes: unknown[]; edges: unknown[]; status?: string;
      cooldown_minutes?: number | null;
      // Scope (Wave 6, docs/automation-hub/BUILDER_REDESIGN_V2_SCOPE.md §2) —
      // mirrors createWorkflowSchema exactly. Omitted → server defaults to 'org'.
      scopeType?: 'org' | 'survey' | 'tag';
      scopeSurveyId?: string;
      scopeTagId?: string;
    }) => {
      const res = await http.post('/api/workflows', data);
      return res.data;
    },
    // GET /api/workflows/notification-targets — id+name+memberCount lookup lists
    // for the NotifyTargetPicker (role/department/group modes). Gated by
    // `workflows:manage` (not `users:manage`), so any workflow author can call
    // it — see backend/src/routes/workflows.ts's route comment for why a
    // separate, lighter endpoint exists instead of GET /api/roles etc.
    getNotificationTargets: async (): Promise<NotificationTargetsResponse> => {
      const res = await http.get('/api/workflows/notification-targets');
      return res.data;
    },
    testWorkflow: async (id: string, event?: Record<string, unknown>) => {
      const res = await http.post(`/api/workflows/${id}/test`, event ? { event } : {});
      return res.data;
    },
    getWorkflowExecutions: async (id: string): Promise<{ executions: WorkflowExecution[] }> => {
      const res = await http.get(`/api/workflows/${id}/executions`);
      return res.data;
    },
    // GET /api/workflows/:id/audit-log — paginated config-change history
    // (Wave 11, Nina). `page`/`limit` mirror the backend's own query-param
    // names exactly (see WorkflowAuditLogResponse's doc above).
    getWorkflowAuditLog: async (id: string, params: { page?: number; limit?: number } = {}): Promise<WorkflowAuditLogResponse> => {
      const qs = new URLSearchParams();
      if (params.page) qs.set('page', String(params.page));
      if (params.limit) qs.set('limit', String(params.limit));
      const res = await http.get<WorkflowAuditLogResponse>(`/api/workflows/${id}/audit-log${qs.toString() ? `?${qs}` : ''}`);
      return res.data;
    },
    listWorkflowApprovals: async (): Promise<{ approvals: Array<{ id: string; execution_id: string; workflow_id: string; node_id: string; requested_at: string; workflow_name: string }> }> => {
      const res = await http.get('/api/workflows/approvals');
      return res.data;
    },
    decideApproval: async (executionId: string, decision: 'approve' | 'reject') => {
      const res = await http.post(`/api/workflows/approvals/${executionId}`, { decision });
      return res.data;
    },
    retryWorkflowExecution: async (executionId: string) => {
      const res = await http.post(`/api/workflows/executions/${executionId}/retry`, {});
      return res.data;
    },
    // NL builder — Amara's Wave 3 CrystalOS parser (not built yet). Calls the
    // real contract per BUILDER_SPEC_WAVE2.md §2.1 so no frontend changes are
    // needed once the backend route ships; a 404 today (route not mounted) is
    // surfaced as ParseWorkflowNLError('UNKNOWN') the same as any other
    // network/server failure. Uses `rawHttp` (see toManualRunError above for
    // the same pattern) because the shared `http` interceptor discards status
    // codes and the 422 `suggestions` array this call depends on.
    // `signal` lets the caller enforce the 20s client-side abort + cancel on
    // unmount required by the spec's edge cases.
    parseWorkflowNL: async (description: string, signal?: AbortSignal): Promise<ParseWorkflowNLResult> => {
      try {
        const res = await rawHttp.post<ParseWorkflowNLResult>('/api/workflows/parse-nl', { description }, { signal });
        return res.data;
      } catch (error) {
        throw toParseWorkflowNLError(error);
      }
    },

    // ── Survey Insights (v2 — agentic) ────────────────────────────────────────

    listInsights: async (surveyId: string, opts: { timeWindow?: string } = {}): Promise<{
      insights:        AgenticInsight[];
      run_status?:     string | null;
      survey?:         { id: string; title: string; response_count: number };
      crystal_opening?: string | null;
      pipeline_active?: boolean;
      survey_status?:  string;
      // Phase 0.5 — investigation trajectory. Null until the backend task
      // "Add latest_checkpoint to GET /api/insights/:surveyId/list" ships.
      latest_checkpoint?: LatestCheckpoint | null;
    }> => {
      const params = new URLSearchParams();
      if (opts.timeWindow && opts.timeWindow !== 'all_time') params.set('time_window', opts.timeWindow);
      const qs = params.toString();
      const url = `/api/insights/${surveyId}/list${qs ? '?' + qs : ''}`;
      const res = await http.get(url);
      // Postgres NUMERIC columns (nps, deltas) arrive as strings — coerce so
      // .toFixed() in the header band/drawer never crashes. See listTopics().
      const coerce = (v: unknown) => (v == null ? null : Number(v));
      const raw = res.data?.latest_checkpoint;
      let latest_checkpoint: LatestCheckpoint | null = null;
      if (raw) {
        const rawDelta = raw.delta;
        const delta: CheckpointDelta | null = rawDelta
          ? {
              nps_delta:            coerce(rawDelta.nps_delta),
              csat_delta:           coerce(rawDelta.csat_delta),
              response_count_delta: Number(rawDelta.response_count_delta ?? 0),
              topic_changes: {
                emerged:   rawDelta.topic_changes?.emerged   ?? [],
                resolved:  rawDelta.topic_changes?.resolved  ?? [],
                persisted: rawDelta.topic_changes?.persisted ?? [],
              },
              trend_direction:   rawDelta.trend_direction   ?? 'stable',
              trend_persistence: rawDelta.trend_persistence ?? '',
            }
          : null;
        latest_checkpoint = {
          number:        Number(raw.number),
          nps:           coerce(raw.nps),
          delta,
          meaningful:    Boolean(raw.meaningful),
          created_at:    raw.created_at,
          trigger:       raw.trigger ?? null,
          new_responses: raw.new_responses != null ? Number(raw.new_responses) : null,
          csat:          coerce(raw.csat),
          ces:           coerce(raw.ces),
          model:         raw.model ?? null,
        };
      }
      return { ...res.data, latest_checkpoint };
    },

    // Phase 0.5 — recent checkpoints for the drawer sparkline. The Trail
    // endpoint ships in Phase 4; tolerate its absence now by returning [] on 404.
    getRecentCheckpoints: async (surveyId: string, limit = 5): Promise<RecentCheckpointPoint[]> => {
      const coerce = (v: unknown) => (v == null ? null : Number(v));
      try {
        const res = await http.get<{ checkpoints?: Array<Record<string, unknown>> }>(
          `/api/insights/${surveyId}/trail?limit=${limit}`,
        );
        const rows = res.data?.checkpoints ?? [];
        return rows.map((c) => ({
          number:     Number(c.number),
          nps:        coerce(c.nps),
          created_at: String(c.created_at ?? ''),
        }));
      } catch {
        // 404 (Trail not yet shipped) or any error → graceful empty fallback.
        return [];
      }
    },

    triggerInsightGeneration: async (
      surveyId: string,
      opts: { trigger?: 'manual' | 'regenerate' | 'schedule' | 'stream'; force?: boolean } = {},
    ): Promise<{ run_id: string; status: string }> => {
      const res = await http.post<{ run_id: string; status: string }>(
        `/api/insights/${surveyId}/generate`,
        // Default to 'manual' so user-initiated generation always bypasses the cache
        // and produces a fresh report. The scheduler uses 'schedule'; stream consumer uses 'stream'.
        { trigger: opts.trigger ?? 'manual', force: opts.force ?? false },
      );
      return res.data;
    },

    getInsightRunStatus: async (surveyId: string): Promise<{ run_id: string; status: string; stream_events: unknown[] }> => {
      const res = await http.get<{ run_id: string; status: string; stream_events: unknown[] }>(`/api/insights/${surveyId}/run-status`);
      return res.data;
    },

    // ── Topic tagging backfill (Experience → Topics page "Backfill Tagging") ──
    // Drains a survey's entire untagged-response backlog in the background —
    // useful for an old survey with a large pre-existing backlog, or one that
    // hit a tagging failure before it was fixed. Progress is reported into the
    // SAME generic agent_runs polling mechanism every other run type uses
    // (getRun below) — no bespoke progress channel.

    /**
     * Start a backfill job. 202 → { run_id, status: 'started' }. If there's
     * nothing untagged for this survey, the backend skips starting a job (and
     * charging credits) entirely → 200 { status: 'nothing_to_backfill',
     * bootstrap_pending } with no run_id. `bootstrap_pending` is true when the
     * survey has never had its first topic-bootstrap run (no topic centroids
     * yet) — sentiment/emotion tagging can be fully complete while topics are
     * still permanently unassigned, so this must be surfaced separately from
     * "nothing_to_backfill" rather than folded into it. Throws ManualRunError
     * on 402/429.
     */
    triggerTopicBackfill: async (surveyId: string): Promise<{ run_id?: string; status: string; bootstrap_pending?: boolean }> => {
      try {
        const res = await rawHttp.post<{ run_id?: string; status: string; bootstrap_pending?: boolean }>(
          `/api/insights/${surveyId}/topics/backfill`,
        );
        return res.data;
      } catch (error) {
        throw toManualRunError(error);
      }
    },

    /**
     * Find an already-running backfill job for this survey, if any — lets the
     * page resume showing a progress bar after a reload/navigation instead of
     * losing track of an in-flight job (the job itself runs server-side and
     * keeps going regardless of whether anyone is watching).
     */
    getActiveTopicBackfillRun: async (surveyId: string): Promise<string | null> => {
      const res = await http.get<{ runs: Array<{ id: string }> }>(
        `/api/runs?run_type=topic_backfill&survey_id=${surveyId}&status=running&limit=1`,
      );
      return res.data.runs?.[0]?.id ?? null;
    },

    /** Generic run poll — status + the stream_events progress feed every run_type writes into. */
    getRun: async (runId: string): Promise<{ id: string; status: string; stream_events: Array<Record<string, unknown>> }> => {
      const res = await http.get<{ id: string; status: string; stream_events: Array<Record<string, unknown>> }>(
        `/api/runs/${runId}`,
      );
      return res.data;
    },

    // ── Manual runs (Phase 3) + Insight Trail (Phase 4) ────────────────────────

    /**
     * Trigger a manual insight run (expert / quick / refresh). Returns 202 with a
     * run_id to poll via getInsightRunStatus. Surfaces 402/429 as a ManualRunError
     * (use `err instanceof ManualRunError` + `.code` to render the right message).
     */
    triggerManualRun: async (
      surveyId: string,
      body: ManualRunRequest,
    ): Promise<ManualRunResponse> => {
      try {
        const res = await rawHttp.post<ManualRunResponse>(`/api/insights/${surveyId}/runs`, body);
        return res.data;
      } catch (error) {
        throw toManualRunError(error);
      }
    },

    /** Preview the corpus size / credit cost / duration / sample size for a run. */
    previewManualRun: async (
      surveyId: string,
      body: ManualRunPreviewRequest,
    ): Promise<ManualRunPreview> => {
      const coerce = (v: unknown) => (v == null ? null : Number(v));
      try {
        const res = await rawHttp.post<Record<string, unknown>>(
          `/api/insights/${surveyId}/runs/preview`,
          body,
        );
        const d = res.data ?? {};
        return {
          estimated_cost:           coerce(d.estimated_cost),
          corpus_size:              coerce(d.corpus_size),
          estimated_duration_label: String(d.estimated_duration_label ?? ''),
          sample_size:              coerce(d.sample_size),
        };
      } catch (error) {
        throw toManualRunError(error);
      }
    },

    /** Paginated trail: automated + manual checkpoints with deltas + manual reports. */
    getInsightTrail: async (
      surveyId: string,
      opts: { lane?: TrailLane | 'all'; limit?: number; cursor?: string | null } = {},
    ): Promise<InsightTrailResult> => {
      const coerce = (v: unknown) => (v == null ? null : Number(v));
      const params = new URLSearchParams();
      if (opts.lane && opts.lane !== 'all') params.set('lane', opts.lane);
      if (opts.limit != null) params.set('limit', String(opts.limit));
      if (opts.cursor) params.set('cursor', opts.cursor);
      const qs = params.toString();
      const res = await http.get<Record<string, unknown>>(
        `/api/insights/${surveyId}/trail${qs ? '?' + qs : ''}`,
      );
      const data = res.data ?? {};
      const mapDelta = (rawDelta: any): CheckpointDelta | null =>
        rawDelta
          ? {
              nps_delta:            coerce(rawDelta.nps_delta),
              csat_delta:           coerce(rawDelta.csat_delta),
              response_count_delta: Number(rawDelta.response_count_delta ?? 0),
              topic_changes: {
                emerged:   rawDelta.topic_changes?.emerged   ?? [],
                resolved:  rawDelta.topic_changes?.resolved  ?? [],
                persisted: rawDelta.topic_changes?.persisted ?? [],
              },
              trend_direction:   rawDelta.trend_direction   ?? 'stable',
              trend_persistence: rawDelta.trend_persistence ?? '',
            }
          : null;
      const checkpoints: TrailCheckpoint[] = ((data.checkpoints as any[]) ?? []).map((c) => ({
        id:           String(c.id ?? ''),
        number:       Number(c.number ?? 0),
        lane:         (c.lane === 'manual' ? 'manual' : 'automated') as TrailLane,
        run_mode:     c.run_mode ?? null,
        trigger:      c.trigger ?? null,
        nps:          coerce(c.nps),
        csat:         coerce(c.csat),
        ces:          coerce(c.ces),
        delta:        mapDelta(c.delta),
        meaningful:   Boolean(c.meaningful),
        created_at:   String(c.created_at ?? ''),
        created_by:   c.created_by ?? null,
        report_label: c.report_label ?? null,
        report_id:    c.report_id ?? null,
        window_start: c.window_start ?? null,
        window_end:   c.window_end ?? null,
        response_count: c.response_count != null ? Number(c.response_count) : null,
        tier_label:     (c.tier_label ?? null) as TrailCheckpoint['tier_label'],
      }));
      const reports: TrailReport[] = ((data.reports as any[]) ?? []).map((r) => ({
        id:                   String(r.id ?? ''),
        label:                r.label ?? null,
        name:                 r.name ?? null,
        mode:                 r.mode ?? null,
        report_type:          (r.report_type === 'custom' ? 'custom' : 'manual') as TrailReport['report_type'],
        created_at:           String(r.created_at ?? ''),
        created_by:           r.created_by ?? null,
        window_start:         r.window_start ?? null,
        window_end:           r.window_end ?? null,
        trust_score_avg:      r.trust_score_avg != null ? Number(r.trust_score_avg) : null,
        corpus_coverage_pct:  r.corpus_coverage_pct != null ? Number(r.corpus_coverage_pct) : null,
        sample_size:          r.sample_size != null ? Number(r.sample_size) : null,
        slug:                 r.slug ?? null,
      }));
      return { checkpoints, reports, next_cursor: (data.next_cursor as string) ?? null };
    },

    /** Single checkpoint detail + lineage + blob ref. */
    getCheckpointDetail: async (
      surveyId: string,
      checkpointId: string,
    ): Promise<CheckpointDetail> => {
      const coerce = (v: unknown) => (v == null ? null : Number(v));
      const mapDelta = (raw: any): CheckpointDelta | null =>
        raw
          ? {
              nps_delta:            coerce(raw.nps_delta),
              csat_delta:           coerce(raw.csat_delta),
              response_count_delta: Number(raw.response_count_delta ?? 0),
              topic_changes: {
                emerged:   raw.topic_changes?.emerged   ?? [],
                resolved:  raw.topic_changes?.resolved  ?? [],
                persisted: raw.topic_changes?.persisted ?? [],
              },
              trend_direction:   raw.trend_direction   ?? 'stable',
              trend_persistence: raw.trend_persistence ?? '',
            }
          : null;

      const res = await http.get<Record<string, unknown>>(
        `/api/insights/${surveyId}/trail/${checkpointId}`,
      );
      const data = res.data ?? {};
      const delta = mapDelta(data.delta_from_prior);

      // Backend sends an already-shaped checkpoint but with raw delta — re-map it.
      const raw = (data.checkpoint as any) ?? {};
      const checkpoint: TrailCheckpoint = {
        id:             String(raw.id ?? ''),
        number:         Number(raw.number ?? 0),
        lane:           (raw.lane === 'manual' ? 'manual' : 'automated') as TrailLane,
        run_mode:       raw.run_mode  ?? null,
        trigger:        raw.trigger   ?? null,
        nps:            coerce(raw.nps),
        csat:           coerce(raw.csat),
        ces:            coerce(raw.ces),
        delta,
        meaningful:     Boolean(raw.meaningful),
        created_at:     String(raw.created_at ?? ''),
        created_by:     raw.created_by    ?? null,
        report_label:   raw.report_label  ?? null,
        report_id:      raw.report_id     ?? null,
        window_start:   raw.window_start  ?? null,
        window_end:     raw.window_end    ?? null,
        response_count: raw.response_count != null ? Number(raw.response_count) : null,
        tier_label:     (raw.tier_label   ?? null) as TrailCheckpoint['tier_label'],
      };

      return {
        checkpoint,
        lineage_json: (data.lineage_json as Record<string, unknown>) ?? null,
        delta,
        blob_ref: (data.report_blob_ref as string) ?? null,
        document: data.document,
        blob_url: (data.blob_url as string) ?? null,
        source:   (data.source as 'v2' | 'legacy') ?? undefined,
      };
    },

    /** Compare two checkpoints → metric deltas + topic diff. */
    compareCheckpoints: async (
      surveyId: string,
      a: string,
      b: string,
    ): Promise<CheckpointComparison> => {
      const coerce = (v: unknown) => (v == null ? null : Number(v));
      const res = await http.get<Record<string, unknown>>(
        `/api/insights/${surveyId}/trail/${a}/compare/${b}`,
      );
      const d = res.data ?? {};
      const md = (d.metric_deltas as Record<string, unknown>) ?? {};
      const td = (d.topic_diff as Record<string, unknown>) ?? {};
      const coerceCheckpoint = (cp: Record<string, unknown>): TrailCheckpoint => ({
        ...(cp as object),
        nps: coerce(cp.nps),
        csat: coerce(cp.csat),
        ces: coerce(cp.ces),
        delta: cp.delta ? {
          ...(cp.delta as Record<string, unknown>),
          nps_delta: coerce((cp.delta as Record<string, unknown>).nps_delta),
          csat_delta: coerce((cp.delta as Record<string, unknown>).csat_delta),
          ces_delta: coerce((cp.delta as Record<string, unknown>).ces_delta),
        } : null,
      } as TrailCheckpoint);
      return {
        a: coerceCheckpoint(d.a as Record<string, unknown>),
        b: coerceCheckpoint(d.b as Record<string, unknown>),
        metric_deltas: { nps: coerce(md.nps), csat: coerce(md.csat), ces: coerce(md.ces) },
        topic_diff: {
          added:   (td.added as string[]) ?? [],
          removed: (td.removed as string[]) ?? [],
        },
      };
    },

    /** Fetch a persisted insight report document (manual report viewer). */
    getInsightReport: async (
      surveyId: string,
      reportId: string,
    ): Promise<InsightReport> => {
      const res = await http.get<InsightReport>(
        `/api/insights/${surveyId}/reports/${reportId}`,
      );
      return res.data;
    },

    // ── Insight settings (Phase 5) + Custom Analysis (Phase 6) ──────────────────

    /** Effective merged insight settings + survey/org layers + provenance. */
    getInsightSettings: async (surveyId: string): Promise<InsightSettings> => {
      const res = await http.get<Record<string, unknown>>(`/api/insights/${surveyId}/settings`);
      const d = res.data ?? {};
      return {
        survey_id:        String(d.survey_id ?? surveyId),
        effective:        (d.effective as Record<string, unknown>) ?? {},
        survey_overrides: (d.survey_overrides as Record<string, unknown>) ?? {},
        org_defaults:     (d.org_defaults as Record<string, unknown>) ?? {},
        config_hash:      (d.config_hash as string) ?? null,
        config_version:   d.config_version != null ? Number(d.config_version) : null,
        editable:         Boolean(d.editable),
      };
    },

    /** PATCH only the changed setting keys (admin or owner). */
    updateInsightSettings: async (
      surveyId: string,
      patch: Record<string, unknown>,
    ): Promise<InsightSettingsPatchResult> => {
      const res = await http.patch<Record<string, unknown>>(
        `/api/insights/${surveyId}/settings`,
        patch,
      );
      const d = res.data ?? {};
      return {
        survey_overrides: (d.survey_overrides as Record<string, unknown>) ?? {},
        config_version:   d.config_version != null ? Number(d.config_version) : null,
        config_hash:      (d.config_hash as string) ?? null,
      };
    },

    /** Read the org-level insight defaults template. */
    getOrgInsightDefaults: async (orgId: string): Promise<OrgInsightDefaults> => {
      const res = await http.get<Record<string, unknown>>(`/api/orgs/${orgId}/insight-defaults`);
      const d = res.data ?? {};
      return {
        org_id:     String(d.org_id ?? orgId),
        defaults:   (d.defaults as Record<string, unknown>) ?? {},
        updated_at: (d.updated_at as string) ?? null,
        updated_by: (d.updated_by as string) ?? null,
      };
    },

    /** PATCH the org-level insight defaults (admin only). */
    updateOrgInsightDefaults: async (
      orgId: string,
      patch: Record<string, unknown>,
    ): Promise<OrgInsightDefaults> => {
      const res = await http.patch<Record<string, unknown>>(
        `/api/orgs/${orgId}/insight-defaults`,
        patch,
      );
      const d = res.data ?? {};
      return {
        org_id:     String(d.org_id ?? orgId),
        defaults:   (d.defaults as Record<string, unknown>) ?? {},
        updated_at: (d.updated_at as string) ?? null,
        updated_by: (d.updated_by as string) ?? null,
      };
    },

    /**
     * Trigger a custom analysis run. Returns 202 with report_id/run_id to poll.
     * Surfaces 402/429 as a ManualRunError (same pattern as manual runs).
     */
    createCustomReport: async (body: CustomReportRequest): Promise<CustomReportResponse> => {
      try {
        const res = await rawHttp.post<CustomReportResponse>('/api/reports/custom', body);
        return res.data;
      } catch (error) {
        throw toManualRunError(error);
      }
    },

    /** Preview corpus size / est cost / sample size / low-confidence for a custom run. */
    previewCustomReport: async (body: CustomReportPreviewRequest): Promise<CustomReportPreview> => {
      const coerce = (v: unknown) => (v == null ? null : Number(v));
      try {
        const res = await rawHttp.post<Record<string, unknown>>('/api/reports/custom/preview', body);
        const d = res.data ?? {};
        return {
          estimated_cost: coerce(d.estimated_cost),
          corpus_size:    coerce(d.corpus_size),
          sample_size:    coerce(d.sample_size),
          low_confidence: Boolean(d.low_confidence),
        };
      } catch (error) {
        throw toManualRunError(error);
      }
    },

    /** List past custom reports (optionally scoped to a survey). */
    listCustomReports: async (surveyId?: string): Promise<{ reports: CustomReport[] }> => {
      const coerce = (v: unknown) => (v == null ? null : Number(v));
      const qs = surveyId ? `?survey_id=${encodeURIComponent(surveyId)}` : '';
      const res = await http.get<{ reports?: Array<Record<string, unknown>> }>(`/api/reports/custom${qs}`);
      const reports: CustomReport[] = (res.data?.reports ?? []).map((r) => ({
        id:             String(r.id ?? ''),
        survey_id:      String(r.survey_id ?? ''),
        name:           String(r.name ?? ''),
        slug:           (r.slug as string) ?? null,
        status:         String(r.status ?? 'pending'),
        filter_spec:    (r.filter_spec as CustomReport['filter_spec']) ?? {},
        filter_label:   (r.filter_label as string) ?? null,
        corpus_size:    coerce(r.corpus_size),
        sample_size:    coerce(r.sample_size),
        low_confidence: Boolean(r.low_confidence),
        created_at:     String(r.created_at ?? ''),
        created_by:     (r.created_by as string) ?? null,
        completed_at:   (r.completed_at as string) ?? null,
      }));
      return { reports };
    },

    /** Fetch a single custom report + its insights + optional document. */
    getCustomReport: async (reportId: string): Promise<CustomReportDetail> => {
      const coerce = (v: unknown) => (v == null ? null : Number(v));
      const res = await http.get<Record<string, unknown>>(`/api/reports/custom/${reportId}`);
      const d = res.data ?? {};
      const r = (d.report as Record<string, unknown>) ?? {};
      const report: CustomReport = {
        id:             String(r.id ?? reportId),
        survey_id:      String(r.survey_id ?? ''),
        name:           String(r.name ?? ''),
        slug:           (r.slug as string) ?? null,
        status:         String(r.status ?? 'pending'),
        filter_spec:    (r.filter_spec as CustomReport['filter_spec']) ?? {},
        filter_label:   (r.filter_label as string) ?? null,
        corpus_size:    coerce(r.corpus_size),
        sample_size:    coerce(r.sample_size),
        low_confidence: Boolean(r.low_confidence),
        created_at:     String(r.created_at ?? ''),
        created_by:     (r.created_by as string) ?? null,
        completed_at:   (r.completed_at as string) ?? null,
      };
      const insights: CustomReportDetail['insights'] = ((d.insights as Array<Record<string, unknown>>) ?? []).map((i) => ({
        id:           String(i.id ?? ''),
        layer:        String(i.layer ?? 'descriptive'),
        category:     (i.category as string) ?? null,
        headline:     String(i.headline ?? ''),
        narrative:    (i.narrative as string) ?? null,
        trust_score:  coerce(i.trust_score),
        filter_label: (i.filter_label as string) ?? null,
        sample_size:  coerce(i.sample_size),
      }));
      return { report, insights, document: (d.document as Record<string, unknown>) ?? null };
    },

    updateInsightFeedback: async (insightId: string, feedback: { thumbs?: 'up' | 'down' | null; pinned?: boolean; dismissed?: boolean }): Promise<void> => {
      await http.post(`/api/insights/${insightId}/feedback`, feedback);
    },

    // ── Action Recommendations ─────────────────────────────────────────────────

    /** Fetch AI-generated recommended next actions for a survey. */
    getActionRecommendations: async (surveyId: string): Promise<ActionRecommendations> => {
      const res = await http.get<ActionRecommendations>(`/api/insights/${surveyId}/actions`);
      return res.data;
    },

    /** Dismiss an action so it no longer appears. */
    dismissAction: async (surveyId: string, actionId: string): Promise<void> => {
      await http.post(`/api/insights/${surveyId}/actions/${actionId}/dismiss`, {});
    },

    /** Record the outcome of a Crystal action proposal (idempotent upsert keyed on proposalKey). */
    recordProposalOutcome: async (
      surveyId: string,
      data: {
        proposalKey: string;
        type: string;
        params?: Record<string, unknown>;
        priority?: string;
        businessRationale?: string;
        confidence?: number;
        status: 'emitted' | 'accepted' | 'dismissed' | 'succeeded' | 'failed';
        outcomeRef?: string;
        errorDetail?: string;
      },
    ): Promise<void> => {
      await http.post(`/api/insights/${surveyId}/crystal/proposals`, data);
    },

    askInsights: async (surveyId: string, question: string): Promise<{ answer: string; citations: AgenticInsight[] }> => {
      const res = await http.post<{ answer: string; citations: AgenticInsight[] }>(`/api/insights/${surveyId}/ask`, { question });
      return res.data;
    },

    listTopics: async (
      surveyId: string,
      window = 'all_time',
      sort: 'volume' | 'urgency' = 'volume',
    ): Promise<{ topics: SurveyTopic[]; run_status: string | null; window: string }> => {
      const res = await http.get<{ topics: SurveyTopic[]; run_status: string | null; window: string }>(
        `/api/insights/${surveyId}/topics?window=${window}&sort=${sort}`,
      );
      // Postgres NUMERIC columns arrive as strings from the pg driver.
      // Coerce to numbers here so .toFixed() calls in components never crash.
      const coerce = (v: unknown) => (v == null ? null : Number(v));
      const topics = (res.data.topics ?? []).map(t => ({
        ...t,
        sentiment_score:    coerce(t.sentiment_score),
        effort_score:       coerce(t.effort_score),
        urgency_score:      coerce(t.urgency_score),
        nps_avg:            coerce(t.nps_avg),
        positive_pct:       coerce(t.positive_pct),
        negative_pct:       coerce(t.negative_pct),
        neutral_pct:        coerce(t.neutral_pct),
        volume_delta_pct:   coerce(t.volume_delta_pct),
        nps_correlation:    coerce(t.nps_correlation),
        net_sentiment:      coerce(t.net_sentiment),
        nps_impact:         coerce(t.nps_impact),
        promoter_pct:       coerce(t.promoter_pct),
        detractor_pct:      coerce(t.detractor_pct),
        passive_pct:        coerce(t.passive_pct),
        avg_csat:           coerce(t.avg_csat),
        csat_impact:        coerce(t.csat_impact),
        avg_effort_score:   coerce(t.avg_effort_score),
        driver_score:       coerce(t.driver_score),
        velocity_pct:       coerce(t.velocity_pct),
        // Hierarchy fields — pass parent_topic_id as-is (UUID string or null)
        parent_topic_id:    t.parent_topic_id ?? null,
        hierarchy_level:    t.hierarchy_level != null ? Number(t.hierarchy_level) : undefined,
        sub_topic_count:    t.sub_topic_count != null ? Number(t.sub_topic_count) : 0,
      }));
      return { ...res.data, topics };
    },

    getTopicDrivers: async (surveyId: string, window = 'all_time'): Promise<{
      drivers: TopicDriver[];
      overall_nps: number | null;
      total_topics: number;
      window: string;
    }> => {
      const res = await http.get(`/api/insights/${surveyId}/drivers?window=${window}`);
      const coerce = (v: unknown) => (v == null ? null : Number(v));
      const drivers = ((res.data as any).drivers ?? []).map((d: TopicDriver) => ({
        ...d,
        volume:          d.volume != null ? Number(d.volume) : 0,
        nps_delta:       coerce(d.nps_delta),
        impact_score:    coerce(d.impact_score) ?? 0,
        sentiment_score: coerce(d.sentiment_score),
        effort_score:    coerce(d.effort_score),
        positive_pct:    coerce(d.positive_pct),
        negative_pct:    coerce(d.negative_pct),
        topic_avg_nps:   coerce(d.topic_avg_nps),
      }));
      const overall = (res.data as any).overall_nps;
      return {
        ...(res.data as any),
        drivers,
        overall_nps: overall != null ? Number(overall) : null,
      };
    },

    getTopicQuotes: async (surveyId: string, topicId: string): Promise<{
      topic_id: string;
      topic_name: string;
      quotes: Array<{
        response_id: string;
        texts: string[];
        nps_score: number | null;
        submitted_at: string;
      }>;
    }> => {
      const res = await http.get(`/api/insights/${surveyId}/topics/${topicId}/quotes`);
      return res.data as {
        topic_id: string;
        topic_name: string;
        quotes: Array<{ response_id: string; texts: string[]; nps_score: number | null; submitted_at: string }>;
      };
    },

    crystalChat: async (
      surveyId: string,
      message: string,
      ctx?: { window?: string; focused_topic?: string },
    ): Promise<{
      answer: string;
      suggestions: string[];
      insight_refs: string[];
      thread_key: string;
    }> => {
      const res = await http.post<{
        answer: string;
        suggestions: string[];
        insight_refs: string[];
        thread_key: string;
      }>(`/api/insights/${surveyId}/crystal`, { message, ...ctx });
      return res.data;
    },

    // Unified Crystal REST fallback — works for any scope.
    // scope is auto-detected from survey_id: present → survey, absent → org.
    crystalChat2: async (
      message: string,
      opts: { surveyId?: string; focusedTopic?: string; conversationHistory?: Array<{ role: string; content: string }> } = {},
    ): Promise<{ answer: string; suggestions: string[]; insight_refs: string[]; citations: string[]; citation_map?: Record<string, unknown> }> => {
      const res = await http.post<{
        answer: string; suggestions: string[]; insight_refs: string[]; citations: string[]; citation_map?: Record<string, unknown>;
      }>('/api/experience/crystal', {
        message,
        survey_id:            opts.surveyId ?? '',
        focused_topic:        opts.focusedTopic,
        conversation_history: opts.conversationHistory ?? [],
      });
      return res.data;
    },

    // Kept for backward compat — delegates to crystalChat2 with no survey_id
    crystalChatOrg: async (
      message: string,
      conversationHistory: Array<{ role: string; content: string }> = [],
    ): Promise<{ answer: string; suggestions: string[]; insight_refs: string[]; citations: string[] }> => {
      const res = await http.post<{
        answer: string; suggestions: string[]; insight_refs: string[]; citations: string[];
      }>('/api/experience/crystal', { message, survey_id: '', conversation_history: conversationHistory });
      return res.data;
    },

    getCrystalHistory: async (surveyId: string): Promise<{
      messages: Array<{ role: string; content: string; created_at: string }>;
      updated_at: string | null;
    }> => {
      const res = await http.get<{
        messages: Array<{ role: string; content: string; created_at: string }>;
        updated_at: string | null;
      }>(`/api/insights/${surveyId}/crystal/history`);
      return res.data;
    },

    clearCrystalHistory: async (surveyId: string): Promise<void> => {
      await http.delete(`/api/insights/${surveyId}/crystal/history`);
    },

    // ── Topics deep-dive ──────────────────────────────────────────────────────

    getTopicHierarchy: async (
      surveyId: string,
      window = 'all_time',
    ): Promise<{ themes: TopicTheme[]; total_topics: number; window: string }> => {
      const res = await http.get<{ themes: TopicTheme[]; total_topics: number; window: string }>(
        `/api/insights/${surveyId}/topics/hierarchy?window=${window}`,
      );
      // Postgres NUMERIC columns arrive as strings — coerce topic fields in every theme.
      const coerce = (v: unknown) => (v == null ? null : Number(v));
      type TopicWithSubtopics = SurveyTopic & { subtopics?: SurveyTopic[] };
      const coerceTopic = (t: TopicWithSubtopics): TopicWithSubtopics => ({
        ...t,
        sentiment_score:   coerce(t.sentiment_score),
        effort_score:      coerce(t.effort_score),
        urgency_score:     coerce(t.urgency_score),
        nps_avg:           coerce(t.nps_avg),
        positive_pct:      coerce(t.positive_pct),
        negative_pct:      coerce(t.negative_pct),
        volume_delta_pct:  coerce(t.volume_delta_pct),
        nps_impact:        coerce(t.nps_impact),
        net_sentiment:     coerce(t.net_sentiment),
        driver_score:      coerce(t.driver_score),
        avg_csat:          coerce(t.avg_csat),
        csat_impact:       coerce(t.csat_impact),
        avg_effort_score:  coerce(t.avg_effort_score),
        velocity_pct:      coerce(t.velocity_pct),
        promoter_pct:      coerce(t.promoter_pct),
        detractor_pct:     coerce(t.detractor_pct),
        passive_pct:       coerce(t.passive_pct),
        subtopics:         t.subtopics?.map(coerceTopic),
      });
      const themes = (res.data.themes ?? []).map((theme) => ({
        ...theme,
        topics: (theme.topics ?? []).map(coerceTopic),
      }));
      return { ...res.data, themes };
    },

    getTopicDetail: async (
      surveyId: string,
      topicId: string,
      window = 'all_time',
    ): Promise<{ topic: SurveyTopic; detail: TopicDetail; window: string }> => {
      const res = await http.get<{ topic: SurveyTopic; detail: TopicDetail; window: string }>(
        `/api/insights/${surveyId}/topics/${topicId}/detail?window=${window}`,
      );
      const coerce = (v: unknown) => (v == null ? null : Number(v));
      const coerceTopic = (t: SurveyTopic): SurveyTopic => ({
        ...t,
        sentiment_score:  coerce(t.sentiment_score),
        effort_score:     coerce(t.effort_score),
        urgency_score:    coerce(t.urgency_score),
        nps_avg:          coerce(t.nps_avg),
        positive_pct:     coerce(t.positive_pct),
        negative_pct:     coerce(t.negative_pct),
        volume_delta_pct: coerce(t.volume_delta_pct),
        nps_impact:       coerce(t.nps_impact),
        net_sentiment:    coerce(t.net_sentiment),
        driver_score:     coerce(t.driver_score),
        avg_csat:         coerce(t.avg_csat),
        csat_impact:      coerce(t.csat_impact),
        avg_effort_score: coerce(t.avg_effort_score),
        velocity_pct:     coerce(t.velocity_pct),
        promoter_pct:     coerce(t.promoter_pct),
        detractor_pct:    coerce(t.detractor_pct),
        passive_pct:      coerce(t.passive_pct),
      } as SurveyTopic);
      const raw = res.data;
      return {
        ...raw,
        topic:  raw.topic  ? coerceTopic(raw.topic)  : raw.topic,
        detail: raw.detail ? {
          ...raw.detail,
          subtopics: (raw.detail.subtopics ?? []).map(coerceTopic),
        } : raw.detail,
      };
    },

    getTopicVerbatims: async (
      surveyId: string,
      topicId: string,
      opts: { limit?: number; offset?: number; sentiment?: string; nps_bucket?: string; window?: string } = {},
    ): Promise<{ verbatims: TopicVerbatim[]; total: number; has_more: boolean; limit: number; offset: number }> => {
      const params = new URLSearchParams();
      if (opts.limit)      params.set('limit',      String(opts.limit));
      if (opts.offset)     params.set('offset',     String(opts.offset));
      if (opts.sentiment)  params.set('sentiment',  opts.sentiment);
      if (opts.nps_bucket) params.set('nps_bucket', opts.nps_bucket);
      if (opts.window && opts.window !== 'all_time') params.set('window', opts.window);
      const qs = params.toString();
      const res = await http.get<{ verbatims: TopicVerbatim[]; total: number; has_more: boolean; limit: number; offset: number }>(
        `/api/insights/${surveyId}/topics/${topicId}/verbatims${qs ? '?' + qs : ''}`,
      );
      return res.data;
    },

    renameTopic: async (surveyId: string, topicId: string, name: string): Promise<{ success: boolean; name: string }> => {
      const res = await http.patch<{ success: boolean; name: string }>(
        `/api/insights/${surveyId}/topics/${topicId}`,
        { name },
      );
      return res.data;
    },

    // ── Analytics ──────────────────────────────────────────────────────────────

    getSurveyAnalytics: async (surveyId: string): Promise<{
      total_responses:  number;
      avg_nps:          number | null;
      completion_rate:  number;
      nps_distribution: { promoters: number; passives: number; detractors: number };
      responses_by_day: Array<{ day: string; count: number }>;
    }> => {
      const res = await http.get(`/api/surveys/${surveyId}/analytics`);
      return res.data;
    },

    getOrgAnalytics: async (): Promise<{
      total_surveys:    number;
      active_surveys:   number;
      total_responses:  number;
      avg_nps:          number | null;
      responses_by_day: Array<{ day: string; count: number }>;
      top_surveys:      Array<{ id: string; title: string; response_count: number }>;
    }> => {
      const res = await http.get('/api/orgs/me/analytics');
      return res.data;
    },

    getExperienceOverview: async (): Promise<{
      surveys: Array<{
        id: string; title: string; status: string;
        response_count: number; nps_score: number | null;
        csat_score: number | null; metrics_at: string | null;
      }>;
      portfolio_metrics: {
        nps_score: number | null; csat_score: number | null;
        response_count: number; survey_count: number; captured_at: string;
      } | null;
      active_survey_count: number;
    }> => {
      const res = await http.get('/api/experience/org/overview');
      return res.data;
    },

    // ── Time-series metric history ────────────────────────────────────────────

    getSurveyMetricHistory: async (
      surveyId: string,
      days = 90,
    ): Promise<{ history: MetricSnapshot[]; days: number; survey_id: string }> => {
      const res = await http.get<{ history: MetricSnapshot[]; days: number; survey_id: string }>(
        `/api/insights/${surveyId}/metric-history?days=${days}`,
      );
      return res.data;
    },

    getTopicTrends: async (
      surveyId: string,
      opts: { topicId?: string; weeks?: number } = {},
    ): Promise<{ topics: TopicTrend[]; weeks: number; survey_id: string }> => {
      const params = new URLSearchParams();
      if (opts.weeks)   params.set('weeks',   String(opts.weeks));
      if (opts.topicId) params.set('topicId', opts.topicId);
      const qs = params.toString();
      const res = await http.get<{ topics: TopicTrend[]; weeks: number; survey_id: string }>(
        `/api/insights/${surveyId}/topic-trends${qs ? '?' + qs : ''}`,
      );
      return res.data;
    },

    getOrgMetricHistory: async (
      days = 90,
    ): Promise<{ history: OrgMetricSnapshot[]; days: number; org_id: string }> => {
      const res = await http.get<{ history: OrgMetricSnapshot[]; days: number; org_id: string }>(
        `/api/insights/org/metric-history?days=${days}`,
      );
      return res.data;
    },

    // ── Org Dashboard (Command Center) ──────────────────────────────────────────
    // Endpoints owned by the Backend Engineer agent working in parallel on this
    // branch (docs/org-dashboard/IMPLEMENTATION_SPEC.md, "File ownership").
    // Response shapes follow ARCHITECTURE.md's "API Design" section, reconciled
    // per that spec: `programs[].tags` is an array (0-5 `survey_tags` rows per
    // survey), not the singular `tagGroupId`/`tagGroupName` in the original doc.

    getOrgDashboard: async (): Promise<OrgDashboardPayload> => {
      const res = await http.get<OrgDashboardPayload>('/api/org/dashboard');
      return res.data;
    },

    getOrgDashboardTrends: async (
      range: TrendRange = '30d',
      granularity?: TrendGranularity,
    ): Promise<OrgTrendsResponse> => {
      const qs = new URLSearchParams({ range });
      if (granularity) qs.set('granularity', granularity);
      const res = await http.get<OrgTrendsResponse>(`/api/org/dashboard/trends?${qs}`);
      return res.data;
    },

    getOrgDashboardPrograms: async (query: ProgramsQuery = {}): Promise<ProgramsResponse> => {
      const qs = new URLSearchParams();
      if (query.page)     qs.set('page',     String(query.page));
      if (query.pageSize) qs.set('pageSize', String(query.pageSize));
      if (query.sort)     qs.set('sort',     query.sort);
      if (query.order)    qs.set('order',    query.order);
      if (query.tagId)    qs.set('tagGroupId', query.tagId);
      if (query.status)   qs.set('status',   query.status);
      const q = qs.toString();
      const res = await http.get<ProgramsResponse>(`/api/org/dashboard/programs${q ? `?${q}` : ''}`);
      return res.data;
    },

    getOrgDashboardTopics: async (): Promise<OrgTopicsResponse> => {
      const res = await http.get<OrgTopicsResponse>('/api/org/dashboard/topics');
      return res.data;
    },

    getOrgTopicBreakdown: async (topicLabel: string): Promise<OrgTopicBreakdown> => {
      const res = await http.get<OrgTopicBreakdown>(`/api/org/dashboard/topics/${encodeURIComponent(topicLabel)}`);
      return res.data;
    },

    getOrgDashboardAlerts: async (limit = 20): Promise<OrgAlertsResponse> => {
      const res = await http.get<OrgAlertsResponse>(`/api/org/dashboard/alerts?limit=${limit}`);
      return res.data;
    },

    acknowledgeOrgAlert: async (alertId: string): Promise<{ alertId: string; acknowledgedAt: string }> => {
      const res = await http.patch<{ alertId: string; acknowledgedAt: string }>(
        `/api/org/dashboard/alerts/${alertId}/acknowledge`,
        {},
      );
      return res.data;
    },

    getOrgCrystalBrief: async (): Promise<CrystalBrief & { inputSnapshot?: object | null }> => {
      const res = await http.get<CrystalBrief & { inputSnapshot?: object | null }>('/api/org/dashboard/crystal-brief');
      return res.data;
    },

    regenerateOrgCrystalBrief: async (): Promise<{ jobId: string; estimatedSeconds: number }> => {
      const res = await http.post<{ jobId: string; estimatedSeconds: number }>('/api/org/dashboard/crystal-brief/regenerate', {});
      return res.data;
    },

    getOrgHealthScoreDetail: async (): Promise<OrgHealthScoreDetail> => {
      const res = await http.get<OrgHealthScoreDetail>('/api/org/health-score');
      return res.data;
    },

    getOrgDashboardBriefs: async (page = 1, pageSize = 25): Promise<BriefsResponse> => {
      const res = await http.get<BriefsResponse>(`/api/org/dashboard/briefs?page=${page}&pageSize=${pageSize}`);
      return res.data;
    },

    compareOrgBriefs: async (id: string, otherId: string): Promise<CheckpointComparisonResult> => {
      const res = await http.get<CheckpointComparisonResult>(`/api/org/dashboard/briefs/${id}/compare/${otherId}`);
      return res.data;
    },

    getOrgTagMetrics: async (): Promise<TagMetricsResponse> => {
      const res = await http.get<TagMetricsResponse>('/api/org/dashboard/tags');
      return res.data;
    },

    // Manual Summary Generator — mirrors CustomAnalysisPage's/ManualRun's
    // preview/create pattern exactly: `rawHttp` + `toManualRunError` so
    // `ManualSummaryGenerator.tsx` can branch on `err instanceof
    // ManualRunError` and `.code` (402 → INSUFFICIENT_CREDITS, 429 →
    // RATE_LIMITED) instead of parsing message strings or reinventing a
    // second error-normalization path.
    previewOrgSummary: async (req: SummaryPreviewRequest): Promise<SummaryPreviewResponse> => {
      try {
        const res = await rawHttp.post<SummaryPreviewResponse>('/api/org/dashboard/summaries/preview', req);
        return res.data;
      } catch (error) {
        throw toManualRunError(error);
      }
    },

    createOrgSummary: async (req: CreateSummaryRequest): Promise<CreateSummaryResponse> => {
      try {
        const res = await rawHttp.post<CreateSummaryResponse>('/api/org/dashboard/summaries', req);
        return res.data;
      } catch (error) {
        throw toManualRunError(error);
      }
    },

    listOrgSummaries: async (): Promise<{ summaries: OrgSummary[] }> => {
      const res = await http.get<{ summaries: OrgSummary[] }>('/api/org/dashboard/summaries');
      return res.data;
    },

    getOrgSummary: async (id: string): Promise<{ summary: OrgSummary }> => {
      const res = await http.get<{ summary: OrgSummary }>(`/api/org/dashboard/summaries/${id}`);
      return res.data;
    },

    // ── User Directory ─────────────────────────────────────────────────────────

    listUsers: async (params: ListUsersParams = {}): Promise<{
      users: DirectoryUser[]; total: number; limit: number; offset: number; hasMore: boolean;
    }> => {
      const qs = new URLSearchParams();
      if (params.search)       qs.set('search', params.search);
      if (params.roleId)       qs.set('roleId', params.roleId);
      if (params.roleKey)      qs.set('roleKey', params.roleKey);
      if (params.departmentId) qs.set('departmentId', params.departmentId);
      if (params.status)       qs.set('status', params.status);
      if (params.limit != null)  qs.set('limit', String(params.limit));
      if (params.offset != null) qs.set('offset', String(params.offset));
      const query = qs.toString() ? `?${qs}` : '';
      const res = await http.get(`/api/users${query}`);
      return res.data;
    },
    getUser: async (userId: string): Promise<{ user: DirectoryUser }> => {
      const res = await http.get(`/api/users/${userId}`);
      return res.data;
    },
    inviteUser: async (payload: { email: string; roleId?: string; jobTitle?: string; departmentId?: string }): Promise<{ success: boolean; user: DirectoryUser }> => {
      const res = await http.post('/api/users/invite', payload);
      return res.data;
    },
    updateUser: async (userId: string, data: UpdateUserPayload): Promise<{ user: DirectoryUser }> => {
      const res = await http.patch(`/api/users/${userId}`, data);
      return res.data;
    },
    deleteUser: async (userId: string): Promise<{ success: boolean }> => {
      const res = await http.delete(`/api/users/${userId}`);
      return res.data;
    },

    // ── Roles ──────────────────────────────────────────────────────────────────

    listRoles: async (): Promise<{ roles: DirectoryRole[] }> => {
      const res = await http.get('/api/roles');
      return res.data;
    },
    createRole: async (data: {
      name: string; description?: string; permissions: Record<string, PermissionScope>;
      seatWeight?: number; color?: string;
    }): Promise<{ role: DirectoryRole }> => {
      const res = await http.post('/api/roles', data);
      return res.data;
    },
    updateRole: async (id: string, data: {
      name?: string; description?: string | null; permissions?: Record<string, PermissionScope>;
      seatWeight?: number; color?: string | null;
    }): Promise<{ role: DirectoryRole }> => {
      const res = await http.patch(`/api/roles/${id}`, data);
      return res.data;
    },
    deleteRole: async (id: string): Promise<{ success: boolean }> => {
      const res = await http.delete(`/api/roles/${id}`);
      return res.data;
    },

    // ── Departments ────────────────────────────────────────────────────────────

    listDepartments: async (): Promise<{ tree: DepartmentNode[]; flat: DepartmentNode[] }> => {
      const res = await http.get('/api/departments');
      return res.data;
    },
    createDepartment: async (data: {
      name: string; description?: string | null; parentDepartmentId?: string | null;
      headUserId?: string | null; color?: string | null; sortOrder?: number;
    }): Promise<{ department: DepartmentNode }> => {
      const res = await http.post('/api/departments', data);
      return res.data;
    },
    updateDepartment: async (id: string, data: Record<string, unknown>): Promise<{ department: DepartmentNode }> => {
      const res = await http.patch(`/api/departments/${id}`, data);
      return res.data;
    },
    deleteDepartment: async (id: string): Promise<{ success: boolean }> => {
      const res = await http.delete(`/api/departments/${id}`);
      return res.data;
    },

    // ── Groups ─────────────────────────────────────────────────────────────────

    listGroups: async (): Promise<{ groups: UserGroup[] }> => {
      const res = await http.get('/api/groups');
      return res.data;
    },
    createGroup: async (data: {
      name: string; description?: string | null; groupType: GroupType; dynamicRules?: DynamicRuleSet;
    }): Promise<{ group: UserGroup }> => {
      const res = await http.post('/api/groups', data);
      return res.data;
    },
    updateGroup: async (id: string, data: Record<string, unknown>): Promise<{ group: UserGroup }> => {
      const res = await http.patch(`/api/groups/${id}`, data);
      return res.data;
    },
    deleteGroup: async (id: string): Promise<{ success: boolean }> => {
      const res = await http.delete(`/api/groups/${id}`);
      return res.data;
    },
    getGroupMembers: async (id: string): Promise<{ members: GroupMember[] }> => {
      const res = await http.get(`/api/groups/${id}/members`);
      return res.data;
    },
    addGroupMember: async (id: string, userId: string): Promise<{ success: boolean }> => {
      const res = await http.post(`/api/groups/${id}/members`, { userId });
      return res.data;
    },
    removeGroupMember: async (id: string, userId: string): Promise<{ success: boolean }> => {
      const res = await http.delete(`/api/groups/${id}/members/${userId}`);
      return res.data;
    },

    // ── SCIM provisioning tokens ─────────────────────────────────────────────────

    listScimTokens: async (): Promise<{ tokens: ScimToken[]; scimBaseUrl: string }> => {
      const res = await http.get('/api/scim-tokens');
      return res.data;
    },
    createScimToken: async (data: { name: string; provider?: string }): Promise<{ token: string } & ScimToken> => {
      const res = await http.post('/api/scim-tokens', data);
      return res.data;
    },
    revokeScimToken: async (id: string): Promise<{ success: boolean }> => {
      const res = await http.delete(`/api/scim-tokens/${id}`);
      return res.data;
    },

    // ── SSO attribute mapping ────────────────────────────────────────────────────

    getSsoMappings: async (): Promise<{ mappings: Record<string, string> }> => {
      const res = await http.get('/api/sso-mappings');
      return res.data;
    },
    updateSsoMappings: async (mappings: Record<string, string>): Promise<{ mappings: Record<string, string> }> => {
      const res = await http.put('/api/sso-mappings', { mappings });
      return res.data;
    },

    // ── Seats + Audit ────────────────────────────────────────────────────────────

    getSeatBreakdown: async (): Promise<SeatBreakdown> => {
      const res = await http.get('/api/seats/breakdown');
      return res.data;
    },
    listAuditLogs: async (params: {
      page?: number; limit?: number; event_type?: string; actor_user_id?: string; target_user_id?: string;
    } = {}): Promise<{ events: AuditEvent[]; total: number; page: number; limit: number; pages: number }> => {
      const qs = new URLSearchParams();
      Object.entries(params).forEach(([k, v]) => { if (v != null) qs.set(k, String(v)); });
      const res = await http.get(`/api/audit-logs${qs.toString() ? `?${qs}` : ''}`);
      return res.data;
    },
    exportAuditLogsCsv: async (): Promise<string> => {
      const res = await http.get('/api/audit-logs', { params: { format: 'csv' }, responseType: 'text' });
      return res.data as string;
    },
    // ── Survey Tags ────────────────────────────────────────────────────────────

    // ── Survey Tags ────────────────────────────────────────────────────────────

    listTags: async (params: { q?: string } = {}): Promise<{ tags: SurveyTag[] }> => {
      const qs = new URLSearchParams();
      if (params.q) qs.set('q', params.q);
      const query = qs.toString() ? `?${qs}` : '';
      const res = await http.get<{ tags: SurveyTag[] }>(`/api/survey-tags${query}`);
      return res.data;
    },

    createTag: async (data: { name: string; color?: string; description?: string }): Promise<{ tag: SurveyTag }> => {
      const res = await http.post<{ tag: SurveyTag }>('/api/survey-tags', data);
      return res.data;
    },

    updateTag: async (id: string, data: Partial<SurveyTag>): Promise<{ tag: SurveyTag }> => {
      const res = await http.patch<{ tag: SurveyTag }>(`/api/survey-tags/${id}`, data);
      return res.data;
    },

    deleteTag: async (id: string): Promise<{ success: boolean }> => {
      const res = await http.delete<{ success: boolean }>(`/api/survey-tags/${id}`);
      return res.data;
    },

    getTagSurveys: async (tagId: string): Promise<{ surveys: Survey[]; tag: SurveyTag }> => {
      const res = await http.get<{ surveys: Survey[]; tag: SurveyTag }>(`/api/survey-tags/${tagId}/surveys`);
      return res.data;
    },

    // Survey-tag mappings live under /api/surveys/:id/tags in surveys.js
    addTagsToSurvey: async (surveyId: string, tagIds: string[]): Promise<{ success: boolean }> => {
      const res = await http.post<{ success: boolean }>(`/api/surveys/${surveyId}/tags`, { tag_ids: tagIds });
      return res.data;
    },

    removeTagFromSurvey: async (surveyId: string, tagId: string): Promise<{ success: boolean }> => {
      const res = await http.delete<{ success: boolean }>(`/api/surveys/${surveyId}/tags/${tagId}`);
      return res.data;
    },

    // ── Group Insights ─────────────────────────────────────────────────────────

    generateGroupInsights: async (data: { tag_ids: string[]; survey_ids?: string[] }): Promise<{ run_id: string }> => {
      const res = await http.post<{ run_id: string }>('/api/group-insights/generate', data);
      return res.data;
    },

    getGroupInsightRunStatus: async (runId: string): Promise<GroupInsightRun> => {
      const res = await http.get<GroupInsightRun>(`/api/group-insights/${runId}/status`);
      return res.data;
    },

    getGroupInsightRun: async (runId: string): Promise<{ run: GroupInsightRun; insights: GroupInsight[] }> => {
      const res = await http.get<{ run: GroupInsightRun; insights: GroupInsight[] }>(`/api/group-insights/${runId}`);
      return res.data;
    },

    getLatestGroupReport: async (tagId: string): Promise<{ run: GroupInsightRun } | null> => {
      try {
        const res = await http.get<{ run: GroupInsightRun }>(`/api/survey-tags/${tagId}/latest-report`);
        return res.data;
      } catch {
        return null;
      }
    },

    // ── Tag Report ─────────────────────────────────────────────────────────────
    // Contract per docs/tag-report/DESIGN.md Appendix A.2 / TRACKER.md §1.
    // CORRECTED 2026-07-02 during integration: TRACKER.md's literal path prose
    // (`/api/survey-groups/...`, `/api/tags/...`) is stale — survey-groups.ts is
    // actually mounted at `/api/group-insights` and tags.ts at `/api/survey-tags`
    // (backend/src/index.ts:217-218; also flagged by the backend implementation
    // itself, which corrected both route files' own docblocks). Paths below match
    // the real mounts, verified directly against backend/src/routes/*.ts.

    generateTagReport: async (data: TagReportGenerateRequest): Promise<TagReportGenerateResponse> => {
      const path = data.run_mode === 'custom_range'
        ? '/api/group-insights/tag-report/custom-range'
        : '/api/group-insights/tag-report/manual';
      const res = await http.post<TagReportGenerateResponse>(path, data);
      return res.data;
    },

    getTagReportRun: async (runId: string): Promise<TagReportRunResponse> => {
      const res = await http.get<TagReportRunResponse>(`/api/group-insights/tag-report/${runId}`);
      return res.data;
    },

    // Paginated run history across all three modes (`/api/survey-tags/:id/tag-report-history`).
    // Used to resolve "latest" (limit=1) and to power the Trail page's run list.
    getTagReportHistory: async (
      tagId: string,
      params: { limit?: number; offset?: number } = {}
    ): Promise<{ runs: TagReportTrailEntry[]; total: number }> => {
      const qs = new URLSearchParams();
      if (params.limit != null) qs.set('limit', String(params.limit));
      if (params.offset != null) qs.set('offset', String(params.offset));
      const query = qs.toString() ? `?${qs}` : '';
      const res = await http.get<{ runs: TagReportTrailEntry[]; total: number }>(
        `/api/survey-tags/${tagId}/tag-report-history${query}`
      );
      return res.data;
    },

    getTagReportTrail: async (runId: string): Promise<TagReportTrailResponse> => {
      const res = await http.get<TagReportTrailResponse>(`/api/group-insights/tag-report/${runId}/trail`);
      return res.data;
    },

    listTagReports: async (params: { q?: string; sort?: 'recent' | 'alpha' | 'survey_count' } = {}): Promise<TagReportsIndexResponse> => {
      const qs = new URLSearchParams();
      if (params.q) qs.set('q', params.q);
      if (params.sort) qs.set('sort', params.sort);
      const query = qs.toString() ? `?${qs}` : '';
      const res = await http.get<TagReportsIndexResponse>(`/api/group-insights/tag-reports${query}`);
      return res.data;
    },

    // Download a survey insight report. 'pdf'/'pptx' return native files (when the
    // server has puppeteer/pptxgenjs); otherwise the server falls back to HTML.
    // Returns the actual format delivered so the caller can name the file correctly.
    downloadReport: async (surveyId: string, format: 'pdf' | 'pptx' | 'html'): Promise<{ blob: Blob; format: string }> => {
      const res = await http.get(`/api/visual/report/${surveyId}`, { params: { format }, responseType: 'blob' });
      // If the server fell back to HTML it signals it via this header.
      const fellBack = res.headers['x-export-fallback'];
      return { blob: res.data as Blob, format: fellBack ? 'html' : format };
    },

    // ── Contacts (Tier 3) ──────────────────────────────────────────────────────
    createContact: async (data: Partial<Contact>): Promise<Contact> => {
      const res = await http.post<{ contact: Contact }>('/api/contacts', data);
      return res.data.contact;
    },

    listContacts: async (params?: { search?: string; account_id?: string; page?: number; limit?: number }): Promise<{ contacts: Contact[]; total: number }> => {
      const qs = new URLSearchParams();
      if (params?.search)     qs.set('search',     params.search);
      if (params?.account_id) qs.set('account_id', params.account_id);
      if (params?.page)       qs.set('page',       String(params.page));
      if (params?.limit)      qs.set('limit',      String(params.limit));
      const query = qs.toString() ? `?${qs}` : '';
      const res = await http.get<{ contacts: Contact[]; total: number }>(`/api/contacts${query}`);
      return res.data;
    },

    getContact: async (id: string): Promise<Contact> => {
      const res = await http.get<{ contact: Contact }>(`/api/contacts/${id}`);
      return res.data.contact;
    },

    updateContact: async (id: string, data: Partial<Contact>): Promise<Contact> => {
      const res = await http.put<{ contact: Contact }>(`/api/contacts/${id}`, data);
      return res.data.contact;
    },

    anonymizeContact: async (id: string): Promise<void> => {
      await http.delete(`/api/contacts/${id}`);
    },

    importContacts: async (contacts: Partial<Contact>[]): Promise<{
      created: number;
      updated: number;
      errors: Array<{ index: number; message: string }>;
    }> => {
      const res = await http.post<{
        created: number;
        updated: number;
        errors: Array<{ index: number; message: string }>;
      }>('/api/contacts/import', { contacts });
      return res.data;
    },

    generateDistributionTokens: async (
      surveyId: string,
      contactIds: string[],
      channel: string,
    ): Promise<{ tokens: { contact_id: string; token: string; url: string }[] }> => {
      const res = await http.post<{ tokens: { contact_id: string; token: string; url: string }[] }>(
        `/api/surveys/${surveyId}/distribution-tokens`,
        { contact_ids: contactIds, channel },
      );
      return res.data;
    },

    // ── CX Cases (Tier 3) ──────────────────────────────────────────────────────
    createCase: async (data: Partial<CxCase>): Promise<CxCase> => {
      const res = await http.post<{ case: CxCase }>('/api/cases', data);
      return res.data.case;
    },

    listCases: async (params?: {
      status?: string;
      severity?: string;
      owner_user_id?: string;
      survey_id?: string;
      search?: string;
      page?: number;
      limit?: number;
    }): Promise<{ cases: CxCase[]; total: number }> => {
      const qs = new URLSearchParams();
      if (params?.status)        qs.set('status',        params.status);
      if (params?.severity)      qs.set('severity',      params.severity);
      if (params?.owner_user_id) qs.set('owner_user_id', params.owner_user_id);
      if (params?.survey_id)     qs.set('survey_id',     params.survey_id);
      if (params?.search)        qs.set('search',        params.search);
      if (params?.page)          qs.set('page',          String(params.page));
      if (params?.limit)         qs.set('limit',         String(params.limit));
      const query = qs.toString() ? `?${qs}` : '';
      const res = await http.get<{ cases: CxCase[]; total: number }>(`/api/cases${query}`);
      return res.data;
    },

    getCase: async (id: string): Promise<CxCase> => {
      const res = await http.get<{ case: CxCase }>(`/api/cases/${id}`);
      return res.data.case;
    },

    updateCase: async (id: string, data: Partial<CxCase>): Promise<CxCase> => {
      const res = await http.put<{ case: CxCase }>(`/api/cases/${id}`, data);
      return res.data.case;
    },

    addCaseEvent: async (id: string, event: { action: string; note?: string }): Promise<CaseAuditEntry[]> => {
      const res = await http.post<{ audit_log: CaseAuditEntry[] }>(`/api/cases/${id}/events`, event);
      return res.data.audit_log;
    },

    getSlaDashboard: async (): Promise<{ open_count: number; at_risk_count: number; breached_count: number; by_severity: Record<string, number> }> => {
      const res = await http.get<{ open_count: number; at_risk_count: number; breached_count: number; by_severity: Record<string, number> }>('/api/cases/sla-dashboard');
      return res.data;
    },

    // ── Ownership Routing (Tier 3) ─────────────────────────────────────────────
    listOwnershipRoutes: async (dimension?: string): Promise<OwnershipRoute[]> => {
      const qs = dimension ? `?dimension=${encodeURIComponent(dimension)}` : '';
      const res = await http.get<{ routes: OwnershipRoute[] }>(`/api/ownership-routes${qs}`);
      return res.data.routes;
    },

    createOwnershipRoute: async (data: Partial<OwnershipRoute>): Promise<OwnershipRoute> => {
      const res = await http.post<{ route: OwnershipRoute }>('/api/ownership-routes', data);
      return res.data.route;
    },

    updateOwnershipRoute: async (id: string, data: Partial<OwnershipRoute>): Promise<OwnershipRoute> => {
      const res = await http.put<{ route: OwnershipRoute }>(`/api/ownership-routes/${id}`, data);
      return res.data.route;
    },

    deleteOwnershipRoute: async (id: string): Promise<void> => {
      await http.delete(`/api/ownership-routes/${id}`);
    },

    resolveOwnershipRoute: async (dimension: string, value: string): Promise<{ matched: boolean; route: OwnershipRoute | null }> => {
      const res = await http.post<{ matched: boolean; route: OwnershipRoute | null }>('/api/ownership-routes/resolve', { dimension, value });
      return res.data;
    },

    // ── Ontology (Tier 3) ──────────────────────────────────────────────────────
    listOntologyNodes: async (category?: string): Promise<OntologyNode[]> => {
      const qs = category ? `?category=${encodeURIComponent(category)}` : '';
      const res = await http.get<{ nodes: OntologyNode[] }>(`/api/ontology${qs}`);
      return res.data.nodes;
    },

    getOntologyNode: async (id: string): Promise<OntologyNode & { edges: unknown[]; mappings: unknown[] }> => {
      const res = await http.get<OntologyNode & { edges: unknown[]; mappings: unknown[] }>(`/api/ontology/${id}`);
      return res.data;
    },

    createOntologyNode: async (data: Partial<OntologyNode>): Promise<OntologyNode> => {
      const res = await http.post<{ node: OntologyNode }>('/api/ontology', data);
      return res.data.node;
    },

    createOntologyEdge: async (data: { from_node_id: string; to_node_id: string; relationship: string; weight?: number }): Promise<unknown> => {
      const res = await http.post<unknown>('/api/ontology/edges', data);
      return res.data;
    },

    createOntologyMapping: async (data: unknown): Promise<unknown> => {
      const res = await http.post<unknown>('/api/ontology/mappings', data);
      return res.data;
    },

    // ── Contact Segments ──────────────────────────────────────────────────────
    listSegments: async (): Promise<ContactSegment[]> => {
      const res = await http.get<{ segments: ContactSegment[] }>('/api/contacts/segments');
      return res.data.segments;
    },
    createSegment: async (data: Partial<ContactSegment>): Promise<ContactSegment> => {
      const res = await http.post<{ segment: ContactSegment }>('/api/contacts/segments', data);
      return res.data.segment;
    },
    updateSegment: async (id: string, data: Partial<ContactSegment>): Promise<ContactSegment> => {
      const res = await http.put<{ segment: ContactSegment }>(`/api/contacts/segments/${id}`, data);
      return res.data.segment;
    },
    deleteSegment: async (id: string): Promise<void> => {
      await http.delete(`/api/contacts/segments/${id}`);
    },
    previewSegment: async (filterDef: FilterDef): Promise<{ count: number; preview: Contact[] }> => {
      const res = await http.post<{ count: number; preview: Contact[] }>('/api/contacts/segments/preview', { filter_def: filterDef });
      return res.data;
    },
    refreshSegment: async (id: string): Promise<{ contact_count: number }> => {
      const res = await http.post<{ contact_count: number }>(`/api/contacts/segments/${id}/refresh`);
      return res.data;
    },
    getSegmentMembers: async (id: string, params?: { page?: number; limit?: number }): Promise<{ members: Contact[]; total: number }> => {
      const q = new URLSearchParams();
      if (params?.page) q.set('page', String(params.page));
      if (params?.limit) q.set('limit', String(params.limit));
      const res = await http.get<{ members: Contact[]; total: number }>(`/api/contacts/segments/${id}/members?${q}`);
      return res.data;
    },
    addSegmentMember: async (segmentId: string, contactId: string): Promise<void> => {
      await http.post(`/api/contacts/segments/${segmentId}/members`, { contact_id: contactId });
    },
    removeSegmentMember: async (segmentId: string, contactId: string): Promise<void> => {
      await http.delete(`/api/contacts/segments/${segmentId}/members/${contactId}`);
    },

    // ── CRM Sync ──────────────────────────────────────────────────────────────
    listSyncConfigs: async (): Promise<SyncConfig[]> => {
      const res = await http.get<{ configs: SyncConfig[] }>('/api/contacts/sync/configs');
      return res.data.configs;
    },
    createSyncConfig: async (data: Partial<SyncConfig>): Promise<SyncConfig> => {
      const res = await http.post<{ config: SyncConfig }>('/api/contacts/sync/configs', data);
      return res.data.config;
    },
    updateSyncConfig: async (id: string, data: Partial<SyncConfig>): Promise<SyncConfig> => {
      const res = await http.put<{ config: SyncConfig }>(`/api/contacts/sync/configs/${id}`, data);
      return res.data.config;
    },
    deleteSyncConfig: async (id: string): Promise<void> => {
      await http.delete(`/api/contacts/sync/configs/${id}`);
    },
    runSync: async (id: string): Promise<{ log_id: string; status: string }> => {
      const res = await http.post<{ log_id: string; status: string }>(`/api/contacts/sync/configs/${id}/run`);
      return res.data;
    },
    getSyncLogs: async (id: string): Promise<SyncLog[]> => {
      const res = await http.get<{ logs: SyncLog[] }>(`/api/contacts/sync/configs/${id}/logs`);
      return res.data.logs;
    },

    // ── Workflow Credentials (Integrations Settings) ───────────────────────────
    // See docs/automation-hub/INTEGRATIONS_BACKEND_REVIEW.md for the final API
    // shape — one GET reports status for all 6 CONNECTORS (jira/salesforce/
    // servicenow/zendesk/slack/webhook), Slack unified into the same response
    // server-side. PUT merges onto the existing saved row (safe to send only
    // the fields the user actually changed).
    listWorkflowCredentials: async (): Promise<WorkflowConnectorEntry[]> => {
      const res = await http.get<{ connectors: WorkflowConnectorEntry[] }>('/api/workflow-credentials');
      return res.data.connectors;
    },
    setWorkflowCredentials: async (connector: WorkflowConnectorName, data: Record<string, unknown>): Promise<{ connector: string; configured: boolean }> => {
      const res = await http.put<{ connector: string; configured: boolean }>(`/api/workflow-credentials/${connector}`, { data });
      return res.data;
    },
    deleteWorkflowCredentials: async (connector: WorkflowConnectorName): Promise<void> => {
      await http.delete(`/api/workflow-credentials/${connector}`);
    },
    // Test-before-save: pass `data` to test candidate values without persisting
    // them; omit `data` to test the currently-saved/effective (vault → env-var
    // fallback) credentials. Uses `rawHttp` so a 429 from connectorTestLimiter
    // (10/org/15min) is surfaced as a typed ConnectorTestError, not swallowed
    // into a generic message — see ConnectorTestError above.
    testWorkflowCredentials: async (connector: WorkflowConnectorName, data?: Record<string, unknown>): Promise<ConnectorTestResult> => {
      try {
        const res = await rawHttp.post<ConnectorTestResult>(`/api/workflow-credentials/${connector}/test`, data ? { data } : {});
        return res.data;
      } catch (error) {
        const e = error as { response?: { status?: number; data?: { error?: string; message?: string } }; message?: string };
        const status = e?.response?.status;
        const message = e?.response?.data?.error || e?.response?.data?.message || e?.message || 'Test failed';
        throw new ConnectorTestError(message, status);
      }
    },

    // ── Response Linking ──────────────────────────────────────────────────────
    getContactActivity: async (contactId: string): Promise<{ timeline: ActivityItem[]; segments: ContactSegment[] }> => {
      const res = await http.get<{ timeline: ActivityItem[]; segments: ContactSegment[] }>(`/api/contacts/${contactId}/activity`);
      return res.data;
    },
    backfillResponseLinks: async (limit?: number): Promise<{ processed: number; linked: number; skipped: number }> => {
      const res = await http.post<{ processed: number; linked: number; skipped: number }>('/api/contacts/link-responses', { limit });
      return res.data;
    },
    linkContactResponse: async (contactId: string, responseId: string): Promise<void> => {
      await http.post(`/api/contacts/${contactId}/link-response`, { response_id: responseId });
    },

    // ── Broadcasts (Outreach) ──────────────────────────────────────────────────
    createBroadcast: async (data: object): Promise<unknown> => {
      const res = await http.post('/api/outreach/broadcasts', data);
      return res.data;
    },

    approveBroadcast: async (id: string): Promise<unknown> => {
      const res = await http.post(`/api/outreach/broadcasts/${id}/approve`, {});
      return res.data;
    },

    rejectBroadcast: async (id: string, reason: string): Promise<unknown> => {
      const res = await http.post(`/api/outreach/broadcasts/${id}/reject`, { reason });
      return res.data;
    },

    sendBroadcast: async (id: string): Promise<unknown> => {
      const res = await http.post(`/api/outreach/broadcasts/${id}/send`, {});
      return res.data;
    },

    getBroadcasts: async (params?: { status?: string; limit?: number }): Promise<unknown> => {
      const qs = new URLSearchParams();
      if (params?.status) qs.set('status', params.status);
      if (params?.limit)  qs.set('limit', String(params.limit));
      const res = await http.get(`/api/outreach/broadcasts${qs.toString() ? `?${qs}` : ''}`);
      return res.data;
    },

    getBroadcastStats: async (): Promise<unknown> => {
      const res = await http.get('/api/outreach/broadcasts/stats');
      return res.data;
    },

    getBroadcastDetail: async (id: string): Promise<unknown> => {
      const res = await http.get(`/api/outreach/broadcasts/${id}`);
      return res.data;
    },

    // ── Notification Analytics ────────────────────────────────────────────────
    getNotificationSummary: async (period: string): Promise<unknown> => {
      const res = await http.get(`/api/outreach/analytics/summary?period=${period}`);
      return res.data;
    },

    getNotificationChannels: async (period: string): Promise<unknown> => {
      const res = await http.get(`/api/outreach/analytics/channels?period=${period}`);
      return res.data;
    },

    getNotificationWorkflows: async (period: string): Promise<unknown> => {
      const res = await http.get(`/api/outreach/analytics/workflows?period=${period}`);
      return res.data;
    },

    getFrequencyCaps: async (): Promise<unknown> => {
      const res = await http.get('/api/outreach/frequency-caps');
      return res.data;
    },

    upsertFrequencyCap: async (data: object): Promise<unknown> => {
      const res = await http.post('/api/outreach/frequency-caps', data);
      return res.data;
    },

    getNotificationSuppression: async (): Promise<unknown> => {
      const res = await http.get('/api/outreach/suppression/stats');
      return res.data;
    },

    // ── Novu subscriber hash ──────────────────────────────────────────────────
    getNovuSubscriberHash: async (): Promise<{ hash: string }> => {
      const res = await http.get<{ hash: string }>('/api/crystal-novu/subscriber-hash');
      return res.data;
    },

    // ── Billing & Credits ──────────────────────────────────────────────────────
    getCredits: async (): Promise<CreditBalance> => {
      const res = await http.get<CreditBalance>('/api/billing/credits');
      return res.data;
    },
    getCreditConfig: async (): Promise<CreditConfig> => {
      const res = await http.get<CreditConfig>('/api/billing/config');
      return res.data;
    },
    getCreditUsage: async (days?: number): Promise<CreditUsageResponse> => {
      const q = days ? `?days=${days}` : '';
      const res = await http.get<CreditUsageResponse>(`/api/billing/usage${q}`);
      return res.data;
    },
    getCreditLedger: async (limit = 50, offset = 0): Promise<{ entries: CreditLedgerEntry[]; total: number }> => {
      const res = await http.get<{ entries: CreditLedgerEntry[]; total: number }>(`/api/billing/ledger?limit=${limit}&offset=${offset}`);
      return res.data;
    },
    setSpendCap: async (data: { overage_enabled: boolean; overage_ceiling: number | null }): Promise<CreditBalance> => {
      const res = await http.put<CreditBalance>('/api/billing/spend-cap', data);
      return res.data;
    },
    setPlan: async (planTier: string): Promise<CreditBalance> => {
      const res = await http.post<CreditBalance>('/api/billing/plan', { plan_tier: planTier });
      return res.data;
    },
    grantCredits: async (credits: number, note?: string): Promise<CreditBalance> => {
      const res = await http.post<CreditBalance>('/api/billing/grant', { credits, note });
      return res.data;
    },
    getCreditPacks: async (): Promise<{ packs: CreditPack[]; stripe_enabled: boolean }> => {
      const res = await http.get<{ packs: CreditPack[]; stripe_enabled: boolean }>('/api/billing/packs');
      return res.data;
    },
    startCheckout: async (packId: string): Promise<{ url: string }> => {
      const res = await http.post<{ url: string }>('/api/billing/checkout', { pack_id: packId });
      return res.data;
    },

    // ── Support System API ─────────────────────────────────────────────────────

    getSupportDocs: async (params?: { q?: string; category?: string; limit?: number }): Promise<{ docs: SupportDoc[]; total: number; page: number; limit: number }> => {
      const qs = new URLSearchParams();
      if (params?.q)        qs.set('q',        params.q);
      if (params?.category) qs.set('category', params.category);
      if (params?.limit)    qs.set('limit',    String(params.limit));
      const res = await http.get<{ docs: SupportDoc[]; total: number; page: number; limit: number }>(
        `/api/support/docs${qs.toString() ? `?${qs}` : ''}`,
      );
      return res.data;
    },

    getSupportDoc: async (key: string): Promise<SupportDoc> => {
      const res = await http.get<SupportDoc>(`/api/support/docs/${encodeURIComponent(key)}`);
      return res.data;
    },

    getSupportChangelog: async (limit?: number): Promise<{ entries: ChangelogEntry[] }> => {
      const qs = limit ? `?limit=${limit}` : '';
      const res = await http.get<{ entries: ChangelogEntry[] }>(`/api/support/changelog${qs}`);
      return res.data;
    },

    getSupportKnownIssues: async (): Promise<{ issues: KnownIssue[] }> => {
      const res = await http.get<{ issues: KnownIssue[] }>('/api/support/known-issues');
      return res.data;
    },

    getSupportRoadmap: async (): Promise<{ sections: RoadmapSection[] }> => {
      const res = await http.get<{ sections: RoadmapSection[] }>('/api/support/roadmap');
      return res.data;
    },

    getSupportStatus: async (): Promise<SystemStatus> => {
      const res = await http.get<SystemStatus>('/api/support/status');
      return res.data;
    },

    getSupportAccount: async (): Promise<AccountState> => {
      const res = await http.get<AccountState>('/api/support/account');
      return res.data;
    },

    createSupportTicket: async (data: CreateTicketRequest): Promise<SupportTicket> => {
      const res = await http.post<SupportTicket>('/api/support/tickets', data);
      return res.data;
    },

    submitDocFeedback: async (data: DocFeedbackRequest): Promise<{ received: boolean }> => {
      const res = await http.post<{ received: boolean }>('/api/support/feedback', data);
      return res.data;
    },

    crystalSupport: async (message: string, context?: Record<string, unknown>): Promise<CrystalSupportResponse> => {
      const res = await http.post<CrystalSupportResponse>('/api/admin/crystal-support', { message, context });
      return res.data;
    },

    // ── Admin Support Pipeline ─────────────────────────────────────────────────

    adminSupportGetQueue: async (): Promise<{ docs: QueuedDoc[] }> => {
      const res = await http.get<{ docs?: QueuedDoc[]; queue?: Record<string, unknown>[] }>(
        '/api/admin-support/queue',
      );
      const rows = res.data.queue ?? res.data.docs ?? [];
      const docs = rows.map((row) =>
        row && typeof row === 'object' && 'docKey' in row
          ? (row as unknown as QueuedDoc)
          : mapQueuedDoc(row as Record<string, unknown>),
      );
      return { docs };
    },

    adminSupportGetFeed: async (): Promise<{ events: PipelineEvent[]; sinceLastVisit: number }> => {
      const res = await http.get<{
        events?: Record<string, unknown>[];
        sinceLastVisit?: number;
        since?: string;
      }>('/api/admin-support/feed');
      const events = (res.data.events ?? []).map((row) =>
        row && 'eventType' in row
          ? (row as unknown as PipelineEvent)
          : mapPipelineEvent(row),
      );
      return {
        events,
        sinceLastVisit: res.data.sinceLastVisit ?? events.length,
      };
    },

    adminSupportGetDoc: async (id: string): Promise<AdminDocDetail> => {
      const res = await http.get<Record<string, unknown>>(`/api/admin-support/docs/${id}`);
      return mapAdminDocDetail(res.data);
    },

    adminSupportApprove: async (docId: string): Promise<{ ok: boolean }> => {
      const res = await http.post<{ ok?: boolean; approved?: boolean }>(
        '/api/admin-support/approve',
        { docId },
      );
      return { ok: res.data.ok ?? res.data.approved ?? true };
    },

    adminSupportReject: async (docId: string, reason: string): Promise<{ ok: boolean }> => {
      const res = await http.post<{ ok?: boolean; rejected?: boolean }>(
        '/api/admin-support/reject',
        { docId, reason },
      );
      return { ok: res.data.ok ?? res.data.rejected ?? true };
    },

    adminSupportEditSections: async (docId: string, sections: SectionEdit[]): Promise<{ ok: boolean }> => {
      const res = await http.put<{ ok?: boolean; sectionsEdited?: number }>(
        '/api/admin-support/sections',
        {
          docId,
          sections: sections.map((s) => ({
            sectionKey: s.sectionKey,
            content:    s.content,
            lock:       s.locked,
          })),
        },
      );
      return { ok: res.data.ok ?? true };
    },

    adminSupportGetGaps: async (): Promise<{ gaps: DocGap[] }> => {
      const res = await http.get<{ gaps?: Record<string, unknown>[] }>('/api/admin-support/gaps');
      return { gaps: (res.data.gaps ?? []).map(mapDocGap) };
    },

    adminSupportGetStats: async (): Promise<PipelineStats> => {
      const res = await http.get<Record<string, unknown>>('/api/admin-support/stats');
      return mapPipelineStats(res.data);
    },

    // ── Prism — ingestion / migration ──────────────────────────────────────────
    // Postgres NUMERIC columns (confidence, counts, metric deltas) arrive as
    // strings — coerce so .toFixed()/arithmetic in the dry-run diff never crash.
    //
    // Response-shape safety: every Prism method routes its raw response through the
    // local `expectEntity`/`expectArray` helpers (defined just below) so an
    // unexpected backend shape throws ONE clear, named error here instead of a
    // downstream `Cannot read properties of undefined (reading 'id')` crash. The
    // helpers also tolerate the two historical wrappers ({ connection } | { connectionId },
    // { job } | { jobId }) and normalize to the canonical DTO in types/prism.ts.

    listPrismConnectors: async (): Promise<{ connectors: PrismConnectorMeta[] }> => {
      const res = await http.get<{ connectors?: PrismConnectorMeta[] }>('/api/prism/connectors');
      return { connectors: expectArray<PrismConnectorMeta>(res.data, 'connectors', 'listPrismConnectors') };
    },

    createPrismConnection: async (data: PrismCreateConnectionRequest): Promise<{ connection: PrismConnection }> => {
      const res = await http.post<Record<string, unknown>>('/api/prism/connections', data);
      // Canonical CreateConnectionResponse = { connection }. Tolerate the legacy
      // { connectionId } shape and normalize so callers always get `connection.id`.
      return { connection: expectEntity<PrismConnection>(res.data, 'connection', 'id', 'createPrismConnection') };
    },

    listPrismConnections: async (): Promise<{ connections: PrismConnection[] }> => {
      const res = await http.get<{ connections?: PrismConnection[] }>('/api/prism/connections');
      return { connections: expectArray<PrismConnection>(res.data, 'connections', 'listPrismConnections') };
    },

    deletePrismConnection: async (id: string): Promise<{ success: boolean }> => {
      const res = await http.delete<{ success?: boolean }>(`/api/prism/connections/${id}`);
      return { success: Boolean(res.data?.success ?? true) };
    },

    discoverPrismResources: async (connectionId: string): Promise<{ resources: PrismDiscoveredResource[] }> => {
      const coerce = (v: unknown) => (v == null ? null : Number(v));
      // Backend route is `/connections/:id/resources` (NOT `/discover`).
      const res = await http.get<{ resources?: Array<Record<string, unknown>> }>(
        `/api/prism/connections/${connectionId}/resources`,
      );
      const rawList = expectArray<Record<string, unknown>>(res.data, 'resources', 'discoverPrismResources');
      const resources: PrismDiscoveredResource[] = rawList.map((r) => ({
        resourceRef: (r.resourceRef ?? r.resource_ref) as PrismResourceRef,
        label:       String(r.label ?? ''),
        recordType:  (r.recordType ?? r.record_type) as PrismRecordType,
        counts:      coerce(r.counts) ?? undefined,
        dateRange:   (r.dateRange ?? r.date_range) as { start: string; end: string } | undefined,
        metric:      (r.metric ?? null) as PrismDiscoveredResource['metric'],
      }));
      return { resources };
    },

    createPrismJob: async (data: PrismCreateJobRequest): Promise<{ job: PrismJob }> => {
      const res = await http.post<Record<string, unknown>>('/api/prism/jobs', data);
      // Canonical CreateJobResponse = { job }. Tolerate legacy { jobId } and normalize.
      return { job: expectEntity<PrismJob>(res.data, 'job', 'id', 'createPrismJob') };
    },

    listPrismJobs: async (): Promise<{ jobs: PrismJob[] }> => {
      const res = await http.get<{ jobs?: PrismJob[] }>('/api/prism/jobs');
      return { jobs: expectArray<PrismJob>(res.data, 'jobs', 'listPrismJobs') };
    },

    getPrismJob: async (jobId: string): Promise<{ job: PrismJob }> => {
      const res = await http.get<Record<string, unknown>>(`/api/prism/jobs/${jobId}`);
      return { job: expectEntity<PrismJob>(res.data, 'job', 'id', 'getPrismJob') };
    },

    pausePrismJob: async (jobId: string): Promise<{ job: PrismJob }> => {
      const res = await http.post<Record<string, unknown>>(`/api/prism/jobs/${jobId}/pause`, {});
      return { job: expectEntity<PrismJob>(res.data, 'job', 'id', 'pausePrismJob') };
    },

    resumePrismJob: async (jobId: string): Promise<{ job: PrismJob }> => {
      const res = await http.post<Record<string, unknown>>(`/api/prism/jobs/${jobId}/resume`, {});
      return { job: expectEntity<PrismJob>(res.data, 'job', 'id', 'resumePrismJob') };
    },

    cancelPrismJob: async (jobId: string): Promise<{ job: PrismJob }> => {
      const res = await http.post<Record<string, unknown>>(`/api/prism/jobs/${jobId}/cancel`, {});
      return { job: expectEntity<PrismJob>(res.data, 'job', 'id', 'cancelPrismJob') };
    },

    getPrismMapping: async (jobId: string): Promise<{ mappings: PrismFieldMapping[]; schema_shape_hash?: string }> => {
      const coerce = (v: unknown) => (v == null ? 0 : Number(v));
      const res = await http.get<{ mappings?: Array<Record<string, unknown>>; suggestions?: Array<Record<string, unknown>>; schema_shape_hash?: string }>(
        `/api/prism/jobs/${jobId}/mapping`,
      );
      // Canonical key is `mappings`; tolerate the engine's legacy `suggestions` key.
      const rawMappings = (res.data?.mappings ?? res.data?.suggestions ?? []) as Array<Record<string, unknown>>;
      const mappings: PrismFieldMapping[] = rawMappings.map((m) => ({
        source_field: String(m.source_field ?? ''),
        source_type:  m.source_type ? String(m.source_type) : undefined,
        target:       String(m.target ?? 'embedded_data'),
        metric:       (m.metric ?? null) as PrismFieldMapping['metric'],
        value_rules:  (m.value_rules as PrismFieldMapping['value_rules']) ?? undefined,
        confidence:   coerce(m.confidence),
        origin:       (m.origin ?? 'llm') as PrismFieldMapping['origin'],
        rationale:    m.rationale ? String(m.rationale) : undefined,
      }));
      return { mappings, schema_shape_hash: res.data.schema_shape_hash };
    },

    putPrismMapping: async (jobId: string, body: PrismConfirmMappingRequest): Promise<{ success: boolean }> => {
      const res = await http.put<{ success?: boolean }>(`/api/prism/jobs/${jobId}/mapping`, body);
      return { success: Boolean(res.data?.success ?? true) };
    },

    getPrismDryRun: async (jobId: string): Promise<PrismDryRunReport> => {
      const coerce = (v: unknown) => (v == null ? null : Number(v));
      // Backend route is `/jobs/:id/dryrun` (NOT `/dry-run`) and returns the report
      // UNWRAPPED. Tolerate a legacy `{ report }` wrapper just in case.
      const raw = await http.get<Record<string, unknown>>(`/api/prism/jobs/${jobId}/dryrun`);
      const d = ((raw.data && (raw.data as Record<string, unknown>).report) ?? raw.data ?? {}) as Record<string, unknown>;
      const summaryRaw = (d.summary ?? {}) as Record<string, unknown>;
      const parity = ((d.metric_parity as Array<Record<string, unknown>>) ?? []).map((p) => ({
        metric:         String(p.metric ?? ''),
        source_value:   coerce(p.source_value),
        prism_computed: coerce(p.prism_computed),
        match:          Boolean(p.match),
        delta:          coerce(p.delta) ?? undefined,
        explanation:    p.explanation ? String(p.explanation) : undefined,
        method:         (p.method ?? undefined) as PrismParityEntry['method'],
      }));
      return {
        summary: {
          create:         Number(summaryRaw.create ?? 0),
          update:         Number(summaryRaw.update ?? 0),
          skip_duplicate: Number(summaryRaw.skip_duplicate ?? 0),
          conflict:       Number(summaryRaw.conflict ?? 0),
        },
        metric_parity:        parity,
        unmapped_fields:      (d.unmapped_fields as PrismDryRunReport['unmapped_fields']) ?? [],
        timestamp_continuity: (d.timestamp_continuity as PrismDryRunReport['timestamp_continuity'])
          ?? { earliest: '', latest: '', gaps: [] },
        conflicts:            (d.conflicts as PrismDryRunReport['conflicts']) ?? [],
        sample:               (d.sample as PrismDryRunReport['sample']) ?? undefined,
      };
    },

    approvePrismJob: async (jobId: string, body: PrismApproveRequest = {}): Promise<{ job: PrismJob }> => {
      const res = await http.post<Record<string, unknown>>(`/api/prism/jobs/${jobId}/approve`, body);
      // Canonical ApproveResponse = { job }. Tolerate legacy { jobId, status } and normalize.
      return { job: expectEntity<PrismJob>(res.data, 'job', 'id', 'approvePrismJob') };
    },

    getPrismReconciliation: async (jobId: string): Promise<PrismReconReport> => {
      const coerce = (v: unknown) => (v == null ? null : Number(v));
      // Returns the report UNWRAPPED. Tolerate a legacy `{ report }` wrapper.
      const raw = await http.get<Record<string, unknown>>(`/api/prism/jobs/${jobId}/reconciliation`);
      const d = ((raw.data && (raw.data as Record<string, unknown>).report) ?? raw.data ?? {}) as Record<string, unknown>;
      const countsRaw = (d.counts ?? {}) as Record<string, unknown>;
      const checksumRaw = (d.checksum ?? {}) as Record<string, unknown>;
      const parity = ((d.metric_parity as Array<Record<string, unknown>>) ?? []).map((p) => ({
        metric:         String(p.metric ?? ''),
        source_value:   coerce(p.source_value),
        prism_computed: coerce(p.prism_computed),
        match:          Boolean(p.match),
        delta:          coerce(p.delta) ?? undefined,
        explanation:    p.explanation ? String(p.explanation) : undefined,
        method:         (p.method ?? undefined) as PrismParityEntry['method'],
      }));
      return {
        tier1_pass: Boolean(d.tier1_pass),
        counts: {
          source: Number(countsRaw.source ?? 0),
          prism:  Number(countsRaw.prism ?? 0),
          match:  Boolean(countsRaw.match),
        },
        checksum: {
          source: String(checksumRaw.source ?? ''),
          prism:  String(checksumRaw.prism ?? ''),
          match:  Boolean(checksumRaw.match),
        },
        metric_parity: parity,
        generated_at:  String(d.generated_at ?? ''),
        report_url:    (d.report_url ?? null) as string | null,
      };
    },

    /**
     * Upload a raw file (CSV / Excel / SPSS / JSON / service-account key) to Prism.
     * Posts the raw bytes as the request body — NOT multipart — with the filename
     * passed as a query param, matching POST /api/prism/uploads?filename=.
     */
    uploadPrismFile: async (
      file: File,
      onProgress?: (pct: number) => void,
    ): Promise<{ fileRef: string; filename: string; sizeBytes: number; detectedFormat: string; detectedPlatform?: string }> => {
      const res = await http.post<{ fileRef: string; filename: string; sizeBytes: number; detectedFormat: string; detectedPlatform?: string }>(
        '/api/prism/uploads',
        file,
        {
          params: { filename: file.name },
          headers: { 'Content-Type': file.type || 'application/octet-stream' },
          onUploadProgress: (e) => {
            if (onProgress && e.total) onProgress(Math.round((e.loaded / e.total) * 100));
          },
        },
      );
      const d = (res.data ?? {}) as Record<string, unknown>;
      const fileRef = d.fileRef;
      if (typeof fileRef !== 'string' || !fileRef) {
        throw new Error(`uploadPrismFile: backend returned no fileRef (got keys: ${describeKeys(res.data)})`);
      }
      return {
        fileRef,
        filename:         String(d.filename ?? file.name),
        sizeBytes:        Number(d.sizeBytes ?? file.size),
        detectedFormat:   String(d.detectedFormat ?? ''),
        detectedPlatform: d.detectedPlatform != null ? String(d.detectedPlatform) : undefined,
      };
    },

    /**
     * Begin an OAuth2 connect flow. Returns the provider authorize URL; the caller
     * navigates the browser there. The provider redirects back to
     * /app/prism/connect/:platform?connected={connectionId}.
     */
    startPrismOAuth: async (
      platform: string,
      opts: { mode: PrismMode; history_window: number; returnUrl: string },
    ): Promise<{ authorizeUrl: string }> => {
      const res = await http.post<{ authorizeUrl?: string }>(
        `/api/prism/oauth/${platform}/start`,
        opts,
      );
      const url = res.data?.authorizeUrl;
      if (typeof url !== 'string' || !url) {
        throw new Error(`startPrismOAuth: backend returned no authorizeUrl (got keys: ${describeKeys(res.data)})`);
      }
      return { authorizeUrl: url };
    },

  };
}

// ── Credit system types ───────────────────────────────────────────────────────
export interface CreditBalance {
  plan_tier:           string;
  monthly_allowance:   number;
  allowance_remaining: number;
  pack_balance:        number;
  available:           number;
  overage_enabled:     boolean;
  overage_ceiling:     number | null;
  overage_used:        number;
  overage_remaining:   number | null;
  period_start:        string;
  period_days:         number;
}
export interface CreditConfig {
  credit_usd:          number;
  period_days:         number;
  costs:               Record<string, number>;
  plan_allowances:     Record<string, number>;
  plan_prices?:        Record<string, number>;
  free_lifetime_grant: number;
}
export interface CreditUsageRow {
  action_type:    string;
  total_credits:  number;
  event_count:    number;
  total_cost_usd: number;
}
export interface CreditUsageResponse {
  summary: CreditUsageRow[];
  balance: CreditBalance;
  days:    number;
}
export interface CreditLedgerEntry {
  id:            string;
  action_type:   string;
  credits:       number;
  source:        string;
  action_ref:    string | null;
  balance_after: number;
  unit_cost_usd: number | null;
  note:          string | null;
  user_id:       string | null;
  created_at:    string;
}
export interface CreditPack {
  id:        string;
  label:     string;
  credits:   number;
  price_usd: number;
}

// ── Support System types ───────────────────────────────────────────────────────

export interface SupportDoc {
  key:          string;
  title:        string;
  category:     string;
  content:      string;
  excerpt?:     string;
  tags?:        string[];
  updated_at:   string;
  author?:      string;
}

export interface ChangelogEntry {
  version:      string;
  date:         string;
  title:        string;
  description:  string;
  type:         'feature' | 'fix' | 'improvement' | 'deprecation';
  tags?:        string[];
}

export interface KnownIssue {
  id:           string;
  title:        string;
  description:  string;
  status:       'investigating' | 'identified' | 'monitoring' | 'resolved';
  severity:     'critical' | 'major' | 'minor';
  affected?:    string[];
  started_at:   string;
  resolved_at?: string | null;
}

export interface RoadmapSection {
  id:           string;
  title:        string;
  status:       'planned' | 'in_progress' | 'completed';
  eta?:         string;
  items:        RoadmapItem[];
}

export interface RoadmapItem {
  id:           string;
  title:        string;
  description?: string;
  status:       'planned' | 'in_progress' | 'completed';
  votes?:       number;
}

export type SystemStatusLevel = 'operational' | 'degraded' | 'partial_outage' | 'major_outage';

export interface SystemStatusComponent {
  name:         string;
  status:       SystemStatusLevel;
  updated_at:   string;
}

export interface SystemStatus {
  overall:      SystemStatusLevel;
  components:   SystemStatusComponent[];
  updated_at:   string;
  incident?:    string | null;
}

export interface AccountState {
  plan_tier:    string;
  seats_used:   number;
  seats_limit:  number | null;
  features:     string[];
  billing_email?: string;
  next_renewal?:  string | null;
}

export interface CreateTicketRequest {
  subject:      string;
  description:  string;
  priority?:    'low' | 'normal' | 'high' | 'urgent';
  category?:    string;
  attachments?: string[];
}

export interface SupportTicket {
  id:           string;
  subject:      string;
  status:       'open' | 'pending' | 'resolved' | 'closed';
  priority:     string;
  created_at:   string;
  url?:         string;
}

export interface DocFeedbackRequest {
  doc_key:      string;
  helpful:      boolean;
  query?:       string;
  comment?:     string;
}

export interface CrystalSupportResponse {
  answer:               string;
  suggestions?:         string[];
  doc_refs?:            string[];
  escalation_package?:  EscalationPackage | null;
  resolved:             boolean;
}

export interface EscalationPackage {
  description:  string;
  priority:     'low' | 'normal' | 'high' | 'urgent';
  context:      Record<string, unknown>;
}

// ── Admin Support Pipeline types ──────────────────────────────────────────────

export type PipelineStatus =
  | 'queued' | 'extracting' | 'drafting' | 'quality_check'
  | 'auto_approved' | 'pending_review' | 'requires_annotation'
  | 'rejected' | 'publishing' | 'live' | 'stale';

export interface QueuedDoc {
  id:                  string;
  title:               string;
  docKey:              string;
  qualityScore:        number;
  status:              PipelineStatus;
  autoApproveDeadline: string | null;
  humanEdited:         boolean;
  sourceUrl:           string | null;
  version:             number;
  updatedAt:           string;
  createdAt:           string;
}

export interface AdminDocSection {
  key:     string;
  heading: string;
  content: string;
}

export interface AdminDocDetail {
  doc:              QueuedDoc;
  sections:         AdminDocSection[];
  oldSections:      AdminDocSection[];
  locks:            Array<{ sectionKey: string; lockedBy: string }>;
  pipelineHistory:  PipelineEvent[];
  qualityBreakdown: QualityBreakdown;
}

export interface PipelineEvent {
  id:        string;
  docId:     string;
  docTitle:  string;
  eventType: string;
  actor:     string | null;
  actorType: 'system' | 'crystal' | 'admin';
  occurredAt: string;
}

export interface DocGap {
  id:              string;
  query:           string;
  feedbackType:    string;
  crystalIntent:   string | null;
  occurrenceCount: number;
  firstSeenAt:     string;
  lastSeenAt:      string;
  resolvedAt:      string | null;
  resolution:      'doc_created' | 'linked' | 'wont_fix' | null;
}

export interface QualityBreakdown {
  accuracy:       number;
  completeness:   number;
  clarity:        number;
  searchability:  number;
  actionability:  number;
}

export interface PipelineStats {
  docsLive:            number;
  docsLiveDelta:       number;
  publishedToday:      number;
  publishedTodayDelta: number;
  gapsOpen:            number;
  avgQualityScore:     number;
  statusDistribution:  Record<PipelineStatus, number>;
  qualityHistogram:    Array<{ bucket: string; count: number }>;
}

export interface SectionEdit {
  sectionKey: string;
  content:    string;
  locked:     boolean;
}

// Re-export for consumers that import InsightRunStatus from api.ts
export type { InsightRunStatus };

export type ApiClient = ReturnType<typeof createApiClient>;
