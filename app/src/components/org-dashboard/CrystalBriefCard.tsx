// CrystalBriefCard — full version, per DESIGN.md §2 + the Trust/Citation
// Progressive Disclosure spec (Decision 16). Lives on the full Command
// Center page (`OrgTrendsPage.tsx`). The Hub's subordinate teaser is a
// separate component, `WeeklyBriefTeaserCard.tsx`.
//
// Governing rule (Decision 16): this card is a verdict surface, not an audit
// surface. A "pass" trust verdict is NEVER rendered — only `flag`/`fail`
// surface a chip, using "Crystal's best read" / "Early read" copy, never
// "hallucination"/"low confidence"/"unverified".

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../Icon';
import { Button } from '@/components/ui/button';
import { useTranslation } from '../../lib/i18n';
import { ROUTES, toPath } from '../../constants/routes';
import type { CrystalBrief } from '../../types/orgDashboard';

const ACTION_ICON: Record<string, string> = {
  investigate: 'search',
  review: 'bar_chart',
  celebrate: 'star',
  monitor: 'visibility',
};

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function dateRangeLabel(start: string, end: string): string {
  const s = new Date(start), e = new Date(end);
  const fmt = (d: Date) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${fmt(s)}–${fmt(e)}, ${e.getFullYear()}`;
}

export function CrystalBriefCard({
  brief, loading, error, minDataMet = true, onRetry, onAskFollowUp,
}: {
  brief: CrystalBrief | null;
  loading: boolean;
  error?: string | null;
  minDataMet?: boolean;
  onRetry?: () => void;
  onAskFollowUp: () => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  if (loading) {
    return <div className="h-32 rounded-xl bg-surface-container animate-pulse" />;
  }

  const cardBase = 'rounded-xl border p-5 transition-colors duration-150';
  const cardStyle = 'bg-gradient-to-r from-indigo-50 to-purple-50 border-indigo-100 hover:border-indigo-300';

  if (error) {
    return (
      <div className={`${cardBase} ${cardStyle}`}>
        <div className="flex items-center gap-3">
          <Icon name="error_outline" size={16} style={{ color: '#b41340' }} />
          <p className="text-sm text-on-surface flex-1">{t('orgDashboard.crystalBrief.couldNotLoad')}</p>
          {onRetry && (
            <Button variant="ghost" size="sm" onClick={onRetry}>{t('orgDashboard.crystalBrief.retry')}</Button>
          )}
        </div>
      </div>
    );
  }

  if (!brief) {
    return (
      <div className={`${cardBase} ${cardStyle}`}>
        <div className="flex items-center gap-3">
          <Icon name="auto_awesome" size={20} style={{ color: 'var(--color-outline-variant)' }} />
          <div>
            <p className="text-sm font-semibold text-on-surface">{t('orgDashboard.crystalBrief.empty')}</p>
            {!minDataMet && (
              <p className="text-xs text-on-surface-variant mt-0.5">{t('orgDashboard.crystalBrief.notEnoughData')}</p>
            )}
          </div>
        </div>
      </div>
    );
  }

  const showBroadFlag = brief.trustVerdict === 'fail';
  const showFlag = brief.trustVerdict === 'flag' || showBroadFlag;

  return (
    <div
      className={`${cardBase} ${cardStyle}`}
      data-org-dash-brief-card
      aria-label={t('orgDashboard.crystalBrief.ariaLabel', { dateRange: dateRangeLabel(brief.dateRangeStart, brief.dateRangeEnd) })}
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Icon name="auto_awesome" size={16} style={{ color: '#8329c8' }} />
          <span className="text-sm font-semibold text-indigo-700">{t('orgDashboard.crystalBrief.title')}</span>
        </div>
        <span className="text-xs text-gray-500">{dateRangeLabel(brief.dateRangeStart, brief.dateRangeEnd)}</span>
      </div>

      {showFlag && (
        <div className="mb-2 flex items-center gap-1.5 text-xs font-medium" style={{ color: '#b45309' }}>
          <Icon name="info" size={13} />
          {showBroadFlag ? t('orgDashboard.trust.earlyReadWhole') : t('orgDashboard.trust.earlyRead')}
        </div>
      )}

      <p className={`text-base text-gray-900 leading-relaxed ${expanded ? '' : 'line-clamp-3'}`}>
        {brief.briefText}
      </p>
      {!expanded && (
        <button type="button" onClick={() => setExpanded(true)} className="text-xs font-semibold text-indigo-600 mt-1 hover:underline">
          {t('orgDashboard.crystalBrief.readMore')}
        </button>
      )}

      {expanded && brief.recommendations.length > 0 && (
        <ol className="mt-4 space-y-3">
          {brief.recommendations.slice(0, 3).map((rec) => (
            <li key={rec.rank} className="flex items-start gap-3">
              <span className="w-5 h-5 rounded-full bg-indigo-600 text-white text-[10px] font-black flex items-center justify-center flex-shrink-0 mt-0.5">
                {rec.rank}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <Icon name={ACTION_ICON[rec.actionType] ?? 'flag'} size={13} style={{ color: '#6366f1' }} />
                  {rec.surveyId ? (
                    <Link to={toPath(ROUTES.EXPERIENCE_SURVEY, { surveyId: rec.surveyId })} className="text-sm font-medium text-indigo-700 underline underline-offset-2">
                      {rec.action}
                    </Link>
                  ) : (
                    <span className="text-sm font-medium text-gray-800">{rec.action}</span>
                  )}
                </div>
                <p className="text-sm text-gray-500 mt-0.5">{rec.rationale}</p>
              </div>
            </li>
          ))}
        </ol>
      )}

      <div className="flex items-center justify-between mt-4 pt-3 border-t border-indigo-100/60">
        <span className="text-xs text-gray-400">{t('orgDashboard.crystalBrief.lastUpdated', { time: relativeTime(brief.generatedAt) })}</span>
        <Button variant="ghost" size="sm" onClick={onAskFollowUp}>
          {t('orgDashboard.crystalBrief.askFollowUp')}
        </Button>
      </div>
    </div>
  );
}
