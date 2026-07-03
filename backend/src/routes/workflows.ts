import express from 'express';
import type { Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { requirePermission } from '../middleware/requirePermission';
import { validate } from '../lib/validate';
import { createWorkflowSchema, updateWorkflowSchema, parseWorkflowNLSchema, SCOPE_UNSUPPORTED_TRIGGER_TYPES } from '../schemas/workflows';
import { query } from '../lib/db';
import { serverError, clientError } from '../lib/httpError';
import { registry } from '../lib/workflowRegistry';
import { runWorkflow, resumeWorkflow, computeCooldownStatus } from '../lib/workflowEngine';
import type { WorkflowRecord } from '../lib/workflowEngine';
import * as agentsClient from '../lib/agentsClient';
import { UnparseableWorkflowError } from '../lib/agentsClient';
import { checkTriggerTierGate, upgradeRequiredMessage } from '../lib/planGating';
import { humanizeExecutionError } from '../lib/humanizeExecutionError';
import { writeWorkflowAuditLog, diffChangedFields } from '../lib/workflowAuditLog';
import logger from '../lib/logger';

const router = express.Router();

interface PgError extends Error {
  code?: string;
}

// Gated uniformly with requirePermission('workflows:manage') on every route in this
// file — including read-only/static ones (registry, templates) — mirroring the
// existing convention for this class of resource: routes/alerts.ts applies a single
// `alerts:manage` permission across its entire surface, including the equally-static
// GET /types taxonomy catalog. `workflows:manage` has no read/write split in the
// permission catalog (unlike contacts:read/contacts:write), so one permission covers
// the whole router, same as alerts.ts.

// Attach the computed `cooldown_status` field to a workflow row for GET responses
// (spec: docs/automation-hub/BUILDER_REBUILD_SPEC.md §5.3). Computed server-side so
// the frontend never does clock-skew-prone "resets in N min" math itself.
function withCooldownStatus<T extends WorkflowRecord>(row: T): T & { cooldown_status: ReturnType<typeof computeCooldownStatus> } {
  return { ...row, cooldown_status: computeCooldownStatus(row) };
}

// GET /api/workflows/approvals — pending approvals for the org
router.get('/approvals', requireAuth, requirePermission('workflows:manage'), async (req: Request, res: Response): Promise<void> => {
  try {
    const { rows } = await query(
      `SELECT a.id, a.execution_id, a.workflow_id, a.node_id, a.requested_at, w.name AS workflow_name
         FROM workflow_approvals a
         JOIN workflows w ON w.id = a.workflow_id
        WHERE a.org_id = $1 AND a.status = 'pending'
        ORDER BY a.requested_at DESC LIMIT 50`,
      [req.orgId]
    );
    res.json({ approvals: rows });
  } catch (err: unknown) {
    const pgErr = err as PgError;
    if (pgErr.code === '42P01') { res.json({ approvals: [] }); return; }
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

// POST /api/workflows/approvals/:executionId — approve/reject → resume/abort
//
// Fail-closed decision parsing (Nina, 2026-07-01, DEEP_AUDIT_PM_FINDINGS.md §7c):
// previously ANYTHING that wasn't literally 'reject'/'rejected' was silently
// treated as 'approved' — a client bug, typo, or malformed payload (e.g.
// `{decision: undefined}`, `{decision: 'aprove'}`, `{decision: true}`) would
// silently approve a consequential, gated action. Now: only an exact (case-
// insensitive) 'approved'/'approve' or 'rejected'/'reject' is accepted; anything
// else is a 400, not a silent approval.
router.post('/approvals/:executionId', requireAuth, requirePermission('workflows:manage'), async (req: Request, res: Response): Promise<void> => {
  try {
    const raw = typeof req.body?.decision === 'string' ? req.body.decision.toLowerCase() : null;
    const decision = raw === 'approved' || raw === 'approve' ? 'approved'
      : raw === 'rejected' || raw === 'reject' ? 'rejected'
      : null;
    if (!decision) {
      clientError(res, 400, "decision must be 'approved' or 'rejected'");
      return;
    }
    const result = await resumeWorkflow(req.params.executionId, req.orgId, decision, req.userId);
    if (!result) { clientError(res, 404, 'No pending approval for that execution'); return; }
    res.json({ result });
  } catch (err: unknown) {
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

// GET /api/workflows/registry — triggers / condition fields+operators / actions catalog
router.get('/registry', requireAuth, requirePermission('workflows:manage'), (req: Request, res: Response): void => {
  res.json(registry());
});

// GET /api/workflows/templates — pre-built workflow templates
//
// Gallery honesty fix (Nina, 2026-07-01, DEEP_AUDIT_PM_FINDINGS.md Top-5 Finding
// #3 / §5, corroborated by DEEP_AUDIT_UX_FINDINGS.md): re-verified directly against
// the current workflowRegistry.ts + every real event producer in the codebase —
// exactly 4 of the 8 seeded templates (nps-recovery, verbatim-escalation,
// nps-win-celebration, slow-completion-flag) use a trigger_type with zero producer
// anywhere, so they can never fire, for any org, on any plan, ever. Migration
// 20260701140100_workflow_template_functional_flag.sql marks those 4
// `is_functional = FALSE`. Excluded here (WHERE clause) rather than shipped with a
// "not yet available" badge — a customer's first action in the product is often
// "click a template," and a gallery entry that always no-ops is worse than a
// smaller, fully-functional gallery. `is_functional` intentionally does NOT cover
// "delivers perfectly end-to-end" (e.g. anomaly-to-jira's dead email step from a
// missing recipient) — that's a narrower, already-tracked config gap, not a
// dead-trigger gap; conflating the two would silently hide functional templates
// too.
router.get('/templates', requireAuth, requirePermission('workflows:manage'), async (req: Request, res: Response): Promise<void> => {
  try {
    const { rows } = await query(
      `SELECT slug, name, description, category, trigger_type, nodes, edges, is_featured
         FROM workflow_templates
        WHERE is_functional = TRUE
        ORDER BY is_featured DESC, name`
    );
    res.json({ templates: rows });
  } catch (err: unknown) {
    const pgErr = err as PgError;
    if (pgErr.code === '42P01') { res.json({ templates: [] }); return; }
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

// GET /api/workflows/notification-targets — id+name-only lookup lists for the
// notify.email/notify.in_app recipient picker (role/department/group targeting,
// see lib/recipientResolver.ts). Deliberately gated by `workflows:manage`
// (this router's uniform permission) rather than `users:manage`.
//
// Why a separate, lighter endpoint instead of just calling GET /api/roles,
// GET /api/departments, GET /api/groups: those three all require
// `users:manage` (an admin-level people-management permission that also
// gates writes and PII-adjacent fields like email/avatar). A workflow author
// with `workflows:manage: 'ALL'` but `users:manage: 'NONE'` is a real,
// existing built-in role (org:program_admin — see lib/rbac.ts) — without this
// endpoint, that role could build a notify.email node but get a 403 the
// moment they tried to open the role/department/group picker to target it,
// making the picker unusable for a real, non-hypothetical set of users.
// Response is intentionally minimal (id + name only, no member emails/PII, no
// counts beyond what's needed to show "N members" — reusing the exact
// resolver-mirrored queries) so this stays a safe read surface even for users
// who cannot manage the People/Roles/Departments/Groups admin pages.
router.get('/notification-targets', requireAuth, requirePermission('workflows:manage'), async (req: Request, res: Response): Promise<void> => {
  try {
    const [{ rows: roles }, { rows: departments }, { rows: groups }] = await Promise.all([
      query(
        `SELECT r.id, r.name, COUNT(up.user_id)::int AS member_count
           FROM org_roles r
           LEFT JOIN user_profiles up ON up.role_id = r.id AND up.org_id = r.org_id
          WHERE r.org_id = $1
          GROUP BY r.id
          ORDER BY r.name ASC`,
        [req.orgId]
      ),
      // Direct-member count only — matches routes/departments.ts's
      // `directMemberCount` (NOT the tree's subtree `totalMemberCount`), and
      // matches lib/recipientResolver.ts's resolveDepartmentMembers exactly,
      // so this preview count is never out of sync with what targeting this
      // department id will actually deliver to.
      query(
        `SELECT d.id, d.name,
                COUNT(up.user_id) FILTER (WHERE up.is_active = TRUE AND up.deprovisioned_at IS NULL)::int AS member_count
           FROM departments d
           LEFT JOIN user_profiles up ON up.department_id = d.id AND up.org_id = d.org_id
          WHERE d.org_id = $1 AND d.is_active = TRUE
          GROUP BY d.id
          ORDER BY d.name ASC`,
        [req.orgId]
      ),
      query(
        `SELECT id, name, member_count FROM user_groups WHERE org_id = $1 AND is_active = TRUE ORDER BY name ASC`,
        [req.orgId]
      ),
    ]);
    res.json({
      roles: roles.map((r: Record<string, unknown>) => ({ id: r.id, name: r.name, memberCount: Number(r.member_count) })),
      departments: departments.map((d: Record<string, unknown>) => ({ id: d.id, name: d.name, memberCount: Number(d.member_count) })),
      groups: groups.map((g: Record<string, unknown>) => ({ id: g.id, name: g.name, memberCount: Number(g.member_count) })),
    });
  } catch (err: unknown) {
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

router.get('/', requireAuth, requirePermission('workflows:manage'), async (req: Request, res: Response): Promise<void> => {
  try {
    const { rows } = await query(
      'SELECT * FROM workflows WHERE org_id = $1 ORDER BY created_at DESC',
      [req.orgId]
    );
    res.json({ workflows: (rows as WorkflowRecord[]).map(withCooldownStatus) });
  } catch (err: unknown) {
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

// POST /api/workflows/parse-nl — thin proxy to CrystalOS's NL workflow parser
// (Wave 3, see docs/automation-hub/BUILDER_SPEC_WAVE2.md §2.1 and
// docs/automation-hub/WORKFLOW_SIGNAL_CONTRACT.md). Per root CLAUDE.md's
// architecture pattern, this route never talks to CrystalOS's own contract
// shape directly to the caller — it maps agentsClient.parseWorkflowNL's result
// onto exactly the shape app/src/lib/api.ts's parseWorkflowNL()/
// toParseWorkflowNLError() already expect (declared before /:id, matching the
// file's convention of literal-path routes before param routes).
router.post('/parse-nl', requireAuth, requirePermission('workflows:manage'), validate(parseWorkflowNLSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const { description } = req.body as { description: string };

    // Wave 12 (docs/automation-hub/BUILDER_REDESIGN_V2_SCOPE.md) — this pipeline
    // predates the org/survey/tag scope redesign and previously forced every
    // NL-created workflow to org-wide scope. Forward a lightweight org
    // survey/tag catalog alongside the existing trigger/action registry so
    // Amara's CrystalOS parser can match an NL mention (e.g. "for the Q3 NPS
    // survey") against a REAL survey/tag and return a scope hint. This extended
    // payload is built ONLY for this call site — `registry()` itself is
    // untouched (it's also used by GET /api/workflows/registry for the
    // no-code builders, which have no use for a full survey/tag list).
    // Reuses the exact same queries GET /api/surveys and GET /api/survey-tags
    // already run (see routes/surveys.ts's `router.get('/')` and
    // routes/tags.ts's `router.get('/')`) — trimmed to just {id, name} since
    // that's all the NL scope-matching skill needs, not the full survey/tag
    // objects those routes return.
    const [surveysResult, tagsResult] = await Promise.all([
      query('SELECT id, title AS name FROM surveys WHERE org_id = $1 AND deleted_at IS NULL ORDER BY updated_at DESC', [req.orgId]),
      query('SELECT id, name FROM survey_tags WHERE org_id = $1 ORDER BY name ASC', [req.orgId]),
    ]);
    const extendedRegistry = {
      ...registry(),
      surveys: surveysResult.rows as { id: string; name: string }[],
      tags: tagsResult.rows as { id: string; name: string }[],
    };

    const result = await agentsClient.parseWorkflowNL(description, extendedRegistry, req.orgId);
    // Pass CrystalOS's response through unchanged, including the optional
    // scopeType/scopeSurveyId/scopeTagId fields when present — omitted when
    // CrystalOS doesn't (yet) return them, which the frontend/route contract
    // treats identically to `scopeType: 'org'` (today's behavior).
    res.json(result);
  } catch (err: unknown) {
    if (err instanceof UnparseableWorkflowError) {
      res.status(422).json({ error: 'unparseable', message: err.message, suggestions: err.suggestions });
      return;
    }
    const agentsErr = err as { status?: number; message?: string; name?: string };
    const isTimeout = agentsErr?.name === 'AbortError'
      || /abort|timeout/i.test(agentsErr?.message ?? '');
    if (isTimeout) {
      res.status(504).json({ error: 'Agents service timed out' });
      return;
    }
    logger.error({ err: agentsErr?.message, status: agentsErr?.status }, 'workflows_parse_nl_error');
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

// GET /api/workflows/:id — fetch a single workflow (org-scoped), for builder edit-mode
// pre-population (see docs/automation-hub/BUILDER_SPEC_WAVE2.md §0). Declared after the
// literal-path routes above (/approvals, /registry, /templates) and before /:id/toggle,
// /:id/test, /:id/executions — those have extra path segments so they never collide with
// this one regardless of order, but keeping this after the literal siblings matches the
// file's existing convention of static routes before param routes.
router.get('/:id', requireAuth, requirePermission('workflows:manage'), async (req: Request, res: Response): Promise<void> => {
  try {
    const { rows: [workflow] } = await query(
      'SELECT * FROM workflows WHERE id = $1 AND org_id = $2', [req.params.id, req.orgId]
    );
    if (!workflow) { clientError(res, 404, 'Workflow not found'); return; }
    res.json({ workflow: withCooldownStatus(workflow as WorkflowRecord) });
  } catch (err: unknown) {
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

router.post('/', requireAuth, requirePermission('workflows:manage'), validate(createWorkflowSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, condition, action, description, triggerType, nodes, edges, status, cooldown_minutes,
            scopeType, scopeSurveyId, scopeTagId } = req.body;

    // Growth-tier enforcement for Crystal Signal triggers (Nina, 2026-07-01,
    // DEEP_AUDIT_PM_FINDINGS.md §6d — previously zero enforcement anywhere, just
    // a tooltip's marketing copy). See lib/planGating.ts for the full rationale
    // and why this is also re-checked at execution time (workflowEngine.ts).
    const gate = await checkTriggerTierGate(req.orgId, triggerType);
    if (!gate.allowed && gate.requiredTier) {
      clientError(res, 403, upgradeRequiredMessage(triggerType, gate.requiredTier));
      return;
    }

    const { rows } = await query(
      `INSERT INTO workflows (org_id, name, condition, action, created_by, description, trigger_type, nodes, edges, status, cooldown_minutes, scope_type, scope_survey_id, scope_tag_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14) RETURNING *`,
      [req.orgId, name, JSON.stringify(condition || {}), JSON.stringify(action || {}), req.userId,
       description || null, triggerType || null,
       JSON.stringify(nodes || []), JSON.stringify(edges || []), status || 'draft',
       cooldown_minutes ?? null,
       scopeType || 'org', scopeSurveyId || null, scopeTagId || null]
    );
    const created = rows[0] as WorkflowRecord;
    // Audit trail (Nina, 2026-07-02, DEEP_AUDIT_PM_FINDINGS.md §10b). Fire-and-forget
    // relative to the response — see lib/workflowAuditLog.ts's header for why a
    // write failure here must never fail/revert the create it's recording.
    void writeWorkflowAuditLog({
      workflowId: created.id,
      orgId: req.orgId,
      actorUserId: req.userId,
      action: 'created',
      summary: { name: created.name, status: created.status, trigger_type: created.trigger_type },
    });
    res.status(201).json({ workflow: withCooldownStatus(created) });
  } catch (err: unknown) {
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

router.put('/:id', requireAuth, requirePermission('workflows:manage'), validate(updateWorkflowSchema), async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, condition, action, status, description, triggerType, nodes, edges, cooldown_minutes,
            scopeType, scopeSurveyId, scopeTagId, version } = req.body;

    // Growth-tier enforcement (see the identical check in POST / and
    // lib/planGating.ts for full rationale). Only checked when this PUT is
    // actually setting/changing triggerType — a PUT that doesn't touch it can't
    // newly introduce a gated trigger, and an already-saved gated trigger on a
    // since-downgraded org is caught by the execution-time check instead (so a
    // customer editing an unrelated field, e.g. the Slack message wording, on an
    // old workflow they can no longer save with its original trigger isn't
    // needlessly blocked here).
    if (triggerType !== undefined) {
      const gate = await checkTriggerTierGate(req.orgId, triggerType);
      if (!gate.allowed && gate.requiredTier) {
        clientError(res, 403, upgradeRequiredMessage(triggerType, gate.requiredTier));
        return;
      }
    }

    // Fetch the current row once, up front — covers three independent needs
    // below: the scope/triggerType cross-check (pre-existing ad-hoc lookup this
    // replaces), the optimistic-lock version check (§10a), and a real before/
    // after audit diff (§10b) instead of one that would otherwise misreport
    // every field as "changed" with no prior snapshot to compare against. If
    // the workflow doesn't exist / belongs to another org, `existingRow` is
    // simply undefined and every use below degrades gracefully (no 409, no
    // diff, no audit write) — this route has never 404'd on PUT, and the
    // UPDATE below still affects zero rows and returns `{ success: true }`
    // exactly as before this wave. Not a behavior change, just not a new one.
    const { rows: [existingRowRaw] } = await query(
      'SELECT * FROM workflows WHERE id = $1 AND org_id = $2', [req.params.id, req.orgId]
    );
    const existingRow = existingRowRaw as Record<string, unknown> | undefined;

    // Concurrent-edit protection (Nina, 2026-07-02, DEEP_AUDIT_PM_FINDINGS.md
    // §10a, TRACKER.md Wave 11 Part 2). CRITICAL backward-compatibility rule:
    // `version` is OPTIONAL on this endpoint. When the caller omits it entirely
    // (every existing caller today — tests, internal-workflows signal path,
    // template-seed flows, any pre-Wave-11 client), this check is skipped
    // completely and the PUT proceeds exactly as it did before this feature
    // existed. Only a caller that opts in by sending its last-known `version`
    // gets 409-on-conflict protection.
    //
    // KENJI, Wave 11 Phase 3 (fault-tolerance gate) — TOCTOU fix: this pre-flight
    // check against `existingRow` (a plain SELECT) is a fast-path/early-exit
    // convenience ONLY — it is deliberately NOT the mechanism that makes the
    // conflict check race-safe. Two concurrent requests carrying the same stale
    // `version` can both pass this SELECT-based check before either one's UPDATE
    // commits (classic time-of-check-to-time-of-use gap), which would let both
    // writers "win" (a lost update) with neither getting a 409. The actual
    // safety guarantee lives in the UPDATE below: `version = $version` is folded
    // directly into that statement's WHERE clause when the caller opted in, so
    // Postgres's row-level locking serializes concurrent UPDATEs against the
    // same row — only the first to commit can match `version = $version`; by
    // the time the second one's UPDATE acquires the lock, the row's version has
    // already moved, so its WHERE clause matches zero rows and it falls into the
    // post-UPDATE re-check below, which re-fetches and returns 409. This
    // SELECT-based check now exists purely to fail fast in the common
    // (non-racing) stale-edit case without paying for a write attempt.
    if (version !== undefined && existingRow && version !== (existingRow as { version?: number }).version) {
      res.status(409).json({
        error: 'This workflow was changed by someone else. Refresh to see the latest version before saving again.',
        workflow: withCooldownStatus(existingRow as WorkflowRecord),
      });
      return;
    }

    // schemas/workflows.ts's superRefine can only cross-check triggerType against
    // scope when BOTH are present in this same request body. A PUT that sets
    // scopeType without re-sending triggerType needs the row's EXISTING trigger
    // type to run that same check — reuses existingRow (fetched above) rather
    // than a second query.
    if (scopeType !== undefined && scopeType !== 'org' && triggerType === undefined) {
      const existingTriggerType = (existingRow as { trigger_type?: string } | undefined)?.trigger_type;
      if (existingTriggerType && SCOPE_UNSUPPORTED_TRIGGER_TYPES.has(existingTriggerType)) {
        clientError(res, 400, `triggerType '${existingTriggerType}' has no survey dimension and can only be org-scoped`);
        return;
      }
    }

    const sets = ['updated_at = NOW()'];
    const vals: unknown[] = [];
    let i = 1;
    if (name        !== undefined) { sets.push(`name = $${i++}`);         vals.push(name); }
    if (condition   !== undefined) { sets.push(`condition = $${i++}`);    vals.push(JSON.stringify(condition)); }
    if (action      !== undefined) { sets.push(`action = $${i++}`);       vals.push(JSON.stringify(action)); }
    if (status      !== undefined) { sets.push(`status = $${i++}`);       vals.push(status); }
    // Graph engine fields — mirrors POST /'s INSERT (createWorkflowSchema already
    // accepted these; updateWorkflowSchema now does too). Builder edit-mode saves
    // persist through these (see docs/automation-hub/BUILDER_SPEC_WAVE2.md §0).
    if (description !== undefined) { sets.push(`description = $${i++}`);  vals.push(description); }
    if (triggerType !== undefined) { sets.push(`trigger_type = $${i++}`); vals.push(triggerType); }
    if (nodes       !== undefined) { sets.push(`nodes = $${i++}::jsonb`); vals.push(JSON.stringify(nodes)); }
    if (edges       !== undefined) { sets.push(`edges = $${i++}::jsonb`); vals.push(JSON.stringify(edges)); }
    // cooldown_minutes (C-004, see docs/automation-hub/BUILDER_REBUILD_SPEC.md §5.3).
    // Explicit `!== undefined` check (not truthy) so the UI can send `null` to clear
    // an existing cooldown back to "no cooldown, fire every time".
    if (cooldown_minutes !== undefined) { sets.push(`cooldown_minutes = $${i++}`); vals.push(cooldown_minutes); }
    // Scope (see docs/automation-hub/BUILDER_REDESIGN_V2_SCOPE.md §2). The schema
    // layer requires scopeType whenever scope is being touched at all (see
    // schemas/workflows.ts), so scopeType is the signal that this request intends
    // to write scope — writing all three together keeps the two-id-columns
    // invariant atomic (never a half-updated scope where e.g. scope_tag_id from a
    // prior tag-scope lingers after switching to survey-scope).
    if (scopeType !== undefined) {
      sets.push(`scope_type = $${i++}`);       vals.push(scopeType);
      sets.push(`scope_survey_id = $${i++}`);  vals.push(scopeSurveyId || null);
      sets.push(`scope_tag_id = $${i++}`);     vals.push(scopeTagId || null);
    }
    // Audit trail — updated_by (§10b). Unconditional on every successful PUT,
    // same as updated_at above; created_by itself is never touched by this route.
    sets.push(`updated_by = $${i++}`); vals.push(req.userId);
    // Optimistic-lock counter — unconditional increment on every successful PUT,
    // regardless of whether the caller sent `version` (§10a). This is what makes
    // the NEXT caller's version check meaningful even if today's caller never
    // opted in.
    sets.push('version = version + 1');

    vals.push(req.params.id, req.orgId);
    let whereClause = `id = $${i++} AND org_id = $${i}`;
    // Atomic optimistic-lock guard (Kenji, Wave 11 Phase 3): when the caller
    // opted into version checking, fold `AND version = $version` into THIS
    // UPDATE's own WHERE clause — not a separate SELECT — so the check-and-write
    // is a single atomic statement with no gap a second concurrent request could
    // land in. Postgres serializes concurrent UPDATEs targeting the same row via
    // its row-level lock: whichever request's UPDATE acquires the lock first
    // commits (and bumps `version`), and any other concurrently-executing
    // request's WHERE clause is (re-)evaluated against the now-updated row and
    // matches zero rows — it can never also succeed against the stale version.
    if (version !== undefined) {
      i += 1;
      whereClause += ` AND version = $${i}`;
      vals.push(version);
    }
    const { rows: [updatedRow] } = await query(
      `UPDATE workflows SET ${sets.join(', ')} WHERE ${whereClause} RETURNING *`,
      vals
    );

    // Lost-the-race case: the caller sent a `version` that matched at SELECT
    // time (or no pre-fetch existed yet) but by the time this UPDATE's WHERE
    // clause was evaluated, a concurrent request had already committed first and
    // moved the row's version — this UPDATE matches zero rows. Re-fetch and
    // return the same 409 shape as the fast-path check above, rather than
    // silently reporting `{ success: true }` for a write that didn't happen.
    // Only applies when a version was actually supplied AND the row genuinely
    // exists (existingRow was found) — this must never turn the route's
    // long-standing "PUT against a nonexistent/cross-org id is a silent
    // zero-rows-affected {success:true}" behavior into a new 409.
    if (version !== undefined && existingRow && !updatedRow) {
      const { rows: [latestRaw] } = await query(
        'SELECT * FROM workflows WHERE id = $1 AND org_id = $2', [req.params.id, req.orgId]
      );
      res.status(409).json({
        error: 'This workflow was changed by someone else. Refresh to see the latest version before saving again.',
        workflow: withCooldownStatus((latestRaw || existingRow) as WorkflowRecord),
      });
      return;
    }

    // Audit trail (§10b) — fire-and-forget relative to the response; see
    // lib/workflowAuditLog.ts's header for the transactional-coupling rationale.
    // status_changed is recorded as its own action (distinct from a generic
    // 'updated') whenever this PUT touches status, mirroring the PM audit's
    // explicit interest in "who turned this on/off" as a first-class question —
    // a plain 'updated' action with the diff buried in `summary` would still
    // technically answer it, but a dedicated action makes it filterable/scannable
    // without parsing every summary blob. Only logged when both the before
    // snapshot and the UPDATE's result are present — a PUT against a
    // nonexistent/cross-org id affects zero rows (pre-existing behavior,
    // unchanged by this wave) and has nothing real to audit; requiring both
    // also guarantees the diff below is a genuine before/after comparison, not
    // one that misreports every field as "changed" from a missing baseline.
    if (existingRow && updatedRow) {
      const changedFields = diffChangedFields(existingRow, updatedRow as Record<string, unknown>);
      void writeWorkflowAuditLog({
        workflowId: req.params.id,
        orgId: req.orgId,
        actorUserId: req.userId,
        action: status !== undefined ? 'status_changed' : 'updated',
        summary: changedFields,
      });
    }

    res.json({ success: true, version: (updatedRow as { version?: number } | undefined)?.version });
  } catch (err: unknown) {
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

router.delete('/:id', requireAuth, requirePermission('workflows:manage'), async (req: Request, res: Response): Promise<void> => {
  try {
    // RETURNING (rather than a separate pre-fetch) so this stays a single query,
    // same query count as before this feature — the audit summary uses whatever
    // the row looked like at the moment it was deleted.
    const { rows: [deleted] } = await query(
      'DELETE FROM workflows WHERE id = $1 AND org_id = $2 RETURNING *', [req.params.id, req.orgId]
    );
    // Audit trail (§10b). Only logged when a row actually existed to delete —
    // an org-scoped no-op delete (already gone / never existed / cross-org) has
    // nothing to record. See lib/workflowAuditLog.ts for the fire-and-forget
    // rationale; workflow_audit_log has no FK to workflows (see migration) so
    // this 'deleted' row is guaranteed to outlive the workflow it describes.
    if (deleted) {
      void writeWorkflowAuditLog({
        workflowId: req.params.id,
        orgId: req.orgId,
        actorUserId: req.userId,
        action: 'deleted',
        summary: { name: (deleted as WorkflowRecord).name, status: (deleted as WorkflowRecord).status },
      });
    }
    res.json({ success: true });
  } catch (err: unknown) {
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

router.post('/:id/toggle', requireAuth, requirePermission('workflows:manage'), async (req: Request, res: Response): Promise<void> => {
  try {
    const { rows } = await query(
      `UPDATE workflows
       SET status = CASE WHEN status = 'active' THEN 'paused' ELSE 'active' END,
           updated_at = NOW(), updated_by = $3, version = version + 1
       WHERE id = $1 AND org_id = $2
       RETURNING status`,
      [req.params.id, req.orgId, req.userId]
    );
    if (!rows.length) { res.status(404).json({ error: 'Workflow not found' }); return; }
    // Audit trail (§10b) — toggling is a status change same as PUT's status
    // field, so it gets the same 'status_changed' action for consistent
    // filtering regardless of which endpoint the caller used.
    void writeWorkflowAuditLog({
      workflowId: req.params.id,
      orgId: req.orgId,
      actorUserId: req.userId,
      action: 'status_changed',
      summary: { status: { after: rows[0].status } },
    });
    res.json({ status: rows[0].status });
  } catch (err: unknown) {
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

// GET /api/workflows/:id/audit-log — paginated config-change history (Nina,
// 2026-07-02, DEEP_AUDIT_PM_FINDINGS.md §10b, TRACKER.md Wave 11 Part 1). Read-only,
// backend surface only — Elias builds the frontend view in a later phase (per
// root CLAUDE.md's Team-driven Implementation Protocol, this endpoint is the
// contract he builds against). Pagination mirrors routes/auditLogs.ts's existing
// `page`/`limit` convention exactly (same param names, same response shape:
// `{ events, total, page, limit, pages }`) rather than inventing a cursor scheme,
// since that's this codebase's established pattern for audit-log-shaped reads.
router.get('/:id/audit-log', requireAuth, requirePermission('workflows:manage'), async (req: Request, res: Response): Promise<void> => {
  try {
    // Org-scoped existence check first so a workflow belonging to another org
    // 404s (no distinguishing signal that would leak existence), same convention
    // as GET /:id above — the audit query itself is also org_id-filtered as a
    // second, independent guard.
    const { rows: [workflow] } = await query(
      'SELECT id FROM workflows WHERE id = $1 AND org_id = $2', [req.params.id, req.orgId]
    );
    if (!workflow) { clientError(res, 404, 'Workflow not found'); return; }

    const page = Math.max(parseInt(String(req.query.page ?? ''), 10) || 1, 1);
    const limit = Math.min(parseInt(String(req.query.limit ?? ''), 10) || 50, 200);
    const offset = (page - 1) * limit;

    const [{ rows: events }, { rows: [{ count }] }] = await Promise.all([
      query(
        `SELECT id, workflow_id, org_id, actor_user_id, action, summary, created_at
           FROM workflow_audit_log
          WHERE workflow_id = $1 AND org_id = $2
          ORDER BY created_at DESC
          LIMIT $3 OFFSET $4`,
        [req.params.id, req.orgId, limit, offset]
      ),
      query('SELECT COUNT(*)::int AS count FROM workflow_audit_log WHERE workflow_id = $1 AND org_id = $2', [req.params.id, req.orgId]),
    ]);

    res.json({
      events: (events as Record<string, unknown>[]).map((e) => ({
        id: e.id,
        workflowId: e.workflow_id,
        actorUserId: e.actor_user_id,
        action: e.action,
        summary: e.summary,
        createdAt: e.created_at,
      })),
      total: count, page, limit, pages: Math.ceil(count / limit),
    });
  } catch (err: unknown) {
    const pgErr = err as PgError;
    if (pgErr.code === '42P01') { res.json({ events: [], total: 0, page: 1, limit: 50, pages: 0 }); return; }
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

// POST /api/workflows/:id/test — run the workflow against a sample/provided event
router.post('/:id/test', requireAuth, requirePermission('workflows:manage'), async (req: Request, res: Response): Promise<void> => {
  try {
    const { rows: [wf] } = await query(
      'SELECT * FROM workflows WHERE id = $1 AND org_id = $2', [req.params.id, req.orgId]
    );
    if (!wf) { clientError(res, 404, 'Workflow not found'); return; }
    const event = req.body?.event || { type: wf.trigger_type || 'manual', userId: req.userId, nps: 4, sentiment: 'negative', text: 'sample' };
    // Manual test run — bypass cooldown, matching the existing idempotency-bypass
    // convention for explicit human actions (see runWorkflow's bypassCooldown doc).
    const result = await runWorkflow(wf as Parameters<typeof runWorkflow>[0], event, { orgId: req.orgId, bypassCooldown: true });
    res.json({ result });
  } catch (err: unknown) {
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

// POST /api/workflows/executions/:execId/retry — re-run a failed execution (DLQ)
router.post('/executions/:execId/retry', requireAuth, requirePermission('workflows:manage'), async (req: Request, res: Response): Promise<void> => {
  try {
    const { rows: [exec] } = await query(
      'SELECT * FROM workflow_executions WHERE id = $1 AND org_id = $2', [req.params.execId, req.orgId]
    );
    if (!exec) { clientError(res, 404, 'Execution not found'); return; }
    if (exec.status !== 'failed') { clientError(res, 409, 'Only failed executions can be retried'); return; }
    const { rows: [wf] } = await query(
      'SELECT * FROM workflows WHERE id = $1 AND org_id = $2', [exec.workflow_id, req.orgId]
    );
    if (!wf) { clientError(res, 404, 'Workflow not found'); return; }
    // Manual DLQ replay — bypass cooldown, matching the existing idempotency-bypass
    // convention for explicit human actions (see runWorkflow's bypassCooldown doc).
    const result = await runWorkflow(wf as Parameters<typeof runWorkflow>[0], exec.trigger_payload || {}, { orgId: req.orgId, bypassCooldown: true });
    res.json({ result });
  } catch (err: unknown) {
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

// GET /api/workflows/:id/executions — recent run history with per-step detail.
//
// Extended (Nina, 2026-07-01, DEEP_AUDIT_PM_FINDINGS.md §4/§9a,
// DEEP_AUDIT_UX_FINDINGS.md §3.5 finding R-1/R-2) from a bare `step_count` to a
// full `steps` array per execution — the frontend previously had no way to show
// WHY a step was skipped (e.g. `output.reason = 'role_has_no_members'`) or what a
// failed step's error actually was, only a count. Two queries (executions, then
// all their steps in one batched IN() query) rather than N+1 per-execution step
// fetches. `error_message` at both the execution and step level is now an object
// ({ raw, message, matched }) produced by humanizeExecutionError — the raw value
// is never mutated in the DB, only reshaped at this response boundary. Also now
// selects the dead-letter/retry columns (added in the async-queue migration but
// never surfaced by this endpoint before — audit finding §9a) so the frontend can
// distinguish "will auto-retry" from "retries exhausted."
router.get('/:id/executions', requireAuth, requirePermission('workflows:manage'), async (req: Request, res: Response): Promise<void> => {
  try {
    const { rows: executions } = await query(
      `SELECT e.id, e.trigger_type, e.status, e.triggered_at, e.completed_at, e.duration_ms, e.error_message,
              e.attempt_count, e.next_retry_at, e.dead_letter,
              (SELECT COUNT(*)::int FROM workflow_step_executions s WHERE s.execution_id = e.id) AS step_count
         FROM workflow_executions e
        WHERE e.workflow_id = $1 AND e.org_id = $2
        ORDER BY e.triggered_at DESC LIMIT 25`,
      [req.params.id, req.orgId]
    );

    const execIds = (executions as { id: string }[]).map((e) => e.id);
    const stepsByExecution = new Map<string, Record<string, unknown>[]>();
    if (execIds.length > 0) {
      const { rows: steps } = await query(
        `SELECT execution_id, node_id, node_type, status, output, error_message, created_at
           FROM workflow_step_executions
          WHERE execution_id = ANY($1::uuid[])
          ORDER BY created_at ASC`,
        [execIds]
      );
      for (const step of steps as Record<string, unknown>[]) {
        const execId = step.execution_id as string;
        const list = stepsByExecution.get(execId) || [];
        list.push({
          nodeId: step.node_id,
          nodeType: step.node_type,
          status: step.status,
          output: step.output,
          errorMessage: humanizeExecutionError(step.error_message as string | null, step.node_type as string | undefined),
        });
        stepsByExecution.set(execId, list);
      }
    }

    const result = (executions as Record<string, unknown>[]).map((e) => ({
      ...e,
      error_message: humanizeExecutionError(e.error_message as string | null, e.trigger_type as string | undefined),
      steps: stepsByExecution.get(e.id as string) || [],
    }));

    res.json({ executions: result });
  } catch (err: unknown) {
    const pgErr = err as PgError;
    if (pgErr.code === '42P01') { res.json({ executions: [] }); return; }
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

export default router;
