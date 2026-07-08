import { useState } from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import { SectionChecklist } from '../../../../components/workflow-builder/sentence/SectionChecklist';
import { defaultActionContentConfig, type SectionState, type SectionPreset } from '../../../../components/workflow-builder/sentence/contentSections';

afterEach(cleanup);

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  Element.prototype.releasePointerCapture = vi.fn();
});

function Wrapper() {
  const initial = defaultActionContentConfig();
  const [sections, setSections] = useState<SectionState>(initial.sections);
  const [preset, setPreset] = useState<SectionPreset>(initial.preset);
  return (
    <SectionChecklist
      sections={sections} preset={preset}
      onChange={(s, p) => { setSections(s); setPreset(p); }}
    />
  );
}

describe('SectionChecklist — defaults', () => {
  it('Standard Digest default: Crystal AI Summary, Key Metrics, Trend Chart checked; rest unchecked', () => {
    render(<Wrapper />);
    expect(screen.getByTestId('section-checkbox-crystalSummary')).toHaveAttribute('data-state', 'checked');
    expect(screen.getByTestId('section-checkbox-keyMetrics')).toHaveAttribute('data-state', 'checked');
    expect(screen.getByTestId('section-checkbox-trendChart')).toHaveAttribute('data-state', 'checked');
    expect(screen.getByTestId('section-checkbox-topVerbatims')).toHaveAttribute('data-state', 'unchecked');
    expect(screen.getByTestId('section-checkbox-recommendedActions')).toHaveAttribute('data-state', 'unchecked');
    expect(screen.getByTestId('section-checkbox-rawResponseCount')).toHaveAttribute('data-state', 'unchecked');
  });

  it('the Crystal AI Summary checkbox is never disabled — it must always be uncheckable', () => {
    render(<Wrapper />);
    expect(screen.getByTestId('section-checkbox-crystalSummary')).not.toBeDisabled();
  });
});

describe('SectionChecklist — preset switching', () => {
  it('"Metrics Only" preset checks only Key Metrics', async () => {
    const user = userEvent.setup();
    render(<Wrapper />);
    await user.click(screen.getByTestId('section-preset-select'));
    await user.click(screen.getByText('Metrics Only'));
    expect(screen.getByTestId('section-checkbox-keyMetrics')).toHaveAttribute('data-state', 'checked');
    expect(screen.getByTestId('section-checkbox-crystalSummary')).toHaveAttribute('data-state', 'unchecked');
  });

  it('"Full Detail" preset checks every section', async () => {
    const user = userEvent.setup();
    render(<Wrapper />);
    await user.click(screen.getByTestId('section-preset-select'));
    await user.click(screen.getByText('Full Detail'));
    for (const key of ['crystalSummary', 'keyMetrics', 'topVerbatims', 'trendChart', 'recommendedActions', 'rawResponseCount']) {
      expect(screen.getByTestId(`section-checkbox-${key}`)).toHaveAttribute('data-state', 'checked');
    }
  });

  it('toggling an individual checkbox after selecting a preset flips the dropdown display to Custom', async () => {
    const user = userEvent.setup();
    render(<Wrapper />);
    await user.click(screen.getByTestId('section-checkbox-topVerbatims'));
    expect(screen.getByTestId('section-preset-select')).toHaveTextContent('Custom');
  });

  it('unchecking Crystal AI Summary from Standard Digest also flips the preset to Custom', async () => {
    const user = userEvent.setup();
    render(<Wrapper />);
    await user.click(screen.getByTestId('section-checkbox-crystalSummary'));
    expect(screen.getByTestId('section-checkbox-crystalSummary')).toHaveAttribute('data-state', 'unchecked');
    expect(screen.getByTestId('section-preset-select')).toHaveTextContent('Custom');
  });
});
