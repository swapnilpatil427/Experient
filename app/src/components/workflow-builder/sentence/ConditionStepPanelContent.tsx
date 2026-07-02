import { useTranslation } from '../../../lib/i18n';
import { Icon } from '../../Icon';
import { Input } from '@/components/ui/input';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';

// Condition-step in the sentence builder (Wave 11, Rohan Desai —
// docs/automation-hub/WAVE11_UX_SPECS.md §1.3). Same file-per-step-type
// convention as TriggerStepPanelContent.tsx/ActionStepPanelContent.tsx: reads
// the registry's conditionFields/conditionOperators, doesn't own its own copy
// of that data.
export interface ConditionField { field: string; label: string; kind: 'number' | 'string' }

export interface ConditionClause {
  id: string;
  field: string;
  op: string;
  // Always stored as a string in UI state; coerced at serialize time per the
  // field's `kind` (WorkflowBuilderPage.tsx's serialize()/coerceValue).
  value: string;
}

export interface ConditionStepPanelContentProps {
  fields: ConditionField[];
  operators: string[];
  clauses: ConditionClause[];
  onChange: (clauses: ConditionClause[]) => void;
}

// Never render the raw engine token ('gte' etc.) as user-facing copy.
const OPERATOR_LABEL_KEYS: Record<string, string> = {
  eq: 'workflows.builder.sentence.condition.op.eq',
  neq: 'workflows.builder.sentence.condition.op.neq',
  gt: 'workflows.builder.sentence.condition.op.gt',
  lt: 'workflows.builder.sentence.condition.op.lt',
  gte: 'workflows.builder.sentence.condition.op.gte',
  lte: 'workflows.builder.sentence.condition.op.lte',
  contains: 'workflows.builder.sentence.condition.op.contains',
  not_contains: 'workflows.builder.sentence.condition.op.notContains',
  in: 'workflows.builder.sentence.condition.op.in',
  not_in: 'workflows.builder.sentence.condition.op.notIn',
};

// `between` needs a two-input min/max range UI that doesn't fit this wave's
// single-value-input row — deliberately excluded from the dropdown (spec
// §1.3, "UI-only omission", the engine still supports it for anything that
// sets it directly, e.g. a future canvas enhancement).
const HIDDEN_OPERATORS = new Set(['between']);

export function fieldKindFor(fields: ConditionField[], fieldKey: string): 'number' | 'string' {
  return fields.find((f) => f.field === fieldKey)?.kind ?? 'string';
}

export function ConditionStepPanelContent({ fields, operators, clauses, onChange }: ConditionStepPanelContentProps) {
  const { t } = useTranslation();
  const visibleOperators = operators.filter((op) => !HIDDEN_OPERATORS.has(op));

  function updateClause(id: string, patch: Partial<ConditionClause>) {
    onChange(clauses.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }

  function removeClause(id: string) {
    onChange(clauses.filter((c) => c.id !== id));
  }

  function addClause() {
    const defaultField = fields[0]?.field ?? '';
    const defaultOp = visibleOperators[0] ?? 'eq';
    onChange([...clauses, { id: newConditionId(), field: defaultField, op: defaultOp, value: '' }]);
  }

  return (
    <div className="space-y-3" data-testid="condition-step-panel-content">
      {clauses.map((clause) => {
        const kind = fieldKindFor(fields, clause.field);
        return (
          <div key={clause.id} className="flex items-center gap-2" data-testid={`condition-row-${clause.id}`}>
            <Select
              value={clause.field}
              onValueChange={(v) => updateClause(clause.id, { field: v, value: '' })}
            >
              <SelectTrigger className="w-40" data-testid={`condition-field-select-${clause.id}`}><SelectValue /></SelectTrigger>
              <SelectContent>
                {fields.map((f) => <SelectItem key={f.field} value={f.field}>{f.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select
              value={clause.op}
              onValueChange={(v) => updateClause(clause.id, { op: v })}
            >
              <SelectTrigger className="w-40" data-testid={`condition-op-select-${clause.id}`}><SelectValue /></SelectTrigger>
              <SelectContent>
                {visibleOperators.map((op) => (
                  <SelectItem key={op} value={op}>{t(OPERATOR_LABEL_KEYS[op] ?? op)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {kind === 'number' ? (
              <Input
                type="number"
                className="w-24"
                value={clause.value}
                onChange={(e) => updateClause(clause.id, { value: e.target.value })}
                data-testid={`condition-value-${clause.id}`}
              />
            ) : (
              <Input
                type="text"
                className="w-40"
                value={clause.value}
                onChange={(e) => updateClause(clause.id, { value: e.target.value })}
                placeholder={t('workflows.builder.sentence.condition.valuePlaceholder')}
                data-testid={`condition-value-${clause.id}`}
              />
            )}
            <button
              type="button"
              aria-label={t('workflows.builder.sentence.condition.removeAria')}
              onClick={() => removeClause(clause.id)}
              className="rounded-full hover:bg-accent p-1"
            >
              <Icon name="close" size={14} />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        onClick={addClause}
        className="text-sm font-semibold text-primary hover:underline"
        data-testid="condition-add-another"
      >
        {t('workflows.builder.sentence.condition.addAnother')}
      </button>
    </div>
  );
}

let seq = 0;
function newConditionId(): string {
  seq += 1;
  return `condition_${Date.now()}_${seq}`;
}
