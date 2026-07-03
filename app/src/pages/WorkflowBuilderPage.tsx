import { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from '../lib/i18n';
import { useSetPageTitle } from '../contexts/pageTitle';
import { useApi } from '../hooks/useApi';
import { invalidate } from '../lib/dataBus';
import { Icon } from '../components/Icon';
import { ROUTES } from '../constants/routes';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useCrystalPanel } from '../contexts/crystalPanel';
import type { ActionProposal } from '../types';
import { AskCrystalFab } from '../components/workflow-builder/AskCrystalFab';
import { SentencePill } from '../components/workflow-builder/sentence/SentencePill';
import { StepPanel } from '../components/workflow-builder/sentence/StepPanel';
import { TriggerStepPanelContent } from '../components/workflow-builder/sentence/TriggerStepPanelContent';
import { ScopeStepPanelContent, type ScopeSelection } from '../components/workflow-builder/sentence/ScopeStepPanelContent';
import { ActionStepPanelContent } from '../components/workflow-builder/sentence/ActionStepPanelContent';
import { ActionClauseList, type ActionClause } from '../components/workflow-builder/sentence/ActionClauseList';
import {
  ConditionStepPanelContent, fieldKindFor, type ConditionClause, type ConditionField,
} from '../components/workflow-builder/sentence/ConditionStepPanelContent';
import type { WorkflowStatus } from '../types';
import { CONTENT_PRODUCING_ACTIONS } from '../components/workflow-builder/sentence/ContentCustomizationPanel';
import { WorkflowSettingsPanel } from '../components/workflow-builder/panels/WorkflowSettingsPanel';
import {
  defaultActionContentConfig, extractNotifyTarget, flattenNotifyTarget, type ActionContentConfig,
} from '../components/workflow-builder/sentence/contentSections';
import {
  buildCronFromConfig, buildScheduleDescription,
  defaultScheduleConfig, type ScheduleConfigState,
} from '../lib/scheduleConfig';
import { defaultDelayConfig, minutesToUiState, type DelayConfigState } from '../components/workflow-builder/sentence/DelayActionConfigPanel';
import { SCOPE_UNSUPPORTED_TRIGGER_TYPES } from '../lib/scopeRules';
import type { EngineNode, EngineEdge } from '../lib/workflowCanvas';
import { connectorForAction, credentialStatusForAction, type CredentialStatus } from '../lib/workflowConnectorStatus';
import { WorkflowConflictError } from '../lib/api';

interface Trigger { type: string; label: string; category: string; live?: boolean }
interface ActionDef { action: string; label: string; category: string; live: boolean | string }

// flow.delay's wire config shape — `delay_minutes` is the only field the
// engine reads; `delayUiState` is a frontend-only round-trip convenience
// (same precedent as time.schedule's `scheduleUiState`/`cron` pair), so
// re-editing a saved delay action restores the exact friendly amount/unit
// the customer chose, instead of back-calculating an awkward fractional unit.
const DELAY_ACTION = 'flow.delay';

interface ActionState {
  id: string;
  action: string;
  contentConfig: ActionContentConfig;
  simpleConfig: Record<string, unknown>;
}

// Full seed shape — extended (Wave 9) beyond the original partial
// `{name, triggerType}` cross-link (still used by the canvas→linear hand-back,
// switchToCanvas()'s inverse) to also carry `description`/`nodes`/`edges`, the
// shape a template or the NL-builder-to-canvas handoff produces. See
// docs/automation-hub/TEMPLATE_FLOW_AND_RECIPIENT_TARGETING_SPEC.md §Issue 1.
interface LocationState {
  workflowId?: string;
  seed?: {
    name?: string;
    description?: string;
    triggerType?: string;
    nodes?: EngineNode[];
    edges?: EngineEdge[];
  };
}

type StepId = 'trigger' | 'scope' | 'condition' | 'action' | null;

// Cooldown's own default (was a second unnamed literal `60` at the
// `useState` initializer below before DEEP_AUDIT_FIX_SPECS.md Issue 3 needed
// to compare against it in switchToCanvas() — hoisted into a named constant
// instead of duplicating the magic number).
const DEFAULT_COOLDOWN_MINUTES = 60;

function newActionId(): string {
  return `action_${Date.now()}_${Math.round(Math.random() * 1e6)}`;
}

let conditionSeq = 0;
function newConditionClauseId(): string {
  conditionSeq += 1;
  return `cond_${Date.now()}_${conditionSeq}`;
}

interface HydratedFromNodes {
  triggerType?: string;
  scheduleConfig?: ScheduleConfigState;
  actions: ActionState[];
  // Wave 11 (Rohan WAVE11_UX_SPECS.md §1.7) — additive 4th return field. Both
  // existing call sites (edit-mode fetch, template-seed hydration) already
  // destructure this function's return via object destructuring, so adding a
  // field here is non-breaking; a workflow with no condition node in its
  // saved `nodes` array simply gets `conditionClauses: []`.
  conditionClauses: ConditionClause[];
}

// Shared node-parser — walks a `nodes: EngineNode[]` array (the engine's
// persisted graph shape) into the sentence builder's internal state. Used by
// both the edit-mode fetch (GET /api/workflows/:id) and the template-seed
// path, so a template's nodes/edges hydrate the sentence exactly like loading
// an existing workflow would (trigger AND scope AND actions, not just the
// trigger type). Extracted per the spec rather than duplicating this parsing
// a second time for templates.
//
// `fallbackTriggerType` covers edit-mode's own fallback: the workflow row's
// `trigger_type` column when the trigger node itself doesn't carry one.
function hydrateFromNodes(nodes: EngineNode[], fallbackTriggerType?: string): HydratedFromNodes {
  const triggerNode = nodes.find((n) => n.type === 'trigger');
  const triggerType = triggerNode?.trigger ?? fallbackTriggerType ?? undefined;
  const scheduleConfig = triggerType === 'time.schedule'
    ? ((triggerNode?.config?.scheduleUiState as ScheduleConfigState | undefined) ?? defaultScheduleConfig())
    : undefined;

  const actions: ActionState[] = nodes.filter((n) => n.type === 'action').map((n) => {
    const cfg = (n.config as Record<string, unknown>) ?? {};
    const hasContentShape = cfg.sections != null;
    // notify.in_app never has `sections` (it's not a CONTENT_PRODUCING_ACTION)
    // but does need its saved targeting fields (flat on `config`, per Nina's
    // backend contract — see extractNotifyTarget's doc) rehydrated into
    // contentConfig.target, the field its config panel reads (see
    // ActionStepPanelContent.tsx).
    if (n.action === 'notify.in_app') {
      return {
        id: newActionId(),
        action: n.action ?? '',
        contentConfig: { ...defaultActionContentConfig(), target: extractNotifyTarget(cfg) },
        simpleConfig: {},
      };
    }
    // flow.delay (Wave 11, Rohan WAVE11_UX_SPECS.md §2.4) — mirror-image of
    // buildDelayNodeConfig(): prefer the persisted `delayUiState` (the exact
    // friendly amount/unit the customer chose), falling back to
    // minutesToUiState(delay_minutes) for a node created some other way
    // (directly via API, or a future canvas builder support) that has
    // delay_minutes but no delayUiState.
    if (n.action === DELAY_ACTION) {
      const delayUiState = (cfg.delayUiState as DelayConfigState | undefined) ?? minutesToUiState(cfg.delay_minutes as number | undefined);
      return {
        id: newActionId(),
        action: n.action ?? '',
        contentConfig: defaultActionContentConfig(),
        simpleConfig: { delayUiState },
      };
    }
    return {
      id: newActionId(),
      action: n.action ?? '',
      contentConfig: hasContentShape
        ? { ...(cfg as unknown as ActionContentConfig), target: extractNotifyTarget(cfg) }
        : defaultActionContentConfig(),
      simpleConfig: hasContentShape ? {} : cfg,
    };
  });

  // Condition step (Wave 11, Rohan WAVE11_UX_SPECS.md §1.7) — finds the single
  // `type: 'condition'` node (if any) and maps its `conditions.rules` into
  // ConditionClause[]. A workflow saved before this feature existed (or one
  // with no condition pill ever touched) has no such node, so this is `[]`,
  // which is exactly the "no condition" state serialize() must reproduce
  // byte-identically.
  const conditionNode = nodes.find((n) => n.type === 'condition');
  const rules = conditionNode?.conditions?.rules ?? [];
  const conditionClauses: ConditionClause[] = rules.map((r) => ({
    id: newConditionClauseId(),
    field: r.field ?? '',
    op: r.op ?? 'eq',
    value: Array.isArray(r.value) ? r.value.join(', ') : String(r.value ?? ''),
  }));

  return { triggerType, scheduleConfig, actions, conditionClauses };
}

// The Sentence Builder — replaces Wave 5's 3-panel shell entirely per
// docs/automation-hub/BUILDER_REDESIGN_V2_CONCEPT.md. One always-visible
// sentence ("When [trigger] on [scope] then [action], [action]...") is the
// spine; each blank opens a full-focus step-panel beneath it to fill in.
// No persistent palette/canvas/config-panel layout — see docs/automation-hub/
// TRACKER.md Wave 6 for why (direct stakeholder rejection of Wave 5's shell).
export function WorkflowBuilderPage() {
  const { t } = useTranslation();
  const api = useApi();
  const navigate = useNavigate();
  const location = useLocation();

  const state = (location.state as LocationState | null) ?? null;
  const workflowId = state?.workflowId;
  const isEditMode = Boolean(workflowId);

  useSetPageTitle(isEditMode ? t('workflows.builder.editTitle') : t('workflows.builder.title'));

  const [triggers, setTriggers] = useState<Trigger[]>([]);
  const [actionDefs, setActionDefs] = useState<ActionDef[]>([]);
  // Condition step (Wave 11, Rohan WAVE11_UX_SPECS.md §1.7) — reads the
  // registry's conditionFields/conditionOperators off the SAME
  // getWorkflowRegistry() call below (just destructuring two extra fields
  // already in flight); no second source of truth, mirrors what
  // WorkflowCanvasPage.tsx's ConditionNode already consumes.
  const [conditionFields, setConditionFields] = useState<ConditionField[]>([]);
  const [conditionOperators, setConditionOperators] = useState<string[]>([]);
  // Real per-org connector credential status (Kenji finding 1 / Maya 6c /
  // Rohan I-1) — reuses the same GET /api/workflow-credentials endpoint
  // IntegrationsSettingsPage.tsx already calls, so a disconnected org sees a
  // distinct readiness state on jira.create_issue/salesforce.*/servicenow.*/
  // zendesk.* instead of the static registry 'env' tier every org got before.
  const [credentialStatusByAction, setCredentialStatusByAction] = useState<Record<string, CredentialStatus>>({});

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [triggerType, setTriggerType] = useState<string | undefined>(undefined);
  const [scheduleConfig, setScheduleConfig] = useState<ScheduleConfigState | undefined>(undefined);
  const [scope, setScope] = useState<ScopeSelection>({ scopeType: 'org' });
  // Wave 11 (Rohan WAVE11_UX_SPECS.md §1.2) — starts `[]` for every new
  // workflow and for every existing workflow loaded via hydrateFromNodes that
  // has no condition node in its saved `nodes` array. This is the literal
  // mechanism of the zero-condition backward-compat contract: no condition
  // state -> serialize() pushes no condition node -> runNodes never calls
  // evaluateConditions -> behavior is byte-identical to pre-Wave-11.
  const [conditionClauses, setConditionClauses] = useState<ConditionClause[]>([]);
  const [actions, setActions] = useState<ActionState[]>([]);
  const [cooldownMinutes, setCooldownMinutes] = useState<number | null>(DEFAULT_COOLDOWN_MINUTES);
  // The status of the workflow as loaded from the server (edit mode only).
  // MUST be preserved on save — a routine edit (e.g. tweaking a Slack message)
  // must never silently disable an active workflow. Only ever 'draft' for a
  // brand-new workflow (create mode, where there's nothing to preserve).
  const [loadedStatus, setLoadedStatus] = useState<WorkflowStatus>('draft');
  // Concurrent-edit protection (Wave 11, Nina — TRACKER.md Wave 11 Part 2).
  // Set from the loaded workflow's `version` — EDIT MODE ONLY. A brand-new
  // workflow has no prior version to conflict with, so this stays `undefined`
  // in create mode and `version` is omitted entirely from the save payload,
  // matching the backend's optional-field contract exactly (omitting it
  // skips the conflict check, byte-identical to pre-Wave-11 behavior).
  const [version, setVersion] = useState<number | undefined>(undefined);
  // The server's current workflow snapshot from a 409 response body — shown
  // in the conflict dialog and used by "Reload latest".
  const [conflictWorkflow, setConflictWorkflow] = useState<{ nodes?: EngineNode[]; edges?: EngineEdge[]; version?: number } | null>(null);

  // `openStep` drives which step-panel is visible below the sentence.
  // `activeActionId` is set both while adding a brand-new action (so the
  // 'action' step-panel can render that action's own config form right under
  // the tile grid, matching concept §4/§6's "resolves in the same panel, no
  // extra screen") and while re-opening an existing action clause to edit it.
  const [openStep, setOpenStep] = useState<StepId>(null);
  const [activeActionId, setActiveActionId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [scopeAutoResetNotice, setScopeAutoResetNotice] = useState(false);
  // Confirm-before-switch warning (DEEP_AUDIT_FIX_SPECS.md Issue 3) — the
  // canvas has no scope/cooldown UI at all, so switching there with a
  // non-default scope or cooldown would silently drop them. Only shown when
  // one of those two is actually non-default; a default-everything workflow
  // switches straight through with no interruption.
  const [showCanvasSwitchWarning, setShowCanvasSwitchWarning] = useState(false);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [loadingWorkflow, setLoadingWorkflow] = useState(isEditMode);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const scopeDisabled = Boolean(triggerType && SCOPE_UNSUPPORTED_TRIGGER_TYPES.has(triggerType));

  // Wave 14 (docs/automation-hub/WAVE14_UNIFIED_BUILDER_SPEC.md §2/§3) — the
  // Crystal trigger icon opens the existing global CrystalPanel, scoped to
  // "we are operating on the Automation Hub builder" via the context wiring
  // below (mount/unmount lifecycle here; the draft-sync + hydrator-
  // registration effects live further down, after actionLabel() is defined).
  const { openCrystal, setBuilderContext, setBuilderDraft, setBuilderDraftHydrator } = useCrystalPanel();

  useEffect(() => {
    setBuilderContext({ kind: 'workflow_builder' });
    return () => {
      setBuilderContext(null);
      setBuilderDraft(null);
      setBuilderDraftHydrator(null);
    };
  }, [setBuilderContext, setBuilderDraft, setBuilderDraftHydrator]);

  // Registry load — also handles the cross-link seed shape from other builder
  // entry points (templates, Advanced: Branching Canvas hand-back).
  useEffect(() => {
    api.getWorkflowRegistry().then((r) => {
      setTriggers(r.triggers as Trigger[]);
      const actions = r.actions as ActionDef[];
      setActionDefs(actions);
      // Wave 11 — same response, two extra fields (see conditionFields/
      // conditionOperators state doc above). `?? []` covers registry mocks in
      // existing tests that predate this field.
      setConditionFields((r.conditionFields ?? []) as ConditionField[]);
      setConditionOperators(r.conditionOperators ?? []);
      // Fetch real per-org connector health once we know which actions exist,
      // and build a flat action -> status map so ActionStepPanelContent/
      // ActionTile don't need to know about connectors at all.
      api.listWorkflowCredentials().then((entries) => {
        const map: Record<string, CredentialStatus> = {};
        for (const a of actions) {
          if (!connectorForAction(a.action)) continue;
          const status = credentialStatusForAction(a.action, entries);
          if (status) map[a.action] = status;
        }
        setCredentialStatusByAction(map);
      }).catch(() => {});
      if (!isEditMode) {
        const seed = state?.seed;
        if (seed?.nodes) {
          // Template hand-off / full seed (Wave 9) — hydrate the whole sentence
          // (trigger AND actions), not just the trigger pill, using the same
          // parser edit-mode uses for GET /api/workflows/:id.
          setName(seed.name ?? '');
          setDescription(seed.description ?? '');
          const { triggerType: tType, scheduleConfig: sched, actions: seededActions, conditionClauses: seededConditions } = hydrateFromNodes(seed.nodes, seed.triggerType);
          if (tType) setTriggerType(tType);
          if (sched) setScheduleConfig(sched);
          setActions(seededActions);
          setConditionClauses(seededConditions);
        } else if (seed) {
          setName(seed.name ?? '');
          if (seed.triggerType) {
            setTriggerType(seed.triggerType);
            if (seed.triggerType === 'time.schedule') setScheduleConfig(defaultScheduleConfig());
          }
        }
      }
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  // Fetch-on-mount for edit mode.
  useEffect(() => {
    if (!workflowId) return;
    setLoadingWorkflow(true);
    setLoadError(null);
    setNotFound(false);
    api.getWorkflow(workflowId)
      .then(({ workflow }) => {
        setName(workflow.name);
        setDescription(workflow.description ?? '');
        const nodes = (workflow.nodes as EngineNode[] | undefined) ?? [];
        const { triggerType: tType, scheduleConfig: sched, actions: loadedActions, conditionClauses: loadedConditions } = hydrateFromNodes(nodes, workflow.trigger_type ?? undefined);
        if (tType) {
          setTriggerType(tType);
          if (sched) setScheduleConfig(sched);
        }
        setScope({
          scopeType: (workflow.scope_type as ScopeSelection['scopeType']) ?? 'org',
          scopeSurveyId: workflow.scope_survey_id ?? undefined,
          scopeTagId: workflow.scope_tag_id ?? undefined,
        });
        setActions(loadedActions);
        setConditionClauses(loadedConditions);
        setCooldownMinutes(workflow.cooldown_minutes ?? 60);
        setLoadedStatus(workflow.status);
        setVersion(workflow.version);
      })
      .catch((err) => {
        const status = (err as { response?: { status?: number } })?.response?.status;
        setNotFound(status === 404);
        setLoadError(t('workflows.builder.loadError'));
      })
      .finally(() => setLoadingWorkflow(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowId, api]);

  // Resolve survey/tag display names for edit-mode rehydration (list response
  // only has ids, not names) — best-effort, non-blocking.
  useEffect(() => {
    if (scope.scopeType === 'survey' && scope.scopeSurveyId && !scope.surveyName) {
      api.listSurveys({ limit: 100 }).then((res) => {
        const match = res.surveys.find((s) => s.id === scope.scopeSurveyId);
        if (match) setScope((prev) => ({ ...prev, surveyName: match.title }));
      }).catch(() => {});
    }
    if (scope.scopeType === 'tag' && scope.scopeTagId && !scope.tagName) {
      api.listTags({}).then((res) => {
        const match = res.tags.find((tg) => tg.id === scope.scopeTagId);
        if (match) setScope((prev) => ({ ...prev, tagName: match.name, tagSurveyCount: match.survey_count ?? 0 }));
      }).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope.scopeType, scope.scopeSurveyId, scope.scopeTagId, api]);

  // Auto-reset scope to org if the user switches to a scope-unsupported
  // trigger after already picking survey/tag scope (concept §5 CRITICAL rule):
  // never allow the sentence to reach Save with an invalid trigger/scope pair.
  useEffect(() => {
    if (scopeDisabled && scope.scopeType !== 'org') {
      setScope({ scopeType: 'org' });
      setScopeAutoResetNotice(true);
      const timer = setTimeout(() => setScopeAutoResetNotice(false), 5000);
      return () => clearTimeout(timer);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeDisabled]);

  function selectTrigger(newType: string) {
    setTriggerType(newType);
    if (newType === 'time.schedule' && !scheduleConfig) {
      setScheduleConfig(defaultScheduleConfig());
    }
  }

  function openAddActionStep() {
    setActiveActionId(null);
    setOpenStep('action');
  }

  function openEditActionStep(id: string) {
    setActiveActionId(id);
    setOpenStep('action');
  }

  // Called from the action tile grid — creates the action immediately (so its
  // config form appears in the same panel, per concept §4) rather than
  // waiting for a second confirm step.
  function selectActionForActive(action: string) {
    if (activeActionId) {
      updateActionField(activeActionId, { action });
      return;
    }
    const id = newActionId();
    setActions((prev) => [...prev, { id, action, contentConfig: defaultActionContentConfig(), simpleConfig: {} }]);
    setActiveActionId(id);
  }

  function updateActionField(id: string, patch: Partial<ActionState>) {
    setActions((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  }

  function removeAction(id: string) {
    setActions((prev) => prev.filter((a) => a.id !== id));
  }

  function closeActionStep() {
    setOpenStep(null);
    setActiveActionId(null);
  }

  const triggerLabel = (typeKey: string) => triggers.find((tr) => tr.type === typeKey)?.label ?? typeKey;
  const actionLabel = (typeKey: string) => actionDefs.find((a) => a.action === typeKey)?.label ?? typeKey;

  const triggerPillLabel = useMemo(() => {
    if (!triggerType) return t('workflows.builder.sentence.pill.pickTrigger');
    if (triggerType === 'time.schedule' && scheduleConfig) {
      const desc = buildScheduleDescription(scheduleConfig);
      return desc.charAt(0).toUpperCase() + desc.slice(1);
    }
    return triggerLabel(triggerType);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [triggerType, scheduleConfig, triggers, t]);

  const scopePillLabel = useMemo(() => {
    if (scope.scopeType === 'survey') return t('workflows.builder.sentence.pill.scopeSurvey', { name: scope.surveyName ?? '…' });
    if (scope.scopeType === 'tag') return t('workflows.builder.sentence.pill.scopeTag', { name: scope.tagName ?? '…' });
    return t('workflows.builder.sentence.pill.scopeOrg');
  }, [scope, t]);

  // Compact symbolic rendering for the 6 comparison ops; label-key text for
  // contains/not_contains/in/not_in, which don't have a clean symbol (Wave
  // 11, Rohan WAVE11_UX_SPECS.md §1.5).
  const CONDITION_OP_SYMBOL: Record<string, string> = { eq: '=', neq: '≠', gt: '>', lt: '<', gte: '≥', lte: '≤' };
  const OPERATOR_LABEL_KEYS: Record<string, string> = {
    eq: 'workflows.builder.sentence.condition.op.eq', neq: 'workflows.builder.sentence.condition.op.neq',
    gt: 'workflows.builder.sentence.condition.op.gt', lt: 'workflows.builder.sentence.condition.op.lt',
    gte: 'workflows.builder.sentence.condition.op.gte', lte: 'workflows.builder.sentence.condition.op.lte',
    contains: 'workflows.builder.sentence.condition.op.contains', not_contains: 'workflows.builder.sentence.condition.op.notContains',
    in: 'workflows.builder.sentence.condition.op.in', not_in: 'workflows.builder.sentence.condition.op.notIn',
  };

  const conditionPillLabel = useMemo(() => {
    if (conditionClauses.length === 0) return t('workflows.builder.sentence.pill.pickCondition');
    if (conditionClauses.length === 1) {
      const c = conditionClauses[0];
      const fieldLabel = conditionFields.find((f) => f.field === c.field)?.label ?? c.field;
      const symbol = CONDITION_OP_SYMBOL[c.op] ?? t(OPERATOR_LABEL_KEYS[c.op] ?? '');
      return `${fieldLabel} ${symbol} ${c.value}`;
    }
    // Filled, 2+ conditions: collapse to a count summary (Wave 11 §1.5) — full
    // detail is only in the step-panel, matching how action pills already work.
    return t('workflows.builder.sentence.pill.conditionCount', { count: conditionClauses.length });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conditionClauses, conditionFields, t]);

  // Wave 11 (Rohan WAVE11_UX_SPECS.md §2.3) — ActionClause gains `category` so
  // SortableClause (ActionClauseList.tsx) can branch on it without a second
  // registry lookup inside the list component.
  const actionClauses: ActionClause[] = actions.map((a) => ({
    id: a.id, action: a.action, label: actionLabel(a.action),
    category: actionDefs.find((d) => d.action === a.action)?.category,
  }));
  const activeAction = actions.find((a) => a.id === activeActionId);

  // Wave 14 (WAVE14_UNIFIED_BUILDER_SPEC.md §3.3) — every relevant state
  // change keeps Crystal's view of the draft current. Reuses the same
  // display strings already computed for the sentence's own pills
  // (triggerPillLabel/actionLabel()/scopePillLabel above) rather than
  // re-deriving a second summary.
  useEffect(() => {
    setBuilderDraft({
      mode: 'sentence',
      triggerType,
      scopeSelection: scope,
      conditionClauses: conditionClauses.map((c) => ({ field: c.field, op: c.op, value: c.value })),
      actions: actions.map((a) => ({ action: a.action, label: actionLabel(a.action) })),
      workflowName: name,
      isEditMode,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [triggerType, scope, conditionClauses, actions, name, isEditMode, setBuilderDraft]);

  // Wave 14 §4.3 — applies a Crystal `create_workflow` proposal to THIS page's
  // own local state, reusing hydrateFromNodes() (the exact same parser already
  // used for edit-mode fetch and template hand-off) — no new graph-parsing
  // logic. Returns `false` for any proposal shape this page doesn't recognize
  // (e.g. the legacy flat trigger/action_type shape) so CrystalPanel's
  // executeAction can safely fall back to its existing persist path.
  //
  // Deliberately does NOT touch `scope` unless the proposal explicitly carries
  // a scope hint — out of scope for this wave (see spec §5); today's
  // hydrateFromNodes()/hydration payload carries no scope hint at all, so this
  // is naturally already true by construction, not by an added guard.
  const hydrateFromProposal = useCallback((proposal: ActionProposal): boolean => {
    const nodes = proposal.params.nodes as EngineNode[] | undefined;
    const edges = proposal.params.edges as EngineEdge[] | undefined;
    if (!Array.isArray(nodes) || !Array.isArray(edges)) return false;  // unrecognized shape — let the panel fall back

    const { triggerType: tType, scheduleConfig: sched, actions: newActions, conditionClauses: newConditions } =
      hydrateFromNodes(nodes, proposal.params.trigger_type as string | undefined);
    if (tType) {
      setTriggerType(tType);
      if (sched) setScheduleConfig(sched);
    }
    setActions(newActions);
    setConditionClauses(newConditions);
    if (!name.trim() && (proposal.params.name || proposal.title)) {
      setName((proposal.params.name as string) || proposal.title);
    }
    return true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  // Register the hydration callback once it's stable — see CrystalPanel.tsx's
  // executeAction for why the panel checks for the callback's existence
  // rather than a scope label.
  useEffect(() => {
    setBuilderDraftHydrator(hydrateFromProposal);
    return () => setBuilderDraftHydrator(null);
  }, [hydrateFromProposal, setBuilderDraftHydrator]);

  // Wave 11 (Rohan WAVE11_UX_SPECS.md §2.3) — a one-time static caption shown
  // under the sentence only once any Flow-category action (approval/stop/
  // delay) is present, telling the customer that array order is now
  // execution-meaningful. Invisible for the common case (no Flow action).
  const hasFlowAction = actions.some((a) => actionDefs.find((d) => d.action === a.action)?.category === 'Flow');

  const hasActions = actions.length > 0;
  // Condition must NOT be added to canSave — it's the first pill in this
  // sentence that is explicitly optional (Wave 11 §1.5).
  const canSave = Boolean(name.trim() && triggerType && hasActions);
  const saveDisabledReason = !name.trim()
    ? t('workflows.builder.sentence.saveReason.name')
    : !triggerType
      ? t('workflows.builder.sentence.saveReason.trigger')
      : !hasActions
        ? t('workflows.builder.sentence.saveReason.action')
        : null;

  function buildTriggerNodeConfig(): Record<string, unknown> {
    if (triggerType === 'time.schedule' && scheduleConfig) {
      return { cron: buildCronFromConfig(scheduleConfig), scheduleUiState: scheduleConfig };
    }
    return {};
  }

  // flow.delay (Wave 11, Rohan WAVE11_UX_SPECS.md §2.1) — converts the UI's
  // friendly amount/unit into the engine's `delay_minutes` wire field only at
  // serialize time (same `scheduleUiState`/`cron` round-trip precedent
  // time.schedule already uses). `delayUiState` is persisted alongside so
  // hydrateFromNodes() can restore the exact friendly value on re-edit.
  function buildDelayNodeConfig(ui: DelayConfigState): Record<string, unknown> {
    const unitToMinutes: Record<DelayConfigState['unit'], number> = { minutes: 1, hours: 60, days: 1440 };
    return { delay_minutes: Math.round(ui.amount * unitToMinutes[ui.unit]), delayUiState: ui };
  }

  // Coerces a condition clause's string UI value into the shape
  // evaluateConditions expects: a Number for number-kind fields, a
  // comma-separated trimmed string array for in/not_in (regardless of kind —
  // Wave 11 §1.3a's scoping call), the raw string otherwise.
  function coerceConditionValue(clause: ConditionClause): unknown {
    if (clause.op === 'in' || clause.op === 'not_in') {
      return clause.value.split(',').map((v) => v.trim()).filter(Boolean);
    }
    if (fieldKindFor(conditionFields, clause.field) === 'number') {
      return Number(clause.value);
    }
    return clause.value;
  }

  // Explicit return type (DEEP_AUDIT_FIX_SPECS.md Issue 3) — formalizes what
  // was already structurally true: this output is EngineNode[]/EngineEdge[]
  // compatible, the exact shape switchToCanvas()'s create-mode branch hands to
  // WorkflowCanvasPage's seed-consumption branch.
  function serialize(): { nodes: EngineNode[]; edges: EngineEdge[] } {
    const nodes: EngineNode[] = [];
    if (triggerType) {
      const cfg = buildTriggerNodeConfig();
      nodes.push({ id: 'trigger', type: 'trigger', trigger: triggerType, ...(Object.keys(cfg).length ? { config: cfg } : {}) });
    }
    // Condition step (Wave 11, Rohan WAVE11_UX_SPECS.md §1.2/§1.4) — CRITICAL
    // backward-compatibility contract: only push a condition node when
    // conditionClauses.length > 0. When it's empty (every workflow saved
    // before this feature existed, and any new workflow that never touches
    // the condition step), this must produce ZERO condition nodes — byte
    // identical to serialize()'s pre-Wave-11 output. Inserted right after the
    // trigger node, before the first action node, matching the engine's own
    // execution order (runNodes evaluates the condition immediately after the
    // trigger, before actions). Multiple clauses collapse into ONE condition
    // node with `rules: [...]` (never multiple condition nodes), and the
    // sentence builder only ever writes the implicit AND operator — no OR
    // toggle this wave.
    if (conditionClauses.length > 0) {
      nodes.push({
        id: 'condition',
        type: 'condition',
        conditions: {
          operator: 'AND',
          rules: conditionClauses.map((c) => ({ field: c.field, op: c.op, value: coerceConditionValue(c) })),
        },
      });
    }
    actions.forEach((a, i) => {
      // notify.in_app isn't a CONTENT_PRODUCING_ACTION (no sections/preset/
      // subject — see ActionStepPanelContent.tsx) but Wave 9 gives it the same
      // recipient-targeting picker as notify.email, backed by the same
      // `contentConfig.target` field for storage convenience. Persist only the
      // flattened targeting fields for it — not the full contentConfig shape,
      // which would otherwise leak an irrelevant `sections`/`preset` into its
      // saved config.
      //
      // `target` is a frontend-only nested convenience field — Nina's backend
      // contract wants the targeting id fields FLAT on the action config
      // (`{ targetType, userIds/roleId/departmentId/groupId, ...rest }`), so
      // flattenNotifyTarget() spreads it in and `target` itself is stripped
      // before this reaches POST/PUT /api/workflows.
      let config: Record<string, unknown>;
      if (CONTENT_PRODUCING_ACTIONS.has(a.action)) {
        const { target, ...rest } = a.contentConfig as unknown as Record<string, unknown> & { target?: ActionContentConfig['target'] };
        config = { ...rest, ...flattenNotifyTarget(target) };
      } else if (a.action === 'notify.in_app') {
        config = flattenNotifyTarget(a.contentConfig.target);
      } else if (a.action === DELAY_ACTION) {
        const delayUiState = (a.simpleConfig as { delayUiState?: DelayConfigState }).delayUiState ?? defaultDelayConfig();
        config = buildDelayNodeConfig(delayUiState);
      } else {
        config = a.simpleConfig;
      }
      nodes.push({ id: `action_${i}`, type: 'action', action: a.action, config });
    });
    const edges = nodes.slice(1).map((n, i) => ({ from: nodes[i].id, to: n.id }));
    return { nodes, edges };
  }

  // Concurrent-edit protection (Wave 11, Nina — TRACKER.md Wave 11 Part 2).
  // `forceOverwrite` is the "Overwrite anyway" path: re-submits the exact
  // same PUT with `version` omitted entirely, which the backend contract
  // makes a force-save (routes/workflows.ts: an absent `version` skips the
  // conflict check unconditionally, regardless of what's actually stored).
  async function save(forceOverwrite = false) {
    if (!canSave || !triggerType) {
      setError(t('workflows.builder.incomplete'));
      return;
    }
    setSaving(true); setError(null);
    const { nodes, edges } = serialize();
    const payload = {
      // Preserve the loaded workflow's status on edit — a routine edit must
      // never silently disable an active workflow. `loadedStatus` defaults to
      // 'draft', which is correct for create mode (nothing to preserve yet).
      name, description, triggerType, nodes, edges, status: loadedStatus,
      cooldown_minutes: triggerType === 'time.schedule' ? null : cooldownMinutes,
      scopeType: scope.scopeType,
      ...(scope.scopeType === 'survey' && scope.scopeSurveyId ? { scopeSurveyId: scope.scopeSurveyId } : {}),
      ...(scope.scopeType === 'tag' && scope.scopeTagId ? { scopeTagId: scope.scopeTagId } : {}),
      // Edit mode + not forcing an overwrite: send the last-known version so
      // the backend can detect a conflict. Create mode never sends `version`
      // at all (nothing to conflict with) — matches the backend's optional-
      // field contract exactly.
      ...(isEditMode && !forceOverwrite ? { version } : {}),
    };
    try {
      if (isEditMode) {
        const result = await api.updateWorkflow(workflowId!, payload);
        setVersion(result.version);
      } else {
        await api.createGraphWorkflow(payload);
      }
      invalidate('workflows');
      navigate(ROUTES.WORKFLOWS);
    } catch (err) {
      if (err instanceof WorkflowConflictError && err.isConflict) {
        setConflictWorkflow({
          nodes: err.serverWorkflow?.nodes as EngineNode[] | undefined,
          edges: err.serverWorkflow?.edges as EngineEdge[] | undefined,
          version: err.serverWorkflow?.version,
        });
        setError(null);
        return;
      }
      setError(err instanceof Error ? err.message : t('workflows.builder.saveError'));
    } finally { setSaving(false); }
  }

  // "Reload latest" — discards local edits and re-fetches the workflow fresh
  // from the server (the same effect edit-mode's initial mount already runs).
  async function reloadLatest() {
    setConflictWorkflow(null);
    if (!workflowId) return;
    setLoadingWorkflow(true);
    try {
      const { workflow } = await api.getWorkflow(workflowId);
      setName(workflow.name);
      setDescription(workflow.description ?? '');
      const nodes = (workflow.nodes as EngineNode[] | undefined) ?? [];
      const { triggerType: tType, scheduleConfig: sched, actions: loadedActions, conditionClauses: loadedConditions } = hydrateFromNodes(nodes, workflow.trigger_type ?? undefined);
      if (tType) {
        setTriggerType(tType);
        if (sched) setScheduleConfig(sched);
      }
      setScope({
        scopeType: (workflow.scope_type as ScopeSelection['scopeType']) ?? 'org',
        scopeSurveyId: workflow.scope_survey_id ?? undefined,
        scopeTagId: workflow.scope_tag_id ?? undefined,
      });
      setActions(loadedActions);
      setConditionClauses(loadedConditions);
      setCooldownMinutes(workflow.cooldown_minutes ?? 60);
      setLoadedStatus(workflow.status);
      setVersion(workflow.version);
    } catch {
      setError(t('workflows.builder.loadError'));
    } finally {
      setLoadingWorkflow(false);
    }
  }

  function overwriteAnyway() {
    setConflictWorkflow(null);
    save(true);
  }

  // DEEP_AUDIT_FIX_SPECS.md Issue 3 — the create-mode branch used to send only
  // `{ name, triggerType }` as the canvas seed, silently dropping every
  // already-configured action (and scope/cooldown) the user had built in the
  // sentence builder. `serialize()`'s `{ nodes, edges }` output is already the
  // exact EngineNode[]/EngineEdge[] shape WorkflowCanvasPage's
  // `seed?.nodes || seed?.edges` branch consumes today (the same path
  // templates/the NL builder already use) — no adapter needed.
  function switchToCanvas() {
    if (isEditMode) {
      navigate(ROUTES.WORKFLOW_CANVAS, { state: { workflowId } });
      return;
    }
    const hasNonDefaultScope = scope.scopeType !== 'org';
    const hasNonDefaultCooldown = cooldownMinutes !== DEFAULT_COOLDOWN_MINUTES;
    if (hasNonDefaultScope || hasNonDefaultCooldown) {
      setShowCanvasSwitchWarning(true);
      return;
    }
    proceedToCanvas();
  }

  function proceedToCanvas() {
    const { nodes, edges } = serialize();
    navigate(ROUTES.WORKFLOW_CANVAS, {
      state: { seed: { name, description, triggerType, nodes, edges } },
    });
  }

  if (loadingWorkflow) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="w-8 h-8 rounded-full border-2 border-t-transparent animate-spin border-primary" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex items-center justify-center h-full p-8">
        <div className="max-w-md text-center">
          <Icon name="error_outline" size={32} className="text-error mx-auto mb-3" />
          <h3 className="font-semibold text-on-surface mb-1">{t('workflows.builder.notFoundHeading')}</h3>
          <p className="text-sm text-on-surface-variant mb-4">
            {notFound ? t('workflows.builder.notFoundBody') : t('workflows.builder.loadErrorBody')}
          </p>
          <Button variant="outline" onClick={() => navigate(ROUTES.WORKFLOWS)}>{t('workflows.builder.backToList')}</Button>
        </div>
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={200}>
      <div className="pt-6 md:pt-8" data-testid="sentence-builder">
        {/* Sentence container — max-w-4xl, generous top padding, deliberately
            narrower than the step-panel below (BUILDER_REDESIGN_V2_CONCEPT.md §7). */}
        <div className="max-w-4xl mx-auto w-full">
          <div className="flex items-center gap-3 mb-6 flex-wrap">
            <button type="button" aria-label={t('workflows.builder.sentence.backAria')} onClick={() => navigate(ROUTES.WORKFLOWS)} className="p-1.5 rounded-lg hover:bg-accent">
              <Icon name="arrow_back" size={18} />
            </button>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('workflows.builder.unified.newAutomationPlaceholder')}
              className="max-w-xs font-semibold border-transparent hover:border-border focus:border-border"
            />
            <div className="flex-1" />
            <Button variant="ghost" size="icon" aria-label={t('workflows.builder.sentence.settingsAria')} onClick={() => setSettingsOpen(true)}>
              <Icon name="settings" size={18} />
            </Button>
            <Button variant="link" size="sm" onClick={switchToCanvas}>
              {t('workflows.builder.unified.palette.advancedCanvas')}
            </Button>
            {error && <p className="text-sm text-destructive">{error}</p>}
            {!error && saveDisabledReason && (
              // S-2 (DEEP_AUDIT_UX_FINDINGS.md §8) — this reason text used to be
              // `hidden md:block`, so a mobile user saw a disabled Save button
              // with zero explanation of why. Visible at every breakpoint now.
              <p className="text-xs text-on-surface-variant w-full md:w-auto" data-testid="save-disabled-reason">{saveDisabledReason}</p>
            )}
            <Button onClick={() => save()} disabled={saving || !canSave}>
              {saving ? t('common.saving') : (isEditMode ? t('workflows.builder.unified.saveChanges') : t('workflows.builder.unified.save'))}
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-x-2 gap-y-3 text-lg" data-testid="workflow-sentence">
            <span className="text-on-surface-variant font-medium">{t('workflows.builder.sentence.when')}</span>
            <SentencePill
              testId="pill-trigger"
              state={triggerType ? 'filled' : 'empty'}
              label={triggerPillLabel}
              onClick={() => setOpenStep('trigger')}
              disabled={openStep !== null && openStep !== 'trigger'}
            />
            <span className="text-on-surface-variant font-medium">{t('workflows.builder.sentence.on')}</span>
            <SentencePill
              testId="pill-scope"
              state="filled"
              label={scopePillLabel}
              onClick={() => setOpenStep('scope')}
              disabled={openStep !== null && openStep !== 'scope'}
            />
            {/* Condition step (Wave 11, Rohan WAVE11_UX_SPECS.md §1.5) — always
                rendered (not conditionally hidden based on state), matching the
                scope pill's own "always-visible spine" precedent. The "if" word
                and pill are self-evidently skippable via the "(optional)" suffix
                on the empty-state label, not a required blank. */}
            <span className="text-on-surface-variant font-medium">{t('workflows.builder.sentence.if')}</span>
            <SentencePill
              testId="pill-condition"
              state={conditionClauses.length === 0 ? 'empty' : 'condition'}
              icon="filter_alt"
              label={conditionPillLabel}
              onClick={() => setOpenStep('condition')}
              disabled={openStep !== null && openStep !== 'condition'}
            />
            <span className="text-on-surface-variant font-medium">{t('workflows.builder.sentence.then')}</span>
            {actions.length === 0 ? (
              <SentencePill
                testId="pill-add-action"
                state="empty"
                label={t('workflows.builder.sentence.pill.addAction')}
                onClick={openAddActionStep}
                disabled={openStep !== null && openStep !== 'action'}
              />
            ) : (
              <>
                <ActionClauseList
                  clauses={actionClauses}
                  onReorder={(next) => setActions((prev) => next.map((c) => prev.find((a) => a.id === c.id)!))}
                  onRemove={removeAction}
                  onEdit={openEditActionStep}
                />
                <button
                  type="button"
                  data-testid="pill-add-another-action"
                  onClick={openAddActionStep}
                  disabled={openStep !== null && openStep !== 'action'}
                  className="text-sm font-semibold text-primary hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {t('workflows.builder.sentence.pill.addAnotherAction')}
                </button>
              </>
            )}
          </div>

          <p className="text-sm text-on-surface-variant mt-3">{t('workflows.builder.sentence.helperText')}</p>

          {/* Wave 11 (Rohan WAVE11_UX_SPECS.md §2.3) — a fixed, one-time
              caption, not a per-position computed narrative — shown only once
              any Flow-category action (approval/stop/delay) exists in the
              sentence, so it's invisible for the common case. */}
          {hasFlowAction && (
            <p className="text-xs text-on-surface-variant mt-1" data-testid="flow-order-hint">
              {t('workflows.builder.sentence.actionClause.flowOrderHint')}
            </p>
          )}

          {scopeAutoResetNotice && (
            <p className="text-xs text-warning mt-2 flex items-center gap-1" data-testid="scope-auto-reset-notice">
              <Icon name="info" size={13} />{t('workflows.builder.sentence.scope.autoResetNotice')}
            </p>
          )}
        </div>

        {/* Step-panel container — max-w-7xl per app/CLAUDE.md's page-pattern
            convention, wider than the sentence above it. */}
        <div className="max-w-7xl mx-auto w-full mt-6">
          <StepPanel
            testId="step-panel-trigger"
            open={openStep === 'trigger'}
            label={t('workflows.builder.sentence.stepPanel.triggerLabel')}
            onCancel={() => setOpenStep(null)}
            onDone={() => setOpenStep(null)}
            doneDisabled={!triggerType}
          >
            <TriggerStepPanelContent
              triggers={triggers}
              selectedType={triggerType}
              onSelect={selectTrigger}
              scheduleConfig={scheduleConfig}
              onScheduleChange={setScheduleConfig}
            />
          </StepPanel>

          <StepPanel
            testId="step-panel-scope"
            open={openStep === 'scope'}
            label={t('workflows.builder.sentence.stepPanel.scopeLabel')}
            onCancel={() => setOpenStep(null)}
            onDone={() => setOpenStep(null)}
          >
            <ScopeStepPanelContent value={scope} onChange={setScope} scopeDisabled={scopeDisabled} />
          </StepPanel>

          <StepPanel
            testId="step-panel-condition"
            open={openStep === 'condition'}
            label={t('workflows.builder.sentence.stepPanel.conditionLabel')}
            onCancel={() => setOpenStep(null)}
            onDone={() => setOpenStep(null)}
          >
            <ConditionStepPanelContent
              fields={conditionFields}
              operators={conditionOperators}
              clauses={conditionClauses}
              onChange={setConditionClauses}
            />
          </StepPanel>

          <StepPanel
            testId="step-panel-action"
            open={openStep === 'action'}
            label={activeAction
              ? t('workflows.builder.sentence.stepPanel.editActionLabel', { label: actionLabel(activeAction.action) })
              : t('workflows.builder.sentence.stepPanel.actionLabel')}
            onCancel={closeActionStep}
            onDone={closeActionStep}
            doneDisabled={!activeAction}
          >
            <ActionStepPanelContent
              actions={actionDefs as unknown as Array<{ action: string; label: string; category: string; live: boolean | 'stub' | 'env' }>}
              selectedAction={activeAction?.action}
              onSelect={selectActionForActive}
              contentConfig={activeAction?.contentConfig ?? defaultActionContentConfig()}
              onContentConfigChange={(cfg) => activeActionId && updateActionField(activeActionId, { contentConfig: cfg })}
              simpleConfig={activeAction?.simpleConfig ?? {}}
              onSimpleConfigChange={(cfg) => activeActionId && updateActionField(activeActionId, { simpleConfig: cfg })}
              credentialStatusByAction={credentialStatusByAction}
            />
          </StepPanel>
        </div>

        <Sheet open={settingsOpen} onOpenChange={setSettingsOpen}>
          <SheetContent>
            <SheetHeader>
              <SheetTitle>{t('workflows.builder.unified.settings.heading')}</SheetTitle>
            </SheetHeader>
            <div className="mt-4">
              <WorkflowSettingsPanel cooldownMinutes={cooldownMinutes} onChange={setCooldownMinutes} triggerType={triggerType} />
            </div>
          </SheetContent>
        </Sheet>

        {/* Canvas switch warning (DEEP_AUDIT_FIX_SPECS.md Issue 3) — only
            shown when scope/cooldown are non-default, since the canvas has
            nowhere to carry them. Matches the existing Delete-confirmation
            Dialog pattern (WorkflowsPage.tsx) — no new modal interaction
            pattern introduced. */}
        <Dialog open={showCanvasSwitchWarning} onOpenChange={setShowCanvasSwitchWarning}>
          <DialogContent className="w-full max-w-sm">
            <DialogHeader>
              <DialogTitle>{t('workflows.builder.sentence.canvasSwitchWarning.title')}</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-on-surface-variant">
              {t('workflows.builder.sentence.canvasSwitchWarning.body')}
            </p>
            <DialogFooter className="flex gap-3 mt-2">
              <Button variant="secondary" className="flex-1" onClick={() => setShowCanvasSwitchWarning(false)}>
                {t('workflows.builder.sentence.stepPanel.cancel')}
              </Button>
              <Button
                className="flex-1"
                onClick={() => { setShowCanvasSwitchWarning(false); proceedToCanvas(); }}
              >
                {t('workflows.builder.sentence.canvasSwitchWarning.continue')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Concurrent-edit conflict (Wave 11, Nina — TRACKER.md Wave 11 Part 2).
            Matches the existing Delete-confirmation Dialog pattern
            (WorkflowsPage.tsx) / the canvas-switch warning above — no new
            modal interaction pattern introduced. "Reload latest" discards
            local edits and re-fetches; "Overwrite anyway" re-submits the same
            PUT with `version` omitted, which the backend contract makes a
            force-save. */}
        <Dialog open={conflictWorkflow != null} onOpenChange={(open) => { if (!open) setConflictWorkflow(null); }}>
          <DialogContent className="w-full max-w-sm">
            <DialogHeader>
              <DialogTitle>{t('workflows.builder.sentence.conflictDialog.title')}</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-on-surface-variant">
              {t('workflows.builder.sentence.conflictDialog.body')}
            </p>
            <DialogFooter className="flex gap-3 mt-2">
              <Button variant="secondary" className="flex-1" onClick={reloadLatest} data-testid="conflict-reload">
                {t('workflows.builder.sentence.conflictDialog.reload')}
              </Button>
              <Button className="flex-1" onClick={overwriteAnyway} data-testid="conflict-overwrite">
                {t('workflows.builder.sentence.conflictDialog.overwrite')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Wave 14 (WAVE14_UNIFIED_BUILDER_SPEC.md §2) — pure trigger for the
            existing global CrystalPanel, no new chat surface. */}
        <AskCrystalFab onOpen={() => openCrystal()} />
      </div>
    </TooltipProvider>
  );
}
