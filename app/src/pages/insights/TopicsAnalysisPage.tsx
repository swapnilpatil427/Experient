// TopicsAnalysisPage — /app/insights/topics?survey=ID&topic=ID&window=all_time|30d|7d
//
// Three modes:
//   • No survey selected  → nudge to pick survey
//   • surveyId, no topic  → overview (hierarchy tree + scatter chart)
//   • surveyId + topicId  → deep-dive (TopicDetailPanel)

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useSetPageTitle } from '../../contexts/pageTitle';
import { useCrystalPanel } from '../../contexts/crystalPanel';
import { useApi } from '../../hooks/useApi';
import { useSurveys } from '../../hooks/useSurveys';
import { useTranslation } from '../../lib/i18n';
import { ROUTES } from '../../constants/routes';
import { PageHeader } from '../../components/PageHeader';
import { Icon } from '../../components/Icon';
import { Button } from '@/components/ui/button';
import { SurveyScopePicker } from '../../components/SurveyScopePicker';
import { GlassCard } from './shared';
import { TopicHierarchyTree, type ThemeGroup } from './components/TopicHierarchyTree';
import { TopicDetailPanel } from './components/TopicDetailPanel';
import { ImpactScatterChart } from './components/ImpactScatterChart';
import type { SurveyTopic, TopicDetail, TopicVerbatim, TopicTheme } from '../../types';

// ── Time window constants ──────────────────────────────────────────────────────

type TimeWindow = 'all_time' | '30d' | '7d';

// ── Animation variants ─────────────────────────────────────────────────────────

const fadeSlide = {
  initial: { opacity: 0, y: 16 },
  animate: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.45, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] },
  },
  exit: {
    opacity: 0,
    y: -10,
    transition: { duration: 0.25, ease: [0.4, 0, 1, 1] as [number, number, number, number] },
  },
} as const;

// ── TopicsAnalysisPage ─────────────────────────────────────────────────────────

export function TopicsAnalysisPage() {
  const { t } = useTranslation();
  const api = useApi();
  const [searchParams, setSearchParams] = useSearchParams();
  const { openCrystal, setCrystalCtx } = useCrystalPanel();
  const { surveys } = useSurveys();

  // ── URL-driven state ─────────────────────────────────────────────────────
  const surveyId = searchParams.get('survey') ?? '';
  const selectedTopicId = searchParams.get('topic') ?? '';
  const timeWindow = (searchParams.get('window') as TimeWindow) ?? 'all_time';

  // ── Page title ───────────────────────────────────────────────────────────
  // detailTopic holds the selected topic once loaded — used in breadcrumbs and panel
  useSetPageTitle(
    t('topicsAnalysis.pageTitle'),
    t('topicsAnalysis.pageSubtitle'),
  );

  // ── Hierarchy data ───────────────────────────────────────────────────────
  const [themes, setThemes] = useState<ThemeGroup[]>([]);
  const [hierarchyLoading, setHierarchyLoading] = useState(false);
  const [hierarchyError, setHierarchyError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);

  // All topics flattened (for scatter chart)
  const allTopics = useMemo<Array<SurveyTopic & { nps_correlation?: number | null; theme?: string | null }>>(
    () => themes.flatMap((th) => th.topics.map((tp) => ({ ...tp, theme: tp.theme ?? th.name }))),
    [themes],
  );

  const loadHierarchy = useCallback(async () => {
    if (!surveyId) { setThemes([]); return; }
    setHierarchyLoading(true);
    setHierarchyError(null);
    try {
      const data = await api.getTopicHierarchy(surveyId, timeWindow);
      setThemes((data.themes ?? []) as unknown as ThemeGroup[]);
    } catch {
      setHierarchyError(t('topicsAnalysis.errorLoadingTopics'));
      setThemes([]);
    } finally {
      setHierarchyLoading(false);
    }
  }, [api, surveyId, timeWindow, t]);

  useEffect(() => { loadHierarchy(); }, [loadHierarchy]);

  const handleGenerate = useCallback(async () => {
    if (!surveyId || generating) return;
    setGenerating(true);
    try {
      await api.triggerInsightGeneration(surveyId);
      // Poll once after a short delay, then reload hierarchy
      await new Promise((r) => setTimeout(r, 3000));
      await loadHierarchy();
    } catch {
      // ignore — user can retry
    } finally {
      setGenerating(false);
    }
  }, [api, surveyId, generating, loadHierarchy]);

  // ── Topic detail ─────────────────────────────────────────────────────────
  const [topicDetail, setTopicDetail] = useState<TopicDetail | null>(null);
  const [detailTopic, setDetailTopic] = useState<(SurveyTopic & { nps_correlation?: number | null; theme?: string | null }) | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const loadDetail = useCallback(async (topicId: string) => {
    if (!surveyId || !topicId) { setTopicDetail(null); setDetailTopic(null); return; }
    setDetailLoading(true);
    try {
      const data = await api.getTopicDetail(surveyId, topicId);
      setTopicDetail(data.detail ?? null);
      setDetailTopic(data.topic ?? null);
    } catch {
      setTopicDetail(null);
      setDetailTopic(null);
    } finally {
      setDetailLoading(false);
    }
  }, [api, surveyId]);

  useEffect(() => {
    if (selectedTopicId) {
      loadDetail(selectedTopicId);
      // Sync Crystal context to focused topic
      setCrystalCtx({ focused_topic: selectedTopicId });
    } else {
      setTopicDetail(null);
      setDetailTopic(null);
      setCrystalCtx({});
    }
  }, [selectedTopicId, loadDetail, setCrystalCtx]);

  // ── Verbatims ────────────────────────────────────────────────────────────
  const [verbatims, setVerbatims] = useState<TopicVerbatim[]>([]);
  const [verbatimsTotal, setVerbatimsTotal] = useState(0);
  const [verbatimsLoading, setVerbatimsLoading] = useState(false);
  const verbatimsOffset = useMemo(() => verbatims.length, [verbatims]);

  const loadVerbatims = useCallback(async (reset = false) => {
    if (!surveyId || !selectedTopicId) { setVerbatims([]); return; }
    setVerbatimsLoading(true);
    const offset = reset ? 0 : verbatimsOffset;
    try {
      const data = await api.getTopicVerbatims(surveyId, selectedTopicId, { offset, limit: 25, window: timeWindow });
      setVerbatims((prev) => (reset ? (data.verbatims ?? []) : [...prev, ...(data.verbatims ?? [])]));
      setVerbatimsTotal(data.total ?? 0);
    } catch {
      if (reset) setVerbatims([]);
    } finally {
      setVerbatimsLoading(false);
    }
  // verbatimsOffset intentionally omitted — it changes on every append which would cause a loop
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, surveyId, selectedTopicId, timeWindow]);

  useEffect(() => {
    if (selectedTopicId) {
      loadVerbatims(true);
    } else {
      setVerbatims([]);
      setVerbatimsTotal(0);
    }
  }, [selectedTopicId, surveyId, timeWindow, loadVerbatims]);

  // ── URL helpers ──────────────────────────────────────────────────────────
  const setSurvey = (id: string) => {
    const p: Record<string, string> = {};
    if (id) p.survey = id;
    if (timeWindow !== 'all_time') p.window = timeWindow;
    setSearchParams(p, { replace: true });
  };

  const setTopic = (topicId: string) => {
    const p: Record<string, string> = {};
    if (surveyId) p.survey = surveyId;
    if (topicId)  p.topic  = topicId;
    if (timeWindow !== 'all_time') p.window = timeWindow;
    setSearchParams(p, { replace: false });
  };

  const clearTopic = () => {
    const p: Record<string, string> = {};
    if (surveyId) p.survey = surveyId;
    if (timeWindow !== 'all_time') p.window = timeWindow;
    setSearchParams(p, { replace: false });
  };

  const setWindow = (w: TimeWindow) => {
    const p: Record<string, string> = {};
    if (surveyId)        p.survey = surveyId;
    if (selectedTopicId) p.topic  = selectedTopicId;
    if (w !== 'all_time') p.window = w;
    setSearchParams(p, { replace: true });
  };

  // ── Crystal ──────────────────────────────────────────────────────────────
  const handleAskCrystal = useCallback(
    (query: string, ctx: Record<string, string>) => {
      openCrystal(query, { focused_topic: ctx.focused_topic });
    },
    [openCrystal],
  );

  // ── Summary stats ────────────────────────────────────────────────────────
  const topicCount = useMemo(() => allTopics.length, [allTopics]);
  const themeCount = useMemo(() => themes.length, [themes]);
  const npsValues = useMemo(
    () => allTopics
      .map((tp) => tp.nps_correlation != null ? Math.round(tp.nps_correlation * 50) : tp.nps_avg)
      .filter((v): v is number => v != null),
    [allTopics],
  );
  const npsMin = npsValues.length ? Math.min(...npsValues) : null;
  const npsMax = npsValues.length ? Math.max(...npsValues) : null;

  // ── Breadcrumbs ──────────────────────────────────────────────────────────
  const crumbs = useMemo(() => {
    const base = [
      { label: t('topicsAnalysis.breadcrumbInsights'), path: ROUTES.INSIGHTS },
      { label: t('topicsAnalysis.breadcrumbTopics'),   path: ROUTES.INSIGHTS_TOPICS },
    ];
    if (selectedTopicId && detailTopic) {
      return [...base, { label: detailTopic.name }];
    }
    return base;
  }, [t, selectedTopicId, detailTopic]);

  // ── Time window pill group ────────────────────────────────────────────────
  const WINDOWS: { value: TimeWindow; label: string }[] = [
    { value: 'all_time', label: t('topicsAnalysis.windowAllTime') },
    { value: '30d',      label: t('topicsAnalysis.window30d') },
    { value: '7d',       label: t('topicsAnalysis.window7d') },
  ];

  const headerActions = (
    <div className="flex items-center gap-2 flex-wrap">
      {/* Survey scope picker */}
      <SurveyScopePicker
        surveys={surveys}
        scope={surveyId || 'all'}
        onChange={(s) => setSurvey(s === 'all' ? '' : s)}
      />

      {/* Time window pills */}
      <div
        className="flex items-center gap-1 p-1 rounded-full"
        style={{ background: 'rgba(0,0,0,0.06)' }}
      >
        {WINDOWS.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            onClick={() => setWindow(value)}
            className="px-3 py-1 rounded-full text-xs font-semibold transition-all duration-150"
            style={
              timeWindow === value
                ? {
                    background: 'var(--color-primary)',
                    color: '#fff',
                    boxShadow: '0 1px 6px color-mix(in srgb, var(--color-primary) 30%, transparent)',
                  }
                : { color: 'var(--color-on-surface-variant, #6b7280)' }
            }
          >
            {label}
          </button>
        ))}
      </div>

      {/* Ask Crystal button */}
      <Button
        variant="outline"
        size="sm"
        className="gap-2 border-primary/30 text-primary hover:bg-primary/5"
        onClick={() =>
          openCrystal(
            selectedTopicId
              ? `Tell me about the "${detailTopic?.name ?? selectedTopicId}" topic`
              : `What are the key themes in this survey?`,
            selectedTopicId ? { focused_topic: selectedTopicId } : {},
          )
        }
      >
        <Icon name="auto_awesome" size={14} />
        {t('topicsAnalysis.askCrystal')}
      </Button>
    </div>
  );

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="max-w-7xl mx-auto w-full">
      <PageHeader
        crumbs={crumbs}
        title={t('topicsAnalysis.pageTitle')}
        actions={headerActions}
      />

      <AnimatePresence mode="wait">
        {/* ═══════════════════════════════════════════════════════════
            MODE 1: No survey selected
        ════════════════════════════════════════════════════════════ */}
        {!surveyId && (
          <motion.div key="no-survey" {...fadeSlide}>
            <GlassCard className="p-12 text-center">
              <Icon
                name="hub"
                size={48}
                style={{ color: 'var(--color-primary)', display: 'block', margin: '0 auto 16px' }}
              />
              <h3 className="text-lg font-bold text-on-surface mb-2">
                {t('topicsAnalysis.selectSurveyTitle')}
              </h3>
              <p className="text-sm text-muted-foreground max-w-md mx-auto">
                {t('topicsAnalysis.selectSurveyDesc')}
              </p>
            </GlassCard>
          </motion.div>
        )}

        {/* ═══════════════════════════════════════════════════════════
            MODE 2: Overview — all topics in hierarchy
        ════════════════════════════════════════════════════════════ */}
        {surveyId && !selectedTopicId && (
          <motion.div key="overview" {...fadeSlide} className="space-y-6 pb-12">
            {/* Summary stats bar */}
            {!hierarchyLoading && !hierarchyError && topicCount > 0 && (
              <div className="flex items-center gap-3 flex-wrap text-xs text-muted-foreground">
                <span className="font-semibold text-on-surface">
                  {t('topicsAnalysis.topicsDiscovered', { count: topicCount })}
                </span>
                <span className="opacity-40">·</span>
                <span>{t('topicsAnalysis.themesCount', { count: themeCount })}</span>
                {npsMin != null && npsMax != null && (
                  <>
                    <span className="opacity-40">·</span>
                    <span>
                      {t('topicsAnalysis.npsImpactRange', {
                        min: npsMin > 0 ? `+${npsMin}` : npsMin,
                        max: npsMax > 0 ? `+${npsMax}` : npsMax,
                      })}
                    </span>
                  </>
                )}
              </div>
            )}

            {/* Hierarchy load error */}
            {hierarchyError && !hierarchyLoading && (
              <div className="flex items-center gap-3 px-4 py-3 rounded-xl border"
                style={{ background: 'rgba(220,38,38,0.05)', borderColor: 'rgba(220,38,38,0.2)' }}>
                <Icon name="error_outline" size={16} style={{ color: '#dc2626', flexShrink: 0 }} />
                <p className="text-sm flex-1" style={{ color: '#dc2626' }}>{hierarchyError}</p>
                <Button variant="ghost" size="sm" onClick={loadHierarchy} className="gap-1 text-xs">
                  <Icon name="refresh" size={13} />
                  {t('topicsAnalysis.retryDetail')}
                </Button>
              </div>
            )}

            {/* Topic hierarchy tree */}
            <TopicHierarchyTree
              themes={themes}
              selectedTopicId={selectedTopicId}
              onSelectTopic={setTopic}
              onAskCrystal={handleAskCrystal}
              loading={hierarchyLoading}
              onGenerate={handleGenerate}
              generating={generating}
            />

            {/* Impact scatter chart — only if 3+ topics with NPS data */}
            {!hierarchyLoading && allTopics.length >= 3 && (
              <ImpactScatterChart
                topics={allTopics}
                onSelectTopic={setTopic}
              />
            )}
          </motion.div>
        )}

        {/* ═══════════════════════════════════════════════════════════
            MODE 3: Deep-dive — single topic
        ════════════════════════════════════════════════════════════ */}
        {surveyId && selectedTopicId && (
          <motion.div key={`deep-${selectedTopicId}`} {...fadeSlide} className="pb-12">
            {detailLoading && !detailTopic ? (
              // Loading skeleton
              <div className="space-y-4">
                {[1, 2, 3].map((i) => (
                  <div
                    key={i}
                    className="rounded-2xl animate-pulse"
                    style={{
                      height: i === 1 ? 160 : 240,
                      background: 'rgba(0,0,0,0.04)',
                      border: '1px solid rgba(255,255,255,0.6)',
                    }}
                  />
                ))}
              </div>
            ) : detailTopic ? (
              <TopicDetailPanel
                topic={detailTopic}
                detail={topicDetail}
                verbatims={verbatims}
                verbatimsTotal={verbatimsTotal}
                verbatimsLoading={verbatimsLoading}
                onLoadMore={() => loadVerbatims(false)}
                onAskCrystal={handleAskCrystal}
                onBack={clearTopic}
                surveyId={surveyId}
              />
            ) : (
              // Error / not found state
              <GlassCard className="p-12 text-center">
                <Icon
                  name="error_outline"
                  size={40}
                  style={{ color: '#dc2626', display: 'block', margin: '0 auto 12px' }}
                />
                <p className="text-sm text-muted-foreground mb-4">
                  {t('topicsAnalysis.errorLoadingDetail')}
                </p>
                <div className="flex items-center justify-center gap-2">
                  <Button
                    size="sm"
                    onClick={() => loadDetail(selectedTopicId)}
                    className="gap-1.5"
                  >
                    <Icon name="refresh" size={14} />
                    {t('topicsAnalysis.retryDetail')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={clearTopic}
                    className="gap-1.5"
                  >
                    <Icon name="arrow_back" size={14} />
                    {t('topicsAnalysis.backToTopics')}
                  </Button>
                </div>
              </GlassCard>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
