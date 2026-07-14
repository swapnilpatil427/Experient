// TagGroupsStrip — Hub teaser, Precision Component Specs #2 (DESIGN.md,
// Decision 20) + Decision 18's binding conditions.
//
// Hard-scoped AT THE DATA LAYER to `healthStatus !== 'healthy'` tags only —
// filtered here defensively even though the caller (ExperienceHubPage) is
// expected to pass already-scoped data, so this component can never become a
// general tag browser no matter what it's given. Its only exit is a single
// CTA doing full navigation to the real Tag Report route — it never renders
// Tag Report's own multi-metric/provenance machinery inline.
//
// Empty/error: renders nothing at all (extends the "if all tags are healthy,
// don't render" precedent from DESIGN.md's Failure States table).

import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { Icon } from '../Icon';
import { Button } from '@/components/ui/button';
import { useTranslation } from '../../lib/i18n';
import { ROUTES, toPath } from '../../constants/routes';
import { healthStatusColor } from './HealthPill';
import type { TagMetric } from '../../types/orgDashboard';

function worstStatusColor(tags: TagMetric[]): string {
  if (tags.some((t) => t.healthStatus === 'critical')) return healthStatusColor('critical').dot;
  if (tags.some((t) => t.healthStatus === 'attention')) return healthStatusColor('attention').dot;
  return healthStatusColor('healthy').dot;
}

function TagGroupCard({ tag }: { tag: TagMetric }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const c = healthStatusColor(tag.healthStatus);

  return (
    <div
      className="p-4 rounded-xl border cursor-pointer transition-all duration-150 flex-shrink-0 w-full md:w-56 bg-white"
      // Inline `border-color` always wins over any stylesheet rule (including
      // war-room.css's `[data-org-dash-surface]` override), so the war-room
      // value has to be threaded through as a CSS var-with-fallback here
      // rather than relying on that selector alone for this element.
      style={{ borderColor: 'var(--org-dash-card-border, color-mix(in srgb, var(--color-outline-variant) 20%, transparent))' }}
      data-org-dash-surface
      onClick={() => setExpanded((v) => !v)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') setExpanded((v) => !v); }}
    >
      <div className="flex items-start justify-between gap-2 mb-1">
        <span className="text-sm font-bold truncate">{tag.tagName}</span>
        <span
          className="text-[10px] font-bold px-1.5 py-0.5 rounded-full flex-shrink-0"
          style={{ background: `${c.text}14`, color: c.text }}
        >
          {t(`orgDashboard.health.${tag.healthStatus}`)}
        </span>
      </div>
      <div className="text-[10px] text-on-surface-variant/60">
        {t('orgDashboard.tagGroups.surveyCount', { n: String(tag.surveyCount) })}
      </div>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="overflow-hidden"
          >
            <div className="mt-3 pt-3 border-t border-outline-variant/15">
              <div className="text-2xl font-black" style={{ color: c.text }}>
                {tag.aggregateNps != null ? (tag.aggregateNps > 0 ? `+${tag.aggregateNps}` : tag.aggregateNps) : '—'}
              </div>
              {tag.topTopic && (
                <div className="text-xs text-on-surface-variant mt-1">
                  {t('orgDashboard.tagGroups.topTopic', { topic: tag.topTopic })}
                </div>
              )}
              <Link to={toPath(ROUTES.TAG_REPORT_LATEST, { tagId: tag.tagId })} onClick={(e) => e.stopPropagation()}>
                <Button variant="outline" size="sm" className="mt-3 w-full">
                  {t('orgDashboard.tagGroups.viewTagReport')}
                </Button>
              </Link>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function TagGroupsStrip({ tags, loading }: { tags: TagMetric[]; loading: boolean }) {
  const { t } = useTranslation();
  const atRisk = tags.filter((tag) => tag.healthStatus !== 'healthy');

  if (loading) {
    return (
      <div className="space-y-2">
        {[...Array(2)].map((_, i) => <div key={i} className="h-16 rounded-xl bg-surface-container animate-pulse" />)}
      </div>
    );
  }

  // Nothing at risk (or the fetch failed upstream) — render nothing, per the
  // "don't render a broken/empty card on the primary landing page" rule.
  if (atRisk.length === 0) return null;

  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <span className="w-2 h-2 rounded-full" style={{ background: worstStatusColor(atRisk), animation: 'pulse-glow 2s ease-in-out infinite' }} />
        <span className="text-[10px] font-black uppercase tracking-widest text-on-surface-variant">
          {t('orgDashboard.tagGroups.stripTitle')}
        </span>
      </div>
      <div className="flex flex-col md:flex-row gap-3 md:flex-wrap">
        {atRisk.map((tag) => <TagGroupCard key={tag.tagId} tag={tag} />)}
      </div>
    </section>
  );
}
