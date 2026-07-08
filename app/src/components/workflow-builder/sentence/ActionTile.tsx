import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useTranslation } from '../../../lib/i18n';
import { cn } from '@/lib/utils';

export interface ActionTileProps {
  action: string;
  label: string;
  live: boolean | 'stub' | 'env';
  selected: boolean;
  onSelect: () => void;
  // Real per-org connector health (Kenji finding 1 / Maya 6c / Rohan I-1) —
  // fetched from GET /api/workflow-credentials (same endpoint
  // IntegrationsSettingsPage.tsx already uses), NOT the registry's static
  // `live: 'env'` constant. When set to 'disconnected', this overrides the
  // registry's `live` tier for connector-backed actions (jira.create_issue/
  // salesforce.*/servicenow.*/zendesk.*) so a disconnected org sees a visibly
  // distinct state instead of the same generic "env" dot every org gets
  // regardless of whether they've actually configured that connector.
  credentialStatus?: 'connected' | 'disconnected';
}

const READINESS_COLOR: Record<string, string> = {
  true: 'bg-success',
  stub: 'bg-warning',
  env: 'bg-outline-variant',
  disconnected: 'bg-error',
};

export function ActionTile({ action, label, live, credentialStatus, selected, onSelect }: ActionTileProps) {
  const { t } = useTranslation();
  const isDisconnected = credentialStatus === 'disconnected';
  const key = isDisconnected ? 'disconnected' : String(live);
  const dotColor = READINESS_COLOR[key] ?? READINESS_COLOR.true;
  const tooltipText = isDisconnected
    ? t('workflows.builder.sentence.action.readinessDisconnected')
    : live === true
      ? t('workflows.builder.sentence.action.readinessLive')
      : live === 'stub'
        ? t('workflows.builder.sentence.action.readinessStub')
        : t('workflows.builder.sentence.action.readinessEnv');

  return (
    <button
      type="button"
      data-testid={`action-tile-${action}`}
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        'flex items-center gap-2 text-left rounded-xl border p-4 transition-colors',
        selected ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50 hover:bg-accent/40',
      )}
    >
      <span className="font-semibold text-sm text-on-surface flex-1">{label}</span>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            data-testid={`action-readiness-${action}`}
            data-readiness={key}
            aria-describedby={`action-readiness-desc-${action}`}
            className={cn('inline-block w-2.5 h-2.5 rounded-full flex-shrink-0', dotColor)}
          />
        </TooltipTrigger>
        <TooltipContent>{tooltipText}</TooltipContent>
      </Tooltip>
      {/* A-1 (DEEP_AUDIT_UX_FINDINGS.md §8) — the readiness dot's meaning was
          mouse-only (Tooltip requires hover/focus to reveal). This sr-only span
          gives screen-reader / keyboard-only users the same text via
          aria-describedby, without changing the tile's visible layout. */}
      <span id={`action-readiness-desc-${action}`} className="sr-only">{tooltipText}</span>
    </button>
  );
}
