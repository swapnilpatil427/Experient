import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from '../../lib/i18n';
import { useSetPageTitle } from '../../contexts/pageTitle';
import { useApi } from '../../hooks/useApi';
import { PageHeader } from '../../components/PageHeader';
import { Icon } from '../../components/Icon';
import { Button } from '@/components/ui/button';
import { DocDiffViewer } from '../../components/admin/DocDiffViewer';
import { QualityScoreBreakdown } from '../../components/admin/QualityScoreBreakdown';
import { PipelineEventFeed } from '../../components/admin/PipelineEventFeed';
import { ROUTES, toPath } from '../../constants/routes';
import { diffDocSections } from '../../lib/docDiff';
import type { AdminDocDetail, SectionEdit } from '../../lib/api';

export function DocReviewPage() {
  const { t } = useTranslation();
  const { docId } = useParams<{ docId: string }>();
  const navigate = useNavigate();
  const api = useApi();

  const [detail, setDetail]           = useState<AdminDocDetail | null>(null);
  const [loading, setLoading]         = useState(true);
  const [rejectOpen, setRejectOpen]   = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [submitting, setSubmitting]   = useState(false);
  const [locks, setLocks]             = useState<Array<{ sectionKey: string; lockedBy: string }>>([]);

  useSetPageTitle(
    detail?.doc.title ?? t('admin.docPipeline.title'),
    t('admin.docPipeline.reviewSubtitle'),
  );

  const loadDetail = useCallback(async () => {
    if (!docId) return;
    try {
      const res = await api.adminSupportGetDoc(docId);
      setDetail(res);
      setLocks(res.locks);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [api, docId]);

  useEffect(() => { void loadDetail(); }, [loadDetail]);

  const handleApprove = async () => {
    if (!docId) return;
    setSubmitting(true);
    try {
      await api.adminSupportApprove(docId);
      navigate(ROUTES.ADMIN_SUPPORT_PIPELINE);
    } finally {
      setSubmitting(false);
    }
  };

  const handleReject = async () => {
    if (!docId || !rejectReason.trim()) return;
    setSubmitting(true);
    try {
      await api.adminSupportReject(docId, rejectReason);
      navigate(ROUTES.ADMIN_SUPPORT_PIPELINE);
    } finally {
      setSubmitting(false);
    }
  };

  const handleLockSection = (sectionKey: string, locked: boolean) => {
    if (!detail) return;
    if (locked) {
      setLocks((prev) => [...prev, { sectionKey, lockedBy: 'admin' }]);
    } else {
      setLocks((prev) => prev.filter((l) => l.sectionKey !== sectionKey));
    }
  };

  const handleEditSection = async (sectionKey: string, newContent: string) => {
    if (!docId || !detail) return;
    const sections: SectionEdit[] = detail.sections.map((s) => ({
      sectionKey: s.key,
      content: s.key === sectionKey ? newContent : s.content,
      locked: locks.some((l) => l.sectionKey === s.key),
    }));
    await api.adminSupportEditSections(docId, sections);
    void loadDetail();
  };

  const sectionDiffs = detail
    ? diffDocSections(detail.oldSections, detail.sections, locks)
    : [];

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto w-full">
        <div className="flex items-center justify-center py-32">
          <div
            className="w-8 h-8 rounded-full border-2 animate-spin"
            style={{
              borderColor: 'color-mix(in srgb, var(--color-primary) 20%, transparent)',
              borderTopColor: 'var(--color-primary)',
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto w-full">
      <PageHeader
        crumbs={[
          { label: t('admin.docPipeline.title'), path: ROUTES.ADMIN_SUPPORT_PIPELINE },
          { label: detail?.doc.title ?? t('admin.docPipeline.reviewSubtitle') },
        ]}
        title={detail?.doc.title ?? t('admin.docPipeline.reviewSubtitle')}
        subtitle={t('admin.docPipeline.reviewSubtitle')}
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate(toPath(ROUTES.ADMIN_SUPPORT_EDIT, { docId: docId! }))}
          >
            <Icon name="edit" size={16} className="mr-1.5" />
            {t('admin.docPipeline.editDoc')}
          </Button>
        }
      />

      {detail && (
        <div className="flex gap-6 mt-2">
          {/* ── Left: diff viewer ────────────────────────────────────────── */}
          <div className="flex-[3] min-w-0">
            <DocDiffViewer
              sections={sectionDiffs}
              onLockSection={handleLockSection}
              onEditSection={handleEditSection}
            />
          </div>

          {/* ── Right: score + metadata ──────────────────────────────────── */}
          <div className="flex-[2] min-w-0 space-y-4">
            <QualityScoreBreakdown
              score={detail.doc.qualityScore}
              breakdown={detail.qualityBreakdown}
            />

            {/* Metadata card */}
            <div
              style={{
                backdropFilter: 'blur(24px)',
                WebkitBackdropFilter: 'blur(24px)',
                background: 'rgba(255,255,255,0.72)',
                border: '1px solid rgba(255,255,255,0.5)',
                borderRadius: '1rem',
                padding: '1.5rem',
              }}
            >
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
                {t('admin.docPipeline.metadata')}
              </p>
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <dt className="text-gray-500">{t('admin.docPipeline.version')}</dt>
                  <dd className="font-medium">v{detail.doc.version}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-gray-500">{t('admin.docPipeline.status')}</dt>
                  <dd className="font-medium">{detail.doc.status.replace(/_/g, ' ')}</dd>
                </div>
                {detail.doc.sourceUrl && (
                  <div className="flex justify-between">
                    <dt className="text-gray-500">{t('admin.docPipeline.source')}</dt>
                    <dd>
                      <a
                        href={detail.doc.sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:underline truncate max-w-[12rem] block"
                      >
                        {detail.doc.sourceUrl}
                      </a>
                    </dd>
                  </div>
                )}
              </dl>
            </div>

            {/* Pipeline history */}
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
                {t('admin.docPipeline.pipelineHistory')}
              </p>
              <PipelineEventFeed events={detail.pipelineHistory} newSinceLastVisit={0} />
            </div>
          </div>
        </div>
      )}

      {/* ── Sticky bottom action bar ─────────────────────────────────────────── */}
      {detail && (
        <div
          className="sticky bottom-0 mt-8 -mx-6 md:-mx-8 px-6 md:px-8 py-4 flex items-center justify-end gap-3 z-20"
          style={{
            background: 'rgba(255,255,255,0.88)',
            backdropFilter: 'blur(16px)',
            WebkitBackdropFilter: 'blur(16px)',
            borderTop: '1px solid rgba(0,0,0,0.08)',
          }}
        >
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setRejectOpen(true)}
            disabled={submitting}
          >
            <Icon name="close" size={16} className="mr-1.5" />
            {t('admin.docPipeline.rejectDoc')}
          </Button>
          <Button
            variant="success"
            size="sm"
            onClick={handleApprove}
            disabled={submitting}
          >
            <Icon name="check" size={16} className="mr-1.5" />
            {t('admin.docPipeline.approveDoc')}
          </Button>
        </div>
      )}

      {/* ── Reject modal ─────────────────────────────────────────────────────── */}
      <AnimatePresence>
        {rejectOpen && (
          <motion.div
            key="reject-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 12 }}
              transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
              className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-md mx-4"
            >
              <h2 className="text-base font-semibold mb-1">{t('admin.docPipeline.rejectDoc')}</h2>
              <p className="text-sm text-gray-500 mb-4">{t('admin.docPipeline.rejectReason')}</p>
              <textarea
                className="w-full rounded-lg border border-black/12 p-3 text-sm resize-none focus:outline-none focus:ring-2"
                style={{ minHeight: 100 }}
                placeholder={t('admin.docPipeline.rejectReasonPlaceholder')}
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
              />
              <div className="flex justify-end gap-2 mt-4">
                <Button variant="outline" size="sm" onClick={() => setRejectOpen(false)}>
                  {t('common.cancel')}
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={!rejectReason.trim() || submitting}
                  onClick={handleReject}
                >
                  {t('admin.docPipeline.rejectDoc')}
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
