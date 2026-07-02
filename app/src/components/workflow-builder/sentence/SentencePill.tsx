import { Icon } from '../../Icon';
import { cn } from '@/lib/utils';

// 'condition' (Wave 11, Rohan WAVE11_UX_SPECS.md §1.6) is an ADDITIVE 4th
// state for the new condition-step pill — dashed border, amber/warning tint,
// distinct from both action pills (solid, primary-tinted) and the
// trigger/scope pills' 'filled' state (also primary-tinted), so a filled
// condition reads as a "filter" rather than a plain value. No existing state
// is renamed; every current call site (pill-trigger/pill-scope/pill-add-action)
// compiles and renders unchanged.
export type SentencePillState = 'empty' | 'filled' | 'invalid' | 'condition';

export interface SentencePillProps {
  state: SentencePillState;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  testId?: string;
  // Optional leading icon (Material Symbol name) — additive prop, kept
  // generic rather than hardcoding "filter_alt" inside this component so a
  // future pill type doesn't require editing SentencePill.tsx's internals
  // again. Only the condition pill uses it today.
  icon?: string;
}

// One blank/clause in the sentence builder's spine (BUILDER_REDESIGN_V2_CONCEPT.md
// §7 component #2). 4 conceptual states collapse to 3 CSS states here — "filled"
// and "filled + editable-on-click" are the same markup, the pencil icon is just a
// hover reveal (no separate state needed to express that in CSS).
export function SentencePill({ state, label, onClick, disabled, testId, icon }: SentencePillProps) {
  return (
    <button
      type="button"
      data-testid={testId}
      data-pill-state={state}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'group inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-semibold transition-colors',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        state === 'empty' && 'border-2 border-dashed border-outline-variant text-on-surface-variant hover:border-primary hover:text-primary',
        state === 'filled' && 'border border-transparent bg-primary/10 text-primary hover:bg-primary/15',
        state === 'invalid' && 'border-2 border-dashed border-warning text-warning bg-warning/10',
        state === 'condition' && 'border-2 border-dashed border-warning/60 text-warning bg-warning/5 hover:bg-warning/10',
      )}
    >
      {icon && <Icon name={icon} size={13} className="opacity-70" />}
      <span>{label}</span>
      {state !== 'empty' && !disabled && (
        <Icon name="edit" size={13} className="opacity-0 group-hover:opacity-70 transition-opacity" />
      )}
      {state === 'invalid' && <Icon name="warning" size={13} />}
    </button>
  );
}
