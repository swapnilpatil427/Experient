import { describe, it, expect } from 'vitest';
import { resolveEditRoute } from '../../lib/workflowEditRoute';
import { ROUTES } from '../../constants/routes';
import type { EngineNode, EngineEdge } from '../../lib/workflowCanvas';

describe('resolveEditRoute', () => {
  it('routes a straight-line workflow (trigger -> condition -> action) to the linear builder', () => {
    const nodes: EngineNode[] = [
      { id: 'trigger', type: 'trigger', trigger: 'survey.response_filtered' },
      { id: 'cond', type: 'condition', conditions: { operator: 'AND', rules: [{ field: 'nps', op: 'lte', value: 6 }] } },
      { id: 'action_0', type: 'action', action: 'notify.slack' },
    ];
    const edges: EngineEdge[] = [
      { from: 'trigger', to: 'cond' },
      { from: 'cond', to: 'action_0' },
    ];
    expect(resolveEditRoute(nodes, edges)).toBe(ROUTES.WORKFLOW_BUILD);
  });

  it('routes a workflow with no condition at all to the linear builder', () => {
    const nodes: EngineNode[] = [
      { id: 'trigger', type: 'trigger', trigger: 'survey.response_filtered' },
      { id: 'action_0', type: 'action', action: 'notify.slack' },
    ];
    const edges: EngineEdge[] = [{ from: 'trigger', to: 'action_0' }];
    expect(resolveEditRoute(nodes, edges)).toBe(ROUTES.WORKFLOW_BUILD);
  });

  it('routes a branching workflow (condition with true/false edges) to the canvas builder', () => {
    const nodes: EngineNode[] = [
      { id: 'trigger', type: 'trigger', trigger: 'survey.response_filtered' },
      { id: 'cond', type: 'condition', conditions: { operator: 'AND', rules: [{ field: 'nps', op: 'lte', value: 6 }] } },
      { id: 'action_true', type: 'action', action: 'notify.slack' },
      { id: 'action_false', type: 'action', action: 'notify.in_app' },
    ];
    const edges: EngineEdge[] = [
      { from: 'trigger', to: 'cond' },
      { from: 'cond', to: 'action_true', branch: 'true' },
      { from: 'cond', to: 'action_false', branch: 'false' },
    ];
    expect(resolveEditRoute(nodes, edges)).toBe(ROUTES.WORKFLOW_CANVAS);
  });

  it('routes a workflow with more than one condition node to the canvas builder even without branches', () => {
    const nodes: EngineNode[] = [
      { id: 'trigger', type: 'trigger', trigger: 'survey.response_filtered' },
      { id: 'cond_1', type: 'condition', conditions: { operator: 'AND', rules: [{ field: 'nps', op: 'lte', value: 6 }] } },
      { id: 'cond_2', type: 'condition', conditions: { operator: 'AND', rules: [{ field: 'sentiment', op: 'eq', value: 'negative' }] } },
      { id: 'action_0', type: 'action', action: 'notify.slack' },
    ];
    const edges: EngineEdge[] = [
      { from: 'trigger', to: 'cond_1' },
      { from: 'cond_1', to: 'cond_2' },
      { from: 'cond_2', to: 'action_0' },
    ];
    expect(resolveEditRoute(nodes, edges)).toBe(ROUTES.WORKFLOW_CANVAS);
  });

  it('defaults to the linear builder for empty nodes/edges', () => {
    expect(resolveEditRoute([], [])).toBe(ROUTES.WORKFLOW_BUILD);
    expect(resolveEditRoute()).toBe(ROUTES.WORKFLOW_BUILD);
  });
});
