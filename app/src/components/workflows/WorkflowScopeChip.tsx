import { Icon } from '../Icon';
import { useTranslation } from '../../lib/i18n';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { scopeRailColorVar } from '../../lib/workflowScopeDisplay';
import type { Workflow } from '../../types';

export interface WorkflowScopeChipProps {
  scopeType: Workflow['scope_type'];
  surveyName?: string | null; // undefined = still loading, null = resolved-but-missing
  tagName?: string | null;
  tagIsProgram?: boolean;
}

const ICON_BY_SCOPE: Record<string, string> = { org: 'public', survey: 'description', tag: 'sell' };

function truncate(name: string, max: number): string {
  return name.length > max ? `${name.slice(0, max - 1)}…` : name;
}

// Leading scope chip — first element of the card's metadata row (ahead of the
// existing name Badge/status pill), per BUILDER_REDESIGN_V2_CONCEPT.md §2.
// Must render in the initial DOM with no interaction required — resolves
// survey/tag names from a pre-built lookup map (passed in), showing a
// lightweight skeleton while that lookup is still loading rather than
// lazy-loading behind a click/hover.
export function WorkflowScopeChip({ scopeType, surveyName, tagName, tagIsProgram }: WorkflowScopeChipProps) {
  const { t } = useTranslation();
  const type = scopeType ?? 'org';
  const color = scopeRailColorVar(type);
  const icon = ICON_BY_SCOPE[type];

  let label: string;
  let loading = false;
  if (type === 'survey') {
    if (surveyName === undefined) { loading = true; label = ''; }
    else label = t('workflows.card.scope.survey', { name: truncate(surveyName ?? '', 24) });
  } else if (type === 'tag') {
    if (tagName === undefined) { loading = true; label = ''; }
    else label = t('workflows.card.scope.tag', { name: tagName ?? '' });
  } else {
    label = t('workflows.card.scope.org');
  }

  if (loading) {
    return <span data-testid="workflow-scope-chip-skeleton" className="skeleton inline-block h-5 w-24 rounded-full" />;
  }

  const chip = (
    <span
      data-testid="workflow-scope-chip"
      data-scope-type={type}
      className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-bold"
      style={{ background: `color-mix(in srgb, ${color} 10%, transparent)`, color }}
    >
      <Icon name={icon} size={12} />
      {label}
      {type === 'tag' && tagIsProgram && (
        <span className="ml-1 text-[10px] font-bold uppercase tracking-wide opacity-70">
          {t('workflows.card.scope.programSuffix')}
        </span>
      )}
    </span>
  );

  if (type === 'survey' && surveyName && surveyName.length > 24) {
    return (
      <Tooltip>
        <TooltipTrigger asChild><span>{chip}</span></TooltipTrigger>
        <TooltipContent>{surveyName}</TooltipContent>
      </Tooltip>
    );
  }

  return chip;
}
