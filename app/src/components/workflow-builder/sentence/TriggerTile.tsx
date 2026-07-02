import { Icon } from '../../Icon';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useTranslation } from '../../../lib/i18n';
import { cn } from '@/lib/utils';

export interface TriggerTileProps {
  type: string;
  label: string;
  description: string;
  icon: string;
  isCrystal: boolean;
  selected: boolean;
  onSelect: () => void;
  // Whether the registry has a real backend producer wired up for this trigger
  // (backend/src/lib/workflowRegistry.ts's `WorkflowTriggerDef.live`, added
  // orchestrator-side — see docs/automation-hub/TRACKER.md Wave 10). Optional
  // for callers that haven't threaded the registry's `live` field through yet;
  // treated as live (no dot) when omitted so this is purely additive.
  live?: boolean;
}

// Mirrors ActionTile.tsx's readiness-dot color/tooltip pattern exactly, but
// only has two states (no 'stub'/'env' tier for triggers — a trigger either
// has a real event producer or it doesn't).
const READINESS_COLOR: Record<string, string> = {
  true: 'bg-success',
  false: 'bg-outline-variant',
};

export function TriggerTile({ type, label, description, icon, isCrystal, selected, onSelect, live }: TriggerTileProps) {
  const { t } = useTranslation();
  const isLive = live !== false;
  const dotColor = READINESS_COLOR[String(isLive)];
  const tooltipText = isLive
    ? t('workflows.builder.sentence.trigger.readinessLive')
    : t('workflows.builder.sentence.trigger.readinessNoProducer');

  return (
    <button
      type="button"
      data-testid={`trigger-tile-${type}`}
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        'flex flex-col items-start gap-1.5 text-left rounded-xl border p-4 transition-colors',
        selected ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50 hover:bg-accent/40',
      )}
    >
      <div className="flex items-center gap-2 w-full">
        <Icon name={icon} size={18} className="text-primary flex-shrink-0" />
        <span className="font-semibold text-sm text-on-surface flex-1">{label}</span>
        {isCrystal && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span aria-describedby={`trigger-crystal-desc-${type}`}>
                <Badge className="text-[10px] bg-violet-50 text-violet-700 border border-violet-200 rounded-full px-2 py-0.5">
                  {t('workflows.builder.unified.palette.crystalBadge')}
                </Badge>
              </span>
            </TooltipTrigger>
            <TooltipContent>{t('workflows.builder.unified.palette.crystalTooltip')}</TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              data-testid={`trigger-readiness-${type}`}
              data-readiness={String(isLive)}
              aria-describedby={`trigger-readiness-desc-${type}`}
              className={cn('inline-block w-2.5 h-2.5 rounded-full flex-shrink-0', dotColor)}
            />
          </TooltipTrigger>
          <TooltipContent>{tooltipText}</TooltipContent>
        </Tooltip>
      </div>
      <p className="text-xs text-on-surface-variant">{description}</p>
      {/* A-1 (DEEP_AUDIT_UX_FINDINGS.md §8) — sr-only text alternatives for the
          two mouse-only Tooltips above (Crystal badge + readiness dot), so
          keyboard/screen-reader users get the same information without
          changing the visible layout. */}
      {isCrystal && (
        <span id={`trigger-crystal-desc-${type}`} className="sr-only">
          {t('workflows.builder.unified.palette.crystalTooltip')}
        </span>
      )}
      <span id={`trigger-readiness-desc-${type}`} className="sr-only">{tooltipText}</span>
    </button>
  );
}
