// UnifiedInsightsView — "Crystal Command" — the single unified Insights experience.
//
// Architecture: dark cinematic hero (crystal + ask) → editorial brief →
// metrics → deeper findings bento → live crystal conversation → auto-surfaced.
// Scroll is the journey; the crystal is the constant thread.
//
// Engineering alignment vs docs/insights/ARCHITECTURE.md:
//   • Crystal: CSS-only (client-side), no Three.js weight on this page
//   • Brief: representative data until /api/insights/aggregate ships (v1.1)
//   • Conversation: static demo Q&A — wires to /api/insights/ask (NLQ endpoint)
//   • Contributing surveys strip: meta.cross_survey category (backend v1.1)
//   • All citations use the [rXXX] format from INSIGHT_TAXONOMY.md

import { useState, useCallback, useMemo, type ReactNode } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Link, useNavigate } from 'react-router-dom';
import { Icon } from '../../components/Icon';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import type { Insight, Survey, AgenticInsight } from '../../types';
import type { SurveyScope } from '../../components/SurveyScopePicker';
import { useCrystalPanel } from '../../contexts/crystalPanel';
import { ROUTES, toPath } from '../../constants/routes';
import { useTranslation } from '../../lib/i18n';
import { useApi } from '../../hooks/useApi';
import { getFeatureFlags } from '../../lib/features';
import { EnhancedHeaderBand } from '../../components/insights/EnhancedHeaderBand';
import { InvestigationDrawer } from '../../components/insights/InvestigationDrawer';
import { TopicChangeBar } from '../../components/insights/TopicChangeBar';
import { ManualRunDialog } from '../../components/insights/ManualRunDialog';
import type { ManualRunMode } from '../../types';
import type { LatestCheckpoint, RecentCheckpointPoint } from '../../types';
import {
  GlassCard,
  CitationChip,
  ConfidenceChip,
  CIBar,
  LayerBadge,
  LiveDot,
  LAYER_CONFIG,
  SENTIMENT_BORDER,
} from './shared';
import { GeneratingOverlay } from './GeneratingOverlay';

// Pipeline nodes — must match InsightsDashboardPage.INSIGHT_NODES order
const PIPELINE_NODES = [
  { id: 'ingest',   label: 'Loading Responses',  icon: 'download'            },
  { id: 'embed',    label: 'Building Embeddings', icon: 'memory'              },
  { id: 'metrics',  label: 'Computing Metrics',   icon: 'analytics'           },
  { id: 'absa',     label: 'Sentiment Analysis',  icon: 'sentiment_satisfied' },
  { id: 'cluster',  label: 'Clustering Topics',   icon: 'hub'                 },
  { id: 'topics',   label: 'Discovering Topics',  icon: 'topic'               },
  { id: 'narrate',  label: 'Narrating Insights',  icon: 'edit_note'           },
  { id: 'verify',   label: 'Verifying Claims',    icon: 'fact_check'          },
  { id: 'evaluate', label: 'Evaluating Quality',  icon: 'verified'            },
  { id: 'publish',  label: 'Publishing Results',  icon: 'publish'             },
] as const;

// ── Animation variants ────────────────────────────────────────────────────
const stagger = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.07 } },
};
const rise = {
  hidden: { opacity: 0, y: 18 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.65, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] },
  },
};

// ── Types ─────────────────────────────────────────────────────────────────
interface ViewProps {
  insights: Insight | null;
  scope: SurveyScope;
  surveys: Survey[];
  agenticInsights?: AgenticInsight[];
  agenticLoading?: boolean;
  generating?: boolean;
  nodesDone?: string[];
  genError?: string | null;
  onGenerate?: () => void;
  focusSurvey?: Survey;
  orgAvgNps?: number | null;
  // ── Phase 0.5 — investigation trajectory (Enhanced Header Band) ───────────
  latestCheckpoint?: LatestCheckpoint | null;
  priorCheckpoints?: RecentCheckpointPoint[];
  runStatus?: string | null;
  /** Band Generate dropdown — distinguishes 'manual' (refresh) vs 'regenerate'. */
  onGenerateTrigger?: (trigger: 'manual' | 'regenerate') => void;
  onRefresh?: () => void;
}

// ─────────────────────────────────────────────────────────────────────────────
export function UnifiedInsightsView({
  insights,
  scope,
  surveys,
  agenticInsights = [],
  agenticLoading = false,
  generating = false,
  nodesDone = [],
  genError,
  onGenerate,
  focusSurvey,
  orgAvgNps,
  latestCheckpoint = null,
  priorCheckpoints = [],
  runStatus = null,
  onGenerateTrigger,
  onRefresh,
}: ViewProps) {
  const { t } = useTranslation();
  const api = useApi();
  const navigate = useNavigate();
  const isAll = scope === 'all';
  const { openCrystal } = useCrystalPanel();
  const [askQuery, setAskQuery] = useState('');
  // ── Phase 0.5 — Enhanced Header Band + Investigation Drawer ───────────────
  const trajectoryEnabled = getFeatureFlags().insightsTrajectoryV1;
  const [drawerOpen, setDrawerOpen] = useState(false);
  // ── Phase 3/4 — Manual Run dialog + Trail navigation ──────────────────────
  const trailEnabled = getFeatureFlags().insightsTrajectoryV1; // Trail UI ships with trajectory
  const [manualRunOpen, setManualRunOpen] = useState(false);
  const [manualRunMode, setManualRunMode] = useState<ManualRunMode>('expert');
  const focusSurveyId = focusSurvey?.id;
  const goToTrail = useCallback(() => {
    if (focusSurveyId) navigate(toPath(ROUTES.INSIGHT_TRAIL, { surveyId: focusSurveyId }));
  }, [navigate, focusSurveyId]);
  // Phase 5/6 — Generate ▾ menu deep links to the Custom Analysis wizard and the
  // Intelligence settings page (single-survey scope only).
  const goToCustomAnalysis = useCallback(() => {
    if (focusSurveyId) navigate(toPath(ROUTES.CUSTOM_ANALYSIS, { surveyId: focusSurveyId }));
  }, [navigate, focusSurveyId]);
  const goToSettings = useCallback(() => {
    if (focusSurveyId) navigate(toPath(ROUTES.INSIGHT_SETTINGS, { surveyId: focusSurveyId }));
  }, [navigate, focusSurveyId]);
  // The band replaces the legacy header only for a single survey with a
  // checkpoint present (graceful fallback otherwise — see 06_UX_DESIGN §15.0).
  const showBand = trajectoryEnabled && !isAll && latestCheckpoint != null;
  const isGenerating = runStatus === 'running';
  const showTopicBar =
    showBand &&
    !isGenerating &&
    (latestCheckpoint?.delta?.topic_changes?.emerged?.length ?? 0) +
      (latestCheckpoint?.delta?.topic_changes?.resolved?.length ?? 0) > 0;
  const [filterLayer,    setFilterLayer]    = useState<AgenticInsight['layer'] | 'all'>('all');
  const [filterCategory, setFilterCategory] = useState<string>('all');
  // Audit drawer state — P10-04
  const [auditInsight, setAuditInsight] = useState<AgenticInsight | null>(null);
  const [insightFeedback, setInsightFeedback] = useState<Record<string, { thumbs?: 'up' | 'down' | null; pinned?: boolean }>>(() =>
    Object.fromEntries(agenticInsights.map((i) => [i.id, i.user_state_json ?? {}]))
  );
  const handleThumb = useCallback(async (insightId: string, thumbs: 'up' | 'down') => {
    setInsightFeedback((prev) => {
      const current = prev[insightId] ?? {};
      return { ...prev, [insightId]: { ...current, thumbs: current.thumbs === thumbs ? null : thumbs } };
    });
    const next = insightFeedback[insightId]?.thumbs === thumbs ? null : thumbs;
    try { await api.updateInsightFeedback(insightId, { thumbs: next }); } catch { /* optimistic — no rollback */ }
  }, [api, insightFeedback]);

  const handlePin = useCallback(async (insightId: string) => {
    setInsightFeedback((prev) => {
      const current = prev[insightId] ?? {};
      return { ...prev, [insightId]: { ...current, pinned: !current.pinned } };
    });
    const next = !insightFeedback[insightId]?.pinned;
    try { await api.updateInsightFeedback(insightId, { pinned: next }); } catch { /* optimistic — no rollback */ }
  }, [api, insightFeedback]);

  const availableLayers = useMemo(() => {
    const present = new Set(agenticInsights.map((i) => i.layer));
    return (['descriptive', 'diagnostic', 'predictive', 'prescriptive'] as const).filter((l) => present.has(l));
  }, [agenticInsights]);

  const availableCategories = useMemo(() => {
    const cats = [...new Set(agenticInsights.map((i) => i.category).filter(Boolean))];
    return cats.sort();
  }, [agenticInsights]);

  const filteredInsights = useMemo(() => {
    return agenticInsights.filter((ins) => {
      if (filterLayer    !== 'all' && ins.layer    !== filterLayer)    return false;
      if (filterCategory !== 'all' && ins.category !== filterCategory) return false;
      return true;
    });
  }, [agenticInsights, filterLayer, filterCategory]);

  // P11-07: Hero card — first NPS descriptive insight
  const heroInsight = agenticInsights.find(
    (ins) => ins.layer === 'descriptive' && ins.category === 'metric.nps',
  );


  const nps = insights?.nps_score ?? null;
  const activeSurveys = surveys.filter((s) => s.status === 'active' && !s.deleted_at);
  const activeCount = activeSurveys.length;
  const totalResponses = surveys.reduce((sum, s) => sum + (s.response_count ?? 0), 0);
  const leadSurvey = activeSurveys[0];
  const displayNps = isAll ? (orgAvgNps != null ? Math.round(orgAvgNps) : null) : nps;

  const responseCount = focusSurvey?.response_count ?? 0;

  // Empty-state kind — drives the UX treatment below
  type EmptyKind = 'no_responses' | 'insufficient' | 'low_confidence' | 'ready' | 'failed';
  const emptyKind: EmptyKind = !isAll && !generating && !agenticLoading && agenticInsights.length === 0
    ? genError
      ? 'failed'
      : responseCount === 0
        ? 'no_responses'
        : responseCount < 5
          ? 'insufficient'
          : responseCount < 30
            ? 'low_confidence'
            : 'ready'
    : 'ready'; // sentinel — not shown when this doesn't apply

  const showEmptyState = !isAll && !generating && !agenticLoading && agenticInsights.length === 0;
  const hasAgenticData = agenticInsights.length > 0;

  return (
    <div className="space-y-6">

      {/* ════════════════════════════════════════════════════════════════════
          PHASE 0.5 — Enhanced Header Band (replaces the legacy NPS strip when
          insightsTrajectoryV1 is on and a checkpoint exists). Graceful fallback:
          when off / no checkpoint, nothing renders here and the existing header
          and cards remain unchanged.
      ════════════════════════════════════════════════════════════════════ */}
      {showBand && latestCheckpoint && (
        <EnhancedHeaderBand
          checkpoint={latestCheckpoint}
          delta={latestCheckpoint.delta}
          runStatus={runStatus}
          newResponseCount={latestCheckpoint.new_responses ?? 0}
          showTrail={trailEnabled && !!focusSurveyId}
          onViewTrail={goToTrail}
          onOpenDrawer={() => setDrawerOpen(true)}
          onOpenManualRun={focusSurveyId ? () => { setManualRunMode('expert'); setManualRunOpen(true); } : undefined}
          onOpenCustomAnalysis={focusSurveyId ? goToCustomAnalysis : undefined}
          onOpenSettings={focusSurveyId ? goToSettings : undefined}
          onGenerate={(trigger) => (onGenerateTrigger ? onGenerateTrigger(trigger) : onGenerate?.())}
          onRefresh={
            focusSurveyId
              ? () => { setManualRunMode('refresh'); setManualRunOpen(true); }
              : (onRefresh ?? onGenerate)
          }
        />
      )}

      {/* Manual Run dialog (Phase 3) — opened from the band's Generate ▾ / Refresh */}
      {focusSurveyId && (
        <ManualRunDialog
          open={manualRunOpen}
          onClose={() => setManualRunOpen(false)}
          surveyId={focusSurveyId}
          initialMode={manualRunMode}
          onViewReport={(reportId) => {
            if (reportId) {
              navigate(toPath(ROUTES.INSIGHT_REPORT, { surveyId: focusSurveyId, reportId }));
            } else {
              goToTrail();
            }
          }}
          onViewTrail={goToTrail}
        />
      )}

      {/* Investigation Drawer — mounted whenever trajectory is on for a single
          survey; tolerates a null checkpoint (loading skeleton). */}
      {trajectoryEnabled && !isAll && (
        <InvestigationDrawer
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          checkpoint={isGenerating ? null : latestCheckpoint}
          delta={latestCheckpoint?.delta ?? null}
          priorCheckpoints={priorCheckpoints}
          showTrail={false}
          showFeatureBadge={import.meta.env.DEV}
        />
      )}

      {/* P11-09: Sample data banner — shown only when scope === 'all' */}
      {isAll && (
        <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-amber-200 bg-amber-50 text-xs font-bold text-amber-800 sticky top-0 z-20">
          <Icon name="science" size={14} />
          {t('surveyInsights.sampleDataBanner')}
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════════════
          GENERATING OVERLAY — light-theme pipeline progress
      ════════════════════════════════════════════════════════════════════ */}
      <GeneratingOverlay
        generating={generating}
        nodesDone={nodesDone}
        genError={!hasAgenticData ? genError : null}
        nodes={PIPELINE_NODES}
        focusSurvey={focusSurvey}
        onRetry={onGenerate}
      />

      {/* P10-04: Audit drawer — opens when user clicks trust score badge */}
      <Sheet open={!!auditInsight} onOpenChange={(open) => { if (!open) setAuditInsight(null); }}>
        <SheetContent side="right" className="w-full max-w-sm overflow-y-auto">
          {auditInsight && (
            <>
              <SheetHeader>
                <SheetTitle className="text-sm font-black">Insight Audit Trail</SheetTitle>
              </SheetHeader>
              <div className="mt-6 space-y-4 text-xs">
                {/* Model */}
                <div className="p-3 rounded-xl bg-muted/40 border border-outline-variant/20">
                  <p className="font-bold uppercase tracking-wide text-on-surface-variant mb-1">Model</p>
                  <p className="font-mono text-on-surface break-all">{auditInsight.audit_json?.model ?? '—'}</p>
                </div>
                {/* Verifier notes */}
                <div className="p-3 rounded-xl bg-muted/40 border border-outline-variant/20">
                  <p className="font-bold uppercase tracking-wide text-on-surface-variant mb-1">Verifier Notes</p>
                  <p className="text-on-surface leading-relaxed">
                    {auditInsight.audit_json?.verifier_notes
                      ? `${auditInsight.audit_json.verifier_pass ? '✓ Passed' : '✗ Failed'} — ${auditInsight.audit_json.verifier_notes}`
                      : '—'}
                  </p>
                </div>
                {/* Trust metrics */}
                {auditInsight.trust_json && (
                  <div className="p-3 rounded-xl bg-muted/40 border border-outline-variant/20 space-y-2">
                    <p className="font-bold uppercase tracking-wide text-on-surface-variant mb-1">Trust Metrics</p>
                    {([
                      { label: 'Coverage',     value: auditInsight.trust_json.coverage,     suffix: '%' },
                      { label: 'Consistency',  value: auditInsight.trust_json.consistency,  suffix: '%' },
                      { label: 'Statistical',  value: auditInsight.trust_json.statistical,  suffix: '' },
                      { label: 'Grounding',    value: auditInsight.trust_json.grounding,    suffix: '' },
                      { label: 'Sample Size',  value: auditInsight.trust_json.sample_size,  suffix: '' },
                    ] as const).map(({ label, value, suffix }) => (
                      <div key={label} className="flex justify-between items-center">
                        <span className="text-on-surface-variant">{label}</span>
                        <span className="font-black text-on-surface">
                          {value != null ? `${value}${suffix}` : '—'}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                {/* Prompt hash */}
                {auditInsight.audit_json?.prompt_hash && (
                  <div className="p-3 rounded-xl bg-muted/40 border border-outline-variant/20">
                    <p className="font-bold uppercase tracking-wide text-on-surface-variant mb-1">Prompt Hash</p>
                    <p className="font-mono text-[10px] text-on-surface break-all">{auditInsight.audit_json.prompt_hash}</p>
                  </div>
                )}
                {/* Overall trust score */}
                <div className="p-3 rounded-xl border-2 text-center"
                  style={{
                    borderColor: auditInsight.trust_score >= 80 ? '#059669' : auditInsight.trust_score >= 60 ? '#d97706' : '#94a3b8',
                    background: auditInsight.trust_score >= 80 ? '#ecfdf5' : auditInsight.trust_score >= 60 ? '#fffbeb' : '#f8fafc',
                  }}>
                  <p className="font-bold uppercase tracking-wide text-on-surface-variant mb-1">Trust Score</p>
                  <p className="text-3xl font-black font-headline" style={{
                    color: auditInsight.trust_score >= 80 ? '#059669' : auditInsight.trust_score >= 60 ? '#d97706' : '#94a3b8',
                  }}>
                    {auditInsight.trust_score}
                    <span className="text-sm font-bold opacity-60">/100</span>
                  </p>
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      {/* ════════════════════════════════════════════════════════════════════
          AGENTIC INSIGHTS SECTION — real pipeline results (light theme)
          Shown only when scope is a single survey and insights exist.
      ════════════════════════════════════════════════════════════════════ */}
      {!isAll && hasAgenticData && !generating && (
        <div className="space-y-6">
          {/* Compact Crystal ask bar — light theme, no bleed */}
          <GlassCard className="p-4">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (askQuery.trim()) { openCrystal(askQuery.trim()); setAskQuery(''); }
              }}
              className="flex items-center gap-3"
            >
              <Icon name="psychology" size={20} style={{ color: 'var(--color-primary)', flexShrink: 0 }} />
              <input
                type="text"
                value={askQuery}
                onChange={(e) => setAskQuery(e.target.value)}
                placeholder='"Why did NPS dip on May 10?" — ask Crystal anything about this survey'
                className="flex-1 px-2 py-1.5 bg-transparent focus:outline-none text-sm placeholder:text-on-surface-variant/50"
              />
              <Button
                type="submit"
                size="sm"
                className="text-xs font-bold text-white border-0 flex-shrink-0"
                style={{ background: 'linear-gradient(135deg, #2a4bd9, #8329c8)' }}
              >
                <Icon name="arrow_upward" size={14} />
                Ask Crystal
              </Button>
            </form>
          </GlassCard>

          {/* P11-07: Hero narrative card — first NPS descriptive insight */}
          {heroInsight && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
            >
              <GlassCard
                className="p-6 overflow-hidden relative"
                style={{
                  background: 'linear-gradient(135deg, rgba(42,75,217,0.06) 0%, rgba(131,41,200,0.04) 100%)',
                  borderColor: 'rgba(42,75,217,0.2)',
                }}
              >
                {/* Featured label */}
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-[10px] font-black uppercase tracking-[0.2em] text-primary">
                    Featured Insight
                  </span>
                  <span
                    className="px-2 py-0.5 rounded-md text-[10px] font-bold"
                    style={{ background: '#e0f2fe', color: '#0369a1' }}
                  >
                    NPS
                  </span>
                  {heroInsight.trust_score >= 80 && (
                    <span className="text-[10px] font-bold text-emerald-700">● Reliable</span>
                  )}
                </div>
                <h2 className="text-lg font-black font-headline leading-snug mb-2 text-on-surface">
                  {heroInsight.headline}
                </h2>
                {heroInsight.narrative && !/^[^:]{1,60}:\s/.test(heroInsight.narrative) && (
                  <p className="text-sm text-on-surface-variant leading-relaxed mb-4 max-w-2xl">
                    {heroInsight.narrative.length > 280
                      ? heroInsight.narrative.slice(0, 280) + '…'
                      : heroInsight.narrative}
                  </p>
                )}
                {heroInsight.metric_json?.value != null && (
                  <div className="flex items-center gap-4 mb-2">
                    <div>
                      <p className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">NPS Score</p>
                      <p className="text-4xl font-black font-headline" style={{
                        color: heroInsight.metric_json.value >= 50 ? '#059669'
                          : heroInsight.metric_json.value >= 0 ? '#d97706'
                          : '#b41340',
                      }}>
                        {Math.round(heroInsight.metric_json.value)}
                      </p>
                    </div>
                  </div>
                )}
                {/* Decorative gradient orb */}
                <div
                  className="absolute -right-8 -top-8 w-32 h-32 rounded-full pointer-events-none"
                  style={{ background: 'radial-gradient(circle, rgba(42,75,217,0.12), transparent 70%)' }}
                />
              </GlassCard>
            </motion.div>
          )}

          {/* ── Insight filters ───────────────────────────────────────────── */}
          {(availableLayers.length > 1 || availableCategories.length > 1) && (
            <div className="space-y-2 px-1">
              {availableLayers.length > 1 && (
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[10px] font-black uppercase tracking-widest text-on-surface-variant w-12 shrink-0">
                    {t('surveyInsights.filters.layerLabel')}
                  </span>
                  <div className="flex gap-1.5 flex-wrap">
                    <FilterPill
                      active={filterLayer === 'all'}
                      onClick={() => setFilterLayer('all')}
                    >
                      {t('surveyInsights.filters.all')} ({agenticInsights.length})
                    </FilterPill>
                    {availableLayers.map((layer) => {
                      const cfg   = LAYER_CONFIG[layer];
                      const count = agenticInsights.filter((i) => i.layer === layer).length;
                      return (
                        <FilterPill
                          key={layer}
                          active={filterLayer === layer}
                          activeColor={cfg.color}
                          activeBg={cfg.bg}
                          onClick={() => setFilterLayer(filterLayer === layer ? 'all' : layer)}
                        >
                          {t(`surveyInsights.layers.${layer}.label`)} ({count})
                        </FilterPill>
                      );
                    })}
                  </div>
                </div>
              )}

              {availableCategories.length > 1 && (
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[10px] font-black uppercase tracking-widest text-on-surface-variant w-12 shrink-0">
                    {t('surveyInsights.filters.typeLabel')}
                  </span>
                  <div className="flex gap-1.5 flex-wrap">
                    <FilterPill
                      active={filterCategory === 'all'}
                      onClick={() => setFilterCategory('all')}
                    >
                      {t('surveyInsights.filters.all')}
                    </FilterPill>
                    {availableCategories.map((cat) => {
                      const count = agenticInsights.filter((i) => i.category === cat).length;
                      return (
                        <FilterPill
                          key={cat}
                          active={filterCategory === cat}
                          onClick={() => setFilterCategory(filterCategory === cat ? 'all' : cat)}
                        >
                          {prettifyCategory(cat)} ({count})
                        </FilterPill>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          <motion.section
            variants={stagger}
            initial="hidden"
            animate="visible"
            className="space-y-4"
          >
            <SectionLabel
              icon="auto_awesome"
              label={
                filterLayer !== 'all' || filterCategory !== 'all'
                  ? `${filteredInsights.length} of ${agenticInsights.length} AI insights`
                  : `${agenticInsights.length} AI insights generated`
              }
            />

            {filteredInsights.length === 0 ? (
              <div className="py-12 text-center">
                <p className="text-sm text-on-surface-variant mb-3">
                  {t('surveyInsights.filters.noResults')}
                </p>
                <button
                  onClick={() => { setFilterLayer('all'); setFilterCategory('all'); }}
                  className="text-xs font-bold text-primary hover:underline"
                >
                  {t('surveyInsights.filters.clearFilters')}
                </button>
              </div>
            ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {filteredInsights.map((insight, i) => {
              const layerCfg = LAYER_CONFIG[insight.layer] ?? LAYER_CONFIG.descriptive;
              const layerKey = insight.layer ?? 'descriptive';
              return (
                <motion.div
                  key={insight.id}
                  variants={rise}
                  custom={i}
                  className="card-tilt"
                >
                  <GlassCard className="p-5 h-full flex flex-col gap-0 overflow-hidden">
                    {/* Top accent bar — layer colour identity at a glance */}
                    <div
                      className="rounded-t-2xl mb-4 -mx-5 -mt-5 h-0.5"
                      style={{ background: layerCfg.color, opacity: 0.5 }}
                    />

                    {/* Row 1: layer badge + sentiment + confidence */}
                    <TooltipProvider delayDuration={200}>
                    <div className="flex items-center gap-2 mb-2">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span
                            className="px-2 py-0.5 rounded-md text-[10px] font-bold tracking-wide cursor-default"
                            style={{ background: layerCfg.bg, color: layerCfg.color }}
                          >
                            {t(`surveyInsights.layers.${layerKey}.label`)}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-[200px] text-xs">
                          {t(`surveyInsights.layers.${layerKey}.tooltip`)}
                        </TooltipContent>
                      </Tooltip>
                      {insight.metric_json?.dominant_sentiment && (
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold tracking-wide ${
                          insight.metric_json.dominant_sentiment === 'positive'
                            ? 'bg-emerald-50 text-emerald-700'
                            : insight.metric_json.dominant_sentiment === 'negative'
                              ? 'bg-red-50 text-red-700'
                              : 'bg-muted text-on-surface-variant'
                        }`}>
                          <span className="w-1.5 h-1.5 rounded-full" style={{
                            background: insight.metric_json.dominant_sentiment === 'positive' ? '#059669'
                              : insight.metric_json.dominant_sentiment === 'negative' ? '#dc2626' : '#94a3b8'
                          }} />
                          {insight.metric_json.dominant_sentiment}
                        </span>
                      )}
                      <div className="flex-1" />
                      <Tooltip>
                        <TooltipTrigger asChild>
                          {/* P10-04: Click trust score to open audit drawer */}
                          <button
                            className={`text-[10px] font-bold cursor-pointer hover:underline ${
                              insight.trust_score >= 80 ? 'text-emerald-700'
                              : insight.trust_score >= 60 ? 'text-amber-700'
                              : 'text-on-surface-variant'
                            }`}
                            onClick={() => setAuditInsight(insight)}
                            title="View audit details"
                          >
                            {insight.trust_score >= 80 ? '● Reliable finding'
                              : insight.trust_score >= 60 ? '◑ Indicative finding'
                              : '○ Low-signal'}
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-[180px] text-xs">
                          {insight.trust_score >= 80
                            ? `Based on strong evidence (${insight.trust_score}/100). Click to view audit.`
                            : insight.trust_score >= 60
                            ? `Directional signal (${insight.trust_score}/100). Click to view audit.`
                            : `Low sample or mixed responses (${insight.trust_score}/100). Click to view audit.`}
                        </TooltipContent>
                      </Tooltip>
                    </div>
                    </TooltipProvider>

                    {/* Headline */}
                    <h3 className="text-sm font-black font-headline leading-snug mb-2">
                      {insight.headline}
                    </h3>

                    {/* Narrative — suppress raw "TopicName: phrase, phrase" dumps */}
                    {(() => {
                      const raw = insight.narrative ?? '';
                      const isRawDump = /^[^:]{1,60}:\s/.test(raw) && raw.split(' ').length < 14;
                      return !isRawDump && raw.length > 0 ? (
                        <p className="text-xs text-on-surface-variant leading-relaxed flex-1 mb-3">
                          {raw.length > 200 ? raw.slice(0, 200) + '…' : raw}
                        </p>
                      ) : <div className="flex-1" />;
                    })()}

                    {/* Respondent quotes — 2 actual quotes, not opaque bookmark icons.
                        Click-through to the Response Detail page (R-T5 audit trail) —
                        survey_id comes from this page's own scope (focusSurveyId),
                        since UnifiedInsightsView is always survey-scoped already. */}
                    {insight.citations_json.length > 0 && (
                      <div className="space-y-1.5 mb-3">
                        {insight.citations_json.slice(0, 2).map((c) => {
                          const clickable = Boolean(focusSurveyId && c.response_id);
                          return (
                            <div
                              key={c.response_id}
                              role={clickable ? 'button' : undefined}
                              tabIndex={clickable ? 0 : undefined}
                              onClick={clickable ? () => navigate(toPath(ROUTES.RESPONSE_DETAIL, { surveyId: focusSurveyId!, responseId: c.response_id })) : undefined}
                              className={`px-3 py-2 rounded-lg bg-muted/60 ${clickable ? 'cursor-pointer hover:bg-muted transition-colors' : ''}`}
                              style={{ borderLeft: `3px solid ${SENTIMENT_BORDER[c.sentiment] ?? 'var(--color-outline-variant, #ccc)'}` }}
                            >
                              <p className="text-xs leading-relaxed text-on-surface line-clamp-2">
                                "{c.quote}"
                              </p>
                            </div>
                          );
                        })}
                        {insight.citations_json.length > 2 && (
                          <span className="text-[10px] font-bold text-primary px-1">
                            +{insight.citations_json.length - 2} more quotes
                          </span>
                        )}
                      </div>
                    )}

                    {/* Recommended action — prominent when present */}
                    {insight.recommended_action && (
                      <div className="flex items-start gap-2 p-2.5 rounded-lg bg-primary/5 border border-primary/15 mb-3">
                        <Icon name="bolt" size={14} style={{ color: 'var(--color-primary)', flexShrink: 0, marginTop: 1 }} />
                        <div>
                          <p className="text-xs font-semibold text-on-surface leading-snug">
                            {insight.recommended_action.label}
                          </p>
                          {insight.recommended_action.target && (
                            <p className="text-[10px] text-on-surface-variant mt-0.5">
                              {insight.recommended_action.target}
                            </p>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Action bar */}
                    {(() => {
                      const fb = insightFeedback[insight.id] ?? {};
                      return (
                        <div className="flex items-center gap-1 pt-2.5 border-t border-outline-variant/20">
                          <Button
                            size="sm"
                            variant="ghost"
                            className={`text-xs gap-1 px-2 h-7 ${fb.thumbs === 'up' ? 'text-emerald-600' : ''}`}
                            onClick={() => handleThumb(insight.id, 'up')}
                          >
                            <Icon name="thumb_up" size={13}
                              style={fb.thumbs === 'up' ? { color: '#059669' } : undefined} />
                            Helpful
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className={`text-xs gap-1 px-2 h-7 ${fb.pinned ? 'text-primary' : ''}`}
                            onClick={() => handlePin(insight.id)}
                          >
                            <Icon name="push_pin" size={13}
                              style={fb.pinned ? { color: 'var(--color-primary)' } : undefined} />
                            {fb.pinned ? 'Pinned' : 'Pin'}
                          </Button>
                          {/* Ask Crystal about this specific insight */}
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-xs gap-1 px-2 h-7 text-primary hover:bg-primary/8"
                            onClick={() => openCrystal(insight.headline)}
                            title="Ask Crystal to explain or expand on this insight"
                          >
                            <Icon name="psychology" size={13} style={{ color: 'var(--color-primary)' }} />
                            Ask Crystal
                          </Button>
                          <div className="flex-1" />
                          <span className="text-[10px] text-on-surface-variant/60">
                            {prettifyCategory(insight.category)}
                          </span>
                        </div>
                      );
                    })()}
                  </GlassCard>
                </motion.div>
              );
              })}
            </div>
            )}
          </motion.section>

          {/* Phase 0.5 — Topic Change Bar (below insight cards). Hidden during
              generation; only shown when there are named topic changes. */}
          <AnimatePresence mode="wait">
            {showTopicBar && latestCheckpoint?.delta && (
              <TopicChangeBar
                key="topic-change-bar"
                delta={latestCheckpoint.delta}
                prevCheckpoint={latestCheckpoint.number - 1}
                createdAt={latestCheckpoint.created_at}
              />
            )}
          </AnimatePresence>
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════════════
          EMPTY STATE — single survey selected, no insights yet (light theme)
          State-aware: no_responses / insufficient / low_confidence / ready / failed
      ════════════════════════════════════════════════════════════════════ */}
      <AnimatePresence mode="wait">
        {showEmptyState && (
          <motion.div
            key={emptyKind}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
          >
            <GlassCard className="p-10 md:p-12 text-center">

              {/* State orb — color/style varies by state */}
              <div className="flex justify-center mb-7">
                <EmptyOrb kind={emptyKind} />
              </div>

              {/* Headline */}
              <h3 className="text-2xl font-black font-headline mb-2 leading-tight">
                {emptyKind === 'no_responses'   && t('surveyInsights.empty.noResponses.title')}
                {emptyKind === 'insufficient'   && t('surveyInsights.empty.insufficient.title', { count: responseCount })}
                {emptyKind === 'low_confidence' && t('surveyInsights.empty.lowConfidence.title')}
                {emptyKind === 'ready'          && t('surveyInsights.empty.ready.title')}
                {emptyKind === 'failed'         && t('surveyInsights.empty.failed.title')}
              </h3>

              {/* Confidence / status badge */}
              {(emptyKind === 'low_confidence' || emptyKind === 'insufficient') && (
                <div className="flex justify-center mb-3">
                  <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-amber-50 text-amber-800 ring-1 ring-amber-200">
                    <Icon name="warning" size={12} />
                    {emptyKind === 'insufficient'
                      ? t('surveyInsights.empty.insufficient.warning')
                      : t('surveyInsights.empty.lowConfidence.badge', { count: responseCount })}
                  </span>
                </div>
              )}
              {emptyKind === 'ready' && (
                <div className="flex justify-center mb-3">
                  <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200">
                    <Icon name="verified" size={12} />
                    {t('surveyInsights.empty.ready.badge', { count: responseCount })}
                  </span>
                </div>
              )}
              {emptyKind === 'failed' && (
                <div className="flex justify-center mb-3">
                  <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-red-50 text-red-700 ring-1 ring-red-200">
                    <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
                    Generation failed
                  </span>
                </div>
              )}

              {/* Body copy */}
              <p className="text-on-surface-variant text-sm max-w-md mx-auto mb-3 leading-relaxed">
                {emptyKind === 'no_responses'   && t('surveyInsights.empty.noResponses.body')}
                {emptyKind === 'insufficient'   && t('surveyInsights.empty.insufficient.body', { count: responseCount, remaining: 5 - responseCount })}
                {emptyKind === 'low_confidence' && t('surveyInsights.empty.lowConfidence.body', { count: responseCount })}
                {emptyKind === 'ready'          && t('surveyInsights.empty.ready.body', { count: responseCount })}
                {emptyKind === 'failed'         && t('surveyInsights.empty.failed.body')}
              </p>

              {/* Progress bar — shown for insufficient state */}
              {emptyKind === 'insufficient' && (
                <div className="flex justify-center mb-6">
                  <div className="flex items-center gap-2 max-w-xs w-full">
                    <div className="flex-1 flex gap-1">
                      {Array.from({ length: 5 }).map((_, i) => (
                        <div
                          key={i}
                          className="flex-1 h-2 rounded-full transition-all duration-500"
                          style={{
                            background: i < responseCount ? '#2a4bd9' : 'var(--color-outline-variant)',
                          }}
                        />
                      ))}
                    </div>
                    <span className="text-xs font-bold text-on-surface-variant whitespace-nowrap">
                      {responseCount} / 5
                    </span>
                  </div>
                </div>
              )}

              {/* Error detail */}
              {emptyKind === 'failed' && genError && (
                <div className="mb-6 mx-auto max-w-md p-3 rounded-xl bg-red-50 border border-red-100 text-sm text-red-700 flex items-start gap-2 text-left">
                  <Icon name="error_outline" size={16} style={{ marginTop: 2, flexShrink: 0 }} />
                  <div>
                    <p className="font-bold mb-0.5">Error details</p>
                    <p className="font-mono text-xs break-all">{genError}</p>
                    <p className="text-xs mt-2 text-red-600/70">
                      {t('surveyInsights.empty.failed.devHint')}
                    </p>
                  </div>
                </div>
              )}

              {/* CTAs — hierarchy changes by state */}
              <div className="flex flex-wrap justify-center gap-3 mb-8">
                {/* Primary CTA */}
                {emptyKind === 'no_responses' && focusSurvey && (
                  <Link to={ROUTES.RESPONDENTS}>
                    <Button size="lg" className="font-bold text-white border-0 shadow-md" style={{ background: 'linear-gradient(135deg, #2a4bd9, #8329c8)' }}>
                      <Icon name="share" size={16} />
                      {t('surveyInsights.empty.noResponses.cta')}
                    </Button>
                  </Link>
                )}

                {emptyKind === 'insufficient' && focusSurvey && (
                  <>
                    {/* Collecting more is the encouraged path — primary */}
                    <Link to={ROUTES.RESPONDENTS}>
                      <Button size="lg" className="font-bold text-white border-0 shadow-md" style={{ background: 'linear-gradient(135deg, #2a4bd9, #8329c8)' }}>
                        <Icon name="share" size={16} />
                        {t('surveyInsights.empty.insufficient.cta')}
                      </Button>
                    </Link>
                    {/* Generate anyway is secondary — outlined, de-emphasized */}
                    <Button size="lg" variant="outline" onClick={onGenerate} className="font-bold">
                      <Icon name="auto_awesome" size={16} />
                      {t('surveyInsights.empty.insufficient.ctaGenerate')}
                    </Button>
                  </>
                )}

                {(emptyKind === 'low_confidence' || emptyKind === 'ready') && (
                  <Button
                    size="lg"
                    onClick={onGenerate}
                    className="font-bold text-white border-0 shadow-lg"
                    style={{ background: 'linear-gradient(135deg, #2a4bd9, #8329c8)' }}
                  >
                    <Icon name="auto_awesome" size={18} />
                    {emptyKind === 'low_confidence'
                      ? t('surveyInsights.empty.lowConfidence.cta')
                      : t('surveyInsights.empty.ready.cta')}
                  </Button>
                )}

                {emptyKind === 'failed' && (
                  <Button
                    size="lg"
                    onClick={onGenerate}
                    className="font-bold text-white border-0 shadow-md"
                    style={{ background: 'linear-gradient(135deg, #2a4bd9, #8329c8)' }}
                  >
                    <Icon name="refresh" size={16} />
                    {t('surveyInsights.empty.failed.cta')}
                  </Button>
                )}

                {/* Secondary CTA */}
                {focusSurvey && emptyKind !== 'insufficient' && (
                  <Link
                    to={emptyKind === 'no_responses'
                      ? ROUTES.RESPONDENTS
                      : toPath(ROUTES.RESPONSE_DASHBOARD, { surveyId: focusSurvey.id })}
                  >
                    <Button size="lg" variant="outline" className="font-bold">
                      <Icon name={emptyKind === 'no_responses' ? 'open_in_new' : 'table_rows'} size={16} />
                      {emptyKind === 'no_responses'
                        ? t('surveyInsights.empty.noResponses.ctaSecondary')
                        : emptyKind === 'failed'
                          ? t('surveyInsights.empty.failed.ctaSecondary')
                          : emptyKind === 'low_confidence'
                            ? t('surveyInsights.empty.lowConfidence.ctaSecondary')
                            : t('surveyInsights.empty.ready.ctaSecondary')}
                    </Button>
                  </Link>
                )}
              </div>

              {/* Runtime hint — shown when generation is possible */}
              {(emptyKind === 'low_confidence' || emptyKind === 'ready' || emptyKind === 'failed') && (
                <p className="text-xs text-on-surface-variant/60 mb-8">
                  {t('surveyInsights.empty.runtime')}
                </p>
              )}

              {/* Capabilities grid — shown when generation is likely to succeed (5+ responses) */}
              {(emptyKind === 'low_confidence' || emptyKind === 'ready') && (
                <div className="border-t border-outline-variant/20 pt-8">
                  <p className="text-[10px] font-black uppercase tracking-[0.2em] text-on-surface-variant mb-4">
                    What Crystal will surface
                  </p>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-left">
                    {([
                      { icon: 'sentiment_satisfied', labelKey: 'sentiment' as const, descKey: 'sentimentDesc' as const },
                      { icon: 'hub',                 labelKey: 'topics'    as const, descKey: 'topicsDesc'    as const },
                      { icon: 'insights',            labelKey: 'forecast'  as const, descKey: 'forecastDesc'  as const },
                      { icon: 'flag',                labelKey: 'actions'   as const, descKey: 'actionsDesc'   as const },
                    ] as const).map((item) => (
                      <div
                        key={item.labelKey}
                        className="p-3 rounded-xl border border-outline-variant/30 bg-surface-container/50"
                      >
                        <Icon name={item.icon} size={20} style={{ color: '#2a4bd9', marginBottom: 6 }} />
                        <div className="text-xs font-black">
                          {t(`surveyInsights.empty.capabilities.${item.labelKey}`)}
                        </div>
                        <div className="text-[10px] text-on-surface-variant">
                          {t(`surveyInsights.empty.capabilities.${item.descKey}`)}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* "What you'll get" teaser for insufficient state */}
              {emptyKind === 'insufficient' && (
                <div className="border-t border-outline-variant/20 pt-6">
                  <p className="text-[10px] font-black uppercase tracking-[0.2em] text-on-surface-variant mb-3">
                    What you'll unlock at 5+ responses
                  </p>
                  <div className="flex flex-wrap justify-center gap-2">
                    {['Sentiment analysis', 'Topic clusters', 'NPS trends', 'Predictions', 'Recommended actions'].map((cap) => (
                      <span key={cap} className="px-2.5 py-1 rounded-full text-xs bg-muted text-on-surface-variant border border-outline-variant/30">
                        {cap}
                      </span>
                    ))}
                  </div>
                </div>
              )}

            </GlassCard>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Error banner — when data exists but re-generation failed */}
      {genError && !showEmptyState && (
        <div className="p-4 rounded-xl bg-red-50 border border-red-100 text-sm text-red-700 flex items-start gap-3">
          <Icon name="error_outline" size={18} style={{ marginTop: 1, flexShrink: 0 }} />
          <div className="flex-1">
            <p className="font-bold mb-0.5">Re-generation failed</p>
            <p>{genError}</p>
          </div>
          <Button size="sm" variant="outline" onClick={onGenerate} className="text-xs border-red-200 text-red-700 hover:bg-red-100 flex-shrink-0">
            <Icon name="refresh" size={14} /> Retry
          </Button>
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════════════
          ALL-SURVEYS demo content — wrapped so it never renders for single survey
      ════════════════════════════════════════════════════════════════════ */}
      {isAll && (
        <>
          {/* Select-a-survey nudge */}
          <div className="flex items-center gap-3 px-4 py-3 rounded-xl border-2 border-dashed border-primary/30 bg-primary/3">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
              style={{ background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))' }}>
              <Icon name="psychology" size={16} style={{ color: 'white' }} />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold text-on-surface">Select a survey above to run Crystal's analysis</p>
              <p className="text-xs text-on-surface-variant mt-0.5">
                Crystal will read every response and surface what happened, why it happened, and what to fix — with cited evidence.
                The cards below use sample data for illustration.
              </p>
            </div>
            <span className="text-[10px] font-black uppercase tracking-widest text-on-surface-variant/50 flex-shrink-0">
              Sample data
            </span>
          </div>

          {/* ════════════════════════════════════════════════════════════════
              § 1  CRYSTAL HERO — dark cinematic section
          ════════════════════════════════════════════════════════════════ */}
          <motion.section
            variants={stagger}
            initial="hidden"
            animate="visible"
            className="relative overflow-hidden rounded-2xl"
        style={{
          background:
            'radial-gradient(ellipse at 25% 0%, rgba(42,75,217,0.45) 0%, transparent 55%),' +
            'radial-gradient(ellipse at 75% 20%, rgba(131,41,200,0.35) 0%, transparent 55%),' +
            'radial-gradient(ellipse at 50% 100%, rgba(0,100,124,0.25) 0%, transparent 60%),' +
            'linear-gradient(180deg, #07091F 0%, #0F0822 60%, #070920 100%)',
        }}
      >
        {/* Top vignette */}
        <div
          className="absolute inset-x-0 top-0 h-28 pointer-events-none"
          style={{ background: 'linear-gradient(to bottom, rgba(7,9,31,0.6), transparent)' }}
        />

        <div className="relative z-10 px-8 md:px-16 pt-16 pb-14 text-white text-center">
          {/* Live badge */}
          <motion.div variants={rise} className="flex justify-center mb-8">
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-[11px] font-bold"
              style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.12)' }}>
              <LiveDot color="#34d399" />
              <span className="text-emerald-300">
                {isAll
                  ? `${activeCount} surveys live · ${totalResponses.toLocaleString()} responses`
                  : 'Live · 3 new insights in last 60s'}
              </span>
            </div>
          </motion.div>

          {/* Crystal */}
          <motion.div variants={rise} className="flex justify-center mb-2 relative">
            {/* Glow pedestal */}
            <div
              className="absolute bottom-0 left-1/2 -translate-x-1/2 pointer-events-none"
              style={{
                width: 200,
                height: 60,
                background: 'radial-gradient(ellipse, rgba(131,41,200,0.5), transparent 70%)',
                filter: 'blur(16px)',
                bottom: -20,
              }}
            />
            <Crystal />
          </motion.div>

          <motion.div variants={rise}>
            <div className="text-[10px] font-black uppercase tracking-[0.3em] text-cyan-300/80 mb-3 mt-6">
              Crystal · Experience Intelligence
            </div>
            <h2 className="font-headline font-black text-2xl md:text-3xl tracking-tight text-white mb-2">
              {isAll
                ? `Ask anything across ${activeCount} surveys`
                : 'Ask anything about this survey'}
            </h2>
            <p className="text-sm text-white/60 mb-8 max-w-md mx-auto">
              Every answer cites real customer quotes. Numbers come from analytics tools, not the LLM.
            </p>
          </motion.div>

          {/* Ask bar */}
          <motion.div variants={rise} className="max-w-2xl mx-auto mb-5">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (askQuery.trim()) {
                  openCrystal(askQuery.trim());
                  setAskQuery('');
                }
              }}
              className="flex items-center gap-2 p-2 rounded-2xl"
              style={{
                background: 'rgba(255,255,255,0.07)',
                backdropFilter: 'blur(24px) saturate(180%)',
                WebkitBackdropFilter: 'blur(24px) saturate(180%)',
                border: '1px solid rgba(255,255,255,0.14)',
              }}
            >
              <button
                type="button"
                className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 hover:bg-white/10 transition-colors"
              >
                <Icon name="mic" size={20} style={{ color: 'rgba(255,255,255,0.7)' }} />
              </button>
              <input
                type="text"
                value={askQuery}
                onChange={(e) => setAskQuery(e.target.value)}
                placeholder={
                  isAll
                    ? '"Which survey has the highest churn risk?"'
                    : '"Why did NPS dip on May 10?"'
                }
                className="flex-1 px-3 py-2.5 bg-transparent focus:outline-none text-sm text-white placeholder:text-white/40"
              />
              <Button
                type="submit"
                size="sm"
                className="flex-shrink-0 text-xs font-bold text-white border-0 shadow-lg"
                style={{ background: 'linear-gradient(135deg, #2a4bd9, #8329c8)' }}
              >
                <Icon name="arrow_upward" size={15} />
                Ask Crystal
              </Button>
            </form>
          </motion.div>

          {/* Suggested prompts */}
          <motion.div variants={rise} className="flex flex-wrap justify-center gap-2">
            {isAll ? (
              <>
                <DarkPromptChip icon="compare" label="Which survey has highest churn risk?" onClick={() => openCrystal('Which survey has highest churn risk?')} />
                <DarkPromptChip icon="trending_up" label="Themes appearing in 3+ surveys" onClick={() => openCrystal('Themes appearing in 3+ surveys')} />
                <DarkPromptChip icon="balance" label="Over-sampled segments?" onClick={() => openCrystal('Are surveys over-sampling one segment?')} />
                <DarkPromptChip icon="lightbulb" label="Top portfolio action?" onClick={() => openCrystal('Top portfolio action right now?')} />
              </>
            ) : (
              <>
                <DarkPromptChip icon="trending_down" label="Why did NPS drop May 10?" onClick={() => openCrystal('Why did NPS drop May 10?')} />
                <DarkPromptChip icon="warning" label="Highest churn-risk segment?" onClick={() => openCrystal('Highest churn-risk segment?')} />
                <DarkPromptChip icon="lightbulb" label="What would raise CSAT most?" onClick={() => openCrystal('What would raise CSAT most?')} />
                <DarkPromptChip icon="compare" label="Compare to last quarter" onClick={() => openCrystal('Compare to last quarter')} />
              </>
            )}
          </motion.div>
        </div>
      </motion.section>

      {/* Portfolio stats — real data only */}
      <motion.section
        variants={stagger}
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true }}
        className="space-y-4"
      >
        <SectionLabel icon="monitoring" label="Portfolio overview" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <motion.div variants={rise}>
            <GlassCard className="p-5 text-center">
              <div className="text-3xl font-black font-headline">{activeCount}</div>
              <div className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant mt-1">Active surveys</div>
            </GlassCard>
          </motion.div>
          <motion.div variants={rise}>
            <GlassCard className="p-5 text-center">
              <div className="text-3xl font-black font-headline">{totalResponses.toLocaleString()}</div>
              <div className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant mt-1">Total responses</div>
            </GlassCard>
          </motion.div>
          <motion.div variants={rise}>
            <GlassCard className="p-5 text-center">
              <div className="text-3xl font-black font-headline">{displayNps != null ? displayNps : '—'}</div>
              <div className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant mt-1">Portfolio NPS</div>
            </GlassCard>
          </motion.div>
          <motion.div variants={rise}>
            <GlassCard className="p-5 text-center">
              <div className="text-3xl font-black font-headline">{surveys.length}</div>
              <div className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant mt-1">Total surveys</div>
            </GlassCard>
          </motion.div>
        </div>
      </motion.section>

      {/* Contributing surveys strip */}
      {activeSurveys.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
        >
          <div className="flex items-center gap-2 mb-3">
            <Icon name="dataset" size={15} className="text-on-surface-variant" />
            <span className="text-[10px] font-black uppercase tracking-widest text-on-surface-variant">
              Active surveys
            </span>
            <span className="text-[10px] text-on-surface-variant/60">
              {activeCount} surveys · {totalResponses.toLocaleString()} responses
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {activeSurveys.slice(0, 8).map((s) => (
              <button
                key={s.id}
                className="px-3 py-1.5 rounded-full bg-card border border-border/40 hover:border-primary/40 transition-colors flex items-center gap-2 text-xs"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                <span className="font-bold truncate max-w-[180px]">
                  {s.title || 'Untitled survey'}
                </span>
                <span className="font-mono text-on-surface-variant text-[10px]">
                  {(s.response_count ?? 0).toLocaleString()}
                </span>
              </button>
            ))}
            {activeSurveys.length > 8 && (
              <button className="px-3 py-1.5 rounded-full text-xs font-bold text-primary hover:bg-primary/10 transition-colors">
                +{activeSurveys.length - 8} more
              </button>
            )}
          </div>
        </motion.div>
      )}

      {/* Cross-survey portfolio analysis — coming in a future release */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.5 }}
      >
        <GlassCard className="p-8 text-center border-2 border-dashed border-primary/20">
          <div
            className="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-4"
            style={{ background: 'linear-gradient(135deg, rgba(42,75,217,0.12), rgba(131,41,200,0.12))' }}
          >
            <Icon name="hub" size={28} style={{ color: '#2a4bd9' }} />
          </div>
          <h3 className="text-lg font-black font-headline mb-2">
            Portfolio analysis coming soon
          </h3>
          <p className="text-sm text-on-surface-variant max-w-md mx-auto mb-5">
            Cross-survey theme clustering, portfolio NPS attribution, and segment comparison
            are being built. Select a specific survey above to run Crystal's full AI analysis now.
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            {[
              'Cross-survey themes',
              'Portfolio NPS attribution',
              'Segment comparison',
              'Survey correlation analysis',
            ].map((feature) => (
              <span
                key={feature}
                className="px-2.5 py-1 rounded-full text-xs border border-outline-variant/40 bg-muted/50 text-on-surface-variant"
              >
                {feature}
              </span>
            ))}
          </div>
        </GlassCard>
      </motion.div>
        </>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Sub-components
// ═══════════════════════════════════════════════════════════════════════════

// ── Insight filter pill ───────────────────────────────────────────────────
function FilterPill({
  children, active, onClick, activeColor, activeBg,
}: {
  children: ReactNode;
  active: boolean;
  onClick: () => void;
  activeColor?: string;
  activeBg?: string;
}) {
  return (
    <button
      onClick={onClick}
      className="px-2.5 py-1 rounded-full text-xs font-bold transition-all border"
      style={
        active
          ? {
              background:   activeBg      ?? 'var(--color-primary)',
              color:        activeColor   ?? 'white',
              borderColor:  activeColor   ?? 'var(--color-primary)',
            }
          : {
              background:   'transparent',
              color:        'var(--color-on-surface-variant)',
              borderColor:  'var(--color-outline-variant)',
            }
      }
    >
      {children}
    </button>
  );
}

// ── Category label formatter ───────────────────────────────────────────────
function prettifyCategory(cat: string): string {
  const MAP: Record<string, string> = {
    'voice.topic':  'Topics',
    'metric.nps':   'NPS',
    'metric.csat':  'CSAT',
    'metric.ces':   'CES',
    'meta.bias':    'Bias',
    'meta.cross':   'Cross-survey',
  };
  return MAP[cat] ?? (cat.split('.').pop()?.replace(/_/g, ' ') ?? cat);
}

// ── Crystal centerpiece — CSS layered hexagons, spins continuously ────────
function Crystal() {
  return (
    <div
      className="relative mx-auto"
      style={{ width: 200, height: 200, filter: 'drop-shadow(0 24px 48px rgba(42,75,217,0.3))' }}
    >
      <div
        className="absolute inset-0"
        style={{
          background:
            'conic-gradient(from 0deg at 50% 50%, #879aff 0%, #d299ff 25%, #82deff 50%, #d299ff 75%, #879aff 100%)',
          clipPath: 'polygon(50% 0%, 100% 30%, 100% 70%, 50% 100%, 0% 70%, 0% 30%)',
          animation: 'spin-crystal 20s linear infinite',
          filter: 'blur(0.5px)',
        }}
      />
      <div
        className="absolute"
        style={{
          inset: '18%',
          background:
            'conic-gradient(from 180deg at 50% 50%, #ffffff 0%, #879aff 33%, #d299ff 66%, #ffffff 100%)',
          clipPath: 'polygon(50% 0%, 100% 30%, 100% 70%, 50% 100%, 0% 70%, 0% 30%)',
          animation: 'spin-crystal 10s linear infinite reverse',
          opacity: 0.75,
        }}
      />
      <div
        className="absolute"
        style={{
          inset: '38%',
          background: 'radial-gradient(circle, #ffffff, #82deff)',
          borderRadius: '50%',
          filter: 'blur(5px)',
          animation: 'pulse-glow 2.5s ease-in-out infinite',
        }}
      />
      <style>{`
        @keyframes spin-crystal {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}

// ── Section label — divider with icon + label + optional explore link ────
function SectionLabel({ label, icon, explorePath }: { label: string; icon: string; explorePath?: string }) {
  return (
    <div className="flex items-center gap-3">
      <div className="h-px flex-1 bg-border/40" />
      <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.25em] text-on-surface-variant">
        <Icon name={icon} size={13} />
        {label}
      </div>
      {explorePath && (
        <Link
          to={explorePath}
          className="flex items-center gap-1 text-[10px] font-black uppercase tracking-[0.2em] text-primary hover:text-primary/70 transition-colors"
        >
          See full analysis
          <Icon name="arrow_forward" size={11} />
        </Link>
      )}
      <div className="h-px flex-1 bg-border/40" />
    </div>
  );
}

// ── Dark prompt chip (for dark hero section) ──────────────────────────────
function DarkPromptChip({ icon, label, onClick }: { icon?: string; label: string; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      className="px-3 py-1.5 rounded-full text-xs font-bold flex items-center gap-1.5 transition-colors"
      style={{
        background: 'rgba(255,255,255,0.08)',
        border: '1px solid rgba(255,255,255,0.12)',
        color: 'rgba(255,255,255,0.80)',
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.14)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.08)';
      }}
    >
      {icon && <Icon name={icon} size={13} style={{ color: 'rgba(255,255,255,0.7)' }} />}
      {label}
    </button>
  );
}

// ── Empty state orb — color/animation varies by state ────────────────────
function EmptyOrb({ kind }: { kind: 'no_responses' | 'insufficient' | 'low_confidence' | 'ready' | 'failed' }) {
  const config = {
    no_responses:   { from: '#94a3b8', to: '#cbd5e1', icon: 'inbox',        iconColor: '#64748b' },
    insufficient:   { from: '#f59e0b', to: '#fbbf24', icon: 'hourglass_top', iconColor: '#b45309' },
    low_confidence: { from: '#2a4bd9', to: '#8329c8', icon: 'psychology',    iconColor: 'white'   },
    ready:          { from: '#2a4bd9', to: '#8329c8', icon: 'auto_awesome',  iconColor: 'white'   },
    failed:         { from: '#f43f5e', to: '#e11d48', icon: 'error_outline', iconColor: 'white'   },
  }[kind];

  const isPulsing = kind === 'low_confidence' || kind === 'ready';
  const isDashed  = kind === 'no_responses';

  return (
    <motion.div
      animate={isPulsing ? { scale: [1, 1.06, 1] } : {}}
      transition={{ repeat: Infinity, duration: 2.8, ease: 'easeInOut' }}
      className="relative w-24 h-24"
    >
      <div
        className="absolute inset-0 rounded-full flex items-center justify-center"
        style={{
          background: isDashed
            ? 'transparent'
            : `linear-gradient(135deg, ${config.from}, ${config.to})`,
          border: isDashed ? `2px dashed ${config.from}` : 'none',
          boxShadow: isPulsing ? `0 0 40px -8px ${config.from}88` : 'none',
        }}
      >
        <Icon name={config.icon} size={36} style={{ color: isDashed ? config.from : config.iconColor }} />
      </div>
    </motion.div>
  );
}

// ── Auto-surfaced finding card ────────────────────────────────────────────
function AutoFinding({
  icon,
  iconColor,
  tag,
  tagColor,
  confidence,
  title,
  sub,
  borderLeft,
}: {
  icon: string;
  iconColor: string;
  tag: string;
  tagColor: string;
  confidence?: number;
  title: string;
  sub: string;
  borderLeft?: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] }}
    >
      <GlassCard
        className="p-5 flex items-start gap-4 hover:scale-[1.005] transition-transform cursor-pointer"
        style={borderLeft ? { borderLeft: `4px solid ${borderLeft}` } : undefined}
      >
        <Icon name={icon} size={22} style={{ color: iconColor, marginTop: 2 }} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className={`text-[10px] font-black uppercase tracking-widest ${tagColor}`}>
              {tag}
            </span>
            {confidence !== undefined && <ConfidenceChip value={confidence} />}
          </div>
          <div className="font-bold text-sm mb-1">{title}</div>
          <p className="text-xs text-on-surface-variant">{sub}</p>
        </div>
        <Icon
          name="arrow_forward"
          size={17}
          className="text-on-surface-variant self-center flex-shrink-0"
        />
      </GlassCard>
    </motion.div>
  );
}
