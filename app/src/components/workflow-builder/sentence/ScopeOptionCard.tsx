import type { ReactNode } from 'react';
import { Icon } from '../../Icon';
import { cn } from '@/lib/utils';

export interface ScopeOptionCardProps {
  icon: string;
  label: string;
  subtext: string;
  consequence?: string;
  selected: boolean;
  disabled?: boolean;
  disabledReason?: string;
  onSelect: () => void;
  testId?: string;
  children?: ReactNode;
}

// One of the 3 big scope-choice cards (Org-wide / Survey / Tag), per
// BUILDER_REDESIGN_V2_CONCEPT.md §3. `disabled` renders greyed-out with a
// one-line reason (not hidden) when the current trigger doesn't support
// survey/tag scoping (time.schedule / external.webhook).
export function ScopeOptionCard({
  icon, label, subtext, consequence, selected, disabled, disabledReason, onSelect, testId, children,
}: ScopeOptionCardProps) {
  return (
    <div
      data-testid={testId}
      className={cn(
        'rounded-xl border p-4 transition-colors',
        disabled ? 'opacity-50 border-border bg-surface-container-low' : selected ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50',
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        disabled={disabled}
        aria-pressed={selected}
        className="flex items-start gap-3 w-full text-left disabled:cursor-not-allowed"
      >
        <Icon name={icon} size={20} className="text-primary flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-sm text-on-surface">{label}</p>
          <p className="text-xs text-on-surface-variant mt-0.5">{subtext}</p>
          {disabled && disabledReason && (
            <p className="text-xs text-warning mt-1 flex items-center gap-1">
              <Icon name="block" size={12} />{disabledReason}
            </p>
          )}
          {!disabled && selected && consequence && (
            <p className="text-xs text-primary mt-1.5 font-medium">{consequence}</p>
          )}
        </div>
      </button>
      {!disabled && selected && children && <div className="mt-3 pl-8">{children}</div>}
    </div>
  );
}
