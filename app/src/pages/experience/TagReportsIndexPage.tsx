import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useTranslation } from '../../lib/i18n';
import { useSetPageTitle } from '../../contexts/pageTitle';
import { useTagReportsIndex } from '../../hooks/useTagReport';
import { Icon } from '../../components/Icon';
import { ExperienceSubNav } from '../../components/ExperienceSubNav';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { PageHeader } from '../../components/PageHeader';
import { GlassCard } from '../insights/shared';
import { TagReportsIndexSkeleton } from '../../components/LoadingStates';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ROUTES, toPath } from '../../constants/routes';
import type { TagReportsIndexItem, TagReportRunMode } from '../../types/tagReport';

const stagger = { hidden: {}, visible: { transition: { staggerChildren: 0.06 } } };
const rise = {
  hidden:  { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.4, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] } },
};

const SORT_OPTIONS = ['recent', 'alpha', 'survey_count'] as const;
type SortOption = (typeof SORT_OPTIONS)[number];

function ReportSortDropdown({ value, onChange }: { value: SortOption; onChange: (v: SortOption) => void }) {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="rounded-xl gap-1.5 font-semibold text-xs text-on-surface-variant border-[#dfe3e6] bg-white">
          <Icon name="sort" size={14} />
          {t(`tagReport.index.sort.${value}`)}
          <Icon name="expand_more" size={14} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        {SORT_OPTIONS.map((opt) => (
          <DropdownMenuItem
            key={opt}
            onClick={() => onChange(opt)}
            className={`flex items-center justify-between text-sm ${value === opt ? 'text-primary font-semibold' : ''}`}
          >
            {t(`tagReport.index.sort.${opt}`)}
            {value === opt && <Icon name="check" size={14} className="text-primary" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ModeBadge({ mode }: { mode: TagReportRunMode }) {
  const { t } = useTranslation();
  return <Badge variant="neutral">{t(`tagReport.index.card.modeBadge.${mode}`)}</Badge>;
}

function ReportCard({ item }: { item: TagReportsIndexItem }) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <Card
      className="p-4 cursor-pointer hover:shadow-md transition-shadow"
      onClick={() => navigate(toPath(ROUTES.TAG_REPORT_LATEST, { tagId: item.tag_id }))}
    >
      <div className="flex items-center gap-2 mb-3">
        <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: item.tag_color }} />
        <span className="font-bold text-on-surface truncate">{item.tag_name}</span>
      </div>
      <p className="text-xs text-on-surface-variant mb-3">{t('tagReport.index.card.surveyCount', { count: item.survey_count })}</p>
      {item.latest_run && (
        <div className="flex items-center justify-between gap-2 mb-2">
          <span className="text-xs text-on-surface-variant">
            {t('tagReport.index.card.generated', { time: new Date(item.latest_run.created_at).toLocaleDateString() })}
          </span>
          <ModeBadge mode={item.latest_run.mode} />
        </div>
      )}
      {item.latest_run?.has_active_warning && (
        <div className="flex items-center gap-1.5 text-xs font-semibold" style={{ color: '#d97706' }}>
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: '#d97706' }} />
          {t('tagReport.index.card.needsAttention')}
        </div>
      )}
    </Card>
  );
}

/** Reports index — `TAG_REPORTS_INDEX` (TRACKER.md Part C). */
export function TagReportsIndexPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  useSetPageTitle(t('tagReport.index.title'), t('tagReport.index.subtitle'));

  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortOption>('recent');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const params = useMemo(() => ({ q: search || undefined, sort }), [search, sort]);
  const { reports, loading, error } = useTagReportsIndex(params);

  function handleSearchInput(val: string) {
    setSearchInput(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setSearch(val), 300);
  }

  const stats = useMemo(() => ({
    tagsWithReports: reports.length,
    needsAttention: reports.filter((r) => r.latest_run?.has_active_warning).length,
    automatedActive: reports.filter((r) => r.automated_enabled).length,
  }), [reports]);

  return (
    <div className="max-w-7xl mx-auto w-full">
      <PageHeader
        crumbs={[
          { label: t('tagReport.breadcrumbs.experience'), path: ROUTES.EXPERIENCE },
          { label: t('tagReport.index.title') },
        ]}
        title={t('tagReport.index.title')}
        subtitle={t('tagReport.index.subtitle')}
      />

      <ExperienceSubNav active="reports" className="mb-6" />

      {error && <div className="banner-error mb-4">{error}</div>}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        <GlassCard className="p-4">
          <p className="label-caps mb-1">{t('tagReport.index.stats.tagsWithReports')}</p>
          <p className="text-3xl font-black font-headline" style={{ color: 'var(--color-primary)' }}>{stats.tagsWithReports}</p>
        </GlassCard>
        <GlassCard className="p-4">
          <p className="label-caps mb-1">{t('tagReport.index.stats.needsAttention')}</p>
          <p className="text-3xl font-black font-headline" style={{ color: stats.needsAttention > 0 ? '#d97706' : '#64748b' }}>
            {stats.needsAttention}
          </p>
        </GlassCard>
        <GlassCard className="p-4">
          <p className="label-caps mb-1">{t('tagReport.index.stats.automatedActive')}</p>
          <p className="text-3xl font-black font-headline" style={{ color: '#059669' }}>{stats.automatedActive}</p>
        </GlassCard>
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-6">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Icon name="search" size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <input
            value={searchInput}
            onChange={(e) => handleSearchInput(e.target.value)}
            placeholder={t('tagReport.index.searchPlaceholder')}
            className="w-full pl-9 pr-8 py-2 rounded-xl text-sm bg-white border border-[#dfe3e6] text-on-surface placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors"
          />
          {searchInput && (
            <button onClick={() => { setSearchInput(''); setSearch(''); }}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-on-surface">
              <Icon name="close" size={14} />
            </button>
          )}
        </div>
        <ReportSortDropdown value={sort} onChange={setSort} />
      </div>

      {loading ? (
        <TagReportsIndexSkeleton />
      ) : reports.length === 0 && !search ? (
        <div className="text-center py-20">
          <div className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-4 bg-surface-container-low">
            <Icon name="summarize" size={32} className="text-muted-foreground" />
          </div>
          <h3 className="text-xl font-bold mb-2 font-headline text-on-surface">{t('tagReport.index.emptyOrgWide.heading')}</h3>
          <p className="text-sm mb-6 text-on-surface-variant">{t('tagReport.index.emptyOrgWide.description')}</p>
          <Button onClick={() => navigate(ROUTES.SETTINGS_TAGS)} variant="gradient"
            className="px-6 py-3 text-white font-bold text-sm transition-all active:scale-95 font-headline rounded-xl">
            {t('tagReport.index.emptyOrgWide.cta')}
          </Button>
        </div>
      ) : reports.length === 0 ? (
        <div className="flex items-center justify-between gap-3 py-6 px-4 rounded-xl border border-border">
          <p className="text-sm text-on-surface-variant">{t('tagReport.index.emptySearch.heading', { query: search })}</p>
          <button onClick={() => { setSearchInput(''); setSearch(''); }} className="text-sm font-semibold underline" style={{ color: 'var(--color-primary)' }}>
            {t('tagReport.index.emptySearch.clear')}
          </button>
        </div>
      ) : (
        <motion.div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4" variants={stagger} initial="hidden" animate="visible">
          {reports.map((item) => (
            <motion.div key={item.tag_id} variants={rise}>
              <ReportCard item={item} />
            </motion.div>
          ))}
        </motion.div>
      )}
    </div>
  );
}
