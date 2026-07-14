// WeeklyBriefTeaserCard — the Hub teaser version of the Crystal Brief,
// inserted immediately after `crystalOpening` in ExperienceHubPage.tsx.
//
// Precision Component Specs #1 (DESIGN.md, Decision 20): visually
// subordinate to `crystalOpening` — collapsed-to-one-line (two on mobile)
// with an expand affordance, explicit "Crystal's Weekly Brief for {org}"
// eyebrow label, `GlassCard` styling matching `SurveyCard`'s exact shadow
// value. One primary hero voice per viewer (`crystalOpening`); this is a
// clearly-labeled secondary artifact, never a competing equal.

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Link } from 'react-router-dom';
import { Icon } from '../Icon';
import { Button } from '@/components/ui/button';
import { useTranslation } from '../../lib/i18n';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { ROUTES, toPath } from '../../constants/routes';
import type { CrystalBrief } from '../../types/orgDashboard';

const HOUSE_CURVE: [number, number, number, number] = [0.22, 1, 0.36, 1];
const ACTION_ICON: Record<string, string> = {
  investigate: 'search', review: 'bar_chart', celebrate: 'star', monitor: 'visibility',
};

function dateRangeLabel(start: string, end: string): string {
  const s = new Date(start), e = new Date(end);
  const fmt = (d: Date) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${fmt(s)}–${fmt(e)}`;
}

function relativeTime(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function WeeklyBriefTeaserCard({
  orgName, brief, loading, error, minDataMet = true, onAskFollowUp, onRetry,
}: {
  orgName: string;
  brief: CrystalBrief | null;
  loading: boolean;
  error?: string | null;
  // Real eligibility check ("Crystal needs at least 2 weeks of data from 3
  // programs") — matches `CrystalBriefCard`'s own default/convention. Without
  // this, the Hub's empty state was a permanent, unexplained "Crystal hasn't
  // written a brief yet" for any org below the eligibility bar, forever.
  minDataMet?: boolean;
  onAskFollowUp: () => void;
  onRetry?: () => void;
}) {
  const { t } = useTranslation();
  const bp = useBreakpoint();
  const [expanded, setExpanded] = useState(false);
  const prefersReducedMotion = typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  const cardClass = 'p-5 rounded-2xl border border-indigo-100 bg-gradient-to-r from-indigo-50 to-purple-50';
  const cardShadow = { boxShadow: '0 4px 20px rgba(0,0,0,0.05), inset 0 1px 0 rgba(255,255,255,0.9)' };

  if (loading) {
    return <div className="h-20 rounded-2xl bg-surface-container animate-pulse" />;
  }

  if (error) {
    return (
      <div className={cardClass} style={cardShadow}>
        <div className="flex items-center gap-2">
          <Icon name="error_outline" size={14} style={{ color: '#b41340' }} />
          <span className="text-xs text-on-surface-variant flex-1">{t('orgDashboard.crystalBrief.couldNotLoad')}</span>
          {onRetry && <button type="button" onClick={onRetry} className="text-xs font-semibold text-indigo-600 hover:underline">{t('orgDashboard.crystalBrief.retry')}</button>}
        </div>
      </div>
    );
  }

  if (!brief) {
    return (
      <div className={cardClass} style={cardShadow}>
        <div className="flex items-center gap-2">
          <Icon name="auto_awesome" size={24} style={{ color: 'var(--color-outline-variant)' }} />
          <div>
            <span className="text-xs text-on-surface-variant block">{t('orgDashboard.crystalBrief.empty')}</span>
            {!minDataMet && (
              <span className="text-xs text-on-surface-variant/80 block mt-0.5">{t('orgDashboard.crystalBrief.notEnoughData')}</span>
            )}
          </div>
        </div>
      </div>
    );
  }

  const clampClass = bp === 'mobile' ? 'line-clamp-2' : 'line-clamp-1';

  return (
    <motion.div layout={!prefersReducedMotion} transition={{ duration: 0.3, ease: HOUSE_CURVE }} className={cardClass} style={cardShadow}>
      {/* Eyebrow */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5">
          <Icon name="auto_awesome" size={13} style={{ color: '#8329c8' }} />
          <span className="text-[10px] font-black uppercase tracking-widest text-on-surface-variant">
            {t('orgDashboard.crystalBrief.eyebrowForOrg', { org: orgName })}
          </span>
        </div>
        <span className="text-[10px] text-on-surface-variant/55">{dateRangeLabel(brief.dateRangeStart, brief.dateRangeEnd)}</span>
      </div>

      {/* Narrative */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full text-left flex items-start gap-2"
      >
        <p className={`flex-1 text-sm text-on-surface leading-relaxed ${expanded ? '' : clampClass}`}>
          {brief.briefText}
        </p>
        <Icon
          name="expand_more"
          size={14}
          className="flex-shrink-0 mt-0.5 transition-transform"
          style={{ transform: expanded ? 'rotate(180deg)' : undefined }}
        />
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={prefersReducedMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15, delay: prefersReducedMotion ? 0 : 0.05 }}
            className="mt-3 pt-3 border-t border-outline-variant/20"
          >
            {brief.recommendations.length > 0 && (
              <ol className="space-y-2 mb-3">
                {brief.recommendations.slice(0, 3).map((rec) => (
                  <li key={rec.rank} className="flex items-start gap-2.5">
                    <span className="w-5 h-5 rounded-full bg-[#8329c8] text-white text-[10px] font-black flex items-center justify-center flex-shrink-0 mt-0.5">
                      {rec.rank}
                    </span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <Icon name={ACTION_ICON[rec.actionType] ?? 'flag'} size={12} style={{ color: '#8329c8' }} />
                        <span className="text-sm font-medium text-on-surface">{rec.action}</span>
                      </div>
                      <p className="text-xs text-on-surface-variant">{rec.rationale}</p>
                    </div>
                  </li>
                ))}
              </ol>
            )}
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className="text-[10px] text-on-surface-variant/60">
                {t('orgDashboard.crystalBrief.lastUpdated', { time: relativeTime(brief.generatedAt) })}
              </span>
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={onAskFollowUp}>{t('orgDashboard.crystalBrief.askFollowUp')}</Button>
                <Link to={ROUTES.EXPERIENCE_ORG_TRENDS}>
                  <Button variant="outline" size="sm">{t('orgDashboard.crystalBrief.viewFullCommandCenter')}</Button>
                </Link>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
