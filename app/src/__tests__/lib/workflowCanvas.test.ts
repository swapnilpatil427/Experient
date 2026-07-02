import { describe, it, expect, vi } from 'vitest';
import { serializeCanvas, deserializeCanvas, triggerTypeOf, hasBranches, hasEngineBranches, isActionConfigured } from '../../lib/workflowCanvas';
import type { Node, Edge } from 'reactflow';
import type { CanvasNodeData, EngineNode, EngineEdge } from '../../lib/workflowCanvas';

const nodes: Node<CanvasNodeData>[] = [
  { id: 'trigger', type: 'wfTrigger', position: { x: 0, y: 0 }, data: { kind: 'trigger', triggerType: 'survey.response_filtered' } },
  { id: 'cond_1', type: 'wfCondition', position: { x: 0, y: 0 }, data: { kind: 'condition', field: 'nps', op: 'lte', value: '6' } },
  { id: 'action_2', type: 'wfAction', position: { x: 0, y: 0 }, data: { kind: 'action', action: 'notify.slack' } },
  { id: 'action_3', type: 'wfAction', position: { x: 0, y: 0 }, data: { kind: 'action', action: 'notify.in_app' } },
];

const edges: Edge[] = [
  { id: 'e1', source: 'trigger', target: 'cond_1' },
  { id: 'e2', source: 'cond_1', target: 'action_2', sourceHandle: 'true', data: { branch: 'true' } },
  { id: 'e3', source: 'cond_1', target: 'action_3', sourceHandle: 'false', data: { branch: 'false' } },
];

describe('serializeCanvas', () => {
  it('maps canvas nodes to the engine node format', () => {
    const { nodes: out } = serializeCanvas(nodes, edges);
    expect(out[0]).toEqual({ id: 'trigger', type: 'trigger', trigger: 'survey.response_filtered' });
    expect(out[1]).toEqual({ id: 'cond_1', type: 'condition', conditions: { operator: 'AND', rules: [{ field: 'nps', op: 'lte', value: 6 }] } });
    expect(out[2]).toEqual({ id: 'action_2', type: 'action', action: 'notify.slack', config: {} });
  });

  // DEEP_AUDIT_FIX_SPECS.md Issue 1 / DEEP_AUDIT_PM_FINDINGS.md Top-5 #2 — this
  // used to hardcode `config: {}` for every action node unconditionally, so
  // every canvas-built workflow, ever, fired every action with empty config.
  it('carries a real per-action config through instead of hardcoding {}', () => {
    const configuredNodes: Node<CanvasNodeData>[] = [
      { id: 'action_x', type: 'wfAction', position: { x: 0, y: 0 }, data: { kind: 'action', action: 'notify.slack', config: { channel: '#cx-alerts' } } },
    ];
    const { nodes: out } = serializeCanvas(configuredNodes, []);
    expect(out[0]).toEqual({ id: 'action_x', type: 'action', action: 'notify.slack', config: { channel: '#cx-alerts' } });
  });

  it('defaults to an empty config object when the node has none set', () => {
    const bareNode: Node<CanvasNodeData>[] = [
      { id: 'action_y', type: 'wfAction', position: { x: 0, y: 0 }, data: { kind: 'action', action: 'flow.stop' } },
    ];
    const { nodes: out } = serializeCanvas(bareNode, []);
    expect(out[0].config).toEqual({});
  });

  it('coerces numeric condition values but leaves strings alone', () => {
    const strNodes: Node<CanvasNodeData>[] = [
      { id: 'c', type: 'wfCondition', position: { x: 0, y: 0 }, data: { kind: 'condition', field: 'sentiment', op: 'eq', value: 'negative' } },
    ];
    const { nodes: out } = serializeCanvas(strNodes, []);
    expect(out[0].conditions?.rules[0].value).toBe('negative');
  });

  it('labels condition branches on the edges', () => {
    const { edges: out } = serializeCanvas(nodes, edges);
    expect(out).toContainEqual({ from: 'trigger', to: 'cond_1' });
    expect(out).toContainEqual({ from: 'cond_1', to: 'action_2', branch: 'true' });
    expect(out).toContainEqual({ from: 'cond_1', to: 'action_3', branch: 'false' });
  });

  it('derives branch from sourceHandle when edge data is absent', () => {
    const { edges: out } = serializeCanvas(nodes, [
      { id: 'x', source: 'cond_1', target: 'action_2', sourceHandle: 'true' },
    ]);
    expect(out[0]).toEqual({ from: 'cond_1', to: 'action_2', branch: 'true' });
  });

  it('triggerTypeOf finds the trigger node type, hasBranches detects branching', () => {
    expect(triggerTypeOf(nodes)).toBe('survey.response_filtered');
    expect(hasBranches(edges)).toBe(true);
    expect(hasBranches([{ id: 'e', source: 'a', target: 'b' }])).toBe(false);
  });
});

describe('hasEngineBranches', () => {
  it('detects a branch on the engine edge shape', () => {
    expect(hasEngineBranches([{ from: 'cond', to: 'a', branch: 'true' }])).toBe(true);
    expect(hasEngineBranches([{ from: 'trigger', to: 'action' }])).toBe(false);
    expect(hasEngineBranches([])).toBe(false);
  });
});

describe('deserializeCanvas', () => {
  const ctx = { triggers: [], actionDefs: [], operators: [], patch: vi.fn() };

  it('round-trips through serializeCanvas (structurally equivalent modulo position)', () => {
    const { nodes: engineNodes, edges: engineEdges } = serializeCanvas(nodes, edges);
    const { nodes: rfNodes, edges: rfEdges } = deserializeCanvas(engineNodes, engineEdges, ctx);
    const reSerialized = serializeCanvas(rfNodes, rfEdges);

    expect(reSerialized.nodes).toEqual(engineNodes);
    // Edges: compare from/to/branch triples regardless of id/style/order noise.
    const normalize = (es: EngineEdge[]) => es.map((e) => ({ from: e.from, to: e.to, branch: e.branch })).sort((a, b) => `${a.from}${a.to}`.localeCompare(`${b.from}${b.to}`));
    expect(normalize(reSerialized.edges)).toEqual(normalize(engineEdges));
  });

  it('lays out nodes left-to-right by BFS depth from the trigger', () => {
    const engineNodes: EngineNode[] = [
      { id: 'trigger', type: 'trigger', trigger: 'survey.response_filtered' },
      { id: 'cond', type: 'condition', conditions: { operator: 'AND', rules: [{ field: 'nps', op: 'lte', value: 6 }] } },
      { id: 'action_0', type: 'action', action: 'notify.slack' },
    ];
    const engineEdges: EngineEdge[] = [{ from: 'trigger', to: 'cond' }, { from: 'cond', to: 'action_0' }];
    const { nodes: rfNodes } = deserializeCanvas(engineNodes, engineEdges, ctx);

    const byId = Object.fromEntries(rfNodes.map((n) => [n.id, n]));
    expect(byId.trigger.position.x).toBeLessThan(byId.cond.position.x);
    expect(byId.cond.position.x).toBeLessThan(byId.action_0.position.x);
  });

  it('produces reactflow node types matching each engine node kind', () => {
    const engineNodes: EngineNode[] = [
      { id: 'trigger', type: 'trigger', trigger: 'survey.response_filtered' },
      { id: 'cond', type: 'condition', conditions: { operator: 'AND', rules: [{ field: 'nps', op: 'lte', value: 6 }] } },
      { id: 'action_0', type: 'action', action: 'notify.slack' },
    ];
    const { nodes: rfNodes } = deserializeCanvas(engineNodes, [{ from: 'trigger', to: 'cond' }, { from: 'cond', to: 'action_0' }], ctx);
    const byId = Object.fromEntries(rfNodes.map((n) => [n.id, n]));
    expect(byId.trigger.type).toBe('wfTrigger');
    expect(byId.cond.type).toBe('wfCondition');
    expect(byId.action_0.type).toBe('wfAction');
  });

  it('does not throw on a dangling edge referencing a missing node — drops it instead', () => {
    const engineNodes: EngineNode[] = [{ id: 'trigger', type: 'trigger', trigger: 'survey.response_filtered' }];
    const engineEdges: EngineEdge[] = [{ from: 'trigger', to: 'ghost_node' }];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => deserializeCanvas(engineNodes, engineEdges, ctx)).not.toThrow();
    const { nodes: rfNodes, edges: rfEdges } = deserializeCanvas(engineNodes, engineEdges, ctx);
    expect(rfNodes).toHaveLength(1);
    expect(rfEdges).toHaveLength(0);
    warnSpy.mockRestore();
  });

  it('does not throw on missing/undefined nodes or edges — degrades to empty output', () => {
    expect(() => deserializeCanvas(undefined as unknown as EngineNode[], undefined as unknown as EngineEdge[], ctx)).not.toThrow();
    const { nodes: rfNodes, edges: rfEdges } = deserializeCanvas(undefined as unknown as EngineNode[], undefined as unknown as EngineEdge[], ctx);
    expect(rfNodes).toEqual([]);
    expect(rfEdges).toEqual([]);
  });

  it('still renders an orphan node unreached by BFS from the trigger', () => {
    const engineNodes: EngineNode[] = [
      { id: 'trigger', type: 'trigger', trigger: 'survey.response_filtered' },
      { id: 'orphan_action', type: 'action', action: 'notify.slack' },
    ];
    const { nodes: rfNodes } = deserializeCanvas(engineNodes, [], ctx);
    expect(rfNodes.map((n) => n.id)).toContain('orphan_action');
  });

  // Maya DEEP_AUDIT_PM_FINDINGS.md 2d — ConditionNode's field input used to be
  // raw free text with zero validation; a fix threads the registry's declared
  // condition fields through so the canvas can render a dropdown instead.
  it('carries ctx.conditionFields through onto a condition node as fieldOptions', () => {
    const fields = [{ field: 'nps', label: 'NPS Score', kind: 'number' as const }];
    const ctxWithFields = { ...ctx, conditionFields: fields };
    const engineNodes: EngineNode[] = [
      { id: 'trigger', type: 'trigger', trigger: 'survey.response_filtered' },
      { id: 'cond', type: 'condition', conditions: { operator: 'AND', rules: [{ field: 'nps', op: 'lte', value: 6 }] } },
    ];
    const { nodes: rfNodes } = deserializeCanvas(engineNodes, [{ from: 'trigger', to: 'cond' }], ctxWithFields);
    const cond = rfNodes.find((n) => n.id === 'cond');
    expect(cond?.data.fieldOptions).toEqual(fields);
  });

  it('defaults fieldOptions to an empty array when ctx.conditionFields is omitted', () => {
    const engineNodes: EngineNode[] = [
      { id: 'trigger', type: 'trigger', trigger: 'survey.response_filtered' },
      { id: 'cond', type: 'condition', conditions: { operator: 'AND', rules: [{ field: 'nps', op: 'lte', value: 6 }] } },
    ];
    const { nodes: rfNodes } = deserializeCanvas(engineNodes, [{ from: 'trigger', to: 'cond' }], ctx);
    const cond = rfNodes.find((n) => n.id === 'cond');
    expect(cond?.data.fieldOptions).toEqual([]);
  });

  // DEEP_AUDIT_FIX_SPECS.md Issue 1 — previously dropped `n.config` entirely
  // when building a wfAction node's data, so reopening an existing
  // canvas-built workflow blanked every action's config on load, and the next
  // save would re-persist the blanked-out {} right back (the config could
  // never survive an edit round-trip even after Issue 1's serialize fix).
  it('carries an action node\'s config forward into wfAction node data', () => {
    const engineNodes: EngineNode[] = [
      { id: 'trigger', type: 'trigger', trigger: 'survey.response_filtered' },
      { id: 'action_0', type: 'action', action: 'notify.slack', config: { channel: '#cx-alerts' } },
    ];
    const { nodes: rfNodes } = deserializeCanvas(engineNodes, [{ from: 'trigger', to: 'action_0' }], ctx);
    const action = rfNodes.find((n) => n.id === 'action_0');
    expect(action?.data.config).toEqual({ channel: '#cx-alerts' });
  });

  it('defaults an action node\'s config to {} when the engine node has none', () => {
    const engineNodes: EngineNode[] = [
      { id: 'trigger', type: 'trigger', trigger: 'survey.response_filtered' },
      { id: 'action_0', type: 'action', action: 'flow.stop' },
    ];
    const { nodes: rfNodes } = deserializeCanvas(engineNodes, [{ from: 'trigger', to: 'action_0' }], ctx);
    const action = rfNodes.find((n) => n.id === 'action_0');
    expect(action?.data.config).toEqual({});
  });
});

// DEEP_AUDIT_FIX_SPECS.md Issue 1 — one test per action-type branch, mirroring
// the sentence builder's own "configured" definitions (imports the same
// FIELDS_BY_ACTION/CONTENT_PRODUCING_ACTIONS ActionStepPanelContent.tsx uses,
// not a reinvented copy).
describe('isActionConfigured', () => {
  it('flow.stop is always configured (zero fields declared)', () => {
    expect(isActionConfigured('flow.stop', {})).toBe(true);
    expect(isActionConfigured('flow.stop', undefined)).toBe(true);
  });

  it('SimpleActionConfigForm actions require their declared field to be non-empty', () => {
    expect(isActionConfigured('jira.create_issue', {})).toBe(false);
    expect(isActionConfigured('jira.create_issue', { projectKey: '' })).toBe(false);
    expect(isActionConfigured('jira.create_issue', { projectKey: 'CX' })).toBe(true);
    expect(isActionConfigured('flow.approval', { approverEmail: 'manager@co.com' })).toBe(true);
  });

  it('notify.webhook only requires its `required` url field, not the optional ones', () => {
    expect(isActionConfigured('notify.webhook', {})).toBe(false);
    expect(isActionConfigured('notify.webhook', { url: 'https://example.com/hook' })).toBe(true);
    expect(isActionConfigured('notify.webhook', { url: '  ' })).toBe(false);
  });

  it('notify.in_app requires a resolved recipient target', () => {
    expect(isActionConfigured('notify.in_app', {})).toBe(false);
    expect(isActionConfigured('notify.in_app', { targetType: 'users', userIds: ['u1'] })).toBe(true);
    expect(isActionConfigured('notify.in_app', { targetType: 'role', roleId: 'role-1' })).toBe(true);
  });

  it('notify.email (content-producing) requires a resolved recipient target', () => {
    expect(isActionConfigured('notify.email', {})).toBe(false);
    expect(isActionConfigured('notify.email', { targetType: 'users', userIds: ['u1'] })).toBe(true);
  });

  it('notify.slack (content-producing) requires a non-empty channel', () => {
    expect(isActionConfigured('notify.slack', {})).toBe(false);
    expect(isActionConfigured('notify.slack', { channel: '' })).toBe(false);
    expect(isActionConfigured('notify.slack', { channel: '#cx-alerts' })).toBe(true);
  });

  it('crystal.summarize (content-producing) is always configured once selected', () => {
    expect(isActionConfigured('crystal.summarize', {})).toBe(true);
  });

  it('crystal.classify (no declared fields) is always configured, matching the sentence builder', () => {
    expect(isActionConfigured('crystal.classify', {})).toBe(true);
  });

  it('an unrecognized action type is treated as configured (no fields to require)', () => {
    expect(isActionConfigured('some.unknown_action', {})).toBe(true);
  });
});
