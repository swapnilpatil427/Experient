import { useState } from 'react';
import { render, screen, cleanup, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import {
  DelayActionConfigPanel, clampDelayAmount, buildDelayPreview, defaultDelayConfig, minutesToUiState,
  type DelayConfigState,
} from '../../../../components/workflow-builder/sentence/DelayActionConfigPanel';
import { t } from '../../../../lib/i18n';

afterEach(cleanup);

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  Element.prototype.releasePointerCapture = vi.fn();
});

function Wrapper({ initial }: { initial: DelayConfigState }) {
  const [value, setValue] = useState(initial);
  return <DelayActionConfigPanel value={value} onChange={setValue} />;
}

describe('DelayActionConfigPanel — rendering + live preview', () => {
  it('renders the amount input and unit select with the given value', () => {
    render(<Wrapper initial={{ amount: 2, unit: 'hours' }} />);
    expect(screen.getByLabelText(/wait for/i)).toHaveValue(2);
  });

  it('shows the exact preview copy for 2 hours: "Then wait 2 hours before continuing."', () => {
    render(<Wrapper initial={{ amount: 2, unit: 'hours' }} />);
    const preview = screen.getByTestId('delay-preview');
    expect(within(preview).getByText('Then wait 2 hours before continuing.')).toBeInTheDocument();
  });

  it('uses the singular unit label for amount === 1', () => {
    render(<Wrapper initial={{ amount: 1, unit: 'hours' }} />);
    const preview = screen.getByTestId('delay-preview');
    expect(within(preview).getByText('Then wait 1 hour before continuing.')).toBeInTheDocument();
  });

  it('updating the amount input updates the live preview', () => {
    render(<Wrapper initial={{ amount: 1, unit: 'minutes' }} />);
    const input = screen.getByLabelText(/wait for/i);
    fireEvent.change(input, { target: { value: '30' } });
    const preview = screen.getByTestId('delay-preview');
    expect(within(preview).getByText('Then wait 30 minutes before continuing.')).toBeInTheDocument();
  });
});

describe('DelayActionConfigPanel — defaultDelayConfig', () => {
  it('defaults to 1 hour, not 1 minute', () => {
    expect(defaultDelayConfig()).toEqual({ amount: 1, unit: 'hours' });
  });
});

describe('clampDelayAmount — unit-aware guardrails + intent-preserving conversion', () => {
  it('clamps minutes to the 1-1440 range', () => {
    expect(clampDelayAmount(5000, 'minutes')).toBe(1440);
    expect(clampDelayAmount(0, 'minutes')).toBe(1);
    expect(clampDelayAmount(-10, 'minutes')).toBe(1);
  });

  it('clamps hours to the 1-720 range', () => {
    expect(clampDelayAmount(1000, 'hours')).toBe(720);
  });

  it('clamps days to the 1-90 range', () => {
    expect(clampDelayAmount(200, 'days')).toBe(90);
  });

  // Real correctness detail per the spec: switching "2 hours" to minutes must
  // show "120", not silently become "2 minutes" (a 120x-smaller delay).
  it('converts the underlying total when switching units, preserving intent', () => {
    // "2 hours" -> switch display unit to minutes -> shows "120", not "2".
    expect(clampDelayAmount(2, 'minutes', 'hours')).toBe(120);
    // "120 minutes" -> switch display unit to hours -> shows "2".
    expect(clampDelayAmount(120, 'hours', 'minutes')).toBe(2);
    // "1 day" -> switch display unit to hours -> shows "24".
    expect(clampDelayAmount(1, 'hours', 'days')).toBe(24);
  });

  it('switching units in the live component preserves the total, not the raw number', async () => {
    const user = userEvent.setup();
    render(<Wrapper initial={{ amount: 2, unit: 'hours' }} />);
    await user.click(screen.getByTestId('delay-unit-select'));
    await user.click(await screen.findByRole('option', { name: /minutes/i }));
    expect(screen.getByLabelText(/wait for/i)).toHaveValue(120);
  });
});

describe('buildDelayPreview', () => {
  it('pluralizes correctly per unit (no ICU support in this i18n lib, literal keys per unit)', () => {
    expect(buildDelayPreview({ amount: 1, unit: 'days' }, t)).toBe('Then wait 1 day before continuing.');
    expect(buildDelayPreview({ amount: 3, unit: 'days' }, t)).toBe('Then wait 3 days before continuing.');
    expect(buildDelayPreview({ amount: 1, unit: 'minutes' }, t)).toBe('Then wait 1 minute before continuing.');
    expect(buildDelayPreview({ amount: 45, unit: 'minutes' }, t)).toBe('Then wait 45 minutes before continuing.');
  });
});

describe('minutesToUiState — friendliest-unit backward compatibility', () => {
  it('converts a whole-day minute count to days', () => {
    expect(minutesToUiState(2880)).toEqual({ amount: 2, unit: 'days' });
  });

  it('converts a whole-hour minute count to hours', () => {
    expect(minutesToUiState(120)).toEqual({ amount: 2, unit: 'hours' });
  });

  it('falls back to raw minutes when not evenly divisible', () => {
    expect(minutesToUiState(47)).toEqual({ amount: 47, unit: 'minutes' });
  });

  it('falls back to a sane default (60 minutes) for missing/invalid input', () => {
    expect(minutesToUiState(undefined)).toEqual({ amount: 1, unit: 'hours' });
    expect(minutesToUiState(0)).toEqual({ amount: 1, unit: 'hours' });
  });
});
