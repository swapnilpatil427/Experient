import { useNavigate } from 'react-router-dom';
import { useTranslation } from '../../lib/i18n';
import { Icon } from '../Icon';
import { Button } from '@/components/ui/button';
import { ROUTES, toPath } from '../../constants/routes';

/** Lowest-visual-emphasis power-user affordance — full audit trail (R-T5). */
export function TrailEntryPoint({ tagId }: { tagId: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <div className="rounded-2xl border border-dashed border-border p-5 flex items-center justify-between gap-4 mt-2">
      <div className="flex items-center gap-3 min-w-0">
        <Icon name="history" size={20} className="text-muted-foreground shrink-0" />
        <p className="text-sm text-on-surface-variant truncate">{t('tagReport.trailEntry.description')}</p>
      </div>
      <Button
        variant="outline"
        size="sm"
        className="shrink-0 rounded-xl"
        onClick={() => navigate(toPath(ROUTES.TAG_REPORT_TRAIL, { tagId }))}
      >
        {t('tagReport.trailEntry.cta')}
      </Button>
    </div>
  );
}
