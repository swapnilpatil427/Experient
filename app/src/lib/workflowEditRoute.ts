// Decides which builder page an "Edit" click should open, based purely on the
// shape of the workflow's nodes/edges — no picker, no blanket default. See
// docs/automation-hub/BUILDER_SPEC_WAVE2.md §1.1 for the rationale: most
// workflows are straight lines (trigger → optional condition → ordered
// actions) and the linear builder is the better editing surface for those;
// only real graphs (branches, or more than one condition node) need the
// canvas.
import { ROUTES } from '../constants/routes';
import { hasEngineBranches } from './workflowCanvas';
import type { EngineEdge, EngineNode } from './workflowCanvas';

export function resolveEditRoute(nodes: EngineNode[] = [], edges: EngineEdge[] = []): string {
  const conditionCount = nodes.filter((n) => n.type === 'condition').length;
  if (hasEngineBranches(edges) || conditionCount > 1) {
    return ROUTES.WORKFLOW_CANVAS;
  }
  return ROUTES.WORKFLOW_BUILD;
}
