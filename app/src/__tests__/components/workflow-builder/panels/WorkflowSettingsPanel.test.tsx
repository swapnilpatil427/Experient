import { useState } from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, afterEach } from 'vitest';
import { WorkflowSettingsPanel } from '../../../../components/workflow-builder/panels/WorkflowSettingsPanel';

afterEach(cleanup);

function Wrapper({ initial, triggerType }: { initial: number | null; triggerType?: string | null }) {
  const [cooldown, setCooldown] = useState<number | null>(initial);
  return <WorkflowSettingsPanel cooldownMinutes={cooldown} onChange={setCooldown} triggerType={triggerType} />;
}

describe('WorkflowSettingsPanel — defaults', () => {
  it('defaults to the 1-hour preset pre-selected when no trigger is on canvas', () => {
    render(<Wrapper initial={60} />);
    expect(screen.getByRole('radio', { name: '1 hour' })).toHaveAttribute('data-state', 'checked');
  });
});

describe('WorkflowSettingsPanel — round trip (C-004, spec §7 test plan item 6)', () => {
  it('selecting "4 hours" re-selects correctly after being set (simulated save/reload via remount)', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Wrapper initial={60} />);
    await user.click(screen.getByRole('radio', { name: '4 hours' }));
    expect(screen.getByRole('radio', { name: '4 hours' })).toHaveAttribute('data-state', 'checked');
    unmount();

    // Simulated reload: remount with the persisted value (240) as the initial prop.
    render(<Wrapper initial={240} />);
    expect(screen.getByRole('radio', { name: '4 hours' })).toHaveAttribute('data-state', 'checked');
  });

  it('Custom: 90 minutes round-trips as Custom selected with 90 in the input, not the nearest preset', async () => {
    const user = userEvent.setup();
    render(<Wrapper initial={90} />);
    const customRadios = screen.getAllByRole('radio', { name: /custom/i });
    const checkedCustom = customRadios.find((r) => r.getAttribute('data-state') === 'checked');
    expect(checkedCustom).toBeTruthy();
    const inputs = screen.getAllByRole('spinbutton') as HTMLInputElement[];
    expect(inputs.some((i) => i.value === '90')).toBe(true);
  });

  it('clicking the Custom radio enables its input for typing', async () => {
    const user = userEvent.setup();
    render(<Wrapper initial={60} />);
    await user.click(screen.getByRole('radio', { name: /custom/i }));
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    expect(input).toBeEnabled();
    await user.type(input, '5');
    expect(input.value).toContain('5');
  });

  it('selecting time.schedule as the trigger disables the cooldown group and shows "Not applicable"', () => {
    render(<Wrapper initial={60} triggerType="time.schedule" />);
    expect(screen.getByTestId('cooldown-not-applicable')).toBeInTheDocument();
    expect(screen.queryByTestId('cooldown-radio-group')).not.toBeInTheDocument();
  });

  it('does not show "Not applicable" for a non-schedule trigger', () => {
    render(<Wrapper initial={60} triggerType="score.nps_drop" />);
    expect(screen.queryByTestId('cooldown-not-applicable')).not.toBeInTheDocument();
    expect(screen.getByTestId('cooldown-radio-group')).toBeInTheDocument();
  });
});
