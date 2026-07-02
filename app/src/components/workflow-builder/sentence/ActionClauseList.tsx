import {
  DndContext, closestCenter, PointerSensor, KeyboardSensor, useSensor, useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext, verticalListSortingStrategy, useSortable, arrayMove, sortableKeyboardCoordinates,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Icon } from '../../Icon';
import { useTranslation } from '../../../lib/i18n';
import { cn } from '@/lib/utils';

export interface ActionClause {
  id: string;
  action: string;
  label: string;
  // Wave 11, Rohan WAVE11_UX_SPECS.md §2.3 — lets SortableClause branch on
  // category without a second registry lookup inside this list component.
  // Optional so any pre-existing caller that hasn't threaded it through yet
  // still compiles (falls back to the default primary-tinted pill).
  category?: string;
}

export interface ActionClauseListProps {
  clauses: ActionClause[];
  onReorder: (nextOrder: ActionClause[]) => void;
  onRemove: (id: string) => void;
  onEdit: (id: string) => void;
}

// Repeated ", then <action>" clauses (BUILDER_REDESIGN_V2_CONCEPT.md §7
// component #7) — drag-reorderable via @dnd-kit (already installed, no prior
// in-repo usage pattern to match, so this is a straightforward vertical
// sortable list).
export function ActionClauseList({ clauses, onReorder, onRemove, onEdit }: ActionClauseListProps) {
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = clauses.findIndex((c) => c.id === active.id);
    const newIndex = clauses.findIndex((c) => c.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    onReorder(arrayMove(clauses, oldIndex, newIndex));
  }

  if (clauses.length === 0) return null;

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={clauses.map((c) => c.id)} strategy={verticalListSortingStrategy}>
        <span className="inline-flex flex-wrap items-center gap-2" data-testid="action-clause-list">
          {clauses.map((clause) => (
            <SortableClause key={clause.id} clause={clause} onRemove={onRemove} onEdit={onEdit} />
          ))}
        </span>
      </SortableContext>
    </DndContext>
  );
}

function SortableClause({ clause, onRemove, onEdit }: { clause: ActionClause; onRemove: (id: string) => void; onEdit: (id: string) => void }) {
  const { t } = useTranslation();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: clause.id });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 };
  // Wave 11, Rohan WAVE11_UX_SPECS.md §2.3 — Flow-category actions
  // (flow.approval/flow.stop/flow.delay) get a distinct amber/pause-icon pill
  // so a customer scanning the sentence sees at a glance which clause pauses
  // the chain, instead of every action rendering identically. Additive branch
  // — non-Flow actions keep the exact pre-existing markup/classes.
  const isFlow = clause.category === 'Flow';

  return (
    <span
      ref={setNodeRef}
      style={style}
      data-testid={`action-clause-${clause.id}`}
      data-category={clause.category}
      className={cn(
        'inline-flex items-center gap-1 rounded-full pl-1 pr-2 py-1 text-sm font-semibold',
        isFlow ? 'bg-warning/10 text-warning' : 'bg-primary/10 text-primary',
      )}
    >
      <button type="button" {...attributes} {...listeners} aria-label={t('workflows.builder.sentence.actionClause.dragAria')} className="cursor-grab active:cursor-grabbing p-0.5">
        <Icon name="drag_indicator" size={14} />
      </button>
      {isFlow && <Icon name="pause_circle" size={13} className="opacity-80" />}
      <button type="button" onClick={() => onEdit(clause.id)} className="hover:underline">
        {clause.label}
      </button>
      <button
        type="button"
        aria-label={t('workflows.builder.sentence.actionClause.removeAria')}
        onClick={() => onRemove(clause.id)}
        className={cn('ml-0.5 rounded-full p-0.5', isFlow ? 'hover:bg-warning/20' : 'hover:bg-primary/20')}
      >
        <Icon name="close" size={12} />
      </button>
    </span>
  );
}
