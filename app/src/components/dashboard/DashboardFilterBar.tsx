import { useTranslation } from '../../lib/i18n';
import { Icon } from '../Icon';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { DEFAULT_FILTERS } from '../../types/dashboard';
import type { DashboardFilters, NpsSegment } from '../../types/dashboard';

interface DashboardFilterBarProps {
  filters: DashboardFilters;
  surveys: Array<{ id: string; title: string }>;
  tags: Array<{ id: string; name: string; color: string }>;
  onChange: (filters: DashboardFilters) => void;
}

const DATE_RANGES: Array<DashboardFilters['dateRange']> = ['7d', '30d', '90d', '180d'];
const ALL = '__all__';
const NPS_SEGMENTS: Array<{ value: NpsSegment; labelKey: string }> = [
  { value: 'all',        labelKey: 'allSegments' },
  { value: 'promoters',  labelKey: 'promoters' },
  { value: 'passives',   labelKey: 'passives' },
  { value: 'detractors', labelKey: 'detractors' },
];

const SEGMENT_COLORS: Record<NpsSegment, string> = {
  all:        'var(--color-on-surface-variant)',
  promoters:  '#10b981',
  passives:   '#f59e0b',
  detractors: '#ef4444',
};

function isDefault(f: DashboardFilters): boolean {
  return (
    f.dateRange === DEFAULT_FILTERS.dateRange &&
    f.surveyId === DEFAULT_FILTERS.surveyId &&
    f.tagId === DEFAULT_FILTERS.tagId &&
    (f.npsSegment ?? 'all') === 'all'
  );
}

export function DashboardFilterBar({ filters, surveys, tags, onChange }: DashboardFilterBarProps) {
  const { t } = useTranslation();
  const segment = filters.npsSegment ?? 'all';
  const selectedSurveyTitle = surveys.find((s) => s.id === filters.surveyId)?.title;

  return (
    <div
      className="sticky top-16 z-10 mb-5 rounded-2xl overflow-hidden"
      style={{
        background: 'var(--color-surface-raised, #fff)',
        boxShadow: '0 1px 8px rgba(0,0,0,0.06), 0 4px 24px rgba(0,0,0,0.04)',
        border: '1px solid rgba(0,0,0,0.07)',
      }}
    >
      {/* ── Row 1: Data scope ── */}
      <div className="px-4 pt-3 pb-2.5 border-b border-black/[0.05]">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-on-surface-variant/50 flex-shrink-0 mr-1">
            {t('dashboard.scope.scopeLabel')}
          </span>

          {/* All Surveys pill */}
          <button
            onClick={() => onChange({ ...filters, surveyId: null })}
            className="flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold transition-all duration-200"
            style={
              !filters.surveyId
                ? {
                    background: 'var(--color-primary)',
                    color: '#fff',
                    boxShadow: '0 2px 8px color-mix(in srgb, var(--color-primary) 28%, transparent)',
                  }
                : {
                    background: 'rgba(0,0,0,0.05)',
                    color: 'var(--color-on-surface-variant)',
                  }
            }
          >
            <Icon name="public" size={12} />
            {t('dashboard.scope.all')}
          </button>

          <span className="text-on-surface-variant/30 text-xs select-none">or</span>

          {/* Survey focus selector */}
          <Select
            value={filters.surveyId ?? ALL}
            onValueChange={(v) => onChange({ ...filters, surveyId: v === ALL ? null : v })}
          >
            <SelectTrigger
              className="h-7 rounded-full border-0 bg-transparent px-3 text-xs font-semibold w-auto min-w-[160px] max-w-[260px] transition-all duration-200"
              style={
                filters.surveyId
                  ? {
                      background: 'rgba(16,185,129,0.1)',
                      color: '#10b981',
                      boxShadow: '0 0 0 1.5px rgba(16,185,129,0.3)',
                    }
                  : {
                      background: 'rgba(0,0,0,0.05)',
                      color: 'var(--color-on-surface-variant)',
                    }
              }
            >
              <span className="flex items-center gap-1.5 truncate">
                <Icon name="description" size={12} />
                <SelectValue
                  placeholder={
                    <span className="text-on-surface-variant/60">{t('dashboard.scope.selectSurvey')}</span>
                  }
                >
                  {selectedSurveyTitle && (
                    <span className="truncate max-w-[180px]">{selectedSurveyTitle}</span>
                  )}
                </SelectValue>
              </span>
            </SelectTrigger>
            <SelectContent>
              {surveys.length === 0 ? (
                <div className="px-3 py-2 text-xs text-on-surface-variant/60">No surveys yet</div>
              ) : (
                surveys.map((s) => (
                  <SelectItem key={s.id} value={s.id}>{s.title}</SelectItem>
                ))
              )}
            </SelectContent>
          </Select>

          {/* Context hint */}
          <span className="ml-auto text-[10px] text-on-surface-variant/40 hidden md:block">
            {filters.surveyId
              ? t('dashboard.scope.context.specificSurvey')
              : t('dashboard.scope.context.allSurveys')}
          </span>
        </div>
      </div>

      {/* ── Row 2: Time + group + segment filters ── */}
      <div className="px-4 py-2.5 flex flex-wrap items-center gap-3">
        {/* Date range segment control */}
        <div
          className="inline-flex rounded-xl overflow-hidden"
          style={{
            background: 'var(--color-surface, #f5f7f9)',
            border: '1px solid rgba(0,0,0,0.08)',
            padding: '2px',
          }}
        >
          {DATE_RANGES.map((r) => (
            <button
              key={r}
              onClick={() => onChange({ ...filters, dateRange: r })}
              className="px-3 py-1 text-xs font-semibold rounded-lg transition-all duration-200 leading-none"
              style={
                filters.dateRange === r
                  ? {
                      background: 'var(--color-primary)',
                      color: '#fff',
                      boxShadow: '0 2px 8px color-mix(in srgb, var(--color-primary) 28%, transparent)',
                    }
                  : { color: 'var(--color-on-surface-variant)', background: 'transparent' }
              }
            >
              {r}
            </button>
          ))}
        </div>

        {/* Group picker */}
        <Select
          value={filters.tagId ?? ALL}
          onValueChange={(v) => onChange({ ...filters, tagId: v === ALL ? null : v })}
        >
          <SelectTrigger className="w-44 h-8 text-xs">
            <SelectValue placeholder={t('dashboard.filterBar.allGroups')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t('dashboard.filterBar.allGroups')}</SelectItem>
            {tags.map((tag) => (
              <SelectItem key={tag.id} value={tag.id}>
                <span className="inline-flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full" style={{ background: tag.color }} />
                  {tag.name}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* NPS Segment filter */}
        <Select
          value={segment}
          onValueChange={(v) => onChange({ ...filters, npsSegment: v as NpsSegment })}
        >
          <SelectTrigger
            className="w-44 h-8 text-xs transition-all duration-200"
            style={segment !== 'all' ? { color: SEGMENT_COLORS[segment], fontWeight: 600 } : undefined}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {NPS_SEGMENTS.map(({ value, labelKey }) => (
              <SelectItem key={value} value={value}>
                <span className="flex items-center gap-2">
                  {value !== 'all' && (
                    <span className="w-2 h-2 rounded-full" style={{ background: SEGMENT_COLORS[value] }} />
                  )}
                  {t(`dashboard.filterBar.${labelKey}`)}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Reset */}
        {!isDefault(filters) && (
          <button
            onClick={() => onChange({ ...DEFAULT_FILTERS })}
            className="ml-auto flex items-center gap-1 text-xs font-medium transition-colors hover:opacity-80"
            style={{ color: 'var(--color-primary)' }}
          >
            <Icon name="refresh" size={13} />
            {t('dashboard.filterBar.reset')}
          </button>
        )}
      </div>
    </div>
  );
}
