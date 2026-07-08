// TopicCard — rich topic card used in the Topics Analysis overview grid.
// Shows volume, sentiment bar, NPS impact, effort dial, sparkline, and actions.

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
import type { SurveyTopic } from '../../../types';

// ── Types ──────────────────────────────────────────────────────────────────────

interface TopicCardProps {
  topic: SurveyTopic & {
    subtopics?: SurveyTopic[];
    theme?: string | null;
    nps_correlation?: number | null;
  };
  onSelect: (topicId: string) => void;
  onAskCrystal: (query: string, ctx: { focused_topic: string }) => void;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatVolumeDelta(pct: number | null | undefined): string {
  if (pct == null) return '';
  const abs = Math.abs(Math.round(pct));
  return pct >= 0 ? `▲${abs}%` : `▼${abs}%`;
}

function trendLabel(trending: SurveyTopic['trending'], t: (k: string) => string): string {
  switch (trending) {
    case 'up':     return t('topicsAnalysis.cardTrendingUp');
    case 'down':   return t('topicsAnalysis.cardTrendingDown');
    case 'new':    return t('topicsAnalysis.cardNew');
    default:       return t('topicsAnalysis.cardTrendingStable');
  }
}

function trendColor(trending: SurveyTopic['trending']): string {
  switch (trending) {
    case 'up':     return '#059669';
    case 'down':   return '#dc2626';
    case 'new':    return 'var(--color-primary)';
    default:       return '#6b7280';
  }
}

function trendIcon(trending: SurveyTopic['trending']): string {
  switch (trending) {
    case 'up':   return 'trending_up';
    case 'down': return 'trending_down';
    case 'new':  return 'new_releases';
    default:     return 'trending_flat';
  }
}

// Effort arc via CSS clip-path trick — small SVG arc dial 1-7
function EffortDial({ score }: { score: number | null }) {
  const { t } = useTranslation();
  if (score == null) return (
    <span className="text-xs text-muted-foreground">—</span>
  );
  const normalized = Math.max(1, Math.min(7, score));
  const fraction = (normalized - 1) / 6; // 0-1
  const degrees = Math.round(fraction * 180); // 0-180 deg arc
  const color =
    normalized < 3.5 ? '#059669' :
    normalized <= 5   ? '#f59e0b' :
                        '#dc2626';
  const r = 14;
  const cx = 18;
  const cy = 18;
  // Arc from left (270°) sweeping through top — simplified: just a colored ring fraction
  const startAngle = Math.PI; // left
  const endAngle = Math.PI - (fraction * Math.PI); // sweeping right
  const sx = cx + r * Math.cos(startAngle);
  const sy = cy + r * Math.sin(startAngle);
  const ex = cx + r * Math.cos(endAngle);
  const ey = cy + r * Math.sin(endAngle);
  const largeArc = fraction > 0.5 ? 1 : 0;
  const pathD =
    fraction === 0
      ? ''
      : `M ${sx} ${sy} A ${r} ${r} 0 ${largeArc} 0 ${ex} ${ey}`;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex flex-col items-center gap-0.5">
            <svg width="36" height="20" viewBox="0 0 36 20" fill="none" aria-label={`Effort score ${score}`}>
              {/* background arc track */}
              <path
                d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`}
                stroke="#e5e7eb"
                strokeWidth="3"
                strokeLinecap="round"
                fill="none"
              />
              {/* colored progress arc */}
              {fraction > 0 && (
                <path
                  d={`M ${cx - r} ${cy} A ${r} ${r} 0 ${largeArc} 1 ${ex} ${ey}`}
                  stroke={color}
                  strokeWidth="3"
                  strokeLinecap="round"
                  fill="none"
                />
              )}
            </svg>
            <span className="text-[10px] font-bold tabular-nums" style={{ color }}>
              {normalized.toFixed(1)}
            </span>
          </div>
        </TooltipTrigger>
        <TooltipContent>
          <p>{t('topicsAnalysis.cardEffort')}: {normalized.toFixed(1)} / 7</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// Inline sparkline placeholder — a simple gradient SVG polyline
function SparklinePlaceholder({ trending }: { trending: SurveyTopic['trending'] }) {
  const color = trendColor(trending);
  // Gentle mock polyline based on trend direction
  const pts =
    trending === 'up'
      ? '0,55 10,50 20,42 30,38 40,30 50,22 60,14'
      : trending === 'down'
        ? '0,14 10,22 20,30 30,38 40,44 50,50 60,55'
        : '0,35 10,30 20,36 30,32 40,35 50,30 60,33';
  return (
    <svg width="60" height="60" viewBox="0 0 60 60" fill="none" aria-hidden>
      <defs>
        <linearGradient id={`sg-${trending}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.3} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <polyline
        points={pts}
        stroke={color}
        strokeWidth="1.5"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ── NPS impact pill ────────────────────────────────────────────────────────────
function NpsImpactPill({
  npsCorrelation,
  npsAvg,
  t,
}: {
  npsCorrelation?: number | null;
  npsAvg?: number | null;
  t: (k: string, v?: Record<string, unknown>) => string;
}) {
  // Use nps_correlation if available (Pearson r scaled to NPS pts estimate), else nps_avg delta
  const val = npsCorrelation != null ? Math.round(npsCorrelation * 50) : npsAvg ?? null;
  if (val == null) {
    return (
      <span
        className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold"
        style={{ background: '#f3f4f6', color: '#6b7280' }}
      >
        {t('topicsAnalysis.cardNoNpsData')}
      </span>
    );
  }
  if (val > 5) {
    return (
      <span
        className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold"
        style={{ background: '#d1fae5', color: '#059669' }}
      >
        {t('topicsAnalysis.cardNpsLift', { n: val })}
      </span>
    );
  }
  if (val < -5) {
    return (
      <span
        className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold"
        style={{ background: '#fee2e2', color: '#dc2626' }}
      >
        {t('topicsAnalysis.cardNpsDrag', { n: val })}
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold"
      style={{ background: '#f3f4f6', color: '#6b7280' }}
    >
      {val > 0 ? `+${val}` : val} NPS
    </span>
  );
}

// ── Sentiment bar ──────────────────────────────────────────────────────────────
function SentimentBar({
  positivePct,
  negativePct,
  t,
}: {
  positivePct: number | null | undefined;
  negativePct: number | null | undefined;
  t: (k: string) => string;
}) {
  const pos = Math.max(0, Math.min(100, positivePct ?? 0));
  const neg = Math.max(0, Math.min(100, negativePct ?? 0));
  const neu = Math.max(0, 100 - pos - neg);
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className="h-2 w-full rounded-full overflow-hidden flex cursor-default"
            aria-label={`Sentiment: ${pos}% positive, ${Math.round(neu)}% neutral, ${neg}% negative`}
          >
            <div style={{ width: `${pos}%`, background: '#059669', minWidth: pos > 0 ? 2 : 0 }} />
            <div style={{ width: `${neu}%`, background: '#d1d5db', minWidth: neu > 0 ? 2 : 0 }} />
            <div style={{ width: `${neg}%`, background: '#ef4444', minWidth: neg > 0 ? 2 : 0 }} />
          </div>
        </TooltipTrigger>
        <TooltipContent>
          <div className="space-y-1 text-xs">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-green-500 inline-block" />
              <span>{t('topicsAnalysis.cardPositive')}: {Math.round(pos)}%</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-gray-300 inline-block" />
              <span>{t('topicsAnalysis.cardNeutral')}: {Math.round(neu)}%</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-red-400 inline-block" />
              <span>{t('topicsAnalysis.cardNegative')}: {Math.round(neg)}%</span>
            </div>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// ── TopicCard ──────────────────────────────────────────────────────────────────

export function TopicCard({ topic, onSelect, onAskCrystal }: TopicCardProps) {
  const { t } = useTranslation();
  const isUrgent = (topic.urgency_score ?? 0) >= 30; // urgency_score is [0,100] — 30% = medium threshold
  const deltaPct = formatVolumeDelta(topic.volume_delta_pct);
  const deltaPositive = (topic.volume_delta_pct ?? 0) >= 0;

  return (
    <GlassCard
      className="flex flex-col h-full transition-all duration-200 hover:shadow-lg cursor-pointer"
      style={{
        minWidth: 0,
        // Urgent: red-orange left glow
        ...(isUrgent
          ? {
              borderLeft: '3px solid #f97316',
              boxShadow:
                '-4px 0 16px rgba(249,115,22,0.25), 0 4px 24px rgba(0,0,0,0.06), inset 0 1px 0 rgba(255,255,255,0.8)',
            }
          : {}),
      }}
    >
      {/* ── Header ─────────────────────────────────────────────────── */}
      <div
        className="px-4 pt-4 pb-3 flex flex-col gap-2"
        onClick={() => onSelect(topic.id)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onSelect(topic.id)}
        aria-label={`Open deep dive for ${topic.name}`}
      >
        {/* Row 1: name + trend badge */}
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-sm font-bold text-on-surface leading-snug flex-1 min-w-0 truncate">
            {topic.name}
          </h3>
          <div
            className="flex items-center gap-1 flex-shrink-0 px-2 py-0.5 rounded-full text-[10px] font-bold"
            style={{
              background: `${trendColor(topic.trending)}18`,
              color: trendColor(topic.trending),
            }}
          >
            <Icon name={trendIcon(topic.trending)} size={12} />
            <span>{trendLabel(topic.trending, t)}</span>
          </div>
        </div>

        {/* Row 2: theme pill + chronic badge */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {topic.theme && (
            <span
              className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold"
              style={{
                background: 'color-mix(in srgb, var(--color-primary) 9%, transparent)',
                color: 'var(--color-primary)',
              }}
            >
              {topic.theme}
            </span>
          )}
          {topic.chronic && (
            <span
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold"
              style={{ background: '#fef3c7', color: '#b45309' }}
            >
              <Icon name="warning" size={10} />
              {t('topicsAnalysis.cardRecurring')}
            </span>
          )}
          {topic.is_new && !topic.chronic && (
            <span
              className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold"
              style={{ background: 'color-mix(in srgb, var(--color-primary) 9%, transparent)', color: 'var(--color-primary)' }}
            >
              {t('topicsAnalysis.cardNew')}
            </span>
          )}
        </div>

        {/* ── Volume + delta ───────────────────────────────────────── */}
        <div className="flex items-end gap-2 mt-1">
          <span className="text-2xl font-extrabold tabular-nums text-on-surface leading-none">
            {topic.volume.toLocaleString()}
          </span>
          {deltaPct && (
            <span
              className="text-xs font-bold mb-0.5"
              style={{ color: deltaPositive ? '#059669' : '#dc2626' }}
            >
              {deltaPct}
            </span>
          )}
          <span className="text-xs text-muted-foreground mb-0.5">
            {t('topicsAnalysis.cardVolume').toLowerCase()}
          </span>
        </div>

        {/* ── Sentiment bar ─────────────────────────────────────────── */}
        <SentimentBar
          positivePct={topic.positive_pct}
          negativePct={topic.negative_pct}
          t={t}
        />

        {/* ── KPI row: NPS + Effort + Sparkline ───────────────────── */}
        <div className="flex items-center justify-between gap-3 pt-1">
          <div className="flex flex-col gap-1">
            <NpsImpactPill
              npsCorrelation={topic.nps_correlation}
              npsAvg={topic.nps_avg}
              t={t}
            />
            <EffortDial score={topic.effort_score} />
          </div>
          <SparklinePlaceholder trending={topic.trending} />
        </div>

        {/* ── Subtopics chip ────────────────────────────────────────── */}
        {(topic.subtopics?.length ?? 0) > 0 && (
          <div className="flex">
            <span
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] text-muted-foreground"
              style={{ background: 'rgba(0,0,0,0.04)' }}
            >
              <Icon name="account_tree" size={11} />
              {t('topicsAnalysis.cardSubtopics', { n: topic.subtopics!.length })}
            </span>
          </div>
        )}
      </div>

      {/* ── Footer actions ────────────────────────────────────────────── */}
      <div
        className="mt-auto px-4 py-3 flex items-center justify-between border-t"
        style={{ borderColor: 'rgba(0,0,0,0.06)' }}
      >
        <button
          type="button"
          className="text-xs font-semibold text-primary hover:underline"
          onClick={() => onSelect(topic.id)}
        >
          {t('topicsAnalysis.cardDeepDive')}
        </button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs text-muted-foreground hover:text-primary"
          onClick={(e) => {
            e.stopPropagation();
            onAskCrystal(`Tell me about the "${topic.name}" topic`, {
              focused_topic: topic.id,
            });
          }}
        >
          <Icon name="auto_awesome" size={13} className="mr-1" />
          {t('topicsAnalysis.cardAskCrystal')}
        </Button>
      </div>
    </GlassCard>
  );
}
