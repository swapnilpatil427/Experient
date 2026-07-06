// BriefArchive — "Past Briefs" vertical timeline, DESIGN.md's "Org Insight
// History & Manual Summary Generator" section.
//
// Scheduled vs. manual distinction uses dedicated `--source-scheduled` /
// `--source-manual` tokens (war-room.css), never severity colors — provenance
// is not urgency (per the design review's explicit warning against training
// users to misread a "manual" badge as a risk signal).

import { useState } from 'react';
import { Icon } from '../Icon';
import { Button } from '@/components/ui/button';
import { useTranslation } from '../../lib/i18n';
import { CheckpointDiffPanel } from './CheckpointDiffPanel';
import { BriefProvenancePanel } from './BriefProvenancePanel';
import { SourcePill } from './SourcePill';
import type { BriefHistoryEntry } from '../../types/orgDashboard';

function dateRangeLabel(start: string, end: string): string {
  const s = new Date(start), e = new Date(end);
  const fmt = (d: Date) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${fmt(s)}–${fmt(e)}, ${e.getFullYear()}`;
}

function BriefEntry({ entry }: { entry: BriefHistoryEntry }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [showCompare, setShowCompare] = useState(false);
  const [showProvenance, setShowProvenance] = useState(false);
  const dotColor = entry.healthStatusAtTime === 'critical' ? '#F43F5E'
    : entry.healthStatusAtTime === 'attention' ? '#F59E0B' : '#22C55E';

  return (
    <li className="relative pl-6">
      <span className="absolute left-0 top-1.5 w-2.5 h-2.5 rounded-full" style={{ background: dotColor }} aria-hidden="true" />
      <div className="cursor-pointer" onClick={() => setExpanded((v) => !v)}>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold">{dateRangeLabel(entry.dateRangeStart, entry.dateRangeEnd)}</span>
          <SourcePill source={entry.source} requestedByName={entry.requestedByName} />
          {entry.hasCriticalSignal && <Icon name="warning" size={13} style={{ color: '#f59e0b' }} />}
        </div>
        <p className="text-xs text-gray-500 line-clamp-1 mt-0.5">{entry.briefText}</p>
      </div>

      {expanded && (
        <div className="mt-2 pl-1 pb-4">
          <p className="text-sm text-gray-800 leading-relaxed">{entry.briefText}</p>
          <div className="flex items-center gap-3 mt-2">
            {entry.parentCheckpointId && (
              <button
                type="button"
                className="text-xs font-medium text-primary flex items-center gap-1"
                onClick={() => setShowCompare((v) => !v)}
              >
                <Icon name="compare_arrows" size={13} />
                {t('orgDashboard.briefArchive.compareToPrevious')}
              </button>
            )}
            <button
              type="button"
              className="text-xs font-medium text-primary flex items-center gap-1"
              onClick={() => setShowProvenance((v) => !v)}
            >
              <Icon name="manage_search" size={13} />
              {t('orgDashboard.briefArchive.viewProvenance')}
            </button>
          </div>
          {showCompare && entry.parentCheckpointId && (
            <CheckpointDiffPanel currentId={entry.id} previousId={entry.parentCheckpointId} />
          )}
          {showProvenance && <BriefProvenancePanel briefId={entry.id} />}
        </div>
      )}
    </li>
  );
}

export function BriefArchive({
  entries, loading, page, totalPages, onPageChange, onOpenGenerator,
}: {
  entries: BriefHistoryEntry[];
  loading: boolean;
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  onOpenGenerator: () => void;
}) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(true);

  return (
    <section className="bg-white rounded-xl border border-gray-100 shadow-sm">
      <div className="flex items-center justify-between px-4 py-3">
        <button type="button" onClick={() => setCollapsed((v) => !v)} className="flex items-center gap-1.5 text-sm font-semibold text-gray-900">
          {t('orgDashboard.insightHistory.title')}
          <Icon name="expand_more" size={16} style={{ transform: collapsed ? undefined : 'rotate(180deg)', transition: 'transform 200ms' }} />
        </button>
        <Button variant="outline" size="sm" onClick={onOpenGenerator}>
          <Icon name="auto_awesome" size={13} />
          {t('orgDashboard.insightHistory.generateCustom')}
        </Button>
      </div>

      {!collapsed && (
        <div className="px-4 pb-4">
          {loading && (
            <div className="space-y-3">
              {[...Array(3)].map((_, i) => <div key={i} className="h-12 rounded-lg bg-surface-container animate-pulse" />)}
            </div>
          )}

          {!loading && entries.length === 0 && (
            <p className="text-sm text-gray-500 py-4">{t('orgDashboard.insightHistory.empty')}</p>
          )}

          {!loading && entries.length > 0 && (
            <>
              <ul className="space-y-4 border-l border-gray-200 ml-1">
                {entries.map((entry) => <BriefEntry key={entry.id} entry={entry} />)}
              </ul>
              {totalPages > 1 && (
                <div className="flex items-center justify-center gap-3 mt-3 text-xs text-gray-500">
                  <button disabled={page <= 1} onClick={() => onPageChange(page - 1)} className="disabled:opacity-30">
                    <Icon name="chevron_left" size={16} />
                  </button>
                  <span>{t('orgDashboard.programs.pageOf', { page: String(page), total: String(totalPages) })}</span>
                  <button disabled={page >= totalPages} onClick={() => onPageChange(page + 1)} className="disabled:opacity-30">
                    <Icon name="chevron_right" size={16} />
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
