import { z } from 'zod';

const STATUS = ['draft', 'active', 'paused', 'archived', 'error'] as const;

// cooldown_minutes: null/0 = "no cooldown, fire every time" (default/existing behavior
// for every workflow that doesn't opt in). See docs/automation-hub/BUILDER_REBUILD_SPEC.md
// §5.3 — exact field name/shape Elias's builder UI sends on save; do not rename.
const cooldownMinutesSchema = z.number().int().min(0).max(43200).nullable(); // cap: 30 days

// ── Scope (docs/automation-hub/BUILDER_REDESIGN_V2_SCOPE.md §2 /
// BUILDER_REDESIGN_V2_CONCEPT.md §3) ─────────────────────────────────────────
//
// `scope_type` defaults to 'org' (backward compatible with every existing
// workflow, which is implicitly org-wide today). Validation mirrors the DB
// CHECK constraint in 20260701120000_workflow_scope.sql exactly — one nullable
// id column per scope kind, and exactly the right one must be set:
//   org    → neither scope_survey_id nor scope_tag_id
//   survey → scope_survey_id required, scope_tag_id must be absent
//   tag    → scope_tag_id required, scope_survey_id must be absent
export const SCOPE_TYPES = ['org', 'survey', 'tag'] as const;
export type ScopeType = (typeof SCOPE_TYPES)[number];

// Trigger types with no natural survey dimension for EVENT MATCHING purposes.
//
// `time.schedule` was originally excluded here too, on the reasoning that "a
// cron tick isn't about any particular survey." That reasoning is correct for
// event-matching (there's no incoming event to filter), but scope has a SECOND,
// independent purpose for scheduled workflows: it tells runScheduledWorkflows
// which survey(s)/tag's data to fetch and summarize for a digest (see
// workflowEngine.ts's fetchScheduledSurveyMetrics/buildScheduledEventData). A
// scope-less "Executive Weekly Digest" or "Quarterly Engagement Digest" has
// nothing to summarize but the generic fallback string — scoping it to a
// survey/tag is exactly what makes the digest non-empty. So time.schedule DOES
// support survey/tag scope now (used for data-fetch, not event-filtering).
//
// `external.webhook` remains excluded: an inbound webhook already carries its
// own event payload (it isn't a content-generation trigger the way a scheduled
// digest is), so scoping one to a survey/tag would still be a confusing no-op.
export const SCOPE_UNSUPPORTED_TRIGGER_TYPES = new Set(['external.webhook']);

interface ScopeFields {
  scopeType?: ScopeType;
  scopeSurveyId?: string;
  scopeTagId?: string;
  triggerType?: string;
}

function checkScopeFields(data: ScopeFields, ctx: z.RefinementCtx): void {
  const scopeType = data.scopeType ?? 'org';

  if (data.triggerType && SCOPE_UNSUPPORTED_TRIGGER_TYPES.has(data.triggerType) && scopeType !== 'org') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['scopeType'],
      message: `triggerType '${data.triggerType}' has no survey dimension and can only be org-scoped`,
    });
    return;
  }

  if (scopeType === 'org') {
    if (data.scopeSurveyId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scopeSurveyId'], message: 'scopeSurveyId must not be set when scopeType is org' });
    }
    if (data.scopeTagId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scopeTagId'], message: 'scopeTagId must not be set when scopeType is org' });
    }
  } else if (scopeType === 'survey') {
    if (!data.scopeSurveyId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scopeSurveyId'], message: 'scopeSurveyId is required when scopeType is survey' });
    }
    if (data.scopeTagId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scopeTagId'], message: 'scopeTagId must not be set when scopeType is survey' });
    }
  } else if (scopeType === 'tag') {
    if (!data.scopeTagId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scopeTagId'], message: 'scopeTagId is required when scopeType is tag' });
    }
    if (data.scopeSurveyId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scopeSurveyId'], message: 'scopeSurveyId must not be set when scopeType is tag' });
    }
  }
}

const scopeShape = {
  scopeType: z.enum(SCOPE_TYPES).optional(),
  scopeSurveyId: z.string().uuid('scopeSurveyId must be a UUID').optional(),
  scopeTagId: z.string().uuid('scopeTagId must be a UUID').optional(),
};

export const createWorkflowSchema = z.object({
  name: z.string().min(1, 'name is required').max(200),
  condition: z.record(z.string(), z.unknown()).optional(),
  action: z.record(z.string(), z.unknown()).optional(),
  // Graph engine fields (optional — legacy condition/action still supported)
  description: z.string().max(2000).optional(),
  triggerType: z.string().max(64).optional(),
  nodes: z.array(z.record(z.string(), z.unknown())).optional(),
  edges: z.array(z.record(z.string(), z.unknown())).optional(),
  status: z.enum(STATUS).optional(),
  cooldown_minutes: cooldownMinutesSchema.optional(),
  ...scopeShape,
}).superRefine(checkScopeFields);

export const updateWorkflowSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  condition: z.record(z.string(), z.unknown()).optional(),
  action: z.record(z.string(), z.unknown()).optional(),
  description: z.string().max(2000).optional(),
  triggerType: z.string().max(64).optional(),
  nodes: z.array(z.record(z.string(), z.unknown())).optional(),
  edges: z.array(z.record(z.string(), z.unknown())).optional(),
  status: z.enum(STATUS).optional(),
  cooldown_minutes: cooldownMinutesSchema.optional(),
  // Optimistic-locking token (Nina, 2026-07-02, DEEP_AUDIT_PM_FINDINGS.md §10a,
  // TRACKER.md Wave 11 Part 2). Strictly OPTIONAL — this is the field's whole
  // backward-compatibility contract. Every caller that predates this feature
  // (tests, internal-workflows signal consumers, template-seed flows) never
  // sends `version`, so routes/workflows.ts's `version !== undefined` check
  // skips the conflict check entirely for them, unchanged from today's
  // behavior. Only a caller that opts in by sending its last-known version
  // gets 409-on-conflict protection.
  version: z.number().int().positive().optional(),
  ...scopeShape,
}).superRefine((data, ctx) => {
  // Update is a partial patch — only enforce scope consistency when the caller
  // is actually touching scope this request (scopeType/scopeSurveyId/scopeTagId
  // present in the body). A PUT that only changes e.g. `name` must not be forced
  // to re-send a fully-valid scope triple every time.
  if (data.scopeType === undefined && data.scopeSurveyId === undefined && data.scopeTagId === undefined) return;
  // Changing scope always requires scopeType explicitly in the same request —
  // a lone scopeSurveyId/scopeTagId with no scopeType is ambiguous (is this
  // narrowing an existing survey scope, or is the caller trying to switch scope
  // kind entirely?) rather than guessing/defaulting, require the full intent.
  if (data.scopeType === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scopeType'], message: 'scopeType is required when setting scopeSurveyId or scopeTagId' });
    return;
  }
  checkScopeFields(data, ctx);
});

export type CreateWorkflowInput = z.infer<typeof createWorkflowSchema>;
export type UpdateWorkflowInput = z.infer<typeof updateWorkflowSchema>;

// POST /api/workflows/parse-nl — see docs/automation-hub/BUILDER_SPEC_WAVE2.md §2.1
// and docs/automation-hub/WORKFLOW_SIGNAL_CONTRACT.md. Bounds (1-1000 chars) match
// the frontend's WorkflowNLBuilderPage textarea contract exactly.
export const parseWorkflowNLSchema = z.object({
  description: z.string().min(1, 'description is required').max(1000, 'description must be 1000 characters or fewer'),
});

export type ParseWorkflowNLInput = z.infer<typeof parseWorkflowNLSchema>;

// POST /api/internal/workflows/signal — inbound workflow_signal from CrystalOS
// (see docs/automation-hub/WORKFLOW_SIGNAL_CONTRACT.md). Service-to-service only,
// gated by requireInternalKey (not requireAuth — there is no end-user session on
// this call), so org_id must be supplied explicitly (unlike req.orgId elsewhere).
export const workflowSignalSchema = z.object({
  org_id: z.string().min(1, 'org_id is required'),
  signal_type: z.enum(['sentiment_spike', 'new_theme_detected', 'anomaly_detected']),
  confidence: z.number().min(0).max(1),
  payload: z.record(z.string(), z.unknown()).default({}),
  detected_at: z.string().optional(),
  survey_id: z.string().optional(),
  source_run_id: z.string().optional(),
});

export type WorkflowSignalInput = z.infer<typeof workflowSignalSchema>;
