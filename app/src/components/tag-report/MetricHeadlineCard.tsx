import { useNavigate } from 'react-router-dom';
import { useTranslation } from '../../lib/i18n';
import { Icon } from '../Icon';
import { GlassCard } from '../../pages/insights/shared';
import { ROUTES, toPath } from '../../constants/routes';
import type { TagReportMetricTrack, ConfidenceTier } from '../../types/tagReport';

// Local color map — deliberately NOT `insights/shared.tsx`'s LAYER_CONFIG,
// per TRACKER.md's Component Reuse Ledger: GroupReportPage's own LAYER_COLOR
// hex values are the ones this feature must match.
const METRIC_COLOR: Record<string, string> = {
  nps: '#2a4bd9',
  csat: '#8b5cf6',
  ces: '#059669',
};

const TIER_COLOR: Record<ConfidenceTier, string> = {
  high: '#059669',
  medium: '#d97706',
  low: '#d97706',
  severe: '#dc2626',
  insufficient: '#d97706',
};

// Fixed 2026-07-03 (customer-journey review finding): warning_type is a bare
// string off the wire (crystalos/graphs/tag_report.py's warning_type values) —
// only known values get a real sentence via tagReport.metricCard.warningType.*;
// anything else falls back to the 'unknown' key rather than rendering the raw
// snake_case identifier.
const KNOWN_WARNING_TYPES = new Set([
  'temporal_offset', 'staleness', 'question_type_mismatch', 'scale_mismatch', 'cadence_mismatch',
]);
function warningTypeKey(warningType: string): string {
  return KNOWN_WARNING_TYPES.has(warningType) ? warningType : 'unknown';
}

interface MetricHeadlineCardProps {
  track: TagReportMetricTrack;
  tagId: string;
}

export function MetricHeadlineCard({ track, tagId }: MetricHeadlineCardProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const color = METRIC_COLOR[track.metric_key] ?? '#64748b';
  const tierColor = track.confidence_tier ? TIER_COLOR[track.confidence_tier] : '#64748b';

  return (
    <GlassCard
      className="p-5 relative overflow-hidden"
      style={track.single_survey_sourced ? { borderTop: '3px solid #d97706' } : undefined}
    >
      <div className="flex items-center gap-2 mb-3">
        <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: color }} />
        <span className="text-xs font-bold uppercase tracking-wide" style={{ color }}>
          {t(`tagReport.metricCard.metricLabel.${track.metric_key}`)}
        </span>
        {track.single_survey_sourced && (
          <span
            className="text-[11px] font-semibold px-2 py-0.5 rounded-full ml-auto"
            style={{ background: '#fef3c7', color: '#d97706' }}
          >
            {t('tagReport.metricCard.singleSurveySourced')}
          </span>
        )}
      </div>

      <h3 className="text-lg font-black font-headline text-on-surface mb-2 leading-snug">
        {track.headline}
      </h3>

      {track.single_survey_sourced && track.single_survey_name && (
        <p className="text-xs text-on-surface-variant mb-2">
          {t('tagReport.metricCard.singleSurveyNamed', { name: track.single_survey_name })}
        </p>
      )}

      {track.trust_score != null && (
        <div className="flex items-center gap-2 mb-3">
          <span className="text-xs text-on-surface-variant shrink-0">
            {t('tagReport.metricCard.trendEligibleSurveys', { count: track.eligible_survey_count })}
          </span>
          <div className="h-1 flex-1 rounded-full bg-border overflow-hidden">
            <div className="h-full rounded-full" style={{ width: `${track.trust_score}%`, background: color }} />
          </div>
          {track.confidence_tier && (
            <span className="text-[10px] font-bold shrink-0" style={{ color: tierColor }}>
              {t(`tagReport.metricCard.confidence.${track.confidence_tier}`)}
            </span>
          )}
        </div>
      )}

      {track.warnings.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-3">
          {track.warnings.map((w, i) => (
            <span
              key={i}
              className="text-[11px] font-semibold px-2 py-0.5 rounded-full"
              style={{ background: '#fef3c7', color: '#d97706' }}
              title={t(`tagReport.metricCard.warningType.${warningTypeKey(w.warning_type)}`)}
            >
              <Icon name="warning" size={11} className="inline mr-1 align-text-bottom" />
              {t(`tagReport.metricCard.warningType.${warningTypeKey(w.warning_type)}`)}
            </span>
          ))}
        </div>
      )}

      {track.corroborated_with && track.corroborated_with.length > 0 && (
        <p className="text-xs text-emerald-700 mb-2 flex items-center gap-1">
          <Icon name="link" size={12} />
          {t('tagReport.metricCard.corroboratedWith', {
            metric: track.corroborated_with.map((m) => t(`tagReport.metricCard.metricLabel.${m}`)).join(', '),
          })}
        </p>
      )}

      <p className="text-sm text-on-surface-variant leading-relaxed mb-3">{track.narrative}</p>

      {track.citations.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-3">
          {track.citations.slice(0, 4).map((c, i) => (
            c.survey_id ? (
              <button
                key={i}
                type="button"
                onClick={() => navigate(toPath(ROUTES.RESPONSE_DETAIL, { surveyId: c.survey_id, responseId: c.response_id }))}
                className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-muted/60 hover:bg-muted text-on-surface transition-colors"
              >
                {t('tagReport.citation.viewResponse')}
              </button>
            ) : (
              // Legacy citation missing survey_id (Task 16) — non-clickable plain text.
              <span key={i} className="text-[11px] px-2 py-0.5 rounded-full bg-muted/40 text-on-surface-variant">
                "{c.quote}"
              </span>
            )
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={() => navigate(toPath(ROUTES.TAG_REPORT_TRAIL, { tagId }))}
        className="text-xs font-semibold flex items-center gap-1 hover:underline"
        style={{ color }}
      >
        {t('tagReport.trailEntry.cta')}
        <Icon name="arrow_forward" size={12} />
      </button>
    </GlassCard>
  );
}
