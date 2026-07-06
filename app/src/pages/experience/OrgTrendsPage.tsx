// OrgTrendsPage — the full Command Center, promoted from a 34-line stub per
// Decision 19 ("the Hub-vs-full-page split is now explicit"). Registered at
// the existing `ROUTES.EXPERIENCE_ORG_TRENDS` route — no new route needed.
//
// The original `useOrgOverview()`-backed 4-stat grid is preserved verbatim
// (still the fastest-loading, simplest summary) and extended below it with
// the full Command Center: Health Score breakdown, full Crystal Brief,
// Brief Archive + Manual Summary Generator, full Tag Intelligence grid,
// Program Alerts panel, NPS trend chart, Programs table, Checkpoint Compare
// (nested inside Brief Archive entries), and the War Room Mode toggle.
//
// DESIGN.md's TopNav/HealthBar and FilterBar (⌘K command bar, tag-group
// filter dropdown, CalendarDateRangePicker) describe infrastructure that
// does not exist anywhere in this codebase (no global command bar beyond
// `SupportCommandPalette`, no shared date-range-picker component) — per
// IMPLEMENTATION_SPEC.md, those are aspirational. This page uses the
// existing `AppShell`/`PageHeader` conventions instead, per the Responsive
// Design section's own guidance for the Response Detail viewer ("no new
// pattern required").

import { useCallback, useState } from 'react';
import { useTranslation } from '../../lib/i18n';
import { useCrystalPanel } from '../../contexts/crystalPanel';
import { useOrgOverview } from '../../hooks/useExperience';
import {
  useOrgDashboard, useOrgHealthScore, useOrgCrystalBrief, useOrgBriefArchive, useOrgTrends,
} from '../../hooks/useOrgDashboard';
import { useOrgPrograms } from '../../hooks/useOrgPrograms';
import { useOrgAlerts } from '../../hooks/useOrgAlerts';
import { useOrgTopics } from '../../hooks/useOrgTopics';
import { useTagMetrics } from '../../hooks/useTagMetrics';
import { useOrgDashboardLive } from '../../hooks/useOrgDashboardLive';
import { useBreakpoint } from '../../hooks/useBreakpoint';

import { KpiTile } from '../../components/org-dashboard/KpiTile';
import { CrystalBriefCard } from '../../components/org-dashboard/CrystalBriefCard';
import { AnomalyAlerts } from '../../components/org-dashboard/AnomalyAlerts';
import { EmergingTopics } from '../../components/org-dashboard/EmergingTopics';
import { TagIntelligenceGrid } from '../../components/org-dashboard/TagIntelligenceGrid';
import { NPSTrendChart } from '../../components/org-dashboard/NPSTrendChart';
import { ProgramsTable } from '../../components/org-dashboard/ProgramsTable';
import { BriefArchive } from '../../components/org-dashboard/BriefArchive';
import { ManualSummaryGenerator } from '../../components/org-dashboard/ManualSummaryGenerator';
import { GenerationStatusChip, type GenerationStatusState } from '../../components/org-dashboard/GenerationStatusChip';
import { HealthPill, healthStatusColor } from '../../components/org-dashboard/HealthPill';
import { WarRoomToggle, useWarRoomMode } from '../../components/org-dashboard/WarRoomToggle';
import { Icon } from '../../components/Icon';
import type { OrgDashboardLiveEvent } from '../../types/orgDashboard';
import './../../components/org-dashboard/war-room.css';

export function OrgTrendsPage() {
  const { t } = useTranslation();
  const { openCrystal, setScope } = useCrystalPanel();
  const bp = useBreakpoint();
  const [warRoom, toggleWarRoom] = useWarRoomMode();

  // ── Original stub's data source — preserved, still drives the top stat grid.
  const { data: overviewData, loading: overviewLoading } = useOrgOverview();
  const d = overviewData as { avg_nps?: number; total_responses?: number; active_surveys?: number; total_surveys?: number } | null;

  // ── Command Center data ────────────────────────────────────────────────────
  const { data: dashboard, loading: dashboardLoading, error: dashboardError, refetch: refetchDashboard } = useOrgDashboard();
  const { data: healthDetail, loading: healthLoading } = useOrgHealthScore();
  const {
    data: brief, loading: briefLoading, error: briefError, minDataMet, regenerate, regenerating,
    completeRegeneration, refetch: refetchBrief,
  } = useOrgCrystalBrief();
  const { data: trends, loading: trendsLoading } = useOrgTrends('30d');
  const programs = useOrgPrograms();
  const alerts = useOrgAlerts();
  const { data: topicsData, loading: topicsLoading } = useOrgTopics();
  const { data: tagMetrics, loading: tagMetricsLoading } = useTagMetrics();

  const [healthBreakdownOpen, setHealthBreakdownOpen] = useState(false);
  const [generatorOpen, setGeneratorOpen] = useState(false);
  const [generationState, setGenerationState] = useState<GenerationStatusState | null>(null);
  const [regenerateError, setRegenerateError] = useState<string | null>(null);

  // Alerts that arrived via the live SSE channel in the last few seconds —
  // drives `AnomalyAlerts`'s slide-in/pulse "this just happened" treatment.
  // 3s window matches `SeverityBar`'s own `org-dash-severity-pulse 1.5s * 2`
  // animation total runtime, so the highlight never outlives its own pulse.
  const NEW_ALERT_HIGHLIGHT_MS = 3000;
  const [newAlertIds, setNewAlertIds] = useState<Set<string>>(new Set());

  const handleLiveEvent = useCallback((evt: OrgDashboardLiveEvent) => {
    if (evt.type === 'anomaly_detected') {
      alerts.prependLive(evt.payload);
      const id = evt.payload.id;
      setNewAlertIds((prev) => new Set(prev).add(id));
      setTimeout(() => {
        setNewAlertIds((prev) => {
          if (!prev.has(id)) return prev;
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }, NEW_ALERT_HIGHLIGHT_MS);
    }
    if (evt.type === 'crystal_brief_ready') {
      completeRegeneration();
      refetchDashboard();
      refetchBrief();
      setRegenerateError(evt.payload.success ? null : t('orgDashboard.crystalBrief.regenerateFailed'));
    }
    // 'response_received' KPI counter updates are cosmetic-only here; the
    // canonical KPI values still come from `useOrgDashboard`'s payload, per
    // this page's read-mostly design — a full-fidelity live counter splice
    // is a fast-follow once the backend stream ships.
  }, [alerts.prependLive, completeRegeneration, refetchDashboard, refetchBrief, t]);

  const { connectionStatus } = useOrgDashboardLive(handleLiveEvent);

  const archive = useOrgBriefArchive(10);

  const handleAskFollowUp = () => {
    setScope('all');
    openCrystal(t('orgDashboard.crystalBrief.followUpQuery'), { focused_brief_id: brief?.id });
  };

  const handleGenerated = () => {
    setGenerationState('in-progress');
  };

  const healthTotal = dashboard?.healthScore?.total ?? healthDetail?.totalScore ?? null;
  const healthStatus = healthDetail?.status ?? null;

  // `healthDetail.history` is currently always `[]` (org-metrics.service.ts's
  // `getHealthScore` — no time-series table exists yet, a documented backend
  // gap out of this pass's scope). Rather than hardcode an empty-string
  // `trend` interpolation (the confirmed bug — "...30-day trend: ." read to
  // screen readers), compute a real direction whenever history is actually
  // populated and fall back to a trend-free sentence otherwise, so the
  // aria-label stays grammatically complete either way and starts working
  // for free once that backend gap closes.
  const healthHistory = healthDetail?.history ?? [];
  const healthTrendLabel = healthHistory.length >= 2
    ? (() => {
      const last = healthHistory[healthHistory.length - 1].totalScore;
      const prev = healthHistory[healthHistory.length - 2].totalScore;
      if (last > prev) return t('orgDashboard.healthScore.trend.up');
      if (last < prev) return t('orgDashboard.healthScore.trend.down');
      return t('orgDashboard.healthScore.trend.stable');
    })()
    : null;

  const kpis = dashboard?.kpis ?? null;

  const loading = overviewLoading;

  if (loading) return <div className="p-6 animate-pulse">{t('common.loading')}</div>;

  return (
    <div
      data-theme={warRoom ? 'war-room' : undefined}
      data-org-dash-theme-fade
      className="max-w-7xl mx-auto w-full space-y-8 pb-16"
    >
      <div className="flex items-center justify-between pt-2">
        <div>
          <h1 className="text-2xl font-semibold">{t('trends.org.title')}</h1>
          {connectionStatus !== 'connected' && (
            <p className="text-xs text-amber-500 mt-1">
              {connectionStatus === 'polling' || connectionStatus === 'disconnected'
                ? t('orgDashboard.live.pausedFallback')
                : t('orgDashboard.live.reconnecting')}
            </p>
          )}
        </div>
        <div className="w-56">
          <WarRoomToggle enabled={warRoom} onToggle={toggleWarRoom} />
        </div>
      </div>

      {/* ── Original stub grid — preserved, still functional. Labels now go
          through t() (they were hardcoded English in the original 34-line
          stub) — fixed in passing since this file is being fully rewritten
          anyway; the data source and behavior are otherwise unchanged. ── */}
      {d && (
        <div className="glass-card rounded-xl p-6 grid grid-cols-2 md:grid-cols-4 gap-4">
          {d.avg_nps != null && (
            <div><div className="text-2xl font-bold">{d.avg_nps}</div><div className="text-xs opacity-60">{t('orgDashboard.stub.portfolioNps')}</div></div>
          )}
          {d.total_responses != null && (
            <div><div className="text-2xl font-bold">{d.total_responses}</div><div className="text-xs opacity-60">{t('orgDashboard.stub.totalResponses')}</div></div>
          )}
          {d.active_surveys != null && (
            <div><div className="text-2xl font-bold">{d.active_surveys}</div><div className="text-xs opacity-60">{t('orgDashboard.stub.activeSurveys')}</div></div>
          )}
          {d.total_surveys != null && (
            <div><div className="text-2xl font-bold">{d.total_surveys}</div><div className="text-xs opacity-60">{t('orgDashboard.stub.totalSurveys')}</div></div>
          )}
        </div>
      )}

      {/* ── Org Health Score breakdown ────────────────────────────────────────── */}
      <section className="bg-white rounded-xl border border-gray-100 shadow-sm p-5" data-org-dash-surface>
        <div
          className="flex items-center justify-between"
          {...(bp === 'mobile' ? {
            role: 'button', tabIndex: 0,
            onClick: () => setHealthBreakdownOpen((v) => !v),
          } : {
            onMouseEnter: () => setHealthBreakdownOpen(true),
            onMouseLeave: () => setHealthBreakdownOpen(false),
          })}
        >
          <div className="flex items-center gap-3">
            <span className="text-xs uppercase tracking-wider text-gray-500">{t('orgDashboard.healthScore.label')}</span>
            {healthTotal != null && healthStatus && (
              <>
                <span className="text-3xl font-black tabular-nums" style={{ color: healthStatusColor(healthStatus).text }}
                  data-org-dash-health-glow
                  aria-label={healthTrendLabel
                    ? t('orgDashboard.healthScore.ariaLabel', { score: String(healthTotal), status: t(`orgDashboard.health.${healthStatus}`), trend: healthTrendLabel })
                    : t('orgDashboard.healthScore.ariaLabelNoTrend', { score: String(healthTotal), status: t(`orgDashboard.health.${healthStatus}`) })}
                >
                  {healthTotal}
                </span>
                <HealthPill status={healthStatus} />
              </>
            )}
            {healthLoading && <div className="h-8 w-12 rounded bg-surface-container animate-pulse" />}
          </div>
          <Icon name={healthBreakdownOpen ? 'expand_less' : 'expand_more'} size={18} />
        </div>

        {healthBreakdownOpen && healthDetail && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-4 pt-4 border-t border-gray-100">
            {(['nps', 'sentiment', 'responseVelocity', 'anomalyFree'] as const).map((key) => (
              <div key={key}>
                <div className="text-xs text-gray-500">{t(`orgDashboard.healthScore.breakdown.${key}`)}</div>
                <div className="text-lg font-bold tabular-nums">{Math.round(healthDetail.components[key].score)}</div>
                <div className="text-[10px] text-gray-400">{t('orgDashboard.healthScore.breakdown.weight', { pct: String(Math.round(healthDetail.components[key].weight * 100)) })}</div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── Crystal Brief (full) ─────────────────────────────────────────────── */}
      <section>
        <div className="flex items-center justify-end gap-2 mb-2">
          {regenerateError && <span className="text-xs text-[#b41340]">{regenerateError}</span>}
          <button
            type="button"
            onClick={() => { setRegenerateError(null); regenerate().catch(() => setRegenerateError(t('orgDashboard.crystalBrief.regenerateFailed'))); }}
            disabled={regenerating}
            className="text-xs font-medium text-indigo-600 hover:underline disabled:opacity-50"
          >
            {t('orgDashboard.crystalBrief.regenerate')}
          </button>
        </div>
        <CrystalBriefCard
          brief={brief}
          loading={briefLoading}
          error={briefError}
          minDataMet={minDataMet}
          onRetry={refetchDashboard}
          onAskFollowUp={handleAskFollowUp}
        />
      </section>

      {/* ── Brief Archive + Manual Summary Generator ─────────────────────────── */}
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <BriefArchive
            entries={archive.data?.briefs ?? []}
            loading={archive.loading}
            page={archive.page}
            totalPages={archive.data?.pagination.totalPages ?? 1}
            onPageChange={archive.setPage}
            onOpenGenerator={() => setGeneratorOpen(true)}
          />
        </div>
        {generationState && (
          <GenerationStatusChip state={generationState} onRetry={() => setGenerationState('in-progress')} />
        )}
      </div>
      <ManualSummaryGenerator open={generatorOpen} onOpenChange={setGeneratorOpen} onGenerated={handleGenerated} />

      {/* ── KPI row ───────────────────────────────────────────────────────────── */}
      {kpis && (
        <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
          <KpiTile
            label={t('orgDashboard.kpis.activeSurveys')} value={String(kpis.activeSurveys)}
            icon="dynamic_form" iconColor="var(--color-tertiary)" loading={dashboardLoading}
            ariaLabel={kpis.activeSurveysDelta != null
              ? t('orgDashboard.kpis.ariaLabels.activeSurveys', {
                count: String(kpis.activeSurveys),
                delta: `${kpis.activeSurveysDelta >= 0 ? '+' : ''}${kpis.activeSurveysDelta}`,
              })
              : t('orgDashboard.kpis.ariaLabels.activeSurveysNoDelta', { count: String(kpis.activeSurveys) })}
          />
          <KpiTile
            label={t('orgDashboard.kpis.totalResponses')} value={kpis.totalResponses.toLocaleString()}
            unit={t('orgDashboard.kpis.responsesToday', { count: String(kpis.responsesToday) })}
            icon="people" iconColor="#059669" loading={dashboardLoading}
            ariaLabel={t('orgDashboard.kpis.ariaLabels.totalResponses', {
              count: String(kpis.totalResponses), today: String(kpis.responsesToday),
            })}
          />
          <KpiTile
            label={t('orgDashboard.kpis.orgNps')} value={kpis.avgNps > 0 ? `+${kpis.avgNps}` : String(kpis.avgNps)}
            valueColor={kpis.avgNps > 30 ? '#059669' : kpis.avgNps >= 0 ? '#d97706' : '#b41340'}
            unit={t('orgDashboard.kpis.wowDelta', { sign: kpis.npsWowDelta >= 0 ? '+' : '', value: String(kpis.npsWowDelta) })}
            icon="sentiment_satisfied" iconColor="var(--color-primary)" loading={dashboardLoading}
            ariaLabel={t('orgDashboard.kpis.ariaLabels.orgNps', {
              score: String(kpis.avgNps), delta: String(kpis.npsWowDelta),
            })}
          />
          <KpiTile
            label={t('orgDashboard.kpis.avgSentiment')}
            value={t(`orgDashboard.kpis.sentimentTrend.${kpis.sentimentTrend}`)}
            valueColor={kpis.sentimentTrend === 'improving' ? '#059669' : kpis.sentimentTrend === 'declining' ? '#b41340' : '#6b7280'}
            unit={t('orgDashboard.kpis.sentimentOutOf100', { value: String(Math.round(((kpis.avgSentiment + 1) / 2) * 100)) })}
            icon="mood" iconColor="var(--color-secondary)" loading={dashboardLoading}
            ariaLabel={t('orgDashboard.kpis.ariaLabels.avgSentiment', {
              score: String(Math.round(((kpis.avgSentiment + 1) / 2) * 100)),
              trend: t(`orgDashboard.kpis.sentimentTrend.${kpis.sentimentTrend}`),
            })}
          />
        </section>
      )}

      {/* ── NPS Trend chart ───────────────────────────────────────────────────── */}
      <NPSTrendChart data={trends} loading={trendsLoading} />

      {/* ── Programs table + Program Alerts panel ────────────────────────────── */}
      <section className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <div className="lg:col-span-8">
          <ProgramsTable
            programs={programs.data?.programs ?? []}
            loading={programs.loading}
            sort={programs.sort}
            order={programs.order}
            onToggleSort={programs.toggleSort}
            page={programs.page}
            pageSize={programs.pageSize}
            total={programs.data?.pagination.total ?? 0}
            onPageChange={programs.setPage}
            onPageSizeChange={programs.setPageSize}
          />
        </div>
        <div className="lg:col-span-4">
          <AnomalyAlerts
            alerts={alerts.alerts}
            loading={alerts.loading}
            totalUnresolved={alerts.totalUnresolved}
            onAcknowledge={alerts.acknowledge}
            acknowledging={alerts.acknowledging}
            newAlertIds={Array.from(newAlertIds)}
          />
        </div>
      </section>

      {/* ── Emerging Topics ───────────────────────────────────────────────────── */}
      <EmergingTopics topics={topicsData?.topics ?? []} loading={topicsLoading} />

      {/* ── Full Tag Intelligence grid ────────────────────────────────────────── */}
      <TagIntelligenceGrid tags={tagMetrics?.tags ?? []} loading={tagMetricsLoading} />
    </div>
  );
}
