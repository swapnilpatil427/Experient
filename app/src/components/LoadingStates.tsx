import { motion, AnimatePresence } from 'framer-motion';

interface SpinnerProps {
  size?: number;
  color?: string;
  className?: string;
}

export function Spinner({ size = 24, color = '#2a4bd9', className = '' }: SpinnerProps) {
  return (
    <div
      className={`rounded-full animate-spin flex-shrink-0 ${className}`}
      style={{
        width: size,
        height: size,
        border: `${Math.max(2, size / 10)}px solid ${color}22`,
        borderTopColor: color,
      }}
    />
  );
}

interface FullPageLoaderProps {
  message?: string;
}

export function FullPageLoader({ message = 'Loading…' }: FullPageLoaderProps) {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen gap-4 bg-surface">
      <Spinner size={40} />
      <p className="text-sm font-semibold text-on-surface-variant">{message}</p>
    </div>
  );
}

export function SurveyCardSkeleton() {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="rounded-2xl p-5 bg-white"
      style={{ boxShadow: '0 4px 20px rgba(0,0,0,0.04)', border: '1px solid rgba(171,173,175,0.12)' }}
    >
      <div className="flex items-start justify-between mb-4">
        <div className="skeleton h-5 w-48 rounded-lg" />
        <div className="skeleton h-5 w-16 rounded-full" />
      </div>
      <div className="skeleton h-3 w-full rounded mb-2" />
      <div className="skeleton h-3 w-3/4 rounded mb-4" />
      <div className="flex items-center gap-3">
        <div className="skeleton h-4 w-20 rounded" />
        <div className="skeleton h-4 w-20 rounded" />
      </div>
    </motion.div>
  );
}

interface SurveyListSkeletonProps {
  count?: number;
}

export function SurveyListSkeleton({ count = 4 }: SurveyListSkeletonProps) {
  return (
    <div className="space-y-4">
      {Array.from({ length: count }, (_, i) => (
        <motion.div
          key={i}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: i * 0.06 }}
        >
          <SurveyCardSkeleton />
        </motion.div>
      ))}
    </div>
  );
}

export function TagReportCardSkeleton() {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="rounded-2xl p-5 bg-white"
      style={{ boxShadow: '0 4px 20px rgba(0,0,0,0.04)', border: '1px solid rgba(171,173,175,0.12)' }}
    >
      <div className="flex items-center gap-2 mb-4">
        <div className="skeleton h-2.5 w-2.5 rounded-full" />
        <div className="skeleton h-4 w-32 rounded-lg" />
      </div>
      <div className="skeleton h-3 w-20 rounded mb-3" />
      <div className="flex items-center gap-2">
        <div className="skeleton h-4 w-24 rounded" />
        <div className="skeleton h-4 w-16 rounded-full" />
      </div>
    </motion.div>
  );
}

interface TagReportsIndexSkeletonProps {
  count?: number;
}

/** Modeled on `SurveyListSkeleton`'s shape/rhythm — TRACKER.md Part C. */
export function TagReportsIndexSkeleton({ count = 6 }: TagReportsIndexSkeletonProps) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {Array.from({ length: count }, (_, i) => (
        <motion.div
          key={i}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: i * 0.06 }}
        >
          <TagReportCardSkeleton />
        </motion.div>
      ))}
    </div>
  );
}

interface OverlayLoaderProps {
  message?: string;
  visible?: boolean;
}

export function OverlayLoader({ message = 'Saving…', visible = false }: OverlayLoaderProps) {
  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key="overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[100] flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.35)', backdropFilter: 'blur(4px)' }}
        >
          <motion.div
            initial={{ scale: 0.88, opacity: 0, y: 12 }}
            animate={{ scale: 1, opacity: 1, y: 0, transition: { duration: 0.3, ease: [0.22, 1, 0.36, 1] } }}
            exit={{ scale: 0.92, opacity: 0, y: 8, transition: { duration: 0.18 } }}
            className="flex flex-col items-center gap-4 px-10 py-8 rounded-3xl bg-white mx-4"
            style={{ boxShadow: '0 40px 80px rgba(0,0,0,0.18)' }}
          >
            <Spinner size={40} />
            <p className="text-sm font-bold text-on-surface">{message}</p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
