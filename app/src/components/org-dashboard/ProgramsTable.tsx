// ProgramsTable — DESIGN.md §5. Sortable columns (client-side for the
// current page, server-side sort/pagination beyond it — the parent's
// `useOrgPrograms` hook owns that state), pin-to-top via localStorage,
// row expand for a mini-detail panel.
//
// `tags` renders as multiple pill badges (IMPLEMENTATION_SPEC.md
// reconciliation — a survey can carry 0-5 `survey_tags` rows, not one).

import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../Icon';
import { Button } from '@/components/ui/button';
import { useTranslation } from '../../lib/i18n';
import { useCrystalPanel } from '../../contexts/crystalPanel';
import { ROUTES, toPath } from '../../constants/routes';
import { HealthPill, healthStatusColor } from './HealthPill';
import { SparklineCell } from './SparklineCell';
import type { ProgramRow, ProgramsSortKey, SortOrder } from '../../types/orgDashboard';

const PIN_KEY_PREFIX = 'org_dashboard_pinned_programs';

function relativeTime(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function usePinnedPrograms(orgId: string) {
  const key = `${PIN_KEY_PREFIX}:${orgId}`;
  const [pinned, setPinned] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(key) ?? '[]'); } catch { return []; }
  });
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(pinned)); } catch { /* ignore */ }
  }, [pinned, key]);
  const togglePin = (surveyId: string) =>
    setPinned((prev) => (prev.includes(surveyId) ? prev.filter((id) => id !== surveyId) : [...prev, surveyId]));
  return { pinned, togglePin };
}

const COLUMNS: Array<{ key: ProgramsSortKey; labelKey: string }> = [
  { key: 'name',         labelKey: 'orgDashboard.programs.col.name' },
  { key: 'responses',    labelKey: 'orgDashboard.programs.col.responses' },
  { key: 'nps',          labelKey: 'orgDashboard.programs.col.nps' },
  { key: 'health',       labelKey: 'orgDashboard.programs.col.health' },
  { key: 'lastActivity', labelKey: 'orgDashboard.programs.col.lastActivity' },
];

export function ProgramsTable({
  programs, loading, sort, order, onToggleSort, orgId = 'default',
  page, pageSize, total, onPageChange, onPageSizeChange,
}: {
  programs: ProgramRow[];
  loading: boolean;
  sort: ProgramsSortKey;
  order: SortOrder;
  onToggleSort: (key: ProgramsSortKey) => void;
  orgId?: string;
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: 10 | 25 | 50) => void;
}) {
  const { t } = useTranslation();
  const { openCrystal, setScope } = useCrystalPanel();
  const { pinned, togglePin } = usePinnedPrograms(orgId);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const rows = useMemo(() => {
    const pinnedRows = programs.filter((p) => pinned.includes(p.surveyId));
    const rest = programs.filter((p) => !pinned.includes(p.surveyId));
    return [...pinnedRows, ...rest];
  }, [programs, pinned]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const handleAskCrystal = (row: ProgramRow) => {
    setScope(row.surveyId);
    openCrystal(t('orgDashboard.programs.askCrystalQuery', { title: row.surveyTitle }));
  };

  if (loading) {
    return (
      <div className="space-y-2">
        {[...Array(5)].map((_, i) => <div key={i} className="h-12 rounded-lg bg-surface-container animate-pulse" />)}
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100">
              <th className="w-6" />
              {COLUMNS.map((col) => (
                <th
                  key={col.key}
                  className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500 cursor-pointer select-none"
                  onClick={() => onToggleSort(col.key)}
                >
                  <span className="inline-flex items-center gap-1">
                    {t(col.labelKey)}
                    {sort === col.key && <Icon name={order === 'asc' ? 'arrow_upward' : 'arrow_downward'} size={12} />}
                  </span>
                </th>
              ))}
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const isPinned = pinned.includes(row.surveyId);
              const isExpanded = expandedId === row.surveyId;
              const c = healthStatusColor(row.healthStatus);
              return (
                <Fragment key={row.surveyId}>
                  <tr
                    className="group border-b border-gray-50 hover:bg-indigo-50/50 cursor-pointer"
                    style={isPinned ? { borderLeft: '2px solid #818CF8' } : undefined}
                    onClick={() => setExpandedId(isExpanded ? null : row.surveyId)}
                  >
                    <td className="pl-2">
                      <button
                        type="button"
                        className={`opacity-0 group-hover:opacity-100 transition-opacity ${isPinned ? '!opacity-100' : ''}`}
                        onClick={(e) => { e.stopPropagation(); togglePin(row.surveyId); }}
                        aria-label={t('orgDashboard.programs.pin')}
                      >
                        <Icon name="push_pin" size={13} style={{ color: isPinned ? '#818CF8' : '#cbd5e1' }} />
                      </button>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="font-medium text-gray-900 truncate max-w-[220px]" title={row.surveyTitle}>{row.surveyTitle}</div>
                      {row.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1">
                          {row.tags.map((tag) => (
                            <span key={tag.id} className="text-[10px] font-medium px-1.5 py-0.5 rounded-full" style={{ background: `${tag.color}18`, color: tag.color }}>
                              {tag.name}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-gray-700">{row.responses7d.toLocaleString()}</td>
                    <td className="px-3 py-2.5 tabular-nums font-semibold" style={{ color: c.text }}>
                      {row.lastNps > 0 ? `+${row.lastNps}` : row.lastNps}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <HealthPill status={row.healthStatus} size="sm" />
                        <SparklineCell points={row.sparkline} color={c.dot} />
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-xs text-gray-500">{relativeTime(row.lastActivityAt)}</td>
                    <td className="pr-3">
                      <button
                        type="button"
                        className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 text-[11px] font-bold text-indigo-600"
                        onClick={(e) => { e.stopPropagation(); handleAskCrystal(row); }}
                      >
                        <Icon name="psychology" size={13} />
                        {t('orgDashboard.programs.askCrystal')}
                      </button>
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr className="bg-gray-50/60">
                      <td colSpan={COLUMNS.length + 2} className="px-6 py-4">
                        <div className="flex items-center justify-between">
                          <div>
                            <SparklineCell points={row.sparkline} width={200} height={40} color={c.dot} />
                          </div>
                          <Link to={toPath(ROUTES.EXPERIENCE_SURVEY, { surveyId: row.surveyId })} onClick={(e) => e.stopPropagation()}>
                            <Button variant="outline" size="sm">{t('orgDashboard.programs.viewFullSurvey')}</Button>
                          </Link>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100 text-xs text-gray-500">
        <div className="flex items-center gap-2">
          <span>{t('orgDashboard.programs.pageSizeLabel')}</span>
          {[10, 25, 50].map((size) => (
            <button
              key={size}
              onClick={() => onPageSizeChange(size as 10 | 25 | 50)}
              className={`px-1.5 py-0.5 rounded ${pageSize === size ? 'bg-indigo-100 text-indigo-700 font-semibold' : 'hover:bg-gray-100'}`}
            >
              {size}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <button disabled={page <= 1} onClick={() => onPageChange(page - 1)} className="disabled:opacity-30">
            <Icon name="chevron_left" size={16} />
          </button>
          <span>{t('orgDashboard.programs.pageOf', { page: String(page), total: String(totalPages) })}</span>
          <button disabled={page >= totalPages} onClick={() => onPageChange(page + 1)} className="disabled:opacity-30">
            <Icon name="chevron_right" size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
