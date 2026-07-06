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
  // `--org-dash-gen-*` vars are only ever defined (war-room.css, scoped to
  // `[data-org-dash-generation-chip]`) under War Room Mode — the fallback
  // here is what renders in ordinary light mode, so this single style object
  // covers both themes without a `text-*` utility class, since a plain
  // Tailwind class's literal color can never be overridden by a var-based
  // stylesheet rule once a component also carries an inline color.
  const textStyle = state === 'reconnecting' ? { color: 'var(--org-dash-gen-warn, #d97706)' }
    : state === 'timeout' ? undefined // already a theme token (text-on-surface-variant), no change needed
    : state === 'failure' ? { color: 'var(--org-dash-gen-fail, #b41340)' }
    : { color: 'var(--org-dash-gen-accent, #8329c8)' };
  const textClass = state === 'timeout' ? 'text-on-surface-variant' : '';

  return (
    <div
      className="inline-flex items-center gap-2.5 px-3 py-2 rounded-full"
      data-org-dash-generation-chip
      style={{
        background: 'var(--org-dash-gen-bg, rgba(131,41,200,0.08))',
        border: '1px solid var(--org-dash-gen-border, rgba(131,41,200,0.18))',
      }}
    >
      {state === 'failure' ? (
        <Icon name="error_outline" size={16} style={textStyle} />
      ) : (
        <CrystalMotif spinning={isSpinning && !prefersReducedMotion} />
      )}

      {state === 'failure' ? (
        <button type="button" onClick={onRetry} className="text-xs font-semibold underline-offset-2 hover:underline" style={textStyle}>
          {t('orgDashboard.generationStatus.failure')}
        </button>
      ) : state === 'reconnecting' ? (
        <span className={`text-xs font-semibold ${textClass}`} style={textStyle}>{t('orgDashboard.generationStatus.reconnecting')}</span>
      ) : state === 'timeout' ? (
        <span className={`text-xs font-semibold ${textClass}`} style={textStyle}>{t('orgDashboard.generationStatus.timeout')}</span>
      ) : (
        <AnimatePresence mode="wait">
          <motion.span
            key={rotatingIdx}
            initial={prefersReducedMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className={`text-xs font-semibold ${textClass}`}
            style={textStyle}
          >
            {t(ROTATING_KEYS[rotatingIdx])}
          </motion.span>
        </AnimatePresence>
      )}
    </div>
  );
}
