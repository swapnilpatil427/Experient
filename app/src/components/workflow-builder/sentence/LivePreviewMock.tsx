import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from '../../../lib/i18n';
import { Icon } from '../../Icon';
import type { SectionState } from './contentSections';

export interface LivePreviewMockProps {
  actionType: string; // 'notify.slack' | 'notify.email' | 'crystal.summarize'
  sections: SectionState;
}

interface BlockDef {
  key: keyof SectionState;
  icon: string;
  labelKey: string;
}

const BLOCKS: BlockDef[] = [
  { key: 'crystalSummary', icon: 'auto_awesome', labelKey: 'workflows.builder.sentence.content.previewCrystalSummary' },
  { key: 'keyMetrics', icon: 'speed', labelKey: 'workflows.builder.sentence.content.previewKeyMetrics' },
  { key: 'trendChart', icon: 'show_chart', labelKey: 'workflows.builder.sentence.content.previewTrendChart' },
  { key: 'topVerbatims', icon: 'format_quote', labelKey: 'workflows.builder.sentence.content.previewTopVerbatims' },
  { key: 'recommendedActions', icon: 'checklist', labelKey: 'workflows.builder.sentence.content.previewRecommendedActions' },
  { key: 'rawResponseCount', icon: 'tag', labelKey: 'workflows.builder.sentence.content.previewRawResponseCount' },
];

// Right column of ContentCustomizationPanel — a small, clearly-labeled mock
// that re-renders based on checked sections (BUILDER_REDESIGN_V2_CONCEPT.md
// §5/§7). Cross-fades each block in/out (150-200ms) via AnimatePresence so a
// toggle reads as cause-and-effect, not a jump-cut.
export function LivePreviewMock({ actionType, sections }: LivePreviewMockProps) {
  const { t } = useTranslation();
  const chrome =
    actionType === 'notify.slack'
      ? { label: t('workflows.builder.sentence.content.previewChromeSlack'), icon: 'tag' }
      : actionType === 'notify.email'
        ? { label: t('workflows.builder.sentence.content.previewChromeEmail'), icon: 'mail' }
        : { label: t('workflows.builder.sentence.content.previewChromeSummary'), icon: 'auto_awesome' };

  const activeBlocks = BLOCKS.filter((b) => sections[b.key]);

  return (
    <div className="rounded-xl border border-border bg-surface-container-low p-4" data-testid="live-preview-mock">
      <div className="flex items-center gap-2 mb-3 pb-2 border-b border-border">
        <Icon name={chrome.icon} size={16} className="text-on-surface-variant" />
        <p className="text-xs font-bold uppercase tracking-wide text-on-surface-variant">{chrome.label}</p>
      </div>

      <div className="space-y-2 min-h-[80px]">
        <AnimatePresence mode="popLayout">
          {activeBlocks.length === 0 && (
            <motion.p
              key="empty"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              className="text-xs text-on-surface-variant italic"
            >
              {t('workflows.builder.sentence.content.previewEmpty')}
            </motion.p>
          )}
          {activeBlocks.map((b) => (
            <motion.div
              key={b.key}
              data-testid={`preview-block-${b.key}`}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.18 }}
              className="flex items-start gap-2 rounded-lg bg-white border border-border px-3 py-2"
            >
              <Icon name={b.icon} size={14} className="text-primary mt-0.5 flex-shrink-0" />
              <span className="text-xs text-on-surface">{t(b.labelKey)}</span>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}
