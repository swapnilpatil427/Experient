import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useTranslation } from '../../lib/i18n';
import { useApi } from '../../hooks/useApi';
import { useTagReport } from '../../hooks/useTagReport';
import { useSetPageTitle } from '../../contexts/pageTitle';
import { useCrystalPanel } from '../../contexts/crystalPanel';
import { Icon } from '../../components/Icon';
import { Button } from '@/components/ui/button';
import { PageHeader } from '../../components/PageHeader';
import { ROUTES, toPath } from '../../constants/routes';
import { PipelineVisualization } from '../../components/tag-report/PipelineVisualization';
import { DisclosureBanner } from '../../components/tag-report/DisclosureBanner';
import { MetricHeadlineCard } from '../../components/tag-report/MetricHeadlineCard';
import { ComparisonWaveCard } from '../../components/tag-report/ComparisonWaveCard';
import { TrailEntryPoint } from '../../components/tag-report/TrailEntryPoint';
import { InFlightRunBanner } from '../../components/tag-report/InFlightRunBanner';

const stagger = { hidden: {}, visible: { transition: { staggerChildren: 0.07 } } };
const rise = {
  hidden:  { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.45, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] } },
};

/**
 * Final Tag Report page — mounted at both `TAG_REPORT_LATEST` (no :runId,
 * resolves to the most recent run) and `TAG_REPORT` (specific :runId).
 * Structure mirrors `GroupReportPage.tsx`'s run-resolution/polling pattern.
 */
export function TagReportPage() {
  const { t } = useTranslation();
  const { tagId, runId } = useParams<{ tagId: string; runId?: string }>();
  const navigate = useNavigate();
  const api = useApi();
  const { setScope } = useCrystalPanel();
  const [tagName, setTagName] = useState<string | null>(null);

  const {
    run, metricTracks, sources, poolSize, examinedCount, includedCount, backfillOccurred,
    loading, error, inFlightNotice, dismissInFlightNotice,
  } = useTagReport(tagId, runId);

  useSetPageTitle(tagName ? t('groups.groupReportTitle', { name: tagName }) : t('tagReport.new.title'));

  useEffect(() => {
    if (tagId) setScope(tagId);
    return () => { setScope('all'); };
  }, [tagId, setScope]);

  useEffect(() => {
    if (!tagId) return;
    api.getTagSurveys(tagId).then((res) => setTagName(res.tag.name)).catch(() => {});
  }, [tagId, api]);

  // "Latest" mode: once resolved, canonicalize the URL to the specific run.
  useEffect(() => {
    if (!runId && run && tagId) {
      navigate(toPath(ROUTES.TAG_REPORT, { tagId, runId: run.id }), { replace: true });
    }
  }, [runId, run, tagId, navigate]);

  const crumbs = [
    { label: t('tagReport.breadcrumbs.experience'), path: ROUTES.EXPERIENCE },
    { label: t('tagReport.breadcrumbs.reports'), path: ROUTES.TAG_REPORTS_INDEX },
    { label: tagName ?? t('tagReport.new.title') },
  ];

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto w-full flex items-center justify-center py-32">
        <div className="w-10 h-10 rounded-full border-2 animate-spin"
          style={{ borderColor: 'color-mix(in srgb, var(--color-primary) 20%, transparent)', borderTopColor: 'var(--color-primary)' }} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-7xl mx-auto w-full">
        <PageHeader crumbs={crumbs} title={tagName ?? t('tagReport.new.title')} />
        <div className="banner-error mt-4">{error}</div>
      </div>
    );
  }

  if (!run) {
    return (
      <div className="max-w-7xl mx-auto w-full">
        <PageHeader crumbs={crumbs} title={tagName ?? t('tagReport.new.title')} />
        <div className="rounded-xl border border-border p-12 text-center">
          <Icon name="analytics" size={40} className="text-muted-foreground mx-auto mb-4" />
          <p className="text-on-surface-variant mb-4">{t('tagReport.new.noRunsYet')}</p>
          <Button
            onClick={() => tagId && navigate(toPath(ROUTES.TAG_REPORT_NEW, { tagId }))}
            style={{ background: 'var(--color-primary)' }}
          >
            {t('tagReport.new.manualCta')}
          </Button>
        </div>
      </div>
    );
  }

  const isStreaming = run.status === 'pending' || run.status === 'running';
  const isFailed = run.status === 'failed';
  const isCustomRange = run.run_mode === 'custom_range';
  const sortedTracks = [...metricTracks].sort(
    (a, b) => Number(b.single_survey_sourced) - Number(a.single_survey_sourced)
  );

  return (
    <div className="max-w-7xl mx-auto w-full">
      <PageHeader
        crumbs={crumbs}
        title={tagName ? t('groups.groupReportTitle', { name: tagName }) : t('tagReport.new.title')}
      />

      {inFlightNotice && <InFlightRunBanner notice={inFlightNotice} onDismiss={dismissInFlightNotice} />}

      <PipelineVisualization events={run.stream_events} collapsed={!isStreaming} />

      {isFailed && (
        <div className="banner-error mt-4">
          {(run.stream_events.find((e) => e.event === 'run_failed') as { error?: string } | undefined)?.error
            ?? t('tagReport.new.errorGeneric')}
        </div>
      )}

      {!isStreaming && !isFailed && (
        <motion.div variants={stagger} initial="hidden" animate="visible" className="space-y-6">
          <motion.div variants={rise}>
            <DisclosureBanner
              poolSize={poolSize}
              examinedCount={examinedCount}
              includedCount={includedCount}
              backfillOccurred={backfillOccurred}
              sources={sources}
            />
          </motion.div>

          <motion.div variants={rise} className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {sortedTracks.map((track) => (
              <MetricHeadlineCard key={track.metric_key} track={track} tagId={tagId!} />
            ))}
          </motion.div>

          {isCustomRange && sortedTracks.length > 0 && (
            <motion.div variants={rise} className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {sortedTracks.map((track) => (
                <ComparisonWaveCard key={track.metric_key} track={track} />
              ))}
            </motion.div>
          )}

          <motion.div variants={rise}>
            <TrailEntryPoint tagId={tagId!} />
          </motion.div>
        </motion.div>
      )}
    </div>
  );
}
