import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { ScopeOptionCard } from '../../../../components/workflow-builder/sentence/ScopeOptionCard';

afterEach(cleanup);

describe('ScopeOptionCard', () => {
  it('renders label, subtext, and calls onSelect when clicked', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <ScopeOptionCard
        icon="public" label="Org-wide" subtext="Applies to every survey" selected={false}
        onSelect={onSelect} testId="card"
      />,
    );
    expect(screen.getByText('Org-wide')).toBeInTheDocument();
    expect(screen.getByText('Applies to every survey')).toBeInTheDocument();
    await user.click(screen.getByRole('button'));
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it('shows the consequence line only when selected', () => {
    const { rerender } = render(
      <ScopeOptionCard icon="public" label="Org-wide" subtext="s" consequence="Evaluates every response" selected={false} onSelect={() => {}} testId="card" />,
    );
    expect(screen.queryByText('Evaluates every response')).not.toBeInTheDocument();
    rerender(
      <ScopeOptionCard icon="public" label="Org-wide" subtext="s" consequence="Evaluates every response" selected onSelect={() => {}} testId="card" />,
    );
    expect(screen.getByText('Evaluates every response')).toBeInTheDocument();
  });

  it('renders disabled with a reason and does not fire onSelect when clicked', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <ScopeOptionCard
        icon="description" label="A specific survey" subtext="s" selected={false} disabled
        disabledReason="Not available — this trigger type applies to the whole org."
        onSelect={onSelect} testId="card"
      />,
    );
    expect(screen.getByText(/Not available/)).toBeInTheDocument();
    await user.click(screen.getByRole('button'));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('renders children (the inline picker) only when selected and not disabled', () => {
    const { rerender } = render(
      <ScopeOptionCard icon="description" label="Survey" subtext="s" selected={false} onSelect={() => {}} testId="card">
        <div data-testid="inline-picker" />
      </ScopeOptionCard>,
    );
    expect(screen.queryByTestId('inline-picker')).not.toBeInTheDocument();
    rerender(
      <ScopeOptionCard icon="description" label="Survey" subtext="s" selected onSelect={() => {}} testId="card">
        <div data-testid="inline-picker" />
      </ScopeOptionCard>,
    );
    expect(screen.getByTestId('inline-picker')).toBeInTheDocument();
  });
});
