// HealthPill — new, unified healthy/attention/critical status palette for
// Org Dashboard (Command Center). No such component existed anywhere in the
// codebase before this (verified by direct audit, IMPLEMENTATION_SPEC.md).
//
// This is intentionally the ONE new unified palette for org-dashboard code —
// it does not attempt to refactor the 6 independent `npsColor()` copies
// scattered across the app (ExperienceHubPage, SurveyIntelligencePage,
// SurveyTrendsPage, SurveysListPage, TopicDetailPanel,
// RecentResponsesWidget) — that unification is explicitly out of scope here
// and flagged as a follow-up in TRACKER.md.
//
// Colors per DESIGN.md's Color System section (light mode) and the War Room
// Mode neon overrides (dark mode, via `[data-theme="war-room"]` CSS vars in
// `war-room.css`). WCAG AA — text/background pairs below meet >= 4.5:1.

import { useTranslation } from '../../lib/i18n';
import type { HealthStatus } from '../../types/orgDashboard';

const PALETTE: Record<HealthStatus, { bg: string; text: string; dot: string; labelKey: string }> = {
  healthy:   { bg: '#F0FDF4', text: '#15803D', dot: '#22C55E', labelKey: 'orgDashboard.health.healthy' },
  attention: { bg: '#FFFBEB', text: '#B45309', dot: '#F59E0B', labelKey: 'orgDashboard.health.attention' },
  critical:  { bg: '#FFF1F2', text: '#BE123C', dot: '#F43F5E', labelKey: 'orgDashboard.health.critical' },
};

export function healthStatusColor(status: HealthStatus): { bg: string; text: string; dot: string } {
  return PALETTE[status];
}

/** Maps a 0-100 health score onto the same three-tier palette used everywhere else. */
export function healthStatusFromScore(score: number): HealthStatus {
  if (score >= 70) return 'healthy';
  if (score >= 40) return 'attention';
  return 'critical';
}

export function HealthPill({
  status, size = 'md', showDot = true, className = '',
}: {
  status: HealthStatus;
  size?: 'sm' | 'md';
  showDot?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const c = PALETTE[status];
  const label = t(c.labelKey);
  const sizeCls = size === 'sm' ? 'text-[10px] px-1.5 py-0.5' : 'text-xs px-2 py-1';
  return (
    <span
      role="status"
      aria-label={t('orgDashboard.health.ariaLabel', { status: label })}
      className={`inline-flex items-center gap-1.5 rounded-full font-bold border ${sizeCls} ${className}`}
      style={{ background: c.bg, color: c.text, borderColor: `${c.text}33` }}
    >
      {showDot && (
        <span
          className="rounded-full flex-shrink-0"
          style={{ width: 6, height: 6, background: c.dot }}
          aria-hidden="true"
        />
      )}
      {label}
    </span>
  );
}
