// TagIntelligenceGrid — full Command Center page, DESIGN.md §8 (Tag Group
// Comparison Grid). Unlike the Hub's `TagGroupsStrip`, this shows ALL tags
// (not just at-risk) with sort options and a collapse/expand toggle.
// Card click navigates (full page transition) to Tag Report — this grid
// never embeds Tag Report's own drill-down machinery inline.

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../Icon';
import { useTranslation } from '../../lib/i18n';
import { ROUTES, toPath } from '../../constants/routes';
import { HealthPill, healthStatusColor } from './HealthPill';
import { SparklineCell } from './SparklineCell';
import type { TagMetric } from '../../types/orgDashboard';

type SortOption = 'health' | 'nps' | 'responses' | 'name';
const HEALTH_RANK: Record<string, number> = { critical: 0, attention: 1, healthy: 2 };

export function TagIntelligenceGrid({ tags, loading }: { tags: TagMetric[]; loading: boolean }) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(true);
  const [sortBy, setSortBy] = useState<SortOption>('health');

  const sorted = useMemo(() => {
    const copy = [...tags];
    copy.sort((a, b) => {
      switch (sortBy) {
        case 'nps':       return (b.aggregateNps ?? -Infinity) - (a.aggregateNps ?? -Infinity);
        case 'responses': return b.responses - a.responses;
        case 'name':      return a.tagName.localeCompare(b.tagName);
        default:          return HEALTH_RANK[a.healthStatus] - HEALTH_RANK[b.healthStatus];
      }
    });
    return copy;
  }, [tags, sortBy]);

  const SORT_OPTIONS: Array<{ key: SortOption; labelKey: string }> = [
    { key: 'health',    labelKey: 'orgDashboard.tagGrid.sortHealth' },
    { key: 'nps',       labelKey: 'orgDashboard.tagGrid.sortNps' },
    { key: 'responses', labelKey: 'orgDashboard.tagGrid.sortResponses' },
    { key: 'name',      labelKey: 'orgDashboard.tagGrid.sortName' },
  ];

  return (
    <section className="bg-white rounded-xl border border-gray-100 shadow-sm">
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className="w-full flex items-center justify-between px-5 py-4"
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-gray-900">{t('orgDashboard.tagGrid.title')}</span>
          <span className="text-xs text-gray-500">{t('orgDashboard.tagGrid.count', { n: String(tags.length) })}</span>
        </div>
        <Icon name="expand_more" size={18} style={{ transform: collapsed ? undefined : 'rotate(180deg)', transition: 'transform 200ms ease-in' }} />
      </button>

      {!collapsed && (
        <div className="px-5 pb-5">
          <div className="flex items-center gap-2 mb-4">
            <span className="text-xs text-gray-500">{t('orgDashboard.tagGrid.sortLabel')}</span>
            {SORT_OPTIONS.map((opt) => (
              <button
                key={opt.key}
                onClick={() => setSortBy(opt.key)}
                className={`text-xs font-medium px-2 py-1 rounded-full ${sortBy === opt.key ? 'bg-indigo-100 text-indigo-700' : 'text-gray-500 hover:bg-gray-100'}`}
              >
                {t(opt.labelKey)}
              </button>
            ))}
          </div>

          {loading && (
            <div className="grid grid-cols-2 md:grid-cols-3 2xl:grid-cols-4 gap-4">
              {[...Array(4)].map((_, i) => <div key={i} className="h-32 rounded-xl bg-surface-container animate-pulse" />)}
            </div>
          )}

          {!loading && tags.length === 0 && (
            <p className="text-sm text-gray-500 text-center py-8">{t('orgDashboard.tagGrid.empty')}</p>
          )}

          {!loading && tags.length > 0 && (
            <div className="grid grid-cols-2 md:grid-cols-3 2xl:grid-cols-4 gap-4">
              {sorted.map((tag) => {
                const c = healthStatusColor(tag.healthStatus);
                return (
                  <Link
                    key={tag.tagId}
                    to={toPath(ROUTES.TAG_REPORT_LATEST, { tagId: tag.tagId })}
                    className="p-5 rounded-xl border border-gray-100 shadow-sm bg-white cursor-pointer hover:shadow-md transition-shadow block"
                  >
                    <div className="text-sm font-semibold text-gray-900 mb-1">{tag.tagName}</div>
                    <div className="text-xs text-gray-500 mb-2">{t('orgDashboard.tagGroups.surveyCount', { n: String(tag.surveyCount) })}</div>
                    <div className="text-2xl font-black tabular-nums mb-1" style={{ color: c.text }}>
                      {tag.aggregateNps != null ? (tag.aggregateNps > 0 ? `+${tag.aggregateNps}` : tag.aggregateNps) : '—'}
                    </div>
                    {tag.topTopic && (
                      <div className="text-xs text-gray-600 mt-1">{t('orgDashboard.tagGroups.topTopic', { topic: tag.topTopic })}</div>
                    )}
                    <div className="flex items-center justify-between mt-3">
                      <HealthPill status={tag.healthStatus} size="sm" />
                    </div>
                    <div className="mt-2">
                      <SparklineCell points={tag.sparkline14d} width={200} height={40} color={c.dot} />
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
