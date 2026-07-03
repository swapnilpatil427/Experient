import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import ReactFlow, {
  Background, Controls, MiniMap, addEdge, useNodesState, useEdgesState,
  Handle, Position, type Node, type Edge, type Connection, type NodeProps,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { useTranslation } from '../lib/i18n';
import { useSetPageTitle } from '../contexts/pageTitle';
import { useApi } from '../hooks/useApi';
import { useBreakpoint } from '../hooks/useBreakpoint';
import { invalidate } from '../lib/dataBus';
import { PageHeader } from '../components/PageHeader';
import { Icon } from '../components/Icon';
import { ROUTES } from '../constants/routes';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import {
  serializeCanvas, deserializeCanvas, triggerTypeOf, isActionConfigured,
  type CanvasNodeData, type EngineNode, type EngineEdge,
} from '../lib/workflowCanvas';
import { ActionConfigPanel } from '../components/workflow-builder/canvas/ActionConfigPanel';
import { extractNotifyTarget } from '../components/workflow-builder/sentence/contentSections';
import { useCrystalPanel } from '../contexts/crystalPanel';
import { AskCrystalFab } from '../components/workflow-builder/AskCrystalFab';
import type { WorkflowStatus, ActionProposal } from '../types';
import { WorkflowConflictError } from '../lib/api';

interface Trigger { type: string; label: string; category: string }
interface ActionDef { action: string; label: string; category: string; live: boolean | string }
interface Rule { field: string; op: string; value: string }
// Registry's declared condition fields (backend/src/lib/workflowRegistry.ts's
// CONDITION_FIELDS, exposed via GET /api/workflows/registry's `conditionFields`
// — same endpoint triggers/actions already come from). Used to render
// ConditionNode's field picker as a dropdown instead of raw free text (Maya
// DEEP_AUDIT_PM_FINDINGS.md 2d) — a typo'd field key used to resolve to
// `undefined` forever with zero validation error. This is a partial,
// frontend-only fix: it stops NEW typos from being entered, but does not
// validate already-saved bad data — that's a separate backend fix
// (evaluateConditions), explicitly out of scope here.
interface ConditionField { field: string; label: string; kind: 'number' | 'string' }

// Full seed shape — covers both the linear builder's partial cross-link (§1.5,
// only ever has name/triggerType/rules) and the NL builder's full handoff
// (§2.4, has name/description/triggerType/nodes/edges). A seed with nodes/edges
// present is treated as equivalent to an edit-mode fetch result.
interface CanvasSeed {
  name?: string;
  description?: string;
  triggerType?: string;
  rules?: Rule[];
  nodes?: EngineNode[];
  edges?: EngineEdge[];
}

interface LocationState {
  workflowId?: string;
  seed?: CanvasSeed;
}

// Free-form branching workflow canvas. Drag nodes, connect them, and fan a
// condition out into true/false branches — the engine runs these in graph mode.
export function WorkflowCanvasPage() {
  const { t } = useTranslation();
  const api = useApi();
  const navigate = useNavigate();
  const location = useLocation();

  const state = (location.state as LocationState | null) ?? null;
  const workflowId = state?.workflowId;
  const seed = state?.seed;
  const isEditMode = Boolean(workflowId);

  useSetPageTitle(t('workflows.canvas.title'));
  // C-3 (DEEP_AUDIT_UX_FINDINGS.md §7/§8) — the canvas builder's drag/zoom/
  // connect interactions are pointer-and-precision shaped; a full touch-gesture
  // ReactFlow rework is explicitly out of scope this wave. Pragmatic fix only:
  // fluid (not fixed-width) header inputs + an advisory banner below tablet.
  const breakpoint = useBreakpoint();
  const isCompact = breakpoint !== 'desktop';

  const [triggers, setTriggers] = useState<Trigger[]>([]);
  const [actionDefs, setActionDefs] = useState<ActionDef[]>([]);
  const [operators, setOperators] = useState<string[]>([]);
  const [conditionFields, setConditionFields] = useState<ConditionField[]>([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [loadingWorkflow, setLoadingWorkflow] = useState(isEditMode);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  // The status of the workflow as loaded from the server (edit mode only) —
  // MUST be preserved on save so a routine edit never silently disables an
  // active workflow. Defaults to 'draft', correct for create mode.
  const [loadedStatus, setLoadedStatus] = useState<WorkflowStatus>('draft');
  // Concurrent-edit protection (Wave 11, Nina — TRACKER.md Wave 11 Part 2).
  // Same contract as WorkflowBuilderPage.tsx: edit-mode-only version tracking,
  // omitted entirely in create mode (nothing to conflict with).
  const [version, setVersion] = useState<number | undefined>(undefined);
  const [conflictOpen, setConflictOpen] = useState(false);

  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNodeData>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  // Which action node's ActionConfigPanel is currently open, if any
  // (DEEP_AUDIT_FIX_SPECS.md Issue 1).
  const [configuringNodeId, setConfiguringNodeId] = useState<string | null>(null);

  // Patch a node's data field (used by the inline selects inside each node).
  const patchNode = useCallback((id: string, patch: Partial<CanvasNodeData>) => {
    setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)));
  }, [setNodes]);

  // Opens ActionConfigPanel for the given action node (DEEP_AUDIT_FIX_SPECS.md
  // Issue 1) — passed down the same way `patch` already is, via node data.
  const openConfigPanel = useCallback((id: string) => setConfiguringNodeId(id), []);

  // Wave 14 (docs/automation-hub/WAVE14_UNIFIED_BUILDER_SPEC.md §2/§3) — the
  // Crystal trigger icon opens the existing global CrystalPanel, scoped to
  // "we are operating on the Automation Hub builder" via the context wiring
  // below. Mirrors WorkflowBuilderPage.tsx's wiring exactly.
  const { openCrystal, setBuilderContext, setBuilderDraft, setBuilderDraftHydrator } = useCrystalPanel();

  useEffect(() => {
    setBuilderContext({ kind: 'workflow_builder' });
    return () => {
      setBuilderContext(null);
      setBuilderDraft(null);
      setBuilderDraftHydrator(null);
    };
  }, [setBuilderContext, setBuilderDraft, setBuilderDraftHydrator]);

  // Every relevant state change — keep Crystal's view of the draft current.
  // The canvas has no scope UI (see the canvas-switch warning in
  // WorkflowBuilderPage.tsx), so scopeSelection is always org-wide here.
  useEffect(() => {
    const triggerType = triggerTypeOf(nodes as Node<CanvasNodeData>[]);
    const actionNodes = (nodes as Node<CanvasNodeData>[]).filter((n) => n.data.kind === 'action');
    setBuilderDraft({
      mode: 'canvas',
      triggerType,
      scopeSelection: { scopeType: 'org' },
      conditionClauses: (nodes as Node<CanvasNodeData>[])
        .filter((n) => n.data.kind === 'condition')
        .map((n) => ({ field: n.data.field ?? '', op: n.data.op ?? '', value: n.data.value ?? '' })),
      actions: actionNodes.map((n) => ({
        action: n.data.action ?? '',
        label: actionDefs.find((a) => a.action === n.data.action)?.label ?? n.data.action ?? '',
      })),
      workflowName: name,
      isEditMode,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, actionDefs, name, isEditMode, setBuilderDraft]);

  // Wave 14 §4.3 — applies a Crystal `create_workflow` proposal to THIS page's
  // own local state, reusing deserializeCanvas() (the exact same parser
  // already used for this page's own edit-mode fetch and seed hydration) — no
  // second graph-to-canvas converter. Returns `false` for any proposal shape
  // this page doesn't recognize so CrystalPanel's executeAction can safely
  // fall back to its existing persist path.
  const hydrateFromProposal = useCallback((proposal: ActionProposal): boolean => {
    const proposalNodes = proposal.params.nodes as EngineNode[] | undefined;
    const proposalEdges = proposal.params.edges as EngineEdge[] | undefined;
    if (!Array.isArray(proposalNodes) || !Array.isArray(proposalEdges)) return false;

    const { nodes: rfNodes, edges: rfEdges } = deserializeCanvas(
      proposalNodes, proposalEdges,
      { triggers, actionDefs, operators, conditionFields, patch: patchNode, onConfigure: openConfigPanel },
    );
    setNodes(rfNodes);
    setEdges(rfEdges);
    if (!name.trim() && (proposal.params.name || proposal.title)) {
      setName((proposal.params.name as string) || proposal.title);
    }
    return true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [triggers, actionDefs, operators, conditionFields, patchNode, openConfigPanel, name]);

  // Register the hydration callback once it's stable.
  useEffect(() => {
    setBuilderDraftHydrator(hydrateFromProposal);
    return () => setBuilderDraftHydrator(null);
  }, [hydrateFromProposal, setBuilderDraftHydrator]);

  useEffect(() => {
    api.getWorkflowRegistry().then((r) => {
      const trs = r.triggers as Trigger[];
      const actions = r.actions as ActionDef[];
      const ops = r.conditionOperators;
      const fields = (r.conditionFields ?? []) as ConditionField[];
      setTriggers(trs);
      setActionDefs(actions);
      setOperators(ops);
      setConditionFields(fields);

      if (workflowId) {
        setLoadingWorkflow(true);
        setLoadError(null);
        setNotFound(false);
        api.getWorkflow(workflowId).then(({ workflow }) => {
          setName(workflow.name);
          setDescription(workflow.description ?? '');
          const { nodes: rfNodes, edges: rfEdges } = deserializeCanvas(
            (workflow.nodes ?? []) as EngineNode[],
            (workflow.edges ?? []) as EngineEdge[],
            { triggers: trs, actionDefs: actions, operators: ops, conditionFields: fields, patch: patchNode, onConfigure: openConfigPanel },
          );
          setNodes(rfNodes);
          setEdges(rfEdges);
          setLoadedStatus(workflow.status);
          setVersion(workflow.version);
        }).catch((err) => {
          const status = (err as { response?: { status?: number } })?.response?.status;
          setNotFound(status === 404);
          setLoadError(t('workflows.canvas.loadError'));
        }).finally(() => setLoadingWorkflow(false));
      } else if (seed?.nodes || seed?.edges) {
        // NL builder "Edit in canvas" handoff — treat like an edit-mode fetch result.
        setName(seed.name ?? '');
        setDescription(seed.description ?? '');
        const { nodes: rfNodes, edges: rfEdges } = deserializeCanvas(
          seed.nodes ?? [], seed.edges ?? [],
          { triggers: trs, actionDefs: actions, operators: ops, conditionFields: fields, patch: patchNode, onConfigure: openConfigPanel },
        );
        setNodes(rfNodes);
        setEdges(rfEdges);
      } else if (seed) {
        // Linear builder cross-link (§1.5) — partial seed, never has actions or
        // branches, so build one trigger node + one condition node directly.
        setName(seed.name ?? '');
        const seedNodes: Node<CanvasNodeData>[] = [{
          id: 'trigger', type: 'wfTrigger', position: { x: 80, y: 160 },
          data: { kind: 'trigger', triggerType: seed.triggerType || trs[0]?.type, options: trs, patch: patchNode },
        } as Node<CanvasNodeData>];
        const firstRule = seed.rules?.[0];
        if (firstRule) {
          seedNodes.push({
            id: 'cond_seed', type: 'wfCondition', position: { x: 360, y: 160 },
            data: { kind: 'condition', field: firstRule.field, op: firstRule.op, value: firstRule.value, options: ops, fieldOptions: fields, patch: patchNode },
          } as Node<CanvasNodeData>);
        }
        setNodes(seedNodes);
      } else {
        // Seed a trigger node so the canvas isn't empty.
        setNodes([{
          id: 'trigger', type: 'wfTrigger', position: { x: 80, y: 160 },
          data: { kind: 'trigger', triggerType: trs[0]?.type, options: trs, patch: patchNode },
        } as Node<CanvasNodeData>]);
      }
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, workflowId]);

  const onConnect = useCallback((c: Connection) => {
    // Edges leaving a condition's true/false handle carry that branch label.
    const branch = c.sourceHandle === 'true' || c.sourceHandle === 'false' ? c.sourceHandle : undefined;
    setEdges((es) => addEdge({
      ...c, animated: true,
      label: branch, data: branch ? { branch } : undefined,
      style: branch === 'false' ? { stroke: '#ef4444' } : branch === 'true' ? { stroke: '#059669' } : undefined,
    }, es));
  }, [setEdges]);

  let seq = nodes.length;
  const addCondition = () => setNodes((ns) => [...ns, {
    id: `cond_${seq++}`, type: 'wfCondition', position: { x: 360, y: 80 + ns.length * 30 },
    data: {
      kind: 'condition',
      field: conditionFields[0]?.field ?? 'nps',
      op: 'lte', value: '6', options: operators, fieldOptions: conditionFields, patch: patchNode,
    },
  } as Node<CanvasNodeData>]);

  const addAction = () => setNodes((ns) => [...ns, {
    id: `action_${seq++}`, type: 'wfAction', position: { x: 660, y: 80 + ns.length * 30 },
    // `config: {}` from the very first render (DEEP_AUDIT_FIX_SPECS.md Issue
    // 1) — isActionConfigured correctly evaluates this as unconfigured for
    // every non-flow.stop action, so a freshly dropped node shows "Needs
    // configuration" immediately, not just after a failed save.
    data: { kind: 'action', action: actionDefs[0]?.action || 'notify.in_app', config: {}, options: actionDefs, patch: patchNode, onConfigure: openConfigPanel },
  } as Node<CanvasNodeData>]);

  // Concurrent-edit protection (Wave 11, Nina — TRACKER.md Wave 11 Part 2).
  // `forceOverwrite` mirrors WorkflowBuilderPage.tsx's save() exactly: resends
  // the same PUT with `version` omitted, which the backend contract makes a
  // force-save.
  async function save(forceOverwrite = false) {
    const triggerType = triggerTypeOf(nodes as Node<CanvasNodeData>[]);
    const actionNodes = nodes.filter((n) => n.data.kind === 'action');
    if (!name.trim() || !triggerType || actionNodes.length === 0) {
      setError(t('workflows.builder.incomplete'));
      return;
    }
    // Block save while any action is unconfigured (DEEP_AUDIT_FIX_SPECS.md
    // Issue 1) — the difference between "the UI makes it visible" and "the UI
    // makes it impossible to ship silently broken."
    const unconfiguredCount = actionNodes.filter((n) => !isActionConfigured(n.data.action ?? '', n.data.config)).length;
    if (unconfiguredCount > 0) {
      setError(t('workflows.canvas.saveBlockedUnconfigured', { count: unconfiguredCount, s: unconfiguredCount === 1 ? '' : 's' }));
      return;
    }
    setSaving(true); setError(null);
    const serialized = serializeCanvas(nodes as Node<CanvasNodeData>[], edges as Edge[]);
    // Preserve the loaded workflow's status on edit — a routine edit must never
    // silently disable an active workflow. `loadedStatus` defaults to 'draft',
    // correct for create mode (nothing to preserve yet).
    const payload = {
      name, description, triggerType, nodes: serialized.nodes, edges: serialized.edges, status: loadedStatus,
      // Edit mode + not forcing: send the last-known version. Create mode
      // never sends `version` at all (nothing to conflict with).
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
        setConflictOpen(true);
        setError(null);
        return;
      }
      setError(err instanceof Error ? err.message : t('workflows.builder.saveError'));
    } finally { setSaving(false); }
  }

  // "Reload latest" — re-fetches the workflow fresh from the server, reusing
  // the already-loaded registry data (triggers/actionDefs/operators/
  // conditionFields don't change mid-session).
  async function reloadLatest() {
    setConflictOpen(false);
    if (!workflowId) return;
    setLoadingWorkflow(true);
    try {
      const { workflow } = await api.getWorkflow(workflowId);
      setName(workflow.name);
      setDescription(workflow.description ?? '');
      const { nodes: rfNodes, edges: rfEdges } = deserializeCanvas(
        (workflow.nodes ?? []) as EngineNode[],
        (workflow.edges ?? []) as EngineEdge[],
        { triggers, actionDefs, operators, conditionFields, patch: patchNode, onConfigure: openConfigPanel },
      );
      setNodes(rfNodes);
      setEdges(rfEdges);
      setLoadedStatus(workflow.status);
      setVersion(workflow.version);
    } catch {
      setLoadError(t('workflows.canvas.loadError'));
    } finally {
      setLoadingWorkflow(false);
    }
  }

  function overwriteAnyway() {
    setConflictOpen(false);
    save(true);
  }

  const nodeTypes = useMemo(() => ({ wfTrigger: TriggerNode, wfCondition: ConditionNode, wfAction: ActionNode }), []);
  const saveLabel = isEditMode ? t('workflows.builder.saveChanges') : t('workflows.builder.save');

  const configuringNode = configuringNodeId ? (nodes as Node<CanvasNodeData>[]).find((n) => n.id === configuringNodeId) : undefined;
  const configuringActionLabel = configuringNode
    ? (actionDefs.find((a) => a.action === configuringNode.data.action)?.label ?? configuringNode.data.action ?? '')
    : '';

  return (
    <div className="max-w-7xl mx-auto w-full">
      <PageHeader
        crumbs={[{ label: t('nav.workflows'), path: ROUTES.WORKFLOWS }, { label: t('workflows.canvas.title') }]}
        title={t('workflows.canvas.title')}
        subtitle={t('workflows.canvas.subtitle')}
        actions={
          // C-3 — was `w-56`/`w-64` fixed-width Inputs that pushed the action
          // buttons off-screen (with no wrap) below desktop. `flex-wrap` +
          // `min-w-0` fluid inputs let this row reflow instead of overflowing.
          <div className="flex items-center gap-2 flex-wrap w-full md:w-auto">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('workflows.builder.namePlaceholder')} className="w-full sm:w-56 min-w-0" disabled={loadingWorkflow} />
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t('workflows.builder.descriptionPlaceholder')} className="w-full sm:w-64 min-w-0" disabled={loadingWorkflow} maxLength={2000} />
            <Button variant="outline" onClick={addCondition} disabled={loadingWorkflow}><Icon name="filter_alt" size={14} className="mr-1" />{t('workflows.canvas.addCondition')}</Button>
            <Button variant="outline" onClick={addAction} disabled={loadingWorkflow}><Icon name="play_arrow" size={14} className="mr-1" />{t('workflows.canvas.addAction')}</Button>
            <Button onClick={() => save()} disabled={saving || loadingWorkflow}>{saving ? t('common.saving') : saveLabel}</Button>
          </div>
        }
      />
      {isCompact && (
        <div
          data-testid="canvas-mobile-advisory"
          className="flex items-start gap-2 px-4 py-3 mb-4 rounded-xl text-sm bg-warning/10 text-warning"
        >
          <Icon name="desktop_windows" size={16} className="shrink-0 mt-0.5" />
          <span>{t('workflows.canvas.mobileAdvisory')}</span>
        </div>
      )}
      {error && <p className="text-sm text-destructive mb-2">{error}</p>}
      <div style={{ height: '70vh' }} className="rounded-2xl border border-border overflow-hidden bg-surface-variant/20">
        {loadingWorkflow ? (
          <div className="w-full h-full flex flex-col items-center justify-center gap-3">
            <div className="w-8 h-8 rounded-full border-2 border-t-transparent animate-spin border-primary" />
            <p className="text-sm text-on-surface-variant">{t('workflows.canvas.loadingWorkflow')}</p>
          </div>
        ) : loadError ? (
          <div className="w-full h-full flex items-center justify-center p-8">
            <div className="max-w-md text-center">
              <Icon name="error_outline" size={32} className="text-error mx-auto mb-3" />
              <h3 className="font-semibold text-on-surface mb-1">{t('workflows.builder.notFoundHeading')}</h3>
              <p className="text-sm text-on-surface-variant mb-4">
                {notFound ? t('workflows.builder.notFoundBody') : t('workflows.builder.loadErrorBody')}
              </p>
              <Button variant="outline" onClick={() => navigate(ROUTES.WORKFLOWS)}>
                {t('workflows.builder.backToList')}
              </Button>
            </div>
          </div>
        ) : (
          <ReactFlow
            nodes={nodes} edges={edges}
            onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect}
            nodeTypes={nodeTypes} fitView
          >
            <Background />
            <Controls />
            <MiniMap pannable zoomable />
          </ReactFlow>
        )}
      </div>
      {configuringNode && (
        <ActionConfigPanel
          open
          action={configuringNode.data.action ?? ''}
          actionLabel={configuringActionLabel}
          config={configuringNode.data.config ?? {}}
          onChange={(next) => patchNode(configuringNode.id, { config: next })}
          onClose={() => setConfiguringNodeId(null)}
        />
      )}

      {/* Concurrent-edit conflict (Wave 11, Nina — TRACKER.md Wave 11 Part 2).
          Matches WorkflowBuilderPage.tsx's / the delete-confirmation Dialog
          pattern exactly — no new modal interaction pattern introduced. */}
      <Dialog open={conflictOpen} onOpenChange={setConflictOpen}>
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

      {/* Wave 14 (WAVE14_UNIFIED_BUILDER_SPEC.md §2.5) — the ReactFlow canvas
          above is a 70vh bordered box inside this normal scrolling page, not
          full-viewport, so this fixed FAB floats clear of it. */}
      <AskCrystalFab onOpen={() => openCrystal()} />
    </div>
  );
}

// ── Custom nodes ────────────────────────────────────────────────────────────────
const SHELL = 'rounded-xl bg-white shadow-md border border-border px-3 py-2 text-sm min-w-[180px]';

function TriggerNode({ id, data }: NodeProps<CanvasNodeData & { options?: Trigger[]; patch?: (id: string, p: Partial<CanvasNodeData>) => void }>) {
  const { t } = useTranslation();
  return (
    <div className={SHELL} style={{ borderTop: '3px solid #2a4bd9' }}>
      <div className="flex items-center gap-1.5 mb-1 font-semibold text-on-surface"><Icon name="bolt" size={14} className="text-primary" />{t('workflows.canvas.trigger')}</div>
      <select className="w-full text-xs border border-border rounded px-1.5 py-1 bg-transparent" value={data.triggerType}
        onChange={(e) => data.patch?.(id, { triggerType: e.target.value })}>
        {(data.options || []).map((o) => <option key={o.type} value={o.type}>{o.label}</option>)}
      </select>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function ConditionNode({ id, data }: NodeProps<CanvasNodeData & { options?: string[]; fieldOptions?: ConditionField[]; patch?: (id: string, p: Partial<CanvasNodeData>) => void }>) {
  const { t } = useTranslation();
  const fieldOptions = data.fieldOptions ?? [];
  return (
    <div className={SHELL} style={{ borderTop: '3px solid #d97706' }}>
      <Handle type="target" position={Position.Left} />
      <div className="flex items-center gap-1.5 mb-1 font-semibold text-on-surface"><Icon name="filter_alt" size={14} className="text-warning" />{t('workflows.canvas.condition')}</div>
      <div className="flex items-center gap-1">
        {fieldOptions.length > 0 ? (
          // Dropdown of the registry's declared condition fields (Maya
          // DEEP_AUDIT_PM_FINDINGS.md 2d) — prevents new typo'd field keys from
          // being entered. Partial fix: does not validate already-saved bad
          // data (a separate backend fix in evaluateConditions).
          <select
            aria-label={t('workflows.canvas.conditionFieldAria')}
            className="text-xs border border-border rounded px-1.5 py-1 bg-transparent flex-1"
            value={data.field || ''}
            onChange={(e) => data.patch?.(id, { field: e.target.value })}
          >
            {fieldOptions.map((f) => <option key={f.field} value={f.field}>{f.label}</option>)}
          </select>
        ) : (
          <Input className="h-7 text-xs flex-1" value={data.field || ''} onChange={(e) => data.patch?.(id, { field: e.target.value })} />
        )}
        <select className="text-xs border border-border rounded px-1 py-1 bg-transparent" value={data.op}
          onChange={(e) => data.patch?.(id, { op: e.target.value })}>
          {(data.options || []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
        <Input className="h-7 text-xs w-12" value={data.value || ''} onChange={(e) => data.patch?.(id, { value: e.target.value })} />
      </div>
      <div className="flex justify-between text-[10px] mt-1.5"><span className="text-success">{t('workflows.canvas.true')}</span><span className="text-destructive">{t('workflows.canvas.false')}</span></div>
      <Handle id="true" type="source" position={Position.Bottom} style={{ left: '25%', background: '#059669' }} />
      <Handle id="false" type="source" position={Position.Bottom} style={{ left: '75%', background: '#ef4444' }} />
    </div>
  );
}

// One-line human summary for a configured action (DEEP_AUDIT_FIX_SPECS.md
// Issue 1 — "answers Rohan's own §6 finding, S-1/per-action status glyph, for
// free" instead of a generic "Configured" label). Falls back to the generic
// label for actions with no single obviously-summarizable field.
function configuredSummary(action: string, config: Record<string, unknown> | undefined, t: (k: string) => string): string {
  const cfg = config ?? {};
  if (action === 'notify.slack' && typeof cfg.channel === 'string' && cfg.channel) return cfg.channel;
  if (action === 'notify.email' || action === 'notify.in_app') {
    const target = extractNotifyTarget(cfg);
    if (target?.targetType === 'users') return t('workflows.canvas.actionNode.configured') + ` (${target.userIds.length})`;
    if (target) return target.targetType;
  }
  if (action === 'jira.create_issue' && typeof cfg.projectKey === 'string' && cfg.projectKey) return cfg.projectKey;
  if (action === 'flow.approval' && typeof cfg.approverEmail === 'string' && cfg.approverEmail) return cfg.approverEmail;
  if (action === 'notify.webhook' && typeof cfg.url === 'string' && cfg.url) return cfg.url;
  return t('workflows.canvas.actionNode.configured');
}

function ActionNode({ id, data }: NodeProps<CanvasNodeData & { options?: ActionDef[]; patch?: (id: string, p: Partial<CanvasNodeData>) => void; onConfigure?: (id: string) => void }>) {
  const { t } = useTranslation();
  const actionLabel = (data.options || []).find((o) => o.action === data.action)?.label ?? data.action ?? '';
  const configured = isActionConfigured(data.action ?? '', data.config);
  return (
    <div className={SHELL} style={{ borderTop: `3px solid ${configured ? '#059669' : '#d97706'}` }}>
      <Handle type="target" position={Position.Left} />
      <div className="flex items-center gap-1.5 mb-1 font-semibold text-on-surface"><Icon name="play_arrow" size={14} className="text-success" />{t('workflows.canvas.action')}</div>
      <select className="w-full text-xs border border-border rounded px-1.5 py-1 bg-transparent" value={data.action}
        onChange={(e) => data.patch?.(id, { action: e.target.value })}>
        {(data.options || []).map((o) => <option key={o.action} value={o.action}>{o.label}{o.live === true ? '' : o.live === 'env' ? ' ⚙' : ' (stub)'}</option>)}
      </select>
      <button
        type="button"
        data-testid={`action-node-config-status-${id}`}
        data-configured={configured}
        aria-label={t('workflows.canvas.actionNode.configureAria').replace('{action}', actionLabel)}
        onClick={() => data.onConfigure?.(id)}
        className={`w-full flex items-center gap-1 mt-1.5 pt-1.5 border-t border-border text-[11px] font-medium text-left ${configured ? 'text-success' : 'text-warning'}`}
      >
        <Icon name={configured ? 'check_circle' : 'warning'} size={12} />
        <span className="flex-1 truncate">{configured ? configuredSummary(data.action ?? '', data.config, t) : t('workflows.canvas.actionNode.needsConfig')}</span>
        <Icon name="chevron_right" size={12} />
      </button>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
