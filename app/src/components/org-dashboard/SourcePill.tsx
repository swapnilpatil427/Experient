// SourcePill — the scheduled/manual provenance badge, extracted out of
// `BriefArchive.tsx` so `BriefProvenancePanel.tsx` ("How was this
// generated?") can reuse the exact same visual convention without a
// circular import between the two components.
//
// Scheduled vs. manual distinction uses dedicated `--source-scheduled` /
// `--source-manual` tokens (war-room.css), never severity colors — provenance
// is not urgency (per the design review's explicit warning against training
// users to misread a "manual" badge as a risk signal).

import { Icon } from '../Icon';
import { useTranslation } from '../../lib/i18n';
import type { BriefSource } from '../../types/orgDashboard';

export function SourcePill({ source, requestedByName }: { source: BriefSource; requestedByName?: string | null }) {
  const { t } = useTranslation();
  if (source === 'scheduled') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-indigo-100 text-indigo-700">
        <Icon name="schedule" size={11} />
        {t('orgDashboard.briefArchive.scheduledPill')}
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-violet-100 text-violet-700"
      title={requestedByName ? t('orgDashboard.briefArchive.requestedBy', { name: requestedByName }) : undefined}
    >
      <Icon name="auto_awesome" size={11} />
      {t('orgDashboard.briefArchive.manualPill')}
    </span>
  );
}
