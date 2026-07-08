import { useState } from 'react';
import { Icon } from '../Icon';
import { useTranslation } from '../../lib/i18n';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export type ScopeFilterValue =
  | { kind: 'all' }
  | { kind: 'org' }
  | { kind: 'survey'; surveyId: string; label: string }
  | { kind: 'tag'; tagId: string; label: string };

export interface ScopeFilterBarProps {
  value: ScopeFilterValue;
  onChange: (value: ScopeFilterValue) => void;
  surveyOptions: Array<{ id: string; title: string }>;
  tagOptions: Array<{ id: string; name: string }>;
}

// Chip-row filter above the card grid: All / Org-wide / By survey ▾ / By tag ▾
// (BUILDER_REDESIGN_V2_CONCEPT.md §2). Filters client-side over the already-
// loaded workflows array — no new API call needed for the filter itself
// (surveyOptions/tagOptions are the same lookups already fetched for chip
// name resolution).
export function ScopeFilterBar({ value, onChange, surveyOptions, tagOptions }: ScopeFilterBarProps) {
  const { t } = useTranslation();
  const [surveyQuery, setSurveyQuery] = useState('');
  const [tagQuery, setTagQuery] = useState('');

  const chipClass = (active: boolean) => cn(
    'px-3 py-1.5 rounded-full text-xs font-bold transition-colors',
    active ? 'bg-primary text-white' : 'bg-surface-container-low text-on-surface-variant hover:bg-accent',
  );

  const filteredSurveys = surveyOptions.filter((s) => s.title.toLowerCase().includes(surveyQuery.toLowerCase()));
  const filteredTags = tagOptions.filter((tg) => tg.name.toLowerCase().includes(tagQuery.toLowerCase()));

  return (
    <div className="flex items-center gap-2 flex-wrap mb-5" data-testid="scope-filter-bar">
      <button type="button" className={chipClass(value.kind === 'all')} onClick={() => onChange({ kind: 'all' })}>
        {t('workflows.scopeFilter.all')}
      </button>
      <button type="button" className={chipClass(value.kind === 'org')} onClick={() => onChange({ kind: 'org' })}>
        {t('workflows.scopeFilter.orgWide')}
      </button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className={chipClass(value.kind === 'survey')}>
            {value.kind === 'survey' ? value.label : t('workflows.scopeFilter.bySurvey')}
            <Icon name="expand_more" size={12} className="inline-block ml-1 align-text-bottom" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <div className="p-2">
            <Input
              placeholder={t('workflows.scopeFilter.searchSurveyPlaceholder')}
              value={surveyQuery}
              onChange={(e) => setSurveyQuery(e.target.value)}
              className="h-8 text-sm"
            />
          </div>
          <div className="max-h-56 overflow-y-auto">
            {filteredSurveys.map((s) => (
              <DropdownMenuItem key={s.id} onClick={() => onChange({ kind: 'survey', surveyId: s.id, label: s.title })}>
                {s.title}
              </DropdownMenuItem>
            ))}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className={chipClass(value.kind === 'tag')}>
            {value.kind === 'tag' ? value.label : t('workflows.scopeFilter.byTag')}
            <Icon name="expand_more" size={12} className="inline-block ml-1 align-text-bottom" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <div className="p-2">
            <Input
              placeholder={t('workflows.scopeFilter.searchTagPlaceholder')}
              value={tagQuery}
              onChange={(e) => setTagQuery(e.target.value)}
              className="h-8 text-sm"
            />
          </div>
          <div className="max-h-56 overflow-y-auto">
            {filteredTags.map((tg) => (
              <DropdownMenuItem key={tg.id} onClick={() => onChange({ kind: 'tag', tagId: tg.id, label: tg.name })}>
                {tg.name}
              </DropdownMenuItem>
            ))}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
