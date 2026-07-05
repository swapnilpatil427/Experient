// GenerationStatusChip — "Ask Crystal for a Brief," in progress. Precision
// Component Specs #3 (DESIGN.md, Decision 20).
//
// Reuses the existing CSS-only conic-gradient hex crystal motif (same
// three-layer structure as `ExperienceHubPage.tsx`'s `CrystalOrb` /
// `CrystalPanel.tsx`'s thinking orb), shrunk to 24px, plus the confirmed
// `crystal-spin`/`pulse-glow` keyframes already defined globally
// (`index.css`, `CrystalPanel.tsx`) — no new visual motif invented.

import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import { Icon } from '../Icon';
import { useTranslation } from '../../lib/i18n';

export type GenerationStatusState = 'in-progress' | 'reconnecting' | 'failure' | 'timeout';

const ROTATING_KEYS = [
  'orgDashboard.generationStatus.reading',
  'orgDashboard.generationStatus.synthesizing',
  'orgDashboard.generationStatus.writing',
];

function CrystalMotif({ spinning }: { spinning: boolean }) {
  return (
    <div style={{ width: 24, height: 24, position: 'relative', flexShrink: 0 }}>
      <div style={{
        position: 'absolute', inset: 0,
        background: 'conic-gradient(from 0deg at 50% 50%, var(--color-primary-container) 0%, var(--color-tertiary-container) 25%, var(--color-secondary-container) 50%, var(--color-tertiary-container) 75%, var(--color-primary-container) 100%)',
        clipPath: 'polygon(50% 0%, 100% 30%, 100% 70%, 50% 100%, 0% 70%, 0% 30%)',
        animation: spinning ? 'crystal-spin 4s linear infinite' : undefined,
      }} />
      <div style={{
        position: 'absolute', inset: '32%',
        background: 'radial-gradient(circle, #fff, var(--color-secondary-container))',
        borderRadius: '50%', filter: 'blur(2px)',
        animation: spinning ? 'pulse-glow 2.5s ease-in-out infinite' : undefined,
      }} />
    </div>
  );
}

export function GenerationStatusChip({
  state, onRetry,
}: {
  state: GenerationStatusState;
  onRetry?: () => void;
}) {
  const { t } = useTranslation();
  const [rotatingIdx, setRotatingIdx] = useState(0);
  const prefersReducedMotion = typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  useEffect(() => {
    if (state !== 'in-progress') return;
    const id = setInterval(() => setRotatingIdx((i) => (i + 1) % ROTATING_KEYS.length), 4000);
    return () => clearInterval(id);
  }, [state]);

  const isSpinning = state === 'in-progress' || state === 'reconnecting' || state === 'timeout';
  const textColor = state === 'reconnecting' ? 'text-amber-600'
    : state === 'timeout' ? 'text-on-surface-variant'
    : state === 'failure' ? ''
    : 'text-[#8329c8]';

  return (
    <div
      className="inline-flex items-center gap-2.5 px-3 py-2 rounded-full"
      style={{ background: 'rgba(131,41,200,0.08)', border: '1px solid rgba(131,41,200,0.18)' }}
    >
      {state === 'failure' ? (
        <Icon name="error_outline" size={16} style={{ color: '#b41340' }} />
      ) : (
        <CrystalMotif spinning={isSpinning && !prefersReducedMotion} />
      )}

      {state === 'failure' ? (
        <button type="button" onClick={onRetry} className="text-xs font-semibold underline-offset-2 hover:underline" style={{ color: '#b41340' }}>
          {t('orgDashboard.generationStatus.failure')}
        </button>
      ) : state === 'reconnecting' ? (
        <span className={`text-xs font-semibold ${textColor}`}>{t('orgDashboard.generationStatus.reconnecting')}</span>
      ) : state === 'timeout' ? (
        <span className={`text-xs font-semibold ${textColor}`}>{t('orgDashboard.generationStatus.timeout')}</span>
      ) : (
        <AnimatePresence mode="wait">
          <motion.span
            key={rotatingIdx}
            initial={prefersReducedMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className={`text-xs font-semibold ${textColor}`}
          >
            {t(ROTATING_KEYS[rotatingIdx])}
          </motion.span>
        </AnimatePresence>
      )}
    </div>
  );
}
