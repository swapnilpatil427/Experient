import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useTranslation } from '../../lib/i18n';
import { useSetPageTitle } from '../../contexts/pageTitle';
import { useApi } from '../../hooks/useApi';
import { PageHeader } from '../../components/PageHeader';
import { AdminSupportNav } from '../../components/AdminSupportNav';
import { Icon } from '../../components/Icon';
import { Button } from '@/components/ui/button';
import { PipelineStats as PipelineStatsComponent } from '../../components/admin/PipelineStats';
import { ROUTES } from '../../constants/routes';
import type { PipelineStats } from '../../lib/api';

type DateRange = '7d' | '30d' | '90d';

const DATE_RANGES: Array<{ key: DateRange; label: string }> = [
  { key: '7d',  label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: '90d', label: 'Last 90 days' },
];

const EASE = [0.22, 1, 0.36, 1] as const;

function buildCsvFromStats(stats: PipelineStats): string {
  const rows: string[][] = [];
  rows.push(['Metric', 'Value']);
  rows.push(['Docs Live', String(stats.docsLive)]);
  rows.push(['Published Today', String(stats.publishedToday)]);
  rows.push(['Gaps Open', String(stats.gapsOpen)]);
  rows.push(['Avg Quality Score', (stats.avgQualityScore * 100).toFixed(1) + '%']);
  rows.push([]);
  rows.push(['Status', 'Count']);
  for (const [status, count] of Object.entries(stats.statusDistribution)) {
    rows.push([status.replace(/_/g, ' '), String(count)]);
  }
  rows.push([]);
  rows.push(['Quality Bucket', 'Count']);
  for (const bucket of stats.qualityHistogram) {
    rows.push([bucket.bucket, String(bucket.count)]);
  }
  return rows.map((r) => r.map((cell) => `"${cell}"`).join(',')).join('\n');
}

function downloadCsv(csv: string, filename: string) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function PipelineStatsPage() {
  const { t } = useTranslation();
  useSetPageTitle(t('admin.docPipeline.pipelineStats'), t('admin.docPipeline.statsSubtitle'));

  const api = useApi();
  const [searchParams, setSearchParams] = useSearchParams();
  const range = (searchParams.get('range') as DateRange) ?? '30d';

  const [stats, setStats]       = useState<PipelineStats | null>(null);
  const [loading, setLoading]   = useState(true);

  const loadStats = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.adminSupportGetStats();
      setStats(res);
    } catch {
      // silently ignore — page shows empty state
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { void loadStats(); }, [loadStats]);

  const handleRangeChange = (r: DateRange) => {
    setSearchParams({ range: r });
    void loadStats();
  };

  const handleExport = () => {
    if (!stats) return;
    const csv = buildCsvFromStats(stats);
    downloadCsv(csv, `pipeline-stats-${range}-${new Date().toISOString().slice(0, 10)}.csv`);
  };

  return (
    <div className="max-w-7xl mx-auto w-full">
      <PageHeader
        crumbs={[
          { label: t('nav.settings'), path: ROUTES.SETTINGS },
          { label: t('admin.docPipeline.title'), path: ROUTES.ADMIN_SUPPORT_PIPELINE },
          { label: t('admin.docPipeline.pipelineStats') },
        ]}
        title={t('admin.docPipeline.pipelineStats')}
        subtitle={t('admin.docPipeline.statsSubtitle')}
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleExport}
              disabled={!stats}
            >
              <Icon name="download" size={16} className="mr-1.5" />
              {t('admin.docPipeline.exportCsv')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => { void loadStats(); }}
            >
              <Icon name="refresh" size={16} className="mr-1.5" />
              {t('common.refresh')}
            </Button>
          </div>
        }
      />

      <AdminSupportNav />

      {/* ── Date range selector ───────────────────────────────────────────── */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: EASE }}
        className="flex gap-1 mb-6"
      >
        {DATE_RANGES.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => handleRangeChange(key)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              range === key
                ? 'text-white'
                : 'text-gray-500 hover:text-gray-700 hover:bg-black/5'
            }`}
            style={range === key ? { background: 'var(--color-primary)' } : undefined}
          >
            {label}
          </button>
        ))}
      </motion.div>

      {/* ── Content ────────────────────────────────────────────────────────── */}
      {loading ? (
        <div className="flex items-center justify-center py-32">
          <div
            className="w-8 h-8 rounded-full border-2 animate-spin"
            style={{ borderColor: 'color-mix(in srgb, var(--color-primary) 20%, transparent)', borderTopColor: 'var(--color-primary)' }}
          />
        </div>
      ) : stats ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.3, ease: EASE }}
        >
          <PipelineStatsComponent stats={stats} />
        </motion.div>
      ) : (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <Icon name="bar_chart" size={40} className="text-gray-300 mb-3" />
          <p className="text-gray-500">{t('admin.docPipeline.noStatsData')}</p>
        </div>
      )}
    </div>
  );
}
