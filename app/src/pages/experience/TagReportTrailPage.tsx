import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from '../../lib/i18n';
import { useApi } from '../../hooks/useApi';
import { useTagReportTrail } from '../../hooks/useTagReport';
import { useSetPageTitle } from '../../contexts/pageTitle';
import { useCrystalPanel } from '../../contexts/crystalPanel';
import { Icon } from '../../components/Icon';
import { PageHeader } from '../../components/PageHeader';
import { GlassCard } from '../insights/shared';
import { ROUTES, toPath } from '../../constants/routes';

/**
 * Full audit trail (R-T5) — every checkpoint, survey, and exclusion behind a
 * tag's reports, with drill-down to the cited response. Route is tag-scoped
 * (`TAG_REPORT_TRAIL`); the underlying trail data is keyed by run, so this
 * page resolves the tag's most recent run first, then loads its trail.
 */
export function TagReportTrailPage() {
  const { t } = useTranslation();
  const { tagId } = useParams<{ tagId: string }>();
  const navigate = useNavigate();
  const api = useApi();
  const { setCrystalCtx } = useCrystalPanel();
  const [latestRunId, setLatestRunId] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    if (!tagId) return;
    api.getTagReportHistory(tagId, { limit: 1 })
      .then((h) => setLatestRunId(h.runs[0]?.run_id ?? null))
      .catch(() => setLatestRunId(null));
  }, [tagId, api]);

  const { tagName, runs, sources, loading, error } = useTagReportTrail(latestRunId ?? undefined);

  // Auto-scope Crystal to this tag via the additive crystalCtx bag (never via
  // `scope`/`setScope` — a tag_id is not a survey_id). Mirrors TagReportPage.tsx.
  useEffect(() => {
    if (!tagId) return;
    setCrystalCtx({ focused_tag_id: tagId, focused_tag_name: tagName ?? undefined });
    return () => setCrystalCtx({});
  }, [tagId, tagName, setCrystalCtx]);

  useSetPageTitle(t('tagReport.trailPage.title'));

  const crumbs = [
    { label: t('tagReport.breadcrumbs.experience'), path: ROUTES.EXPERIENCE },
    { label: t('tagReport.breadcrumbs.reports'), path: ROUTES.TAG_REPORTS_INDEX },
    { label: tagName ?? t('tagReport.trailPage.title') },
    { label: t('tagReport.trailPage.title') },
  ];

  if (latestRunId === undefined || loading) {
    return (
      <div className="max-w-5xl mx-auto w-full flex items-center justify-center py-32">
        <div className="w-10 h-10 rounded-full border-2 animate-spin"
          style={{ borderColor: 'color-mix(in srgb, var(--color-primary) 20%, transparent)', borderTopColor: 'var(--color-primary)' }} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-5xl mx-auto w-full">
        <PageHeader crumbs={crumbs} title={t('tagReport.trailPage.title')} />
        <div className="banner-error mt-4">{error}</div>
      </div>
    );
  }

  if (!latestRunId) {
    return (
      <div className="max-w-5xl mx-auto w-full">
        <PageHeader crumbs={crumbs} title={t('tagReport.trailPage.title')} />
        <div className="rounded-xl border border-border p-12 text-center text-on-surface-variant">
          {t('tagReport.trailPage.noRuns')}
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto w-full">
      <PageHeader
        crumbs={crumbs}
        title={t('tagReport.trailPage.title')}
        subtitle={tagName ? t('tagReport.trailPage.subtitle', { tagName }) : undefined}
      />

      <div className="space-y-6">
        <section>
          <h2 className="text-sm font-bold font-headline text-on-surface mb-3">{t('tagReport.trailPage.runHistoryHeading')}</h2>
          <div className="space-y-2">
            {runs.map((r) => (
              <GlassCard key={r.run_id} className="p-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  <Icon name="history" size={16} className="text-muted-foreground shrink-0" />
                  <span className="text-sm text-on-surface truncate">{new Date(r.created_at).toLocaleString()}</span>
                  <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-muted/60 text-on-surface-variant shrink-0">
                    {r.run_mode}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => tagId && navigate(toPath(ROUTES.TAG_REPORT, { tagId, runId: r.run_id }))}
                  className="text-xs font-semibold hover:underline shrink-0"
                  style={{ color: 'var(--color-primary)' }}
                >
                  {t('common.back')} → {r.metric_tracks_narrated}
                </button>
              </GlassCard>
            ))}
            {runs.length === 0 && (
              <p className="text-sm text-on-surface-variant">{t('tagReport.trailPage.noRuns')}</p>
            )}
          </div>
        </section>

        <section>
          <h2 className="text-sm font-bold font-headline text-on-surface mb-3">{t('tagReport.trailPage.sourcesHeading')}</h2>
          <div className="space-y-2">
            {sources.map((s) => (
              <GlassCard key={s.id} className="p-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm text-on-surface truncate">{s.survey_title ?? s.survey_id}</p>
                  <p className="text-xs text-on-surface-variant">
                    {s.trend_eligible ? t('tagReport.disclosure.responseCount', { count: s.response_count_at_generation }) : t('tagReport.metricCard.confidence.insufficient')}
                  </p>
                </div>
                {s.exclusion_reason && (
                  <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full shrink-0" style={{ background: '#fef3c7', color: '#d97706' }}>
                    {t(`tagReport.stream.excludedReason.${s.exclusion_reason}`)}
                  </span>
                )}
              </GlassCard>
            ))}
            {sources.length === 0 && (
              <p className="text-sm text-on-surface-variant">—</p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
