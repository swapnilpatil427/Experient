// SurveyTrendsPage — Best-in-class experience trend analysis.
//
// Sections:
//   § 1  Sticky strip      — sub-nav + time-range picker + Crystal
//   § 2  KPI summary row   — latest NPS, CSAT, CES, completion with delta vs previous point
//   § 3  NPS trend chart   — line + confidence interval band + anomaly markers + promoter/detractor fill
//   § 4  NPS breakdown     — stacked area: promoter%, passive%, detractor% over time
//   § 5  CSAT + CES chart  — combined line chart
//   § 6  Response velocity — area chart: responses/day + completion rate
//   § 7  Topic trends      — topic selector + week-over-week sentiment & volume heatmap
//   § 8  Crystal ask bar   — always inline, pre-loaded with trend context
//
// Data sources (all real, nothing hardcoded):
//   • getSurveyMetricHistory(surveyId, days)  → MetricSnapshot[]
//   • getTopicTrends(surveyId, { weeks })     → TopicTrend[]

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  AreaChart, Area, LineChart, Line, ComposedChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip as RechartsTip,
  ResponsiveContainer, ReferenceLine, ReferenceArea, Cell, Legend,
} from 'recharts';
import { useTranslation } from '../../lib/i18n';
import { useSetPageTitle } from '../../contexts/pageTitle';
import { useSurveys } from '../../hooks/useSurveys';
import { useApi } from '../../hooks/useApi';
import { useCrystalPanel } from '../../contexts/crystalPanel';
import { Icon } from '../../components/Icon';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { ROUTES, toPath } from '../../constants/routes';
import { GlassCard } from '../insights/shared';
import type { MetricSnapshot, TopicTrend, TopicWindow } from '../../lib/api';

// ── Motion ────────────────────────────────────────────────────────────────────
const rise = {
  hidden:  { opacity: 0, y: 14 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.45, ease: [0.22, 1, 0.36, 1] as [number,number,number,number] } },
};

// ── Helpers ───────────────────────────────────────────────────────────────────
const npsColor  = (v: number | null) => v == null ? '#94a3b8' : v >= 50 ? '#059669' : v >= 0 ? '#d97706' : '#b41340';
const sentColor = (v: number | null) => v == null ? '#94a3b8' : v > 0.2 ? '#059669' : v < -0.2 ? '#b41340' : '#d97706';

function delta(current: number | null, previous: number | null): number | null {
  if (current == null || previous == null) return null;
  return Math.round((current - previous) * 10) / 10;
}

function fmtDate(iso: string, style: 'short' | 'month' = 'short') {
  const d = new Date(iso);
  if (style === 'month') return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function fmtWeek(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Custom Recharts tooltip wrapper
function ChartTooltip({ active, payload, label, formatValue }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="glass-card-premium rounded-xl px-3 py-2 text-xs shadow-lg max-w-[220px]">
      <p className="font-bold text-on-surface mb-1">{label}</p>
      {payload.map((p: any) => (
        <div key={p.dataKey} className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: p.color }} />
          <span className="text-on-surface-variant">{p.name}:</span>
          <span className="font-bold text-on-surface">{formatValue ? formatValue(p.value, p.dataKey) : p.value}</span>
        </div>
      ))}
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────
export function SurveyTrendsPage() {
  const { surveyId } = useParams<{ surveyId: string }>();
  const { t }         = useTranslation();
  const api           = useApi();
  const { surveys }   = useSurveys();
  const { openCrystal, setScope } = useCrystalPanel();

  const survey = surveys.find((s) => s.id === surveyId);
  useSetPageTitle(survey?.title ?? t('nav.experience'), t('trends.title'));

  const [days,           setDays]           = useState(90);
  const [snapshots,      setSnapshots]      = useState<MetricSnapshot[]>([]);
  const [topicTrends,    setTopicTrends]    = useState<TopicTrend[]>([]);
  const [selectedTopic,  setSelectedTopic]  = useState<string>('');
  const [loading,        setLoading]        = useState(true);
  const [topicsLoading,  setTopicsLoading]  = useState(false);

  // Scope Crystal on mount
  useEffect(() => {
    if (surveyId) setScope(surveyId);
    return () => setScope('all');
  }, [surveyId, setScope]);

  // Load metric history
  const loadHistory = useCallback(async () => {
    if (!surveyId) return;
    setLoading(true);
    try {
      const r = await api.getSurveyMetricHistory(surveyId, days);
      const snaps = (r.history ?? []).map((s) => ({
        ...s,
        nps:                  s.nps != null ? Number(s.nps) : null,
        nps_ci_low:           s.nps_ci_low != null ? Number(s.nps_ci_low) : null,
        nps_ci_high:          s.nps_ci_high != null ? Number(s.nps_ci_high) : null,
        csat:                 s.csat != null ? Number(s.csat) : null,
        effort_score:         s.effort_score != null ? Number(s.effort_score) : null,
        completion_rate:      s.completion_rate != null ? Number(s.completion_rate) : null,
        response_velocity_7d: s.response_velocity_7d != null ? Number(s.response_velocity_7d) : null,
        promoter_pct:         s.promoter_pct != null ? Number(s.promoter_pct) : null,
        passive_pct:          s.passive_pct != null ? Number(s.passive_pct) : null,
        detractor_pct:        s.detractor_pct != null ? Number(s.detractor_pct) : null,
        response_count:       s.response_count != null ? Number(s.response_count) : null,
        nps_n:                s.nps_n != null ? Number(s.nps_n) : null,
      }));
      setSnapshots(snaps);
    } catch { setSnapshots([]); }
    finally { setLoading(false); }
  }, [api, surveyId, days]);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  // Load topic trends
  useEffect(() => {
    if (!surveyId) return;
    setTopicsLoading(true);
    const weeks = Math.ceil(days / 7);
    api.getTopicTrends(surveyId, { weeks })
      .then((r) => { setTopicTrends(r.topics ?? []); })
      .catch(() => setTopicTrends([]))
      .finally(() => setTopicsLoading(false));
  }, [api, surveyId, days]);

  // ── Derived data ─────────────────────────────────────────────────────────
  const chartData = useMemo(() => snapshots.map((s) => ({
    date:         fmtDate(s.captured_at),
    fullDate:     s.captured_at,
    nps:          s.nps,
    nps_ci_low:   s.nps_ci_low,
    nps_ci_high:  s.nps_ci_high,
    csat:         s.csat != null ? Math.round(s.csat * 100) / 100 : null,
    ces:          s.effort_score,
    completion:   s.completion_rate != null ? Math.round(s.completion_rate * 100) : null,
    velocity:     s.response_velocity_7d != null ? Math.round(s.response_velocity_7d * 10) / 10 : null,
    promoters:    s.promoter_pct != null ? Math.round(s.promoter_pct) : null,
    passives:     s.passive_pct  != null ? Math.round(s.passive_pct)  : null,
    detractors:   s.detractor_pct != null ? Math.round(s.detractor_pct) : null,
    responses:    s.response_count,
    anomaly:      s.anomaly_flag,
    n:            s.nps_n,
  })), [snapshots]);

  const latest   = snapshots[snapshots.length - 1] ?? null;
  const previous = snapshots[snapshots.length - 2] ?? null;
  const npsDelta    = delta(latest?.nps, previous?.nps);
  const csatDelta   = delta(latest?.csat, previous?.csat);
  const cesDelta    = delta(latest?.effort_score, previous?.effort_score);
  const completionDelta = latest?.completion_rate != null && previous?.completion_rate != null
    ? Math.round((latest.completion_rate - previous.completion_rate) * 100)
    : null;

  const anomalyDates = chartData.filter((d) => d.anomaly);

  // NPS CI band data (Recharts area needs [low, high-low])
  const ciData = chartData.map((d) => ({
    ...d,
    // Recharts stacked area: base = ci_low, fill = ci_high - ci_low
    ciBand: d.nps_ci_low != null && d.nps_ci_high != null
      ? [d.nps_ci_low, d.nps_ci_high] as [number, number]
      : null,
  }));

  // Topic trend for selected topic
  const selectedTopicData = useMemo(() => {
    if (!selectedTopic) return null;
    return topicTrends.find((t) => t.topic_id === selectedTopic) ?? null;
  }, [topicTrends, selectedTopic]);

  const topicChartData = useMemo(() => {
    if (!selectedTopicData) return [];
    return selectedTopicData.windows.map((w: TopicWindow) => ({
      week:      fmtWeek(w.window_start),
      sentiment: w.avg_sentiment_score != null ? Math.round(w.avg_sentiment_score * 100) : null,
      mentions:  w.response_count,
      npsImpact: w.nps_impact != null ? Math.round(w.nps_impact * 10) / 10 : null,
      velocity:  w.velocity_pct != null ? Math.round(w.velocity_pct) : null,
      urgency:   w.urgency_score != null ? Math.round(w.urgency_score) : null, // already [0,100]
    }));
  }, [selectedTopicData]);

  // ── Common chart styling ──────────────────────────────────────────────────
  const axisStyle  = { fontSize: 11, fill: '#94a3b8' };
  const gridStyle  = { stroke: 'rgba(0,0,0,0.04)', strokeDasharray: '3 3' };
  const chartMargin = { top: 8, right: 12, bottom: 0, left: 0 };

  if (!surveyId) {
    return (
      <div className="max-w-5xl mx-auto w-full pt-12 text-center">
        <p className="text-on-surface-variant mb-4">{t('experience.topics.noSurvey')}</p>
        <Link to={ROUTES.EXPERIENCE}><Button variant="outline" size="sm">← Experience</Button></Link>
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={200}>
    <div className="max-w-5xl mx-auto w-full space-y-5 pt-6 md:pt-8">

      {/* ══════════════════════════════════════════════════════════════════
          § 1  STICKY COMMAND STRIP
      ══════════════════════════════════════════════════════════════════ */}
      <motion.div initial={{ opacity:0, y:-6 }} animate={{ opacity:1, y:0 }}
        transition={{ duration:0.35 }}
        className="glass-card-premium rounded-2xl px-4 py-3 sticky top-0 z-20 flex items-center gap-3 flex-wrap"
        style={{ boxShadow:'0 4px 24px rgba(0,0,0,0.07), inset 0 1px 0 rgba(255,255,255,0.9)' }}>

        {/* Sub-nav */}
        <div className="flex items-center gap-1 flex-wrap">
          {([
            { label: t('experience.nav.intelligence'), icon: 'auto_awesome', path: toPath(ROUTES.EXPERIENCE_SURVEY, { surveyId }) },
            { label: t('experience.nav.topics'),       icon: 'hub',          path: toPath(ROUTES.EXPERIENCE_SURVEY_TOPICS, { surveyId }) },
            { label: t('experience.nav.advanced'),     icon: 'analytics',    path: `${ROUTES.ADVANCED_INSIGHTS}?survey=${surveyId}` },
            { label: t('experience.nav.trends'),       icon: 'timeline',     path: toPath(ROUTES.EXPERIENCE_SURVEY_TRENDS, { surveyId }), active: true },
            { label: t('experience.nav.report'),       icon: 'description',  path: toPath(ROUTES.EXPERIENCE_SURVEY_REPORT, { surveyId }) },
          ] as const).map((item) => (
            <Link key={item.label} to={item.path}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-[11px] font-bold transition-all"
              style={'active' in item && item.active
                ? { background:'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))', color:'white', boxShadow:'0 2px 8px color-mix(in srgb, var(--color-primary) 25%, transparent)' }
                : { background:'var(--color-surface-container)', color:'var(--color-on-surface-variant)' }
              }>
              <Icon name={item.icon} size={12} />{item.label}
            </Link>
          ))}
        </div>

        <div className="flex-1" />

        {/* Time range */}
        <div className="flex items-center gap-1 p-0.5 rounded-xl bg-surface-container">
          {([30, 60, 90, 180, 365] as const).map((d) => (
            <button key={d} onClick={() => setDays(d)}
              className="px-2.5 py-1 rounded-lg text-[11px] font-bold transition-all"
              style={days === d
                ? { background:'white', color:'var(--color-primary)', boxShadow:'0 1px 4px rgba(0,0,0,0.10)' }
                : { color:'var(--color-on-surface-variant)' }
              }>
              {d === 365 ? '1y' : `${d}d`}
            </button>
          ))}
        </div>

        {/* Crystal */}
        <Button size="sm"
          onClick={() => openCrystal(t('trends.crystalQuery'))}
          className="text-xs font-bold text-white border-0 flex-shrink-0"
          style={{ background:'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))' }}>
          <Icon name="psychology" size={13} /> {t('trends.askCrystal')}
        </Button>
      </motion.div>

      {/* ══════════════════════════════════════════════════════════════════
          Loading / empty states
      ══════════════════════════════════════════════════════════════════ */}
      {loading && (
        <div className="space-y-4">
          {[...Array(4)].map((_,i) => <div key={i} className="h-56 rounded-2xl bg-surface-container animate-pulse" />)}
        </div>
      )}

      {!loading && snapshots.length === 0 && (
        <GlassCard className="p-14 text-center">
          <div className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-5"
            style={{ background:'linear-gradient(135deg, color-mix(in srgb, var(--color-primary) 12%, transparent), color-mix(in srgb, var(--color-tertiary) 12%, transparent))' }}>
            <Icon name="timeline" size={32} style={{ color:'var(--color-primary)' }} />
          </div>
          <h3 className="text-xl font-black font-headline mb-2">{t('trends.noData')}</h3>
          <p className="text-sm text-on-surface-variant mb-6 max-w-sm mx-auto">{t('trends.noDataHint')}</p>
          <Link to={toPath(ROUTES.EXPERIENCE_SURVEY, { surveyId })}>
            <Button className="font-bold text-white border-0"
              style={{ background:'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))' }}>
              <Icon name="auto_awesome" size={15} /> {t('trends.runPipeline')}
            </Button>
          </Link>
        </GlassCard>
      )}

      {/* ══════════════════════════════════════════════════════════════════
          § 2  KPI SUMMARY ROW
          Latest value + delta from the previous snapshot
      ══════════════════════════════════════════════════════════════════ */}
      {!loading && snapshots.length > 0 && (
        <motion.div variants={rise} initial="hidden" animate="visible"
          className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {([
            {
              label:     t('trends.metrics.npsShort'),
              value:     latest?.nps != null ? (latest.nps > 0 ? `+${Math.round(latest.nps)}` : String(Math.round(latest.nps))) : '—',
              delta:     npsDelta,
              icon:      'sentiment_satisfied',
              iconColor: npsColor(latest?.nps ?? null),
              valueColor:npsColor(latest?.nps ?? null),
              ci:        latest?.nps_ci_low != null && latest?.nps_ci_high != null
                ? `CI [${Math.round(latest.nps_ci_low)}, ${Math.round(latest.nps_ci_high)}]`
                : undefined,
              n:         latest?.nps_n != null ? `n=${latest.nps_n}` : undefined,
            },
            {
              label:     t('trends.metrics.csatShort'),
              value:     latest?.csat != null ? latest.csat.toFixed(2) : '—',
              delta:     csatDelta,
              icon:      'star',
              iconColor: 'var(--color-secondary)',
              sub:       t('trends.csatScale'),
            },
            {
              label:     t('trends.metrics.cesShort'),
              value:     latest?.effort_score != null ? latest.effort_score.toFixed(1) : '—',
              delta:     cesDelta != null ? -cesDelta : null, // lower effort = better
              deltaInverted: true,
              icon:      'speed',
              iconColor: 'var(--color-tertiary)',
              sub:       t('trends.cesScale'),
            },
            {
              label:     t('trends.metrics.completionShort'),
              value:     latest?.completion_rate != null ? `${Math.round(latest.completion_rate * 100)}%` : '—',
              delta:     completionDelta,
              icon:      'check_circle',
              iconColor: '#059669',
              sub:       latest?.response_velocity_7d != null
                ? t('trends.metrics.velocityUnit', { n: latest.response_velocity_7d.toFixed(1) })
                : undefined,
            },
          ]).map((m, i) => (
            <GlassCard key={i} className="p-4">
              <div className="flex items-start justify-between mb-2">
                <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
                  style={{ background:`${m.iconColor}18` }}>
                  <Icon name={m.icon} size={15} style={{ color:m.iconColor }} />
                </div>
                {m.delta != null && (
                  <span className={`text-[10px] font-bold flex items-center gap-0.5 ${
                    (m.deltaInverted ? -m.delta : m.delta) > 0 ? 'text-emerald-600' :
                    (m.deltaInverted ? -m.delta : m.delta) < 0 ? 'text-red-500' : 'text-on-surface-variant'
                  }`}>
                    <Icon name={(m.deltaInverted ? -m.delta : m.delta) > 0 ? 'arrow_upward' : (m.deltaInverted ? -m.delta : m.delta) < 0 ? 'arrow_downward' : 'remove'} size={10} />
                    {Math.abs(m.delta)}
                  </span>
                )}
              </div>
              <div className="font-headline font-black text-2xl leading-none mb-0.5"
                style={m.valueColor ? { color:m.valueColor } : undefined}>{m.value}</div>
              <div className="text-[9px] font-black uppercase tracking-widest text-on-surface-variant">{m.label}</div>
              {(m.ci || m.sub || m.n) && (
                <div className="text-[9px] text-on-surface-variant/55 mt-0.5">{m.ci ?? m.sub ?? m.n}</div>
              )}
            </GlassCard>
          ))}
        </motion.div>
      )}

      {/* ══════════════════════════════════════════════════════════════════
          § 3  NPS TREND — line + CI band + anomaly markers
      ══════════════════════════════════════════════════════════════════ */}
      {!loading && chartData.length >= 2 && (
        <motion.div variants={rise} initial="hidden" animate="visible">
          <GlassCard className="p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-sm font-black font-headline">{t('trends.chart.npsTitle')}</h2>
                <p className="text-[11px] text-on-surface-variant mt-0.5">
                  {chartData.length} {t('trends.summary.dataPoints', { n: '' }).replace('{n} ', '')}
                  {anomalyDates.length > 0 && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="ml-2 inline-flex items-center gap-1 text-amber-600 cursor-help">
                          <Icon name="warning" size={11} />
                          {anomalyDates.length} {anomalyDates.length === 1 ? 'anomaly' : 'anomalies'} flagged
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="right" className="text-xs max-w-[220px]">
                        {t('trends.anomaly.tooltip')}
                      </TooltipContent>
                    </Tooltip>
                  )}
                </p>
              </div>
              {latest?.nps != null && (
                <span className="text-[11px] font-black px-2 py-1 rounded-lg"
                  style={{ background:`${npsColor(latest.nps)}18`, color:npsColor(latest.nps) }}>
                  Latest: {latest.nps > 0 ? '+' : ''}{Math.round(latest.nps)}
                </span>
              )}
            </div>
            <ResponsiveContainer width="100%" height={200}>
              <ComposedChart data={chartData} margin={chartMargin}>
                <defs>
                  <linearGradient id="npsGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="var(--color-primary)" stopOpacity={0.15} />
                    <stop offset="95%" stopColor="var(--color-primary)" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="ciGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%"  stopColor="var(--color-primary-container)" stopOpacity={0.15} />
                    <stop offset="100%" stopColor="var(--color-primary-container)" stopOpacity={0.03} />
                  </linearGradient>
                </defs>
                <CartesianGrid {...gridStyle} />
                <XAxis dataKey="date" tick={axisStyle} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                <YAxis tick={axisStyle} axisLine={false} tickLine={false} width={32}
                  domain={(domain) => {
                    const [min, max] = domain as [number, number];
                    return [Math.min(min - 5, -10), Math.max(max + 5, 10)];
                  }}
                />
                <ReferenceLine y={0} stroke="rgba(0,0,0,0.15)" strokeDasharray="4 4" />
                {/* CI band */}
                <Area type="monotone" dataKey="nps_ci_high" stroke="none" fill="url(#ciGrad)" fillOpacity={1} name="CI High" legendType="none" />
                <Area type="monotone" dataKey="nps_ci_low"  stroke="none" fill="white" fillOpacity={1}    name="CI Low"  legendType="none" />
                {/* NPS line */}
                <Area type="monotone" dataKey="nps" stroke="var(--color-primary)" strokeWidth={2.5}
                  fill="url(#npsGrad)" dot={false} activeDot={{ r: 4, strokeWidth: 0, fill: 'var(--color-primary)' }}
                  name={t('trends.metrics.npsShort')} />
                {/* Anomaly markers */}
                {anomalyDates.map((d, i) => (
                  <ReferenceLine key={i} x={d.date} stroke="#d97706"
                    strokeDasharray="3 3" strokeWidth={1.5}
                    label={{ value: '⚠', position: 'top', fontSize: 11 }} />
                ))}
                <RechartsTip content={<ChartTooltip formatValue={(v: number | null, key: string) =>
                  key === 'nps' ? (v != null ? (v > 0 ? `+${v}` : String(v)) : '—') : String(v ?? '—')
                } />} />
              </ComposedChart>
            </ResponsiveContainer>
            {anomalyDates.length > 0 && (
              <div className="flex items-center gap-1.5 mt-3 text-[10px] text-amber-600">
                <Icon name="warning" size={11} />
                {t('trends.anomaly.detected')}: {anomalyDates.map(d => d.date).join(', ')}
              </div>
            )}
          </GlassCard>
        </motion.div>
      )}

      {/* ══════════════════════════════════════════════════════════════════
          § 4  NPS BREAKDOWN — promoter / passive / detractor over time
      ══════════════════════════════════════════════════════════════════ */}
      {!loading && chartData.filter(d => d.promoters != null).length >= 2 && (
        <motion.div variants={rise} initial="hidden" animate="visible">
          <GlassCard className="p-5">
            <h2 className="text-sm font-black font-headline mb-1">{t('trends.chart.breakdown')}</h2>
            <p className="text-[11px] text-on-surface-variant mb-4">
              {t('trends.npsBreakdownDesc')}
            </p>
            <ResponsiveContainer width="100%" height={160}>
              <AreaChart data={chartData} margin={chartMargin}>
                <defs>
                  <linearGradient id="promoterGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%"  stopColor="#059669" stopOpacity={0.3} />
                    <stop offset="100%" stopColor="#059669" stopOpacity={0.05} />
                  </linearGradient>
                  <linearGradient id="detractorGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%"  stopColor="#b41340" stopOpacity={0.3} />
                    <stop offset="100%" stopColor="#b41340" stopOpacity={0.05} />
                  </linearGradient>
                </defs>
                <CartesianGrid {...gridStyle} />
                <XAxis dataKey="date" tick={axisStyle} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                <YAxis tick={axisStyle} axisLine={false} tickLine={false} width={32} unit="%" />
                <Area type="monotone" dataKey="promoters"  stroke="#059669" strokeWidth={2} fill="url(#promoterGrad)"  name={t('trends.chart.promoters')}  dot={false} />
                <Area type="monotone" dataKey="passives"   stroke="#94a3b8" strokeWidth={1.5} fill="rgba(148,163,184,0.08)" name={t('trends.chart.passives')}   dot={false} />
                <Area type="monotone" dataKey="detractors" stroke="#b41340" strokeWidth={2} fill="url(#detractorGrad)" name={t('trends.chart.detractors')} dot={false} />
                <Legend iconType="line" wrapperStyle={{ fontSize: 11 }} />
                <RechartsTip content={<ChartTooltip formatValue={(v: number | null) => `${v ?? '—'}%`} />} />
              </AreaChart>
            </ResponsiveContainer>
          </GlassCard>
        </motion.div>
      )}

      {/* ══════════════════════════════════════════════════════════════════
          § 5  CSAT + CES — two lines on one chart
      ══════════════════════════════════════════════════════════════════ */}
      {!loading && chartData.filter(d => d.csat != null || d.ces != null).length >= 2 && (
        <motion.div variants={rise} initial="hidden" animate="visible">
          <GlassCard className="p-5">
            <h2 className="text-sm font-black font-headline mb-1">{t('trends.chart.csatTitle')}</h2>
            <p className="text-[11px] text-on-surface-variant mb-4">
              {t('trends.csatCesDesc')}
            </p>
            <ResponsiveContainer width="100%" height={160}>
              <LineChart data={chartData} margin={chartMargin}>
                <CartesianGrid {...gridStyle} />
                <XAxis dataKey="date" tick={axisStyle} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                <YAxis tick={axisStyle} axisLine={false} tickLine={false} width={32} />
                <Line type="monotone" dataKey="csat" stroke="var(--color-secondary)" strokeWidth={2.5}
                  dot={false} activeDot={{ r: 4 }} name={t('trends.metrics.csatShort')} />
                <Line type="monotone" dataKey="ces"  stroke="var(--color-tertiary)" strokeWidth={2}
                  dot={false} activeDot={{ r: 4 }} name={t('trends.metrics.cesShort')}
                  strokeDasharray="5 3" />
                <Legend iconType="line" wrapperStyle={{ fontSize: 11 }} />
                <RechartsTip content={<ChartTooltip />} />
              </LineChart>
            </ResponsiveContainer>
          </GlassCard>
        </motion.div>
      )}

      {/* ══════════════════════════════════════════════════════════════════
          § 6  VELOCITY + COMPLETION — operational health over time
      ══════════════════════════════════════════════════════════════════ */}
      {!loading && chartData.filter(d => d.velocity != null || d.completion != null).length >= 2 && (
        <motion.div variants={rise} initial="hidden" animate="visible">
          <GlassCard className="p-5">
            <h2 className="text-sm font-black font-headline mb-1">{t('trends.chart.completionTitle')}</h2>
            <p className="text-[11px] text-on-surface-variant mb-4">
              {t('trends.operationalDesc')}
            </p>
            <ResponsiveContainer width="100%" height={160}>
              <ComposedChart data={chartData} margin={chartMargin}>
                <defs>
                  <linearGradient id="velGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="#059669" stopOpacity={0.2} />
                    <stop offset="95%" stopColor="#059669" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid {...gridStyle} />
                <XAxis dataKey="date" tick={axisStyle} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                <YAxis yAxisId="left"  tick={axisStyle} axisLine={false} tickLine={false} width={32} />
                <YAxis yAxisId="right" orientation="right" tick={axisStyle} axisLine={false} tickLine={false} width={36} unit="%" />
                <Area yAxisId="left" type="monotone" dataKey="velocity" stroke="#059669" strokeWidth={2}
                  fill="url(#velGrad)" dot={false} name={t('trends.metrics.velocityShort')} />
                <Line yAxisId="right" type="monotone" dataKey="completion" stroke="var(--color-primary)" strokeWidth={2}
                  dot={false} strokeDasharray="4 3" name={t('trends.metrics.completionShort')} />
                <Legend iconType="line" wrapperStyle={{ fontSize: 11 }} />
                <RechartsTip content={<ChartTooltip formatValue={(v: number | null, key: string) =>
                  key === 'completion' ? `${v ?? '—'}%` : String(v ?? '—')
                } />} />
              </ComposedChart>
            </ResponsiveContainer>
          </GlassCard>
        </motion.div>
      )}

      {/* ══════════════════════════════════════════════════════════════════
          § 7  TOPIC TRENDS — weekly sentiment + volume by topic
      ══════════════════════════════════════════════════════════════════ */}
      <motion.div variants={rise} initial="hidden" animate="visible">
        <GlassCard className="p-5">
          <div className="flex items-start justify-between mb-4 flex-wrap gap-3">
            <div>
              <h2 className="text-sm font-black font-headline">{t('trends.topics.title')}</h2>
              <p className="text-[11px] text-on-surface-variant mt-0.5">{t('trends.topics.subtitle')}</p>
            </div>
            {/* Topic picker */}
            {topicTrends.length > 0 && (
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[10px] font-black uppercase tracking-widest text-on-surface-variant">{t('trends.topics.pickTopic')}:</span>
                <div className="flex flex-wrap gap-1.5">
                  {topicTrends.slice(0, 8).map((tp) => (
                    <button key={tp.topic_id}
                      onClick={() => setSelectedTopic(tp.topic_id === selectedTopic ? '' : tp.topic_id)}
                      className="px-2.5 py-1 rounded-full text-[11px] font-bold transition-all"
                      style={selectedTopic === tp.topic_id
                        ? { background:'var(--color-primary)', color:'white' }
                        : { background:'var(--color-surface-container)', color:'var(--color-on-surface-variant)' }
                      }>
                      {tp.topic_name}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {topicsLoading && <div className="h-40 rounded-xl bg-surface-container animate-pulse" />}

          {!topicsLoading && topicTrends.length === 0 && (
            <div className="py-10 text-center">
              <Icon name="show_chart" size={28} style={{ color:'var(--color-outline-variant)', margin:'0 auto 8px' }} />
              <p className="text-sm text-on-surface-variant">{t('trends.topics.noTopics')}</p>
            </div>
          )}

          {/* All topics heatmap — volume + sentiment by week */}
          {!topicsLoading && topicTrends.length > 0 && !selectedTopic && (
            <div className="overflow-x-auto">
              <table className="w-full text-[11px] border-collapse">
                <thead>
                  <tr>
                    <th className="text-left pb-2 pr-4 font-black text-on-surface-variant uppercase tracking-widest text-[9px] w-36">
                      {t('trends.heatmapTopicCol')}
                    </th>
                    {topicTrends[0]?.windows.slice(-8).map((w: TopicWindow, i: number) => (
                      <th key={i} className="text-center pb-2 px-1 font-bold text-on-surface-variant/60 min-w-[48px]">
                        {fmtWeek(w.window_start)}
                      </th>
                    ))}
                    <th className="text-right pb-2 pl-4 font-black text-on-surface-variant uppercase tracking-widest text-[9px]">
                      {t('trends.heatmapTrendCol')}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-outline-variant/10">
                  {topicTrends.slice(0, 10).map((tp) => {
                    const windows  = tp.windows.slice(-8);
                    const lastW    = windows[windows.length - 1];
                    const firstW   = windows[0];
                    const volTrend = lastW && firstW ? (lastW.response_count - firstW.response_count) : 0;
                    return (
                      <tr key={tp.topic_id} className="hover:bg-surface-container/30 cursor-pointer transition-colors"
                        onClick={() => setSelectedTopic(tp.topic_id)}>
                        <td className="py-2 pr-4 font-bold text-on-surface truncate max-w-[144px]">{tp.topic_name}</td>
                        {windows.map((w: TopicWindow, i: number) => {
                          const s = w.avg_sentiment_score;
                          const intensity = s == null ? 0 : Math.min(Math.abs(s) * 1.5, 1);
                          const bg = s == null ? 'rgba(148,163,184,0.08)'
                            : s > 0 ? `rgba(5,150,105,${0.1 + intensity * 0.4})`
                            : `rgba(180,19,64,${0.1 + intensity * 0.4})`;
                          return (
                            <td key={i} className="text-center px-1 py-1">
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <div className="mx-auto rounded-md flex items-center justify-center text-[9px] font-bold"
                                    style={{ background:bg, width:40, height:24,
                                      color: s == null ? '#94a3b8' : s > 0 ? '#059669' : '#b41340' }}>
                                    {w.response_count > 0 ? w.response_count : '·'}
                                  </div>
                                </TooltipTrigger>
                                <TooltipContent side="top" className="text-xs">
                                  {fmtWeek(w.window_start)} · {w.response_count} mentions
                                  {s != null && ` · sentiment ${(s * 100).toFixed(0)}%`}
                                  {w.nps_impact != null && ` · NPS ${w.nps_impact > 0 ? '+' : ''}${w.nps_impact.toFixed(1)} pts`}
                                </TooltipContent>
                              </Tooltip>
                            </td>
                          );
                        })}
                        <td className="text-right pl-4 py-2">
                          <span className={`text-[10px] font-bold flex items-center gap-0.5 justify-end ${volTrend > 0 ? 'text-amber-600' : volTrend < 0 ? 'text-emerald-600' : 'text-on-surface-variant'}`}>
                            <Icon name={volTrend > 0 ? 'trending_up' : volTrend < 0 ? 'trending_down' : 'trending_flat'} size={12} />
                            {volTrend !== 0 ? `${volTrend > 0 ? '+' : ''}${volTrend}` : '—'}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="text-[10px] text-on-surface-variant/50 mt-3">
                {t('trends.heatmapLegend')}
              </p>
            </div>
          )}

          {/* Selected topic deep-dive charts */}
          {!topicsLoading && selectedTopic && selectedTopicData && topicChartData.length >= 2 && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-sm font-bold text-on-surface">{selectedTopicData.topic_name}</span>
                <button onClick={() => setSelectedTopic('')}
                  className="text-[10px] text-on-surface-variant hover:text-on-surface transition-colors flex items-center gap-0.5">
                  <Icon name="close" size={12} /> {t('trends.clearSelection')}
                </button>
                <button
                  onClick={() => openCrystal(
                    `Tell me about the "${selectedTopicData.topic_name}" topic trend. Is it improving or getting worse? What should we do?`,
                    { focused_topic: selectedTopicData.topic_name },
                  )}
                  className="ml-auto text-[11px] font-bold text-primary hover:bg-primary/8 flex items-center gap-1 px-2 py-1 rounded-lg transition-colors">
                  <Icon name="psychology" size={12} /> {t('experience.common.ask')}
                </button>
              </div>

              {/* Sentiment trend */}
              <div>
                <p className="text-[10px] font-black uppercase tracking-widest text-on-surface-variant mb-2">
                  {t('trends.sentimentOverTime')}
                </p>
                <ResponsiveContainer width="100%" height={120}>
                  <AreaChart data={topicChartData} margin={chartMargin}>
                    <defs>
                      <linearGradient id="sentGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%"  stopColor="#059669" stopOpacity={0.2} />
                        <stop offset="100%" stopColor="#059669" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid {...gridStyle} />
                    <XAxis dataKey="week" tick={axisStyle} axisLine={false} tickLine={false} />
                    <YAxis tick={axisStyle} axisLine={false} tickLine={false} width={32} unit="%" />
                    <ReferenceLine y={0} stroke="rgba(0,0,0,0.15)" strokeDasharray="3 3" />
                    <Area type="monotone" dataKey="sentiment" stroke="#059669" strokeWidth={2}
                      fill="url(#sentGrad)" dot={false} name={t('trends.topics.sentiment')} />
                    <RechartsTip content={<ChartTooltip formatValue={(v: number | null) => `${v ?? '—'}%`} />} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>

              {/* Volume + NPS impact */}
              <div>
                <p className="text-[10px] font-black uppercase tracking-widest text-on-surface-variant mb-2">
                  {t('trends.volumeAndImpact')}
                </p>
                <ResponsiveContainer width="100%" height={120}>
                  <ComposedChart data={topicChartData} margin={chartMargin}>
                    <CartesianGrid {...gridStyle} />
                    <XAxis dataKey="week" tick={axisStyle} axisLine={false} tickLine={false} />
                    <YAxis yAxisId="left"  tick={axisStyle} axisLine={false} tickLine={false} width={28} />
                    <YAxis yAxisId="right" orientation="right" tick={axisStyle} axisLine={false} tickLine={false} width={32} />
                    <Bar    yAxisId="left" dataKey="mentions"  fill="color-mix(in srgb, var(--color-primary) 15%, transparent)" name={t('trends.topics.volume')} radius={[3,3,0,0]} />
                    <Line  yAxisId="right" type="monotone" dataKey="npsImpact" stroke="#d97706"
                      strokeWidth={2} dot={false} name={t('trends.npsImpactLabel')} />
                    <ReferenceLine yAxisId="right" y={0} stroke="rgba(0,0,0,0.15)" strokeDasharray="3 3" />
                    <RechartsTip content={<ChartTooltip formatValue={(v: number | null, key: string) =>
                      key === 'npsImpact' ? (v != null ? `${v > 0 ? '+' : ''}${v} pts` : '—') : String(v ?? '—')
                    } />} />
                    <Legend iconType="line" wrapperStyle={{ fontSize: 11 }} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
        </GlassCard>
      </motion.div>

      {/* ══════════════════════════════════════════════════════════════════
          § 8  CRYSTAL ASK BAR
      ══════════════════════════════════════════════════════════════════ */}
      {!loading && snapshots.length > 0 && (
        <motion.div variants={rise} initial="hidden" animate="visible">
          <GlassCard className="p-4 holographic">
            <div className="flex items-center gap-3 relative z-10">
              <div className="w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0"
                style={{ background:'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))' }}>
                <Icon name="psychology" size={18} style={{ color:'white' }} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[10px] font-black uppercase tracking-widest text-tertiary mb-0.5">
                  {t('experience.intelligence.askBar.label')}
                </div>
                <p className="text-xs text-on-surface-variant/70">
                  {latest?.nps != null
                    ? t('trends.latestNps', { n: `${latest.nps > 0 ? '+' : ''}${Math.round(latest.nps)}` })
                    : t('trends.askCrystal')}
                </p>
              </div>
              <Button size="sm"
                onClick={() => openCrystal(t('trends.crystalQuery'))}
                className="text-xs font-bold text-white border-0 flex-shrink-0"
                style={{ background:'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))' }}>
                {t('trends.askCrystal')}
              </Button>
            </div>
          </GlassCard>
        </motion.div>
      )}

    </div>
    </TooltipProvider>
  );
}
