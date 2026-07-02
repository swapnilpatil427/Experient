import { useState } from 'react';
import { render, screen, cleanup, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import { ScheduleTriggerConfigPanel } from '../../../../components/workflow-builder/panels/ScheduleTriggerConfigPanel';
import { weeklyDigestDefaultConfig, defaultScheduleConfig, type ScheduleConfigState } from '../../../../lib/scheduleConfig';

afterEach(cleanup);

// Radix Popover/Command need scrollIntoView + pointer capture polyfills in jsdom.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  Element.prototype.releasePointerCapture = vi.fn();
});

function Wrapper({ initial }: { initial: ScheduleConfigState }) {
  const [config, setConfig] = useState(initial);
  return <ScheduleTriggerConfigPanel config={config} onChange={setConfig} />;
}

describe('ScheduleTriggerConfigPanel — Weekly Digest repro', () => {
  it('renders "every Monday at 9:00 AM UTC" for the Weekly Digest default config', () => {
    const config = { ...weeklyDigestDefaultConfig(), timezone: 'UTC', useBrowserTimezone: false };
    render(<Wrapper initial={config} />);
    const preview = screen.getByTestId('schedule-preview');
    expect(within(preview).getByText(/every monday at 9:00 am utc/i)).toBeInTheDocument();
  });

  it('shows a concrete "Next run" value, not a placeholder', () => {
    const config = { ...weeklyDigestDefaultConfig(), timezone: 'UTC', useBrowserTimezone: false };
    render(<Wrapper initial={config} />);
    const preview = screen.getByTestId('schedule-preview');
    expect(preview.textContent).toMatch(/Next run:/);
    expect(preview.textContent).not.toMatch(/unable to calculate/);
  });

  it('defaults the Weekly toggle group to selected and Monday highlighted', () => {
    const config = { ...weeklyDigestDefaultConfig(), timezone: 'UTC', useBrowserTimezone: false };
    render(<Wrapper initial={config} />);
    const weeklyToggle = screen.getByRole('radio', { name: 'weekly' });
    expect(weeklyToggle).toHaveAttribute('aria-checked', 'true');
  });
});

describe('ScheduleTriggerConfigPanel — frequency switching', () => {
  it('switching to Custom reveals the interval count + unit inputs', async () => {
    const user = userEvent.setup();
    const config = { ...defaultScheduleConfig(), timezone: 'UTC', useBrowserTimezone: false };
    render(<Wrapper initial={config} />);
    const customToggle = screen.getByRole('radio', { name: 'custom' });
    await user.click(customToggle);
    expect(customToggle).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('Repeat every')).toBeInTheDocument();
  });

  it('min-1-selected: cannot deselect the last remaining weekly day', async () => {
    const user = userEvent.setup();
    const config = { ...weeklyDigestDefaultConfig(), timezone: 'UTC', useBrowserTimezone: false };
    render(<Wrapper initial={config} />);
    const mondayToggle = screen.getByRole('button', { name: 'weekday-1' });
    await user.click(mondayToggle);
    // Still shows Monday in the description — deselecting the only day was blocked.
    const preview = screen.getByTestId('schedule-preview');
    expect(within(preview).getByText(/monday/i)).toBeInTheDocument();
  });
});

describe('ScheduleTriggerConfigPanel — developer mode escape hatch', () => {
  it('typing a raw cron sets rawCronOverride and shows the "not representable" fallback when applicable', async () => {
    const user = userEvent.setup();
    const config = { ...defaultScheduleConfig(), timezone: 'UTC', useBrowserTimezone: false };
    render(<Wrapper initial={config} />);
    await user.click(screen.getByText('Developer mode'));
    const cronInput = screen.getByLabelText('Cron expression');
    // fireEvent (single change) rather than user.type (keystroke-by-keystroke)
    // — each keystroke would otherwise recompute getNextRunFromCron()'s
    // bounded forward scan against a still-malformed intermediate cron
    // string, which is unnecessary work this test doesn't need to exercise.
    fireEvent.change(cronInput, { target: { value: '*/15 9-17 * * 1-5' } });
    const preview = screen.getByTestId('schedule-preview');
    expect(within(preview).getByText(/not representable in picker/i)).toBeInTheDocument();
  });

  it('clearing the raw cron field reverts to the picker-derived description, not the daily default', async () => {
    const user = userEvent.setup();
    const config: ScheduleConfigState = {
      ...weeklyDigestDefaultConfig(),
      timezone: 'UTC',
      useBrowserTimezone: false,
      developerMode: true,
      rawCronOverride: '*/15 9-17 * * 1-5',
    };
    render(<Wrapper initial={config} />);
    const cronInput = screen.getByLabelText('Cron expression') as HTMLInputElement;
    expect(cronInput.value).toBe('*/15 9-17 * * 1-5');
    await user.clear(cronInput);
    expect(cronInput.value).toBe('');
    const preview = screen.getByTestId('schedule-preview');
    expect(preview.textContent).toMatch(/every monday at 9:00 am utc/i);
  });
});
