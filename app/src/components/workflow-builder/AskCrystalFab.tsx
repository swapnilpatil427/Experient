import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from '../../lib/i18n';
import { Icon } from '../Icon';

// Wave 14 (docs/automation-hub/WAVE14_UNIFIED_BUILDER_SPEC.md §2) — a pure
// trigger for the existing global CrystalPanel, not a new chat surface. Mounted
// on both WorkflowBuilderPage and WorkflowCanvasPage; the parent wires `onOpen`
// to `openCrystal()`. No pre-filled query — this is a general entry point.
//
// First-view label chip mirrors ExperientCopilot.tsx's exact mechanics
// (`ExperientCopilot.tsx:254-267`): a dismiss-once localStorage-gated chip that
// appears after a short delay and disappears on first interaction/dismissal —
// not a second onboarding-tooltip mechanism.
const SEEN_KEY = 'askCrystalFabSeen';

interface AskCrystalFabProps {
  onOpen: () => void;
}

export function AskCrystalFab({ onOpen }: AskCrystalFabProps) {
  const { t } = useTranslation();
  const [showLabel, setShowLabel] = useState(false);

  useEffect(() => {
    let seen = true;
    try {
      seen = window.localStorage.getItem(SEEN_KEY) === 'true';
    } catch {
      // localStorage unavailable (privacy mode, SSR-like test env) — treat as
      // already seen so we never throw for a purely cosmetic affordance.
      seen = true;
    }
    if (seen) return;
    const timer = setTimeout(() => setShowLabel(true), 1500);
    return () => clearTimeout(timer);
  }, []);

  function dismissLabel() {
    setShowLabel(false);
    try {
      window.localStorage.setItem(SEEN_KEY, 'true');
    } catch {
      // ignore — best-effort persistence only
    }
  }

  function handleOpen() {
    if (showLabel) dismissLabel();
    onOpen();
  }

  return (
    <div className="fixed bottom-24 md:bottom-6 right-4 md:right-6 z-40 flex flex-col items-end gap-2">
      <AnimatePresence>
        {showLabel && (
          <motion.div
            initial={{ opacity: 0, y: 6, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.18 }}
            onClick={dismissLabel}
            className="cursor-pointer bg-white rounded-2xl px-3.5 py-2.5"
            style={{ boxShadow: '0 4px 16px rgba(42,75,217,0.12)', border: '1px solid rgba(42,75,217,0.1)' }}
          >
            <span
              className="text-xs font-black"
              style={{ background: 'linear-gradient(135deg, #2a4bd9, #8329c8)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}
            >
              {t('workflows.builder.askCrystal.label')}
            </span>
          </motion.div>
        )}
      </AnimatePresence>
      <button
        type="button"
        onClick={handleOpen}
        aria-label={t('workflows.builder.askCrystal.aria')}
        title={t('workflows.builder.askCrystal.aria')}
        data-testid="ask-crystal-fab"
        className="w-14 h-14 rounded-2xl flex items-center justify-center shadow-lg transition-transform hover:scale-105 active:scale-95"
        style={{
          background: 'linear-gradient(135deg, #2a4bd9, #8329c8)',
          boxShadow: '0 8px 24px rgba(42,75,217,0.35)',
        }}
      >
        <Icon name="diamond" size={22} style={{ color: 'white' }} />
      </button>
    </div>
  );
}
