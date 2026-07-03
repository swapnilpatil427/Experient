// TopicAnalysisHubPage — Unified best-in-class topic intelligence page.
//
// Design synthesis:
//   § 1  Sticky command strip  — sub-nav + filters (window, sort) + Crystal
//   § 2  Summary metrics       — total topics, total mentions, avg sentiment, top urgency
//   § 3  Anomaly alerts        — rising negative topics (same as SurveyIntelligencePage)
//   § 4  Driver chart          — horizontal bar chart: NPS impact per topic
//   § 5  Topic hierarchy list  — parent+children, full signal fingerprint per row
//   § 6  Crystal ask bar       — always-visible inline ask
//
// Data sources:
//   • listTopics()       → full SurveyTopic[] with all 40+ fields
//   • getTopicDrivers()  → NPS delta per topic, ranked by impact
//
// Every piece of data in SurveyTopic is surfaced somewhere on this page.

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from '../../lib/i18n';
import { useTopicAnalysis } from '../../hooks/useExperience';
import { useSurveys } from '../../hooks/useSurveys';
import { useCrystalPanel } from '../../contexts/crystalPanel';
import { useSetPageTitle } from '../../contexts/pageTitle';
import { useApi } from '../../hooks/useApi';
import { Icon } from '../../components/Icon';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { ROUTES, toPath } from '../../constants/routes';
import { GlassCard } from '../insights/shared';
import type { SurveyTopic, TopicDriver } from '../../types';

// ── Motion ────────────────────────────────────────────────────────────────────
const stagger = { hidden: {}, visible: { transition: { staggerChildren: 0.05 } } };
const rise = {
  hidden:  { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.4, ease: [0.22, 1, 0.36, 1] as [number,number,number,number] } },
};

// ── Sentiment helpers ─────────────────────────────────────────────────────────
function sentColor(s: number | null | undefined) {
  if (s == null) return '#94a3b8';
  if (s > 0.3)   return '#059669';
  if (s < -0.3)  return '#b41340';
  return '#d97706';
}
function sentLabel(s: number | null | undefined, t: (k: string) => string) {
  if (s == null) return '—';
  if (s > 0.3)   return t('experience.common.sentiment.positive');
  if (s < -0.3)  return t('experience.common.sentiment.critical');
  return t('experience.common.sentiment.mixed');
}
function sentBg(s: number | null | undefined) {
  if (s == null) return '#f1f5f9';
  if (s > 0.3)   return '#dcfce7';
  if (s < -0.3)  return '#fee2e2';
  return '#fef3c7';
}

// ── Urgency helpers ───────────────────────────────────────────────────────────
// urgency_score is [0, 100] — % of mentions with high-intensity emotion.
// Thresholds: 30 = medium, 50 = high, 80 = critical.
function urgencyLabel(score: number | null, t: (k: string) => string) {
  if (score == null || score < 30) return null;
  if (score >= 80) return { label: t('experience.topics.urgency.critical'), bg: '#fef2f2', color: '#b91c1c' };
  if (score >= 50) return { label: t('experience.topics.urgency.high'),     bg: '#fff7ed', color: '#c2410c' };
  return            { label: t('experience.topics.urgency.medium'), bg: '#fefce8', color: '#854d0e' };
}

// ── Page ─────────────────────────────────────────────────────────────────────
export function TopicAnalysisHubPage() {
  const { surveyId } = useParams<{ surveyId: string }>();
  const { t }         = useTranslation();
  const api           = useApi();
  const { surveys }   = useSurveys();
  const { openCrystal, setScope } = useCrystalPanel();

  const survey = surveys.find((s) => s.id === surveyId);
  useSetPageTitle(survey?.title ?? t('nav.experience'), t('insights.topics.title'));

  // Time window + sort state
  const [window_, setWindow_] = useState<'all_time' | '30d' | '7d'>('all_time');
  const [sort,    setSort]    = useState<'volume' | 'urgency'>('volume');

  // Topics from listTopics (has hierarchy fields)
  const { data, loading } = useTopicAnalysis(surveyId!);
  const rawTopics: SurveyTopic[] = data?.topics ?? [];

  // Drivers (NPS impact)
  const [drivers,       setDrivers]       = useState<TopicDriver[]>([]);
  const [overallNps,    setOverallNps]     = useState<number | null>(null);
  const [driversLoaded, setDriversLoaded] = useState(false);

  // Dismissed anomaly topics
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());

  // Expanded topic IDs for showing children inline
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useSetPageTitle(survey?.title ?? t('nav.experience'), t('insights.topics.title'));

  // Scope Crystal on mount
  useEffect(() => {
    if (surveyId) setScope(surveyId);
    return () => setScope('all');
  }, [surveyId, setScope]);

  // Load drivers
  useEffect(() => {
    if (!surveyId) return;
    api.getTopicDrivers(surveyId, window_)
      .then((r) => { setDrivers(r.drivers ?? []); setOverallNps(r.overall_nps ?? null); setDriversLoaded(true); })
      .catch(() => setDriversLoaded(true));
  }, [api, surveyId, window_]);

  // Build topic hierarchy from flat list
  const { rootTopics, childMap } = useMemo(() => {
    const sorted = [...rawTopics].sort(
      sort === 'urgency'
        ? (a, b) => (b.urgency_score ?? 0) - (a.urgency_score ?? 0)
        : (a, b) => (b.volume ?? 0)        - (a.volume ?? 0),
    );
    const roots    = sorted.filter((t) => !t.parent_topic_id);
    const rootIds  = new Set(roots.map((t) => t.id));
    const childMap: Record<string, SurveyTopic[]> = {};
    sorted.forEach((t) => {
      if (t.parent_topic_id) {
        const key = rootIds.has(t.parent_topic_id) ? t.parent_topic_id : '__orphaned__';
        (childMap[key] ??= []).push(t);
      }
    });
    // Orphaned → synthetic roots
    const orphans = (childMap['__orphaned__'] ?? []).map((t) => ({ ...t, parent_topic_id: null as string | null | undefined }));
    return { rootTopics: [...roots, ...orphans], childMap };
  }, [rawTopics, sort]);

  // NPS impact lookup from drivers (by topic name, since driver IDs may differ)
  const driverByName = useMemo(() => {
    const m: Record<string, TopicDriver> = {};
    drivers.forEach((d) => { m[d.name.toLowerCase()] = d; });
    return m;
  }, [drivers]);

  const getDriver = (name: string) => driverByName[name.toLowerCase()] ?? null;

  // Summary stats
  const totalMentions = useMemo(() => rawTopics.reduce((s, t) => s + (t.volume ?? 0), 0), [rawTopics]);
  const avgSentiment  = useMemo(() => {
    const valid = rawTopics.filter((t) => t.sentiment_score != null);
    return valid.length ? valid.reduce((s, t) => s + t.sentiment_score!, 0) / valid.length : null;
  }, [rawTopics]);
  const topUrgency    = useMemo(
    () => [...rawTopics].sort((a, b) => (b.urgency_score ?? 0) - (a.urgency_score ?? 0))[0] ?? null,
    [rawTopics],
  );
  const anomalies     = useMemo(
    () => rawTopics.filter((t) => t.trending === 'up' && (t.sentiment_score ?? 0) < -0.3 && !dismissedIds.has(t.id)),
    [rawTopics, dismissedIds],
  );

  // Top 8 drivers for the chart (sorted by absolute impact)
  const chartDrivers = useMemo(
    () => [...drivers]
      .filter((d) => d.nps_delta != null)
      .sort((a, b) => Math.abs(b.nps_delta!) - Math.abs(a.nps_delta!))
      .slice(0, 8),
    [drivers],
  );
  const maxDelta = useMemo(
    () => Math.max(...chartDrivers.map((d) => Math.abs(d.nps_delta ?? 0)), 1),
    [chartDrivers],
  );

  if (!surveyId) {
    return (
      <div className="max-w-5xl mx-auto w-full pt-12 text-center">
        <p className="text-on-surface-variant mb-4">{t('experience.topics.noSurvey')}</p>
        <Link to={ROUTES.EXPERIENCE}><Button variant="outline" size="sm">{t('experience.topics.back')}</Button></Link>
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
            { label: t('experience.nav.topics'),       icon: 'hub',          path: toPath(ROUTES.EXPERIENCE_SURVEY_TOPICS, { surveyId }), active: true },
            { label: t('experience.nav.advanced'),     icon: 'analytics',    path: `${ROUTES.ADVANCED_INSIGHTS}?survey=${surveyId}` },
            { label: t('experience.nav.trends'),       icon: 'timeline',     path: toPath(ROUTES.EXPERIENCE_SURVEY_TRENDS, { surveyId }) },
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

        {/* Time window */}
        <div className="flex items-center gap-1 p-0.5 rounded-xl bg-surface-container">
          {(['all_time','30d','7d'] as const).map((w) => (
            <button key={w} onClick={() => setWindow_(w)}
              className="px-2.5 py-1 rounded-lg text-[11px] font-bold transition-all"
              style={window_ === w
                ? { background:'white', color:'var(--color-primary)', boxShadow:'0 1px 4px rgba(0,0,0,0.10)' }
                : { color:'var(--color-on-surface-variant)' }
              }>
              {w === 'all_time' ? 'All time' : w}
            </button>
          ))}
        </div>

        {/* Sort */}
        <div className="flex items-center gap-1 p-0.5 rounded-xl bg-surface-container">
          {([['volume','bar_chart'],['urgency','priority_high']] as const).map(([s, icon]) => (
            <button key={s} onClick={() => setSort(s)}
              className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-bold transition-all capitalize"
              style={sort === s
                ? { background:'white', color:'var(--color-primary)', boxShadow:'0 1px 4px rgba(0,0,0,0.10)' }
                : { color:'var(--color-on-surface-variant)' }
              }>
              <Icon name={icon} size={11} />{s}
            </button>
          ))}
        </div>

        {/* Crystal */}
        <Button size="sm"
          onClick={() => openCrystal(t('experience.topics.query.all'))}
          className="text-xs font-bold text-white border-0 flex-shrink-0"
          style={{ background:'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))' }}>
          <Icon name="psychology" size={13} /> {t('experience.topics.askAll')}
        </Button>
      </motion.div>

      {/* ══════════════════════════════════════════════════════════════════
          § 2  SUMMARY METRIC STRIP
      ══════════════════════════════════════════════════════════════════ */}
      {!loading && rawTopics.length > 0 && (
        <motion.div variants={stagger} initial="hidden" animate="visible"
          className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            {
              label:    t('experience.topics.summary.topicsDiscovered'),
              value:    String(rootTopics.length),
              icon:     'hub',
              iconColor:'var(--color-primary)',
              sub:      t('experience.topics.summary.topicsSubtitle', { n: String(rawTopics.length) }),
            },
            {
              label:    t('experience.topics.summary.totalMentions'),
              value:    totalMentions.toLocaleString(),
              icon:     'chat_bubble_outline',
              iconColor:'var(--color-tertiary)',
              sub:      t('experience.topics.summary.mentionsSubtitle', { n: survey?.response_count?.toLocaleString() ?? '—' }),
            },
            {
              label:    t('experience.topics.summary.avgSentiment'),
              value:    avgSentiment != null ? `${(avgSentiment * 100).toFixed(0)}%` : '—',
              icon:     'sentiment_satisfied',
              iconColor:    avgSentiment == null ? '#94a3b8' : avgSentiment > 0.1 ? '#059669' : avgSentiment < -0.1 ? '#b41340' : '#d97706',
              valueColor:   avgSentiment == null ? undefined : avgSentiment > 0.1 ? '#059669' : avgSentiment < -0.1 ? '#b41340' : '#d97706',
              sub:      avgSentiment != null
                ? avgSentiment > 0.1 ? t('experience.topics.summary.overallPositive')
                : avgSentiment < -0.1 ? t('experience.topics.summary.overallNegative')
                : t('experience.topics.summary.mixedSignals')
                : t('experience.topics.summary.generateToSee'),
            },
            {
              label:    t('experience.topics.summary.topUrgentTopic'),
              value:    topUrgency?.name ?? '—',
              icon:     'priority_high',
              iconColor:'#d97706',
              sub:      topUrgency
                ? t('experience.topics.summary.urgencyDetail', { score: topUrgency.urgency_score?.toFixed(0) ?? '—', volume: String(topUrgency.volume) })
                : t('experience.topics.summary.noUrgentTopics'),
              truncate: true,
            },
          ].map((m, i) => (
            <motion.div key={i} variants={rise}>
              <GlassCard className="p-4">
                <div className="flex items-start justify-between mb-2">
                  <div className="w-7 h-7 rounded-lg flex items-center justify-center"
                    style={{ background:`${m.iconColor}18` }}>
                    <Icon name={m.icon} size={15} style={{ color:m.iconColor }} />
                  </div>
                </div>
                <div className="font-headline font-black text-xl leading-none mb-0.5"
                  style={m.valueColor ? { color:m.valueColor } : undefined}>
                  <span className={m.truncate ? 'truncate block text-sm' : ''}>{m.value}</span>
                </div>
                <div className="text-[9px] font-black uppercase tracking-widest text-on-surface-variant mb-0.5">{m.label}</div>
                <div className="text-[10px] text-on-surface-variant/60 leading-snug">{m.sub}</div>
              </GlassCard>
            </motion.div>
          ))}
        </motion.div>
      )}

      {/* ══════════════════════════════════════════════════════════════════
          § 3  ANOMALY ALERTS — rising negative topics
      ══════════════════════════════════════════════════════════════════ */}
      <AnimatePresence>
        {anomalies.length > 0 && (
          <motion.div initial={{ opacity:0, y:8 }} animate={{ opacity:1, y:0 }} exit={{ opacity:0 }}
            transition={{ duration:0.35 }} className="space-y-2">
            {anomalies.map((tp, i) => (
              <motion.div key={tp.id}
                initial={{ opacity:0, x:-8 }} animate={{ opacity:1, x:0 }}
                transition={{ duration:0.3, delay:i*0.06 }}
                className="flex items-center gap-3 rounded-xl px-4 py-3 border flex-wrap"
                style={{ background:'#fff1f2', borderColor:'#fecdd3' }}>
                <Icon name="warning" fill={1} size={16} style={{ color:'#b41340', flexShrink:0 }} />
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-sm" style={{ color:'#9f1239' }}>
                    {t('insights.anomalyRising')} <span className="font-black">{tp.name}</span>
                  </p>
                  <p className="text-[11px] mt-0.5" style={{ color:'#be123c' }}>
                    {tp.volume} {t('insights.anomalyMentions')}
                    {tp.sentiment_score != null ? ` · ${(tp.sentiment_score*100).toFixed(0)}% sentiment` : ''}
                    {tp.effort_score != null ? ` · ${t('insights.anomalyEffort')} ${tp.effort_score.toFixed(1)}` : ''}
                  </p>
                </div>
                <button
                  onClick={() => openCrystal(
                    `Why is "${tp.name}" rising negatively? What should we do?`,
                    { focused_topic: tp.name },
                  )}
                  className="text-[11px] font-bold px-3 py-1.5 rounded-full flex items-center gap-1 hover:opacity-90 transition-opacity"
                  style={{ background:'#b41340', color:'#fff', flexShrink:0 }}>
                  <Icon name="psychology" size={12} /> {t('insights.anomalyAskCrystal')}
                </button>
                <button onClick={() => setDismissedIds((prev) => new Set([...prev, tp.id]))}
                  className="p-1 rounded-full opacity-60 hover:opacity-100 transition-opacity flex-shrink-0"
                  style={{ color:'#b41340' }}>
                  <Icon name="close" size={14} />
                </button>
              </motion.div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      {/* ══════════════════════════════════════════════════════════════════
          § 4  NPS DRIVER CHART
          Horizontal bar chart: each topic's NPS delta vs overall average.
          Green = lifts NPS, Red = drags NPS, sized by absolute impact.
      ══════════════════════════════════════════════════════════════════ */}
      {driversLoaded && chartDrivers.length >= 2 && (
        <motion.section initial={{ opacity:0, y:14 }} animate={{ opacity:1, y:0 }}
          transition={{ duration:0.45, delay:0.1 }}>
          <GlassCard className="p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-sm font-black font-headline">{t('experience.topics.chart.title')}</h2>
                <p className="text-[11px] text-on-surface-variant mt-0.5">
                  {overallNps != null
                    ? t('experience.topics.chart.subtitle', { nps: `${overallNps > 0 ? '+' : ''}${overallNps.toFixed(0)}` })
                    : t('experience.topics.chart.subtitleNoNps')}
                </p>
              </div>
              {overallNps != null && (
                <span className="text-xs font-black px-2 py-1 rounded-lg"
                  style={{ background: overallNps >= 50 ? '#dcfce7' : overallNps >= 0 ? '#fef3c7' : '#fee2e2',
                           color:      overallNps >= 50 ? '#059669' : overallNps >= 0 ? '#d97706' : '#b41340' }}>
                  NPS {overallNps > 0 ? '+' : ''}{overallNps.toFixed(0)}
                </span>
              )}
            </div>

            <div className="space-y-2">
              {chartDrivers.map((d) => {
                const isPositive = (d.nps_delta ?? 0) >= 0;
                const pct        = Math.min(100, Math.round((Math.abs(d.nps_delta ?? 0) / maxDelta) * 100));
                const barColor   = isPositive ? '#059669' : '#b41340';
                const barBg      = isPositive ? '#dcfce7' : '#fee2e2';
                return (
                  <Tooltip key={d.id}>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => openCrystal(
                          `Tell me about the "${d.name}" topic's ${isPositive ? t('experience.topics.chart.positive') : t('experience.topics.chart.negative')} NPS impact. What should we do?`,
                          { focused_topic: d.name },
                        )}
                        className="w-full group text-left"
                      >
                        <div className="flex items-center gap-3">
                          <div className="w-32 text-[11px] font-bold text-on-surface truncate flex-shrink-0">{d.name}</div>
                          <div className="flex-1 flex items-center gap-1.5">
                            {/* Centre line */}
                            <div className="flex-1 relative h-5 rounded flex items-center"
                              style={{ background:'var(--color-surface-container)' }}>
                              <div
                                className="absolute h-3 rounded transition-all duration-500"
                                style={{
                                  width: `${pct / 2}%`,
                                  background: barColor,
                                  opacity: 0.75,
                                  left: isPositive ? '50%' : undefined,
                                  right: isPositive ? undefined : '50%',
                                }}
                              />
                              {/* Centre tick */}
                              <div className="absolute left-1/2 w-px h-5" style={{ background:'var(--color-outline-variant)', opacity:0.4 }} />
                            </div>
                            <span className="text-[11px] font-black w-14 text-right flex-shrink-0"
                              style={{ color: barColor }}>
                              {(d.nps_delta ?? 0) > 0 ? '+' : ''}{(d.nps_delta ?? 0).toFixed(1)}
                            </span>
                          </div>
                          <div className="w-4 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                            <Icon name="psychology" size={13} style={{ color:'var(--color-primary)' }} />
                          </div>
                        </div>
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="text-xs max-w-[220px]">
                      {d.name}: {d.volume} {t('insights.anomalyMentions')}
                      {d.nps_delta != null ? ` · ${t('experience.topics.signals.npsLabel')} ${d.nps_delta > 0 ? '+' : ''}${d.nps_delta.toFixed(1)} ${t('experience.topics.npsPts')} ${t('experience.topics.vsOverall')}` : ''}
                      {d.effort_score != null ? ` · ${t('insights.anomalyEffort')} ${d.effort_score.toFixed(1)}/7` : ''}
                      <br/>{t('experience.topics.topic.ask')}
                    </TooltipContent>
                  </Tooltip>
                );
              })}
            </div>

            <p className="text-[10px] text-on-surface-variant/50 mt-3 text-center">
              {t('experience.topics.chart.footer')}
            </p>
          </GlassCard>
        </motion.section>
      )}

      {/* ══════════════════════════════════════════════════════════════════
          § 5  TOPIC HIERARCHY — full signal fingerprint per topic
      ══════════════════════════════════════════════════════════════════ */}
      {/* Loading */}
      {loading && (
        <div className="space-y-3">
          {[...Array(4)].map((_,i) => (
            <div key={i} className="h-20 rounded-2xl bg-surface-container animate-pulse" />
          ))}
        </div>
      )}

      {/* Empty state */}
      {!loading && rootTopics.length === 0 && (
        <GlassCard className="p-12 text-center">
          <div className="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-4"
            style={{ background:'linear-gradient(135deg, color-mix(in srgb, var(--color-primary) 12%, transparent), color-mix(in srgb, var(--color-tertiary) 12%, transparent))' }}>
            <Icon name="hub" size={28} style={{ color:'var(--color-primary)' }} />
          </div>
          <h3 className="text-lg font-black font-headline mb-2">{t('insights.topics.empty')}</h3>
          <p className="text-sm text-on-surface-variant mb-5 max-w-xs mx-auto">{t('experience.topics.empty.body')}</p>
          <Link to={toPath(ROUTES.EXPERIENCE_SURVEY, { surveyId })}>
            <Button className="font-bold text-white border-0"
              style={{ background:'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))' }}>
              <Icon name="auto_awesome" size={15} /> {t('experience.topics.empty.button')}
            </Button>
          </Link>
        </GlassCard>
      )}

      {/* Topic list */}
      {!loading && rootTopics.length > 0 && (
        <motion.div variants={stagger} initial="hidden" animate="visible" className="space-y-2.5">
          {rootTopics.map((topic) => {
            const driver   = getDriver(topic.name);
            const children = childMap[topic.id] ?? [];
            const isExpand = expanded.has(topic.id);
            const sc       = topic.sentiment_score;
            const urgency  = urgencyLabel(topic.urgency_score, t);
            const npsImpact= driver?.nps_delta ?? topic.nps_impact ?? null;

            return (
              <motion.div key={topic.id} variants={rise}>
                <GlassCard className="overflow-hidden">
                  {/* ── Main topic row ──────────────────────────────────── */}
                  <div className="flex items-start gap-3 px-4 py-4">
                    {/* Sentiment dot */}
                    <div className="w-3 h-3 rounded-full flex-shrink-0 mt-1"
                      style={{ background: sentColor(sc) }} />

                    {/* Core info */}
                    <div className="flex-1 min-w-0">
                      {/* Row 1: name + tags */}
                      <div className="flex items-center gap-2 flex-wrap mb-1.5">
                        <Link
                          to={toPath(ROUTES.EXPERIENCE_SURVEY_TOPIC, { surveyId, topicId: topic.id })}
                          className="font-headline font-bold text-sm text-on-surface hover:text-primary transition-colors">
                          {topic.name}
                        </Link>
                        {/* Sentiment badge */}
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold"
                          style={{ background: sentBg(sc), color: sentColor(sc) }}>
                          {sentLabel(sc, t)}
                        </span>
                        {/* Trending */}
                        {topic.trending && topic.trending !== 'stable' && (
                          <span className="flex items-center gap-0.5 text-[10px] font-bold"
                            style={{ color: topic.trending==='up'?'#d97706': topic.trending==='new'?'var(--color-primary)':'#64748b' }}>
                            <Icon name={topic.trending==='up'?'trending_up':topic.trending==='new'?'fiber_new':'trending_down'} size={12} />
                            {topic.trending}
                          </span>
                        )}
                        {/* Sentiment momentum */}
                        {topic.sentiment_momentum && topic.sentiment_momentum !== 'stable' && (
                          <span className="flex items-center gap-0.5 text-[10px] font-bold"
                            style={{ color: topic.sentiment_momentum==='improving'?'#059669':'#b41340' }}>
                            <Icon name={topic.sentiment_momentum==='improving'?'arrow_upward':'arrow_downward'} size={11} />
                            {topic.sentiment_momentum==='improving'
                              ? t('experience.topics.signals.improving')
                              : t('experience.topics.signals.worsening')}
                          </span>
                        )}
                        {/* Urgency */}
                        {urgency && (
                          <span className="px-1.5 py-0.5 rounded text-[9px] font-black"
                            style={{ background:urgency.bg, color:urgency.color }}>
                            {urgency.label}
                          </span>
                        )}
                        {/* Chronic */}
                        {topic.chronic && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="px-1.5 py-0.5 rounded text-[9px] font-black cursor-default"
                                style={{ background:'#fdf4ff', color:'#9333ea' }}>Chronic</span>
                            </TooltipTrigger>
                            <TooltipContent side="top" className="text-xs max-w-[200px]">
                              {t('experience.topicDetail.chronic.tooltip')}
                            </TooltipContent>
                          </Tooltip>
                        )}
                        {/* New */}
                        {topic.is_new && (
                          <span className="px-1.5 py-0.5 rounded text-[9px] font-black"
                            style={{ background:'#eef2ff', color:'#4f46e5' }}>
                            {t('experience.topics.signals.isNew')}
                          </span>
                        )}
                        {/* Health */}
                        {topic.health_label === 'at-risk' && (
                          <span className="px-1.5 py-0.5 rounded text-[9px] font-black"
                            style={{ background:'#fef2f2', color:'#b91c1c' }}>
                            {t('experience.topics.signals.atRisk')}
                          </span>
                        )}
                      </div>

                      {/* Row 2: metric chips */}
                      <div className="flex items-center gap-3 flex-wrap text-[11px] text-on-surface-variant">
                        {/* Volume */}
                        <span className="flex items-center gap-1">
                          <Icon name="chat_bubble_outline" size={11} />
                          <strong className="text-on-surface">{topic.volume?.toLocaleString()}</strong>
                          {topic.volume_delta_pct != null && topic.volume_delta_pct !== 0 && (
                            <span style={{ color: topic.volume_delta_pct > 0 ? '#059669' : '#b41340' }}>
                              {topic.volume_delta_pct > 0 ? '↑' : '↓'}{Math.abs(topic.volume_delta_pct).toFixed(0)}%
                            </span>
                          )}
                          <span>{t('insights.anomalyMentions')}</span>
                        </span>
                        {/* Effort */}
                        {topic.effort_score != null && (
                          <span className="flex items-center gap-1">
                            <Icon name="speed" size={11} />
                            <span>{t('experience.topics.signals.effortLabel')}</span>
                            <strong className="text-on-surface"
                              style={{ color: topic.effort_score >= 5.5 ? '#b41340' : topic.effort_score >= 3.5 ? '#d97706' : '#059669' }}>
                              {topic.effort_score.toFixed(1)}/7
                            </strong>
                          </span>
                        )}
                        {/* NPS impact */}
                        {npsImpact != null && (
                          <span className="flex items-center gap-1">
                            <Icon name="trending_flat" size={11} />
                            <span>{t('experience.topics.signals.npsLabel')}</span>
                            <strong style={{ color: npsImpact > 0 ? '#059669' : '#b41340' }}>
                              {npsImpact > 0 ? '+' : ''}{npsImpact.toFixed(1)} {t('experience.topics.npsPts')}
                            </strong>
                          </span>
                        )}
                        {/* Sentiment % */}
                        {(topic.positive_pct != null || topic.negative_pct != null) && (
                          <span className="flex items-center gap-1">
                            {topic.positive_pct != null && (
                              <span className="text-emerald-600">↑{topic.positive_pct.toFixed(0)}%</span>
                            )}
                            {topic.negative_pct != null && (
                              <span className="text-red-600">↓{topic.negative_pct.toFixed(0)}%</span>
                            )}
                          </span>
                        )}
                        {/* Dominant emotion */}
                        {topic.dominant_emotion && (
                          <span className="capitalize text-on-surface-variant/70">{topic.dominant_emotion}</span>
                        )}
                        {/* Confidence */}
                        {topic.confidence_level && (
                          <span className="text-[10px] opacity-60">
                            {t('experience.topics.signals.confidence', { level: topic.confidence_level })}
                          </span>
                        )}
                        {/* Subtopic count */}
                        {children.length > 0 && (
                          <button
                            onClick={() => setExpanded((prev) => {
                              const next = new Set(prev);
                              next.has(topic.id) ? next.delete(topic.id) : next.add(topic.id);
                              return next;
                            })}
                            className="flex items-center gap-0.5 text-primary hover:underline"
                          >
                            <Icon name={isExpand ? 'expand_less' : 'expand_more'} size={13} />
                            {children.length === 1
                              ? t('experience.topics.topic.subtopicOne', { n: '1' })
                              : t('experience.topics.topic.subtopicMany', { n: String(children.length) })}
                          </button>
                        )}
                      </div>

                      {/* Row 3: top verbatim preview.
                          top_verbatims is JSONB — items may be strings or {text:...} objects
                          depending on which pipeline version wrote them. Coerce to string. */}
                      {topic.top_verbatims && topic.top_verbatims.length > 0 && (() => {
                        const raw = topic.top_verbatims[0];
                        const text = typeof raw === 'string' ? raw : (raw as any)?.text ?? String(raw);
                        if (!text) return null;
                        return (
                          <p className="text-[11px] text-on-surface-variant/70 italic mt-1.5 line-clamp-1">
                            "{text.slice(0, 100)}{text.length > 100 ? '…' : ''}"
                          </p>
                        );
                      })()}
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <Button size="sm" variant="ghost"
                        className="text-xs gap-1 px-2 h-7 text-primary hover:bg-primary/8"
                        onClick={() => openCrystal(
                          t('experience.topics.query.topic', { name: topic.name }),
                          { focused_topic: topic.name },
                        )}>
                        <Icon name="psychology" size={12} style={{ color:'var(--color-primary)' }} />
                        {t('experience.topics.topic.ask')}
                      </Button>
                      <Link to={toPath(ROUTES.EXPERIENCE_SURVEY_TOPIC, { surveyId, topicId: topic.id })}>
                        <Button size="sm" variant="ghost"
                          className="text-xs gap-1 px-2 h-7 text-on-surface-variant hover:text-on-surface">
                          {t('experience.topics.topic.deepDive')}
                          <Icon name="arrow_forward" size={12} />
                        </Button>
                      </Link>
                    </div>
                  </div>

                  {/* ── Sub-topics (expandable) ──────────────────────────── */}
                  <AnimatePresence>
                    {isExpand && children.length > 0 && (
                      <motion.div
                        initial={{ opacity:0, height:0 }}
                        animate={{ opacity:1, height:'auto' }}
                        exit={{ opacity:0, height:0 }}
                        transition={{ duration:0.25, ease:[0.22,1,0.36,1] }}
                        className="overflow-hidden"
                      >
                        <div className="border-t border-outline-variant/12 divide-y divide-outline-variant/08">
                          {children.map((child) => {
                            const cDriver  = getDriver(child.name);
                            const cNps     = cDriver?.nps_delta ?? child.nps_impact ?? null;
                            const cSc      = child.sentiment_score;
                            return (
                              <div key={child.id}
                                className="flex items-center gap-3 pl-10 pr-4 py-2.5 hover:bg-surface-container/30 transition-colors group">
                                {/* Indent marker */}
                                <div className="w-2 h-2 rounded-full flex-shrink-0"
                                  style={{ background: sentColor(cSc) }} />

                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <Link
                                      to={toPath(ROUTES.EXPERIENCE_SURVEY_TOPIC, { surveyId, topicId: child.id })}
                                      className="text-xs font-bold text-on-surface-variant hover:text-primary transition-colors">
                                      {child.name}
                                    </Link>
                                    {/* Sentiment */}
                                    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full"
                                      style={{ background:sentBg(cSc), color:sentColor(cSc) }}>
                                      {sentLabel(cSc, t)}
                                    </span>
                                    {/* Trending */}
                                    {child.trending && child.trending !== 'stable' && (
                                      <span className="text-[10px]"
                                        style={{ color:child.trending==='up'?'#d97706':'#64748b' }}>
                                        {child.trending==='up'?'↑':'↓'}{child.trending}
                                      </span>
                                    )}
                                  </div>
                                  <div className="flex items-center gap-3 mt-0.5 text-[10px] text-on-surface-variant/60">
                                    <span>{child.volume} {t('insights.anomalyMentions')}</span>
                                    {child.effort_score != null && (
                                      <span>{t('experience.topics.signals.effortLabel')} {child.effort_score.toFixed(1)}/7</span>
                                    )}
                                    {cNps != null && (
                                      <span style={{ color:cNps>0?'#059669':'#b41340' }}>
                                        {t('experience.topics.signals.npsLabel')} {cNps>0?'+':''}{cNps.toFixed(1)} {t('experience.topics.npsPts')}
                                      </span>
                                    )}
                                  </div>
                                </div>

                                <button
                                  onClick={() => openCrystal(
                                    t('experience.topics.query.topic', { name: child.name }),
                                    { focused_topic: child.name },
                                  )}
                                  className="opacity-0 group-hover:opacity-100 flex items-center gap-1 px-2 py-1 rounded text-[10px] font-bold transition-all hover:bg-primary/10 flex-shrink-0"
                                  style={{ color:'var(--color-primary)' }}>
                                  <Icon name="psychology" size={11} /> {t('experience.common.askShort')}
                                </button>
                                <Link
                                  to={toPath(ROUTES.EXPERIENCE_SURVEY_TOPIC, { surveyId, topicId: child.id })}
                                  className="opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                                  <Icon name="arrow_forward" size={12} style={{ color:'var(--color-on-surface-variant)' }} />
                                </Link>
                              </div>
                            );
                          })}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </GlassCard>
              </motion.div>
            );
          })}
        </motion.div>
      )}

      {/* ══════════════════════════════════════════════════════════════════
          § 6  CRYSTAL ASK BAR
      ══════════════════════════════════════════════════════════════════ */}
      {!loading && rawTopics.length > 0 && (
        <motion.div initial={{ opacity:0, y:12 }} animate={{ opacity:1, y:0 }}
          transition={{ duration:0.4, delay:0.2 }}>
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
                  Ask about any topic — "{topUrgency?.name ? `Why is ${topUrgency.name} urgent?` : 'Which topic needs most attention?'}"
                </p>
              </div>
              <Button size="sm"
                onClick={() => openCrystal(t('experience.topics.query.all'))}
                className="text-xs font-bold text-white border-0 flex-shrink-0"
                style={{ background:'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))' }}>
                {t('experience.topics.askAll')}
              </Button>
            </div>
          </GlassCard>
        </motion.div>
      )}

    </div>
    </TooltipProvider>
  );
}
