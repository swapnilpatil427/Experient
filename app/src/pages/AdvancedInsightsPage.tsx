import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { useSetPageTitle } from '../contexts/pageTitle';
import { useInsights } from '../hooks/useInsights';
import { useSurveys } from '../hooks/useSurveys';
import { useApi } from '../hooks/useApi';
import { Link } from 'react-router-dom';
import { ROUTES, toPath } from '../constants/routes';
import { useTranslation } from '../lib/i18n';
import { PageHeader } from '../components/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useCrystalPanel } from '../contexts/crystalPanel';
import type { SurveyTopic, TopicDriver, TopicTheme } from '../types';
import { GeneratingOverlay } from './insights/GeneratingOverlay';

// ── Palette for topic cards ────────────────────────────────────────────────────
const TOPIC_PALETTES = [
  { icon: 'dashboard',      iconBg: '#eef2ff', iconColor: '#4f46e5', barColor: '#4f46e5' },
  { icon: 'payments',       iconBg: '#fffbeb', iconColor: '#d97706', barColor: '#f59e0b' },
  { icon: 'rocket_launch',  iconBg: '#eef9f4', iconColor: '#059669', barColor: '#10b981' },
  { icon: 'support_agent',  iconBg: '#f0fdfa', iconColor: '#0d9488', barColor: '#14b8a6' },
  { icon: 'insights',       iconBg: '#fdf2f8', iconColor: '#db2777', barColor: '#ec4899' },
  { icon: 'chat',           iconBg: '#eff6ff', iconColor: '#3b82f6', barColor: '#60a5fa' },
  { icon: 'build',          iconBg: '#fafaf9', iconColor: '#78716c', barColor: '#a8a29e' },
  { icon: 'star',           iconBg: '#fffbeb', iconColor: '#b45309', barColor: '#f59e0b' },
] as const;

// Pipeline nodes matching the backend INSIGHT_NODES order
const PIPELINE_NODES = [
  { id: 'ingest',   label: 'Loading Responses',  icon: 'download'            },
  { id: 'embed',    label: 'Building Embeddings', icon: 'memory'              },
  { id: 'metrics',  label: 'Computing Metrics',   icon: 'analytics'           },
  { id: 'absa',     label: 'Sentiment Analysis',  icon: 'sentiment_satisfied' },
  { id: 'cluster',  label: 'Clustering Topics',   icon: 'hub'                 },
  { id: 'topics',   label: 'Discovering Topics',  icon: 'topic'               },
  { id: 'narrate',  label: 'Narrating Insights',  icon: 'edit_note'           },
  { id: 'verify',   label: 'Verifying Claims',    icon: 'fact_check'          },
  { id: 'evaluate', label: 'Evaluating Quality',  icon: 'verified'            },
  { id: 'publish',  label: 'Publishing Results',  icon: 'publish'             },
] as const;

function topicSignal(score: number | null): { label: string; color: string; dot: string } {
  if (score == null) return { label: 'Unknown', color: '#94a3b8', dot: '#94a3b8' };
  if (score > 0.3)   return { label: 'Mostly Positive', color: '#059669', dot: '#10b981' };
  if (score < -0.3)  return { label: 'Critical Issues', color: '#b41340', dot: '#b41340' };
  return { label: 'Mixed', color: '#d97706', dot: '#f59e0b' };
}

function npsGaugeOffset(score: number | null): number {
  if (score == null) return 339.29;
  const ratio = Math.max(0, Math.min(100, score)) / 100;
  return Math.round(339.29 * (1 - ratio) * 10) / 10;
}

function npsQualLabel(t: (k: string) => string, score: number | null): string {
  if (score == null) return '—';
  if (score >= 70) return t('insights.npsExcellent');
  if (score >= 50) return t('insights.npsGood');
  if (score >= 30) return t('insights.npsFair');
  return t('insights.npsLow');
}

// Color scale for NPS delta: positive = green, negative = red
function deltaColor(delta: number | null): string {
  if (delta == null) return '#94a3b8';
  if (delta >= 10) return '#059669';
  if (delta >= 3)  return '#10b981';
  if (delta > -3)  return '#94a3b8';
  if (delta > -10) return '#f59e0b';
  return '#b41340';
}

function effortLabel(score: number | null): string {
  if (score == null) return '';
  if (score >= 5.5) return 'High effort';
  if (score >= 3.5) return 'Moderate';
  return 'Low effort';
}

function effortColor(score: number | null): string {
  if (score == null) return '#94a3b8';
  if (score >= 5.5) return '#b41340';
  if (score >= 3.5) return '#d97706';
  return '#059669';
}

export function AdvancedInsightsPage() {
  const [activeTab, setActiveTab] = useState('analysis');
  const { t } = useTranslation();
  useSetPageTitle(t('advancedInsights.pageTitle'), t('advancedInsights.dateFilter'));
  const { openCrystal, setCrystalData, setScope: setCrystalScope } = useCrystalPanel();

  const api = useApi();
  const [searchParams] = useSearchParams();
  const { surveys } = useSurveys();
  // Prefer ?survey=ID from URL (deep-link from SurveyIntelligencePage),
  // then first active survey, then any survey.
  const surveyParam  = searchParams.get('survey');
  const activeSurvey = (surveyParam ? surveys.find((s) => s.id === surveyParam) : null)
    ?? surveys.find((s) => s.status === 'active')
    ?? surveys[0];
  const { insights, generating: legacyGenerating, regenerate } = useInsights(activeSurvey?.id);

  // ── Time window + sort ────────────────────────────────────────────────────
  const [window,   setWindow]   = useState<'all_time' | '30d' | '7d'>('all_time');
  const [sortMode, setSortMode] = useState<'volume' | 'urgency'>('volume');

  // ── Topics ────────────────────────────────────────────────────────────────
  const [themes,        setThemes]        = useState<TopicTheme[]>([]);
  const [topicsLoading, setTopicsLoading] = useState(false);
  const [runStatus,     setRunStatus]     = useState<string | null>(null);
  const [selectedId,    setSelectedId]    = useState<string | null>(null);

  // Flat sorted list derived from hierarchy — used by all non-rendering logic
  const topics = useMemo<SurveyTopic[]>(() => {
    const flat = themes.flatMap(th => [
      ...th.topics,
      ...th.topics.flatMap(tp => tp.subtopics ?? []),
    ]);
    return sortMode === 'urgency'
      ? [...flat].sort((a, b) => (b.urgency_score ?? 0) - (a.urgency_score ?? 0))
      : [...flat].sort((a, b) => b.volume - a.volume);
  }, [themes, sortMode]);

  const loadTopics = useCallback(async () => {
    if (!activeSurvey?.id) { setThemes([]); return; }
    setTopicsLoading(true);
    try {
      const data = await api.getTopicHierarchy(activeSurvey.id, window);
      setThemes(data.themes ?? []);
      setRunStatus(null);
      if (data.themes?.length && !selectedId) {
        const first = data.themes[0]?.topics[0];
        if (first) setSelectedId(first.id);
      }
    } catch {
      setThemes([]);
    } finally {
      setTopicsLoading(false);
    }
  }, [api, activeSurvey?.id, window]);

  useEffect(() => { loadTopics(); }, [loadTopics]);

  // Scope Crystal to active survey; reset to 'all' when no survey is selected
  useEffect(() => {
    if (activeSurvey?.id) {
      setCrystalScope(activeSurvey.id);
    } else {
      setCrystalScope('all');
    }
    return () => setCrystalScope('all');
  }, [activeSurvey?.id, setCrystalScope]);

  useEffect(() => {
    setCrystalData([], topics);
  }, [topics, setCrystalData]);

  // ── Driver analysis ───────────────────────────────────────────────────────
  const [drivers,        setDrivers]        = useState<TopicDriver[]>([]);
  const [driversLoading, setDriversLoading] = useState(false);
  const [overallNps,     setOverallNps]     = useState<number | null>(null);

  const loadDrivers = useCallback(async () => {
    if (!activeSurvey?.id) { setDrivers([]); return; }
    setDriversLoading(true);
    try {
      const { drivers: list, overall_nps } = await api.getTopicDrivers(activeSurvey.id, window);
      setDrivers(list ?? []);
      setOverallNps(overall_nps);
    } catch {
      setDrivers([]);
    } finally {
      setDriversLoading(false);
    }
  }, [api, activeSurvey?.id, window]);

  useEffect(() => { loadDrivers(); }, [loadDrivers]);

  // ── Response quotes for selected topic ───────────────────────────────────
  type Quote = { response_id: string; texts: string[]; nps_score: number | null; submitted_at: string };
  const [quotes,        setQuotes]        = useState<Quote[]>([]);
  const [quotesLoading, setQuotesLoading] = useState(false);

  useEffect(() => {
    if (!selectedId || !activeSurvey?.id) { setQuotes([]); return; }
    setQuotesLoading(true);
    api.getTopicQuotes(activeSurvey.id, selectedId)
      .then(d => setQuotes(d.quotes ?? []))
      .catch(() => setQuotes([]))
      .finally(() => setQuotesLoading(false));
  }, [api, activeSurvey?.id, selectedId]);

  // ── Generate + poll pipeline ──────────────────────────────────────────────
  const [generating,  setGenerating]  = useState(false);
  const [nodesDone,   setNodesDone]   = useState<string[]>([]);
  const [genError,    setGenError]    = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const handleGenerate = useCallback(async () => {
    if (!activeSurvey?.id || generating) return;
    setGenerating(true);
    setNodesDone([]);
    setGenError(null);
    try {
      await api.triggerInsightGeneration(activeSurvey.id);
    } catch {
      setGenError('Failed to start analysis. Is the agents service running?');
      setGenerating(false);
      return;
    }
    let elapsed = 0;
    pollRef.current = setInterval(async () => {
      elapsed += 3;
      try {
        const { status, stream_events } = await api.getInsightRunStatus(activeSurvey.id);
        const completed = (stream_events as Array<{ event: string; agent: string }>)
          .filter(e => e.event === 'node_complete')
          .map(e => e.agent);
        setNodesDone(completed);
        if (status === 'failed') {
          clearInterval(pollRef.current!);
          setGenError('Analysis failed. Check the agents service logs.');
          setGenerating(false);
          return;
        }
        if (status === 'completed') {
          clearInterval(pollRef.current!);
          setNodesDone(PIPELINE_NODES.map(n => n.id));
          await new Promise(r => setTimeout(r, 800));
          await loadTopics();
          await loadDrivers();
          setGenerating(false);
          setNodesDone([]);
          return;
        }
      } catch { /* keep polling */ }
      if (elapsed >= 180) {
        clearInterval(pollRef.current!);
        setGenError('Analysis timed out. Results may arrive shortly.');
        setGenerating(false);
      }
    }, 3000);
  }, [api, activeSurvey?.id, generating, loadTopics, loadDrivers]);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  // ── Derived values ────────────────────────────────────────────────────────
  const npsScore   = insights?.nps_score ?? null;
  const dashOffset = npsGaugeOffset(npsScore);
  const npsDisplay = npsScore != null ? Math.round(npsScore) : '—';
  const npsLabel   = npsQualLabel(t, npsScore);

  const sb = insights?.sentiment_breakdown;
  // Only show real bars when at least one bucket has data (> 0 means agent ran)
  const hasSentimentData = sb != null && (sb.positive > 0 || sb.neutral > 0 || sb.negative > 0);
  const sentimentBars = hasSentimentData
    ? [
        { label: `${sb!.positive}% Pos`, pct: sb!.positive, color: 'linear-gradient(to top, #10b981, #6ee7b7)', labelColor: '#475569' },
        { label: `${sb!.neutral}% Neu`,  pct: sb!.neutral,  color: 'linear-gradient(to top, #94a3b8, #cbd5e1)', labelColor: '#475569' },
        { label: `${sb!.negative}% Neg`, pct: sb!.negative, color: 'linear-gradient(to top, #b41340, #f74b6d)', labelColor: '#b41340' },
      ]
    : null;

  const phrases = (insights?.top_phrases ?? []).slice(0, 3);
  const responseCount = insights?.response_count ?? 0;

  // Anomalies: topics trending up with negative sentiment
  const anomalies = topics.filter(
    t => t.trending === 'up' && (t.sentiment_score ?? 0) < -0.3,
  );

  return (
    <div className="space-y-8 max-w-7xl mx-auto w-full">

      <PageHeader
        crumbs={
          surveyParam && activeSurvey
            ? [
                { label: t('nav.experience'), icon: 'star', path: ROUTES.EXPERIENCE },
                { label: activeSurvey.title || 'Survey', path: toPath(ROUTES.EXPERIENCE_SURVEY, { surveyId: surveyParam }) },
                { label: t('advancedInsights.pageTitle') },
              ]
            : [
                { label: t('nav.insights'), icon: 'psychology', path: ROUTES.INSIGHTS },
                { label: t('advancedInsights.pageTitle') },
              ]
        }
        title={t('advancedInsights.pageTitle')}
        subtitle={generating ? t('advancedInsights.generateRunning') : t('advancedInsights.topicsDescription', { count: responseCount.toLocaleString() })}
        actions={
          <div className="flex items-center gap-2 flex-wrap">
            {/* Sort mode */}
            <div className="flex rounded-xl overflow-hidden border border-border bg-muted/5 text-xs font-bold">
              {(['volume', 'urgency'] as const).map(s => (
                <button key={s} onClick={() => setSortMode(s)}
                  className="px-3 py-1.5 transition-colors flex items-center gap-1"
                  style={{ background: sortMode === s ? '#0f172a' : 'transparent', color: sortMode === s ? '#fff' : '#64748b' }}>
                  <Icon name={s === 'urgency' ? 'priority_high' : 'bar_chart'} size={12} />
                  {t(`advancedInsights.sortBy${s === 'urgency' ? 'Urgency' : 'Volume'}`)}
                </button>
              ))}
            </div>
            {/* Time window selector */}
            <div className="flex rounded-xl overflow-hidden border border-border bg-muted/5 text-xs font-bold">
              {(['all_time', '30d', '7d'] as const).map(w => (
                <button
                  key={w}
                  onClick={() => setWindow(w)}
                  className="px-3 py-1.5 transition-colors"
                  style={{ background: window === w ? '#4f46e5' : 'transparent', color: window === w ? '#fff' : '#64748b' }}
                >
                  {w === 'all_time' ? t('advancedInsights.windowAll') : w === '30d' ? t('advancedInsights.window30d') : t('advancedInsights.window7d')}
                </button>
              ))}
            </div>
            <Button variant="outline" size="sm" onClick={handleGenerate}
              disabled={generating || !activeSurvey} className="rounded-xl font-bold text-xs">
              <Icon name="psychology" size={16} />
              {t('advancedInsights.recalculateButton')}
            </Button>
          </div>
        }
      />

      <GeneratingOverlay
        generating={generating}
        nodesDone={nodesDone}
        genError={genError ?? null}
        nodes={PIPELINE_NODES}
        focusSurvey={activeSurvey ?? undefined}
        onRetry={handleGenerate}
      />

      {!generating && <>

      {/* ── Anomaly alerts ─────────────────────────────────────────────────── */}
      {anomalies.length > 0 && (
        <div className="space-y-2">
          {anomalies.slice(0, 2).map(topic => (
            <div
              key={topic.id}
              className="flex items-center gap-3 px-5 py-3 rounded-xl border text-sm font-semibold"
              style={{ background: 'rgba(180,19,64,0.06)', borderColor: 'rgba(180,19,64,0.2)', color: '#b41340' }}
            >
              <Icon name="warning" fill={1} size={18} />
              <span>
                <strong>{topic.name}</strong> is trending negative
                {topic.negative_pct != null ? ` — ${Math.round(topic.negative_pct)}% of mentions are critical` : ''}
              </span>
              {activeSurvey?.id ? (
                <Link
                  to={toPath(ROUTES.EXPERIENCE_SURVEY_TOPIC, { surveyId: activeSurvey.id, topicId: topic.id })}
                  className="ml-auto text-xs opacity-60 hover:opacity-100 transition-opacity"
                >
                  View topic →
                </Link>
              ) : (
                <button className="ml-auto text-xs opacity-60 hover:opacity-100" onClick={() => setSelectedId(topic.id)}>
                  View topic →
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── NPS + CSAT ─────────────────────────────────────────────────────── */}
      <section className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* NPS Gauge */}
        <div
          className="p-8 relative overflow-hidden text-white flex items-center gap-8"
          style={{
            background: 'linear-gradient(135deg, #4338ca, #3730a3)',
            borderRadius: '0.75rem',
            boxShadow: '0 20px 40px -10px rgba(67,56,202,0.4)',
          }}
        >
          <div className="relative z-10 flex flex-col justify-center">
            <p className="text-indigo-100 font-bold text-xs uppercase tracking-widest mb-1">
              {t('insights.npsLabel')}
            </p>
            <h3 className="text-5xl font-black mb-4 font-headline">{npsDisplay}</h3>
            {overallNps != null && (
              <p className="text-[11px] text-indigo-200 font-semibold">
                survey avg · {Math.round(overallNps)} pts
              </p>
            )}
          </div>
          <div className="relative z-10 ml-auto">
            <div className="relative w-32 h-32 flex items-center justify-center">
              <svg className="w-full h-full transform -rotate-90" viewBox="0 0 128 128">
                <circle cx="64" cy="64" r="54" fill="transparent" stroke="rgba(67,56,202,0.4)" strokeWidth="12" />
                <circle
                  cx="64" cy="64" r="54"
                  fill="transparent"
                  stroke="var(--color-secondary-container)"
                  strokeWidth="12"
                  strokeDasharray="339.29"
                  strokeDashoffset={dashOffset}
                  strokeLinecap="round"
                />
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-2xl font-black font-headline">
                  {npsScore != null ? `${Math.max(0, Math.round(npsScore))}%` : '—'}
                </span>
                <span className="text-[8px] uppercase font-bold tracking-tighter opacity-70">{npsLabel}</span>
              </div>
            </div>
          </div>
          <button
            onClick={() => openCrystal(
              `What's driving our current NPS of ${npsScore != null ? Math.round(npsScore) : '—'}? What should we improve first?`,
              { window, focused_topic: topics[0]?.name },
            )}
            className="absolute bottom-4 right-4 z-10 text-[11px] font-bold px-3 py-1.5 rounded-full flex items-center gap-1 text-white/80 hover:text-white hover:bg-white/10 transition-all border border-white/20">
            <Icon name="psychology" size={13} />
            Ask Crystal
          </button>
          <div className="absolute -right-10 -bottom-10 w-48 h-48 rounded-full" style={{ background: 'rgba(255,255,255,0.05)', filter: 'blur(48px)' }} />
        </div>

        {/* CSAT / Effort card */}
        <Card className="p-8 relative overflow-hidden flex items-center gap-8 bg-white border-muted/10" style={{ borderRadius: '0.75rem', boxShadow: '0 4px 12px rgba(0,0,0,0.04)' }}>
          <div className="relative z-10 flex flex-col justify-center flex-1">
            <p className="font-bold text-xs uppercase tracking-widest mb-1 text-on-surface-variant">{t('insights.csatLabel')}</p>
            <div className="flex items-baseline gap-2 mb-4">
              <h3 className="text-5xl font-black font-headline text-on-surface">
                {activeSurvey?.avg_csat != null ? Number(activeSurvey.avg_csat).toFixed(1) : '—'}
              </h3>
              <span className="text-xl font-bold text-muted-foreground/50">{t('insights.csatScale')}</span>
            </div>
            {/* Effort score summary */}
            {topics.length > 0 && (
              <div className="mt-2">
                <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-2">Avg Effort Score</p>
                <div className="flex items-center gap-2">
                  {(() => {
                    const scored = topics.filter(t => t.effort_score != null);
                    const avgEffort = scored.length > 0
                      ? scored.reduce((s, t) => s + t.effort_score!, 0) / scored.length
                      : 3.5; // neutral midpoint fallback when no effort data yet
                    return (
                      <>
                        <div className="flex-1 h-1.5 rounded-full bg-muted/30 overflow-hidden">
                          <div className="h-full rounded-full" style={{ width: `${(avgEffort / 7) * 100}%`, background: effortColor(avgEffort) }} />
                        </div>
                        <span className="text-xs font-bold" style={{ color: effortColor(avgEffort) }}>
                          {avgEffort.toFixed(1)} · {effortLabel(avgEffort)}
                        </span>
                      </>
                    );
                  })()}
                </div>
              </div>
            )}
          </div>
          {/* Sentiment breakdown bars — real data from insights, hidden when not available */}
          {insights?.sentiment_breakdown ? (
            <div className="relative z-10 flex gap-2 items-end h-24">
              {[
                { pct: insights.sentiment_breakdown.positive, color: '#10b981' },
                { pct: insights.sentiment_breakdown.neutral,  color: '#94a3b8' },
                { pct: insights.sentiment_breakdown.negative, color: '#b41340' },
              ].map(({ pct, color }, i) => (
                <div key={i} className="w-4 rounded-full self-end"
                  style={{ height: `${Math.max(pct, 4)}%`, background: color,
                    boxShadow: i === 0 ? '0 0 8px rgba(16,185,129,0.3)' : i === 2 ? '0 0 8px rgba(180,19,64,0.3)' : 'none' }} />
              ))}
            </div>
          ) : (
            <div className="relative z-10 flex items-center justify-center h-24 w-16">
              <span className="text-[10px] text-muted-foreground text-center">Run analysis<br/>for data</span>
            </div>
          )}
        </Card>
      </section>

      {/* ── NPS Driver Analysis ───────────────────────────────────────────── */}
      {(drivers.length > 0 || driversLoading) && (
        <section className="space-y-4">
          <div>
            <h4 className="text-xl font-bold font-headline text-on-surface">{t('advancedInsights.driverAnalysis')}</h4>
            <p className="text-sm text-on-surface-variant">{t('advancedInsights.driverSubtitle')}</p>
          </div>

          {driversLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {[0,1,2].map(i => <div key={i} className="h-24 rounded-2xl bg-muted/20 animate-pulse" />)}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {drivers.slice(0, 6).map((driver, idx) => {
                const isLifter  = (driver.nps_delta ?? 0) >= 3;
                const isDragger = (driver.nps_delta ?? 0) <= -3;
                return (
                  <div
                    key={driver.id}
                    className="p-4 rounded-2xl border flex items-center gap-4 group relative"
                    style={{
                      background: isLifter ? 'rgba(5,150,105,0.04)' : isDragger ? 'rgba(180,19,64,0.04)' : 'rgba(0,0,0,0.02)',
                      borderColor: isLifter ? 'rgba(5,150,105,0.2)' : isDragger ? 'rgba(180,19,64,0.2)' : 'rgba(0,0,0,0.06)',
                    }}
                  >
                    <button
                      onClick={() => openCrystal(
                        `What's driving the "${driver.name}" topic's ${(driver.nps_delta ?? 0) > 0 ? 'positive' : 'negative'} impact on NPS? What should we do about it?`,
                        { window, focused_topic: driver.name },
                      )}
                      className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity text-[10px] font-bold px-2 py-1 rounded-full flex items-center gap-1"
                      style={{ background: '#4f46e5', color: '#fff' }}>
                      <Icon name="psychology" size={11} />
                      Ask
                    </button>
                    {/* Rank */}
                    <span className="text-2xl font-black font-headline w-7 text-muted-foreground/40 shrink-0">
                      {idx + 1}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <p className="font-bold text-sm text-on-surface truncate">{driver.name}</p>
                        {driver.trending === 'up' && (
                          <Icon name="trending_up" size={14}
                            style={{ color: (driver.sentiment_score ?? 0) < 0 ? '#b41340' : '#059669' }} />
                        )}
                        {driver.trending === 'down' && <Icon name="trending_down" size={14} className="text-muted-foreground" />}
                      </div>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground">
                        <span>{driver.volume.toLocaleString()} mentions</span>
                        {driver.effort_score != null && (
                          <span style={{ color: effortColor(driver.effort_score) }}>
                            effort {driver.effort_score.toFixed(1)}
                          </span>
                        )}
                      </div>
                    </div>
                    {/* Delta badge */}
                    <div className="text-right shrink-0">
                      {driver.nps_delta != null ? (
                        <>
                          <p className="text-lg font-black font-headline" style={{ color: deltaColor(driver.nps_delta) }}>
                            {driver.nps_delta > 0 ? '+' : ''}{driver.nps_delta}
                          </p>
                          <p className="text-[9px] font-bold uppercase text-muted-foreground">NPS pts</p>
                        </>
                      ) : (
                        <div className="w-8 h-8 rounded-full flex items-center justify-center"
                          style={{ background: (driver.sentiment_score ?? 0) > 0.2 ? '#d1fae5' : (driver.sentiment_score ?? 0) < -0.2 ? '#fee2e2' : '#f1f5f9' }}>
                          <Icon name={(driver.sentiment_score ?? 0) > 0.2 ? 'thumb_up' : (driver.sentiment_score ?? 0) < -0.2 ? 'thumb_down' : 'remove'} size={14}
                            style={{ color: (driver.sentiment_score ?? 0) > 0.2 ? '#059669' : (driver.sentiment_score ?? 0) < -0.2 ? '#b41340' : '#94a3b8' }} />
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* ── Topic Landscape ───────────────────────────────────────────────── */}
      <section className="space-y-4">
        <div className="flex justify-between items-end">
          <div>
            <h4 className="text-xl font-bold font-headline text-on-surface">{t('advancedInsights.extractedTopics')}</h4>
            <p className="text-sm text-on-surface-variant">
              {t('advancedInsights.topicsDescription', { count: responseCount.toLocaleString() })}
            </p>
          </div>
        </div>

        {/* Generating / loading skeletons */}
        {topicsLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {[0,1,2,3].map(i => <div key={i} className="h-32 rounded-2xl bg-muted/20 animate-pulse" />)}
          </div>
        ) : runStatus === 'running' ? (
          <div className="flex flex-col items-center justify-center py-16 gap-3 rounded-2xl border border-dashed border-indigo-200 bg-indigo-50/50">
            <Icon name="psychology" size={32} className="text-indigo-400" style={{ animation: 'spin 3s linear infinite' }} />
            <p className="font-bold text-on-surface">{t('advancedInsights.generateRunning')}</p>
            <p className="text-sm text-muted-foreground">Results will appear automatically when ready</p>
          </div>
        ) : topics.length === 0 ? (
          /* Empty state with generate CTA */
          <div className="flex flex-col items-center justify-center py-20 gap-5 rounded-2xl border border-dashed border-muted/40">
            <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center">
              <Icon name="psychology" size={32} className="text-primary" />
            </div>
            <div className="text-center max-w-sm">
              <p className="font-bold text-lg text-on-surface mb-2">{t('advancedInsights.generateCta')}</p>
              <p className="text-sm text-muted-foreground">{t('advancedInsights.generateSubtitle')}</p>
            </div>
            {genError && (
              <p className="text-sm text-destructive font-medium bg-destructive/10 px-4 py-2 rounded-xl">{genError}</p>
            )}
            {activeSurvey ? (
              <Button
                onClick={handleGenerate}
                disabled={generating}
                className="font-bold px-8 py-3 rounded-2xl text-white"
                style={{ background: '#4f46e5', boxShadow: '0 10px 20px rgba(79,70,229,0.25)' }}
              >
                <Icon name="auto_awesome" size={18} />
                {t('advancedInsights.generateCta')}
              </Button>
            ) : surveys.length === 0 ? (
              <div className="text-center space-y-2">
                <p className="text-sm text-muted-foreground font-bold">No surveys yet</p>
                <p className="text-xs text-muted-foreground">Create and publish a survey first, then come back to analyse it.</p>
                <Link to={ROUTES.CREATE} className="inline-block mt-2">
                  <Button size="sm" variant="outline" className="text-xs font-bold">
                    <Icon name="add" size={13} /> Create a survey
                  </Button>
                </Link>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t('advancedInsights.noSurveySelected')}</p>
            )}
          </div>
        ) : (
          <div className="space-y-6">
            {themes.map((theme, themeIdx) => {
              const themeTopics = sortMode === 'urgency'
                ? [...theme.topics].sort((a, b) => (b.urgency_score ?? 0) - (a.urgency_score ?? 0))
                : [...theme.topics].sort((a, b) => b.volume - a.volume);
              const themeOffset = themes.slice(0, themeIdx).reduce((s, th) => s + th.topics.length, 0);
              return (
                <div key={theme.name} className="space-y-3">
                  {themes.length > 1 && (
                    <div className="flex items-center gap-3 pb-1">
                      <h5 className="text-xs font-black uppercase tracking-widest text-on-surface/50">{theme.name}</h5>
                      <div className="flex-1 h-px bg-muted/20" />
                      <span className="text-xs text-muted-foreground">{theme.volume.toLocaleString()} mentions</span>
                    </div>
                  )}
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                    {themeTopics.map((topic, idx) => {
              const palette  = TOPIC_PALETTES[(themeOffset + idx) % TOPIC_PALETTES.length];
              const signal   = topicSignal(topic.sentiment_score);
              const isActive = topic.id === selectedId;
              return (
                <button
                  key={topic.id}
                  className="group p-5 text-left relative overflow-hidden transition-all duration-300"
                  style={{
                    background: isActive ? '#e0e7ff' : '#ffffff',
                    border: isActive ? '2px solid #4f46e5' : '1px solid rgba(171,173,175,0.1)',
                    borderRadius: '1rem',
                    boxShadow: isActive ? '0 8px 24px rgba(79,70,229,0.2)' : '0 2px 8px rgba(0,0,0,0.04)',
                    transform: isActive ? 'scale(1.04)' : 'none',
                    zIndex: isActive ? 10 : 'auto',
                  }}
                  onClick={() => setSelectedId(topic.id)}
                  onMouseEnter={e => { if (!isActive) e.currentTarget.style.boxShadow = '0 20px 40px -10px rgba(0,0,0,0.1)'; }}
                  onMouseLeave={e => { if (!isActive) e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.04)'; }}
                >
                  {/* Top row: icon + badges */}
                  <div className="flex justify-between items-start mb-3">
                    <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
                      style={{ background: palette.iconBg, color: palette.iconColor }}>
                      <Icon name={palette.icon} size={18} />
                    </div>
                    <div className="flex flex-wrap items-end gap-1 justify-end">
                      {/* Urgency badge — only show medium+ */}
                      {/* urgency_score [0-100]: 30=medium, 80=critical */}
                      {(topic.urgency_score ?? 0) >= 30 && (
                        <span className="text-[9px] font-black px-1.5 py-0.5 rounded-md uppercase tracking-wide"
                          style={{
                            background: (topic.urgency_score ?? 0) >= 80 ? '#fef2f2' : '#fff7ed',
                            color:      (topic.urgency_score ?? 0) >= 80 ? '#b91c1c' : '#c2410c',
                          }}>
                          {(topic.urgency_score ?? 0) >= 80 ? t('advancedInsights.urgencyCritical') : t('advancedInsights.urgencyHigh')}
                        </span>
                      )}
                      {/* Chronic badge */}
                      {topic.chronic && (
                        <span className="text-[9px] font-black px-1.5 py-0.5 rounded-md"
                          style={{ background: '#fdf4ff', color: '#9333ea' }}>
                          Chronic
                        </span>
                      )}
                      {topic.is_new && (
                        <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-md"
                          style={{ background: '#eef2ff', color: '#4f46e5' }}>New</span>
                      )}
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-xl"
                        style={{ background: isActive ? '#4f46e5' : '#f1f5f9', color: isActive ? '#fff' : '#475569' }}>
                        {topic.volume.toLocaleString()}
                        {topic.volume_delta_pct != null && topic.volume_delta_pct !== 0 && (
                          <span style={{ marginLeft: 3, color: topic.volume_delta_pct > 0 ? '#059669' : '#b41340' }}>
                            {topic.volume_delta_pct > 0 ? '↑' : '↓'}
                          </span>
                        )}
                      </span>
                    </div>
                  </div>

                  <h5 className="font-bold text-sm mb-2 font-headline text-on-surface leading-snug">{topic.name}</h5>

                  {/* Signal row: sentiment • volume trend • sentiment momentum */}
                  <div className="flex items-center gap-2 flex-wrap mb-2">
                    <span className="w-2 h-2 rounded-full shrink-0"
                      style={{ background: signal.dot, animation: isActive ? 'pulse 2s infinite' : 'none' }} />
                    <span className="text-[10px] font-semibold uppercase tracking-tighter" style={{ color: signal.color }}>
                      {signal.label}
                    </span>
                    {/* Volume direction */}
                    {topic.trending && topic.trending !== 'stable' && (
                      <span className="flex items-center gap-0.5 text-[10px] font-bold"
                        style={{ color: topic.trending === 'up' ? '#b45309' : '#64748b' }}>
                        <Icon name={topic.trending === 'up' ? 'trending_up' : topic.trending === 'down' ? 'trending_down' : 'fiber_new'} size={12} />
                        {topic.trending === 'new' ? 'new' : topic.volume_delta_pct != null ? `${Math.abs(topic.volume_delta_pct)}%` : ''}
                      </span>
                    )}
                    {/* Sentiment momentum */}
                    {topic.sentiment_momentum && topic.sentiment_momentum !== 'stable' && (
                      <span className="flex items-center gap-0.5 text-[10px] font-bold"
                        style={{ color: topic.sentiment_momentum === 'improving' ? '#059669' : '#b41340' }}>
                        <Icon name={topic.sentiment_momentum === 'improving' ? 'arrow_upward' : 'arrow_downward'} size={11} />
                        {topic.sentiment_momentum === 'improving' ? t('advancedInsights.momentumImproving') : t('advancedInsights.momentumWorsening')}
                      </span>
                    )}
                  </div>

                  {/* Effort score bar */}
                  {topic.effort_score != null && (
                    <div>
                      <div className="flex justify-between text-[9px] font-bold text-muted-foreground mb-0.5">
                        <span>{t('advancedInsights.effortLabel')}</span>
                        <span style={{ color: effortColor(topic.effort_score) }}>{topic.effort_score.toFixed(1)}/7</span>
                      </div>
                      <div className="h-1 rounded-full bg-muted/30 overflow-hidden">
                        <div className="h-full rounded-full"
                          style={{ width: `${(topic.effort_score / 7) * 100}%`, background: effortColor(topic.effort_score) }} />
                      </div>
                    </div>
                  )}

                  <div className="absolute bottom-0 left-0 h-1 w-0 group-hover:w-full transition-all duration-500"
                    style={{ background: palette.barColor }} />
                </button>
              );
            })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ── Analytics Detail ──────────────────────────────────────────────── */}
      {topics.length > 0 && (
        <section className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 space-y-6">
            <Card className="overflow-hidden bg-white border-muted/10" style={{ borderRadius: '1rem', boxShadow: '0 4px 12px rgba(0,0,0,0.04)' }}>
              <Tabs value={activeTab} onValueChange={setActiveTab}>
                <div className="border-b border-muted/20 bg-muted/5 p-2 flex gap-2">
                  <TabsList className="h-auto bg-transparent rounded-none p-0 gap-2">
                    {[
                      { id: 'analysis', label: t('advancedInsights.tabs.analysis'),  icon: 'analytics'     },
                      { id: 'sample',   label: t('advancedInsights.tabs.sampleData'), icon: 'format_quote' },
                      { id: 'trends',   label: t('advancedInsights.tabs.trends'),     icon: 'history'       },
                    ].map(tab => (
                      <TabsTrigger key={tab.id} value={tab.id}
                        className="px-6 py-3 rounded-xl font-bold text-sm flex items-center gap-2 data-[state=active]:bg-white data-[state=active]:text-[#4f46e5] data-[state=active]:shadow-sm data-[state=inactive]:text-muted-foreground">
                        <Icon name={tab.icon} size={16} />
                        {tab.label}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </div>

                <CardContent className="p-8 space-y-10">
                  <div className="flex flex-col md:flex-row gap-12">
                    {/* Sentiment breakdown */}
                    <div className="flex-1 space-y-4">
                      <h6 className="text-sm font-bold uppercase tracking-widest text-muted-foreground">
                        {t('advancedInsights.sentimentBreakdown')}
                      </h6>
                      <div className="flex items-end justify-between h-40 gap-4">
                        {sentimentBars ? sentimentBars.map(bar => (
                          <div key={bar.label} className="flex-1 flex flex-col items-center gap-3">
                            <div className="w-full rounded-t-xl" style={{ height: `${bar.pct}%`, background: bar.color }} />
                            <span className="text-[10px] font-bold" style={{ color: bar.labelColor }}>{bar.label}</span>
                          </div>
                        )) : (
                          <div className="flex-1 flex flex-col items-center justify-center text-sm text-muted-foreground gap-2">
                            <Icon name="bar_chart" size={28} className="text-muted-foreground/40" />
                            <span className="text-xs">{t('advancedInsights.noSentimentData')}</span>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Top phrases */}
                    <div className="flex-1 space-y-4">
                      <h6 className="text-sm font-bold uppercase tracking-widest text-muted-foreground">
                        {t('advancedInsights.topPhrases')}
                      </h6>
                      {phrases.length > 0 ? (
                        <div className="space-y-3">
                          {phrases.map((p, i) => (
                            <div key={i} className="flex items-center p-3 rounded-xl border bg-muted/5 border-muted/20">
                              <span className="text-sm font-semibold text-on-surface">"{p}"</span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="flex items-center justify-center h-28 rounded-xl border border-dashed border-muted/40 text-sm text-muted-foreground">
                          No phrases available yet
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Response quotes for selected topic */}
                  <div className="space-y-4">
                    <h6 className="text-sm font-bold uppercase tracking-widest text-muted-foreground">
                      {t('advancedInsights.sampleResponses')}
                    </h6>
                    <ScrollArea className="h-56 pr-2">
                      {quotesLoading ? (
                        <div className="flex items-center justify-center h-32 gap-2 text-sm text-muted-foreground">
                          <Icon name="hourglass_top" size={16} style={{ animation: 'spin 1s linear infinite' }} />
                          Loading quotes…
                        </div>
                      ) : quotes.length > 0 ? (
                        <div className="space-y-3">
                          {quotes.map((q, i) => (
                            <div key={q.response_id ?? i}
                              className="p-3 rounded-xl border border-muted/20 bg-white space-y-1.5"
                              style={{ boxShadow: '0 2px 6px rgba(0,0,0,0.04)' }}>
                              {q.texts.map((text, ti) => (
                                <p key={ti} className="text-sm italic leading-relaxed text-on-surface-variant">
                                  "{text.slice(0, 200)}{text.length > 200 ? '…' : ''}"
                                </p>
                              ))}
                              <div className="flex items-center gap-2 mt-1.5">
                                {q.nps_score != null && (
                                  <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full"
                                    style={{
                                      background: q.nps_score >= 9 ? '#ecfdf5' : q.nps_score >= 7 ? '#fefce8' : '#fff1f2',
                                      color: q.nps_score >= 9 ? '#059669' : q.nps_score >= 7 ? '#d97706' : '#b41340',
                                    }}>
                                    NPS {q.nps_score}
                                  </span>
                                )}
                                <span className="text-[10px] text-muted-foreground">
                                  {new Date(q.submitted_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                                </span>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="flex flex-col items-center justify-center h-32 gap-2 text-center">
                          <Icon name="chat_bubble_outline" size={28} className="text-muted-foreground/40" />
                          <p className="text-sm text-muted-foreground">
                            {selectedId ? 'No verbatim responses found for this topic yet.' : 'Select a topic above to see response quotes.'}
                          </p>
                        </div>
                      )}
                    </ScrollArea>
                  </div>
                </CardContent>
              </Tabs>
            </Card>
          </div>

          {/* Topic Management sidebar */}
          <div className="lg:col-span-1 space-y-6">
            <Card className="rounded-2xl border p-8 h-full flex flex-col"
              style={{ background: 'rgba(255,255,255,0.6)', backdropFilter: 'blur(24px)', borderColor: 'rgba(255,255,255,0.4)', boxShadow: '0 20px 40px -10px rgba(0,0,0,0.08)' }}>
              <div className="flex items-center gap-3 mb-6">
                <div className="w-10 h-10 rounded-full flex items-center justify-center text-primary bg-primary/10">
                  <Icon name="manage_accounts" size={20} />
                </div>
                <h4 className="text-lg font-black font-headline text-on-surface">{t('advancedInsights.topicManagement')}</h4>
              </div>

              <div className="space-y-6 flex-1">
                <div>
                  <p className="text-xs font-bold uppercase tracking-widest mb-3 text-muted-foreground">{t('advancedInsights.activeSelection')}</p>
                  <div className="flex flex-wrap gap-2">
                    {selectedId ? (
                      <div className="px-3 py-1.5 rounded-full text-xs font-bold flex items-center gap-2 text-white"
                        style={{ background: '#4f46e5', boxShadow: '0 4px 12px rgba(79,70,229,0.2)' }}>
                        {topics.find(t => t.id === selectedId)?.name ?? '—'}
                        <Button variant="ghost" size="icon" className="h-auto w-auto p-0 text-white/80 hover:text-white hover:bg-transparent"
                          onClick={() => setSelectedId(null)}>
                          <Icon name="close" size={12} />
                        </Button>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">No topic selected</span>
                    )}
                  </div>
                </div>

                {/* Selected topic stats */}
                {selectedId && (() => {
                  const sel = topics.find(t => t.id === selectedId);
                  const drv = drivers.find(d => d.id === selectedId);
                  if (!sel) return null;
                  const urgency = sel.urgency_score ?? 0;
                  const urgencyLabel = urgency >= 8 ? t('advancedInsights.urgencyCritical')
                                     : urgency >= 5 ? t('advancedInsights.urgencyHigh')
                                     : urgency >= 3 ? t('advancedInsights.urgencyMedium')
                                     : t('advancedInsights.urgencyLow');
                  const urgencyColor = urgency >= 8 ? '#b91c1c' : urgency >= 5 ? '#c2410c' : urgency >= 3 ? '#d97706' : '#059669';
                  return (
                    <div className="space-y-3">
                      <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Topic Stats</p>
                      <div className="grid grid-cols-2 gap-2">
                        {[
                          { label: 'Mentions', value: sel.volume.toLocaleString() + (sel.volume_delta_pct != null && sel.volume_delta_pct !== 0 ? ` (${sel.volume_delta_pct > 0 ? '+' : ''}${sel.volume_delta_pct}%)` : '') },
                          { label: 'Sentiment', value: sel.sentiment_score != null ? (sel.sentiment_score > 0 ? '+' : '') + sel.sentiment_score.toFixed(2) : '—' },
                          { label: 'NPS Delta', value: drv?.nps_delta != null ? (drv.nps_delta > 0 ? '+' : '') + drv.nps_delta + ' pts' : '—' },
                          { label: 'Effort', value: sel.effort_score != null ? sel.effort_score.toFixed(1) + '/7' : '—' },
                        ].map(({ label, value }) => (
                          <div key={label} className="p-2 rounded-xl bg-muted/5 border border-muted/20 text-center">
                            <p className="text-[9px] font-bold uppercase text-muted-foreground">{label}</p>
                            <p className="font-black text-sm text-on-surface">{value}</p>
                          </div>
                        ))}
                      </div>
                      {/* Extended signal strip */}
                      <div className="space-y-2 pt-1">
                        {/* Urgency */}
                        <div className="flex items-center justify-between px-2 py-1.5 rounded-lg bg-muted/5 border border-muted/20">
                          <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                            {t('advancedInsights.urgencyLabel')}
                          </span>
                          <span className="text-[11px] font-black" style={{ color: urgencyColor }}>
                            {urgencyLabel} {urgency > 0 ? `· ${urgency.toFixed(1)}` : ''}
                          </span>
                        </div>
                        {/* Sentiment momentum */}
                        {sel.sentiment_momentum && (
                          <div className="flex items-center justify-between px-2 py-1.5 rounded-lg bg-muted/5 border border-muted/20">
                            <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Sentiment</span>
                            <span className="text-[11px] font-black flex items-center gap-1" style={{
                              color: sel.sentiment_momentum === 'improving' ? '#059669' : sel.sentiment_momentum === 'worsening' ? '#b41340' : '#64748b',
                            }}>
                              <Icon name={sel.sentiment_momentum === 'improving' ? 'trending_up' : sel.sentiment_momentum === 'worsening' ? 'trending_down' : 'trending_flat'} size={13} />
                              {sel.sentiment_momentum === 'improving' ? t('advancedInsights.momentumImproving') : sel.sentiment_momentum === 'worsening' ? t('advancedInsights.momentumWorsening') : t('advancedInsights.momentumStable')}
                            </span>
                          </div>
                        )}
                        {/* Chronic warning */}
                        {sel.chronic && (
                          <div className="flex items-start gap-2 px-2 py-1.5 rounded-lg border"
                            style={{ background: '#fdf4ff', borderColor: '#e9d5ff' }}>
                            <Icon name="report_problem" size={13} style={{ color: '#9333ea', flexShrink: 0, marginTop: 1 }} />
                            <div>
                              <p className="text-[10px] font-black" style={{ color: '#7e22ce' }}>{t('advancedInsights.chronicLabel')}</p>
                              <p className="text-[9px]" style={{ color: '#9333ea' }}>{t('advancedInsights.chronicDesc')}</p>
                            </div>
                          </div>
                        )}
                      </div>

                      {/* NPS & Loyalty */}
                      {(sel.net_sentiment != null || sel.nps_impact != null || sel.promoter_pct != null) && (
                        <div className="space-y-1.5 pt-1">
                          <p className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground/70 px-1">
                            {t('advancedInsights.loyaltySection')}
                          </p>
                          {sel.net_sentiment != null && (
                            <div className="flex items-center justify-between px-2 py-1.5 rounded-lg bg-muted/5 border border-muted/20">
                              <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                                {t('advancedInsights.netSentimentLabel')}
                              </span>
                              {/* net_sentiment is already [-100, +100] — do NOT multiply by 100 */}
                              <span className="text-[11px] font-black" style={{
                                color: sel.net_sentiment > 10 ? '#059669' : sel.net_sentiment < -10 ? '#b41340' : '#64748b',
                              }}>
                                {sel.net_sentiment > 0 ? '+' : ''}{sel.net_sentiment.toFixed(0)}%
                              </span>
                            </div>
                          )}
                          {sel.nps_impact != null && (
                            <div className="flex items-center justify-between px-2 py-1.5 rounded-lg bg-muted/5 border border-muted/20">
                              <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                                {t('advancedInsights.npsImpactLabel')}
                              </span>
                              <span className="text-[11px] font-black" style={{
                                color: sel.nps_impact > 0 ? '#059669' : sel.nps_impact < 0 ? '#b41340' : '#64748b',
                              }}>
                                {sel.nps_impact > 0 ? '+' : ''}{sel.nps_impact.toFixed(1)} pts
                              </span>
                            </div>
                          )}
                          {sel.promoter_pct != null && sel.detractor_pct != null && (
                            <div className="px-2 py-2 rounded-lg bg-muted/5 border border-muted/20 space-y-1">
                              <div className="flex rounded-full overflow-hidden h-2">
                                <div style={{ width: `${sel.promoter_pct}%`, background: '#059669' }} />
                                <div style={{ width: `${sel.passive_pct ?? 0}%`, background: '#d1d5db' }} />
                                <div style={{ width: `${sel.detractor_pct}%`, background: '#b41340' }} />
                              </div>
                              <div className="flex justify-between">
                                <span className="text-[9px] font-bold" style={{ color: '#059669' }}>
                                  {t('advancedInsights.promoterLabel')} {sel.promoter_pct.toFixed(0)}%
                                </span>
                                <span className="text-[9px] font-bold" style={{ color: '#b41340' }}>
                                  {t('advancedInsights.detractorLabel')} {sel.detractor_pct.toFixed(0)}%
                                </span>
                              </div>
                            </div>
                          )}
                        </div>
                      )}

                      {/* CSAT & Effort */}
                      {(sel.avg_csat != null || sel.csat_impact != null || sel.avg_effort_score != null) && (
                        <div className="space-y-1.5 pt-1">
                          <p className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground/70 px-1">
                            {t('advancedInsights.csatSection')}
                          </p>
                          {sel.avg_csat != null && (
                            <div className="flex items-center justify-between px-2 py-1.5 rounded-lg bg-muted/5 border border-muted/20">
                              <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">CSAT</span>
                              <span className="text-[11px] font-black text-on-surface">{sel.avg_csat.toFixed(1)}/5</span>
                            </div>
                          )}
                          {sel.csat_impact != null && (
                            <div className="flex items-center justify-between px-2 py-1.5 rounded-lg bg-muted/5 border border-muted/20">
                              <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                                {t('advancedInsights.csatImpactLabel')}
                              </span>
                              <span className="text-[11px] font-black" style={{
                                color: sel.csat_impact > 0 ? '#059669' : sel.csat_impact < 0 ? '#b41340' : '#64748b',
                              }}>
                                {sel.csat_impact > 0 ? '+' : ''}{sel.csat_impact.toFixed(2)}
                              </span>
                            </div>
                          )}
                          {sel.avg_effort_score != null && (
                            <div className="flex items-center justify-between px-2 py-1.5 rounded-lg bg-muted/5 border border-muted/20">
                              <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                                {t('advancedInsights.avgEffortScoreLabel')}
                              </span>
                              <span className="text-[11px] font-black text-on-surface">{sel.avg_effort_score.toFixed(1)}/7</span>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Health & Confidence */}
                      {(sel.health_label != null || sel.confidence_level != null || sel.driver_score != null || sel.velocity_pct != null) && (
                        <div className="space-y-1.5 pt-1">
                          <p className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground/70 px-1">
                            {t('advancedInsights.healthSection')}
                          </p>
                          {sel.health_label && (() => {
                            const hColor = sel.health_label === 'healthy' ? '#059669' : sel.health_label === 'at-risk' ? '#b41340' : '#64748b';
                            const hLabel = sel.health_label === 'healthy' ? t('advancedInsights.healthHealthy')
                                         : sel.health_label === 'at-risk'  ? t('advancedInsights.healthAtRisk')
                                         : t('advancedInsights.healthStable');
                            return (
                              <div className="flex items-center justify-between px-2 py-1.5 rounded-lg bg-muted/5 border border-muted/20">
                                <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                                  {t('advancedInsights.healthLabel2')}
                                </span>
                                <span className="text-[11px] font-black" style={{ color: hColor }}>{hLabel}</span>
                              </div>
                            );
                          })()}
                          {sel.confidence_level && (() => {
                            const cColor = sel.confidence_level === 'high' ? '#059669' : sel.confidence_level === 'low' ? '#9ca3af' : '#d97706';
                            return (
                              <div className="flex items-center justify-between px-2 py-1.5 rounded-lg bg-muted/5 border border-muted/20">
                                <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                                  {t('advancedInsights.confidenceLabel')}
                                </span>
                                <span className="text-[11px] font-black capitalize" style={{ color: cColor }}>{sel.confidence_level}</span>
                              </div>
                            );
                          })()}
                          {sel.driver_score != null && (
                            <div className="flex items-center justify-between px-2 py-1.5 rounded-lg bg-muted/5 border border-muted/20">
                              <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                                {t('advancedInsights.driverScoreLabel')}
                              </span>
                              <span className="text-[11px] font-black" style={{
                                color: Math.abs(sel.driver_score) > 0.3 ? '#4f46e5' : '#64748b',
                              }}>
                                {sel.driver_score > 0 ? '+' : ''}{sel.driver_score.toFixed(2)}
                              </span>
                            </div>
                          )}
                          {sel.velocity_pct != null && (
                            <div className="flex items-center justify-between px-2 py-1.5 rounded-lg bg-muted/5 border border-muted/20">
                              <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                                {t('advancedInsights.velocityLabel')}
                              </span>
                              <span className="text-[11px] font-black flex items-center gap-1" style={{
                                color: sel.velocity_pct > 0 ? '#059669' : sel.velocity_pct < 0 ? '#b41340' : '#64748b',
                              }}>
                                <Icon name={sel.velocity_pct > 0 ? 'trending_up' : sel.velocity_pct < 0 ? 'trending_down' : 'trending_flat'} size={12} />
                                {sel.velocity_pct > 0 ? '+' : ''}{sel.velocity_pct.toFixed(0)}%
                              </span>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Emotion mix */}
                      {sel.emotion_distribution && Object.keys(sel.emotion_distribution).length > 0 && (
                        <div className="space-y-1.5 pt-1">
                          <p className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground/70 px-1">
                            {t('advancedInsights.emotionMixLabel')}
                          </p>
                          <div className="flex flex-wrap gap-1 px-1">
                            {Object.entries(sel.emotion_distribution)
                              .sort((a, b) => b[1] - a[1])
                              .slice(0, 5)
                              .map(([emotion, count]) => (
                                <span key={emotion} className="px-2 py-0.5 rounded-full text-[9px] font-bold bg-muted/10 border border-muted/20 text-muted-foreground capitalize">
                                  {emotion} <span className="opacity-60">{count}</span>
                                </span>
                              ))}
                          </div>
                        </div>
                      )}

                      {/* Top verbatims */}
                      {sel.top_verbatims && sel.top_verbatims.length > 0 && (
                        <div className="space-y-1.5 pt-1">
                          <p className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground/70 px-1">
                            {t('advancedInsights.topVerbatimsLabel')}
                          </p>
                          <div className="space-y-1.5 px-1">
                            {sel.top_verbatims.slice(0, 3).map((v, i) => (
                              <p key={i} className="text-[9px] text-muted-foreground leading-relaxed border-l-2 border-muted/30 pl-2 italic">
                                &ldquo;{v}&rdquo;
                              </p>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })()}

                <div className="space-y-4">
                  <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">{t('advancedInsights.globalActions')}</p>
                  <div className="grid gap-3">
                    <Button
                      variant="outline"
                      className="w-full vr-button border py-3 px-4 rounded-xl flex items-center gap-3 font-bold text-sm bg-white justify-start border-border text-foreground"
                      title={t('advancedInsights.globalActionMergeComingSoon')}
                      onClick={() => alert(t('advancedInsights.globalActionMergeComingSoon'))}
                    >
                      <Icon name="merge" size={18} style={{ color: '#4f46e5' }} />
                      {t('advancedInsights.globalActionMerge')}
                    </Button>
                    <Button
                      variant="outline"
                      className="w-full vr-button border py-3 px-4 rounded-xl flex items-center gap-3 font-bold text-sm bg-white justify-start border-border text-foreground"
                      disabled={!selectedId}
                      onClick={async () => {
                        const sel = topics.find(topic => topic.id === selectedId);
                        if (!sel || !activeSurvey?.id) return;
                        const newName = prompt(t('advancedInsights.globalActionRenamePrompt'), sel.name);
                        if (!newName || !newName.trim() || newName.trim() === sel.name) return;
                        try {
                          await api.renameTopic(activeSurvey.id, sel.id, newName.trim());
                          await loadTopics();
                        } catch {
                          alert('Failed to rename topic. Please try again.');
                        }
                      }}
                    >
                      <Icon name="edit" size={18} style={{ color: '#4f46e5' }} />
                      {t('advancedInsights.globalActionRename')}
                    </Button>
                    <Button
                      className="w-full vr-button py-4 px-4 rounded-xl flex items-center justify-center gap-3 font-bold text-sm text-white"
                      style={{ background: '#4f46e5', boxShadow: '0 10px 20px rgba(79,70,229,0.2)' }}
                      title={t('advancedInsights.globalActionGroupComingSoon')}
                      onClick={() => alert(t('advancedInsights.globalActionGroupComingSoon'))}
                    >
                      <Icon name="folder_shared" size={18} />
                      {t('advancedInsights.globalActionGroup')}
                    </Button>
                  </div>
                </div>
              </div>
            </Card>
          </div>
        </section>
      )}

      {/* Crystal Panel is mounted globally in AppShell; scope + topics injected via context */}

      </>}
    </div>
  );
}
