import { useTranslation } from '../../lib/i18n';
import { Icon } from '../Icon';
import { TAG_REPORT_STAGES } from '../../types/tagReport';
import type { TagReportProgress } from '../../lib/tagReportProgress';

const STAGE_ICON: Record<string, string> = {
  discovery: 'travel_explore',
  checkpoint: 'schedule',
  comparison: 'compare_arrows',
  gating: 'filter_alt',
  merge: 'merge',
  narrative: 'auto_awesome',
};

interface ReducedMotionStepperProps {
  progress: TagReportProgress;
}

/**
 * `prefers-reduced-motion: reduce` fallback for the pipeline visualization
 * (Part A of the UX spec) — carries 100% of the same information as the
 * Three.js scene (stage name, backfill note, gating reasons, trust outcome)
 * via text/icons only, no motion.
 */
export function ReducedMotionStepper({ progress }: ReducedMotionStepperProps) {
  const { t } = useTranslation();

  return (
    <div aria-label={t('tagReport.stepper.ariaLabel')} className="py-6">
      <ol className="space-y-0">
        {TAG_REPORT_STAGES.map((stage, i) => {
          const isDone = i < progress.stageIndex || progress.done;
          const isActive = i === progress.stageIndex && !progress.done;
          return (
            <li key={stage} className="flex gap-3">
              <div className="flex flex-col items-center">
                <div
                  className="w-8 h-8 rounded-full flex items-center justify-center shrink-0"
                  style={{
                    background: isDone ? 'var(--color-success, #059669)' : isActive ? 'var(--color-primary)' : '#e2e8f0',
                    color: isDone || isActive ? 'white' : '#64748b',
                  }}
                >
                  <Icon name={isDone ? 'check' : STAGE_ICON[stage]} size={16} />
                </div>
                {i < TAG_REPORT_STAGES.length - 1 && (
                  <div className="w-0.5 flex-1 min-h-[24px]" style={{ background: isDone ? 'var(--color-success, #059669)' : '#e2e8f0' }} />
                )}
              </div>
              <div className="pb-6 pt-1">
                <p className="text-sm font-bold text-on-surface">
                  {t(`tagReport.stream.stageLabel.${stage}`)}
                </p>
                {isActive && progress.backfillActive && (
                  <p className="text-xs text-amber-700 mt-1 flex items-center gap-1">
                    <Icon name="refresh" size={12} />
                    {t('tagReport.stream.backfillNote')}
                  </p>
                )}
                {stage === 'discovery' && progress.surveys.length > 0 && (
                  <ul className="mt-1.5 space-y-1">
                    {progress.surveys.map((s) => (
                      <li key={s.survey_id} className="text-xs flex items-center gap-1.5">
                        <span
                          className="w-1.5 h-1.5 rounded-full shrink-0"
                          style={{ background: s.excluded ? '#94a3b8' : 'var(--color-primary)' }}
                        />
                        <span className={s.excluded ? 'text-on-surface-variant line-through' : 'text-on-surface'}>
                          {s.title}
                        </span>
                        {s.isBackfill && (
                          <span className="text-[10px] font-semibold px-1.5 rounded-full bg-amber-100 text-amber-700">
                            {t('tagReport.stepper.backfillBadge')}
                          </span>
                        )}
                        {s.excluded && s.excludedReason && (
                          <span className="text-on-surface-variant">
                            — {t(`tagReport.stream.excludedReason.${s.excludedReason}`)}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {stage === 'merge' && Object.keys(progress.metricTracks).length > 0 && (
                  <ul className="mt-1.5 space-y-1">
                    {Object.values(progress.metricTracks).map((track) => (
                      <li key={track.metric_key} className="text-xs text-on-surface-variant">
                        {track.metric_key.toUpperCase()}: {track.confidenceTier
                          ? t(`tagReport.metricCard.confidence.${track.confidenceTier}`)
                          : t('common.loading')}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
