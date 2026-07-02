import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { StepPanel } from '../../../../components/workflow-builder/sentence/StepPanel';

afterEach(cleanup);

describe('StepPanel — mount/unmount', () => {
  it('renders nothing when closed', () => {
    render(<StepPanel open={false} label="Choosing your trigger" onCancel={() => {}} onDone={() => {}} testId="panel">content</StepPanel>);
    expect(screen.queryByTestId('panel')).not.toBeInTheDocument();
  });

  it('renders the label and children when open', () => {
    render(<StepPanel open label="Choosing your trigger" onCancel={() => {}} onDone={() => {}} testId="panel"><p>body content</p></StepPanel>);
    expect(screen.getByTestId('panel')).toBeInTheDocument();
    expect(screen.getByText('Choosing your trigger')).toBeInTheDocument();
    expect(screen.getByText('body content')).toBeInTheDocument();
  });
});

describe('StepPanel — Done / Cancel', () => {
  it('Done is disabled when doneDisabled is true', () => {
    render(<StepPanel open label="x" onCancel={() => {}} onDone={() => {}} doneDisabled testId="panel">c</StepPanel>);
    expect(screen.getByRole('button', { name: /done/i })).toBeDisabled();
  });

  it('clicking Done calls onDone', async () => {
    const user = userEvent.setup();
    const onDone = vi.fn();
    render(<StepPanel open label="x" onCancel={() => {}} onDone={onDone} testId="panel">c</StepPanel>);
    await user.click(screen.getByRole('button', { name: /done/i }));
    expect(onDone).toHaveBeenCalledOnce();
  });

  it('clicking Cancel calls onCancel', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<StepPanel open label="x" onCancel={onCancel} onDone={() => {}} testId="panel">c</StepPanel>);
    await user.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('clicking the back-chevron also calls onCancel', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<StepPanel open label="x" onCancel={onCancel} onDone={() => {}} testId="panel">c</StepPanel>);
    await user.click(screen.getByLabelText(/back to sentence/i));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
