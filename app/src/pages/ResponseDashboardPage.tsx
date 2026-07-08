import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useCrystalPanel } from '../contexts/crystalPanel';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { Icon } from '../components/Icon';
import { useSetPageTitle } from '../contexts/pageTitle';
import { ROUTES, toPath } from '../constants/routes';
import { useTranslation } from '../lib/i18n';
import { useApi } from '../hooks/useApi';
import { PageHeader } from '../components/PageHeader';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Spinner } from '../components/LoadingStates';
import { ReportExportMenu } from '../components/ReportExportMenu';
import type { Survey, SurveyTopic } from '../types';

type DayPoint = { day: string; count: number };
type NpsDist = { promoters: number; passives: number; detractors: number };

interface Analytics {
  total_responses:  number;
  avg_nps:          number | null;
  completion_rate:  number;
  nps_distribution: NpsDist;
  responses_by_day: DayPoint[];
}

function npsLabel(score: number | null, t: (k: string) => string): string {
  if (score == null) return '—';
  if (score >= 50) return t('responseDashboard.npsExcellent');
  if (score >= 0)  return t('responseDashboard.npsFair');
  return t('responseDashboard.npsLow');
}

function npsDashOffset(score: number | null): string {
  if (score == null) return '251.2';
  // Map -100..100 to 0..251.2 arc fill
  const pct = Math.min(Math.max((score + 100) / 200, 0), 1);
  return String(Math.round(251.2 * (1 - pct)));
}

function trendPct(series: DayPoint[]): number | null {
  if (series.length < 2) return null;
  const last7  = series.slice(-7).reduce((s, d) => s + d.count, 0);
  const prev7  = series.slice(-14, -7).reduce((s, d) => s + d.count, 0);
  if (prev7 === 0) return last7 > 0 ? 100 : null;
  return Math.round(((last7 - prev7) / prev7) * 100);
}

function formatDay(iso: string): string {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function ResponseDashboardPage() {
  const { t } = useTranslation();
  const api = useApi();
  const { surveyId } = useParams<{ surveyId: string }>();
  const { openCrystal } = useCrystalPanel();
  useSetPageTitle(t('responseDashboard.pageTitle'), t('responseDashboard.dateFilter'));

  const [survey,    setSurvey]    = useState<Survey | null>(null);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [topics,    setTopics]    = useState<SurveyTopic[]>([]);
  const [loading,   setLoading]   = useState(true);

  useEffect(() => {
    if (!surveyId) return;
    setLoading(true);
    Promise.all([
      api.getSurvey(surveyId).then(d => setSurvey(d.survey)).catch(() => {}),
      api.getSurveyAnalytics(surveyId).then(setAnalytics).catch(() => {}),
      api.listTopics(surveyId).then(d => setTopics(d.topics ?? [])).catch(() => {}),
    ]).finally(() => setLoading(false));
  }, [api, surveyId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner size={32} />
      </div>
    );
  }

  const total     = analytics?.total_responses ?? 0;
  const avgNps    = analytics?.avg_nps ?? null;
  const dist      = analytics?.nps_distribution ?? { promoters: 0, passives: 0, detractors: 0 };
  const series    = analytics?.responses_by_day ?? [];
  const trend     = trendPct(series);
  const questions = (survey?.questions as Array<{ id: string; type: string; question: string }> | null) ?? [];

  // Derive sentiment breakdown from NPS distribution
  const npsTotal = dist.promoters + dist.passives + dist.detractors;
  const sentimentBars = npsTotal > 0
    ? [
        { label: t('responseDashboard.sentimentLabels.positive'), pct: Math.round((dist.promoters  / npsTotal) * 100), color: 'linear-gradient(to top, var(--color-primary), var(--color-primary-container))' },
        { label: t('responseDashboard.sentimentLabels.neutral'),  pct: Math.round((dist.passives   / npsTotal) * 100), color: 'linear-gradient(to top, #94a3b8, #cbd5e1)' },
        { label: t('responseDashboard.sentimentLabels.negative'), pct: Math.round((dist.detractors / npsTotal) * 100), color: 'linear-gradient(to top, #b41340, #f74b6d)' },
      ]
    : [
        { label: t('responseDashboard.sentimentLabels.positive'), pct: 0, color: 'linear-gradient(to top, var(--color-primary), var(--color-primary-container))' },
        { label: t('responseDashboard.sentimentLabels.neutral'),  pct: 0, color: 'linear-gradient(to top, #94a3b8, #cbd5e1)' },
        { label: t('responseDashboard.sentimentLabels.negative'), pct: 0, color: 'linear-gradient(to top, #b41340, #f74b6d)' },
      ];

  const crumbs = [
    { label: t('nav.surveys'), icon: 'poll', path: ROUTES.SURVEYS },
    ...(survey ? [{ label: survey.title, path: toPath(ROUTES.RESPONSE_DASHBOARD, { surveyId: survey.id }) }] : []),
    { label: t('responseDashboard.pageTitle') },
  ];

  // ── Empty state ───────────────────────────────────────────────────────────────
  if (total === 0) {
    return (
      <div className="space-y-8 max-w-7xl mx-auto w-full">
        <PageHeader crumbs={crumbs} title={t('responseDashboard.pageTitle')} subtitle={t('responseDashboard.dateFilter')} />
        <div className="flex flex-col items-center justify-center py-32 text-center gap-4">
          <div className="p-5 rounded-2xl bg-primary/10 text-primary mb-2">
            <Icon name="bar_chart" fill={1} size={48} />
          </div>
          <h3 className="text-2xl font-bold font-headline text-on-surface">{t('responseDashboard.noResponses.heading')}</h3>
          <p className="text-on-surface-variant max-w-sm">{t('responseDashboard.noResponses.description')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8 max-w-7xl mx-auto w-full">
      <PageHeader
        crumbs={crumbs}
        title={t('responseDashboard.pageTitle')}
        subtitle={t('responseDashboard.dateFilter')}
        actions={surveyId ? <ReportExportMenu surveyId={surveyId} surveyTitle={survey?.title} /> : undefined}
      />

      {/* Top Metrics */}
      <section className="grid grid-cols-1 md:grid-cols-3 gap-6">

        {/* Total Responses */}
        <Card className="p-8 relative overflow-hidden group bg-white border-muted/10" style={{ borderRadius: '1rem', boxShadow: '0 4px 12px rgba(0,0,0,0.04)' }}>
          <div className="relative z-10">
            <p className="font-medium text-sm text-on-surface-variant">{t('responseDashboard.totalResponses')}</p>
            <h3 className="text-4xl font-black mt-2 font-headline text-on-surface">
              {total.toLocaleString()}
            </h3>
            {trend != null && (
              <div className={`flex items-center gap-1 mt-4 font-bold text-sm ${trend >= 0 ? 'text-success' : 'text-destructive'}`}>
                <Icon name={trend >= 0 ? 'trending_up' : 'trending_down'} size={16} />
                <span>{trend >= 0 ? '+' : ''}{trend}% vs prior 7 days</span>
              </div>
            )}
          </div>
          <div className="absolute -right-4 -bottom-4 opacity-5 group-hover:scale-110 transition-transform duration-500 text-on-surface">
            <Icon name="groups" fill={1} size={120} />
          </div>
        </Card>

        {/* NPS Distribution */}
        <Card className="p-8 relative overflow-hidden bg-white border-muted/10" style={{ borderRadius: '1rem', boxShadow: '0 4px 12px rgba(0,0,0,0.04)' }}>
          <div className="relative z-10">
            <p className="font-medium text-sm text-on-surface-variant">{t('responseDashboard.completionRate')}</p>
            <div className="mt-4 space-y-3">
              {[
                { label: t('responseDashboard.promoters'),  count: dist.promoters,  color: 'var(--color-primary)' },
                { label: t('responseDashboard.passives'),   count: dist.passives,   color: '#94a3b8' },
                { label: t('responseDashboard.detractors'), count: dist.detractors, color: '#b41340' },
              ].map((row) => {
                const pct = npsTotal > 0 ? Math.round((row.count / npsTotal) * 100) : 0;
                return (
                  <div key={row.label}>
                    <div className="flex justify-between text-xs mb-1">
                      <span className="font-medium text-on-surface">{row.label}</span>
                      <span className="font-bold text-on-surface-variant">{pct}%</span>
                    </div>
                    <Progress value={pct} className="h-1.5" style={{ '--progress-color': row.color } as React.CSSProperties} />
                  </div>
                );
              })}
            </div>
          </div>
        </Card>

        {/* NPS Gauge */}
        <Card
          className="p-8 relative overflow-hidden text-white flex flex-col justify-center items-center border-0"
          style={{ background: 'linear-gradient(135deg, #1e2b7a, #0f172a)', borderRadius: '1rem', boxShadow: '0 20px 40px -10px rgba(30,43,122,0.4)' }}
        >
          <div className="relative z-10 text-center">
            <p className="font-bold text-xs uppercase tracking-widest mb-2 text-indigo-300">{t('responseDashboard.npsTitle')}</p>
            <div className="relative inline-block">
              <svg className="w-24 h-24 transform -rotate-90" viewBox="0 0 96 96">
                <circle cx="48" cy="48" r="40" fill="transparent" stroke="rgba(99,102,241,0.3)" strokeWidth="8" />
                <circle cx="48" cy="48" r="40" fill="transparent" stroke="var(--color-secondary-container)" strokeWidth="8"
                  strokeDasharray="251.2" strokeDashoffset={npsDashOffset(avgNps)} strokeLinecap="round" />
              </svg>
              <span className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-3xl font-black font-headline">
                {avgNps != null ? Math.round(avgNps) : '—'}
              </span>
            </div>
            <p className="mt-4 font-bold text-[var(--color-secondary-fixed)]">{npsLabel(avgNps, t)}</p>
            {surveyId && (
              <button
                onClick={() => openCrystal(
                  `What's driving our NPS of ${avgNps != null ? Math.round(avgNps) : '—'} on this survey? What should we focus on to improve it?`,
                  { focused_topic: topics[0]?.name },
                )}
                className="mt-3 text-[11px] font-bold px-3 py-1.5 rounded-full flex items-center gap-1.5 self-start text-white/70 hover:text-white border border-white/20 hover:bg-white/10 transition-all">
                <Icon name="psychology" size={13} />
                Ask Crystal
              </button>
            )}
          </div>
          <div className="absolute top-0 right-0 w-32 h-32 rounded-full" style={{ background: 'color-mix(in srgb, var(--color-primary) 20%, transparent)', filter: 'blur(60px)' }} />
        </Card>
      </section>

      {/* Time-series chart (3-6) */}
      {series.length > 0 && (
        <Card className="p-8 bg-white border-muted/10" style={{ borderRadius: '1rem', boxShadow: '0 4px 12px rgba(0,0,0,0.04)' }}>
          <div className="flex items-center justify-between mb-6">
            <h4 className="text-lg font-bold font-headline text-on-surface">{t('responseDashboard.trend')}</h4>
            {surveyId && trend != null && (
              <button
                onClick={() => openCrystal(
                  `Response volume ${trend >= 0 ? 'increased' : 'decreased'} by ${Math.abs(trend)}% vs. prior week. Why might that be? What does the trend mean for this survey?`,
                )}
                className="text-[11px] font-bold px-3 py-1.5 rounded-full flex items-center gap-1 border border-muted/30 text-on-surface-variant hover:border-primary/30 hover:text-primary transition-all">
                <Icon name="psychology" size={13} />
                Ask Crystal
              </button>
            )}
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={series.map(d => ({ ...d, label: formatDay(d.day) }))} margin={{ top: 5, right: 16, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="responseGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="var(--color-primary)" stopOpacity={0.25} />
                  <stop offset="95%" stopColor="var(--color-primary)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.05)" />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
              <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} width={28} />
              <Tooltip
                contentStyle={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: '8px', fontSize: 12 }}
                formatter={(v) => [v, 'Responses']}
              />
              <Area type="monotone" dataKey="count" stroke="var(--color-primary)" strokeWidth={2} fill="url(#responseGrad)" dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        </Card>
      )}

      {/* Topics + Sentiment */}
      <section className="grid grid-cols-1 lg:grid-cols-5 gap-8">

        {/* Topics / AI Insights */}
        <Card className="lg:col-span-3 p-8 relative overflow-hidden bg-white border-muted/10" style={{ borderRadius: '1rem', boxShadow: '0 4px 12px rgba(0,0,0,0.04)' }}>
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-xl text-tertiary bg-tertiary/10">
                <Icon name="auto_awesome" fill={1} size={20} />
              </div>
              <h4 className="text-xl font-bold font-headline text-on-surface">{t('responseDashboard.topTopics')}</h4>
            </div>
            {topics.length > 0 && surveyId && (
              <Link to={toPath(ROUTES.ADVANCED_INSIGHTS, {})} className="text-xs font-semibold text-primary hover:underline">
                {t('responseDashboard.viewFullAnalysis')}
              </Link>
            )}
          </div>

          {topics.length > 0 ? (
            <div className="space-y-3">
              {topics.slice(0, 6).map((topic) => {
                const sent = topic.sentiment_score ?? 0;
                const sentColor = sent > 0.1 ? '#059669' : sent < -0.1 ? '#b41340' : '#94a3b8';
                const sentBg    = sent > 0.1 ? '#ecfdf5' : sent < -0.1 ? '#fff1f2' : '#f1f5f9';
                const sentLabel = sent > 0.1 ? t('responseDashboard.topicSentimentPos') : sent < -0.1 ? t('responseDashboard.topicSentimentNeg') : t('responseDashboard.topicSentimentNeu');
                const effortPct = topic.effort_score != null ? Math.round(((topic.effort_score - 1) / 6) * 100) : null;
                const effortColor = topic.effort_score != null
                  ? topic.effort_score <= 2.5 ? '#059669' : topic.effort_score <= 4.5 ? '#d97706' : '#b41340'
                  : '#94a3b8';
                const npsAvg = topic.nps_avg ?? null;
                return (
                  <div key={topic.id ?? topic.name}
                    className="rounded-xl p-3 border border-muted/10 hover:border-primary/20 hover:bg-muted/5 transition-all group">
                    <div className="flex items-center gap-2 mb-2">
                      {/* Trending icon */}
                      {topic.trending === 'up' && (
                        <Icon name="trending_up" size={14}
                          style={{ color: sent < -0.1 ? '#b41340' : '#059669', flexShrink: 0 }} />
                      )}
                      {topic.trending === 'down' && (
                        <Icon name="trending_down" size={14} className="text-muted-foreground shrink-0" />
                      )}
                      {topic.trending === 'stable' && (
                        <Icon name="trending_flat" size={14} className="text-muted-foreground shrink-0" />
                      )}
                      <p className="font-semibold text-sm text-on-surface flex-1 truncate">{topic.name}</p>
                      {topic.is_new && (
                        <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full"
                          style={{ background: '#eef2ff', color: '#4f46e5' }}>
                          {t('responseDashboard.topicNew')}
                        </span>
                      )}
                      {/* Sentiment badge */}
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full shrink-0"
                        style={{ background: sentBg, color: sentColor }}>
                        {sentLabel}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-on-surface-variant mb-2">
                      <span>{topic.volume.toLocaleString()} mentions</span>
                      {topic.dominant_emotion && <span className="capitalize">{topic.dominant_emotion}</span>}
                      {npsAvg != null && (
                        <span style={{ color: npsAvg >= 50 ? '#059669' : npsAvg >= 0 ? '#d97706' : '#b41340', fontWeight: 700 }}>
                          {t('responseDashboard.topicNpsDelta')} {Math.round(npsAvg)}
                        </span>
                      )}
                    </div>
                    {/* Effort bar */}
                    {effortPct != null && (
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-on-surface-variant w-10 shrink-0">{t('responseDashboard.topicEffort')}</span>
                        <div className="flex-1 h-1 rounded-full bg-muted/30 overflow-hidden">
                          <div className="h-full rounded-full transition-all duration-500"
                            style={{ width: `${effortPct}%`, background: effortColor }} />
                        </div>
                        <span className="text-[10px] font-bold w-6 text-right" style={{ color: effortColor }}>
                          {topic.effort_score?.toFixed(1)}
                        </span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-10 text-center gap-3">
              <div className="p-3 rounded-xl bg-muted/20 text-muted-foreground">
                <Icon name="bubble_chart" fill={1} size={32} />
              </div>
              <p className="text-sm text-on-surface-variant">{t('responseDashboard.noTopicsYet')}</p>
              {surveyId && (
                <Link to={toPath(ROUTES.ADVANCED_INSIGHTS, {})}>
                  <Button variant="outline" size="sm">{t('responseDashboard.viewFullAnalysis')}</Button>
                </Link>
              )}
            </div>
          )}
        </Card>

        {/* Sentiment Chart */}
        <Card className="lg:col-span-2 p-8 relative flex flex-col justify-between overflow-hidden bg-surface-container-low border-0" style={{ borderRadius: '1rem' }}>
          <div>
            <h4 className="text-lg font-bold mb-1 font-headline text-on-surface">{t('responseDashboard.sentimentProfile')}</h4>
            <p className="text-sm mb-8 text-on-surface-variant">{t('responseDashboard.sentimentDistribution')}</p>
          </div>
          <div className="flex items-end justify-between gap-4 h-48 px-4 relative">
            {sentimentBars.map((bar) => (
              <div key={bar.label} className="group relative flex-1">
                <div className="absolute -top-10 left-1/2 -translate-x-1/2 text-white text-[10px] px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity bg-slate-800">
                  {bar.pct}%
                </div>
                <div className="w-full rounded-t-xl transition-all duration-300 group-hover:scale-y-105 group-hover:brightness-110"
                  style={{ height: `${Math.max(bar.pct, 4)}%`, background: bar.color }} />
                <p className="text-[10px] font-bold text-center mt-3 uppercase tracking-tighter text-on-surface-variant">{bar.label}</p>
              </div>
            ))}
          </div>
        </Card>
      </section>

      {/* Questions Table */}
      {questions.length > 0 && (
        <Card className="overflow-hidden bg-white border-muted/10" style={{ borderRadius: '1rem', boxShadow: '0 4px 12px rgba(0,0,0,0.04)' }}>
          <div className="p-6 flex justify-between items-center border-b border-muted/20">
            <h4 className="text-xl font-bold font-headline text-on-surface">{t('responseDashboard.questionPerformance')}</h4>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead className="bg-muted/5">
                <tr>
                  {[t('responseDashboard.tableHeaders.questionTitle'), t('responseDashboard.tableHeaders.type')].map((h) => (
                    <th key={h} className="px-6 py-4 text-[11px] font-bold uppercase tracking-widest text-on-surface-variant">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {questions.map((q) => (
                  <tr key={q.id} className="group transition-colors border-t border-muted/10 hover:bg-muted/5">
                    <td className="px-6 py-5">
                      <p className="font-semibold text-on-surface">{q.question}</p>
                    </td>
                    <td className="px-6 py-5">
                      <Badge variant="secondary" className="text-[11px] font-bold rounded-full capitalize">
                        {q.type?.replace(/_/g, ' ')}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
