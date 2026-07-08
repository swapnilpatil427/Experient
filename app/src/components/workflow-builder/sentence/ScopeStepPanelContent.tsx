import { useEffect, useState } from 'react';
import { useTranslation } from '../../../lib/i18n';
import { useApi } from '../../../hooks/useApi';
import { Icon } from '../../Icon';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ScopeOptionCard } from './ScopeOptionCard';
import type { SurveyTag } from '../../../lib/api';
import type { Survey, WorkflowScopeType } from '../../../types';

export interface ScopeSelection {
  scopeType: WorkflowScopeType;
  scopeSurveyId?: string;
  scopeTagId?: string;
  // Display-only, resolved at selection time so the sentence pill/consequence
  // line don't need a second lookup — not persisted to the API.
  surveyName?: string;
  tagName?: string;
  tagSurveyCount?: number;
}

export interface ScopeStepPanelContentProps {
  value: ScopeSelection;
  onChange: (next: ScopeSelection) => void;
  scopeDisabled: boolean; // true when trigger is time.schedule / external.webhook
}

function useDebouncedValue(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

export function ScopeStepPanelContent({ value, onChange, scopeDisabled }: ScopeStepPanelContentProps) {
  const { t } = useTranslation();
  const api = useApi();

  const [surveyQuery, setSurveyQuery] = useState('');
  const [surveys, setSurveys] = useState<Survey[]>([]);
  const debouncedSurveyQuery = useDebouncedValue(surveyQuery, 250);

  const [tagQuery, setTagQuery] = useState('');
  const [tags, setTags] = useState<SurveyTag[]>([]);
  const debouncedTagQuery = useDebouncedValue(tagQuery, 250);

  useEffect(() => {
    if (value.scopeType !== 'survey') return;
    api.listSurveys({ q: debouncedSurveyQuery || undefined, limit: 20 })
      .then((res) => setSurveys(res.surveys ?? []))
      .catch(() => setSurveys([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.scopeType, debouncedSurveyQuery, api]);

  useEffect(() => {
    if (value.scopeType !== 'tag') return;
    api.listTags({ q: debouncedTagQuery || undefined })
      .then((res) => setTags(res.tags ?? []))
      .catch(() => setTags([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.scopeType, debouncedTagQuery, api]);

  const disabledReason = t('workflows.builder.sentence.scope.disabledReason');

  return (
    <div className="space-y-3" data-testid="scope-step-panel-content">
      <ScopeOptionCard
        testId="scope-option-org"
        icon="public"
        label={t('workflows.builder.sentence.scope.orgLabel')}
        subtext={t('workflows.builder.sentence.scope.orgSubtext')}
        consequence={t('workflows.builder.sentence.scope.orgConsequence')}
        selected={value.scopeType === 'org'}
        onSelect={() => onChange({ scopeType: 'org' })}
      />

      <ScopeOptionCard
        testId="scope-option-survey"
        icon="description"
        label={t('workflows.builder.sentence.scope.surveyLabel')}
        subtext={t('workflows.builder.sentence.scope.surveySubtext')}
        consequence={value.surveyName ? t('workflows.builder.sentence.scope.surveyConsequence', { name: value.surveyName }) : undefined}
        selected={value.scopeType === 'survey'}
        disabled={scopeDisabled}
        disabledReason={disabledReason}
        onSelect={() => onChange({ scopeType: 'survey' })}
      >
        <div className="space-y-2">
          <Input
            placeholder={t('workflows.builder.sentence.scope.surveySearchPlaceholder')}
            value={surveyQuery}
            onChange={(e) => setSurveyQuery(e.target.value)}
            data-testid="scope-survey-search"
          />
          <div className="max-h-56 overflow-y-auto rounded-lg border border-border divide-y divide-border">
            {surveys.length === 0 && (
              <p className="text-xs text-on-surface-variant p-3">{t('workflows.builder.sentence.scope.surveyEmpty')}</p>
            )}
            {surveys.map((s) => (
              <button
                key={s.id}
                type="button"
                data-testid={`scope-survey-row-${s.id}`}
                onClick={() => onChange({ scopeType: 'survey', scopeSurveyId: s.id, surveyName: s.title })}
                className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-accent transition-colors ${value.scopeSurveyId === s.id ? 'bg-accent' : ''}`}
              >
                <span className="flex-1 min-w-0 truncate font-medium text-on-surface">{s.title}</span>
                <Badge variant="secondary" className="text-[10px] capitalize flex-shrink-0">{s.status}</Badge>
                <span className="text-xs text-on-surface-variant flex-shrink-0">
                  {t('workflows.builder.sentence.scope.responseCount', { count: s.response_count ?? 0 })}
                </span>
              </button>
            ))}
          </div>
        </div>
      </ScopeOptionCard>

      <ScopeOptionCard
        testId="scope-option-tag"
        icon="sell"
        label={t('workflows.builder.sentence.scope.tagLabel')}
        subtext={t('workflows.builder.sentence.scope.tagSubtext')}
        consequence={value.tagName ? t('workflows.builder.sentence.scope.tagConsequence', { name: value.tagName, count: value.tagSurveyCount ?? 0 }) : undefined}
        selected={value.scopeType === 'tag'}
        disabled={scopeDisabled}
        disabledReason={disabledReason}
        onSelect={() => onChange({ scopeType: 'tag' })}
      >
        <div className="space-y-2">
          <Input
            placeholder={t('workflows.builder.sentence.scope.tagSearchPlaceholder')}
            value={tagQuery}
            onChange={(e) => setTagQuery(e.target.value)}
            data-testid="scope-tag-search"
          />
          <div className="max-h-56 overflow-y-auto rounded-lg border border-border divide-y divide-border">
            {tags.length === 0 && (
              <p className="text-xs text-on-surface-variant p-3">{t('workflows.builder.sentence.scope.tagEmpty')}</p>
            )}
            {tags.map((tag) => (
              <button
                key={tag.id}
                type="button"
                data-testid={`scope-tag-row-${tag.id}`}
                onClick={() => onChange({ scopeType: 'tag', scopeTagId: tag.id, tagName: tag.name, tagSurveyCount: tag.survey_count ?? 0 })}
                className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-accent transition-colors ${value.scopeTagId === tag.id ? 'bg-accent' : ''}`}
              >
                <span className="flex-1 min-w-0 truncate font-medium text-on-surface">
                  {tag.name}
                  {tag.program_config && (
                    <span className="ml-1.5 text-[10px] font-bold uppercase tracking-wide text-accent-foreground/70">
                      {t('workflows.builder.sentence.scope.programLabel')}
                    </span>
                  )}
                </span>
                <span className="text-xs text-on-surface-variant flex-shrink-0 flex items-center gap-1">
                  <Icon name="description" size={12} />
                  {t('workflows.builder.sentence.scope.surveyCountShort', { count: tag.survey_count ?? 0 })}
                </span>
              </button>
            ))}
          </div>
        </div>
      </ScopeOptionCard>
    </div>
  );
}
