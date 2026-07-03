import { motion } from 'framer-motion';
import { useTranslation } from '../../lib/i18n';
import type { DashboardFilters } from '../../types/dashboard';
import type { DashboardSummary } from '../../lib/api';

interface DashboardScopeBarProps {
  filters: DashboardFilters;
  surveys: Array<{ id: string; title: string }>;
  tags: Array<{ id: string; name: string }>;
  summary: DashboardSummary | null;
}

const SEGMENT_LABEL: Record<string, string> = {
  promoters:  'Promoters',
  passives:   'Passives',
  detractors: 'Detractors',
};

export function DashboardScopeBar({ filters, surveys, tags, summary }: DashboardScopeBarProps) {
  const { t } = useTranslation();
  const surveyName = surveys.find((s) => s.id === filters.surveyId)?.title;
  const tagName = tags.find((t) => t.id === filters.tagId)?.name;
  const segment = filters.npsSegment;
  const isAllSurveys = !filters.surveyId;

  return (
    <motion.div
      key={`${filters.surveyId}-${filters.dateRange}`}
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
      className="mb-4 px-4 py-2.5 rounded-xl flex items-center gap-3 flex-wrap"
      style={{
        background: isAllSurveys
          ? 'linear-gradient(90deg, color-mix(in srgb, var(--color-primary) 5%, transparent), color-mix(in srgb, var(--color-tertiary) 3%, transparent))'
          : 'linear-gradient(90deg, rgba(16,185,129,0.07), rgba(6,182,212,0.03))',
        border: isAllSurveys
          ? '1px solid color-mix(in srgb, var(--color-primary) 12%, transparent)'
          : '1px solid rgba(16,185,129,0.18)',
      }}
    >
      {/* Scope icon */}
      <span
        className="text-sm w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0"
        style={{
          background: isAllSurveys ? 'color-mix(in srgb, var(--color-primary) 10%, transparent)' : 'rgba(16,185,129,0.12)',
        }}
      >
        {isAllSurveys ? '📊' : '🎯'}
      </span>

      {/* Breadcrumb */}
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs flex-1 min-w-0">
        <span
          className="font-bold truncate"
          style={{ color: isAllSurveys ? 'var(--color-primary)' : '#10b981' }}
        >
          {isAllSurveys ? t('dashboard.scope.all') : surveyName}
        </span>
        <span className="text-on-surface-variant/30">·</span>
        <span className="text-on-surface-variant/70">Last {filters.dateRange}</span>
        {tagName && (
          <>
            <span className="text-on-surface-variant/30">·</span>
            <span className="text-on-surface-variant/70">{tagName}</span>
          </>
        )}
        {segment && segment !== 'all' && (
          <>
            <span className="text-on-surface-variant/30">·</span>
            <span
              className="font-semibold"
              style={{
                color: segment === 'promoters' ? '#10b981' : segment === 'detractors' ? '#ef4444' : '#f59e0b',
              }}
            >
              {SEGMENT_LABEL[segment]}
            </span>
          </>
        )}
        <span className="text-on-surface-variant/40 hidden md:inline ml-1">
          — {isAllSurveys ? t('dashboard.scope.context.allSurveys') : t('dashboard.scope.context.specificSurvey')}
        </span>
      </div>

      {/* Quick stats from summary */}
      {summary && (
        <div className="flex items-center gap-4 flex-shrink-0">
          <div className="text-center">
            <div className="text-sm font-bold text-on-surface tabular-nums">
              {summary.kpis.responses.toLocaleString()}
            </div>
            <div className="text-[10px] text-on-surface-variant/50 leading-none mt-0.5">responses</div>
          </div>
          {summary.kpis.nps != null && (
            <div className="text-center">
              <div
                className="text-sm font-bold tabular-nums"
                style={{ color: 'var(--color-primary)' }}
              >
                {summary.kpis.nps >= 0 ? '+' : ''}
                {Math.round(summary.kpis.nps)}
              </div>
              <div className="text-[10px] text-on-surface-variant/50 leading-none mt-0.5">NPS</div>
            </div>
          )}
          {summary.kpis.activeSurveys > 0 && (
            <div className="text-center hidden sm:block">
              <div className="text-sm font-bold text-on-surface tabular-nums">
                {summary.kpis.activeSurveys}
              </div>
              <div className="text-[10px] text-on-surface-variant/50 leading-none mt-0.5">
                {summary.kpis.activeSurveys === 1 ? 'survey' : 'surveys'}
              </div>
            </div>
          )}
        </div>
      )}
    </motion.div>
  );
}
