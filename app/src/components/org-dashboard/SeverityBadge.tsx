// SeverityBadge — maps alert_events.severity to DESIGN.md §7's Anomaly
// Alerts severity palette. Distinct token set from HealthPill's
// healthy/attention/critical ramp — severity is about an *event*, health is
// about a *state* (Decision 20's Precision Component Specs explicitly warns
// against conflating "provenance"/"severity" palettes with the health ramp).

import type { AlertSeverity } from '../../types/orgDashboard';
import { useTranslation } from '../../lib/i18n';

const PALETTE: Record<AlertSeverity, { bar: string; bg: string; text: string; labelKey: string }> = {
  critical: { bar: '#ef4444', bg: '#fef2f2', text: '#b91c1c', labelKey: 'orgDashboard.alerts.severity.critical' },
  warning:  { bar: '#f59e0b', bg: '#fffbeb', text: '#b45309', labelKey: 'orgDashboard.alerts.severity.warning' },
  info:     { bar: '#60a5fa', bg: '#eff6ff', text: '#1d4ed8', labelKey: 'orgDashboard.alerts.severity.info' },
  success:  { bar: '#22c55e', bg: '#f0fdf4', text: '#15803d', labelKey: 'orgDashboard.alerts.severity.success' },
};

export function severityColor(severity: AlertSeverity) {
  return PALETTE[severity] ?? PALETTE.info;
}

export function SeverityBadge({ severity, className = '' }: { severity: AlertSeverity; className?: string }) {
  const { t } = useTranslation();
  const c = severityColor(severity);
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold ${className}`}
      style={{ background: c.bg, color: c.text }}
    >
      {t(c.labelKey)}
    </span>
  );
}

/** The 4px-wide vertical severity bar used at the left edge of an alert item. */
export function SeverityBar({ severity, pulse = false }: { severity: AlertSeverity; pulse?: boolean }) {
  const c = severityColor(severity);
  return (
    <span
      aria-hidden="true"
      className="flex-shrink-0 rounded-full"
      style={{
        width: 4,
        alignSelf: 'stretch',
        background: c.bar,
        animation: pulse ? 'org-dash-severity-pulse 1.5s ease-in-out 2' : undefined,
      }}
    />
  );
}
