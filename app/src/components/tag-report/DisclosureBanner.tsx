import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from '../../lib/i18n';
import { Icon } from '../Icon';
import { GlassCard } from '../../pages/insights/shared';
import type { TagReportRunSource } from '../../types/tagReport';

interface DisclosureBannerProps {
  poolSize: number;
  examinedCount: number;
  includedCount: number;
  backfillOccurred: boolean;
  sources: TagReportRunSource[];
}

/**
 * R-M2's mandatory backfill disclosure — "Examined 8 of 12 surveys to find 5
 * usable" — plus the expandable Included/Excluded list with reason chips.
 * This is a required, always-visible element of the report, not a tooltip.
 */
export function DisclosureBanner({ poolSize, examinedCount, includedCount, backfillOccurred, sources }: DisclosureBannerProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  const included = sources.filter((s) => s.checkpoint_id != null);
  const excluded = sources.filter((s) => s.checkpoint_id == null && s.exclusion_reason);

  return (
    <GlassCard className="mb-6 overflow-hidden" style={{ background: 'color-mix(in srgb, var(--color-primary) 6%, white)' }}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left"
        aria-expanded={expanded}
      >
        <div className="flex items-center gap-2 min-w-0">
          <Icon name="fact_check" size={18} style={{ color: 'var(--color-primary)' }} />
          <span className="text-sm font-semibold text-on-surface truncate">
            {t('tagReport.disclosure.examined', { examined: examinedCount, pool: poolSize, included: includedCount })}
          </span>
          {backfillOccurred && (
            <span className="text-xs text-on-surface-variant hidden sm:inline">
              {t('tagReport.disclosure.backfillNote', { excludedCount: excluded.length })}
            </span>
          )}
        </div>
        <Icon
          name={expanded ? 'expand_less' : 'expand_more'}
          size={20}
          className="shrink-0 text-on-surface-variant"
        />
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4 grid grid-cols-1 md:grid-cols-2 gap-4 border-t border-border/50 pt-3">
              <div>
                <p className="label-caps mb-2">{t('tagReport.disclosure.includedHeading')}</p>
                <ul className="space-y-1.5">
                  {included.map((s) => (
                    <li key={s.id} className="flex items-center justify-between gap-2 text-sm">
                      <span className="truncate text-on-surface">{s.survey_title ?? s.survey_id}</span>
                      <span className="text-xs text-on-surface-variant shrink-0">
                        {t('tagReport.disclosure.responseCount', { count: s.response_count_at_generation })}
                      </span>
                    </li>
                  ))}
                  {included.length === 0 && (
                    <li className="text-sm text-on-surface-variant">—</li>
                  )}
                </ul>
              </div>
              <div>
                <p className="label-caps mb-2">{t('tagReport.disclosure.excludedHeading')}</p>
                {excluded.length === 0 ? (
                  <p className="text-sm text-on-surface-variant">{t('tagReport.disclosure.noExclusions')}</p>
                ) : (
                  <ul className="space-y-1.5">
                    {excluded.map((s) => (
                      <li key={s.id} className="flex items-center justify-between gap-2 text-sm">
                        <span className="truncate text-on-surface">{s.survey_title ?? s.survey_id}</span>
                        <span
                          className="text-[11px] font-semibold px-2 py-0.5 rounded-full shrink-0"
                          style={{ background: '#fef3c7', color: '#d97706' }}
                        >
                          {t(`tagReport.stream.excludedReason.${s.exclusion_reason}`)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </GlassCard>
  );
}
