import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { ActionClauseList } from '../../../../components/workflow-builder/sentence/ActionClauseList';

afterEach(cleanup);

const CLAUSES = [
  { id: 'a1', action: 'notify.slack', label: 'Slack message' },
  { id: 'a2', action: 'notify.email', label: 'Email' },
];

describe('ActionClauseList — add/remove/reorder', () => {
  it('renders nothing when the clause list is empty', () => {
    render(<ActionClauseList clauses={[]} onReorder={() => {}} onRemove={() => {}} onEdit={() => {}} />);
    expect(screen.queryByTestId('action-clause-list')).not.toBeInTheDocument();
  });

  it('renders one clause per action with its label', () => {
    render(<ActionClauseList clauses={CLAUSES} onReorder={() => {}} onRemove={() => {}} onEdit={() => {}} />);
    expect(screen.getByText('Slack message')).toBeInTheDocument();
    expect(screen.getByText('Email')).toBeInTheDocument();
  });

  it('clicking a clause label calls onEdit with its id', async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    render(<ActionClauseList clauses={CLAUSES} onReorder={() => {}} onRemove={() => {}} onEdit={onEdit} />);
    await user.click(screen.getByText('Slack message'));
    expect(onEdit).toHaveBeenCalledWith('a1');
  });

  it('clicking the remove (x) button calls onRemove with its id', async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    render(<ActionClauseList clauses={CLAUSES} onReorder={() => {}} onRemove={onRemove} onEdit={() => {}} />);
    const clause = screen.getByTestId('action-clause-a1');
    await user.click(clause.querySelector('[aria-label="Remove action"]')!);
    expect(onRemove).toHaveBeenCalledWith('a1');
  });

  it('renders a drag handle on each clause for reordering', () => {
    render(<ActionClauseList clauses={CLAUSES} onReorder={() => {}} onRemove={() => {}} onEdit={() => {}} />);
    expect(screen.getByTestId('action-clause-a1').querySelector('[aria-label="Drag to reorder"]')).toBeTruthy();
    expect(screen.getByTestId('action-clause-a2').querySelector('[aria-label="Drag to reorder"]')).toBeTruthy();
  });
});

// Wave 11, Rohan WAVE11_UX_SPECS.md §2.3 — Flow-category actions (flow.delay/
// flow.approval/flow.stop) get a distinct amber/pause-icon pill so a customer
// can tell at a glance which clause pauses the chain.
describe('ActionClauseList — Flow-category pill treatment', () => {
  const MIXED_CLAUSES = [
    { id: 'a1', action: 'notify.slack', label: 'Slack message', category: 'Notify' },
    { id: 'a2', action: 'flow.delay', label: 'Wait 2 hours', category: 'Flow' },
  ];

  it('gives a Flow-category clause the amber data-category marker and a pause icon', () => {
    render(<ActionClauseList clauses={MIXED_CLAUSES} onReorder={() => {}} onRemove={() => {}} onEdit={() => {}} />);
    const flowClause = screen.getByTestId('action-clause-a2');
    expect(flowClause).toHaveAttribute('data-category', 'Flow');
    expect(flowClause.className).toMatch(/warning/);
    const iconNames = Array.from(flowClause.querySelectorAll('.material-symbols-outlined')).map((el) => el.textContent);
    expect(iconNames).toContain('pause_circle');
  });

  it('leaves a non-Flow clause on the default primary-tinted pill with no pause icon', () => {
    render(<ActionClauseList clauses={MIXED_CLAUSES} onReorder={() => {}} onRemove={() => {}} onEdit={() => {}} />);
    const notifyClause = screen.getByTestId('action-clause-a1');
    expect(notifyClause).toHaveAttribute('data-category', 'Notify');
    expect(notifyClause.className).toMatch(/primary/);
    expect(notifyClause.className).not.toMatch(/warning/);
  });

  it('a clause with no category falls back to the default primary-tinted pill (backward compatible)', () => {
    render(<ActionClauseList clauses={CLAUSES} onReorder={() => {}} onRemove={() => {}} onEdit={() => {}} />);
    expect(screen.getByTestId('action-clause-a1').className).toMatch(/primary/);
  });
});
