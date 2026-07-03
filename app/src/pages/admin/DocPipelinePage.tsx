import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useTranslation } from '../../lib/i18n';
import { useSetPageTitle } from '../../contexts/pageTitle';
import { useApi } from '../../hooks/useApi';
import { PageHeader } from '../../components/PageHeader';
import { AdminSupportNav } from '../../components/AdminSupportNav';
import { Icon } from '../../components/Icon';
import { Button } from '@/components/ui/button';
import { PipelineQueueRow } from '../../components/admin/PipelineQueueRow';
import { PipelineEventFeed } from '../../components/admin/PipelineEventFeed';
import { ROUTES, toPath } from '../../constants/routes';
import type { QueuedDoc, PipelineEvent, PipelineStatus } from '../../lib/api';

type FilterTab = 'all' | 'needs_review' | 'auto_approved' | 'rejected';

const FILTER_TABS: Array<{ key: FilterTab; labelKey: string }> = [
  { key: 'all',           labelKey: 'common.all' },
  { key: 'needs_review',  labelKey: 'admin.docPipeline.filterNeedsReview' },
  { key: 'auto_approved', labelKey: 'admin.docPipeline.filterAutoApproved' },
  { key: 'rejected',      labelKey: 'admin.docPipeline.filterRejected' },
];

function matchesFilter(doc: QueuedDoc, filter: FilterTab): boolean {
  if (filter === 'all') return true;
  if (filter === 'needs_review')
    return (doc.status === 'pending_review' || doc.status === 'requires_annotation');
  if (filter === 'auto_approved')
    return doc.status === 'auto_approved';
  if (filter === 'rejected')
    return doc.status === 'rejected';
  return true;
}

function sortDocs(docs: QueuedDoc[]): QueuedDoc[] {
  const now = Date.now();
  return [...docs].sort((a, b) => {
    // Expired deadlines first
    const aExpired = a.autoApproveDeadline && new Date(a.autoApproveDeadline).getTime() < now;
    const bExpired = b.autoApproveDeadline && new Date(b.autoApproveDeadline).getTime() < now;
    if (aExpired && !bExpired) return -1;
    if (!aExpired && bExpired) return 1;
    // Then worst quality first
    return a.qualityScore - b.qualityScore;
  });
}

export function DocPipelinePage() {
  const { t } = useTranslation();
  useSetPageTitle(t('admin.docPipeline.title'), t('admin.docPipeline.subtitle'));

  const api = useApi();
  const navigate = useNavigate();

  const [docs, setDocs]               = useState<QueuedDoc[]>([]);
  const [events, setEvents]           = useState<PipelineEvent[]>([]);
  const [newSinceLastVisit, setNew]   = useState(0);
  const [loading, setLoading]         = useState(true);
  const [filter, setFilter]           = useState<FilterTab>('all');

  const loadData = useCallback(async () => {
    try {
      const [queueRes, feedRes] = await Promise.all([
        api.adminSupportGetQueue(),
        api.adminSupportGetFeed(),
      ]);
      setDocs(queueRes.docs ?? []);
      setEvents(feedRes.events ?? []);
      setNew(feedRes.sinceLastVisit ?? 0);
    } catch {
      // silently ignore — page shows empty state
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void loadData();
    const interval = setInterval(() => { void loadData(); }, 60_000);
    return () => clearInterval(interval);
  }, [loadData]);

  const handleApprove = useCallback(async (id: string) => {
    await api.adminSupportApprove(id);
    void loadData();
  }, [api, loadData]);

  const handleReject = useCallback((id: string) => {
    navigate(toPath(ROUTES.ADMIN_SUPPORT_REVIEW, { docId: id }));
  }, [navigate]);

  const handleEdit = useCallback((id: string) => {
    navigate(toPath(ROUTES.ADMIN_SUPPORT_EDIT, { docId: id }));
  }, [navigate]);

  const filteredDocs = sortDocs((docs ?? []).filter((d) => matchesFilter(d, filter)));

  return (
    <div className="max-w-7xl mx-auto w-full">
      <PageHeader
        crumbs={[
          { label: t('nav.settings'), path: ROUTES.SETTINGS },
          { label: t('admin.docPipeline.title') },
        ]}
        title={t('admin.docPipeline.title')}
        subtitle={t('admin.docPipeline.subtitle')}
        actions={
          <Button variant="outline" size="sm" onClick={() => { void loadData(); }}>
            <Icon name="refresh" size={16} className="mr-1.5" />
            {t('common.refresh')}
          </Button>
        }
      />

      <AdminSupportNav />

      <div className="flex gap-6 mt-2">
        {/* ── Queue (60%) ─────────────────────────────────────────────────── */}
        <div className="flex-[3] min-w-0">
          {/* Filter tabs */}
          <div className="flex gap-1 mb-4 border-b border-black/8 pb-2">
            {FILTER_TABS.map(({ key, labelKey }) => (
              <button
                key={key}
                onClick={() => setFilter(key)}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  filter === key
                    ? 'text-white'
                    : 'text-gray-500 hover:text-gray-700 hover:bg-black/5'
                }`}
                style={filter === key ? { background: 'var(--color-primary)' } : undefined}
              >
                {t(labelKey as Parameters<typeof t>[0])}
              </button>
            ))}
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-20">
              <div
                className="w-8 h-8 rounded-full border-2 animate-spin"
                style={{
                  borderColor: 'color-mix(in srgb, var(--color-primary) 20%, transparent)',
                  borderTopColor: 'var(--color-primary)',
                }}
              />
            </div>
          ) : filteredDocs.length === 0 ? (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
              className="flex flex-col items-center justify-center py-20 text-center"
            >
              <div
                className="w-16 h-16 rounded-full flex items-center justify-center mb-4"
                style={{ background: 'rgba(34,197,94,0.1)' }}
              >
                <Icon name="check_circle" size={32} style={{ color: '#16a34a' }} />
              </div>
              <p className="text-lg font-semibold text-gray-700">{t('admin.docPipeline.queueEmpty')}</p>
              <p className="text-sm text-gray-500 mt-1">{t('admin.docPipeline.queueEmptyDesc')}</p>
            </motion.div>
          ) : (
            <div
              style={{
                backdropFilter: 'blur(24px)',
                WebkitBackdropFilter: 'blur(24px)',
                background: 'rgba(255,255,255,0.72)',
                border: '1px solid rgba(255,255,255,0.5)',
                borderRadius: '1rem',
                overflow: 'hidden',
              }}
            >
              <table className="w-full">
                <thead>
                  <tr className="border-b border-black/8 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    <th className="px-4 py-3 text-left">{t('admin.docPipeline.columnDoc')}</th>
                    <th className="px-4 py-3 text-left">{t('admin.docPipeline.columnScore')}</th>
                    <th className="px-4 py-3 text-left">{t('admin.docPipeline.columnStatus')}</th>
                    <th className="px-4 py-3 text-left">{t('admin.docPipeline.columnDeadline')}</th>
                    <th className="px-4 py-3 text-left"></th>
                    <th className="px-4 py-3 text-right">{t('admin.docPipeline.columnActions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredDocs.map((doc) => (
                    <PipelineQueueRow
                      key={doc.id}
                      doc={doc}
                      onApprove={handleApprove}
                      onReject={handleReject}
                      onEdit={handleEdit}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* ── Feed (40%) ──────────────────────────────────────────────────── */}
        <div className="flex-[2] min-w-0">
          <div className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-4">
            {t('admin.docPipeline.activityFeed')}
          </div>
          <PipelineEventFeed events={events} newSinceLastVisit={newSinceLastVisit} />
        </div>
      </div>
    </div>
  );
}
