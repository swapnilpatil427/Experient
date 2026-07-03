import { useState, useEffect, useCallback, useMemo, useRef, ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Icon } from '../components/Icon';
import { useApi } from '../hooks/useApi';
import type { Survey, SurveyResponse, Answer } from '../types';
import { ROUTES } from '../constants/routes';
import { useTranslation } from '../lib/i18n';
import { useSetPageTitle } from '../contexts/pageTitle';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuCheckboxItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { PageHeader } from '../components/PageHeader';

// ── Column definitions ────────────────────────────────────────────────────────

interface ColDef {
  id: string;
  header: string;
  group: 'fixed' | 'question' | 'enrichment';
  questionId?: string;
  questionType?: string;
  minWidth?: number;
}

const ENRICHMENT_COLS: Omit<ColDef, 'header'>[] = [
  { id: 'nps_score',       group: 'enrichment', minWidth: 72  },
  { id: 'ai_sentiment',    group: 'enrichment', minWidth: 110 },
  { id: 'ai_emotion',      group: 'enrichment', minWidth: 110 },
  { id: 'ai_topics',       group: 'enrichment', minWidth: 160 },
  { id: 'ai_effort_score', group: 'enrichment', minWidth: 80  },
  { id: 'device_type',     group: 'enrichment', minWidth: 90  },
  { id: 'country',         group: 'enrichment', minWidth: 90  },
  { id: 'completion_time_s', group: 'enrichment', minWidth: 80 },
];

// Enrichment cols visible by default
const DEFAULT_ENRICHMENT_VISIBLE = new Set(['nps_score', 'ai_sentiment', 'ai_emotion', 'ai_topics']);

const PAGE_SIZE = 25;

// ── Cell helpers ──────────────────────────────────────────────────────────────

function NpsBadge({ score: raw }: { score: number | string | null | undefined }) {
  if (raw == null) return <span className="text-on-surface-variant/40">—</span>;
  const score = Number(raw);
  const cls =
    score >= 9 ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
    : score >= 7 ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400'
    : 'bg-red-500/15 text-red-700 dark:text-red-400';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold ${cls}`}>
      {score}
    </span>
  );
}

function SentimentBadge({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="text-on-surface-variant/40">—</span>;
  const map: Record<string, string> = {
    positive: 'bg-emerald-500/15 text-emerald-700',
    negative: 'bg-red-500/15 text-red-700',
    neutral:  'bg-gray-500/15 text-gray-600',
    mixed:    'bg-blue-500/15 text-blue-700',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold capitalize ${map[value] ?? map.neutral}`}>
      {value}
    </span>
  );
}

function TruncatedText({ text, maxLen = 80 }: { text: string; maxLen?: number }) {
  if (text.length <= maxLen) return <span>{text}</span>;
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-help underline decoration-dotted decoration-on-surface-variant/40">
            {text.slice(0, maxLen)}…
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs text-xs whitespace-pre-wrap">{text}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function ChoicePill({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold"
      style={{ background: 'color-mix(in srgb, var(--color-primary) 8%, transparent)', color: 'var(--color-primary)' }}>
      {label}
    </span>
  );
}

function CsatScore({ value }: { value: number }) {
  const color =
    value >= 4 ? { bg: 'rgba(16,185,129,0.1)', text: '#059669' }
    : value === 3 ? { bg: 'rgba(245,158,11,0.1)', text: '#d97706' }
    : { bg: 'rgba(239,68,68,0.1)', text: '#dc2626' };
  return (
    <span className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full text-xs font-bold"
      style={{ background: color.bg, color: color.text }}>
      {value}<span className="font-normal opacity-60">/5</span>
    </span>
  );
}

function renderAnswerValue(value: unknown, type: string | undefined): ReactNode {
  if (value == null || value === '') return <span className="text-on-surface-variant/30">—</span>;

  switch (type) {
    case 'nps':    return <NpsBadge score={typeof value === 'number' ? value : Number(value)} />;
    case 'csat':   return <CsatScore value={Number(value)} />;
    case 'rating':
    case 'slider': return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold tabular-nums"
        style={{ background: 'color-mix(in srgb, var(--color-primary) 7%, transparent)', color: 'var(--color-primary)' }}>
        {String(value)}
      </span>
    );
    case 'open_text':
    case 'short_text': {
      const str = String(value);
      return <TruncatedText text={str} maxLen={90} />;
    }
    case 'multiple_choice':
    case 'dropdown':
      return <ChoicePill label={String(value)} />;
    case 'checkbox':
    case 'ranking': {
      let arr: unknown[];
      if (Array.isArray(value)) arr = value;
      else { try { arr = JSON.parse(String(value)); } catch { arr = [value]; } }
      return (
        <div className="flex flex-wrap gap-1">
          {arr.map((v, i) => <ChoicePill key={i} label={String(v)} />)}
        </div>
      );
    }
    case 'matrix': {
      const obj = typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
      const pairs = Object.entries(obj).map(([k, v]) =>
        `${k}: ${Array.isArray(v) ? (v as unknown[]).join(', ') : String(v)}`
      );
      return <TruncatedText text={pairs.join(' | ')} maxLen={80} />;
    }
    case 'date':   return <span className="tabular-nums text-xs">{String(value)}</span>;
    case 'statement': return <span className="text-on-surface-variant/30">—</span>;
    default:       return <TruncatedText text={String(value)} maxLen={80} />;
  }
}

function renderEnrichmentCell(resp: SurveyResponse, colId: string): ReactNode {
  switch (colId) {
    case 'nps_score':         return <NpsBadge score={resp.nps_score} />;
    case 'ai_sentiment':      return <SentimentBadge value={resp.ai_sentiment} />;
    case 'ai_emotion':        return resp.ai_emotion
      ? <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold capitalize"
          style={{ background: 'rgba(139,52,200,0.08)', color: 'var(--color-tertiary)' }}>{resp.ai_emotion}</span>
      : <span className="text-on-surface-variant/30">—</span>;
    case 'ai_topics':         return resp.ai_topics?.length
      ? <div className="flex flex-wrap gap-1">{resp.ai_topics.slice(0, 3).map((t, i) => (
          <span key={i} className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium"
            style={{ background: 'rgba(8,145,178,0.08)', color: '#0891b2' }}>{t}</span>
        ))}</div>
      : <span className="text-on-surface-variant/30">—</span>;
    case 'ai_effort_score':   return resp.ai_effort_score != null
      ? <span className="font-semibold tabular-nums">{Number(resp.ai_effort_score).toFixed(1)}</span>
      : <span className="text-on-surface-variant/30">—</span>;
    case 'device_type':       return resp.device_type
      ? <span className="capitalize text-xs">{resp.device_type}</span>
      : <span className="text-on-surface-variant/30">—</span>;
    case 'country':           return resp.country
      ? <span className="text-xs">{resp.country}</span>
      : <span className="text-on-surface-variant/30">—</span>;
    case 'completion_time_s': return resp.completion_time_s != null
      ? <span className="tabular-nums text-xs">{resp.completion_time_s}s</span>
      : <span className="text-on-surface-variant/30">—</span>;
    default: return <span className="text-on-surface-variant/30">—</span>;
  }
}

// ── Skeleton row ──────────────────────────────────────────────────────────────

function SkeletonRow({ cols }: { cols: number }) {
  return (
    <TableRow>
      {Array.from({ length: cols }).map((_, i) => (
        <TableCell key={i}>
          <div className="h-4 rounded animate-pulse bg-on-surface/8" style={{ width: `${40 + (i % 3) * 20}%` }} />
        </TableCell>
      ))}
    </TableRow>
  );
}

// ── Pagination helper ─────────────────────────────────────────────────────────

function pageRange(current: number, total: number): (number | '…')[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages: (number | '…')[] = [1];
  if (current > 3)  pages.push('…');
  for (let p = Math.max(2, current - 1); p <= Math.min(total - 1, current + 1); p++) pages.push(p);
  if (current < total - 2) pages.push('…');
  pages.push(total);
  return pages;
}

// ── Main component ────────────────────────────────────────────────────────────

export function DataPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const api = useApi();
  useSetPageTitle(t('data.pageTitle'), t('data.pageSubtitle'));

  // Survey selector
  const [surveys, setSurveys]               = useState<Survey[]>([]);
  const [selectedSurveyId, setSelectedSurveyId] = useState<string>('');
  const [selectedSurvey, setSelectedSurvey] = useState<Survey | null>(null);
  const [surveysLoading, setSurveysLoading] = useState(true);

  // Response grid
  const [responses, setResponses] = useState<SurveyResponse[]>([]);
  const [total, setTotal]         = useState(0);
  const [dataLoading, setDataLoading] = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const [page, setPage]           = useState(1);

  // Filters
  const [searchInput, setSearchInput]       = useState('');
  const [search, setSearch]                 = useState('');
  const [filterSentiment, setFilterSentiment] = useState('');
  const [filterNpsMin, setFilterNpsMin]     = useState('');
  const [filterNpsMax, setFilterNpsMax]     = useState('');
  const [filterDateFrom, setFilterDateFrom] = useState('');
  const [filterDateTo, setFilterDateTo]     = useState('');

  // Column visibility (persisted)
  const [hiddenCols, setHiddenCols] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem('data-hidden-cols');
      return raw ? new Set(JSON.parse(raw)) : new Set<string>();
    } catch { return new Set<string>(); }
  });

  const toggleCol = useCallback((id: string) => {
    setHiddenCols(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      try { localStorage.setItem('data-hidden-cols', JSON.stringify([...next])); } catch {}
      return next;
    });
  }, []);

  // Debounce search
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const handleSearchChange = (val: string) => {
    setSearchInput(val);
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => { setSearch(val); setPage(1); }, 350);
  };

  // ── Load surveys ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!api) return;
    setSurveysLoading(true);
    api.listSurveys({ limit: 50 })
      .then(r => {
        const list = r.surveys || [];
        setSurveys(list);
        if (list.length > 0 && !selectedSurveyId) setSelectedSurveyId(list[0].id);
      })
      .catch(() => {})
      .finally(() => setSurveysLoading(false));
  }, [api]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load survey detail (questions) ───────────────────────────────────────────
  useEffect(() => {
    if (!api || !selectedSurveyId) { setSelectedSurvey(null); return; }
    api.getSurvey(selectedSurveyId)
      .then(r => setSelectedSurvey(r.survey))
      .catch(() => setSelectedSurvey(null));
  }, [api, selectedSurveyId]);

  // ── Load responses ────────────────────────────────────────────────────────────
  const loadResponses = useCallback(async () => {
    if (!api || !selectedSurveyId) return;
    setDataLoading(true);
    setError(null);
    try {
      const params: Parameters<typeof api.getResponses>[1] = {
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
      };
      if (search)          params.search    = search;
      if (filterSentiment) params.sentiment = filterSentiment;
      if (filterNpsMin !== '' && !isNaN(Number(filterNpsMin))) params.nps_min = Number(filterNpsMin);
      if (filterNpsMax !== '' && !isNaN(Number(filterNpsMax))) params.nps_max = Number(filterNpsMax);
      if (filterDateFrom)  params.date_from = filterDateFrom;
      if (filterDateTo)    params.date_to   = filterDateTo;

      const res = await api.getResponses(selectedSurveyId, params);
      setResponses(res.responses || []);
      setTotal(res.total || 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDataLoading(false);
    }
  }, [api, selectedSurveyId, page, search, filterSentiment, filterNpsMin, filterNpsMax, filterDateFrom, filterDateTo]);

  useEffect(() => { loadResponses(); }, [loadResponses]);

  // Reset page to 1 on filter change
  const handleSentimentChange = (v: string) => { setFilterSentiment(v === 'all' ? '' : v); setPage(1); };
  const handleNpsMinChange    = (v: string) => { setFilterNpsMin(v);  setPage(1); };
  const handleNpsMaxChange    = (v: string) => { setFilterNpsMax(v);  setPage(1); };
  const handleDateFromChange  = (v: string) => { setFilterDateFrom(v); setPage(1); };
  const handleDateToChange    = (v: string) => { setFilterDateTo(v);   setPage(1); };
  const handleSurveyChange    = (v: string) => { setSelectedSurveyId(v); setPage(1); clearAllFilters(); };

  const clearAllFilters = () => {
    setSearchInput(''); setSearch('');
    setFilterSentiment(''); setFilterNpsMin(''); setFilterNpsMax('');
    setFilterDateFrom(''); setFilterDateTo('');
  };

  const hasFilters = !!(search || filterSentiment || filterNpsMin || filterNpsMax || filterDateFrom || filterDateTo);

  // ── Column definitions ────────────────────────────────────────────────────────
  const colDefs = useMemo((): ColDef[] => {
    const cols: ColDef[] = [
      { id: 'submitted_at', header: t('data.colSubmittedAt'), group: 'fixed', minWidth: 140 },
    ];
    // Question columns
    if (selectedSurvey?.questions) {
      for (const q of selectedSurvey.questions) {
        if (q.type === 'statement') continue;
        cols.push({
          id: `q__${q.id}`,
          header: q.question.length > 40 ? q.question.slice(0, 40) + '…' : q.question,
          group: 'question',
          questionId: q.id,
          questionType: q.type,
          minWidth: 140,
        });
      }
    }
    // Enrichment columns
    const enrichmentHeaders: Record<string, string> = {
      nps_score:         t('data.colNpsScore'),
      ai_sentiment:      t('data.colSentiment'),
      ai_emotion:        t('data.colEmotion'),
      ai_topics:         t('data.colTopics'),
      ai_effort_score:   t('data.colEffortScore'),
      device_type:       t('data.colDevice'),
      country:           t('data.colCountry'),
      completion_time_s: t('data.colTime'),
    };
    for (const ec of ENRICHMENT_COLS) {
      cols.push({ ...ec, header: enrichmentHeaders[ec.id] });
    }
    return cols;
  }, [selectedSurvey, t]);

  const visibleCols = useMemo(() => {
    return colDefs.filter(c => {
      if (c.group === 'fixed') return true;
      if (c.group === 'enrichment') {
        if (hiddenCols.has(c.id)) return false;
        return DEFAULT_ENRICHMENT_VISIBLE.has(c.id) || !hiddenCols.has(c.id);
      }
      return !hiddenCols.has(c.id);
    });
  }, [colDefs, hiddenCols]);

  // ── Helpers ───────────────────────────────────────────────────────────────────
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const fromRow    = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const toRow      = Math.min(page * PAGE_SIZE, total);

  function getAnswerForQuestion(resp: SurveyResponse, questionId: string): Answer | undefined {
    return (resp.answers || []).find(a => a.questionId === questionId);
  }

  function formatDate(iso: string) {
    try { return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
    catch { return iso; }
  }

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div className="max-w-7xl mx-auto w-full">
      <PageHeader
        crumbs={[{ label: t('data.pageTitle'), icon: 'dataset', path: ROUTES.DATA }]}
        title={t('data.pageTitle')}
        subtitle={total > 0 ? t('data.showingCount', { from: fromRow, to: toRow, total }) : t('data.pageSubtitle')}
        actions={
          <div className="flex items-center gap-2">
            <Select value={selectedSurveyId} onValueChange={handleSurveyChange}>
              <SelectTrigger className="w-56 text-sm font-semibold rounded-xl border-[rgba(171,173,175,0.3)]">
                <SelectValue placeholder={surveysLoading ? t('common.loading') : t('data.allSurveys')} />
              </SelectTrigger>
              <SelectContent>
                {surveys.map(s => (
                  <SelectItem key={s.id} value={s.id}>{s.title}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="ghost" size="icon" onClick={loadResponses} className="rounded-xl" disabled={dataLoading}>
              <motion.span animate={dataLoading ? { rotate: 360 } : { rotate: 0 }} transition={{ duration: 1, repeat: dataLoading ? Infinity : 0, ease: 'linear' }}>
                <Icon name="refresh" size={18} />
              </motion.span>
            </Button>
          </div>
        }
      />

      {/* No survey state */}
      {!selectedSurveyId && !surveysLoading && (
        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}
          className="flex flex-col items-center justify-center py-24 text-center">
          <div className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4"
            style={{ background: 'color-mix(in srgb, var(--color-primary) 6%, transparent)' }}>
            <Icon name="dataset" size={28} className="text-primary" />
          </div>
          <h3 className="font-bold text-lg text-on-surface mb-2 font-headline">{t('data.emptyHeading')}</h3>
          <p className="text-sm text-on-surface-variant max-w-xs mb-6">{t('data.selectSurveyPrompt')}</p>
          <Button onClick={() => navigate(ROUTES.SURVEYS)} variant="gradient" className="rounded-xl font-bold">
            {t('nav.surveys')}
          </Button>
        </motion.div>
      )}

      {selectedSurveyId && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-3">
          {/* Filter bar */}
          <div className="glass-card rounded-2xl border border-[rgba(255,255,255,0.6)] shadow-sm p-3">
            <div className="flex flex-wrap items-center gap-2">
              {/* Search */}
              <div className="relative flex-1 min-w-[200px]">
                <Icon name="search" size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant pointer-events-none" />
                <Input
                  value={searchInput}
                  onChange={e => handleSearchChange(e.target.value)}
                  placeholder={t('data.searchPlaceholder')}
                  className="pl-9 h-9 rounded-xl text-sm border-[rgba(171,173,175,0.3)]"
                />
              </div>

              {/* Sentiment */}
              <Select value={filterSentiment || 'all'} onValueChange={handleSentimentChange}>
                <SelectTrigger className="w-40 h-9 text-sm rounded-xl border-[rgba(171,173,175,0.3)]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('data.allSentiments')}</SelectItem>
                  <SelectItem value="positive">{t('data.sentimentPositive')}</SelectItem>
                  <SelectItem value="negative">{t('data.sentimentNegative')}</SelectItem>
                  <SelectItem value="neutral">{t('data.sentimentNeutral')}</SelectItem>
                  <SelectItem value="mixed">{t('data.sentimentMixed')}</SelectItem>
                </SelectContent>
              </Select>

              {/* NPS range */}
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-semibold text-on-surface-variant whitespace-nowrap">{t('data.filterNps')}</span>
                <Input
                  type="number" min={0} max={10} placeholder={t('data.filterNpsMin')}
                  value={filterNpsMin}
                  onChange={e => handleNpsMinChange(e.target.value)}
                  className="w-16 h-9 text-sm rounded-xl border-[rgba(171,173,175,0.3)] text-center"
                />
                <span className="text-on-surface-variant/40 text-xs">–</span>
                <Input
                  type="number" min={0} max={10} placeholder={t('data.filterNpsMax')}
                  value={filterNpsMax}
                  onChange={e => handleNpsMaxChange(e.target.value)}
                  className="w-16 h-9 text-sm rounded-xl border-[rgba(171,173,175,0.3)] text-center"
                />
              </div>

              {/* Date range */}
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-semibold text-on-surface-variant whitespace-nowrap">{t('data.filterDateRange')}</span>
                <Input
                  type="date" value={filterDateFrom}
                  onChange={e => handleDateFromChange(e.target.value)}
                  className="w-36 h-9 text-sm rounded-xl border-[rgba(171,173,175,0.3)]"
                />
                <span className="text-on-surface-variant/40 text-xs">–</span>
                <Input
                  type="date" value={filterDateTo}
                  onChange={e => handleDateToChange(e.target.value)}
                  className="w-36 h-9 text-sm rounded-xl border-[rgba(171,173,175,0.3)]"
                />
              </div>

              {/* Spacer */}
              <div className="flex-1" />

              {/* Clear filters */}
              <AnimatePresence>
                {hasFilters && (
                  <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }}>
                    <Button variant="ghost" size="sm" onClick={clearAllFilters} className="h-9 rounded-xl text-xs font-semibold">
                      <Icon name="close" size={14} className="mr-1" />
                      {t('data.clearFilters')}
                    </Button>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Column visibility */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="h-9 rounded-xl text-xs font-semibold border-[rgba(171,173,175,0.3)] gap-1.5">
                    <Icon name="view_column" size={14} />
                    {t('data.columns')}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56 max-h-96 overflow-y-auto">
                  <DropdownMenuLabel className="text-xs">{t('data.groupQuestion')}</DropdownMenuLabel>
                  {colDefs.filter(c => c.group === 'question').map(col => (
                    <DropdownMenuCheckboxItem
                      key={col.id}
                      checked={!hiddenCols.has(col.id)}
                      onCheckedChange={() => toggleCol(col.id)}
                      className="text-xs"
                    >
                      {col.header}
                    </DropdownMenuCheckboxItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel className="text-xs">{t('data.groupEnrichment')}</DropdownMenuLabel>
                  {colDefs.filter(c => c.group === 'enrichment').map(col => (
                    <DropdownMenuCheckboxItem
                      key={col.id}
                      checked={!hiddenCols.has(col.id)}
                      onCheckedChange={() => toggleCol(col.id)}
                      className="text-xs"
                    >
                      {col.header}
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {/* Error */}
          {error && !dataLoading && (
            <div className="banner-error rounded-2xl">{error}</div>
          )}

          {/* Data table */}
          <div className="glass-card rounded-2xl border border-[rgba(255,255,255,0.6)] shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="border-b border-[rgba(0,0,0,0.06)] bg-on-surface/[0.02]">
                    <TableHead className="w-12 text-center text-xs font-bold sticky left-0 bg-surface/90 backdrop-blur-sm z-10">#</TableHead>
                    {visibleCols.map(col => (
                      <TableHead
                        key={col.id}
                        className="text-xs font-bold text-on-surface-variant whitespace-nowrap"
                        style={{ minWidth: col.minWidth }}
                      >
                        {col.header}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {dataLoading && responses.length === 0 && (
                    Array.from({ length: 8 }).map((_, i) => (
                      <SkeletonRow key={i} cols={visibleCols.length + 1} />
                    ))
                  )}

                  {!dataLoading && responses.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={visibleCols.length + 1}>
                        <div className="flex flex-col items-center justify-center py-16 text-center">
                          <div className="w-12 h-12 rounded-xl flex items-center justify-center mb-3"
                            style={{ background: 'color-mix(in srgb, var(--color-primary) 6%, transparent)' }}>
                            <Icon name="search_off" size={22} className="text-primary" />
                          </div>
                          <p className="font-semibold text-sm text-on-surface mb-1">
                            {hasFilters ? t('data.emptyFilterHeading') : t('data.emptyHeading')}
                          </p>
                          <p className="text-xs text-on-surface-variant max-w-xs">
                            {hasFilters ? t('data.emptyFilterDescription') : t('data.emptyDescription')}
                          </p>
                          {hasFilters && (
                            <Button variant="ghost" size="sm" onClick={clearAllFilters} className="mt-3 rounded-xl text-xs">
                              {t('data.clearFilters')}
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  )}

                  {responses.map((resp, idx) => (
                    <motion.tr
                      key={resp.id}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ duration: 0.15, delay: idx * 0.02 }}
                      className="border-b border-[rgba(0,0,0,0.04)] hover:bg-on-surface/[0.02] transition-colors"
                    >
                      {/* Row number */}
                      <td className="w-12 text-center px-2 py-2.5 text-xs text-on-surface-variant/50 font-mono sticky left-0 bg-surface/90 backdrop-blur-sm z-10">
                        {(page - 1) * PAGE_SIZE + idx + 1}
                      </td>

                      {visibleCols.map(col => {
                        if (col.id === 'submitted_at') {
                          return (
                            <TableCell key={col.id} className="text-xs text-on-surface-variant whitespace-nowrap">
                              {formatDate(resp.submitted_at)}
                            </TableCell>
                          );
                        }
                        if (col.group === 'question' && col.questionId) {
                          const ans = getAnswerForQuestion(resp, col.questionId);
                          return (
                            <TableCell key={col.id} style={{ minWidth: col.minWidth }}>
                              {renderAnswerValue(ans?.value, col.questionType)}
                            </TableCell>
                          );
                        }
                        if (col.group === 'enrichment') {
                          return (
                            <TableCell key={col.id} style={{ minWidth: col.minWidth }}>
                              {renderEnrichmentCell(resp, col.id)}
                            </TableCell>
                          );
                        }
                        return <TableCell key={col.id}>—</TableCell>;
                      })}
                    </motion.tr>
                  ))}
                </TableBody>
              </Table>
            </div>

            {/* Pagination */}
            {total > PAGE_SIZE && (
              <div className="flex items-center justify-between px-4 py-3 border-t border-[rgba(0,0,0,0.06)]">
                <span className="text-xs text-on-surface-variant">
                  {t('data.showingCount', { from: fromRow, to: toRow, total })}
                </span>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost" size="sm"
                    className="h-8 w-8 p-0 rounded-lg"
                    onClick={() => setPage(p => Math.max(1, p - 1))}
                    disabled={page === 1 || dataLoading}
                  >
                    <Icon name="chevron_left" size={16} />
                  </Button>

                  {pageRange(page, totalPages).map((p, i) =>
                    p === '…' ? (
                      <span key={`ellipsis-${i}`} className="w-8 h-8 flex items-center justify-center text-xs text-on-surface-variant">…</span>
                    ) : (
                      <Button
                        key={p}
                        variant={p === page ? 'default' : 'ghost'}
                        size="sm"
                        className="h-8 w-8 p-0 rounded-lg text-xs font-semibold"
                        onClick={() => setPage(p as number)}
                        disabled={dataLoading}
                      >
                        {p}
                      </Button>
                    )
                  )}

                  <Button
                    variant="ghost" size="sm"
                    className="h-8 w-8 p-0 rounded-lg"
                    onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                    disabled={page === totalPages || dataLoading}
                  >
                    <Icon name="chevron_right" size={16} />
                  </Button>
                </div>
              </div>
            )}
          </div>
        </motion.div>
      )}
    </div>
  );
}
