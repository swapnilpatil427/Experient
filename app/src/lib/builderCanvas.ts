// Pure helpers for the Unified Builder's vertical card-stack canvas
// (BUILDER_REBUILD_SPEC.md §2.3). Deliberately NOT reactflow-based — this is a
// linear ordered list, not a free-form graph (that remains WorkflowCanvasPage's
// job). Kept separate from the page component so serialization logic is
// unit-testable without mounting React.

export type CanvasCardKind = 'trigger' | 'condition' | 'action';

export interface CanvasCardState {
  id: string;
  kind: CanvasCardKind;
  // Trigger cards:
  triggerType?: string;
  scheduleConfig?: unknown; // ScheduleConfigState, kept as unknown here to avoid a circular import
  // Condition cards:
  field?: string;
  op?: string;
  value?: string;
  // Action cards:
  action?: string;
  config?: Record<string, unknown>;
}

export interface SerializedNode {
  id: string;
  type: CanvasCardKind;
  trigger?: string;
  action?: string;
  config?: Record<string, unknown>;
  conditions?: { operator: string; rules: Array<{ field?: string; op?: string; value: unknown }> };
}

export interface SerializedEdge {
  from: string;
  to: string;
}

function coerce(v: unknown): unknown {
  if (v == null || v === '') return v;
  const n = Number(v);
  return Number.isNaN(n) ? v : n;
}

// Reuses the existing linear serialization shape from the pre-rewrite
// WorkflowBuilderPage.tsx.save() — trigger node + one condition node holding
// an AND rule array + ordered action nodes — per spec §2.3's explicit
// direction NOT to adapt workflowCanvas.ts's graph serializer (positions,
// EngineEdge[]) for this linear surface.
export function serializeBuilderCanvas(cards: CanvasCardState[]): { nodes: SerializedNode[]; edges: SerializedEdge[] } {
  const triggerCard = cards.find((c) => c.kind === 'trigger');
  const conditionCards = cards.filter((c) => c.kind === 'condition');
  const actionCards = cards.filter((c) => c.kind === 'action');

  const nodes: SerializedNode[] = [];
  if (triggerCard) {
    const config: Record<string, unknown> = {};
    if (triggerCard.triggerType === 'time.schedule' && triggerCard.scheduleConfig) {
      // Populated by the caller (WorkflowBuilderPage) via buildCronFromConfig()
      // + the raw scheduleUiState — kept as unknown/passthrough here to avoid a
      // circular dependency between builderCanvas.ts and scheduleConfig.ts.
      Object.assign(config, triggerCard.config ?? {});
    } else if (triggerCard.config) {
      Object.assign(config, triggerCard.config);
    }
    nodes.push({
      id: 'trigger',
      type: 'trigger',
      trigger: triggerCard.triggerType,
      ...(Object.keys(config).length ? { config } : {}),
    });
  }

  if (conditionCards.length) {
    nodes.push({
      id: 'cond',
      type: 'condition',
      conditions: {
        operator: 'AND',
        rules: conditionCards
          .filter((c) => c.field && c.value !== undefined)
          .map((c) => ({ field: c.field, op: c.op, value: coerce(c.value) })),
      },
    });
  }

  actionCards.forEach((c, i) => {
    nodes.push({ id: `action_${i}`, type: 'action', action: c.action, config: c.config ?? {} });
  });

  const edges: SerializedEdge[] = nodes.slice(1).map((n, i) => ({ from: nodes[i].id, to: n.id }));
  return { nodes, edges };
}

let cardSeq = 0;
export function newCardId(kind: CanvasCardKind): string {
  cardSeq += 1;
  return `${kind}_${Date.now()}_${cardSeq}`;
}

// Inserts a new card at the end of its kind-group (triggers first, then
// conditions, then actions) — matches the engine's node ordering
// expectations and keeps the vertical stack visually grouped by kind.
export function addCard(cards: CanvasCardState[], card: CanvasCardState): CanvasCardState[] {
  if (card.kind === 'trigger') {
    // Only one trigger card is meaningful in the linear model — replace any existing one.
    return [card, ...cards.filter((c) => c.kind !== 'trigger')];
  }
  if (card.kind === 'condition') {
    const lastConditionIdx = findLastIndex(cards, (c) => c.kind === 'condition');
    const insertAt = lastConditionIdx >= 0 ? lastConditionIdx + 1 : cards.findIndex((c) => c.kind === 'action');
    const idx = insertAt === -1 ? cards.length : insertAt;
    return [...cards.slice(0, idx), card, ...cards.slice(idx)];
  }
  return [...cards, card];
}

function findLastIndex<T>(arr: T[], pred: (x: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return i;
  return -1;
}

export function removeCard(cards: CanvasCardState[], id: string): CanvasCardState[] {
  return cards.filter((c) => c.id !== id);
}

export function moveCard(cards: CanvasCardState[], id: string, direction: 'up' | 'down'): CanvasCardState[] {
  const idx = cards.findIndex((c) => c.id === id);
  if (idx === -1) return cards;
  const swapWith = direction === 'up' ? idx - 1 : idx + 1;
  if (swapWith < 0 || swapWith >= cards.length) return cards;
  // Only allow reordering within the same kind-group (matches addCard's grouping).
  if (cards[swapWith].kind !== cards[idx].kind) return cards;
  const next = [...cards];
  [next[idx], next[swapWith]] = [next[swapWith], next[idx]];
  return next;
}

export function updateCard(cards: CanvasCardState[], id: string, patch: Partial<CanvasCardState>): CanvasCardState[] {
  return cards.map((c) => (c.id === id ? { ...c, ...patch } : c));
}
