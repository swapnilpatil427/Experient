import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Icon } from '../../components/Icon';
import { Button } from '@/components/ui/button';
import { PageHeader } from '../../components/PageHeader';
import { ConnectorCard } from '../../components/prism/ConnectorCard';
import { useApi } from '../../hooks/useApi';
import { usePrismConnections } from '../../hooks/usePrismConnections';
import { useSetPageTitle } from '../../contexts/pageTitle';
import { useTranslation } from '../../lib/i18n';
import { ROUTES, toPath } from '../../constants/routes';
import { FileDropzone } from '../../components/prism/FileDropzone';
import type { FileDropzoneMeta } from '../../components/prism/FileDropzone';
import { invalidate } from '../../lib/dataBus';
import { DEFAULT_CONNECTORS, GROUP_ORDER, inferGroup, GLOBAL_IMPORT_ACCEPT } from './connectorCatalog';
import type { ConnectorMeta, ConnectorGroup, PrismJob, ResourceRef } from '../../types/prism';

const stagger = { hidden: {}, visible: { transition: { staggerChildren: 0.06 } } };
const rise = {
  hidden: { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.5, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] } },
};

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

const GROUP_LABEL: Record<ConnectorGroup, string> = {
  survey: 'prism.gallery.surveysGroup',
  reviews: 'prism.gallery.reviewsGroup',
  files: 'prism.gallery.filesGroup',
};

function PrismOrb() {
  return (
    <div style={{ width: 96, height: 96, position: 'relative', filter: 'drop-shadow(0 16px 36px color-mix(in srgb, var(--color-primary) 40%, transparent))' }} aria-hidden>
      <div style={{ position: 'absolute', inset: 0, background: 'conic-gradient(from 0deg at 50% 50%, var(--color-primary), var(--color-tertiary), var(--color-secondary), var(--color-tertiary), var(--color-primary))', clipPath: 'polygon(50% 0%, 100% 30%, 100% 70%, 50% 100%, 0% 70%, 0% 30%)', animation: 'exp-hub-spin 20s linear infinite', filter: 'blur(0.5px)' }} />
      <div style={{ position: 'absolute', inset: '38%', background: 'radial-gradient(circle, #ffffff, var(--color-secondary-container))', borderRadius: '50%', filter: 'blur(4px)', animation: 'pulse-glow 2.5s ease-in-out infinite' }} />
      <style>{`@keyframes exp-hub-spin { from { transform: rotate(0deg);} to { transform: rotate(360deg);} }`}</style>
    </div>
  );
}

export function PrismHomePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const api = useApi();
  useSetPageTitle(t('prism.title'), t('prism.tagline'));

  const { connections, jobs, loading } = usePrismConnections();
  const [registry, setRegistry] = useState<ConnectorMeta[]>(DEFAULT_CONNECTORS);
  const [importError, setImportError] = useState<string | null>(null);

  useEffect(() => {
    api.listPrismConnectors()
      .then((r) => {
        const live = r.connectors ?? [];
        if (!live.length) return; // keep the default catalog
        // File-import tiles are FE-owned presentation (5 distinct tiles carrying accept/
        // multiple/autodetect); the backend exposes the file connector as a single meta.
        // So: live registry drives survey/reviews; the Files group always comes from the catalog.
        const fileTiles = DEFAULT_CONNECTORS.filter((c) => inferGroup(c) === 'files');
        const nonFileLive = live.filter((c) => inferGroup(c) !== 'files');
        setRegistry([...nonFileLive, ...fileTiles]);
      })
      .catch(() => { /* keep default catalog */ });
  }, [api]);

  const grouped = useMemo(() => {
    const map: Record<ConnectorGroup, ConnectorMeta[]> = { survey: [], reviews: [], files: [] };
    registry.forEach((c) => { map[inferGroup(c)].push(c); });
    return map;
  }, [registry]);

  const recentJobs = jobs.slice(0, 5);
  const connectionLabel = (job: PrismJob) =>
    connections.find((c) => c.id === job.connection_id)?.label ?? job.connection_id;

  function handleConnect(meta: ConnectorMeta) {
    navigate(toPath(ROUTES.PRISM_CONNECT, { platform: meta.platform }));
  }

  /**
   * Global-import panel handler: upload any export(s), auto-detect format + source
   * platform per file, create ONE connection + a job whose resources are the uploaded
   * files, then drop straight into the wizard. (Replaces the old `file_auto` tile.)
   */
  async function handleGlobalImport(metas: FileDropzoneMeta[]) {
    if (metas.length === 0) return;
    setImportError(null);
    try {
      const { connection } = await api.createPrismConnection({
        platform: 'file_auto',
        authKind: 'file_upload',
        mode: 'ingest',
        history_window: 3,
        fileRef: metas[0].fileRef,
      });
      const resources: ResourceRef[] = metas.map((m) => ({
        kind: m.detectedFormat === 'qsf' ? 'survey_def' : 'response',
        id: m.fileRef,
        extra: { format: m.detectedFormat, platform: m.detectedPlatform },
      }));
      const { job } = await api.createPrismJob({ connectionId: connection.id, kind: 'migration', resources });
      invalidate('prism');
      navigate(toPath(ROUTES.PRISM_JOB, { jobId: job.id }));
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
    }
  }

  const hasConnectors = registry.length > 0;

  return (
    <div className="max-w-7xl mx-auto w-full">
      <PageHeader
        crumbs={[{ label: t('prism.title'), icon: 'auto_awesome_motion', path: ROUTES.PRISM }]}
        title={t('prism.title')}
        subtitle={t('prism.tagline')}
        actions={
          <Button variant="ghost" size="sm" className="rounded-xl gap-1.5" onClick={() => navigate(ROUTES.PRISM_JOBS)}>
            <Icon name="history" size={16} />{t('prism.recent.viewAll')}
          </Button>
        }
      />

      {/* Hero */}
      <motion.div
        initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        className="flex items-center gap-5 rounded-2xl p-5 mb-8"
        style={{ background: 'color-mix(in srgb, var(--color-primary) 5%, transparent)', border: '1px solid color-mix(in srgb, var(--color-primary) 14%, transparent)' }}
      >
        <PrismOrb />
        <p className="text-sm text-on-surface max-w-xl leading-relaxed">{t('prism.intro')}</p>
      </motion.div>

      {/* Global import — drop any export(s); we auto-detect format + source. Sits ABOVE the
          connector list (it is the global uploader panel, not a connector tile). */}
      <motion.section
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        className="mb-8"
        aria-label={t('prism.gallery.filesGroup')}
      >
        <FileDropzone
          accept={GLOBAL_IMPORT_ACCEPT}
          maxMb={60}
          multiple
          showDetected
          onUploaded={(_ref, meta) => { void handleGlobalImport([meta]); }}
          onUploadedMany={(metas) => { void handleGlobalImport(metas); }}
          onError={setImportError}
        />
        {importError && (
          <div className="mt-2 rounded-xl px-4 py-2.5 bg-destructive/10 text-destructive text-sm font-medium flex items-center gap-2">
            <Icon name="error" size={16} />{importError}
          </div>
        )}
      </motion.section>

      {/* Connector gallery */}
      {!hasConnectors && !loading ? (
        <div className="py-16 text-center">
          <div className="mx-auto mb-5 w-fit"><PrismOrb /></div>
          <h2 className="text-xl font-extrabold font-headline text-on-surface mb-2">{t('prism.gallery.emptyTitle')}</h2>
          <p className="text-sm text-on-surface-variant max-w-md mx-auto">{t('prism.gallery.emptyBody')}</p>
        </div>
      ) : (
        <div className="space-y-8">
          {GROUP_ORDER.map((group) => {
            const items = grouped[group];
            if (items.length === 0) return null;
            return (
              <section key={group}>
                <h2 className="text-xs font-black uppercase tracking-widest text-on-surface-variant mb-3">{t(GROUP_LABEL[group])}</h2>
                <motion.div
                  className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3"
                  variants={stagger} initial="hidden" animate="visible"
                >
                  {items.map((meta) => (
                    <ConnectorCard key={meta.platform} meta={meta} onConnect={handleConnect} />
                  ))}
                </motion.div>
              </section>
            );
          })}
        </div>
      )}

      {/* Recent imports */}
      <motion.section className="mt-10" variants={rise} initial="hidden" animate="visible">
        <h2 className="text-xs font-black uppercase tracking-widest text-on-surface-variant mb-3">{t('prism.recent.title')}</h2>
        {recentJobs.length === 0 ? (
          <p className="text-sm text-on-surface-variant">{t('prism.recent.empty')}</p>
        ) : (
          <div className="space-y-2">
            {recentJobs.map((job) => {
              const isComplete = job.status === 'complete';
              const isSyncing = job.status === 'running' || job.status === 'queued';
              const count = job.counts.loaded ?? job.counts.extracted ?? 0;
              return (
                <button
                  key={job.id}
                  onClick={() => navigate(toPath(ROUTES.PRISM_JOB, { jobId: job.id }))}
                  className="w-full flex items-center gap-3 rounded-xl px-4 py-3 text-left bg-white border border-border/50 hover:border-primary/30 transition-colors"
                >
                  <Icon
                    name={isComplete ? 'check_circle' : isSyncing ? 'sync' : 'pending'}
                    size={18}
                    fill={isComplete ? 1 : 0}
                    className={isComplete ? 'text-success' : isSyncing ? 'text-primary' : 'text-on-surface-variant'}
                  />
                  <span className="font-semibold text-sm text-on-surface truncate">{connectionLabel(job)}</span>
                  <span className="text-xs text-on-surface-variant ml-auto shrink-0">
                    {t(`prism.status.${job.status}`)} · {t('prism.recent.responsesCount', { count: count.toLocaleString() })} · {t('prism.recent.ago', { time: timeAgo(job.updated_at) })}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </motion.section>
    </div>
  );
}
