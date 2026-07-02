import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { SentencePill } from '../../../../components/workflow-builder/sentence/SentencePill';

afterEach(cleanup);

describe('SentencePill — 4 visual states', () => {
  it('empty state renders dashed styling and the "+ label" text', () => {
    render(<SentencePill state="empty" label="+ pick a trigger" onClick={() => {}} testId="pill" />);
    const pill = screen.getByTestId('pill');
    expect(pill).toHaveAttribute('data-pill-state', 'empty');
    expect(pill.className).toMatch(/border-dashed/);
    expect(pill).toHaveTextContent('+ pick a trigger');
  });

  it('filled state renders a solid pill with the resolved label', () => {
    render(<SentencePill state="filled" label="NPS dropped" onClick={() => {}} testId="pill" />);
    const pill = screen.getByTestId('pill');
    expect(pill).toHaveAttribute('data-pill-state', 'filled');
    expect(pill).toHaveTextContent('NPS dropped');
  });

  it('filled state shows a pencil icon on hover (rendered, opacity-0 by default)', () => {
    render(<SentencePill state="filled" label="NPS dropped" onClick={() => {}} testId="pill" />);
    const pill = screen.getByTestId('pill');
    expect(pill.querySelector('.material-symbols-outlined')).toBeTruthy();
  });

  it('invalid/warning state renders an amber dashed outline with a warning icon', () => {
    render(<SentencePill state="invalid" label="On Org-wide" onClick={() => {}} testId="pill" />);
    const pill = screen.getByTestId('pill');
    expect(pill).toHaveAttribute('data-pill-state', 'invalid');
    expect(pill.className).toMatch(/border-warning/);
  });

  // Wave 11, Rohan WAVE11_UX_SPECS.md §1.6 — additive 4th state for the new
  // condition pill. Must not rename/break any of the 3 states above.
  it('condition state renders a dashed amber-tinted pill, distinct from filled/invalid', () => {
    render(<SentencePill state="condition" label="NPS < 30" onClick={() => {}} testId="pill" />);
    const pill = screen.getByTestId('pill');
    expect(pill).toHaveAttribute('data-pill-state', 'condition');
    expect(pill.className).toMatch(/border-dashed/);
    expect(pill.className).toMatch(/warning/);
    expect(pill).toHaveTextContent('NPS < 30');
  });

  it('renders an optional leading icon before the label when provided', () => {
    render(<SentencePill state="condition" label="NPS < 30" onClick={() => {}} testId="pill" icon="filter_alt" />);
    const pill = screen.getByTestId('pill');
    const icons = Array.from(pill.querySelectorAll('.material-symbols-outlined')).map((el) => el.textContent);
    expect(icons[0]).toBe('filter_alt');
  });

  it('renders no leading icon when the icon prop is omitted (existing pills unaffected)', () => {
    render(<SentencePill state="filled" label="NPS dropped" onClick={() => {}} testId="pill" />);
    const pill = screen.getByTestId('pill');
    const icons = Array.from(pill.querySelectorAll('.material-symbols-outlined')).map((el) => el.textContent);
    expect(icons).not.toContain('filter_alt');
  });

  it('clicking any non-disabled pill fires onClick', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<SentencePill state="empty" label="+ add an action" onClick={onClick} testId="pill" />);
    await user.click(screen.getByTestId('pill'));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('a disabled pill does not fire onClick', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<SentencePill state="empty" label="+ add an action" onClick={onClick} disabled testId="pill" />);
    await user.click(screen.getByTestId('pill'));
    expect(onClick).not.toHaveBeenCalled();
  });
});
