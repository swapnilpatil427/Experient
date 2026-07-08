import { describe, it, expect } from 'vitest';
import {
  serializeBuilderCanvas, addCard, removeCard, moveCard, updateCard,
  type CanvasCardState,
} from '../../lib/builderCanvas';

describe('builderCanvas — serializeBuilderCanvas', () => {
  it('serializes trigger + conditions + actions into the linear engine shape', () => {
    const cards: CanvasCardState[] = [
      { id: 't', kind: 'trigger', triggerType: 'score.nps_drop' },
      { id: 'c1', kind: 'condition', field: 'nps', op: 'lte', value: '6' },
      { id: 'a1', kind: 'action', action: 'notify.slack' },
      { id: 'a2', kind: 'action', action: 'jira.create_issue' },
    ];
    const { nodes, edges } = serializeBuilderCanvas(cards);
    expect(nodes[0]).toMatchObject({ id: 'trigger', type: 'trigger', trigger: 'score.nps_drop' });
    expect(nodes[1]).toMatchObject({
      id: 'cond', type: 'condition',
      conditions: { operator: 'AND', rules: [{ field: 'nps', op: 'lte', value: 6 }] },
    });
    expect(nodes[2]).toMatchObject({ id: 'action_0', action: 'notify.slack' });
    expect(nodes[3]).toMatchObject({ id: 'action_1', action: 'jira.create_issue' });
    expect(edges).toEqual([
      { from: 'trigger', to: 'cond' },
      { from: 'cond', to: 'action_0' },
      { from: 'action_0', to: 'action_1' },
    ]);
  });

  it('omits the condition node entirely when there are no conditions', () => {
    const cards: CanvasCardState[] = [
      { id: 't', kind: 'trigger', triggerType: 'time.schedule' },
      { id: 'a1', kind: 'action', action: 'notify.in_app' },
    ];
    const { nodes } = serializeBuilderCanvas(cards);
    expect(nodes.map((n) => n.type)).toEqual(['trigger', 'action']);
  });

  it('coerces numeric condition values to numbers', () => {
    const cards: CanvasCardState[] = [
      { id: 't', kind: 'trigger', triggerType: 'score.nps_drop' },
      { id: 'c1', kind: 'condition', field: 'nps', op: 'lte', value: '6' },
      { id: 'a1', kind: 'action', action: 'notify.slack' },
    ];
    const { nodes } = serializeBuilderCanvas(cards);
    const cond = nodes.find((n) => n.type === 'condition');
    expect(cond?.conditions?.rules[0].value).toBe(6);
  });

  it('persists the trigger node config (e.g. schedule cron + scheduleUiState) verbatim', () => {
    const cards: CanvasCardState[] = [
      { id: 't', kind: 'trigger', triggerType: 'time.schedule', config: { cron: '0 9 * * 1', scheduleUiState: { frequency: 'weekly' } } },
      { id: 'a1', kind: 'action', action: 'notify.in_app' },
    ];
    const { nodes } = serializeBuilderCanvas(cards);
    expect(nodes[0].config).toEqual({ cron: '0 9 * * 1', scheduleUiState: { frequency: 'weekly' } });
  });
});

describe('builderCanvas — addCard', () => {
  it('inserting a trigger replaces any existing trigger card', () => {
    const cards: CanvasCardState[] = [{ id: 't1', kind: 'trigger', triggerType: 'score.nps_drop' }];
    const next = addCard(cards, { id: 't2', kind: 'trigger', triggerType: 'time.schedule' });
    expect(next).toHaveLength(1);
    expect(next[0].id).toBe('t2');
  });

  it('inserts a condition after the last existing condition, before any actions', () => {
    const cards: CanvasCardState[] = [
      { id: 't', kind: 'trigger', triggerType: 'score.nps_drop' },
      { id: 'c1', kind: 'condition', field: 'nps' },
      { id: 'a1', kind: 'action', action: 'notify.slack' },
    ];
    const next = addCard(cards, { id: 'c2', kind: 'condition', field: 'csat' });
    expect(next.map((c) => c.id)).toEqual(['t', 'c1', 'c2', 'a1']);
  });

  it('appends actions to the end', () => {
    const cards: CanvasCardState[] = [{ id: 't', kind: 'trigger', triggerType: 'score.nps_drop' }];
    const next = addCard(cards, { id: 'a1', kind: 'action', action: 'notify.slack' });
    expect(next.map((c) => c.id)).toEqual(['t', 'a1']);
  });
});

describe('builderCanvas — removeCard / updateCard / moveCard', () => {
  it('removeCard removes by id', () => {
    const cards: CanvasCardState[] = [{ id: 'a', kind: 'action', action: 'x' }, { id: 'b', kind: 'action', action: 'y' }];
    expect(removeCard(cards, 'a').map((c) => c.id)).toEqual(['b']);
  });

  it('updateCard patches only the matching card', () => {
    const cards: CanvasCardState[] = [{ id: 'a', kind: 'action', action: 'x' }];
    const next = updateCard(cards, 'a', { action: 'y' });
    expect(next[0].action).toBe('y');
  });

  it('moveCard swaps adjacent cards of the same kind (up/down substitute for drag-reorder)', () => {
    const cards: CanvasCardState[] = [
      { id: 'a1', kind: 'action', action: 'x' },
      { id: 'a2', kind: 'action', action: 'y' },
    ];
    const movedDown = moveCard(cards, 'a1', 'down');
    expect(movedDown.map((c) => c.id)).toEqual(['a2', 'a1']);
    const movedUp = moveCard(movedDown, 'a1', 'up');
    expect(movedUp.map((c) => c.id)).toEqual(['a1', 'a2']);
  });

  it('moveCard refuses to cross kind boundaries', () => {
    const cards: CanvasCardState[] = [
      { id: 't', kind: 'trigger', triggerType: 'score.nps_drop' },
      { id: 'a1', kind: 'action', action: 'x' },
    ];
    const next = moveCard(cards, 'a1', 'up');
    expect(next.map((c) => c.id)).toEqual(['t', 'a1']); // unchanged
  });

  it('moveCard is a no-op at the boundary', () => {
    const cards: CanvasCardState[] = [{ id: 'a1', kind: 'action', action: 'x' }];
    expect(moveCard(cards, 'a1', 'up')).toEqual(cards);
    expect(moveCard(cards, 'a1', 'down')).toEqual(cards);
  });
});
