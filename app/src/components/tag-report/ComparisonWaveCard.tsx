import { useState } from 'react';
import { LineChart, Line, ResponsiveContainer, YAxis } from 'recharts';
import { useTranslation } from '../../lib/i18n';
import { Icon } from '../Icon';
import { GlassCard } from '../../pages/insights/shared';
import type { TagReportMetricTrack } from '../../types/tagReport';

const METRIC_COLOR: Record<string, string> = { nps: '#2a4bd9', csat: '#8b5cf6', ces: '#059669' };
const DIRECTION_COLOR = { up: '#059669', down: '#dc2626', flat: '#64748b' };

/** Custom Range only — R-C1's bracketed-snapshot wave comparison card. */
export function ComparisonWaveCard({ track }: { track: TagReportMetricTrack }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const color = METRIC_COLOR[track.metric_key] ?? '#64748b';
  const delta = track.merged_delta;
  const directionColor = delta == null ? DIRECTION_COLOR.flat : delta > 0 ? DIRECTION_COLOR.up : delta < 0 ? DIRECTION_COLOR.down : DIRECTION_COLOR.flat;

  const chartData = delta == null
    ? []
    : [{ x: 0, v: 0 }, { x: 1, v: delta }];

  const breakdown = [...(track.survey_breakdown ?? [])].sort((a, b) => b.trust_score - a.trust_score);

  return (
    <GlassCard className="p-5">
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: color }} />
          <h3 className="text-sm font-bold font-headline text-on-surface">
            {t('tagReport.comparisonCard.title', { metric: track.metric_key.toUpperCase() })}
          </h3>
        </div>
        {delta != null && (
          <span className="text-sm font-black px-2 py-0.5 rounded-full" style={{ color: directionColor, background: `${directionColor}1a` }}>
            {delta > 0 ? '+' : ''}{delta}
          </span>
        )}
      </div>

      {delta == null ? (
        <p className="text-sm text-on-surface-variant mb-3">{t('tagReport.comparisonCard.noComparisonAvailable')}</p>
      ) : (
        <div className="h-16 mb-3" data-testid="comparison-sparkline">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData}>
              <YAxis hide domain={['dataMin', 'dataMax']} />
              <Line type="monotone" dataKey="v" stroke={directionColor} strokeWidth={2.5} dot={{ r: 3 }} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {breakdown.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="text-xs font-semibold flex items-center gap-1 text-on-surface-variant hover:text-on-surface"
          >
            {t('tagReport.comparisonCard.perSurveyBreakdown')}
            <Icon name={expanded ? 'expand_less' : 'expand_more'} size={14} />
          </button>
          {expanded && (
            <ul className="mt-2 space-y-2">
              {breakdown.map((s) => (
                <li key={s.survey_id} className="text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-on-surface">{s.survey_title ?? s.survey_id}</span>
                    {s.no_comparison_available ? (
                      <span className="text-xs text-on-surface-variant shrink-0">{t('tagReport.comparisonCard.noComparisonAvailable')}</span>
                    ) : (
                      <span className="text-xs font-semibold shrink-0" style={{ color: (s.delta ?? 0) >= 0 ? DIRECTION_COLOR.up : DIRECTION_COLOR.down }}>
                        {s.delta != null && s.delta > 0 ? '+' : ''}{s.delta}
                      </span>
                    )}
                  </div>
                  {s.requested_window_start && s.actual_window_start && (
                    <div className="text-[11px] text-on-surface-variant space-y-0.5 mt-0.5">
                      <p>{t('tagReport.comparisonCard.requestedWindow', { start: s.requested_window_start, end: s.requested_window_end })}</p>
                      <p>{t('tagReport.comparisonCard.actualWindow', { start: s.actual_window_start, end: s.actual_window_end })}</p>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </GlassCard>
  );
}
