import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Icon }       from '../components/Icon';
import { useSetPageTitle } from '../contexts/pageTitle';
import { PauseModal, ResumeModal, CloseModal, ReopenModal, DeleteSurveyModal } from '../components/SurveyActionModal';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { SurveyListSkeleton, Spinner } from '../components/LoadingStates';
import { useApi }    from '../hooks/useApi';
import { ROUTES, toPath } from '../constants/routes';
import { NPS as NPS_THRESHOLDS } from '../constants/thresholds';
import { SENTIMENT_COLORS }      from '../constants/colors';
import { useTranslation } from '../lib/i18n';
import { Badge }   from '@/components/ui/badge';
import { Button }  from '@/components/ui/button';
import { PageHeader } from '../components/PageHeader';
import { usePermissions } from '../lib/permissions';
import { TagBadge } from '../components/TagBadge';
import { TagSelector } from '../components/TagSelector';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import type { Survey, SurveyStatus } from '../types';
import type { SurveyTag } from '../lib/api';

// ── constants ─────────────────────────────────────────────────────────────────

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1)  return 'Just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

const PAGE_SIZE = 20;

type BadgeVariant = 'live' | 'draft' | 'paused' | 'secondary' | 'neutral' | 'purple' | 'default' | 'destructive' | 'outline' | 'success' | 'warning';
const STATUS_BADGE_VARIANT: Record<string, BadgeVariant> = { active: 'live', draft: 'draft', paused: 'paused', closed: 'secondary' };

const SURVEY_TYPES: Record<string, { label: string; icon: string; color: string }> = {
  nps:              { label: 'NPS',              icon: 'trending_up',       color: '#2a4bd9' },
  csat:             { label: 'CSAT',             icon: 'sentiment_satisfied',color: '#059669' },
  product_feedback: { label: 'Product Feedback', icon: 'feedback',           color: '#8329c8' },
  employee:         { label: 'Employee',         icon: 'people',             color: '#d97706' },
  onboarding:       { label: 'Onboarding',       icon: 'rocket_launch',      color: '#0891b2' },
  custom:           { label: 'Custom',           icon: 'tune',               color: '#6b7280' },
};
const TYPE_META = (typeId: string | null | undefined): { label: string; icon: string; color: string } =>
  (typeId && SURVEY_TYPES[typeId]) || { label: typeId || 'Survey', icon: 'poll', color: '#6b7280' };

const STATUSES: SurveyStatus[]   = ['active', 'draft', 'paused', 'closed'];
const TYPE_IDS   = Object.keys(SURVEY_TYPES);
const SORT_OPTIONS = ['updated_at', 'created_at', 'response_count', 'title'];

const fadeUp = {
  hidden:  { opacity: 0, y: 16 },
  visible: (i = 0) => ({ opacity: 1, y: 0, transition: { duration: 0.38, delay: i * 0.05, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] } }),
};
const stagger = { visible: { transition: { staggerChildren: 0.06, delayChildren: 0.05 } } };

function Sparkline({ data, color = '#2a4bd9' }: { data: number[]; color?: string }) {
  if (!data || data.length < 2) return null;
  const max = Math.max(...data, 1);
  const W = 48, H = 20;
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * W;
    const y = H - (v / max) * H * 0.85 - H * 0.05;
    return `${x},${y}`;
  });
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="shrink-0">
      <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ── Modal target type ─────────────────────────────────────────────────────────

interface ModalTarget {
  id: string;
  title: string;
  responseCount: number;
}

// ── small sub-components ──────────────────────────────────────────────────────

interface MultiSelectDropdownProps {
  label: string;
  icon: string;
  options: string[];
  selected: string[];
  onChange: (next: string[]) => void;
  renderOption?: (opt: string) => React.ReactNode;
  dropdownWidth?: string;
}

function MultiSelectDropdown({ label, icon, options, selected, onChange, renderOption, dropdownWidth = 'w-48' }: MultiSelectDropdownProps) {
  const toggle = (val: string) =>
    onChange(selected.includes(val) ? selected.filter((v) => v !== val) : [...selected, val]);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={`rounded-xl gap-1.5 font-semibold text-xs ${selected.length > 0 ? 'border-primary text-primary bg-primary/5' : 'text-on-surface-variant border-[#dfe3e6] bg-white'}`}
        >
          <Icon name={icon} size={14} />
          {label}
          {selected.length > 0 && (
            <span className="w-4 h-4 rounded-full flex items-center justify-center text-[10px] font-black bg-primary text-white leading-none">
              {selected.length}
            </span>
          )}
          <Icon name="expand_more" size={14} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className={dropdownWidth}>
        {options.map((opt) => (
          <DropdownMenuItem
            key={opt}
            onClick={(e: React.MouseEvent) => { e.preventDefault(); toggle(opt); }}
            className="flex items-center gap-2 cursor-pointer"
          >
            <div className={`w-4 h-4 rounded flex items-center justify-center flex-shrink-0 ${selected.includes(opt) ? 'bg-primary' : 'border border-[#dfe3e6]'}`}>
              {selected.includes(opt) && <Icon name="check" size={11} style={{ color: '#fff' }} />}
            </div>
            {renderOption ? renderOption(opt) : <span className="capitalize text-sm">{opt}</span>}
          </DropdownMenuItem>
        ))}
        {selected.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => onChange([])} className="text-xs text-muted-foreground gap-2">
              <Icon name="close" size={12} />Clear selection
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface SortDropdownProps {
  value: string;
  order: string;
  onChange: (by: string, ord: string) => void;
}

function SortDropdown({ value, order: _order, onChange }: SortDropdownProps) {
  const { t } = useTranslation();
  const label = t(`surveys.filters.sortOptions.${value}`);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="rounded-xl gap-1.5 font-semibold text-xs text-on-surface-variant border-[#dfe3e6] bg-white">
          <Icon name="sort" size={14} />
          {label}
          <Icon name="expand_more" size={14} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        {SORT_OPTIONS.map((opt) => (
          <DropdownMenuItem key={opt} onClick={() => onChange(opt, opt === 'title' ? 'asc' : 'desc')}
            className={`flex items-center justify-between text-sm ${value === opt ? 'text-primary font-semibold' : ''}`}>
            {t(`surveys.filters.sortOptions.${opt}`)}
            {value === opt && <Icon name="check" size={14} className="text-primary" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ── Stats type ────────────────────────────────────────────────────────────────

interface SurveyStats {
  total_surveys: number;
  active_surveys: number;
  total_responses: number;
  avg_nps: number | null;
}

// ── main component ────────────────────────────────────────────────────────────

export function SurveysListPage() {
  const { t }    = useTranslation();
  const navigate = useNavigate();
  useSetPageTitle(t('surveys.pageTitle'));
  const { isAnalyst } = usePermissions();
  const api      = useApi();

  // ── list state
  const [surveys,     setSurveys]     = useState<Survey[]>([]);
  const [total,       setTotal]       = useState<number>(0);
  const [page,        setPage]        = useState<number>(1);
  const [hasMore,     setHasMore]     = useState<boolean>(false);
  const [loading,     setLoading]     = useState<boolean>(true);
  const [loadingMore, setLoadingMore] = useState<boolean>(false);
  const [error,       setError]       = useState<string | null>(null);
  const [stats,       setStats]       = useState<SurveyStats | null>(null);

  // ── filter state
  const [searchInput,   setSearchInput]   = useState<string>('');
  const [search,        setSearch]        = useState<string>('');
  const [statusFilter,  setStatusFilter]  = useState<SurveyStatus[]>([]);
  const [typeFilter,    setTypeFilter]    = useState<string[]>([]);
  const [sortBy,        setSortBy]        = useState<string>('updated_at');
  const [sortOrder,     setSortOrder]     = useState<'asc' | 'desc'>('desc');
  const [tagFilter,       setTagFilter]       = useState<string[]>([]);
  const [availableTags,   setAvailableTags]   = useState<SurveyTag[]>([]);
  const [generatingReport, setGeneratingReport] = useState(false);

  // ── tag editing state
  const [tagEditSurvey, setTagEditSurvey] = useState<{ id: string; title: string; tags: SurveyTag[] } | null>(null);

  // ── modal state
  const [statusChanging, setStatusChanging] = useState<string | null>(null);
  const [pauseTarget,    setPauseTarget]    = useState<ModalTarget | null>(null);
  const [resumeTarget,   setResumeTarget]   = useState<ModalTarget | null>(null);
  const [closeTarget,    setCloseTarget]    = useState<ModalTarget | null>(null);
  const [reopenTarget,   setReopenTarget]   = useState<ModalTarget | null>(null);
  const [deleteTarget,   setDeleteTarget]   = useState<ModalTarget | null>(null);

  // ── debounce search
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleSearchInput = (val: string) => {
    setSearchInput(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setSearch(val.length >= 2 || val.length === 0 ? val : ''), 300);
  };

  // ── tag loading
  useEffect(() => {
    api.listTags().then(r => setAvailableTags(r.tags)).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── data fetching
  const fetchSurveys = useCallback(async (fetchPage: number, append: boolean) => {
    if (append) setLoadingMore(true);
    else        setLoading(true);
    try {
      const result = await api.listSurveys({
        q:              search,
        status:         statusFilter,
        survey_type_id: typeFilter,
        sort_by:        sortBy,
        sort_order:     sortOrder,
        page:           fetchPage,
        limit:          PAGE_SIZE,
        ...(tagFilter.length > 0 ? { tag_ids: tagFilter.join(',') } as Record<string, unknown> : {}),
      } as Parameters<typeof api.listSurveys>[0]);
      setSurveys((prev) => append ? [...prev, ...result.surveys] : result.surveys);
      setTotal(result.total);
      setPage(fetchPage);
      setHasMore(result.hasMore);
      if (result.stats) setStats(result.stats);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (append) setLoadingMore(false);
      else        setLoading(false);
    }
  }, [api, search, statusFilter.join(','), typeFilter.join(','), sortBy, sortOrder, tagFilter.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { fetchSurveys(1, false); }, [fetchSurveys]);

  // ── local optimistic CRUD (used by modals)
  const updateSurvey = useCallback(async (id: string, data: Partial<Survey>) => {
    setSurveys((prev) => prev.map((s) => s.id === id ? { ...s, ...data, updated_at: new Date().toISOString() } : s));
    try { await api.updateSurvey(id, data); } catch { fetchSurveys(1, false); }
  }, [api, fetchSurveys]);

  const deleteSurvey = useCallback(async (id: string) => {
    setSurveys((prev) => prev.filter((s) => s.id !== id));
    setTotal((n) => n - 1);
    try { await api.deleteSurvey(id); } catch { fetchSurveys(1, false); }
  }, [api, fetchSurveys]);

  // Fixed 2026-07-03 (customer-journey review finding): this toolbar button
  // previously always called the OLDER "Group Insights" flow (real, paid,
  // fresh-LLM generation, `GROUP_REPORT` route) regardless of how many tags
  // were selected — presenting near-identical copy/icon to Tag Report's own
  // entry points elsewhere on this same page (the per-survey TagBadge chips),
  // which is the zero-fresh-AI-generation rollup. A customer filtering to a
  // single tag and clicking this got silently charged for fresh AI generation
  // instead of the free, trust-weighted Tag Report they likely meant.
  //
  // Fix: when exactly one tag is selected (the common case, and the only case
  // Tag Report actually supports — it is always scoped to a single tag by
  // design), route to Tag Report instead. Group Insights' multi-tag blended
  // query is a genuinely different capability Tag Report cannot replicate
  // (Tag Report never spans more than one tag per run), so it's preserved,
  // unchanged, for the >1-tag case — but relabeled (see the JSX below) so its
  // identity and cost are never confused with the free Tag Report flow.
  const isSingleTagSelection = tagFilter.length === 1;

  const handleGenerateGroupReport = useCallback(async () => {
    if (isSingleTagSelection) {
      navigate(toPath(ROUTES.TAG_REPORT_NEW, { tagId: tagFilter[0] }));
      return;
    }
    setGeneratingReport(true);
    try {
      const { run_id } = await api.generateGroupInsights({ tag_ids: tagFilter });
      navigate(toPath(ROUTES.GROUP_REPORT, { tagId: tagFilter[0], runId: run_id }));
    } catch {
      setGeneratingReport(false);
    }
  }, [api, tagFilter, navigate, isSingleTagSelection]);

  // ── derived KPI values (from server stats when available, fallback to loaded data)
  const kpiTotalSurveys  = stats?.total_surveys  ?? surveys.length;
  const kpiActiveSurveys = stats?.active_surveys  ?? surveys.filter((s) => s.status === 'active').length;
  const kpiTotalResponses = stats?.total_responses ?? surveys.reduce((acc, s) => acc + (s.response_count ?? 0), 0);
  const kpiAvgNps = stats?.avg_nps != null
    ? Math.round(parseFloat(String(stats.avg_nps)))
    : null;

  const npsColor = (score: number): string => score >= NPS_THRESHOLDS.POSITIVE_MIN ? '#059669' : score >= NPS_THRESHOLDS.NEUTRAL_MIN ? '#d97706' : '#b41340';

  const kpiCards = [
    { label: t('surveys.metrics.totalSurveys'), value: kpiTotalSurveys,                icon: 'poll',      gradient: 'linear-gradient(135deg,rgba(42,75,217,0.08),rgba(42,75,217,0.02))',   iconColor: '#2a4bd9' },
    { label: t('surveys.metrics.active'),       value: kpiActiveSurveys,               icon: 'play_circle',gradient:'linear-gradient(135deg,rgba(5,150,105,0.08),rgba(5,150,105,0.02))',   iconColor: '#059669' },
    { label: t('surveys.metrics.responses'),    value: kpiTotalResponses.toLocaleString(),icon:'forum',   gradient: 'linear-gradient(135deg,rgba(131,41,200,0.08),rgba(131,41,200,0.02))', iconColor: '#8329c8' },
    { label: t('surveys.metrics.avgNps'),       value: kpiAvgNps != null ? kpiAvgNps : '—', icon: 'thumb_up', gradient:'linear-gradient(135deg,rgba(217,119,6,0.08),rgba(217,119,6,0.02))', iconColor:'#d97706' },
  ];

  const activeFilterCount = statusFilter.length + typeFilter.length + tagFilter.length;
  const hasActiveFilters  = activeFilterCount > 0 || search.length > 0;
  const remaining         = total - surveys.length;

  return (
    <>
        <div className="max-w-7xl mx-auto w-full">

          <PageHeader
            crumbs={[{ label: t('nav.surveys'), icon: 'poll', path: ROUTES.SURVEYS }]}
            title={t('surveys.libraryHeading')}
            subtitle={t('surveys.countDescription', { count: kpiTotalSurveys, responses: kpiTotalResponses.toLocaleString() })}
            actions={
              <div className="flex items-center gap-3">
                <Button variant="ghost" size="sm" onClick={() => navigate(ROUTES.TEMPLATES)}
                  className="rounded-xl font-headline text-on-surface-variant gap-1.5">
                  <Icon name="library_books" size={16} />{t('nav.templates')}
                </Button>
                {tagFilter.length > 0 && (
                  // Fixed 2026-07-03: single-tag selection routes to the free
                  // Tag Report flow with Tag Report's own icon/copy/title
                  // attribute; multi-tag selection keeps the legacy paid Group
                  // Insights flow, relabeled so it's never mistaken for the
                  // free one (distinct icon, "Group Insights" wording, and a
                  // title attribute stating it runs fresh AI generation).
                  <Button
                    variant="default"
                    size="sm"
                    onClick={handleGenerateGroupReport}
                    disabled={generatingReport}
                    className="rounded-xl font-headline gap-1.5"
                    style={{ background: 'var(--color-primary)' }}
                    title={isSingleTagSelection ? t('tagReport.toolbarCta.tooltip') : t('groups.generateReportTooltip')}
                  >
                    <Icon name={isSingleTagSelection ? 'summarize' : 'auto_awesome'} size={16} />
                    {generatingReport
                      ? t('groups.generatingReport', { count: surveys.length })
                      : (isSingleTagSelection ? t('tagReport.new.title') : t('groups.generateGroupInsightsCta'))}
                  </Button>
                )}
                {isAnalyst && (
                  <Button variant="gradient" size="sm" onClick={() => navigate(ROUTES.CREATE)}
                    className="rounded-xl font-headline">
                    <Icon name="auto_awesome" size={16} />{t('surveys.createWithAI')}
                  </Button>
                )}
                {isAnalyst && (
                  <Button variant="outline" size="sm" onClick={() => navigate(ROUTES.CREATE, { state: { mode: 'manual' } })}
                    className="rounded-xl font-headline text-on-surface">
                    <Icon name="add" size={16} />{t('surveys.manual')}
                  </Button>
                )}
              </div>
            }
            className="mb-0"
          />

          {/* KPI row */}
          <motion.div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8" variants={stagger} initial="hidden" animate="visible">
            {kpiCards.map((card, i) => (
              <motion.div key={card.label} custom={i} variants={fadeUp}
                className="rounded-2xl p-4 flex items-center gap-3"
                style={{ background: card.gradient, border: '1px solid rgba(171,173,175,0.12)', backdropFilter: 'blur(8px)' } as React.CSSProperties}>
                <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
                  style={{ background: 'rgba(255,255,255,0.7)', color: card.iconColor }}>
                  <Icon name={card.icon} size={20} />
                </div>
                <div>
                  <p className="label-caps">{card.label}</p>
                  <p className="text-xl font-black font-headline text-on-surface">{card.value}</p>
                </div>
              </motion.div>
            ))}
          </motion.div>

          {/* ── Toolbar ── */}
          <motion.div className="mb-5 space-y-3" variants={fadeUp} initial="hidden" animate="visible" custom={0.7}>
            {/* Row 1: search + dropdowns */}
            <div className="flex items-center gap-2 flex-wrap">
              {/* Search */}
              <div className="relative flex-1 min-w-[200px] max-w-sm">
                <Icon name="search" size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                <input
                  value={searchInput}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleSearchInput(e.target.value)}
                  placeholder={t('surveys.search.placeholder')}
                  className="w-full pl-9 pr-8 py-2 rounded-xl text-sm bg-white border border-[#dfe3e6] text-on-surface placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors"
                />
                {searchInput && (
                  <button onClick={() => { setSearchInput(''); setSearch(''); }}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-on-surface">
                    <Icon name="close" size={14} />
                  </button>
                )}
              </div>

              {/* Status multi-select */}
              <MultiSelectDropdown
                label={t('surveys.filters.status')}
                icon="radio_button_checked"
                options={STATUSES}
                selected={statusFilter}
                onChange={(next) => setStatusFilter(next as SurveyStatus[])}
                renderOption={(s) => (
                  <span className="flex items-center gap-2 text-sm capitalize">
                    <span className="w-2 h-2 rounded-full" style={{ background: ({ active:'#059669',draft:'#6b7280',paused:'#d97706',closed:'#b41340'} as Record<string, string>)[s] }} />
                    {s}
                  </span>
                )}
              />

              {/* Type multi-select */}
              <MultiSelectDropdown
                label={t('surveys.filters.type')}
                icon="category"
                options={TYPE_IDS}
                selected={typeFilter}
                onChange={setTypeFilter}
                renderOption={(typeId) => {
                  const meta = TYPE_META(typeId);
                  return (
                    <span className="flex items-center gap-2 text-sm">
                      <Icon name={meta.icon} size={13} style={{ color: meta.color }} />
                      {meta.label}
                    </span>
                  );
                }}
              />

              {/* Tag filter */}
              <MultiSelectDropdown
                label={t('groups.tags')}
                icon="label"
                options={availableTags.map(tag => tag.id)}
                selected={tagFilter}
                onChange={setTagFilter}
                dropdownWidth="w-64"
                renderOption={id => {
                  const tag = availableTags.find(tg => tg.id === id);
                  return tag ? (
                    <span className="flex items-center gap-2 text-sm min-w-0">
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: tag.color }} />
                      <span className="truncate">{tag.name}</span>
                    </span>
                  ) : <span className="text-sm">{id}</span>;
                }}
              />

              {/* Sort */}
              <SortDropdown value={sortBy} order={sortOrder} onChange={(by, ord) => { setSortBy(by); setSortOrder(ord as 'asc' | 'desc'); }} />
            </div>

            {/* Row 2: active filter pills + count */}
            {(hasActiveFilters || (!loading && total > 0)) && (
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2 flex-wrap">
                  {statusFilter.map((s) => (
                    <button key={s} onClick={() => setStatusFilter((p) => p.filter((x) => x !== s))}
                      className="flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold bg-primary/10 text-primary hover:bg-primary/15 transition-colors">
                      <span className="capitalize">{s}</span>
                      <Icon name="close" size={10} />
                    </button>
                  ))}
                  {typeFilter.map((typeId) => (
                    <button key={typeId} onClick={() => setTypeFilter((p) => p.filter((x) => x !== typeId))}
                      className="flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold hover:opacity-80 transition-opacity"
                      style={{ background: `${TYPE_META(typeId).color}18`, color: TYPE_META(typeId).color }}>
                      {TYPE_META(typeId).label}
                      <Icon name="close" size={10} />
                    </button>
                  ))}
                  {tagFilter.map(tagId => {
                    const tag = availableTags.find(tg => tg.id === tagId);
                    return tag ? (
                      <TagBadge
                        key={tagId}
                        tag={tag}
                        size="sm"
                        removable
                        onRemove={() => setTagFilter(p => p.filter(x => x !== tagId))}
                      />
                    ) : null;
                  })}
                  {activeFilterCount > 0 && (
                    <button onClick={() => { setStatusFilter([]); setTypeFilter([]); setTagFilter([]); }}
                      className="text-[11px] font-semibold text-muted-foreground hover:text-on-surface underline underline-offset-2">
                      {t('surveys.filters.clearAll')}
                    </button>
                  )}
                </div>
                {!loading && total > 0 && (
                  <span className="text-xs text-muted-foreground shrink-0">
                    {t('surveys.showing', { shown: surveys.length, total })}
                  </span>
                )}
              </div>
            )}
          </motion.div>

          {/* Loading skeleton */}
          {loading && <SurveyListSkeleton count={4} />}

          {/* Error */}
          {error && !loading && (
            <div className="banner-error mb-6">{t('surveys.errorLoading', { message: error })}</div>
          )}

          {/* Survey list */}
          {!loading && (
            <AnimatePresence mode="popLayout">
              <motion.div className="space-y-3" variants={stagger} initial="hidden" animate="visible">
                {surveys.map((survey, i) => {
                  const badgeVariant  = STATUS_BADGE_VARIANT[survey.status] || 'draft';
                  const responseCount = survey.response_count ?? 0;
                  const npsScore      = (survey as Survey & { npsScore?: number | null }).npsScore ?? survey.nps_score ?? null;
                  const typeMeta      = TYPE_META(survey.survey_type_id);
                  const topics        = (survey as Survey & { topics?: string[] }).topics || [];
                  const sentiment     = (survey as Survey & { sentiment?: string }).sentiment || null;

                  return (
                    <motion.div
                      key={survey.id}
                      custom={i}
                      variants={fadeUp}
                      layout
                      className="group flex items-stretch rounded-2xl cursor-pointer overflow-hidden relative"
                      style={{
                        background: 'rgba(255,255,255,0.78)',
                        backdropFilter: 'blur(16px)',
                        WebkitBackdropFilter: 'blur(16px)',
                        boxShadow: '0 4px 24px rgba(0,0,0,0.04), inset 0 1px 0 rgba(255,255,255,0.8)',
                        border: '1px solid rgba(255,255,255,0.6)',
                      } as React.CSSProperties}
                      whileHover={{ y: -2, boxShadow: '0 16px 40px -8px rgba(42,75,217,0.12), inset 0 1px 0 rgba(255,255,255,0.8)', transition: { duration: 0.18 } }}
                    >
                      {/* Type color accent bar */}
                      <div className="w-1 shrink-0 rounded-l-2xl" style={{ background: typeMeta.color }} />

                      <div className="flex flex-col sm:flex-row sm:items-center gap-4 p-5 flex-1 min-w-0">
                        {/* Hover overlay */}
                        <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none rounded-2xl"
                          style={{ background: 'linear-gradient(135deg,rgba(42,75,217,0.015),rgba(131,41,200,0.01))' }} />

                        {/* Title + meta */}
                        <div className="flex-1 min-w-0 relative">
                          <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                            <Badge variant={badgeVariant}>{survey.status === 'active' ? 'Live' : survey.status.charAt(0).toUpperCase() + survey.status.slice(1)}</Badge>
                            {survey.survey_type_id && (
                              <span className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full"
                                style={{ background: `${typeMeta.color}15`, color: typeMeta.color }}>
                                <Icon name={typeMeta.icon} size={10} />
                                {typeMeta.label}
                              </span>
                            )}
                            {sentiment && (
                              <div className="flex items-center gap-1">
                                <div className="w-1.5 h-1.5 rounded-full" style={{ background: (SENTIMENT_COLORS as Record<string, string>)[sentiment] }} />
                                <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: (SENTIMENT_COLORS as Record<string, string>)[sentiment] }}>{sentiment}</span>
                              </div>
                            )}
                          </div>
                          <h3 className="font-bold text-base truncate font-headline text-on-surface">{survey.title}</h3>
                          {survey.description && (
                            <p className="text-xs text-on-surface-variant mt-0.5 line-clamp-1 leading-relaxed">{survey.description}</p>
                          )}
                          {topics.length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-1.5">
                              {topics.slice(0, 3).map((topic: string) => (
                                <span key={topic} className="tag-topic">{topic}</span>
                              ))}
                              {topics.length > 3 && <span className="tag-topic">+{topics.length - 3}</span>}
                            </div>
                          )}
                          {(survey as Survey & { tags?: SurveyTag[] }).tags && (survey as Survey & { tags?: SurveyTag[] }).tags!.length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-1">
                              {(survey as Survey & { tags?: SurveyTag[] }).tags!.map(tag => (
                                <TagBadge
                                  key={tag.id}
                                  tag={tag}
                                  size="sm"
                                  onNavigate={(tagId) => navigate(toPath(ROUTES.TAG_REPORT_LATEST, { tagId }))}
                                />
                              ))}
                            </div>
                          )}
                        </div>

                        {/* Metrics */}
                        <div className="flex items-center gap-5 shrink-0 relative">
                          <div className="flex flex-col items-end gap-1">
                            <p className="label-caps">{t('surveys.metrics.responses')}</p>
                            <div className="flex items-center gap-2">
                              <Sparkline data={survey.sparkline ?? []} color={survey.status === 'active' ? '#2a4bd9' : '#94a3b8'} />
                              <p className="text-xl font-black font-headline text-on-surface">{responseCount.toLocaleString()}</p>
                            </div>
                          </div>
                          {npsScore !== null && (
                            <div className="text-right">
                              <p className="label-caps">{t('surveys.metrics.nps')}</p>
                              <p className="text-xl font-black font-headline" style={{ color: npsColor(npsScore) }}>{npsScore}</p>
                            </div>
                          )}
                          <div className="text-right">
                            <p className="label-caps">{t('surveys.metrics.updated')}</p>
                            <p className="text-sm font-semibold text-on-surface-variant">{timeAgo(survey.updated_at)}</p>
                          </div>
                        </div>

                        {/* Actions */}
                        <div className="flex items-center gap-2 shrink-0 relative">
                          {survey.status === 'active' && (
                            <Button variant="warning" size="sm"
                              onClick={(e: React.MouseEvent) => { e.stopPropagation(); setPauseTarget({ id: survey.id, title: survey.title, responseCount }); }}
                              className="rounded-xl bg-[rgba(217,119,6,0.08)] text-[#d97706] hover:bg-[rgba(217,119,6,0.15)] shadow-none">
                              <Icon name="pause" size={14} />{t('surveys.actions.pause')}
                            </Button>
                          )}
                          {survey.status === 'paused' && (
                            <Button variant="success" size="sm"
                              onClick={(e: React.MouseEvent) => { e.stopPropagation(); setResumeTarget({ id: survey.id, title: survey.title, responseCount }); }}
                              className="rounded-xl">
                              <Icon name="play_arrow" size={14} />{t('surveys.actions.resume')}
                            </Button>
                          )}
                          {survey.status === 'closed' && (
                            <Button variant="ghost" size="sm"
                              onClick={(e: React.MouseEvent) => { e.stopPropagation(); setReopenTarget({ id: survey.id, title: survey.title, responseCount }); }}
                              className="rounded-xl bg-[rgba(42,75,217,0.08)] text-primary hover:bg-[rgba(42,75,217,0.14)]">
                              <Icon name="lock_open" size={14} />{t('surveys.actions.reopen')}
                            </Button>
                          )}
                          <Button variant="ghost" size="sm"
                            onClick={(e: React.MouseEvent) => { e.stopPropagation(); navigate(toPath(ROUTES.RESPONSE_DASHBOARD, { surveyId: survey.id })); }}
                            className="rounded-xl bg-[rgba(5,150,105,0.08)] text-[#059669] hover:bg-[rgba(5,150,105,0.14)]">
                            <Icon name="bar_chart" size={14} />{t('surveys.actions.responses')}
                          </Button>
                          <Button variant="ghost" size="sm"
                            onClick={(e: React.MouseEvent) => { e.stopPropagation(); navigate(`${ROUTES.INSIGHTS}?survey=${survey.id}`); }}
                            className="rounded-xl bg-[rgba(42,75,217,0.08)] text-primary hover:bg-[rgba(42,75,217,0.14)]">
                            <Icon name="insights" size={14} />{t('surveys.actions.insights')}
                          </Button>
                          {survey.status !== 'closed' && (
                            <Button variant="ghost" size="icon"
                              onClick={(e: React.MouseEvent) => { e.stopPropagation(); navigate(toPath(ROUTES.BUILDER, { surveyId: survey.id }), { state: { title: survey.title, questions: survey.questions || [], surveyTypeId: survey.survey_type_id || null, tags: (survey as Survey & { tags?: SurveyTag[] }).tags || [] } }); }}
                              className="rounded-xl text-on-surface-variant hover:bg-[rgba(171,173,175,0.15)]">
                              <Icon name="edit" size={16} />
                            </Button>
                          )}
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" onClick={(e: React.MouseEvent) => e.stopPropagation()}
                                className="rounded-xl text-on-surface-variant hover:bg-[rgba(171,173,175,0.15)]">
                                <Icon name="more_vert" size={16} />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-52">
                              <DropdownMenuItem className="text-on-surface gap-2"
                                onClick={(e: React.MouseEvent) => {
                                  e.stopPropagation();
                                  setTagEditSurvey({ id: survey.id, title: survey.title, tags: (survey as Survey & { tags?: SurveyTag[] }).tags ?? [] });
                                }}>
                                <Icon name="label" size={15} className="text-[#6366f1]" />{t('groups.manageTags')}
                              </DropdownMenuItem>
                              <DropdownMenuItem className="text-on-surface gap-2"
                                onClick={(e: React.MouseEvent) => { e.stopPropagation(); navigate(toPath(ROUTES.SAMPLE_RESPONSES, { surveyId: survey.id })); }}>
                                <Icon name="auto_awesome" size={15} className="text-primary" />{t('surveys.actions.generateResponses')}
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              {(survey.status === 'active' || survey.status === 'paused') && (
                                <DropdownMenuItem className="text-[#6b7280] gap-2"
                                  onClick={(e: React.MouseEvent) => { e.stopPropagation(); setCloseTarget({ id: survey.id, title: survey.title, responseCount }); }}>
                                  <Icon name="lock" size={15} />{t('surveys.actions.close')}
                                </DropdownMenuItem>
                              )}
                              {(survey.status === 'active' || survey.status === 'paused') && <DropdownMenuSeparator />}
                              {isAnalyst && (
                                <DropdownMenuItem className="text-[#b41340] focus:text-[#b41340] focus:bg-[#fff0f0] gap-2"
                                  onClick={(e: React.MouseEvent) => { e.stopPropagation(); setDeleteTarget({ id: survey.id, title: survey.title, responseCount }); }}>
                                  <Icon name="delete" size={15} />{t('surveys.actions.delete')}
                                </DropdownMenuItem>
                              )}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </div>
                    </motion.div>
                  );
                })}

                {/* Empty state */}
                {surveys.length === 0 && (
                  <motion.div variants={fadeUp} className="py-16 px-4 max-w-2xl mx-auto text-center">
                    <motion.div className="w-20 h-20 rounded-3xl flex items-center justify-center mx-auto mb-6"
                      style={{ background: 'linear-gradient(135deg,rgba(42,75,217,0.08),rgba(131,41,200,0.05))', border: '1px solid rgba(42,75,217,0.1)' }}
                      animate={{ y: [0, -5, 0] }} transition={{ duration: 3.5, repeat: Infinity, ease: 'easeInOut' }}>
                      <Icon name={hasActiveFilters ? 'search_off' : 'assignment'} size={36} className="text-primary" />
                    </motion.div>
                    <h3 className="text-2xl font-extrabold mb-2 font-headline tracking-tight text-on-surface">
                      {hasActiveFilters ? 'No surveys match your filters' : t('surveys.empty.heading')}
                    </h3>
                    <p className="text-sm mb-8 text-on-surface-variant">
                      {hasActiveFilters
                        ? 'Try adjusting your search or filters to find what you\'re looking for.'
                        : t('surveys.empty.description')}
                    </p>
                    {hasActiveFilters ? (
                      <Button variant="outline" onClick={() => { setSearchInput(''); setSearch(''); setStatusFilter([]); setTypeFilter([]); setTagFilter([]); }}
                        className="rounded-xl gap-1.5">
                        <Icon name="filter_alt_off" size={16} />Clear all filters
                      </Button>
                    ) : (
                      <>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-left">
                          <motion.div whileHover={{ scale: 1.02, y: -2 }} whileTap={{ scale: 0.98 }}
                            onClick={() => navigate(ROUTES.CREATE)}
                            className="relative cursor-pointer rounded-2xl p-5 overflow-hidden"
                            style={{ background: 'linear-gradient(135deg,rgba(42,75,217,0.07) 0%,rgba(131,41,200,0.05) 100%)', border: '1px solid rgba(42,75,217,0.18)', boxShadow: '0 4px 20px rgba(42,75,217,0.08)' }}>
                            <div className="absolute top-3 right-3">
                              <span className="text-[10px] font-black tracking-widest uppercase px-2 py-0.5 rounded-full text-white" style={{ background: 'linear-gradient(135deg,#2a4bd9,#8329c8)' }}>Recommended</span>
                            </div>
                            <div className="w-10 h-10 rounded-xl flex items-center justify-center mb-3" style={{ background: 'linear-gradient(135deg,#2a4bd9,#8329c8)' }}>
                              <Icon name="auto_awesome" fill={1} size={20} className="text-white" />
                            </div>
                            <p className="font-bold text-base text-on-surface mb-1">{t('surveys.empty.aiTitle')}</p>
                            <p className="text-xs leading-relaxed text-on-surface-variant">{t('surveys.empty.aiDescription')}</p>
                          </motion.div>
                          <motion.div whileHover={{ scale: 1.02, y: -2 }} whileTap={{ scale: 0.98 }}
                            onClick={() => navigate(ROUTES.CREATE, { state: { mode: 'manual' } })}
                            className="cursor-pointer rounded-2xl p-5"
                            style={{ background: 'rgba(255,255,255,0.7)', border: '1px solid rgba(171,173,175,0.25)', boxShadow: '0 4px 20px rgba(0,0,0,0.04)' }}>
                            <div className="w-10 h-10 rounded-xl flex items-center justify-center mb-3 bg-surface-container">
                              <Icon name="edit_note" size={20} className="text-on-surface-variant" />
                            </div>
                            <p className="font-bold text-base text-on-surface mb-1">{t('surveys.empty.manualTitle')}</p>
                            <p className="text-xs leading-relaxed text-on-surface-variant">{t('surveys.empty.manualDescription')}</p>
                          </motion.div>
                        </div>
                        <div className="mt-5 flex items-center justify-center gap-3">
                          <div className="h-px flex-1 bg-border" />
                          <span className="text-xs text-on-surface-variant">{t('surveys.empty.orDivider')}</span>
                          <div className="h-px flex-1 bg-border" />
                        </div>
                        <button onClick={() => navigate(ROUTES.TEMPLATES)}
                          className="mt-4 text-xs font-semibold text-primary hover:underline underline-offset-2 flex items-center gap-1 mx-auto">
                          <Icon name="dashboard" size={14} />{t('surveys.empty.templateTitle')}
                        </button>
                      </>
                    )}
                  </motion.div>
                )}
              </motion.div>
            </AnimatePresence>
          )}

          {/* ── Load more / all loaded ── */}
          {!loading && surveys.length > 0 && (
            <div className="mt-6 flex items-center justify-center">
              {hasMore ? (
                <Button variant="outline" onClick={() => fetchSurveys(page + 1, true)} disabled={loadingMore}
                  className="rounded-xl px-6 gap-2 text-sm font-semibold border-[#dfe3e6] text-on-surface-variant hover:bg-surface-container">
                  {loadingMore ? (
                    <><Spinner size={14} color="#595c5e" />{t('common.loading')}</>
                  ) : (
                    <>{t('surveys.loadMore', { n: Math.min(PAGE_SIZE, remaining) })}<span className="text-xs text-muted-foreground">({remaining} remaining)</span></>
                  )}
                </Button>
              ) : (
                total > PAGE_SIZE && (
                  <p className="text-xs text-muted-foreground">{t('surveys.allLoaded', { total })}</p>
                )
              )}
            </div>
          )}

        </div>

      {/* Modals */}
      <PauseModal open={!!pauseTarget} onClose={() => setPauseTarget(null)}
        surveyTitle={pauseTarget?.title} responseCount={pauseTarget?.responseCount ?? 0}
        busy={statusChanging === pauseTarget?.id}
        onConfirm={async () => { if (!pauseTarget) return; setStatusChanging(pauseTarget.id); await updateSurvey(pauseTarget.id, { status: 'paused' }); setStatusChanging(null); setPauseTarget(null); }} />

      <ResumeModal open={!!resumeTarget} onClose={() => setResumeTarget(null)}
        surveyTitle={resumeTarget?.title} responseCount={resumeTarget?.responseCount ?? 0}
        busy={statusChanging === resumeTarget?.id}
        onConfirm={async () => { if (!resumeTarget) return; setStatusChanging(resumeTarget.id); await updateSurvey(resumeTarget.id, { status: 'active' }); setStatusChanging(null); setResumeTarget(null); }} />

      <CloseModal open={!!closeTarget} onClose={() => setCloseTarget(null)}
        surveyTitle={closeTarget?.title} responseCount={closeTarget?.responseCount ?? 0}
        busy={statusChanging === closeTarget?.id}
        onConfirm={async () => { if (!closeTarget) return; setStatusChanging(closeTarget.id); await updateSurvey(closeTarget.id, { status: 'closed' }); setStatusChanging(null); setCloseTarget(null); }} />

      <ReopenModal open={!!reopenTarget} onClose={() => setReopenTarget(null)}
        surveyTitle={reopenTarget?.title} responseCount={reopenTarget?.responseCount ?? 0}
        busy={statusChanging === reopenTarget?.id}
        onConfirm={async () => { if (!reopenTarget) return; setStatusChanging(reopenTarget.id); await updateSurvey(reopenTarget.id, { status: 'active' }); setStatusChanging(null); setReopenTarget(null); }} />

      <DeleteSurveyModal open={!!deleteTarget} onClose={() => setDeleteTarget(null)}
        surveyTitle={deleteTarget?.title} responseCount={deleteTarget?.responseCount ?? 0}
        busy={statusChanging === deleteTarget?.id}
        onConfirm={async () => { if (!deleteTarget) return; setStatusChanging(deleteTarget.id); await deleteSurvey(deleteTarget.id); setStatusChanging(null); setDeleteTarget(null); }} />

      {/* Tag management sheet — opens from the ⋮ menu on any survey row */}
      <Sheet open={!!tagEditSurvey} onOpenChange={(o) => { if (!o) setTagEditSurvey(null); }}>
        <SheetContent side="right" className="w-full sm:max-w-sm">
          <SheetHeader className="mb-5">
            <SheetTitle className="flex items-center gap-2 text-base font-bold">
              <Icon name="label" size={16} style={{ color: '#6366f1' }} />
              {t('groups.manageTags')}
            </SheetTitle>
            {tagEditSurvey && (
              <p className="text-sm text-muted-foreground truncate">{tagEditSurvey.title}</p>
            )}
          </SheetHeader>
          {tagEditSurvey && (
            <TagSelector
              selectedTags={tagEditSurvey.tags}
              onAdd={async (tag) => {
                const updated = [...tagEditSurvey.tags, tag];
                setTagEditSurvey(prev => prev ? { ...prev, tags: updated } : null);
                setSurveys(prev => prev.map(s =>
                  s.id === tagEditSurvey.id
                    ? { ...s, tags: updated } as Survey & { tags: SurveyTag[] }
                    : s
                ));
                try { await api.addTagsToSurvey(tagEditSurvey.id, [tag.id]); }
                catch { /* revert on failure */ }
              }}
              onRemove={async (tagId) => {
                const updated = tagEditSurvey.tags.filter(t => t.id !== tagId);
                setTagEditSurvey(prev => prev ? { ...prev, tags: updated } : null);
                setSurveys(prev => prev.map(s =>
                  s.id === tagEditSurvey.id
                    ? { ...s, tags: updated } as Survey & { tags: SurveyTag[] }
                    : s
                ));
                try { await api.removeTagFromSurvey(tagEditSurvey.id, tagId); }
                catch { /* revert on failure */ }
              }}
            />
          )}
          <p className="text-xs text-muted-foreground mt-4 flex items-center gap-1.5">
            <Icon name="info" size={11} />
            {t('groups.tagHint')}
          </p>
        </SheetContent>
      </Sheet>
    </>
  );
}
