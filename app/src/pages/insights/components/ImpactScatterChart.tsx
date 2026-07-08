// ImpactScatterChart — Recharts scatter showing topics by volume vs NPS impact.
// Quadrant labels, clickable dots, dashed crosshair at NPS=0 + median volume.

import { useMemo, useCallback } from 'react';
import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  ReferenceLine,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts';
import { useTranslation } from '../../../lib/i18n';
import { GlassCard } from '../shared';
import type { SurveyTopic } from '../../../types';

// ── Types ──────────────────────────────────────────────────────────────────────

interface ImpactScatterChartProps {
  topics: Array<SurveyTopic & { nps_correlation?: number | null; theme?: string | null }>;
  onSelectTopic: (topicId: string) => void;
}

interface ScatterPoint {
  id: string;
  name: string;
  x: number;       // volume
  y: number;       // nps impact
  z: number;       // urgency_score → bubble size
  sentiment: 'positive' | 'neutral' | 'negative';
  theme: string | null;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function sentimentFromScore(score: number | null): ScatterPoint['sentiment'] {
  if (score == null) return 'neutral';
  if (score > 0.15)  return 'positive';
  if (score < -0.15) return 'negative';
  return 'neutral';
}

function sentimentFill(s: ScatterPoint['sentiment']): string {
  switch (s) {
    case 'positive': return '#34d399';
    case 'negative': return '#f87171';
    default:         return '#9ca3af';
  }
}

function sentimentStroke(s: ScatterPoint['sentiment']): string {
  switch (s) {
    case 'positive': return '#059669';
    case 'negative': return '#dc2626';
    default:         return '#6b7280';
  }
}

// Custom tooltip
function CustomTooltipContent({
  active,
  payload,
  t,
}: {
  active?: boolean;
  payload?: Array<{ payload: ScatterPoint }>;
  t: (k: string) => string;
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  const fill = sentimentFill(p.sentiment);
  return (
    <div
      className="rounded-xl px-3 py-2.5 text-xs shadow-lg"
      style={{
        background: 'rgba(255,255,255,0.97)',
        border: '1px solid rgba(0,0,0,0.1)',
        backdropFilter: 'blur(8px)',
        maxWidth: 200,
      }}
    >
      <div className="font-bold text-sm text-on-surface mb-1.5 leading-snug">
        {p.name}
      </div>
      {p.theme && (
        <div
          className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold mb-1.5"
          style={{ background: 'color-mix(in srgb, var(--color-primary) 9%, transparent)', color: 'var(--color-primary)' }}
        >
          {p.theme}
        </div>
      )}
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">{t('topicsAnalysis.scatterTooltipVolume')}</span>
          <span className="font-semibold">{p.x.toLocaleString()}</span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">{t('topicsAnalysis.scatterTooltipNps')}</span>
          <span className="font-semibold" style={{ color: p.y > 0 ? '#059669' : p.y < 0 ? '#dc2626' : '#6b7280' }}>
            {p.y > 0 ? `+${p.y}` : p.y}
          </span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">{t('topicsAnalysis.scatterTooltipSentiment')}</span>
          <span className="font-semibold capitalize" style={{ color: fill }}>
            {p.sentiment}
          </span>
        </div>
      </div>
    </div>
  );
}

// ── ImpactScatterChart ─────────────────────────────────────────────────────────

export function ImpactScatterChart({ topics, onSelectTopic }: ImpactScatterChartProps) {
  const { t } = useTranslation();

  // Filter to topics that have NPS data
  const hasNpsData = topics.some(
    (tp) => tp.nps_correlation != null || tp.nps_avg != null,
  );

  const points = useMemo<ScatterPoint[]>(() => {
    return topics
      .filter((tp) => tp.nps_correlation != null || tp.nps_avg != null)
      .map((tp) => {
        const npsVal = tp.nps_correlation != null
          ? Math.round(tp.nps_correlation * 50)   // scale Pearson r to approximate NPS pts
          : Math.round(tp.nps_avg ?? 0);
        return {
          id: tp.id,
          name: tp.name,
          x: tp.volume,
          y: npsVal,
          z: Math.max(4, Math.min(16, (tp.urgency_score ?? 5) * 2)),
          sentiment: sentimentFromScore(tp.sentiment_score),
          theme: tp.theme ?? null,
        };
      });
  }, [topics]);

  // Median volume for crosshair
  const medianVolume = useMemo(() => {
    if (!points.length) return 0;
    const sorted = [...points].sort((a, b) => a.x - b.x);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[mid - 1].x + sorted[mid].x) / 2
      : sorted[mid].x;
  }, [points]);

  const handleClick = useCallback(
    (data: ScatterPoint) => {
      if (data?.id) onSelectTopic(data.id);
    },
    [onSelectTopic],
  );

  // Guard: need 3+ topics for a meaningful scatter
  if (topics.length < 3) return null;

  if (!hasNpsData) {
    return (
      <GlassCard className="p-8 text-center">
        <p className="text-sm text-muted-foreground">
          {t('topicsAnalysis.scatterNoData')}
        </p>
      </GlassCard>
    );
  }

  if (!points.length) return null;

  // Quadrant label helper — rendered as static positioned spans over the chart
  const QuadrantLabel = ({
    top, left, right, bottom, text, color,
  }: {
    top?: string; left?: string; right?: string; bottom?: string;
    text: string; color: string;
  }) => (
    <div
      className="absolute text-[9px] font-bold uppercase tracking-wider opacity-60 max-w-[110px] leading-tight text-center pointer-events-none"
      style={{ top, left, right, bottom, color }}
    >
      {text}
    </div>
  );

  return (
    <GlassCard className="overflow-hidden">
      <div className="px-5 pt-4 pb-2 flex items-center justify-between">
        <h3 className="text-sm font-bold text-on-surface">
          {t('topicsAnalysis.scatterTitle')}
        </h3>
        <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-green-400 inline-block" />
            Positive
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-gray-400 inline-block" />
            Neutral
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-red-400 inline-block" />
            Negative
          </span>
        </div>
      </div>

      <div className="relative px-2 pb-4" style={{ height: 340 }}>
        {/* Quadrant labels — absolute positioned over chart */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{ left: 48, top: 8, right: 16, bottom: 32 }}
        >
          <QuadrantLabel top="8%" left="4%" text={t('topicsAnalysis.scatterQ2')} color="#059669" />
          <QuadrantLabel top="8%" right="4%" text={t('topicsAnalysis.scatterQ1')} color="#059669" />
          <QuadrantLabel bottom="8%" left="4%" text={t('topicsAnalysis.scatterQ4')} color="#9ca3af" />
          <QuadrantLabel bottom="8%" right="4%" text={t('topicsAnalysis.scatterQ3')} color="#dc2626" />
        </div>

        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 16, right: 24, bottom: 8, left: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" />

            <XAxis
              type="number"
              dataKey="x"
              name={t('topicsAnalysis.scatterXAxis')}
              label={{
                value: t('topicsAnalysis.scatterXAxis'),
                position: 'insideBottom',
                offset: -4,
                style: { fontSize: 10, fill: '#9ca3af', fontWeight: 600 },
              }}
              axisLine={false}
              tickLine={false}
              tick={{ fontSize: 9, fill: '#9ca3af' }}
            />

            <YAxis
              type="number"
              dataKey="y"
              name={t('topicsAnalysis.scatterYAxis')}
              label={{
                value: t('topicsAnalysis.scatterYAxis'),
                angle: -90,
                position: 'insideLeft',
                offset: 8,
                style: { fontSize: 10, fill: '#9ca3af', fontWeight: 600 },
              }}
              axisLine={false}
              tickLine={false}
              tick={{ fontSize: 9, fill: '#9ca3af' }}
            />

            {/* Horizontal dashed line at NPS=0 */}
            <ReferenceLine
              y={0}
              stroke="#6b7280"
              strokeDasharray="4 4"
              strokeWidth={1}
            />
            {/* Vertical dashed line at median volume */}
            <ReferenceLine
              x={medianVolume}
              stroke="#6b7280"
              strokeDasharray="4 4"
              strokeWidth={1}
            />

            <RechartsTooltip
              cursor={{ strokeDasharray: '3 3', stroke: 'rgba(0,0,0,0.1)' }}
              content={(props) => (
                <CustomTooltipContent
                  active={props.active}
                  payload={props.payload as unknown as Array<{ payload: ScatterPoint }>}
                  t={t}
                />
              )}
            />

            <Scatter
              data={points}
              onClick={(data) => handleClick(data as unknown as ScatterPoint)}
              style={{ cursor: 'pointer' }}
            >
              {points.map((point) => (
                <Cell
                  key={point.id}
                  fill={sentimentFill(point.sentiment)}
                  stroke={sentimentStroke(point.sentiment)}
                  strokeWidth={1.5}
                  fillOpacity={0.8}
                  r={point.z}
                />
              ))}
            </Scatter>
          </ScatterChart>
        </ResponsiveContainer>
      </div>
    </GlassCard>
  );
}
