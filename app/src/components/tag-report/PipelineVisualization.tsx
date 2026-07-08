import { Component, Suspense, lazy, useMemo, useState, useEffect } from 'react';
import type { ReactNode } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from '../../lib/i18n';
import { deriveTagReportProgress } from '../../lib/tagReportProgress';
import { ReducedMotionStepper } from './ReducedMotionStepper';
import type { TagReportStreamEvent } from '../../types/tagReport';

const TagReportScene = lazy(() =>
  import('./three/TagReportScene').then((m) => ({ default: m.TagReportScene }))
);

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  );
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const handler = () => setReduced(mq.matches);
    mq.addEventListener?.('change', handler);
    return () => mq.removeEventListener?.('change', handler);
  }, []);
  return reduced;
}

/** Catches WebGL/Three.js mount failures and falls back to the text stepper. */
class CanvasErrorBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

interface PipelineVisualizationProps {
  events: TagReportStreamEvent[];
  /** Collapsed to a ~120px strip once the report has rendered (Part B layout). */
  collapsed?: boolean;
}

/**
 * Part A of the UX spec — the streaming pipeline visualization. Mounts the
 * Three.js scene only when motion is allowed; otherwise renders the
 * accessible vertical-stepper fallback with 100% of the same information.
 * Always lazy-loaded per app/CLAUDE.md's Three.js conventions — HeroCanvas
 * itself has no reduced-motion gate, so this component implements its own.
 */
export function PipelineVisualization({ events, collapsed = false }: PipelineVisualizationProps) {
  const { t } = useTranslation();
  const prefersReducedMotion = usePrefersReducedMotion();
  const progress = useMemo(() => deriveTagReportProgress(events), [events]);

  const stageLabel = t(`tagReport.stream.stageLabel.${progress.stage}`);
  const liveAnnouncement = progress.backfillActive
    ? t('tagReport.stream.liveAnnouncement', { stage: stageLabel, detail: t('tagReport.stream.backfillNote') })
    : stageLabel;

  if (prefersReducedMotion) {
    return (
      <div data-testid="tag-report-stepper">
        <ReducedMotionStepper progress={progress} />
      </div>
    );
  }

  return (
    <div
      data-testid="tag-report-pipeline-viz"
      className="relative w-full rounded-2xl overflow-hidden mb-6"
      style={{
        aspectRatio: collapsed ? undefined : '16 / 7',
        height: collapsed ? 120 : undefined,
        background: 'radial-gradient(ellipse at center, #0b1020 0%, #05060d 100%)',
      }}
    >
      {/* HUD caption — the accessible anchor even with the canvas rendered */}
      <div className="absolute top-3 left-0 right-0 flex justify-center z-10 pointer-events-none">
        <AnimatePresence mode="wait">
          <motion.span
            key={progress.stage}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="text-xs font-semibold tracking-wide text-white/80 px-3 py-1 rounded-full bg-white/10 backdrop-blur-sm"
          >
            {stageLabel}
          </motion.span>
        </AnimatePresence>
      </div>

      <CanvasErrorBoundary fallback={<ReducedMotionStepper progress={progress} />}>
        <Suspense fallback={null}>
          <TagReportScene progress={progress} />
        </Suspense>
      </CanvasErrorBoundary>

      {/* Bottom progress rail — 6 segments (5 when Comparison is skipped in Manual/Automated) */}
      {!collapsed && (
        <div className="absolute bottom-3 left-4 right-4 flex gap-1.5 z-10">
          {Array.from({ length: progress.totalStages }, (_, i) => (
            <div
              key={i}
              className="h-1 flex-1 rounded-full transition-colors duration-300"
              style={{ background: i <= progress.stageIndex ? 'var(--color-primary)' : 'rgba(255,255,255,0.15)' }}
            />
          ))}
        </div>
      )}

      {/* Screen-reader announcement of stage transitions — the canvas itself is aria-hidden */}
      <div className="sr-only" aria-live="polite">{liveAnnouncement}</div>
    </div>
  );
}
