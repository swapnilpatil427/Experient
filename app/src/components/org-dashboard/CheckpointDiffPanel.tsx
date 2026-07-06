// CheckpointDiffPanel — "Compare to previous", Precision Component Specs #4
// (DESIGN.md, Decision 20). Org-level only for now (Decision 17 item 4) —
// never renders if there's no comparable prior checkpoint (caller already
// guards this via `parentCheckpointId`).
//
// Desktop/tablet: two-column before/after. Mobile: sequential stack
// (Before, then After, then delta) — two columns of numbers don't fit under
// 375px. Fetched lazily on click (this component mounts only when the
// caller's "Compare to previous" toggle is on).

import { useEffect } from 'react';
import { motion } from 'framer-motion';
import { Icon } from '../Icon';
import { useTranslation } from '../../lib/i18n';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { useCheckpointCompare } from '../../hooks/useOrgDashboard';
import { healthStatusColor } from './HealthPill';
import type { CheckpointComparisonDelta, CheckpointCompareSide } from '../../types/orgDashboard';

const HOUSE_CURVE: [number, number, number, number] = [0.22, 1, 0.36, 1];

function verdictColor(verdict: string): string {
  const v = verdict.toLowerCase();
  if (v.includes('improv') || v.includes('healthy')) return healthStatusColor('healthy').text;
  if (v.includes('declin') || v.includes('critical')) return healthStatusColor('critical').text;
  return healthStatusColor('attention').text;
}

function SideCard({ eyebrow, side }: { eyebrow: string; side: CheckpointCompareSide }) {
  return (
    <div className="bg-surface-container/40 rounded-lg p-4">
      <div className="text-[10px] font-black uppercase tracking-widest text-on-surface-variant">{eyebrow}</div>
      <div className="text-[10px] text-on-surface-variant/60 mb-2">{side.dateRangeLabel}</div>
      <div className="text-lg font-black" style={{ color: verdictColor(side.verdict) }}>{side.verdict}</div>
    </div>
  );
}

function DeltaPill({ delta }: { delta: CheckpointComparisonDelta }) {
  const color = delta.positive ? '#059669' : '#b41340';
  const bg = delta.positive ? '#05966914' : '#b4134014';
  return (
    <span
      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold tabular-nums"
      style={{ color, background: bg }}
      title={`${delta.label}: ${delta.delta > 0 ? '+' : ''}${delta.delta}`}
    >
      <Icon name={delta.positive ? 'arrow_upward' : 'arrow_downward'} size={12} />
      {delta.label}
    </span>
  );
}

export function CheckpointDiffPanel({ currentId, previousId }: { currentId: string; previousId: string }) {
  const { t } = useTranslation();
  const bp = useBreakpoint();
  const { result, loading, error, compare } = useCheckpointCompare();

  useEffect(() => { compare(currentId, previousId); }, [currentId, previousId, compare]);

  const prefersReducedMotion = typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  // Error must be checked before the loading/!result fallback — `result` stays
  // null on a failed fetch, so `!result` alone would keep showing the loading
  // skeleton forever instead of ever reaching this branch (found while
  // building BriefProvenancePanel.tsx, which follows the same hook shape;
  // fixed here too since it's the same latent bug, not just avoided there).
  if (error) {
    return (
      <div className="p-5 rounded-xl border border-outline-variant/20 mt-3">
        <p className="text-sm text-on-surface-variant">{t('orgDashboard.checkpointDiff.error')}</p>
      </div>
    );
  }

  if (loading || !result) {
    return (
      <div className="p-5 rounded-xl border border-outline-variant/20 mt-3 grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="h-24 rounded-lg bg-surface-container animate-pulse" />
        <div className="h-24 rounded-lg bg-surface-container animate-pulse" />
      </div>
    );
  }

  const isMobile = bp === 'mobile';

  return (
    <div className="p-5 rounded-xl border border-outline-variant/20 mt-3 bg-white" data-org-dash-surface>
      {isMobile ? (
        <div className="space-y-3">
          <SideCard eyebrow={t('orgDashboard.checkpointDiff.previous')} side={result.previous} />
          <SideCard eyebrow={t('orgDashboard.checkpointDiff.current')} side={result.current} />
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4">
          <motion.div initial={prefersReducedMotion ? false : { opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease: HOUSE_CURVE }}>
            <SideCard eyebrow={t('orgDashboard.checkpointDiff.previous')} side={result.previous} />
          </motion.div>
          <motion.div initial={prefersReducedMotion ? false : { opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease: HOUSE_CURVE }}>
            <SideCard eyebrow={t('orgDashboard.checkpointDiff.current')} side={result.current} />
          </motion.div>
        </div>
      )}

      {result.deltas.length > 0 && (
        <motion.div
          initial={prefersReducedMotion ? false : { scale: 0.8 }}
          animate={{ scale: 1 }}
          transition={{ duration: 0.4, ease: HOUSE_CURVE }}
          className="flex flex-wrap gap-2 mt-4"
        >
          {result.deltas.map((d) => <DeltaPill key={d.key} delta={d} />)}
        </motion.div>
      )}
    </div>
  );
}
