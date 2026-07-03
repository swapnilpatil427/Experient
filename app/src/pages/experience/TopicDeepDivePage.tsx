// TopicDeepDivePage — Deep-dive into a single topic.
//
// Data sources (all real — no hardcoding):
//   • api.getTopicDetail()    → topic stats + trend_series + co_occurring + subtopics
//   • api.getTopicVerbatims() → paginated verbatim quotes (separate endpoint)
// Crystal is accessible scoped to this exact topic.

import { useEffect, useState, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  AreaChart, Area, LineChart, Line, ComposedChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip as RechartsTip,
  ResponsiveContainer, ReferenceLine,
} from 'recharts';
import { useTranslation } from '../../lib/i18n';
import { useApi } from '../../hooks/useApi';
import { useSurveys } from '../../hooks/useSurveys';
import { useCrystalPanel } from '../../contexts/crystalPanel';
import { useSetPageTitle } from '../../contexts/pageTitle';
import { Icon } from '../../components/Icon';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { ROUTES, toPath } from '../../constants/routes';
import { GlassCard } from '../insights/shared';
import type { SurveyTopic, TopicVerbatim, TopicDetail } from '../../types';

const rise = {
  hidden:  { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.45, ease: [0.22, 1, 0.36, 1] as [number,number,number,number] } },
};

function sentimentColor(s: string | null | undefined) {
  if (s === 'positive') return '#059669';
  if (s === 'negative') return '#b41340';
  return '#94a3b8';
}
function sentimentBg(s: string | null | undefined) {
  if (s === 'positive') return '#d1fae5';
  if (s === 'negative') return '#fee2e2';
  return '#f1f5f9';
}

const SENTIMENT_FILTERS = [
  { value: '',         labelKey: 'experience.topicDetail.verbatims.filter.all' },
  { value: 'positive', labelKey: 'experience.topicDetail.verbatims.filter.positive' },
  { value: 'negative', labelKey: 'experience.topicDetail.verbatims.filter.negative' },
  { value: 'neutral',  labelKey: 'experience.topicDetail.verbatims.filter.neutral' },
];

export function TopicDeepDivePage() {
  const { surveyId, topicId } = useParams<{ surveyId: string; topicId: string }>();
  const { t }                  = useTranslation();
  const api                    = useApi();
  const { surveys }            = useSurveys();
  const { openCrystal, setScope, setCrystalCtx } = useCrystalPanel();

  const survey = surveys.find((s) => s.id === surveyId);

  const [topic,        setTopic]        = useState<SurveyTopic | null>(null);
  const [detail,       setDetail]       = useState<TopicDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(true);

  const [verbatims,       setVerbatims]       = useState<TopicVerbatim[]>([]);
  const [verbatimsTotal,  setVerbatimsTotal]  = useState(0);
  const [verbatimsLoading, setVerbatimsLoading] = useState(false);
  const [hasMore,         setHasMore]         = useState(false);
  const [sentFilter,      setSentFilter]      = useState('');
  const [npsFilter,       setNpsFilter]       = useState('');  // 'promoter'|'passive'|'detractor'|''
  const [offset,          setOffset]          = useState(0);
  const PAGE = 10;

  useSetPageTitle(
    topic?.name ?? t('insights.topics.title'),
    survey?.title ?? t('nav.experience'),
  );

  // Scope Crystal to this survey on mount; pass topic context when we have it
  useEffect(() => {
    if (surveyId) setScope(surveyId);
    return () => setScope('all');
  }, [surveyId, setScope]);

  useEffect(() => {
    if (topic?.name) setCrystalCtx({ focused_topic: topic.name });
    return () => setCrystalCtx({});
  }, [topic?.name, setCrystalCtx]);

  // Load topic detail — coerce all Postgres NUMERIC columns to JS numbers.
  // pg returns NUMERIC as strings; .toFixed() / arithmetic will crash without this.
  useEffect(() => {
    if (!surveyId || !topicId) return;
    setDetailLoading(true);
    api.getTopicDetail(surveyId, topicId)
      .then((r) => {
        const n = (v: unknown) => (v == null ? null : Number(v));
        const topic = r.topic ? {
          ...r.topic,
          sentiment_score:    n(r.topic.sentiment_score),
          effort_score:       n(r.topic.effort_score),
          nps_impact:         n(r.topic.nps_impact),
          nps_avg:            n(r.topic.nps_avg),
          urgency_score:      n(r.topic.urgency_score),
          volume:             r.topic.volume != null ? Number(r.topic.volume) : null,
          volume_delta_pct:   n(r.topic.volume_delta_pct),
          positive_pct:       n(r.topic.positive_pct),
          negative_pct:       n(r.topic.negative_pct),
          neutral_pct:        n(r.topic.neutral_pct),
          promoter_pct:       n(r.topic.promoter_pct),
          detractor_pct:      n(r.topic.detractor_pct),
          passive_pct:        n(r.topic.passive_pct),
          net_sentiment:      n(r.topic.net_sentiment),
          nps_correlation:    n(r.topic.nps_correlation),
          csat_impact:        n(r.topic.csat_impact),
          avg_csat:           n(r.topic.avg_csat),
          avg_effort_score:   n(r.topic.avg_effort_score),
          driver_score:       n(r.topic.driver_score),
          velocity_pct:       n(r.topic.velocity_pct),
        } : null;
        // Coerce sub-topic numeric fields too
        const detail = r.detail ? {
          ...r.detail,
          subtopics: (r.detail.subtopics ?? []).map((s: any) => ({
            ...s,
            sentiment_score: n(s.sentiment_score),
            effort_score:    n(s.effort_score),
            volume:          s.volume != null ? Number(s.volume) : null,
          })),
        } : null;
        setTopic(topic as any);
        setDetail(detail as any);
      })
      .catch(() => {})
      .finally(() => setDetailLoading(false));
  }, [api, surveyId, topicId]);

  // Load verbatims — passes both sentiment and nps_bucket filters
  const loadVerbatims = useCallback(async (off: number, sentiment: string, nps: string) => {
    if (!surveyId || !topicId) return;
    setVerbatimsLoading(true);
    try {
      const r = await api.getTopicVerbatims(surveyId, topicId, {
        limit:      PAGE,
        offset:     off,
        sentiment:  sentiment  || undefined,
        nps_bucket: nps        || undefined,
      });
      setVerbatims((prev) => off === 0 ? r.verbatims : [...prev, ...r.verbatims]);
      setVerbatimsTotal(r.total);
      setHasMore(r.has_more);
    } catch {
      setVerbatims([]);
    } finally {
      setVerbatimsLoading(false);
    }
  }, [api, surveyId, topicId]);

  useEffect(() => {
    setOffset(0);
    setVerbatims([]);
    loadVerbatims(0, sentFilter, npsFilter);
  }, [loadVerbatims, sentFilter, npsFilter]);

  const loadMore = () => {
    const next = offset + PAGE;
    setOffset(next);
    loadVerbatims(next, sentFilter, npsFilter);
    // loadVerbatims already called above with correct filters
  };

  const askCrystal = () => {
    if (surveyId) setScope(surveyId);
    openCrystal(
      t('experience.topicDetail.query.topic', { name: topic?.name ?? t('nav.experience') }),
      { focused_topic: topic?.name },
    );
  };

  if (detailLoading) {
    return (
      <div className="max-w-4xl mx-auto w-full space-y-4">
        <div className="h-10 rounded-full bg-surface-container animate-pulse w-2/3" />
        <div className="h-32 rounded-2xl bg-surface-container animate-pulse" />
        <div className="space-y-2">
          {[...Array(4)].map((_, i) => <div key={i} className="h-16 rounded-xl bg-surface-container animate-pulse" />)}
        </div>
      </div>
    );
  }

  if (!topic) {
    return (
      <div className="max-w-4xl mx-auto w-full">
        <GlassCard className="p-12 text-center">
          <Icon name="search_off" size={32} style={{ color: 'var(--color-outline-variant)', margin: '0 auto 12px' }} />
          <p className="font-bold text-on-surface mb-1">{t('experience.topicDetail.notFound.title')}</p>
          <p className="text-sm text-on-surface-variant mb-5">
            {t('experience.topicDetail.notFound.body')}
          </p>
          <div className="flex items-center justify-center gap-3 flex-wrap">
            {surveyId && (
              <Link to={toPath(ROUTES.EXPERIENCE_SURVEY_TOPICS, { surveyId })}>
                <Button variant="outline" size="sm">{t('experience.topicDetail.notFound.backTopics')}</Button>
              </Link>
            )}
            <Link to={ROUTES.EXPERIENCE}>
              <Button variant="outline" size="sm">{t('experience.topicDetail.notFound.backHub')}</Button>
            </Link>
          </div>
        </GlassCard>
      </div>
    );
  }

  const sentScore    = topic.sentiment_score;
  const sentLabel    = sentScore == null ? '—' : sentScore > 0.3 ? t('experience.common.sentiment.positive') : sentScore < -0.3 ? t('experience.common.sentiment.critical') : t('experience.common.sentiment.mixed');
  const sentColor    = sentScore == null ? '#94a3b8' : sentScore > 0.3 ? '#059669' : sentScore < -0.3 ? '#b41340' : '#d97706';
  const subtopics    = detail?.subtopics ?? [];
  const coOccurring  = detail?.co_occurring ?? [];

  return (
    <TooltipProvider delayDuration={300}>
    {/* pt-6 fills the gap that PageHeader normally provides — AppShell only adds horizontal gutters */}
    <div className="max-w-4xl mx-auto w-full space-y-5 pt-6 md:pt-8">

      {/* ── Sub-nav ─────────────────────────────────────────────────────────── */}
      {surveyId && (
        <div className="flex items-center gap-1 flex-wrap">
          {[
            { label: t('experience.topicDetail.nav.intelligence'), icon: 'auto_awesome', path: toPath(ROUTES.EXPERIENCE_SURVEY, { surveyId }) },
            { label: t('experience.topicDetail.nav.topics'),       icon: 'hub',          path: toPath(ROUTES.EXPERIENCE_SURVEY_TOPICS, { surveyId }), active: true },
            { label: t('experience.topicDetail.nav.advanced'),     icon: 'analytics',    path: `${ROUTES.ADVANCED_INSIGHTS}?survey=${surveyId}` },
            { label: t('experience.topicDetail.nav.trends'),       icon: 'timeline',     path: toPath(ROUTES.EXPERIENCE_SURVEY_TRENDS, { surveyId }) },
          ].map((item) => (
            <Link key={item.label} to={item.path}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold transition-all"
              style={item.active ? {
                background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))',
                color: 'white', boxShadow: '0 2px 8px color-mix(in srgb, var(--color-primary) 30%, transparent)',
              } : { background: 'var(--color-surface-container)', color: 'var(--color-on-surface-variant)' }}
            >
              <Icon name={item.icon} size={13} />{item.label}
            </Link>
          ))}
          <div className="flex-1" />
          <Button size="sm" onClick={askCrystal}
            className="text-xs font-bold text-white border-0"
            style={{ background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))' }}>
            <Icon name="psychology" size={13} /> {t('experience.topicDetail.ask')}
          </Button>
        </div>
      )}

      {/* ── Topic hero card ─────────────────────────────────────────────────── */}
      <motion.div initial="hidden" animate="visible" variants={rise}>
        <GlassCard className="p-6">
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 rounded-2xl flex items-center justify-center flex-shrink-0"
              style={{ background: `${sentColor}18` }}>
              <Icon name="hub" size={24} style={{ color: sentColor }} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-3 flex-wrap mb-1">
                <h1 className="font-headline font-black text-2xl">{topic.name}</h1>
                <span className="px-2.5 py-0.5 rounded-full text-xs font-bold"
                  style={{ background: `${sentColor}18`, color: sentColor }}>
                  {sentLabel}
                </span>
                {topic.trending && topic.trending !== 'stable' && (
                  <span className="flex items-center gap-1 text-xs font-bold"
                    style={{ color: topic.trending === 'up' ? '#d97706' : '#64748b' }}>
                    <Icon name={topic.trending === 'up' ? 'trending_up' : 'trending_down'} size={14} />
                    {topic.trending}
                  </span>
                )}
                {topic.chronic && (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-black"
                    style={{ background: '#fdf4ff', color: '#9333ea' }}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span>{t('experience.topicDetail.chronic.label')}</span>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-xs max-w-[200px]">
                        {t('experience.topicDetail.chronic.tooltip')}
                      </TooltipContent>
                    </Tooltip>
                  </span>
                )}
              </div>

              {/* Stat row — primary signals */}
              <div className="flex items-center gap-4 text-sm text-on-surface-variant flex-wrap">
                <span className="flex items-center gap-1">
                  <Icon name="chat_bubble_outline" size={14} />
                  <strong className="text-on-surface">{topic.volume?.toLocaleString() ?? '—'}</strong>
                  {t('insights.anomalyMentions')}
                  {topic.volume_delta_pct != null && topic.volume_delta_pct !== 0 && (
                    <span className="text-[10px] font-bold ml-0.5"
                      style={{ color: topic.volume_delta_pct > 0 ? '#d97706' : '#059669' }}>
                      {topic.volume_delta_pct > 0 ? '↑' : '↓'}{Math.abs(topic.volume_delta_pct).toFixed(0)}%
                    </span>
                  )}
                </span>
                {topic.nps_impact != null && (
                  <span className="flex items-center gap-1">
                    <Icon name="trending_flat" size={14} />
                    <strong style={{ color: topic.nps_impact > 0 ? '#059669' : '#b41340' }}>
                      {topic.nps_impact > 0 ? '+' : ''}{topic.nps_impact.toFixed(1)}
                    </strong>
                    {t('experience.topicDetail.hero.npsImpactSuffix')}
                  </span>
                )}
                {topic.effort_score != null && (
                  <span className="flex items-center gap-1">
                    <Icon name="speed" size={14} />
                    <strong className="text-on-surface"
                      style={{ color: topic.effort_score >= 5.5 ? '#b41340' : topic.effort_score >= 3.5 ? '#d97706' : '#059669' }}>
                      {topic.effort_score.toFixed(1)}/7
                    </strong>
                    {t('insights.anomalyEffort').replace('effort ', '')}
                  </span>
                )}
                {/* urgency_score [0-100]: show when >= 30% high-intensity emotion */}
                {topic.urgency_score != null && topic.urgency_score >= 30 && (
                  <span className="flex items-center gap-1">
                    <Icon name="priority_high" size={14} />
                    <strong className="text-on-surface"
                      style={{ color: topic.urgency_score >= 80 ? '#b91c1c' : topic.urgency_score >= 50 ? '#c2410c' : '#d97706' }}>
                      {t('experience.topics.signals.urgencyScore')}: {topic.urgency_score.toFixed(0)}%
                    </strong>
                  </span>
                )}
                {topic.sentiment_momentum && topic.sentiment_momentum !== 'stable' && (
                  <span className="flex items-center gap-1 text-xs font-bold"
                    style={{ color: topic.sentiment_momentum === 'improving' ? '#059669' : '#b41340' }}>
                    <Icon name={topic.sentiment_momentum === 'improving' ? 'arrow_upward' : 'arrow_downward'} size={12} />
                    {topic.sentiment_momentum === 'improving'
                      ? t('experience.topics.signals.improving')
                      : t('experience.topics.signals.worsening')}
                  </span>
                )}
              </div>

              {/* Ask Crystal inline — primary action on the hero card itself */}
              <div className="mt-4 pt-4 border-t border-outline-variant/20 flex items-center gap-2">
                <Button size="sm" onClick={askCrystal}
                  className="text-xs font-bold text-white border-0"
                  style={{ background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))' }}>
                  <Icon name="psychology" size={13} /> {t('experience.topicDetail.ask')}
                </Button>
                <span className="text-[11px] text-on-surface-variant/60">
                  {t('experience.topicDetail.askHint')}
                </span>
              </div>
            </div>
          </div>
        </GlassCard>
      </motion.div>

      {/* ── Signal Fingerprint — every available metric in organized groups ── */}
      {(() => {
        const hasLoyalty  = topic.nps_avg != null || topic.promoter_pct != null || topic.driver_score != null || topic.nps_correlation != null;
        const hasSent     = topic.positive_pct != null || topic.negative_pct != null || topic.neutral_pct != null || topic.net_sentiment != null;
        const hasEffort   = topic.avg_csat != null || topic.csat_impact != null || topic.avg_effort_score != null;
        const hasHealth   = topic.health_label != null || topic.confidence_level != null || topic.velocity_pct != null;
        const hasKeywords = (topic.aliases?.length ?? 0) > 0 || (topic.keyword_list?.length ?? 0) > 0;
        const hasEmotion  = topic.emotion_distribution && Object.keys(topic.emotion_distribution).length > 0;
        if (!hasLoyalty && !hasSent && !hasEffort && !hasHealth && !hasKeywords && !hasEmotion) return null;
        return (
          <motion.section initial="hidden" animate="visible" variants={rise}>
            <h2 className="text-[10px] font-black uppercase tracking-widest text-on-surface-variant mb-3">
              {t('experience.topicDetail.signals.sectionTitle')}
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">

              {/* NPS & Loyalty */}
              {hasLoyalty && (
                <GlassCard className="p-4">
                  <h3 className="text-[9px] font-black uppercase tracking-widest text-on-surface-variant mb-3">
                    {t('experience.topicDetail.signals.loyalty')}
                  </h3>
                  <div className="space-y-2.5">
                    {topic.nps_avg != null && (
                      <div className="flex justify-between items-center">
                        <span className="text-xs text-on-surface-variant">{t('experience.topicDetail.signals.npsAvg')}</span>
                        <span className="text-sm font-black"
                          style={{ color: topic.nps_avg >= 50 ? '#059669' : topic.nps_avg >= 0 ? '#d97706' : '#b41340' }}>
                          {topic.nps_avg > 0 ? '+' : ''}{topic.nps_avg.toFixed(0)}
                        </span>
                      </div>
                    )}
                    {topic.nps_impact != null && (
                      <div className="flex justify-between items-center">
                        <span className="text-xs text-on-surface-variant">{t('experience.topicDetail.hero.npsImpactSuffix')}</span>
                        <span className="text-sm font-black"
                          style={{ color: topic.nps_impact > 0 ? '#059669' : '#b41340' }}>
                          {topic.nps_impact > 0 ? '+' : ''}{topic.nps_impact.toFixed(1)} pts
                        </span>
                      </div>
                    )}
                    {topic.driver_score != null && (
                      <div className="flex justify-between items-center">
                        <span className="text-xs text-on-surface-variant">{t('experience.topicDetail.signals.driverScore')}</span>
                        <span className="text-sm font-black"
                          style={{ color: Math.abs(topic.driver_score) > 0.3 ? 'var(--color-primary)' : '#94a3b8' }}>
                          {topic.driver_score > 0 ? '+' : ''}{topic.driver_score.toFixed(2)}
                        </span>
                      </div>
                    )}
                    {topic.promoter_pct != null && (
                      <div className="space-y-1">
                        <div className="flex items-center justify-between text-[10px] text-on-surface-variant">
                          <span>{t('experience.topicDetail.signals.promoters')}</span>
                          <span>{t('experience.topicDetail.signals.passives')}</span>
                          <span>{t('experience.topicDetail.signals.detractors')}</span>
                        </div>
                        <div className="flex h-2 rounded-full overflow-hidden gap-px">
                          <div className="bg-emerald-500 transition-all" style={{ width: `${topic.promoter_pct ?? 0}%` }} />
                          <div className="bg-slate-300 transition-all"  style={{ width: `${topic.passive_pct ?? 0}%` }} />
                          <div className="bg-red-500 transition-all"    style={{ width: `${topic.detractor_pct ?? 0}%` }} />
                        </div>
                        <div className="flex items-center justify-between text-[9px] font-bold">
                          <span className="text-emerald-600">{(topic.promoter_pct ?? 0).toFixed(0)}%</span>
                          <span className="text-slate-400">{(topic.passive_pct ?? 0).toFixed(0)}%</span>
                          <span className="text-red-600">{(topic.detractor_pct ?? 0).toFixed(0)}%</span>
                        </div>
                      </div>
                    )}
                  </div>
                </GlassCard>
              )}

              {/* Sentiment breakdown */}
              {hasSent && (
                <GlassCard className="p-4">
                  <h3 className="text-[9px] font-black uppercase tracking-widest text-on-surface-variant mb-3">
                    {t('experience.topicDetail.signals.sentiment')}
                  </h3>
                  <div className="space-y-2.5">
                    {topic.net_sentiment != null && (
                      <div className="flex justify-between items-center">
                        <span className="text-xs text-on-surface-variant">{t('experience.topicDetail.signals.netSentiment')}</span>
                        {/* net_sentiment is already a percentage [-100, +100] — do NOT multiply by 100 */}
                        <span className="text-sm font-black"
                          style={{ color: topic.net_sentiment > 10 ? '#059669' : topic.net_sentiment < -10 ? '#b41340' : '#94a3b8' }}>
                          {topic.net_sentiment > 0 ? '+' : ''}{topic.net_sentiment.toFixed(0)}%
                        </span>
                      </div>
                    )}
                    {[
                      { pct: topic.positive_pct, label: t('experience.common.sentiment.positive'), color: '#059669', bg: '#dcfce7' },
                      { pct: topic.neutral_pct,  label: t('experience.common.sentiment.mixed'),    color: '#94a3b8', bg: '#f1f5f9' },
                      { pct: topic.negative_pct, label: t('experience.common.sentiment.critical'),  color: '#b41340', bg: '#fee2e2' },
                    ].map(({ pct, label, color, bg }) => pct != null ? (
                      <div key={label}>
                        <div className="flex justify-between text-[10px] mb-1">
                          <span className="font-bold" style={{ color }}>{label}</span>
                          <span className="font-mono text-on-surface-variant">{pct.toFixed(0)}%</span>
                        </div>
                        <div className="h-1.5 rounded-full bg-surface-container overflow-hidden">
                          <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color, opacity: 0.7 }} />
                        </div>
                      </div>
                    ) : null)}
                  </div>
                </GlassCard>
              )}

              {/* Effort & CSAT */}
              {hasEffort && (
                <GlassCard className="p-4">
                  <h3 className="text-[9px] font-black uppercase tracking-widest text-on-surface-variant mb-3">
                    {t('experience.topicDetail.signals.effort')}
                  </h3>
                  <div className="space-y-2.5">
                    {topic.effort_score != null && (
                      <div className="flex justify-between items-center">
                        <span className="text-xs text-on-surface-variant">{t('experience.topicDetail.hero.effort', { n: '' }).replace(' ', '')}</span>
                        <span className="text-sm font-black"
                          style={{ color: topic.effort_score >= 5.5 ? '#b41340' : topic.effort_score >= 3.5 ? '#d97706' : '#059669' }}>
                          {topic.effort_score.toFixed(1)}/7
                        </span>
                      </div>
                    )}
                    {topic.avg_effort_score != null && (
                      <div className="flex justify-between items-center">
                        <span className="text-xs text-on-surface-variant">{t('experience.topicDetail.signals.avgEffort')}</span>
                        <span className="text-sm font-black">{topic.avg_effort_score.toFixed(1)}/7</span>
                      </div>
                    )}
                    {topic.avg_csat != null && (
                      <div className="flex justify-between items-center">
                        <span className="text-xs text-on-surface-variant">{t('experience.topicDetail.signals.avgCsat')}</span>
                        <span className="text-sm font-black">{topic.avg_csat.toFixed(2)}</span>
                      </div>
                    )}
                    {topic.csat_impact != null && (
                      <div className="flex justify-between items-center">
                        <span className="text-xs text-on-surface-variant">{t('experience.topicDetail.signals.csatImpact')}</span>
                        <span className="text-sm font-black"
                          style={{ color: topic.csat_impact > 0 ? '#059669' : '#b41340' }}>
                          {topic.csat_impact > 0 ? '+' : ''}{topic.csat_impact.toFixed(2)}
                        </span>
                      </div>
                    )}
                  </div>
                </GlassCard>
              )}

              {/* Health & confidence */}
              {hasHealth && (
                <GlassCard className="p-4">
                  <h3 className="text-[9px] font-black uppercase tracking-widest text-on-surface-variant mb-3">
                    {t('experience.topicDetail.signals.healthSection')}
                  </h3>
                  <div className="space-y-2.5">
                    {topic.health_label && (
                      <div className="flex justify-between items-center">
                        <span className="text-xs text-on-surface-variant">{t('experience.topicDetail.signals.healthLabel')}</span>
                        <span className="text-xs font-black px-2 py-0.5 rounded-full capitalize"
                          style={{
                            background: topic.health_label === 'healthy' ? '#dcfce7' : topic.health_label === 'at-risk' ? '#fee2e2' : '#f1f5f9',
                            color:      topic.health_label === 'healthy' ? '#059669' : topic.health_label === 'at-risk' ? '#b41340' : '#64748b',
                          }}>
                          {({
                            'healthy': t('experience.topicDetail.signals.health.healthy'),
                            'at-risk': t('experience.topicDetail.signals.health.at-risk'),
                            'stable':  t('experience.topicDetail.signals.health.stable'),
                          } as Record<string, string>)[topic.health_label] ?? topic.health_label}
                        </span>
                      </div>
                    )}
                    {topic.confidence_level && (
                      <div className="flex justify-between items-center">
                        <span className="text-xs text-on-surface-variant">{t('experience.topicDetail.signals.confidenceLabel')}</span>
                        <span className="text-xs font-black capitalize"
                          style={{ color: topic.confidence_level === 'high' ? '#059669' : topic.confidence_level === 'low' ? '#94a3b8' : '#d97706' }}>
                          {({
                            'high':   t('experience.topicDetail.signals.confidence.high'),
                            'medium': t('experience.topicDetail.signals.confidence.medium'),
                            'low':    t('experience.topicDetail.signals.confidence.low'),
                          } as Record<string, string>)[topic.confidence_level!] ?? topic.confidence_level}
                        </span>
                      </div>
                    )}
                    {topic.velocity_pct != null && (
                      <div className="flex justify-between items-center">
                        <span className="text-xs text-on-surface-variant">{t('experience.topicDetail.signals.velocity')}</span>
                        <span className="text-sm font-black flex items-center gap-1"
                          style={{ color: topic.velocity_pct > 0 ? '#d97706' : '#059669' }}>
                          <Icon name={topic.velocity_pct > 0 ? 'trending_up' : 'trending_down'} size={12} />
                          {topic.velocity_pct > 0 ? '+' : ''}{topic.velocity_pct.toFixed(0)}%
                        </span>
                      </div>
                    )}
                    {topic.urgency_score != null && (
                      <div className="flex justify-between items-center">
                        <span className="text-xs text-on-surface-variant">{t('experience.topicDetail.signals.urgencyScore')}</span>
                        {/* urgency_score is [0, 100] — % of mentions with high-intensity emotion */}
                        <span className="text-sm font-black"
                          style={{ color: topic.urgency_score >= 80 ? '#b91c1c' : topic.urgency_score >= 50 ? '#c2410c' : topic.urgency_score >= 30 ? '#d97706' : '#94a3b8' }}>
                          {topic.urgency_score.toFixed(0)}%
                        </span>
                      </div>
                    )}
                    {(topic.first_seen_at || topic.last_seen_at) && (
                      <div className="space-y-1 pt-1 border-t border-outline-variant/15">
                        {topic.first_seen_at && (
                          <div className="flex justify-between text-[10px]">
                            <span className="text-on-surface-variant">{t('experience.topicDetail.signals.firstSeen')}</span>
                            <span className="font-mono text-on-surface-variant/70">
                              {new Date(topic.first_seen_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })}
                            </span>
                          </div>
                        )}
                        {topic.last_seen_at && (
                          <div className="flex justify-between text-[10px]">
                            <span className="text-on-surface-variant">{t('experience.topicDetail.signals.lastSeen')}</span>
                            <span className="font-mono text-on-surface-variant/70">
                              {new Date(topic.last_seen_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })}
                            </span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </GlassCard>
              )}

              {/* Emotion distribution */}
              {hasEmotion && (
                <GlassCard className="p-4">
                  <h3 className="text-[9px] font-black uppercase tracking-widest text-on-surface-variant mb-3">
                    {t('experience.topicDetail.signals.emotionTitle')}
                  </h3>
                  <div className="space-y-2">
                    {Object.entries(topic.emotion_distribution!)
                      .sort(([,a],[,b]) => b - a)
                      .slice(0, 5)
                      .map(([emotion, count]) => {
                        const maxCount = Math.max(...Object.values(topic.emotion_distribution!));
                        const pct = Math.round((count / maxCount) * 100);
                        return (
                          <div key={emotion}>
                            <div className="flex justify-between text-[10px] mb-0.5">
                              <span className="font-bold capitalize text-on-surface">{emotion}</span>
                              <span className="font-mono text-on-surface-variant/60">{count}</span>
                            </div>
                            <div className="h-1 rounded-full bg-surface-container overflow-hidden">
                              <div className="h-full rounded-full bg-primary/60" style={{ width: `${pct}%` }} />
                            </div>
                          </div>
                        );
                      })}
                  </div>
                </GlassCard>
              )}

              {/* Aliases & keywords */}
              {hasKeywords && (
                <GlassCard className="p-4">
                  <h3 className="text-[9px] font-black uppercase tracking-widest text-on-surface-variant mb-3">
                    {t('experience.topicDetail.signals.keywords')}
                  </h3>
                  <div className="flex flex-wrap gap-1.5">
                    {[...(topic.aliases ?? []), ...(topic.keyword_list ?? [])].slice(0, 20).map((kw) => (
                      <span key={kw} className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-surface-container text-on-surface-variant">
                        {kw}
                      </span>
                    ))}
                  </div>
                </GlassCard>
              )}
            </div>
          </motion.section>
        );
      })()}

      {/* ── Trend sparkline from detail.trend_series ─────────────────────────── */}
      {detail?.trend_series && detail.trend_series.length >= 3 && (
        <motion.section initial="hidden" animate="visible" variants={rise}>
          <h2 className="text-[10px] font-black uppercase tracking-widest text-on-surface-variant mb-3">
            {t('experience.topicDetail.signals.trendTitle')}
          </h2>
          <GlassCard className="p-4">
            <ResponsiveContainer width="100%" height={130}>
              <ComposedChart
                data={detail.trend_series.map((p) => ({
                  day:  new Date(p.day).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
                  vol:  p.volume,
                  nps:  p.avg_nps != null ? Math.round(p.avg_nps) : null,
                }))}
                margin={{ top: 6, right: 10, bottom: 0, left: 0 }}
              >
                <defs>
                  <linearGradient id="volGradTopic" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%"  stopColor="var(--color-primary)" stopOpacity={0.2} />
                    <stop offset="100%" stopColor="var(--color-primary)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="rgba(0,0,0,0.04)" strokeDasharray="3 3" />
                <XAxis dataKey="day" tick={{ fontSize: 10, fill: '#94a3b8' }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                <YAxis yAxisId="left"  tick={{ fontSize: 10, fill: '#94a3b8' }} axisLine={false} tickLine={false} width={24} />
                <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 10, fill: '#94a3b8' }} axisLine={false} tickLine={false} width={28} />
                <ReferenceLine yAxisId="right" y={0} stroke="rgba(0,0,0,0.12)" strokeDasharray="3 3" />
                <Area yAxisId="left"  type="monotone" dataKey="vol" stroke="var(--color-primary)" strokeWidth={2}
                  fill="url(#volGradTopic)" dot={false} name={t('experience.topicDetail.signals.volumeLabel')} />
                <Line yAxisId="right" type="monotone" dataKey="nps" stroke="#d97706" strokeWidth={2}
                  dot={false} strokeDasharray="4 3" name="NPS" />
                <RechartsTip
                  contentStyle={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: '8px', fontSize: 11 }}
                  formatter={(v, name) => {
                    const label = String(name ?? '');
                    return [
                      label === 'NPS' ? (v != null ? `${Number(v) > 0 ? '+' : ''}${v}` : '—') : String(v),
                      label,
                    ];
                  }}
                />
              </ComposedChart>
            </ResponsiveContainer>
            <p className="text-[9px] text-on-surface-variant/50 mt-2 text-center">
              {t('experience.topicDetail.signals.trendVolumeLeft')}
            </p>
          </GlassCard>
        </motion.section>
      )}

      {/* ── Subtopics ───────────────────────────────────────────────────────── */}
      {subtopics.length > 0 && (
        <motion.section initial="hidden" animate="visible" variants={rise}>
          <h2 className="text-[10px] font-black uppercase tracking-widest text-on-surface-variant mb-3">
            {t('experience.topicDetail.subtopics.title', { n: String(subtopics.length) })}
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            {subtopics.map((sub) => {
              const sc  = sub.sentiment_score;
              const sc2 = sc == null ? '#94a3b8' : sc > 0.3 ? '#059669' : sc < -0.3 ? '#b41340' : '#d97706';
              return (
                <GlassCard key={sub.id}
                  className="px-4 py-3 flex items-center gap-3 hover:shadow-md transition-all duration-200 hover:scale-[1.005] group">
                  <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: sc2 }} />
                  <div className="flex-1 min-w-0">
                    <Link
                      to={toPath(ROUTES.EXPERIENCE_SURVEY_TOPIC, { surveyId: surveyId!, topicId: sub.id })}
                      className="text-sm font-bold truncate block hover:text-primary transition-colors">
                      {sub.name}
                    </Link>
                    <div className="text-[10px] text-on-surface-variant">
                      {t('experience.topicDetail.subtopics.mentions', { n: String(sub.volume) })}
                    </div>
                  </div>
                  {/* Ask Crystal — always visible, not just on hover */}
                  <button
                    onClick={() => {
                      if (surveyId) setScope(surveyId);
                      openCrystal(t('experience.topicDetail.subtopics.query', { name: sub.name }), { focused_topic: sub.name });
                    }}
                    className="flex-shrink-0 flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-bold transition-colors hover:bg-primary/10"
                    style={{ color: 'var(--color-primary)' }}
                    title={t('experience.topicDetail.ask')}
                  >
                    <Icon name="psychology" size={12} />
                    <span className="hidden sm:inline">{t('experience.topicDetail.subtopics.ask')}</span>
                  </button>
                </GlassCard>
              );
            })}
          </div>
        </motion.section>
      )}

      {/* ── Co-occurring topics ─────────────────────────────────────────────── */}
      {coOccurring.length > 0 && (
        <motion.section initial="hidden" animate="visible" variants={rise}>
          <h2 className="text-[10px] font-black uppercase tracking-widest text-on-surface-variant mb-3">
            {t('experience.topicDetail.coOccurring.title')}
          </h2>
          <div className="flex flex-wrap gap-2">
            {coOccurring.slice(0, 8).map((co) => (
              <span key={co.name}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold bg-surface-container text-on-surface-variant">
                {co.name}
                <span className="text-[10px] opacity-60">{co.co_count}</span>
              </span>
            ))}
            {coOccurring.length > 8 && (
              <span className="flex items-center px-3 py-1.5 rounded-full text-xs font-bold text-on-surface-variant/60 bg-surface-container/50">
                {t('experience.topicDetail.coOccurring.more', { n: String(coOccurring.length - 8) })}
              </span>
            )}
          </div>
        </motion.section>
      )}

      {/* ── Verbatims ───────────────────────────────────────────────────────── */}
      <motion.section initial="hidden" animate="visible" variants={rise}>
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-[10px] font-black uppercase tracking-widest text-on-surface-variant">
              {t('insights.verbatims.title')}
            </h2>
            {verbatimsTotal > 0 && (
              <span className="text-[10px] text-on-surface-variant/60">
                {t('experience.topicDetail.verbatims.totalLabel', { n: verbatimsTotal.toLocaleString() })}
              </span>
            )}
          </div>
          {/* Filters: sentiment + NPS bucket */}
          <div className="flex flex-wrap gap-2">
            <div className="flex items-center gap-1">
              {SENTIMENT_FILTERS.map((f) => (
                <button key={f.value}
                  onClick={() => setSentFilter(f.value)}
                  className="px-2.5 py-1 rounded-full text-[11px] font-bold transition-all"
                  style={sentFilter === f.value
                    ? { background: 'var(--color-primary)', color: 'white' }
                    : { background: 'var(--color-surface-container)', color: 'var(--color-on-surface-variant)' }
                  }>
                  {t(f.labelKey)}
                </button>
              ))}
            </div>
            {/* NPS bucket filter — only show if we have NPS data */}
            {verbatimsTotal > 0 && (
              <div className="flex items-center gap-1">
                {([
                  { value: '',          labelKey: 'experience.topicDetail.verbatims.npsAll' },
                  { value: 'promoter',  labelKey: 'experience.topicDetail.verbatims.npsPromoter' },
                  { value: 'passive',   labelKey: 'experience.topicDetail.verbatims.npsPassive' },
                  { value: 'detractor', labelKey: 'experience.topicDetail.verbatims.npsDetractor' },
                ] as const).map((f) => (
                  <button key={f.value}
                    onClick={() => setNpsFilter(f.value)}
                    className="px-2.5 py-1 rounded-full text-[11px] font-bold transition-all"
                    style={npsFilter === f.value
                      ? {
                          background: f.value === 'promoter' ? '#059669' : f.value === 'detractor' ? '#b41340' : f.value === 'passive' ? '#94a3b8' : 'var(--color-secondary)',
                          color: 'white',
                        }
                      : { background: 'var(--color-surface-container)', color: 'var(--color-on-surface-variant)' }
                    }>
                    {t(f.labelKey)}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Verbatim cards */}
        <div className="space-y-2">
          {verbatims.map((v, i) => (
            <GlassCard key={`${v.response_id}-${i}`}
              className="px-4 py-3 group hover:shadow-md transition-shadow"
              style={{ borderLeft: `3px solid ${sentimentColor(v.sentiment)}` }}>
              <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  {/* Primary quote */}
                  <p className="text-sm leading-relaxed text-on-surface">"{v.text}"</p>
                  {/* Additional answer texts from other questions in same response */}
                  {v.all_texts && v.all_texts.length > 1 && (
                    <div className="mt-2 space-y-1">
                      {v.all_texts.filter((txt) => txt !== v.text).slice(0, 2).map((txt, ti) => (
                        <p key={ti} className="text-[11px] text-on-surface-variant/70 italic pl-3 border-l-2 border-outline-variant/30">
                          "{txt.slice(0, 140)}{txt.length > 140 ? '…' : ''}"
                        </p>
                      ))}
                    </div>
                  )}
                  {/* Metadata row */}
                  <div className="flex items-center gap-3 mt-2 text-[10px] text-on-surface-variant flex-wrap">
                    {v.sentiment && (
                      <span className="px-1.5 py-0.5 rounded font-bold capitalize"
                        style={{ background: sentimentBg(v.sentiment), color: sentimentColor(v.sentiment) }}>
                        {v.sentiment}
                      </span>
                    )}
                    {v.nps_score != null && (
                      <span className="flex items-center gap-1">
                        NPS{' '}
                        <strong style={{ color: v.nps_score >= 9 ? '#059669' : v.nps_score >= 7 ? '#d97706' : '#b41340' }}>
                          {v.nps_score}
                        </strong>
                        <span className="text-[9px] opacity-60">
                          {v.nps_score >= 9 ? t('experience.topicDetail.signals.npsSegment.promoter') : v.nps_score >= 7 ? t('experience.topicDetail.signals.npsSegment.passive') : t('experience.topicDetail.signals.npsSegment.detractor')}
                        </span>
                      </span>
                    )}
                    <span>{new Date(v.submitted_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })}</span>
                    {v.sentiment_score != null && (
                      <span className="font-mono opacity-60"
                        style={{ color: v.sentiment_score > 0 ? '#059669' : v.sentiment_score < 0 ? '#b41340' : '#94a3b8' }}>
                        {v.sentiment_score > 0 ? '+' : ''}{(v.sentiment_score * 100).toFixed(0)}%
                      </span>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => {
                    if (surveyId) setScope(surveyId);
                    openCrystal(
                      t('experience.topicDetail.query.verbatim', { quote: v.text.slice(0, 120), topic: topic.name }),
                      { focused_topic: topic.name },
                    );
                  }}
                  className="opacity-0 group-hover:opacity-100 flex-shrink-0 flex items-center gap-1 px-2 py-1 rounded text-[10px] font-bold transition-all hover:bg-primary/10 mt-0.5"
                  style={{ color: 'var(--color-primary)' }}
                  title={t('experience.topicDetail.ask')}
                >
                  <Icon name="psychology" size={12} /> {t('experience.common.askShort')}
                </button>
              </div>
            </GlassCard>
          ))}

          {verbatimsLoading && (
            <div className="space-y-2">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="h-14 rounded-xl bg-surface-container animate-pulse" />
              ))}
            </div>
          )}

          {!verbatimsLoading && verbatims.length === 0 && (
            <GlassCard className="p-8 text-center">
              <Icon name="chat_bubble_outline" size={28} style={{ color: 'var(--color-outline-variant)', margin: '0 auto 8px' }} />
              {(sentFilter || npsFilter) ? (
                <>
                  <p className="text-sm font-bold text-on-surface mb-1">{t('experience.topicDetail.verbatims.noMatchTitle', { sentiment: sentFilter })}</p>
                  <p className="text-xs text-on-surface-variant mb-3">
                    {t('experience.topicDetail.verbatims.noMatchBody', { sentiment: sentFilter })}
                  </p>
                  <button onClick={() => { setSentFilter(''); setNpsFilter(''); }}
                    className="text-xs font-bold text-primary hover:underline">
                    {t('experience.topicDetail.verbatims.clearFilter')}
                  </button>
                </>
              ) : (
                <p className="text-sm text-on-surface-variant">{t('insights.verbatims.empty')}</p>
              )}
            </GlassCard>
          )}

          {hasMore && !verbatimsLoading && (
            <div className="text-center pt-2">
              <Button variant="outline" size="sm" onClick={loadMore} className="text-xs font-bold">
                {t('experience.topicDetail.verbatims.loadMore')}
              </Button>
            </div>
          )}
        </div>
      </motion.section>
    </div>
    </TooltipProvider>
  );
}
