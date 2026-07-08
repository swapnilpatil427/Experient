// TopicDetailPanel — full deep-dive view for a single selected topic.
// Layout: hero strip → 2-col analysis grid → verbatims section.

import { useState, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from 'recharts';
import { motion } from 'framer-motion';
import { useTranslation } from '../../../lib/i18n';
import { GlassCard } from '../shared';
import { Icon } from '../../../components/Icon';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { ROUTES, toPath } from '../../../constants/routes';
import type { SurveyTopic, TopicVerbatim } from '../../../types';

// ── Types ──────────────────────────────────────────────────────────────────────

interface TrendPoint {
  day: string;
  volume: number;
  avg_nps: number | null;
}

interface TopicDetailPanelProps {
  topic: SurveyTopic & { nps_correlation?: number | null; theme?: string | null };
  detail: {
    trend_series: TrendPoint[];
    co_occurring: Array<{ name: string; co_count: number }>;
    subtopics: SurveyTopic[];
  } | null;
  verbatims: TopicVerbatim[];
  verbatimsTotal: number;
  verbatimsLoading: boolean;
  onLoadMore: () => void;
  onAskCrystal: (query: string, ctx: Record<string, string>) => void;
  onBack: () => void;
  surveyId: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

// Wave 19b (WAVE19_CRYSTAL_IDENTITY_TOKEN_SPEC.md §4.4): Recharts `stroke`/
// `stopColor` props are JS/SVG props, not CSS rules — a literal
// 'var(--color-primary)' string doesn't reliably resolve the way it does in a
// `style` object. Resolve the brand-reactive CSS custom properties via
// `getComputedStyle` at mount time instead (same pattern as
// components/three/NLThinkingCrystal.tsx / HeroCanvas.tsx, deliberately
// duplicated locally per spec guidance rather than a cross-module import).
const DEFAULT_PRIMARY_COLOR = '#2a4bd9';
const DEFAULT_TERTIARY_COLOR = '#8329c8';

function resolveCssVarColor(varName: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  return value || fallback;
}

function useResolvedBrandColors() {
  const [colors, setColors] = useState(() => ({
    primary: DEFAULT_PRIMARY_COLOR,
    tertiary: DEFAULT_TERTIARY_COLOR,
  }));

  useEffect(() => {
    setColors({
      primary: resolveCssVarColor('--color-primary', DEFAULT_PRIMARY_COLOR),
      tertiary: resolveCssVarColor('--color-tertiary', DEFAULT_TERTIARY_COLOR),
    });
  }, []);

  return colors;
}

function npsColor(score: number | null): string {
  if (score == null) return '#9ca3af';
  if (score >= 9)  return '#059669';
  if (score >= 7)  return '#f59e0b';
  return '#ef4444';
}

function npsLabel(score: number | null): string {
  if (score == null) return '—';
  if (score >= 9) return 'Promoter';
  if (score >= 7) return 'Passive';
  return 'Detractor';
}

function sentimentColor(s: string | null): string {
  if (!s) return '#9ca3af';
  const lower = s.toLowerCase();
  if (lower.includes('positive')) return '#059669';
  if (lower.includes('negative')) return '#ef4444';
  return '#f59e0b';
}

function formatDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(
      new Date(iso),
    );
  } catch {
    return iso;
  }
}

// Highlight topic keywords in response text
function HighlightedText({
  text,
  keywords,
}: {
  text: string;
  keywords: string[];
}) {
  if (!keywords.length) return <span>{text}</span>;

  // Build a regex from all keywords (case insensitive)
  const pattern = keywords
    .map((kw) => kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const regex = new RegExp(`(${pattern})`, 'gi');
  const parts = text.split(regex);

  return (
    <>
      {parts.map((part, i) =>
        regex.test(part) ? (
          <mark
            key={i}
            style={{
              background: '#fff3e0',
              color: 'inherit',
              borderRadius: 2,
              padding: '0 1px',
            }}
          >
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

// ── KPI tile ───────────────────────────────────────────────────────────────────
function KpiTile({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string | number | React.ReactNode;
  sub?: string;
  color?: string;
}) {
  return (
    <div
      className="flex flex-col gap-1 px-4 py-3 rounded-xl"
      style={{ background: 'rgba(255,255,255,0.55)', border: '1px solid rgba(255,255,255,0.7)' }}
    >
      <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
        {label}
      </span>
      <span
        className="text-xl font-extrabold tabular-nums leading-none"
        style={{ color: color ?? 'var(--color-on-surface, #1a1a2e)' }}
      >
        {value}
      </span>
      {sub && <span className="text-[11px] text-muted-foreground">{sub}</span>}
    </div>
  );
}

// ── Subtopic row ───────────────────────────────────────────────────────────────
function SubtopicRow({
  subtopic,
  maxVolume,
}: {
  subtopic: SurveyTopic;
  maxVolume: number;
}) {
  const pct = maxVolume > 0 ? (subtopic.volume / maxVolume) * 100 : 0;
  const sentScore = subtopic.sentiment_score ?? 0;
  const sentColor =
    sentScore > 0.15 ? '#059669' : sentScore < -0.15 ? '#ef4444' : '#f59e0b';

  return (
    <div className="flex items-center gap-3 py-2">
      <span className="text-xs font-medium text-on-surface flex-1 min-w-0 truncate">
        {subtopic.name}
      </span>
      <div className="flex-1 max-w-[120px] h-1.5 rounded-full overflow-hidden bg-gray-100">
        <div
          className="h-full rounded-full"
          style={{ width: `${pct}%`, background: 'var(--color-primary)' }}
        />
      </div>
      <span className="text-xs font-mono text-muted-foreground w-8 text-right">
        {subtopic.volume}
      </span>
      <span
        className="w-2 h-2 rounded-full flex-shrink-0"
        style={{ background: sentColor }}
      />
    </div>
  );
}

// ── VerbatimCard ───────────────────────────────────────────────────────────────
function VerbatimCard({
  verbatim,
  keywords,
  onTopicClick,
}: {
  verbatim: TopicVerbatim;
  keywords: string[];
  onTopicClick?: (topicName: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="flex gap-4 py-4"
      style={{ borderBottom: '1px solid rgba(0,0,0,0.06)' }}
    >
      {/* NPS chip */}
      <div className="flex-shrink-0 flex flex-col items-center gap-1">
        <div
          className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-extrabold shadow-sm"
          style={{
            background: `${npsColor(verbatim.nps_score)}1a`,
            color: npsColor(verbatim.nps_score),
            border: `2px solid ${npsColor(verbatim.nps_score)}40`,
          }}
        >
          {verbatim.nps_score ?? '—'}
        </div>
        <span
          className="text-[9px] font-bold uppercase tracking-wider"
          style={{ color: npsColor(verbatim.nps_score) }}
        >
          {npsLabel(verbatim.nps_score)}
        </span>
      </div>

      {/* Response text */}
      <div className="flex-1 min-w-0 space-y-2">
        <p className="text-sm text-on-surface leading-relaxed">
          <HighlightedText text={verbatim.text} keywords={keywords} />
        </p>

        {/* Related topics */}
        {verbatim.topics.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[10px] text-muted-foreground font-medium">
              {t('topicsAnalysis.verbatimsRelatedTopics')}
            </span>
            {verbatim.topics.slice(0, 5).map((topic) => (
              <button
                key={topic}
                type="button"
                onClick={() => onTopicClick?.(topic)}
                className="text-[10px] px-1.5 py-0.5 rounded-full font-semibold transition-colors hover:bg-primary/10"
                style={{
                  background: 'color-mix(in srgb, var(--color-primary) 7%, transparent)',
                  color: 'var(--color-primary)',
                }}
              >
                {topic}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Right: sentiment + date */}
      <div className="flex-shrink-0 flex flex-col items-end gap-1.5">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <div
                className="w-2.5 h-2.5 rounded-full"
                style={{ background: sentimentColor(verbatim.sentiment) }}
              />
            </TooltipTrigger>
            <TooltipContent>
              <p className="text-xs capitalize">{verbatim.sentiment ?? 'Unknown sentiment'}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <span className="text-[10px] text-muted-foreground tabular-nums">
          {formatDate(verbatim.submitted_at)}
        </span>
      </div>
    </div>
  );
}

// ── Rise animation variant ─────────────────────────────────────────────────────
const rise = {
  hidden: { opacity: 0, y: 16 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.5, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] },
  },
};

// ── TopicDetailPanel ───────────────────────────────────────────────────────────

export function TopicDetailPanel({
  topic,
  detail,
  verbatims,
  verbatimsTotal,
  verbatimsLoading,
  onLoadMore,
  onAskCrystal,
  onBack,
  surveyId,
}: TopicDetailPanelProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [verbatimFilter, setVerbatimFilter] = useState<'all' | 'positive' | 'neutral' | 'negative'>('all');
  const brandColors = useResolvedBrandColors();

  // NPS display value
  const npsDisplayVal = useMemo(() => {
    if (topic.nps_correlation != null) return Math.round(topic.nps_correlation * 50);
    return topic.nps_avg != null ? Math.round(topic.nps_avg) : null;
  }, [topic.nps_correlation, topic.nps_avg]);

  // Sentiment pcts
  const posPct = Math.round(topic.positive_pct ?? 0);
  const negPct = Math.round(topic.negative_pct ?? 0);
  const neuPct = Math.max(0, 100 - posPct - negPct);

  // Donut data
  const sentimentDonut = [
    { name: 'Positive', value: posPct, color: '#34d399' },
    { name: 'Neutral',  value: neuPct, color: '#d1d5db' },
    { name: 'Negative', value: negPct, color: '#f87171' },
  ];

  // Topic keywords for verbatim highlighting
  const keywords = useMemo(
    () => [topic.name, ...(topic.aliases ?? []), ...(topic.keyword_list ?? [])],
    [topic],
  );

  // Filtered verbatims
  const filteredVerbatims = useMemo(() => {
    if (verbatimFilter === 'all') return verbatims;
    return verbatims.filter((v) => {
      const s = (v.sentiment ?? '').toLowerCase();
      if (verbatimFilter === 'positive') return s.includes('positive');
      if (verbatimFilter === 'negative') return s.includes('negative');
      return !s.includes('positive') && !s.includes('negative');
    });
  }, [verbatims, verbatimFilter]);

  const hasTrendData = (detail?.trend_series?.length ?? 0) > 0;
  const hasSubtopics = (detail?.subtopics?.length ?? 0) > 0;
  const hasCoOccurring = (detail?.co_occurring?.length ?? 0) > 0;
  const maxSubtopicVolume = hasSubtopics
    ? Math.max(...(detail!.subtopics.map((s) => s.volume)))
    : 1;

  // Trending icon + color
  const trendingIconName =
    topic.trending === 'up' ? 'trending_up' :
    topic.trending === 'down' ? 'trending_down' :
    topic.trending === 'new' ? 'new_releases' : 'trending_flat';
  const trendingColor =
    topic.trending === 'up' ? '#059669' :
    topic.trending === 'down' ? '#dc2626' :
    topic.trending === 'new' ? 'var(--color-primary)' : '#9ca3af';

  return (
    <motion.div
      initial="hidden"
      animate="visible"
      variants={{ visible: { transition: { staggerChildren: 0.08 } } }}
      className="space-y-6"
    >
      {/* ── Back button ───────────────────────────────────────────── */}
      <motion.div variants={rise}>
        <Button
          variant="ghost"
          size="sm"
          onClick={onBack}
          className="gap-1.5 text-sm text-muted-foreground hover:text-on-surface -ml-1"
        >
          <Icon name="arrow_back" size={16} />
          {t('topicsAnalysis.backToTopics')}
        </Button>
      </motion.div>

      {/* ── Hero strip ────────────────────────────────────────────── */}
      <motion.div variants={rise}>
        <GlassCard className="p-5">
          {/* Name + theme pill + Crystal button */}
          <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap mb-1">
                {topic.theme && (
                  <span
                    className="px-2 py-0.5 rounded-full text-[11px] font-semibold"
                    style={{ background: 'color-mix(in srgb, var(--color-primary) 9%, transparent)', color: 'var(--color-primary)' }}
                  >
                    {topic.theme}
                  </span>
                )}
                {topic.chronic && (
                  <span
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold"
                    style={{ background: '#fef3c7', color: '#b45309' }}
                  >
                    <Icon name="warning" size={11} />
                    {t('topicsAnalysis.cardRecurring')}
                  </span>
                )}
              </div>
              <h2 className="text-xl md:text-2xl font-extrabold text-on-surface leading-tight">
                {topic.name}
              </h2>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="gap-2 border-primary/30 text-primary hover:bg-primary/5 flex-shrink-0"
              onClick={() =>
                onAskCrystal(
                  `Summarize the "${topic.name}" topic and suggest actionable improvements`,
                  { focused_topic: topic.id },
                )
              }
            >
              <Icon name="auto_awesome" size={14} />
              {t('topicsAnalysis.askCrystal')}
            </Button>
          </div>

          {/* KPI tiles row */}
          <div
            className="grid gap-3"
            style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))' }}
          >
            <KpiTile
              label={t('topicsAnalysis.detailVolume')}
              value={topic.volume.toLocaleString()}
              sub={
                topic.volume_delta_pct != null
                  ? `${topic.volume_delta_pct >= 0 ? '▲' : '▼'}${Math.abs(Math.round(topic.volume_delta_pct))}%`
                  : undefined
              }
            />
            <KpiTile
              label={t('topicsAnalysis.detailSentiment')}
              value={`${posPct}%`}
              sub={t('topicsAnalysis.cardPositive')}
              color={posPct > 50 ? '#059669' : posPct < 30 ? '#dc2626' : '#f59e0b'}
            />
            <KpiTile
              label={t('topicsAnalysis.detailNps')}
              value={npsDisplayVal != null ? (npsDisplayVal > 0 ? `+${npsDisplayVal}` : `${npsDisplayVal}`) : '—'}
              color={
                npsDisplayVal == null ? undefined :
                npsDisplayVal > 5 ? '#059669' :
                npsDisplayVal < -5 ? '#dc2626' : '#9ca3af'
              }
            />
            <KpiTile
              label={t('topicsAnalysis.detailEffort')}
              value={topic.effort_score != null ? topic.effort_score.toFixed(1) : '—'}
              sub="/ 7"
              color={
                topic.effort_score == null ? undefined :
                topic.effort_score < 3.5 ? '#059669' :
                topic.effort_score <= 5 ? '#f59e0b' : '#dc2626'
              }
            />
            <KpiTile
              label={t('topicsAnalysis.detailTrend')}
              value={
                <span className="flex items-center gap-1">
                  <Icon name={trendingIconName} size={18} style={{ color: trendingColor }} />
                  <span style={{ color: trendingColor, fontSize: '0.9rem' }}>
                    {topic.trending ?? 'stable'}
                  </span>
                </span>
              }
            />
          </div>
        </GlassCard>
      </motion.div>

      {/* ── Analysis grid ─────────────────────────────────────────── */}
      <motion.div
        variants={rise}
        className="grid grid-cols-1 lg:grid-cols-2 gap-6"
      >
        {/* Left: trend chart + co-occurring */}
        <div className="space-y-5">
          {/* Trend chart */}
          <GlassCard className="p-5">
            <h3 className="text-sm font-bold text-on-surface mb-4">
              {t('topicsAnalysis.detailTrendChart')}
            </h3>
            {hasTrendData ? (
              <ResponsiveContainer width="100%" height={200}>
                <AreaChart
                  data={detail!.trend_series}
                  margin={{ top: 4, right: 8, left: -20, bottom: 0 }}
                >
                  <defs>
                    <linearGradient id="gradVolume" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={brandColors.primary} stopOpacity={0.25} />
                      <stop offset="95%" stopColor={brandColors.primary} stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="gradNps" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={brandColors.tertiary} stopOpacity={0.2} />
                      <stop offset="95%" stopColor={brandColors.tertiary} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.05)" />
                  <XAxis
                    dataKey="day"
                    tick={{ fontSize: 9, fill: '#9ca3af' }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(v: string) => {
                      try { return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(v)); }
                      catch { return v; }
                    }}
                  />
                  <YAxis
                    yAxisId="volume"
                    orientation="left"
                    tick={{ fontSize: 9, fill: '#9ca3af' }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    yAxisId="nps"
                    orientation="right"
                    domain={[-100, 100]}
                    tick={{ fontSize: 9, fill: '#9ca3af' }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <RechartsTooltip
                    contentStyle={{
                      fontSize: 11,
                      borderRadius: 8,
                      border: '1px solid rgba(0,0,0,0.08)',
                      boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
                    }}
                  />
                  <Area
                    yAxisId="volume"
                    type="monotone"
                    dataKey="volume"
                    stroke={brandColors.primary}
                    strokeWidth={2}
                    fill="url(#gradVolume)"
                    name="Volume"
                    dot={false}
                  />
                  <Area
                    yAxisId="nps"
                    type="monotone"
                    dataKey="avg_nps"
                    stroke={brandColors.tertiary}
                    strokeWidth={1.5}
                    fill="url(#gradNps)"
                    name="Avg NPS"
                    dot={false}
                    connectNulls
                  />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div
                className="flex flex-col items-center justify-center rounded-xl text-center"
                style={{
                  height: 200,
                  background: 'rgba(0,0,0,0.02)',
                  border: '1.5px dashed rgba(0,0,0,0.1)',
                }}
              >
                <Icon name="insights" size={32} style={{ color: '#d1d5db', marginBottom: 8 }} />
                <p className="text-sm text-muted-foreground">
                  {t('topicsAnalysis.detailTrendNoData')}
                </p>
              </div>
            )}
          </GlassCard>

          {/* Co-occurring topics */}
          {hasCoOccurring && (
            <GlassCard className="p-5">
              <h3 className="text-sm font-bold text-on-surface mb-3">
                {t('topicsAnalysis.detailCoOccurring')}
              </h3>
              <div className="flex flex-wrap gap-2">
                {detail!.co_occurring.slice(0, 10).map((co) => (
                  <button
                    key={co.name}
                    type="button"
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold transition-colors hover:bg-primary/10"
                    style={{
                      background: 'color-mix(in srgb, var(--color-primary) 7%, transparent)',
                      color: 'var(--color-primary)',
                      border: '1px solid color-mix(in srgb, var(--color-primary) 12%, transparent)',
                    }}
                    onClick={() =>
                      onAskCrystal(
                        `Tell me how "${topic.name}" and "${co.name}" are related`,
                        { focused_topic: topic.id },
                      )
                    }
                  >
                    {co.name}
                    <span
                      className="text-[9px] px-1 py-0.5 rounded-full font-bold"
                      style={{ background: 'color-mix(in srgb, var(--color-primary) 12%, transparent)', color: 'var(--color-primary)' }}
                    >
                      {co.co_count}
                    </span>
                  </button>
                ))}
              </div>
            </GlassCard>
          )}
        </div>

        {/* Right: sentiment donut + subtopics */}
        <div className="space-y-5">
          {/* Sentiment breakdown donut */}
          <GlassCard className="p-5">
            <h3 className="text-sm font-bold text-on-surface mb-4">
              {t('topicsAnalysis.detailSentimentBreakdown')}
            </h3>
            <div className="flex items-center gap-6">
              <div style={{ width: 140, height: 140 }}>
                <PieChart width={140} height={140}>
                  <Pie
                    data={sentimentDonut}
                    cx={65}
                    cy={65}
                    innerRadius={45}
                    outerRadius={65}
                    paddingAngle={2}
                    dataKey="value"
                    strokeWidth={0}
                  >
                    {sentimentDonut.map((entry, i) => (
                      <Cell key={i} fill={entry.color} />
                    ))}
                  </Pie>
                </PieChart>
              </div>
              <div className="space-y-2 flex-1">
                {sentimentDonut.map((seg) => (
                  <div key={seg.name} className="flex items-center gap-2">
                    <span
                      className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                      style={{ background: seg.color }}
                    />
                    <span className="text-xs font-medium text-on-surface flex-1">
                      {t(`topicsAnalysis.detailSentiment${seg.name}` as Parameters<typeof t>[0])}
                    </span>
                    <span className="text-xs font-bold tabular-nums" style={{ color: seg.color }}>
                      {seg.value}%
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </GlassCard>

          {/* Subtopics list */}
          {hasSubtopics && (
            <GlassCard className="p-5">
              <h3 className="text-sm font-bold text-on-surface mb-3">
                {t('topicsAnalysis.detailSubtopics')}
              </h3>
              <div
                className="divide-y"
                style={{ '--tw-divide-opacity': 1 } as React.CSSProperties}
              >
                {detail!.subtopics.map((sub) => (
                  <SubtopicRow
                    key={sub.id}
                    subtopic={sub}
                    maxVolume={maxSubtopicVolume}
                  />
                ))}
              </div>
            </GlassCard>
          )}
        </div>
      </motion.div>

      {/* ── Verbatims section ─────────────────────────────────────── */}
      <motion.div variants={rise}>
        <GlassCard className="p-5">
          {/* Verbatims header + filter bar */}
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div>
              <h3 className="text-sm font-bold text-on-surface">
                {t('topicsAnalysis.verbatimsHeading')}
              </h3>
              {verbatimsTotal > 0 && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  {t('topicsAnalysis.verbatimsTotal', {
                    n: filteredVerbatims.length,
                    total: verbatimsTotal,
                  })}
                </p>
              )}
            </div>
            {/* Sentiment filter pills */}
            <div
              className="flex items-center gap-1 p-1 rounded-full"
              style={{ background: 'rgba(0,0,0,0.05)' }}
            >
              {(
                [
                  { key: 'all',      label: t('topicsAnalysis.verbatimsFilterAll') },
                  { key: 'positive', label: t('topicsAnalysis.verbatimsFilterPositive') },
                  { key: 'neutral',  label: t('topicsAnalysis.verbatimsFilterNeutral') },
                  { key: 'negative', label: t('topicsAnalysis.verbatimsFilterNegative') },
                ] as const
              ).map(({ key, label }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setVerbatimFilter(key)}
                  className="px-2.5 py-1 rounded-full text-[11px] font-semibold transition-all duration-150"
                  style={
                    verbatimFilter === key
                      ? {
                          background: key === 'positive' ? '#059669' : key === 'negative' ? '#dc2626' : 'var(--color-primary)',
                          color: '#fff',
                        }
                      : { color: 'var(--color-on-surface-variant, #6b7280)' }
                  }
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Verbatim list */}
          {filteredVerbatims.length === 0 ? (
            <div
              className="flex flex-col items-center justify-center rounded-xl text-center py-12"
              style={{
                background: 'rgba(0,0,0,0.02)',
                border: '1.5px dashed rgba(0,0,0,0.1)',
              }}
            >
              <Icon name="forum" size={36} style={{ color: '#d1d5db', marginBottom: 12 }} />
              <p className="text-sm text-muted-foreground max-w-sm">
                {t('topicsAnalysis.verbatimsEmpty')}
              </p>
            </div>
          ) : (
            <div className="divide-y" style={{ '--tw-divide-opacity': 0 } as React.CSSProperties}>
              {filteredVerbatims.slice(0, 50).map((v) => (
                <VerbatimCard
                  key={v.response_id}
                  verbatim={v}
                  keywords={keywords}
                  onTopicClick={(name) =>
                    onAskCrystal(`Tell me about the "${name}" topic`, {
                      focused_topic: name,
                    })
                  }
                />
              ))}
            </div>
          )}

          {/* Load more */}
          {verbatims.length < verbatimsTotal && filteredVerbatims.length > 0 && (
            <div className="pt-4 text-center">
              <Button
                variant="outline"
                size="sm"
                onClick={onLoadMore}
                disabled={verbatimsLoading}
                className="gap-2"
              >
                {verbatimsLoading ? (
                  <>
                    <Icon name="refresh" size={14} className="animate-spin" />
                    {t('common.loading')}
                  </>
                ) : (
                  t('topicsAnalysis.verbatimsLoadMore', {
                    n: Math.min(25, verbatimsTotal - verbatims.length),
                  })
                )}
              </Button>
            </div>
          )}
        </GlassCard>
      </motion.div>
    </motion.div>
  );
}
