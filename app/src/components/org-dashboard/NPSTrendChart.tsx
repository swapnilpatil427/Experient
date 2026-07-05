// NPSTrendChart — DESIGN.md §4. Recharts ComposedChart, dual-axis (NPS
// left, response volume right), Aggregated/By Survey toggle, benchmark
// ReferenceLine.

import { useState } from 'react';
import {
  ComposedChart, Line, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine,
  ResponsiveContainer, Legend,
} from 'recharts';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useTranslation } from '../../lib/i18n';
import type { OrgTrendsResponse } from '../../types/orgDashboard';

const SURVEY_PALETTE = [
  '#6366F1', '#EC4899', '#14B8A6', '#F59E0B', '#8B5CF6',
  '#06B6D4', '#10B981', '#F43F5E', '#3B82F6', '#A16207',
];

export function NPSTrendChart({ data, loading }: { data: OrgTrendsResponse | null; loading: boolean }) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'aggregated' | 'bySurvey'>('aggregated');

  if (loading) {
    return <div className="h-[280px] rounded-xl bg-surface-container animate-pulse" />;
  }

  const series = data?.series ?? [];
  const bySurvey = (data?.bySurvey ?? []).slice(0, 10);
  const benchmark = data?.benchmark?.nps ?? null;

  if (series.length === 0) {
    return (
      <div className="h-[280px] rounded-xl border border-gray-100 flex items-center justify-center">
        <p className="text-sm text-gray-400">{t('orgDashboard.trends.noData')}</p>
      </div>
    );
  }

  // Merge by-survey series onto the shared date axis for a single ComposedChart.
  const bySurveyChartData: Record<string, unknown>[] = mode === 'bySurvey'
    ? series.map((point) => {
        const row: Record<string, unknown> = { date: point.date };
        bySurvey.forEach((s) => {
          const match = s.points.find((p) => p.date === point.date);
          if (match) row[s.surveyId] = match.nps;
        });
        return row;
      })
    : [];

  // Recharts' `data` prop wants `Record<string, unknown>[]` — the aggregated
  // series is a concrete `OrgTrendPoint[]`, which structurally satisfies that
  // shape at runtime but TS won't widen it automatically (missing index
  // signature). Cast at this single boundary rather than loosening the
  // `OrgTrendPoint` type everywhere else it's used.
  const chartData: Record<string, unknown>[] = mode === 'aggregated'
    ? (series as unknown as Record<string, unknown>[])
    : bySurveyChartData;

  return (
    <div className="rounded-xl border border-gray-100 p-4 bg-white">
      <div className="flex items-center justify-end mb-2">
        <ToggleGroup type="single" value={mode} onValueChange={(v) => v && setMode(v as 'aggregated' | 'bySurvey')}>
          <ToggleGroupItem value="aggregated" className="text-xs px-3">{t('orgDashboard.trends.aggregated')}</ToggleGroupItem>
          <ToggleGroupItem value="bySurvey" className="text-xs px-3">{t('orgDashboard.trends.bySurvey')}</ToggleGroupItem>
        </ToggleGroup>
      </div>

      {mode === 'bySurvey' && data && (data.bySurvey?.length ?? 0) > 10 && (
        <p className="text-[11px] text-gray-400 mb-1">{t('orgDashboard.trends.showingTop10')}</p>
      )}

      <div style={{ width: '100%', height: 260 }}>
        <ResponsiveContainer>
          <ComposedChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
            <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#6b7280' }} />
            <YAxis yAxisId="nps" domain={[-100, 100]} ticks={[-50, 0, 50, 100]} tick={{ fontSize: 11, fill: '#6b7280' }} />
            {mode === 'aggregated' && <YAxis yAxisId="volume" orientation="right" tick={{ fontSize: 11, fill: '#6b7280' }} />}
            <Tooltip
              contentStyle={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 12 }}
            />
            {benchmark != null && (
              <ReferenceLine
                yAxisId="nps" y={benchmark} stroke="#9CA3AF" strokeDasharray="4 4"
                label={{ value: t('orgDashboard.trends.benchmarkLabel', { value: String(benchmark) }), position: 'right', fontSize: 10, fill: '#9CA3AF' }}
              />
            )}
            {mode === 'aggregated' ? (
              <>
                <Bar yAxisId="volume" dataKey="totalResponses" fill="#E0E7FF" radius={[3, 3, 0, 0]} />
                <Line yAxisId="nps" type="monotone" dataKey="avgNps" stroke="#6366F1" strokeWidth={2}
                  dot={{ r: 4, fill: '#fff', stroke: '#6366F1', strokeWidth: 2 }}
                  activeDot={{ r: 6, fill: '#6366F1' }} />
              </>
            ) : (
              <>
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {bySurvey.map((s, i) => (
                  <Line
                    key={s.surveyId} yAxisId="nps" type="monotone" dataKey={s.surveyId} name={s.surveyTitle}
                    stroke={SURVEY_PALETTE[i % SURVEY_PALETTE.length]} strokeWidth={2} dot={false} connectNulls
                  />
                ))}
              </>
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
