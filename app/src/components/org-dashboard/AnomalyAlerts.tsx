// AnomalyAlerts — DESIGN.md §7. Right sidebar (4/12 cols) on lg+, full width
// below ProgramsTable on md and smaller — the parent page controls the grid
// placement; this component just renders full-width.
//
// Backed by `alert_events` (Decision 23) via `useOrgAlerts.ts` — no new
// anomaly-storage table. On the full Command Center page this is labeled
// "Program Alerts panel" per DESIGN.md's route-mapping section.

import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Icon } from '../Icon';
import { useTranslation } from '../../lib/i18n';
import { ROUTES, toPath } from '../../constants/routes';
import { SeverityBar } from './SeverityBadge';
import type { OrgAlert } from '../../types/orgDashboard';

function relativeTime(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function AnomalyAlerts({
  alerts, loading, totalUnresolved, onAcknowledge, acknowledging = {}, newAlertIds = [],
}: {
  alerts: OrgAlert[];
  loading: boolean;
  totalUnresolved: number;
  onAcknowledge: (id: string) => void;
  acknowledging?: Record<string, boolean>;
  newAlertIds?: string[];
}) {
  const { t } = useTranslation();

  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm">
      <style>{`
        @keyframes org-dash-severity-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
        @keyframes org-dash-alert-slide-in {
          from { opacity: 0; transform: translateY(-8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
      <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-100">
        <span className="text-sm font-semibold text-gray-900">{t('orgDashboard.alerts.title')}</span>
        {totalUnresolved > 0 && (
          <span className="px-1.5 py-0.5 rounded-full bg-red-100 text-red-700 text-[10px] font-bold">
            {totalUnresolved}
          </span>
        )}
      </div>

      {loading && (
        <div className="p-3 space-y-2">
          {[...Array(3)].map((_, i) => <div key={i} className="h-14 rounded-lg bg-surface-container animate-pulse" />)}
        </div>
      )}

      {!loading && alerts.length === 0 && (
        <div className="p-8 text-center">
          <Icon name="verified" size={28} style={{ color: '#22c55e' }} />
          <p className="text-sm font-semibold text-gray-900 mt-2">{t('orgDashboard.alerts.empty')}</p>
        </div>
      )}

      {!loading && alerts.length > 0 && (
        <ul className="divide-y divide-gray-100">
          {alerts.map((alert) => {
            const isNew = newAlertIds.includes(alert.id);
            return (
              <li
                key={alert.id}
                role={isNew ? 'alert' : undefined}
                aria-label={isNew ? t('orgDashboard.alerts.newAriaLabel', {
                  severity: alert.severity, description: alert.description,
                  surveyName: alert.surveyTitle ?? '', timeAgo: relativeTime(alert.detectedAt),
                }) : undefined}
                className="group flex gap-3 px-4 py-3"
                style={isNew ? { animation: 'org-dash-alert-slide-in 300ms ease-out' } : undefined}
              >
                <SeverityBar severity={alert.severity} pulse={isNew} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-gray-900 truncate">
                    {alert.surveyTitle ?? t('orgDashboard.alerts.orgWide')}
                  </p>
                  <p className="text-xs text-gray-600">{alert.description}</p>
                  <p className="text-xs text-gray-400 mt-0.5">{relativeTime(alert.detectedAt)}</p>
                </div>
                <div className="flex-shrink-0 hidden group-hover:flex items-start gap-1 pt-0.5">
                  <Button
                    variant="ghost" size="sm" className="h-6 px-1.5 text-[11px]"
                    disabled={!!acknowledging[alert.id]}
                    onClick={() => onAcknowledge(alert.id)}
                  >
                    {t('orgDashboard.alerts.resolve')}
                  </Button>
                  {alert.surveyId && (
                    <Link to={toPath(ROUTES.EXPERIENCE_SURVEY, { surveyId: alert.surveyId })}>
                      <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[11px]">
                        {t('orgDashboard.alerts.view')}
                      </Button>
                    </Link>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
