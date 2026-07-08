// Pure helpers that translate the reactflow canvas (nodes + edges) into the
// engine's workflow graph format. Kept separate from the page so the
// serialization — the part that must be correct — is unit-testable without
// rendering reactflow in jsdom.
import type { Node, Edge } from 'reactflow';
import { FIELDS_BY_ACTION } from '../components/workflow-builder/sentence/SimpleActionConfigForm';
import { CONTENT_PRODUCING_ACTIONS } from '../components/workflow-builder/sentence/ContentCustomizationPanel';
import { extractNotifyTarget } from '../components/workflow-builder/sentence/contentSections';

export interface CanvasNodeData {
  kind: 'trigger' | 'condition' | 'action';
  triggerType?: string;
  action?: string;
  // Real per-action config (DEEP_AUDIT_FIX_SPECS.md Issue 1) — only ever
  // meaningful on `kind: 'action'` nodes; trigger/condition nodes ignore it.
  // `undefined`/`{}` until the user opens ActionConfigPanel and enters at
  // least one field — this is the state `isActionConfigured` below keys off.
  config?: Record<string, unknown>;
  field?: string;
  op?: string;
  value?: string;
  [k: string]: unknown;
}

// Whether an action node's config is complete enough to actually do something
// if it fired right now — binary, not a partial-completion score (per spec:
// "this is not a partial-completion progress bar, it's 'would this action
// actually do anything if it fired right now'"). Mirrors the sentence
// builder's own per-action-type notion of "configured" so the same logic is
// reused, not reinvented — imports the exact same FIELDS_BY_ACTION map and
// CONTENT_PRODUCING_ACTIONS set ActionStepPanelContent.tsx's three-way
// dispatch already uses.
export function isActionConfigured(action: string, config: Record<string, unknown> | undefined): boolean {
  const cfg = config ?? {};

  if (CONTENT_PRODUCING_ACTIONS.has(action)) {
    // notify.email requires a resolved recipient target; notify.slack requires
    // a channel; crystal.summarize has no required field beyond being
    // selected (matches the sentence builder's own treatment).
    if (action === 'notify.email') return extractNotifyTarget(cfg) != null;
    if (action === 'notify.slack') return Boolean((cfg.channel as string | undefined)?.trim());
    return true; // crystal.summarize
  }

  if (action === 'notify.in_app') {
    return extractNotifyTarget(cfg) != null;
  }

  // notify.webhook and crystal.classify are out of scope for this fix per PM
  // findings #2a/#2b at the time this spec was written — but notify.webhook
  // now HAS real fields in FIELDS_BY_ACTION (Kenji finding 4 / Maya 2a, fixed
  // in this same wave), so it's picked up by the generic branch below for
  // free, exactly as the spec anticipated ("once Nina wires
  // FIELDS_BY_ACTION['notify.webhook']... the canvas panel picks it up for
  // free"). crystal.classify still has no fields declared, so it falls
  // through to fields.length === 0 below and is always "configured".
  const fields = FIELDS_BY_ACTION[action] ?? [];
  if (fields.length === 0) return true; // flow.stop, crystal.classify, or any unrecognized action type
  // Only fields explicitly marked `required` gate "configured" (e.g.
  // notify.webhook's url) — optional fields (method/headers/payload/secret)
  // don't block the configured state. Actions with no `required` fields at
  // all (Jira/Salesforce/ServiceNow/Zendesk/flow.approval's single field) keep
  // the pre-existing "every declared field must be filled" behavior, since
  // none of those fields are marked optional today.
  const gatingFields = fields.some((f) => f.required) ? fields.filter((f) => f.required) : fields;
  return gatingFields.every((f) => {
    const v = cfg[f.key];
    return typeof v === 'string' ? v.trim().length > 0 : v != null;
  });
}

export interface EngineNode {
  id: string;
  type: string;
  trigger?: string;
  action?: string;
  config?: Record<string, unknown>;
  conditions?: { operator: string; rules: Array<{ field?: string; op?: string; value: unknown }> };
}

export interface EngineEdge {
  from: string;
  to: string;
  branch?: 'true' | 'false';
}

// Numbers stay numbers so engine comparisons (gte/lte/between) work.
function coerce(v: unknown): unknown {
  if (v == null || v === '') return v;
  const n = Number(v);
  return Number.isNaN(n) ? v : n;
}

// A condition node's outgoing edge is labeled by the source handle it leaves from.
function branchOf(edge: Edge): 'true' | 'false' | undefined {
  const fromData = (edge.data as { branch?: string } | undefined)?.branch;
  const handle = edge.sourceHandle;
  const b = fromData || handle;
  return b === 'true' || b === 'false' ? b : undefined;
}

export function serializeCanvas(nodes: Node<CanvasNodeData>[], edges: Edge[]): { nodes: EngineNode[]; edges: EngineEdge[] } {
  const engineNodes: EngineNode[] = nodes.map((n) => {
    const d = n.data;
    if (d.kind === 'trigger') return { id: n.id, type: 'trigger', trigger: d.triggerType };
    if (d.kind === 'condition') {
      return { id: n.id, type: 'condition', conditions: { operator: 'AND', rules: [{ field: d.field, op: d.op, value: coerce(d.value) }] } };
    }
    return { id: n.id, type: 'action', action: d.action, config: d.config ?? {} };
  });

  const engineEdges: EngineEdge[] = edges.map((e) => {
    const branch = branchOf(e);
    return branch ? { from: e.source, to: e.target, branch } : { from: e.source, to: e.target };
  });

  return { nodes: engineNodes, edges: engineEdges };
}

// The trigger type drives the workflow's `trigger_type` column (which trigger bus
// it subscribes to). Falls back to the first node's trigger if unlabeled.
export function triggerTypeOf(nodes: Node<CanvasNodeData>[]): string | undefined {
  const trigger = nodes.find((n) => n.data.kind === 'trigger');
  return trigger?.data.triggerType;
}

// Whether the graph has at least one branch — i.e. the engine will run it in graph mode.
export function hasBranches(edges: Edge[]): boolean {
  return edges.some((e) => branchOf(e) != null);
}

// Same signal as hasBranches(), but over the engine's own EngineEdge[] shape
// (persisted `nodes`/`edges` from the API) rather than reactflow's Edge[] —
// EngineEdge carries `branch` as a top-level field instead of
// `sourceHandle`/`data.branch`, so it needs its own predicate rather than an
// unsafe cast into hasBranches().
export function hasEngineBranches(edges: EngineEdge[]): boolean {
  return edges.some((e) => e.branch === 'true' || e.branch === 'false');
}

export interface DeserializeCanvasCtx {
  triggers: unknown[];
  actionDefs: unknown[];
  operators: string[];
  // Registry's declared condition fields (backend/src/lib/workflowRegistry.ts's
  // CONDITION_FIELDS) — optional so existing callers that haven't threaded the
  // registry's conditionFields through yet still compile; ConditionNode falls
  // back to a plain text input when this is empty (see WorkflowCanvasPage.tsx).
  conditionFields?: unknown[];
  patch: (id: string, p: Partial<CanvasNodeData>) => void;
  // Opens ActionConfigPanel for a given action node id (DEEP_AUDIT_FIX_SPECS.md
  // Issue 1) — optional so existing callers/tests that don't exercise the
  // config panel still compile.
  onConfigure?: (id: string) => void;
}

// Inverse of serializeCanvas. Positions are not persisted by the engine (EngineNode
// has no x/y) so this lays nodes out left-to-right by graph depth (BFS from the
// trigger), 280px column spacing / 120px row spacing — matches the manual spacing
// already used by addCondition/addAction's x offsets (360/660) in WorkflowCanvasPage.
//
// Never throws on malformed input (missing node, dangling edge) — worst case, drop
// the unresolvable edge and log, don't crash the canvas on load.
export function deserializeCanvas(
  nodes: EngineNode[],
  edges: EngineEdge[],
  ctx: DeserializeCanvasCtx,
): { nodes: Node<CanvasNodeData>[]; edges: Edge[] } {
  const safeNodes = Array.isArray(nodes) ? nodes : [];
  const safeEdges = Array.isArray(edges) ? edges : [];
  const byId = new Map(safeNodes.map((n) => [n.id, n]));

  // BFS from trigger node(s) to compute column (depth) per node id.
  const depth = new Map<string, number>();
  const roots = safeNodes.filter((n) => n.type === 'trigger');
  const queue: Array<{ id: string; d: number }> = roots.map((n) => ({ id: n.id, d: 0 }));
  for (const n of safeNodes) if (!depth.has(n.id) && n.type === 'trigger') depth.set(n.id, 0);

  const adjacency = new Map<string, string[]>();
  for (const e of safeEdges) {
    if (!byId.has(e.from) || !byId.has(e.to)) {
      // Dangling edge — reference to a node that doesn't exist. Drop it, don't crash.
      // eslint-disable-next-line no-console
      console.warn(`deserializeCanvas: dropping edge referencing missing node (${e.from} -> ${e.to})`);
      continue;
    }
    if (!adjacency.has(e.from)) adjacency.set(e.from, []);
    adjacency.get(e.from)!.push(e.to);
  }

  while (queue.length > 0) {
    const { id, d } = queue.shift()!;
    for (const next of adjacency.get(id) ?? []) {
      const existing = depth.get(next);
      if (existing == null || d + 1 > existing) {
        depth.set(next, d + 1);
        queue.push({ id: next, d: d + 1 });
      }
    }
  }

  // Any node unreached by BFS (orphan / disconnected) still gets rendered —
  // place it at depth 0 alongside triggers rather than dropping it.
  for (const n of safeNodes) if (!depth.has(n.id)) depth.set(n.id, 0);

  // Track how many nodes already placed at a given column, for row spacing.
  const columnCounts = new Map<number, number>();
  const COLUMN_SPACING = 280;
  const ROW_SPACING = 120;

  const rfNodes: Node<CanvasNodeData>[] = safeNodes.map((n) => {
    const col = depth.get(n.id) ?? 0;
    const row = columnCounts.get(col) ?? 0;
    columnCounts.set(col, row + 1);
    const position = { x: 80 + col * COLUMN_SPACING, y: 80 + row * ROW_SPACING };

    if (n.type === 'trigger') {
      return {
        id: n.id, type: 'wfTrigger', position,
        data: { kind: 'trigger', triggerType: n.trigger, options: ctx.triggers, patch: ctx.patch },
      } as Node<CanvasNodeData>;
    }
    if (n.type === 'condition') {
      const rule = n.conditions?.rules?.[0];
      return {
        id: n.id, type: 'wfCondition', position,
        data: {
          kind: 'condition',
          field: rule?.field ?? '',
          op: rule?.op ?? '',
          value: rule?.value != null ? String(rule.value) : '',
          options: ctx.operators, fieldOptions: ctx.conditionFields ?? [], patch: ctx.patch,
        },
      } as Node<CanvasNodeData>;
    }
    return {
      id: n.id, type: 'wfAction', position,
      data: { kind: 'action', action: n.action ?? '', config: n.config ?? {}, options: ctx.actionDefs, patch: ctx.patch, onConfigure: ctx.onConfigure },
    } as Node<CanvasNodeData>;
  });

  const rfEdges: Edge[] = safeEdges
    .filter((e) => byId.has(e.from) && byId.has(e.to))
    .map((e) => ({
      id: `${e.from}-${e.to}${e.branch ? `-${e.branch}` : ''}`,
      source: e.from,
      target: e.to,
      sourceHandle: e.branch,
      animated: true,
      label: e.branch,
      data: e.branch ? { branch: e.branch } : undefined,
      style: e.branch === 'false' ? { stroke: '#ef4444' } : e.branch === 'true' ? { stroke: '#059669' } : undefined,
    }));

  return { nodes: rfNodes, edges: rfEdges };
}
