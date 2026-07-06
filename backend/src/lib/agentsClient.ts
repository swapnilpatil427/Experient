/**
 * HTTP client for the Xperiq Copilot Agents microservice (Python/FastAPI).
 *
 * The agents service runs on AGENTS_URL (default: http://localhost:8001).
 * All requests include the shared internal key for service-to-service auth.
 *
 * This client is the ONLY place in the Node.js backend that talks to the agents
 * service — no other module should call the agents API directly.
 */
import fetch from 'node-fetch';
import type { RequestInit } from 'node-fetch';
import logger from './logger';

const AGENTS_URL = process.env.AGENTS_URL ?? 'http://localhost:8001';
const AGENTS_INTERNAL_KEY = process.env.AGENTS_INTERNAL_KEY
  ?? (process.env.NODE_ENV !== 'production'
    ? 'dev-internal-key-change-in-prod'
    : (() => { throw new Error('AGENTS_INTERNAL_KEY must be set in production'); })());

// Fast timeout: non-LLM operations (status polls, CRUD edits, registry)
const DEFAULT_TIMEOUT_MS = 12_000;
// LLM timeout: full model inference (copilot refine, skip-logic, recommendations).
// Free-tier models can take 15–30s; retry-after backoff adds up to ~8s per attempt.
// 90s covers one full inference + one rate-limit retry without blocking the request forever.
const LLM_TIMEOUT_MS = 90_000;

interface AgentsError extends Error {
  status?: number;
}

function _headers(): Record<string, string> {
  return {
    'Content-Type':   'application/json',
    'X-Internal-Key': AGENTS_INTERNAL_KEY,
  };
}

async function _fetch(path: string, opts: RequestInit = {}, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${AGENTS_URL}${path}`, {
      ...opts,
      signal:  controller.signal as never,
      headers: { ..._headers(), ...(opts.headers as Record<string, string> || {}) },
    });
    clearTimeout(timer);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err: AgentsError = Object.assign(
        new Error(`Agents service error ${res.status}: ${body}`),
        { status: res.status },
      );
      throw err;
    }
    return res.json();
  } catch (err: unknown) {
    clearTimeout(timer);
    throw err;
  }
}

// Response generation: batches now run in PARALLEL (asyncio.gather in response_generator.py).
// Wall-clock time ≈ ONE batch time (not N_batches × batch_time).
// Free-tier models: ~60s per batch. Paid models (Gemini 2.5 Flash): ~15-30s.
// Timeout = 90s base + 30s per 25-response group to handle rate-limit retries.
function _responseGenTimeout(count: number): number {
  return Math.min(Math.ceil(count / 25) * 30_000 + 90_000, 300_000);
}


// ── Survey creation ──────────────────────────────────────────────────────────────

/**
 * Start a survey creation orchestration run (async — returns run_id immediately).
 */
export async function startOrchestration({
  orgId, userId, intent, surveyTypeId, sessionId,
  orgContext = {}, sessionActions = [], surveyHistory = [],
}: {
  orgId: string;
  userId: string;
  intent: string;
  surveyTypeId?: string | null;
  sessionId?: string | null;
  orgContext?: Record<string, unknown>;
  sessionActions?: unknown[];
  surveyHistory?: unknown[];
}): Promise<unknown> {
  logger.info({ orgId, intent: intent.slice(0, 60) }, 'agents:startOrchestration');
  return _fetch('/orchestrate', {
    method: 'POST',
    body: JSON.stringify({
      org_id:          orgId,
      user_id:         userId,
      intent,
      survey_type_id:  surveyTypeId   || null,
      session_id:      sessionId      || null,
      org_context:     orgContext,
      session_actions: sessionActions,
      survey_history:  surveyHistory,
    }),
  });
}

/**
 * Poll the status of a running orchestration.
 * Returns { run_id, status, questions, qc_score, recommendations, stream_events, ... }
 */
export async function getRunStatus(runId: string, orgId: string): Promise<unknown> {
  return _fetch(`/orchestrate/${runId}/status?org_id=${encodeURIComponent(orgId)}`);
}

/**
 * Cancel a running orchestration. Stops the in-process asyncio task (if still live)
 * and marks the DB record as 'cancelled'. Idempotent — safe to call on already-
 * terminal runs; returns the current status without error.
 * Returns { run_id, status, task_cancelled }
 */
export async function cancelOrchestration(runId: string, orgId: string): Promise<unknown> {
  logger.info({ runId, orgId }, 'agents:cancelOrchestration');
  return _fetch(`/orchestrate/${runId}/cancel?org_id=${encodeURIComponent(orgId)}`, {
    method: 'POST',
  });
}


// ── Copilot chat edits ────────────────────────────────────────────────────────────

/**
 * Apply a natural-language edit to survey questions via the Copilot agent.
 * @param runId
 * @param params
 * @param params.orgId
 * @param params.message        - user's chat message
 * @param params.orgContext
 * @param params.surveyTypeId
 * @param params.intent         - original survey creation intent
 * @returns Promise<{ questions, explanation, changes, suggestions }>
 */
export async function refineRun(runId: string, {
  orgId, message, questions, orgContext = {}, surveyTypeId, intent = '', conversationHistory = [],
}: {
  orgId: string;
  message: string;
  questions?: unknown[] | null;
  orgContext?: Record<string, unknown>;
  surveyTypeId?: string | null;
  intent?: string;
  conversationHistory?: unknown[];
}): Promise<unknown> {
  logger.info({ runId, orgId, message: message.slice(0, 60) }, 'agents:refineRun');
  return _fetch(`/orchestrate/${runId}/refine`, {
    method: 'POST',
    body: JSON.stringify({
      org_id:               orgId,
      message,
      questions:            questions || null,
      org_context:          orgContext,
      survey_type_id:       surveyTypeId || null,
      intent,
      conversation_history: conversationHistory,
    }),
  }, LLM_TIMEOUT_MS);
}


// ── Skip logic ────────────────────────────────────────────────────────────────────

/**
 * Add conditional skip/display logic to survey questions.
 * @param runId
 * @param params
 * @param params.orgId
 * @param params.request     - plain-English: "if NPS < 7 ask why"
 * @param params.orgContext
 * @returns Promise<{ questions, changes, message }>
 */
export async function addSkipLogic(runId: string, {
  orgId, request, orgContext = {},
}: {
  orgId: string;
  request: string;
  orgContext?: Record<string, unknown>;
}): Promise<unknown> {
  logger.info({ runId, orgId }, 'agents:addSkipLogic');
  return _fetch(`/orchestrate/${runId}/skip-logic`, {
    method: 'POST',
    body: JSON.stringify({ org_id: orgId, request, org_context: orgContext }),
  }, LLM_TIMEOUT_MS);
}


// ── Question CRUD ─────────────────────────────────────────────────────────────────

/**
 * Add a new question to the survey.
 * @param runId
 * @param params
 * @param params.orgId
 * @param params.type      - question type (default: "open_text")
 * @param params.afterId   - insert after this question ID
 * @returns Promise<{ questions, message, changes }>
 */
export async function addQuestion(runId: string, {
  orgId, type = 'open_text', afterId = null,
}: {
  orgId: string;
  type?: string;
  afterId?: string | null;
}): Promise<unknown> {
  return _fetch(`/orchestrate/${runId}/questions`, {
    method: 'POST',
    body: JSON.stringify({ org_id: orgId, type, after_id: afterId }),
  });
}

/**
 * Remove a question from the survey.
 * Also removes any skip logic rules that reference the deleted question.
 */
export async function removeQuestion(runId: string, qId: string, orgId: string): Promise<unknown> {
  return _fetch(`/orchestrate/${runId}/questions/${qId}?org_id=${encodeURIComponent(orgId)}`, {
    method: 'DELETE',
  });
}

/**
 * Update specific fields on a question (does not change ID or type via patch — use refineRun for that).
 * @param runId
 * @param qId
 * @param params
 * @param params.orgId
 * @param params.fields   - partial question fields to apply
 */
export async function patchQuestion(runId: string, qId: string, {
  orgId, fields,
}: {
  orgId: string;
  fields: Record<string, unknown>;
}): Promise<unknown> {
  return _fetch(`/orchestrate/${runId}/questions/${qId}`, {
    method: 'PATCH',
    body: JSON.stringify({ org_id: orgId, fields }),
  });
}

/**
 * Reorder questions by providing a new ordered list of IDs.
 * IDs not included will be appended at the end.
 */
export async function reorderQuestions(runId: string, {
  orgId, order,
}: {
  orgId: string;
  order: string[];
}): Promise<unknown> {
  return _fetch(`/orchestrate/${runId}/reorder`, {
    method: 'POST',
    body: JSON.stringify({ org_id: orgId, order }),
  });
}


// ── Recommendation dispatcher ──────────────────────────────────────────────────

/**
 * Execute a recommendation action (adds skip logic, refines a question, adds follow-up, etc.).
 * @param runId
 * @param actionId   - recommendation action ID (e.g. "add_skip_logic")
 * @param params
 * @param params.orgId
 * @param params.parameters    - action-specific parameters
 * @param params.orgContext
 * @param params.surveyTypeId
 * @param params.intent
 */
export async function applyRecommendation(runId: string, actionId: string, {
  orgId, parameters = {}, orgContext = {}, surveyTypeId, intent = '',
}: {
  orgId: string;
  parameters?: Record<string, unknown>;
  orgContext?: Record<string, unknown>;
  surveyTypeId?: string | null;
  intent?: string;
}): Promise<unknown> {
  logger.info({ runId, orgId, actionId }, 'agents:applyRecommendation');
  return _fetch(`/orchestrate/${runId}/apply-recommendation/${actionId}`, {
    method: 'POST',
    body: JSON.stringify({
      org_id:         orgId,
      parameters,
      org_context:    orgContext,
      survey_type_id: surveyTypeId || null,
      intent,
    }),
  }, LLM_TIMEOUT_MS);
}


// ── Sample response generation ─────────────────────────────────────────────────

/**
 * Generate synthetic sample responses for a survey.
 * @param params
 * @param params.surveyId
 * @param params.orgId
 * @param params.surveyTitle
 * @param params.surveyIntent
 * @param params.questions       - survey question objects
 * @param params.count           - number of responses (default 20)
 * @param params.personaMix      - "realistic" | "critical" | "positive" | "mixed"
 * @returns Promise<{ responses: Array, count: number }>
 */
export async function generateSampleResponses({
  surveyId, orgId, surveyTitle, surveyIntent, questions, count = 20, personaMix = 'realistic',
}: {
  surveyId: string;
  orgId: string;
  surveyTitle: string;
  surveyIntent?: string | null;
  questions: unknown[];
  count?: number;
  personaMix?: string;
}): Promise<unknown> {
  const timeoutMs = _responseGenTimeout(count);
  logger.info({ surveyId, orgId, count, personaMix, timeoutMs }, 'agents:generateSampleResponses');
  return _fetch('/responses/generate', {
    method: 'POST',
    body: JSON.stringify({
      survey_id:     surveyId,
      org_id:        orgId,
      survey_title:  surveyTitle,
      survey_intent: surveyIntent || null,
      questions,
      count,
      persona_mix:   personaMix,
    }),
  }, timeoutMs);
}


// ── Insight generation ─────────────────────────────────────────────────────────

/**
 * Fire cross-survey group insight generation.
 * Best-effort — caller should not await the full pipeline, only the HTTP kick-off.
 *
 * @param runId      - group_insight_runs.id created before calling this
 * @param tagIds     - the tag IDs that define the group
 * @param surveyIds  - all survey IDs included in this run
 * @param orgId
 */
export async function generateGroupInsights(
  runId: string,
  tagIds: string[],
  surveyIds: string[],
  orgId: string,
): Promise<unknown> {
  logger.info({ runId, orgId, tagCount: tagIds.length, surveyCount: surveyIds.length }, 'agents:generateGroupInsights');
  return _fetch('/groups/insights/generate', {
    method: 'POST',
    body: JSON.stringify({
      run_id:     runId,
      tag_ids:    tagIds,
      survey_ids: surveyIds,
      org_id:     orgId,
    }),
  }, 15_000);
}


/**
 * Fire Tag Report generation (TRACKER.md §1 reconciliation item 7 / §2). Mirrors
 * generateGroupInsights's shape exactly: fire-and-forget, best-effort — caller
 * should not await the full pipeline, only the HTTP kick-off. Unlike
 * generateGroupInsights, no survey_ids are ever passed — Tag Report's backend
 * layer never resolves survey membership (that is entirely CrystalOS's
 * fetch_next_batch, working from tag_id + effectiveMaxSurveys as target_n).
 *
 * @param runId               - group_insight_runs.id created before calling this
 * @param orgId
 * @param tagId               - the single tag that defines this report (Tag Report is always single-tag, see TRACKER.md reconciliation item 5)
 * @param runMode             - 'manual' | 'automated' | 'custom_range'
 * @param effectiveMaxSurveys - already-resolved cap (3-tier COALESCE), passed to CrystalOS as target_n
 * @param windowStart         - only set for custom_range; requested window start
 * @param windowEnd           - only set for custom_range; requested window end
 */
export async function generateTagReport(
  runId: string,
  orgId: string,
  tagId: string,
  runMode: 'manual' | 'automated' | 'custom_range',
  effectiveMaxSurveys: number,
  windowStart: string | null = null,
  windowEnd: string | null = null,
): Promise<unknown> {
  logger.info({ runId, orgId, tagId, runMode, effectiveMaxSurveys }, 'agents:generateTagReport');
  return _fetch('/tag-reports/generate', {
    method: 'POST',
    body: JSON.stringify({
      run_id:                runId,
      org_id:                orgId,
      tag_id:                tagId,
      run_mode:              runMode,
      window_start:          windowStart,
      window_end:            windowEnd,
      effective_max_surveys: effectiveMaxSurveys,
    }),
  }, 15_000);
}


/**
 * Fire insight generation for a survey. Best-effort; caller should not await
 * the full pipeline — only the HTTP kick-off.
 *
 * @param params - { surveyId, orgId, runId, trigger }
 */
export async function triggerInsightGeneration({
  surveyId, orgId, runId, trigger = 'manual',
}: {
  surveyId: string;
  orgId: string;
  runId?: string;
  trigger?: string;
}): Promise<unknown> {
  logger.info({ surveyId, orgId, runId, trigger }, 'agents:triggerInsightGeneration');
  return _fetch('/insights/generate', {
    method: 'POST',
    body: JSON.stringify({ survey_id: surveyId, org_id: orgId, run_id: runId, trigger }),
  }, 15_000);
}


/**
 * CrystalOS internal endpoint for Insight Pipeline v2 manual / refresh runs.
 * Held as a const so the path is easy to fix if CrystalOS lands on a different route.
 * (Assumed per 02_ARCHITECTURE.md §6/§8 — `run_insight_generation(profile)` queue.)
 */
export const MANUAL_INSIGHT_RUN_PATH = '/insights/runs';

/**
 * Fire a manual / refresh insight run. Best-effort kick-off — the caller should not
 * await the full pipeline. CrystalOS resolves the run profile from `mode`:
 *   refresh → refresh · quick → manual_quick · expert → manual_expert
 *
 * The agents service is built in parallel; if the endpoint does not exist yet the
 * call rejects with a clear AgentsError (status 404) that the caller logs + tolerates.
 *
 * @param params - { surveyId, orgId, runId, mode, windowStart?, windowEnd?, label?, actor }
 */
export async function triggerManualInsightRun({
  surveyId, orgId, runId, mode, windowStart, windowEnd, label, actor, sample_cap,
}: {
  surveyId: string;
  orgId: string;
  runId: string;
  mode: 'expert' | 'quick' | 'refresh';
  windowStart?: string | null;
  windowEnd?: string | null;
  label?: string | null;
  actor: string;
  sample_cap?: number;
}): Promise<unknown> {
  logger.info({ surveyId, orgId, runId, mode }, 'agents:triggerManualInsightRun');
  return _fetch(MANUAL_INSIGHT_RUN_PATH, {
    method: 'POST',
    body: JSON.stringify({
      survey_id:    surveyId,
      org_id:       orgId,
      run_id:       runId,
      mode,
      window_start: windowStart ?? null,
      window_end:   windowEnd   ?? null,
      label:        label       ?? null,
      actor,
      sample_cap:   sample_cap  ?? null,
    }),
  }, 15_000);
}

/**
 * CrystalOS internal endpoint for the manual "Backfill Tagging" job
 * (Experience → Topics page). Held as a const for the same reason as
 * MANUAL_INSIGHT_RUN_PATH above.
 */
export const TOPIC_BACKFILL_PATH = '/topics/backfill';

/**
 * Fire a manual topic-tagging backfill job. Best-effort kick-off — CrystalOS
 * starts a background task and reports progress into the SAME agent_runs row
 * (run_id) via stream_events, pollable at GET /api/runs/:runId. The caller
 * must have already inserted that row (run_type='topic_backfill') before
 * calling this, matching triggerManualInsightRun's division of responsibility.
 */
export async function triggerTopicBackfill({
  surveyId, orgId, runId,
}: {
  surveyId: string;
  orgId: string;
  runId: string;
}): Promise<unknown> {
  logger.info({ surveyId, orgId, runId }, 'agents:triggerTopicBackfill');
  return _fetch(TOPIC_BACKFILL_PATH, {
    method: 'POST',
    body: JSON.stringify({ survey_id: surveyId, org_id: orgId, run_id: runId }),
  }, 15_000);
}


/**
 * CrystalOS internal endpoint for Custom Analysis runs (Insight Pipeline v2 — Phase 6).
 * Custom Analysis has its own queue and writes to custom_reports / custom_report_insights —
 * it NEVER touches the insights table (02_ARCHITECTURE.md §6, 03_DATA_MODEL.md §10/§11).
 * Held as a const so the path is easy to fix if CrystalOS lands on a different route.
 */
export const CUSTOM_ANALYSIS_RUN_PATH = '/reports/custom/run';

/**
 * Fire a Custom Analysis run. Best-effort kick-off — the caller should not await the full
 * pipeline. CrystalOS resolves the corpus from `filterSpec` (date range / segments / topics /
 * metric types / narrative depth) and writes results to custom_reports + custom_report_insights.
 *
 * The agents service is built in parallel; if the endpoint does not exist yet the call rejects
 * with a clear AgentsError (status 404) that the caller logs + tolerates (marks the run failed).
 *
 * @param params - { surveyId, orgId, runId, reportId, filterSpec, actor }
 */
export async function triggerCustomAnalysis({
  surveyId, orgId, runId, reportId, filterSpec, actor,
}: {
  surveyId: string;
  orgId: string;
  runId: string;
  reportId: string;
  filterSpec: Record<string, unknown>;
  actor: string;
}): Promise<unknown> {
  logger.info({ surveyId, orgId, runId, reportId }, 'agents:triggerCustomAnalysis');
  return _fetch(CUSTOM_ANALYSIS_RUN_PATH, {
    method: 'POST',
    body: JSON.stringify({
      survey_id:   surveyId,
      org_id:      orgId,
      run_id:      runId,
      report_id:   reportId,
      filter_spec: filterSpec,
      actor,
    }),
  }, 15_000);
}


/**
 * Alias for triggerInsightGeneration — convenience wrapper for manual run triggers.
 * @param surveyId
 * @param orgId
 * @param options  - merged into the trigger payload (e.g. runId, force_regenerate)
 */
export async function triggerRun(
  surveyId: string,
  orgId: string,
  options: Record<string, unknown> = {},
): Promise<unknown> {
  return triggerInsightGeneration({ surveyId, orgId, trigger: 'manual', ...options } as Parameters<typeof triggerInsightGeneration>[0]);
}


// ── Prism: import-mapping skills (schema-mapper / taxonomy-mapper / metric-parity) ─
// These power the L3 residual of the Prism deterministic-first resolver. CrystalOS
// PROPOSES; the backend persists on confirm. Each is org_id-scoped and structured-JSON.

import type { FieldMapping, ParityEntry } from '../types/prism';

/**
 * Propose Xperiq field mappings for the ambiguous residual source fields via the
 * CrystalOS `schema-mapper` skill (Prism resolver Layer 3). The deterministic L1/L2
 * layers resolve ~80-90% of fields; only the residual reaches here.
 *
 * @param args.orgId
 * @param args.connectionId
 * @param args.platform        - source platform ('qualtrics' | 'typeform' | 'csv' | ...)
 * @param args.fields          - residual source fields (name/type [+ label/samples])
 * @param args.samples         - optional per-field sample values
 * @returns Promise<{ mappings: FieldMapping[] }>
 */
export async function proposeMapping({
  orgId, connectionId, platform, fields, samples,
}: {
  orgId: string;
  connectionId: string;
  platform: string;
  fields: unknown[];
  samples?: Record<string, unknown>;
}): Promise<{ mappings: FieldMapping[] }> {
  logger.info({ orgId, connectionId, platform, fieldCount: fields.length }, 'agents:proposeMapping');
  return _fetch('/prism/map', {
    method: 'POST',
    body: JSON.stringify({
      org_id:        orgId,
      connection_id: connectionId,
      platform,
      fields,
      samples:       samples ?? null,
    }),
  }, LLM_TIMEOUT_MS) as Promise<{ mappings: FieldMapping[] }>;
}

/**
 * Reconcile imported topic/theme labels against the existing Xperiq topic registry
 * via the CrystalOS `taxonomy-mapper` skill. CrystalOS proposes resolutions
 * (merge | new | conflict); the backend persists on confirm.
 *
 * @param args.orgId
 * @param args.surveyId
 * @param args.importedLabels  - labels carried by the import
 * @param args.existingTopics  - the live survey_topics registry to reconcile against
 * @returns Promise<{ resolutions: unknown[] }>
 */
export async function reconcileTaxonomy({
  orgId, surveyId, importedLabels, existingTopics,
}: {
  orgId: string;
  surveyId: string;
  importedLabels: unknown[];
  existingTopics: unknown[];
}): Promise<{ resolutions: unknown[] }> {
  logger.info({ orgId, surveyId, labelCount: importedLabels.length }, 'agents:reconcileTaxonomy');
  return _fetch('/prism/taxonomy', {
    method: 'POST',
    body: JSON.stringify({
      org_id:          orgId,
      survey_id:       surveyId,
      imported_labels: importedLabels,
      existing_topics: existingTopics,
    }),
  }, LLM_TIMEOUT_MS) as Promise<{ resolutions: unknown[] }>;
}

/**
 * Explain a source-vs-Prism metric gap and recommend a remediation method
 * (match_source | rebaseline) via the CrystalOS `metric-parity` skill (Tier-2 parity).
 *
 * @param args.orgId
 * @param args.surveyId
 * @param args.metric            - 'nps' | 'csat' | 'ces'
 * @param args.sourceValue       - the incumbent platform's reported value
 * @param args.responsesSummary  - response evidence + prism_computed + method context
 * @returns Promise<{ explanation: string; recommended_method: string; parity_ledger: ParityEntry | Record<string, unknown> }>
 */
export async function explainParity({
  orgId, surveyId, metric, sourceValue, responsesSummary,
}: {
  orgId: string;
  surveyId: string;
  metric: string;
  sourceValue: number | null;
  responsesSummary: Record<string, unknown>;
}): Promise<{
  explanation: string;
  recommended_method: string;
  parity_ledger: ParityEntry | Record<string, unknown>;
}> {
  logger.info({ orgId, surveyId, metric }, 'agents:explainParity');
  return _fetch('/prism/parity', {
    method: 'POST',
    body: JSON.stringify({
      org_id:            orgId,
      survey_id:         surveyId,
      metric,
      source_value:      sourceValue,
      responses_summary: responsesSummary,
    }),
  }, LLM_TIMEOUT_MS) as Promise<{
    explanation: string;
    recommended_method: string;
    parity_ledger: ParityEntry | Record<string, unknown>;
  }>;
}


// ── Checkpoint blobs ───────────────────────────────────────────────────────────

/**
 * Fetch a checkpoint report blob by its storage ref.
 * In dev/dev-paid the agents service reads from the local filesystem.
 * In staging/prod use getCheckpointReadUrl() to get a signed OCI PAR URL instead.
 *
 * @param ref  - storage ref returned by write_checkpoint_blob (local path or OCI key)
 * @returns parsed + schema-migrated blob
 */
export async function getCheckpointBlob(ref: string): Promise<unknown> {
  return _fetch(`/internal/checkpoint-blob?ref=${encodeURIComponent(ref)}`);
}

/**
 * Get a readable URL for a checkpoint blob.
 * In dev/dev-paid returns the ref itself (agents proxies it).
 * In staging/prod returns a signed OCI Pre-Authenticated Request URL valid for 15 min.
 *
 * @param ref           - storage ref from the DB
 * @param expiryMin     - PAR expiry in minutes (ignored for local refs)
 * @returns URL or local ref
 */
export async function getCheckpointReadUrl(ref: string, expiryMin: number = 15): Promise<string> {
  const result = await _fetch(
    `/internal/checkpoint-read-url?ref=${encodeURIComponent(ref)}&expiry_minutes=${expiryMin}`,
  ) as { url: string };
  return result.url;
}


// ── Workflow automation: NL parsing (Wave 3) ────────────────────────────────────

/**
 * CrystalOS internal endpoint for NL → workflow structured-output parsing
 * (Crystal Builder NL parser — TEAM.md's Amara Osei mandate, TRACKER Wave 3).
 * Held as a const so the path is easy to fix once Amara's actual CrystalOS route
 * lands — see docs/automation-hub/WORKFLOW_SIGNAL_CONTRACT.md for the
 * reconciliation note: at the time this client function was written, Amara's
 * CrystalOS-side implementation did not exist yet, so this path is a working
 * assumption per BUILDER_SPEC_WAVE2.md §2.1, not a confirmed contract.
 */
export const PARSE_WORKFLOW_NL_PATH = '/workflows/parse-nl';

export interface ParseWorkflowNLSuccess {
  name: string;
  description: string;
  triggerType: string;
  nodes: Record<string, unknown>[];
  edges: Record<string, unknown>[];
  confidence: number;
  warnings: string[];
  // Scope hint (Wave 12, docs/automation-hub/BUILDER_REDESIGN_V2_SCOPE.md) — Amara's
  // CrystalOS parser matches an NL mention of a survey/tag against the real
  // `surveys`/`tags` lists this client now forwards in the registry payload (see
  // routes/workflows.ts's POST /parse-nl) and returns the match here. All three
  // fields are OPTIONAL: an older/lagging CrystalOS deploy that predates this
  // change simply omits them, and the route/frontend must treat that exactly like
  // `scopeType: 'org'` with no survey/tag — i.e. today's byte-identical org-wide
  // behavior — mirroring how `schemas/workflows.ts`'s `updateWorkflowSchema`
  // already defaults an absent `scopeType` to `'org'`. Never guess: CrystalOS only
  // populates these when it confidently matched a REAL org survey/tag; an
  // unmatched/hallucinated mention is dropped there, not defaulted here.
  scopeType?: 'org' | 'survey' | 'tag';
  scopeSurveyId?: string;
  scopeTagId?: string;
}

/**
 * Thrown when CrystalOS returns a structured "unparseable" response (422) — the
 * request succeeded at the transport level but Crystal could not produce a
 * workflow it's confident enough to hand back. Distinct from AgentsError (network/
 * non-2xx-without-structured-body) so the route handler can map this to the exact
 * `{ error: 'unparseable', message, suggestions }` shape the frontend's
 * `ParseWorkflowNLError`/`toParseWorkflowNLError` (app/src/lib/api.ts) expects.
 */
export class UnparseableWorkflowError extends Error {
  suggestions: string[];
  constructor(message: string, suggestions: string[] = []) {
    super(message);
    this.name = 'UnparseableWorkflowError';
    this.suggestions = suggestions;
  }
}

/**
 * Parse a natural-language workflow description into a structured workflow via
 * CrystalOS's NL parser skill. Passes the current workflowRegistry.ts catalog so
 * CrystalOS validates triggerType/actions against the single source of truth
 * (root CLAUDE.md: "CrystalOS proposes... the backend is the bridge").
 *
 * Uses LLM_TIMEOUT_MS (90s) since this is a full model-inference call, same class
 * of operation as refineRun/addSkipLogic/applyRecommendation above. The Express
 * route layers its own narrower client-facing timeout mapping (504) on top —
 * see routes/workflows.ts's POST /parse-nl.
 *
 * @throws UnparseableWorkflowError on CrystalOS's structured 422 (low-confidence/
 *   unparseable) response — callers should catch this distinctly from a generic
 *   AgentsError (network failure, 5xx, or timeout).
 */
export async function parseWorkflowNL(
  description: string,
  registryPayload: unknown,
  orgId: string,
): Promise<ParseWorkflowNLSuccess> {
  logger.info({ orgId, descriptionLength: description.length }, 'agents:parseWorkflowNL');
  try {
    return await _fetch(PARSE_WORKFLOW_NL_PATH, {
      method: 'POST',
      body: JSON.stringify({
        org_id:      orgId,
        description,
        registry:    registryPayload,
      }),
    }, LLM_TIMEOUT_MS) as ParseWorkflowNLSuccess;
  } catch (err: unknown) {
    const agentsErr = err as AgentsError;
    if (agentsErr.status === 422) {
      // CrystalOS's error body was already stringified by _fetch's throw path
      // (`Agents service error 422: <body>`) — but _fetch doesn't parse the body
      // as JSON on the error path, only on success. Re-derive the structured
      // fields defensively: if CrystalOS's 422 body is JSON matching
      // { error: 'unparseable', message, suggestions }, surface those; otherwise
      // fall back to a generic message so the route can still return a well-formed
      // 422 rather than leaking a raw "Agents service error 422: ..." string.
      const raw = agentsErr.message.replace(/^Agents service error 422:\s*/, '');
      try {
        const parsed = JSON.parse(raw) as { message?: string; suggestions?: string[] };
        throw new UnparseableWorkflowError(
          parsed.message ?? 'Crystal could not turn that into a workflow',
          Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
        );
      } catch (parseErr) {
        if (parseErr instanceof UnparseableWorkflowError) throw parseErr;
        throw new UnparseableWorkflowError('Crystal could not turn that into a workflow', []);
      }
    }
    throw err;
  }
}


// ── Registry + health ──────────────────────────────────────────────────────────

/** List all agent capabilities (active + stubs). */
export async function getAgentRegistry(): Promise<unknown> {
  return _fetch('/agents/registry');
}

/** Returns true if the agents service is reachable. */
export async function isHealthy(): Promise<boolean> {
  try {
    await fetch(`${AGENTS_URL}/health`, { signal: AbortSignal.timeout(3000) as never });
    return true;
  } catch {
    return false;
  }
}


// ── Novu Connect (Crystal ACI) ───────────────────────────────────────────────

/**
 * Send a message to Crystal via Novu Connect channel.
 * Returns Crystal's reply text.
 */
export async function crystalNovuMessage({
  subscriberId, channel, message, orgId, userId, threadId, metadata,
}: {
  subscriberId: string;
  channel: string;
  message: string;
  orgId: string;
  userId?: string;
  threadId?: string;
  metadata?: Record<string, unknown>;
}): Promise<{ reply: string; thread_id: string | null; delivered: boolean }> {
  return _fetch('/novu/message', {
    method: 'POST',
    body: JSON.stringify({ subscriberId, channel, message, orgId, userId, threadId, metadata }),
  }) as Promise<{ reply: string; thread_id: string | null; delivered: boolean }>;
}

/**
 * Personalize a notification message using Crystal's LLM.
 * Used by Novu Framework workflows to generate Crystal-written email/SMS content.
 */
export async function personalizeNotification({
  contactId, surveyId, channel, orgId, userId, context,
}: {
  contactId: string;
  surveyId?: string;
  channel: 'email' | 'sms' | 'push' | 'in_app';
  orgId: string;
  userId: string;
  context?: Record<string, unknown>;
}): Promise<{ subject?: string; body: string; html?: string }> {
  return _fetch('/novu/personalize', {
    method: 'POST',
    body: JSON.stringify({ contactId, surveyId, channel, orgId, userId, context }),
  }, LLM_TIMEOUT_MS) as Promise<{ subject?: string; body: string; html?: string }>;
}

/**
 * Check whether Crystal Novu Connect is available for this org.
 */
export async function checkNovuConnectHealth(): Promise<{ status: string; detail: string }> {
  return _fetch('/novu/health', {}, DEFAULT_TIMEOUT_MS) as Promise<{ status: string; detail: string }>;
}
