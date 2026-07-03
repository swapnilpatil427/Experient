// InsightDocumentCard — Insight Pipeline v2, Phase 6 (07_CRYSTAL_INTEGRATION §3)
//
// Rendered inside CrystalPanel when a Crystal tool result/citation carries
// render_hint === 'document'. Shows a compact report summary (headline + meta +
// first-N-char executive summary + emerged/declining topics) and an
// "Open full report →" link to the in-app report route. Long content is NOT
// inlined in chat — summary + link only (performance, per the design doc).

import { Link } from 'react-router-dom';
import { Icon } from '../Icon';
import { useTranslation } from '../../lib/i18n';

export interface InsightDocument {
  /** "Insight Report · Checkpoint #14" or similar. */
  title?: string | null;
  run_mode?: string | null;          // 'automated_incremental' | 'manual_expert' | …
  created_at?: string | null;
  executive_summary?: string | null;
  nps?: number | string | null;
  nps_delta?: number | string | null;
  new_response_count?: number | string | null;
  insights_count?: number | string | null;
  emerged_topics?: string[] | null;
  declining_topics?: string[] | null;
  /** In-app deep link to the report viewer. */
  document_url?: string | null;
}

const SUMMARY_CHARS = 400;

function fmtDate(iso?: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function InsightDocumentCard({ doc }: { doc: InsightDocument }) {
  const { t } = useTranslation();

  const isManual = typeof doc.run_mode === 'string' && doc.run_mode.startsWith('manual');
  const laneLabel = isManual ? t('surveyInsights.documentCard.manual') : t('surveyInsights.documentCard.automated');
  const dateLabel = fmtDate(doc.created_at);
  const title = doc.title || t('surveyInsights.documentCard.reportLabel');

  const npsNum = doc.nps != null ? Number(doc.nps) : null;
  const deltaNum = doc.nps_delta != null ? Number(doc.nps_delta) : null;
  const npsText = npsNum != null && !Number.isNaN(npsNum)
    ? `NPS ${Math.round(npsNum)}${deltaNum != null && !Number.isNaN(deltaNum)
        ? ` (${deltaNum >= 0 ? '+' : '−'}${Math.abs(deltaNum).toFixed(1)})`
        : ''}`
    : '—';
  const responses = doc.new_response_count != null ? Number(doc.new_response_count) : 0;
  const insightsCount = doc.insights_count != null ? Number(doc.insights_count) : 0;

  const summary = (doc.executive_summary ?? '').trim();
  const summaryShort = summary.length > SUMMARY_CHARS ? summary.slice(0, SUMMARY_CHARS).trimEnd() + '…' : summary;

  const emerged = (doc.emerged_topics ?? []).filter(Boolean);
  const declining = (doc.declining_topics ?? []).filter(Boolean);

  return (
    <div
      className="rounded-2xl overflow-hidden border"
      style={{ borderColor: 'color-mix(in srgb, var(--color-primary) 18%, transparent)', background: 'var(--color-surface-container, color-mix(in srgb, var(--color-primary) 3%, transparent))' }}
    >
      {/* Header */}
      <div
        className="px-4 py-2.5 flex items-center gap-2"
        style={{ background: 'color-mix(in srgb, var(--color-primary) 7%, transparent)', borderBottom: '1px solid color-mix(in srgb, var(--color-primary) 12%, transparent)' }}
      >
        <Icon name="description" size={16} style={{ color: 'var(--color-primary)' }} />
        <span className="text-[12px] font-bold text-on-surface truncate">{title}</span>
        <span
          className="ml-auto text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full flex-shrink-0"
          style={{ background: 'color-mix(in srgb, var(--color-primary) 10%, transparent)', color: 'var(--color-primary)' }}
        >
          {laneLabel}
        </span>
      </div>

      {/* Meta line */}
      <div className="px-4 pt-3">
        <div className="text-[11px] font-mono text-on-surface-variant">
          {t('surveyInsights.documentCard.metaLine', {
            nps: npsText,
            responses,
            insights: insightsCount,
          })}
          {dateLabel ? ` · ${dateLabel}` : ''}
        </div>
      </div>

      {/* Executive summary */}
      {summaryShort && (
        <p className="px-4 pt-2 text-[12px] text-on-surface leading-relaxed">{summaryShort}</p>
      )}

      {/* Emerged / declining */}
      {(emerged.length > 0 || declining.length > 0) && (
        <div className="px-4 pt-2 flex flex-col gap-1">
          {emerged.length > 0 && (
            <div className="text-[11px] text-emerald-700">
              {t('surveyInsights.documentCard.emerged', { topics: emerged.join(' · ') })}
            </div>
          )}
          {declining.length > 0 && (
            <div className="text-[11px] text-rose-700">
              {t('surveyInsights.documentCard.declining', { topics: declining.join(' · ') })}
            </div>
          )}
        </div>
      )}

      {/* CTA */}
      {doc.document_url && (
        <div className="px-4 py-3">
          <Link
            to={doc.document_url}
            className="inline-flex items-center gap-1 text-[12px] font-bold hover:underline"
            style={{ color: 'var(--color-primary)' }}
          >
            {t('surveyInsights.documentCard.openReport')}
            <Icon name="arrow_forward" size={13} />
          </Link>
        </div>
      )}
    </div>
  );
}
