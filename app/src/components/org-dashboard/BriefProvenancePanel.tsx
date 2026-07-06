// BriefProvenancePanel — "How was this generated?", the audit/provenance
// sibling to `CheckpointDiffPanel`'s "Compare to previous", nested inside the
// same already-expanded `BriefArchive` entry (same 200ms inline-expand
// pattern, lazy-fetched on click via `useOrgBriefDetail`).
//
// Unlike `CrystalBriefCard` (a verdict surface, per Decision 16 never shows a
// "pass" trust badge inline), this IS an audit surface — the full 3-pass
// trust breakdown is shown plainly here, reusing `ConfidenceChip`'s existing
// trust-tier visual language (never inventing new colors) and this feature's
// own "Crystal's best read" / "Early read" copy (never "hallucination" /
// "low confidence" / "unverified", even in this audit view).

import { Link } from 'react-router-dom';
import { Icon } from '../Icon';
import { useTranslation } from '../../lib/i18n';
import { ROUTES, toPath } from '../../constants/routes';
import { useOrgBriefDetail } from '../../hooks/useOrgDashboard';
import { SourcePill } from './SourcePill';
import { ConfidenceChip } from '../../pages/insights/shared';
import type { OrgBriefDetail, TrustVerdict } from '../../types/orgDashboard';

const ACTION_ICON: Record<string, string> = {
  investigate: 'search',
  review: 'bar_chart',
  celebrate: 'star',
  monitor: 'visibility',
};

function relativeTime(iso: string | null): string | null {
  if (!iso) return null;
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function dateRangeLabel(start: string, end: string): string {
  const s = new Date(start), e = new Date(end);
  const fmt = (d: Date) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${fmt(s)}–${fmt(e)}, ${e.getFullYear()}`;
}

function topicSentimentDotColor(avgSentiment: number): string {
  if (avgSentiment > 0.3) return '#22c55e';
  if (avgSentiment < -0.3) return '#ef4444';
  return '#94a3b8';
}

function verdictCopyKey(verdict: TrustVerdict): string {
  if (verdict === 'pass') return 'orgDashboard.trust.bestRead';
  if (verdict === 'fail') return 'orgDashboard.trust.earlyReadWhole';
  return 'orgDashboard.trust.earlyRead';
}

function WhatCrystalLookedAt({ detail }: { detail: OrgBriefDetail }) {
  const { t } = useTranslation();
  const snap = detail.inputSnapshot;
  if (!snap) return null;

  return (
    <div>
      <div className="text-[10px] font-black uppercase tracking-widest text-on-surface-variant mb-2">
        {t('orgDashboard.briefProvenance.whatCrystalLookedAt')}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <div>
          <div className="text-[10px] text-gray-400">{t('orgDashboard.briefProvenance.dateRange')}</div>
          <div className="text-sm font-semibold">{dateRangeLabel(snap.date_range_start, snap.date_range_end)}</div>
        </div>
        <div>
          <div className="text-[10px] text-gray-400">{t('orgDashboard.briefProvenance.totalResponses')}</div>
          <div className="text-sm font-semibold tabular-nums">{snap.total_responses.toLocaleString()}</div>
        </div>
        <div>
          <div className="text-[10px] text-gray-400">{t('orgDashboard.briefProvenance.activeSurveys')}</div>
          <div className="text-sm font-semibold tabular-nums">{snap.active_surveys}</div>
        </div>
        <div>
          <div className="text-[10px] text-gray-400">{t('orgDashboard.briefProvenance.avgNps')}</div>
          <div className="text-sm font-semibold tabular-nums">
            {snap.avg_nps}
            {snap.nps_wow_delta != null && (
              <span className="text-xs text-gray-400 ml-1">
                {t('orgDashboard.kpis.wowDelta', { sign: snap.nps_wow_delta >= 0 ? '+' : '', value: String(snap.nps_wow_delta) })}
              </span>
            )}
          </div>
        </div>
        <div>
          <div className="text-[10px] text-gray-400">{t('orgDashboard.briefProvenance.avgSentiment')}</div>
          <div className="text-sm font-semibold tabular-nums">
            {snap.avg_sentiment.toFixed(2)}
            {snap.sentiment_wow_delta != null && (
              <span className="text-xs text-gray-400 ml-1">
                {t('orgDashboard.kpis.wowDelta', { sign: snap.sentiment_wow_delta >= 0 ? '+' : '', value: snap.sentiment_wow_delta.toFixed(2) })}
              </span>
            )}
          </div>
        </div>
      </div>

      {snap.no_comparable_prior_period && (
        <p className="text-xs text-gray-400 mt-2">{t('orgDashboard.briefProvenance.noComparablePriorPeriod')}</p>
      )}

      {snap.top_topics.length > 0 && (
        <div className="mt-3">
          <div className="text-[10px] text-gray-400 mb-1">{t('orgDashboard.briefProvenance.topTopics')}</div>
          <ul className="space-y-1">
            {snap.top_topics.slice(0, 5).map((topic) => (
              <li key={topic.topic_label} className="flex items-center gap-2 text-sm">
                <span
                  className="w-2 h-2 rounded-full flex-shrink-0"
                  style={{ background: topicSentimentDotColor(topic.avg_sentiment) }}
                  aria-hidden="true"
                />
                <span className="text-gray-800">{topic.topic_label}</span>
                {topic.is_new_this_week && (
                  <span className="text-[10px] font-bold text-blue-500">{t('orgDashboard.briefProvenance.newThisWeek')}</span>
                )}
                <span className="text-xs text-gray-400 ml-auto tabular-nums">{topic.frequency}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function WhatCrystalRecommended({ detail }: { detail: OrgBriefDetail }) {
  const { t } = useTranslation();
  if (detail.recommendations.length === 0) {
    return (
      <div>
        <div className="text-[10px] font-black uppercase tracking-widest text-on-surface-variant mb-2">
          {t('orgDashboard.briefProvenance.whatCrystalRecommended')}
        </div>
        <p className="text-sm text-gray-400">{t('orgDashboard.briefProvenance.noRecommendations')}</p>
      </div>
    );
  }
  return (
    <div>
      <div className="text-[10px] font-black uppercase tracking-widest text-on-surface-variant mb-2">
        {t('orgDashboard.briefProvenance.whatCrystalRecommended')}
      </div>
      <ol className="space-y-3">
        {detail.recommendations.map((rec) => (
          <li key={rec.rank} className="flex items-start gap-3">
            <span className="w-5 h-5 rounded-full bg-indigo-600 text-white text-[10px] font-black flex items-center justify-center flex-shrink-0 mt-0.5">
              {rec.rank}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 flex-wrap">
                <Icon name={ACTION_ICON[rec.actionType] ?? 'flag'} size={13} style={{ color: '#6366f1' }} />
                {rec.surveyId ? (
                  <Link to={toPath(ROUTES.EXPERIENCE_SURVEY, { surveyId: rec.surveyId })} className="text-sm font-medium text-indigo-700 underline underline-offset-2">
                    {rec.action}
                  </Link>
                ) : (
                  <span className="text-sm font-medium text-gray-800">{rec.action}</span>
                )}
              </div>
              <p className="text-sm text-gray-500 mt-0.5">{rec.rationale}</p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function TrustBreakdown({ detail }: { detail: OrgBriefDetail }) {
  const { t } = useTranslation();
  const trust = detail.trustJson;
  if (!trust) return null;
  const pass12 = trust.pass_1_2_numeric_and_llm_grounding;
  const failures = trust.pass_3_grounding_completeness?.grounding_failures ?? [];

  return (
    <div>
      <div className="text-[10px] font-black uppercase tracking-widest text-on-surface-variant mb-2">
        {t('orgDashboard.briefProvenance.trustTitle')}
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        {/* pass12.score is 0.0-1.0 (hallucination_scorer.py's native scale — "higher =
            less hallucination"); ConfidenceChip's tiers expect 0-100 (>=80/>=60/else),
            matching the same *100 scaling this codebase already applies to
            hallucination_score elsewhere (org-metrics.service.ts's mapCrystalBriefRow/
            getBriefDetail). Passing the raw 0-1 value through made every real score
            round down into the lowest tier regardless of actual trust level. */}
        <ConfidenceChip value={Math.round(pass12.score * 100)} />
        <span className="text-xs text-gray-500">{t(verdictCopyKey(pass12.verdict))}</span>
      </div>
      {pass12.issues.length > 0 && (
        <ul className="mt-2 space-y-1 list-disc list-inside">
          {pass12.issues.map((issue, i) => (
            <li key={i} className="text-xs text-gray-500">{issue}</li>
          ))}
        </ul>
      )}
      <p className="text-xs text-gray-400 mt-2">
        {t('orgDashboard.briefProvenance.citedInsights', { n: String(trust.cited_insight_count) })}
      </p>
      {failures.length > 0 && (
        <div className="mt-3">
          <div className="text-[10px] text-gray-400 mb-1">{t('orgDashboard.briefProvenance.flaggedClauses')}</div>
          <ul className="space-y-2">
            {failures.map((f, i) => (
              <li key={i} className="text-xs">
                <span className="text-gray-700 italic">&ldquo;{f.clause}&rdquo;</span>
                <span className="text-gray-400"> — {f.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function BriefProvenancePanel({ briefId }: { briefId: string }) {
  const { t } = useTranslation();
  const { data: detail, loading, error } = useOrgBriefDetail(briefId);

  if (error) {
    return (
      <div className="p-5 rounded-xl border border-outline-variant/20 mt-3">
        <p className="text-sm text-on-surface-variant">{t('orgDashboard.briefProvenance.loadError')}</p>
      </div>
    );
  }

  if (loading || !detail) {
    return (
      <div className="p-5 rounded-xl border border-outline-variant/20 mt-3 space-y-3">
        <div className="h-16 rounded-lg bg-surface-container animate-pulse" />
        <div className="h-16 rounded-lg bg-surface-container animate-pulse" />
      </div>
    );
  }

  return (
    <div className="p-5 rounded-xl border border-outline-variant/20 mt-3 bg-white space-y-5">
      {/* Generation source & model */}
      <div className="flex items-center gap-3 flex-wrap">
        <SourcePill source={detail.source} />
        {detail.modelVersion && <span className="text-xs text-gray-500">{detail.modelVersion}</span>}
        {relativeTime(detail.generatedAt) && (
          <span className="text-xs text-gray-400">{t('orgDashboard.crystalBrief.lastUpdated', { time: relativeTime(detail.generatedAt) as string })}</span>
        )}
      </div>

      <WhatCrystalLookedAt detail={detail} />
      <WhatCrystalRecommended detail={detail} />
      <TrustBreakdown detail={detail} />

      {detail.parentCheckpointId && (
        <p className="text-xs text-gray-400 flex items-center gap-1.5">
          <Icon name="link" size={12} />
          {t('orgDashboard.briefProvenance.lineageNote')}
        </p>
      )}
    </div>
  );
}
