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
import { DocGapCard } from '../../components/admin/DocGapCard';
import { ROUTES } from '../../constants/routes';
import type { DocGap } from '../../lib/api';

type GapFilter = 'all' | 'unresolved' | 'resolved';

const EASE = [0.22, 1, 0.36, 1] as const;

export function DocGapsPage() {
  const { t } = useTranslation();
  useSetPageTitle(t('admin.docPipeline.docGaps'), t('admin.docPipeline.docGapsSubtitle'));

  const api = useApi();
  const navigate = useNavigate();

  const [gaps, setGaps]           = useState<DocGap[]>([]);
  const [loading, setLoading]     = useState(true);
  const [filter, setFilter]       = useState<GapFilter>('all');

  const loadGaps = useCallback(async () => {
    try {
      const res = await api.adminSupportGetGaps();
      setGaps(res.gaps ?? []);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { void loadGaps(); }, [loadGaps]);

  const handleResolve = useCallback(async (
    id: string,
    resolution: 'doc_created' | 'linked' | 'wont_fix',
  ) => {
    // Optimistically update — in a real impl this would call an API endpoint
    setGaps((prev) =>
      prev.map((g) =>
        g.id === id
          ? { ...g, resolvedAt: new Date().toISOString(), resolution }
          : g,
      ),
    );
  }, []);

  const handleCreateDoc = useCallback((_gap: DocGap) => {
    navigate(ROUTES.ADMIN_SUPPORT_PIPELINE);
  }, [navigate]);

  const filteredGaps = gaps.filter((g) => {
    if (filter === 'all') return true;
    if (filter === 'unresolved') return g.resolvedAt === null;
    if (filter === 'resolved') return g.resolvedAt !== null;
    return true;
  });

  const unresolvedCount = gaps.filter((g) => g.resolvedAt === null).length;
  const resolvedThisWeek = gaps.filter((g) => {
    if (!g.resolvedAt) return false;
    const resolvedMs = new Date(g.resolvedAt).getTime();
    return Date.now() - resolvedMs < 7 * 24 * 60 * 60 * 1000;
  }).length;

  const FILTER_TABS: Array<{ key: GapFilter; label: string }> = [
    { key: 'all',        label: t('common.all') },
    { key: 'unresolved', label: t('admin.docPipeline.filterUnresolved') },
    { key: 'resolved',   label: t('admin.docPipeline.filterResolved') },
  ];

  return (
    <div className="max-w-7xl mx-auto w-full">
      <PageHeader
        crumbs={[
          { label: t('nav.settings'), path: ROUTES.SETTINGS },
          { label: t('admin.docPipeline.title'), path: ROUTES.ADMIN_SUPPORT_PIPELINE },
          { label: t('admin.docPipeline.docGaps') },
        ]}
        title={t('admin.docPipeline.docGaps')}
        subtitle={t('admin.docPipeline.docGapsSubtitle')}
        actions={
          <Button variant="outline" size="sm" onClick={() => { void loadGaps(); }}>
            <Icon name="refresh" size={16} className="mr-1.5" />
            {t('common.refresh')}
          </Button>
        }
      />

      <AdminSupportNav />

      {/* ── Stats bar ──────────────────────────────────────────────────────── */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: EASE }}
        className="flex gap-4 mb-6"
      >
        <div
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium"
          style={{ background: 'rgba(239,68,68,0.08)', color: '#dc2626' }}
        >
          <Icon name="help_outline" size={16} />
          {t('admin.docPipeline.unresolvedCount', { count: unresolvedCount })}
        </div>
        <div
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium"
          style={{ background: 'rgba(34,197,94,0.08)', color: '#16a34a' }}
        >
          <Icon name="check_circle" size={16} />
          {t('admin.docPipeline.resolvedThisWeek', { count: resolvedThisWeek })}
        </div>
      </motion.div>

      {/* ── Filter tabs ────────────────────────────────────────────────────── */}
      <div className="flex gap-1 mb-6 border-b border-black/8 pb-2">
        {FILTER_TABS.map(({ key, label }) => (
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
            {label}
          </button>
        ))}
      </div>

      {/* ── Content ────────────────────────────────────────────────────────── */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div
            className="w-8 h-8 rounded-full border-2 animate-spin"
            style={{ borderColor: 'color-mix(in srgb, var(--color-primary) 20%, transparent)', borderTopColor: 'var(--color-primary)' }}
          />
        </div>
      ) : filteredGaps.length === 0 ? (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, ease: EASE }}
          className="flex flex-col items-center justify-center py-20 text-center"
        >
          <div
            className="w-16 h-16 rounded-full flex items-center justify-center mb-4"
            style={{ background: 'rgba(34,197,94,0.1)' }}
          >
            <Icon name="check_circle" size={32} style={{ color: '#16a34a' }} />
          </div>
          <p className="text-lg font-semibold text-gray-700">{t('admin.docPipeline.noGaps')}</p>
          <p className="text-sm text-gray-500 mt-1">{t('admin.docPipeline.noGapsDesc')}</p>
        </motion.div>
      ) : (
        <div className="space-y-3">
          {filteredGaps.map((gap, idx) => (
            <motion.div
              key={gap.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, delay: idx * 0.04, ease: EASE }}
            >
              <DocGapCard
                gap={gap}
                onResolve={handleResolve}
                onCreateDoc={handleCreateDoc}
              />
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
}
