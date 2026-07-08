import type { ReactNode } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from '../../../lib/i18n';
import { Icon } from '../../Icon';
import { Button } from '@/components/ui/button';

export interface StepPanelProps {
  open: boolean;
  label: string;
  onCancel: () => void;
  onDone: () => void;
  doneDisabled?: boolean;
  children: ReactNode;
  testId?: string;
}

// The full-focus slide-down surface (BUILDER_REDESIGN_V2_CONCEPT.md §7 component
// #3). Mounts/unmounts with the house entrance curve from app/CLAUDE.md
// ({ opacity: 0, y: 16 } → { opacity: 1, y: 0 }, ease [0.22, 1, 0.36, 1]),
// wrapped in AnimatePresence so switching between step-panels doesn't jar.
export function StepPanel({ open, label, onCancel, onDone, doneDisabled, children, testId }: StepPanelProps) {
  const { t } = useTranslation();
  return (
    <AnimatePresence mode="wait">
      {open && (
        <motion.div
          key={testId ?? label}
          data-testid={testId ?? 'step-panel'}
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
          className="w-full rounded-2xl border border-border bg-white overflow-hidden"
          style={{ boxShadow: '0 20px 50px -12px rgba(0,0,0,0.12)' }}
        >
          <div className="flex items-center gap-3 px-5 py-4 border-b border-border">
            <button
              type="button"
              aria-label={t('workflows.builder.sentence.stepPanel.backAria')}
              onClick={onCancel}
              className="p-1.5 rounded-lg hover:bg-accent"
            >
              <Icon name="chevron_left" size={18} />
            </button>
            <p className="font-bold text-on-surface">{label}</p>
          </div>

          <div className="p-5 max-h-[70vh] overflow-y-auto">{children}</div>

          <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border bg-surface-container-low">
            <Button variant="outline" size="sm" onClick={onCancel}>
              {t('workflows.builder.sentence.stepPanel.cancel')}
            </Button>
            <Button size="sm" onClick={onDone} disabled={doneDisabled}>
              {t('workflows.builder.sentence.stepPanel.done')}
            </Button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
