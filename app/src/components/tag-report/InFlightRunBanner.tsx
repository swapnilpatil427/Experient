import { useTranslation } from '../../lib/i18n';
import { Icon } from '../Icon';
import type { InFlightNotice } from '../../hooks/useTagReport';

interface InFlightRunBannerProps {
  notice: InFlightNotice;
  onDismiss: () => void;
}

/**
 * DESIGN.md Appendix A.5 AC — when a "Generate" trigger resolves to an
 * already-in-flight run rather than a new one, this must be surfaced
 * explicitly, never silently substituted (TRACKER.md Task 17).
 */
export function InFlightRunBanner({ notice, onDismiss }: InFlightRunBannerProps) {
  const { t } = useTranslation();

  const relativeTime = (iso: string): string => {
    const deltaMs = Date.now() - new Date(iso).getTime();
    const minutes = Math.max(0, Math.round(deltaMs / 60000));
    if (minutes < 1) return t('tagReport.inFlight.momentsAgo');
    if (minutes === 1) return t('tagReport.inFlight.minuteAgo');
    if (minutes < 60) return t('tagReport.inFlight.minutesAgo', { count: minutes });
    const hours = Math.round(minutes / 60);
    return hours === 1 ? t('tagReport.inFlight.hourAgo') : t('tagReport.inFlight.hoursAgo', { count: hours });
  };

  return (
    <div
      role="status"
      className="mb-4 flex items-center justify-between gap-3 rounded-xl px-4 py-3 text-sm"
      style={{ background: '#fef3c7', color: '#92400e' }}
    >
      <div className="flex items-center gap-2">
        <Icon name="sync" size={16} />
        <span>{t('tagReport.inFlight.banner', { time: relativeTime(notice.startedAt) })}</span>
      </div>
      <button type="button" onClick={onDismiss} className="font-semibold underline shrink-0">
        {t('tagReport.inFlight.dismiss')}
      </button>
    </div>
  );
}
