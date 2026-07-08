import { Link } from 'react-router-dom';
import { useTranslation } from '../lib/i18n';
import { ROUTES } from '../constants/routes';
import { cn } from '@/lib/utils';

interface ExperienceSubNavProps {
  active: 'overview' | 'reports';
  className?: string;
}

/**
 * Lightweight "Overview | Reports" segmented control for the Experience
 * area (DESIGN.md Appendix C) — the discovery surface for Tag Report's
 * standing `/app/experience/reports` index, chosen over a new top-level
 * sidebar item (SideNav has no expandable/nested-item precedent) and over
 * embedding Reports as a tab inside ExperienceHubPage itself (that page's
 * KPI-glanceable mental model is intentionally distinct from Tag Report's
 * deliberate, dense analyst workflow).
 */
export function ExperienceSubNav({ active, className }: ExperienceSubNavProps) {
  const { t } = useTranslation();
  const items: Array<{ key: 'overview' | 'reports'; label: string; to: string }> = [
    { key: 'overview', label: t('tagReport.nav.overview'), to: ROUTES.EXPERIENCE },
    { key: 'reports', label: t('tagReport.nav.reports'), to: ROUTES.TAG_REPORTS_INDEX },
  ];

  return (
    <div className={cn('inline-flex items-center gap-1 p-1 rounded-xl bg-surface-container-low w-fit', className)}>
      {items.map((item) => (
        <Link
          key={item.key}
          to={item.to}
          className={cn(
            'px-3.5 py-1.5 rounded-lg text-sm font-semibold transition-colors',
            active === item.key
              ? 'bg-white text-on-surface shadow-sm'
              : 'text-on-surface-variant hover:text-on-surface'
          )}
        >
          {item.label}
        </Link>
      ))}
    </div>
  );
}
