import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useTranslation } from '../../lib/i18n';
import { useSetPageTitle } from '../../contexts/pageTitle';
import { useApi } from '../../hooks/useApi';
import { PageHeader } from '../../components/PageHeader';
import { Icon } from '../../components/Icon';
import { Button } from '@/components/ui/button';
import { ROUTES, toPath } from '../../constants/routes';
import type { AdminDocDetail, AdminDocSection, SectionEdit } from '../../lib/api';

// Framer spring ease
const EASE = [0.22, 1, 0.36, 1] as const;

interface SectionEditorCardProps {
  section: AdminDocSection;
  isLocked: boolean;
  onToggleLock: (key: string, locked: boolean) => void;
  onChange: (key: string, content: string) => void;
}

function SectionEditorCard({ section, isLocked, onToggleLock, onChange }: SectionEditorCardProps) {
  const { t } = useTranslation();
  return (
    <div
      style={{
        backdropFilter: 'blur(24px)',
        WebkitBackdropFilter: 'blur(24px)',
        background: 'rgba(255,255,255,0.72)',
        border: '1px solid rgba(255,255,255,0.5)',
        borderRadius: '1rem',
        padding: '1.5rem',
        borderLeft: isLocked ? '3px solid #d97706' : undefined,
      }}
    >
      {/* Section header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h3 className="font-semibold text-sm text-gray-800">{section.heading}</h3>
          {isLocked && (
            <span
              className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium"
              style={{ background: 'rgba(217,119,6,0.1)', color: '#d97706' }}
            >
              <Icon name="lock" size={12} />
              {t('admin.docPipeline.sectionLocked', { name: 'admin' })}
            </span>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onToggleLock(section.key, !isLocked)}
          className="text-xs"
        >
          <Icon name={isLocked ? 'lock_open' : 'lock'} size={14} className="mr-1" />
          {isLocked ? t('admin.docPipeline.unlockSection') : t('admin.docPipeline.lockSection')}
        </Button>
      </div>

      {/* Code-editor-style textarea */}
      <textarea
        value={section.content}
        onChange={(e) => onChange(section.key, e.target.value)}
        style={{
          width: '100%',
          minHeight: 180,
          resize: 'vertical',
          fontFamily: "'ui-monospace', 'Cascadia Code', 'Source Code Pro', Menlo, monospace",
          fontSize: '0.813rem',
          lineHeight: 1.6,
          background: 'rgba(0,0,0,0.03)',
          border: '1px solid rgba(0,0,0,0.1)',
          borderRadius: '0.5rem',
          padding: '0.75rem',
          outline: 'none',
          color: '#374151',
        }}
        onFocus={(e) => {
          e.target.style.boxShadow = '0 0 0 2px color-mix(in srgb, var(--color-primary) 25%, transparent)';
          e.target.style.borderColor = 'color-mix(in srgb, var(--color-primary) 50%, transparent)';
        }}
        onBlur={(e) => {
          e.target.style.boxShadow = '';
          e.target.style.borderColor = 'rgba(0,0,0,0.1)';
        }}
      />
    </div>
  );
}

export function DocEditorPage() {
  const { t } = useTranslation();
  const { docId } = useParams<{ docId: string }>();
  const navigate = useNavigate();
  const api = useApi();

  const [detail, setDetail]             = useState<AdminDocDetail | null>(null);
  const [localSections, setLocalSections] = useState<AdminDocSection[]>([]);
  const [locks, setLocks]               = useState<Set<string>>(new Set());
  const [loading, setLoading]           = useState(true);
  const [isDirty, setIsDirty]           = useState(false);
  const [submitting, setSubmitting]     = useState(false);

  useSetPageTitle(
    detail?.doc.title ?? t('admin.docPipeline.editDoc'),
    t('admin.docPipeline.editorSubtitle'),
  );

  const loadDetail = useCallback(async () => {
    if (!docId) return;
    try {
      const res = await api.adminSupportGetDoc(docId);
      setDetail(res);
      setLocalSections(res.sections);
      setLocks(new Set(res.locks.map((l) => l.sectionKey)));
    } finally {
      setLoading(false);
    }
  }, [api, docId]);

  useEffect(() => { void loadDetail(); }, [loadDetail]);

  // Warn on navigate-away with unsaved changes
  useEffect(() => {
    if (!isDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = t('admin.docPipeline.unsavedChanges');
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty, t]);

  const handleChange = (sectionKey: string, content: string) => {
    setLocalSections((prev) => prev.map((s) => s.key === sectionKey ? { ...s, content } : s));
    setIsDirty(true);
  };

  const handleToggleLock = (sectionKey: string, locked: boolean) => {
    setLocks((prev) => {
      const next = new Set(prev);
      if (locked) next.add(sectionKey);
      else next.delete(sectionKey);
      return next;
    });
    setIsDirty(true);
  };

  const buildSectionEdits = (): SectionEdit[] =>
    localSections.map((s) => ({
      sectionKey: s.key,
      content: s.content,
      locked: locks.has(s.key),
    }));

  const handleSaveDraft = async () => {
    if (!docId) return;
    setSubmitting(true);
    try {
      await api.adminSupportEditSections(docId, buildSectionEdits());
      setIsDirty(false);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSaveAndApprove = async () => {
    if (!docId) return;
    setSubmitting(true);
    try {
      await api.adminSupportEditSections(docId, buildSectionEdits());
      await api.adminSupportApprove(docId);
      navigate(ROUTES.ADMIN_SUPPORT_PIPELINE);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto w-full">
        <div className="flex items-center justify-center py-32">
          <div
            className="w-8 h-8 rounded-full border-2 animate-spin"
            style={{ borderColor: 'color-mix(in srgb, var(--color-primary) 20%, transparent)', borderTopColor: 'var(--color-primary)' }}
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
          {
            label: detail?.doc.title ?? t('admin.docPipeline.editDoc'),
            path: docId ? toPath(ROUTES.ADMIN_SUPPORT_REVIEW, { docId }) : undefined,
          },
          { label: t('admin.docPipeline.editDoc') },
        ]}
        title={detail?.doc.title ?? t('admin.docPipeline.editDoc')}
        subtitle={t('admin.docPipeline.editorSubtitle')}
      />

      {isDirty && (
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25, ease: EASE }}
          className="mb-4 flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium"
          style={{ background: 'rgba(245,158,11,0.1)', color: '#d97706', border: '1px solid rgba(245,158,11,0.3)' }}
        >
          <Icon name="warning" size={16} />
          {t('admin.docPipeline.unsavedChanges')}
        </motion.div>
      )}

      <div className="space-y-4">
        {localSections.map((section, idx) => (
          <motion.div
            key={section.key}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, delay: idx * 0.05, ease: EASE }}
          >
            <SectionEditorCard
              section={section}
              isLocked={locks.has(section.key)}
              onToggleLock={handleToggleLock}
              onChange={handleChange}
            />
          </motion.div>
        ))}
      </div>

      {/* ── Sticky bottom bar ─────────────────────────────────────────────── */}
      <div
        className="sticky bottom-0 mt-8 -mx-6 md:-mx-8 px-6 md:px-8 py-4 flex items-center justify-between gap-3 z-20"
        style={{
          background: 'rgba(255,255,255,0.88)',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
          borderTop: '1px solid rgba(0,0,0,0.08)',
        }}
      >
        <Button
          variant="outline"
          size="sm"
          onClick={() => navigate(-1)}
        >
          {t('common.back')}
        </Button>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleSaveDraft}
            disabled={submitting || !isDirty}
          >
            {t('admin.docPipeline.saveDraft')}
          </Button>
          <Button
            variant="default"
            size="sm"
            onClick={handleSaveAndApprove}
            disabled={submitting}
            style={{ background: 'var(--color-primary)' }}
          >
            <Icon name="check" size={16} className="mr-1.5" />
            {t('admin.docPipeline.saveAndApprove')}
          </Button>
        </div>
      </div>
    </div>
  );
}
