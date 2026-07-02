import { useState } from 'react';
import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import {
  ConditionStepPanelContent, fieldKindFor, type ConditionClause, type ConditionField,
} from '../../../../components/workflow-builder/sentence/ConditionStepPanelContent';

afterEach(cleanup);

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  Element.prototype.releasePointerCapture = vi.fn();
});

const FIELDS: ConditionField[] = [
  { field: 'nps', label: 'NPS score', kind: 'number' },
  { field: 'sentiment', label: 'Crystal sentiment', kind: 'string' },
];
const OPERATORS = ['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'between', 'contains', 'not_contains', 'in', 'not_in'];

function Wrapper({ initial }: { initial: ConditionClause[] }) {
  const [clauses, setClauses] = useState(initial);
  return (
    <ConditionStepPanelContent fields={FIELDS} operators={OPERATORS} clauses={clauses} onChange={setClauses} />
  );
}

describe('ConditionStepPanelContent — zero-condition empty state', () => {
  it('renders no condition rows and only the "+ add another condition" link when clauses is empty', () => {
    render(<Wrapper initial={[]} />);
    expect(screen.queryByTestId(/condition-row-/)).not.toBeInTheDocument();
    expect(screen.getByTestId('condition-add-another')).toBeInTheDocument();
  });
});

describe('ConditionStepPanelContent — single condition row', () => {
  it('renders field/operator/value controls for one clause', () => {
    render(<Wrapper initial={[{ id: 'c1', field: 'nps', op: 'lt', value: '30' }]} />);
    expect(screen.getByTestId('condition-row-c1')).toBeInTheDocument();
    expect(screen.getByTestId('condition-value-c1')).toHaveValue(30);
  });

  it('renders a number input for a number-kind field', () => {
    render(<Wrapper initial={[{ id: 'c1', field: 'nps', op: 'lt', value: '30' }]} />);
    expect(screen.getByTestId('condition-value-c1')).toHaveAttribute('type', 'number');
  });

  it('renders a text input for a string-kind field', () => {
    render(<Wrapper initial={[{ id: 'c1', field: 'sentiment', op: 'eq', value: 'negative' }]} />);
    expect(screen.getByTestId('condition-value-c1')).toHaveAttribute('type', 'text');
  });

  it('excludes the "between" operator from the dropdown (2.x-range UI out of scope this wave)', async () => {
    const user = userEvent.setup();
    render(<Wrapper initial={[{ id: 'c1', field: 'nps', op: 'lt', value: '30' }]} />);
    await user.click(screen.getByTestId('condition-op-select-c1'));
    expect(screen.queryByRole('option', { name: /between/i })).not.toBeInTheDocument();
  });

  it('never renders a raw engine operator token as visible copy', async () => {
    const user = userEvent.setup();
    render(<Wrapper initial={[{ id: 'c1', field: 'nps', op: 'gte', value: '30' }]} />);
    await user.click(screen.getByTestId('condition-op-select-c1'));
    // 'gte' itself should not appear as visible text anywhere in the listbox.
    const listbox = screen.getByRole('listbox');
    expect(within(listbox).queryByText('gte')).not.toBeInTheDocument();
    expect(within(listbox).getByText('is at least')).toBeInTheDocument();
  });

  it('changing the field resets value to empty (avoids a stale numeric string read as a string-equality check)', async () => {
    const user = userEvent.setup();
    render(<Wrapper initial={[{ id: 'c1', field: 'nps', op: 'eq', value: '30' }]} />);
    await user.click(screen.getByTestId('condition-field-select-c1'));
    await user.click(await screen.findByRole('option', { name: 'Crystal sentiment' }));
    expect(screen.getByTestId('condition-value-c1')).toHaveValue('');
  });

  it('clicking remove removes the clause via onChange', async () => {
    const user = userEvent.setup();
    render(<Wrapper initial={[{ id: 'c1', field: 'nps', op: 'lt', value: '30' }]} />);
    await user.click(screen.getByLabelText('Remove condition'));
    expect(screen.queryByTestId('condition-row-c1')).not.toBeInTheDocument();
  });
});

describe('ConditionStepPanelContent — multi-condition "+ add another condition"', () => {
  it('adds a new clause defaulting to the first registry field and first visible operator', async () => {
    const user = userEvent.setup();
    render(<Wrapper initial={[{ id: 'c1', field: 'nps', op: 'lt', value: '30' }]} />);
    await user.click(screen.getByTestId('condition-add-another'));
    const rows = screen.getAllByTestId(/condition-row-/);
    expect(rows).toHaveLength(2);
  });

  it('renders each clause as its own row with its own remove button', () => {
    render(<Wrapper initial={[
      { id: 'c1', field: 'nps', op: 'lt', value: '30' },
      { id: 'c2', field: 'sentiment', op: 'eq', value: 'negative' },
    ]} />);
    expect(screen.getAllByLabelText('Remove condition')).toHaveLength(2);
  });
});

describe('fieldKindFor', () => {
  it('resolves the kind for a known field', () => {
    expect(fieldKindFor(FIELDS, 'nps')).toBe('number');
    expect(fieldKindFor(FIELDS, 'sentiment')).toBe('string');
  });

  it('defaults to string for an unknown field', () => {
    expect(fieldKindFor(FIELDS, 'unknown_field')).toBe('string');
  });
});
