// SurveyIntelligencePage — Single-survey intelligence, one synthesized scroll.
//
// Design synthesis (no tabs, no view switching):
//   § 1  Sticky command strip    — survey title, KPI chips, sub-nav, regenerate
//   § 2  Tier progression banner — collecting → first_voices → early_signals → growing_picture
//   § 3  Pipeline animation      — 10-node progress when generating
//   § 4  Hero                    — Crystal (no insights) or Editorial narrative brief (with insights)
//   § 5  Metric tiles            — NPS gauge, CSAT, Top Action
//   § 6  Industry nudge          — prompts to configure industry for specialist agents
//   § 7  Anomaly alerts          — rising negative topics with "Ask Crystal why"
//   § 8  Featured insight + insight grid — /app/insights card patterns: featured NPS card,
//                                  layer+type filters, 2-col masonry with inline citations
//   § 9  Crystal ask bar         — always accessible inline
//   § 10 Trust footer            — citation validity, last scan, sample quality
//
// Business logic: all data flows from real API. Nothing is hardcoded.

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from '../../lib/i18n';
import { useSetPageTitle } from '../../contexts/pageTitle';
import { useSurveys } from '../../hooks/useSurveys';
import { useInsights } from '../../hooks/useInsights';
import { useApi } from '../../hooks/useApi';
import { useCrystalPanel } from '../../contexts/crystalPanel';
import { Icon } from '../../components/Icon';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { ROUTES, toPath } from '../../constants/routes';
import {
  GlassCard, CitationChip, ConfidenceChip, CIBar, LayerBadge,
  LiveDot, LAYER_CONFIG, SENTIMENT_BORDER,
} from '../insights/shared';
import { GeneratingOverlay } from '../insights/GeneratingOverlay';
import { ProgressArc } from '../../components/insights/ProgressArc';
import type { AgenticInsight, SurveyTopic } from '../../types';
import { stripCitationRefs } from '../../lib/utils';

// Pipeline node IDs — labels resolved via t() inside the component
const PIPELINE_NODE_IDS = ['ingest','embed','metrics','absa','cluster','topics','narrate','verify','evaluate','publish'] as const;
const PIPELINE_NODE_ICONS: Record<string, string> = {
  ingest:'download', embed:'memory', metrics:'analytics', absa:'sentiment_satisfied',
  cluster:'hub', topics:'topic', narrate:'edit_note', verify:'fact_check',
  evaluate:'verified', publish:'publish',
};

// ── Layer → Cockpit severity border color ─────────────────────────────────────
const SEV_COLOR: Record<AgenticInsight['layer'], string> = {
  prescriptive: '#059669',
  predictive:   '#d97706',
  diagnostic:   '#8329c8',
  descriptive:  '#2a4bd9',
};

function npsColor(v: number | null) {
  if (v == null) return 'var(--color-on-surface-variant)';
  return v >= 50 ? '#059669' : v >= 0 ? '#d97706' : '#b41340';
}
function npsLabel(v: number | null) {
  if (v == null) return '—';
  return v > 0 ? `+${v}` : String(v);
}
function npsCI(score: number | null, n: number) {
  if (score == null || n < 5) return 0;
  const p = (score + 100) / 200;
  return Math.round(1.645 * Math.sqrt((p * (1 - p)) / n) * 200);
}
function computeTier(n: number, hasInsights: boolean) {
  if (n < 10)  return 'collecting'      as const;
  if (n < 40)  return 'first_voices'    as const;
  if (n < 70)  return 'early_signals'   as const;
  if (n < 100) return 'growing_picture' as const;
  return hasInsights ? 'full_report' : 'growing_picture' as const;
}

// ── Page ─────────────────────────────────────────────────────────────────────
export function SurveyIntelligencePage() {
  const { surveyId } = useParams<{ surveyId: string }>();
  const { t }   = useTranslation();
  const api     = useApi();
  const { surveys, loading: surveysLoading } = useSurveys();
  const { setScope: setCrystalScope, openCrystal, setCrystalData } = useCrystalPanel();

  const survey = surveys.find((s) => s.id === surveyId);

  // Build pipeline nodes with localised labels
  const PIPELINE_NODES = PIPELINE_NODE_IDS.map((id) => ({
    id,
    label: t(`experience.intelligence.pipeline.${id}`),
    icon:  PIPELINE_NODE_ICONS[id] ?? 'circle',
  }));

  // ── Agentic insight state ────────────────────────────────────────────────
  const [agenticInsights, setAgenticInsights] = useState<AgenticInsight[]>([]);
  const [agenticLoading,  setAgenticLoading]  = useState(false);
  const [crystalOpening,  setCrystalOpening]  = useState<string | null>(null);

  // ── Topics (for anomaly alerts + Crystal context) ─────────────────────────
  const [topics,           setTopics]          = useState<SurveyTopic[]>([]);
  const [dismissedTopics,  setDismissedTopics] = useState<Set<string>>(new Set());

  // ── Org industry (for nudge banner) ──────────────────────────────────────
  const [orgIndustry,    setOrgIndustry]    = useState<string | null | undefined>(undefined);
  const [nudgeDismissed, setNudgeDismissed] = useState(false);

  // ── Insight feedback + audit drawer (mirrors UnifiedInsightsView) ─────────
  const [auditInsight, setAuditInsight] = useState<AgenticInsight | null>(null);
  const [insightFeedback, setInsightFeedback] = useState<Record<string, { thumbs?: 'up' | 'down' | null; pinned?: boolean }>>({});

  const handleThumb = useCallback(async (insightId: string, thumbs: 'up' | 'down') => {
    setInsightFeedback((prev) => {
      const cur = prev[insightId] ?? {};
      return { ...prev, [insightId]: { ...cur, thumbs: cur.thumbs === thumbs ? null : thumbs } };
    });
    const next = insightFeedback[insightId]?.thumbs === thumbs ? null : thumbs;
    try { await api.updateInsightFeedback(insightId, { thumbs: next }); } catch { /* optimistic */ }
  }, [api, insightFeedback]);

  const handlePin = useCallback(async (insightId: string) => {
    setInsightFeedback((prev) => {
      const cur = prev[insightId] ?? {};
      return { ...prev, [insightId]: { ...cur, pinned: !cur.pinned } };
    });
    const next = !insightFeedback[insightId]?.pinned;
    try { await api.updateInsightFeedback(insightId, { pinned: next }); } catch { /* optimistic */ }
  }, [api, insightFeedback]);

  // ── Pipeline state ───────────────────────────────────────────────────────
  const [generating,   setGenerating]   = useState(false);
  const [nodesDone,    setNodesDone]    = useState<string[]>([]);
  const [genError,     setGenError]     = useState<string | null>(null);
  const [genBackground,setGenBackground]= useState(false);
  const [genToast,     setGenToast]     = useState<string | null>(null);
  const pollRef   = useRef<ReturnType<typeof setInterval> | null>(null);
  const bgPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Legacy insights (NPS/CSAT from before the pipeline ran)
  const { insights, generating: legacyGenerating } = useInsights(surveyId);

  useSetPageTitle(
    survey?.title ?? t('nav.experience'),
    survey ? `${(survey.response_count ?? 0).toLocaleString()} ${t('common.responses')}` : t('experience.hub.subtitle'),
  );

  // Scope Crystal to this survey on mount; inject data; reset on unmount
  useEffect(() => {
    if (surveyId) setCrystalScope(surveyId);
    return () => { setCrystalScope('all'); setCrystalData([], []); };
  }, [surveyId, setCrystalScope, setCrystalData]);

  // Load agentic insights on mount
  const loadAgentic = useCallback(async () => {
    if (!surveyId) return;
    setAgenticLoading(true);
    try {
      const r = await api.listInsights(surveyId);
      const loaded = r.insights ?? [];
      setAgenticInsights(loaded);
      setCrystalOpening(r.crystal_opening ?? null);
      setCrystalData(loaded, []);
    } catch {
      setAgenticInsights([]);
    } finally {
      setAgenticLoading(false);
    }
  }, [api, surveyId, setCrystalData]);

  useEffect(() => {
    loadAgentic();
    return () => {
      if (pollRef.current)   clearInterval(pollRef.current);
      if (bgPollRef.current) clearInterval(bgPollRef.current);
    };
  }, [loadAgentic]);

  const startBackgroundPoll = useCallback((sid: string) => {
    if (bgPollRef.current) clearInterval(bgPollRef.current);
    bgPollRef.current = setInterval(async () => {
      try {
        const { status } = await api.getInsightRunStatus(sid);
        if (status === 'completed') {
          clearInterval(bgPollRef.current!);
          await loadAgentic();
          setGenBackground(false);
          setGenToast(t('experience.intelligence.generate.readyToast'));
        } else if (status === 'failed') {
          clearInterval(bgPollRef.current!);
          setGenBackground(false);
          setGenError(t('experience.intelligence.generate.errorFailed'));
        }
      } catch { /* keep polling */ }
    }, 10_000);
  }, [api, loadAgentic, t]);

  // Load topics for anomaly detection + Crystal context
  useEffect(() => {
    if (!surveyId) return;
    api.listTopics(surveyId)
      .then((r) => { setTopics(r.topics ?? []); setCrystalData(agenticInsights, r.topics ?? []); })
      .catch(() => {});
  }, [api, surveyId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load org profile to decide whether to show the industry nudge
  useEffect(() => {
    api.getOrgProfile()
      .then((d) => setOrgIndustry(d?.profile?.industry ?? null))
      .catch(() => setOrgIndustry(null));
  }, [api]);

  // Trigger pipeline + poll for completion
  const handleGenerate = useCallback(async () => {
    if (!surveyId || generating) return;
    setGenerating(true);
    setNodesDone([]);
    setGenError(null);
    setGenBackground(false);
    setGenToast(null);
    if (bgPollRef.current) clearInterval(bgPollRef.current);
    try {
      await api.triggerInsightGeneration(surveyId);
    } catch {
      setGenError(t('experience.intelligence.generate.errorStart'));
      setGenerating(false);
      return;
    }
    let elapsed = 0;
    pollRef.current = setInterval(async () => {
      elapsed += 3;
      try {
        const { status, stream_events } = await api.getInsightRunStatus(surveyId);
        const completed = (stream_events as Array<{ event: string; agent: string }>)
          .filter((e) => e.event === 'node_complete')
          .map((e) => e.agent);
        setNodesDone(completed);
        if (status === 'failed') {
          clearInterval(pollRef.current!);
          setGenError(t('experience.intelligence.generate.errorFailed'));
          setGenerating(false);
          return;
        }
        if (status === 'completed') {
          clearInterval(pollRef.current!);
          setNodesDone(PIPELINE_NODES.map((n) => n.id));
          await new Promise((r) => setTimeout(r, 700));
          await loadAgentic();
          setGenerating(false);
          setNodesDone([]);
          return;
        }
      } catch { /* keep polling */ }
      if (elapsed >= 120) {
        clearInterval(pollRef.current!);
        setGenerating(false);
        setNodesDone([]);
        setGenBackground(true);
        startBackgroundPoll(surveyId);
      }
    }, 3000);
  }, [api, surveyId, generating, loadAgentic, startBackgroundPoll, t]);

  // ── Derived values ────────────────────────────────────────────────────────
  const isActive  = survey?.status === 'active';
  // Prefer agentic metrics (from the completed pipeline) over stale cached values.
  // avg_csat is NOT stored on the surveys table — derive it from the metric.csat insight.
  const npsInsight  = agenticInsights.find((i) => i.category === 'metric.nps');
  const csatInsight = agenticInsights.find((i) => i.category === 'metric.csat');
  const nps  = npsInsight?.metric_json?.value  != null
    ? Math.round(npsInsight.metric_json.value)
    : (survey?.nps_score ?? insights?.nps_score ?? null);
  const csat = csatInsight?.metric_json?.value != null
    ? csatInsight.metric_json.value
    : null;   // Only available after pipeline runs — show "—" otherwise
  const resCount  = survey?.response_count ?? 0;
  const hasInsights = agenticInsights.length > 0;
  const tier      = computeTier(resCount, hasInsights);

  // Sorted insights: priority DESC, then trust DESC
  const sortedInsights = [...agenticInsights].sort(
    (a, b) => b.priority - a.priority || b.trust_score - a.trust_score,
  );

  // Bento cards: pick one representative insight per quadrant
  const topPrescriptive = sortedInsights.find((i) => i.layer === 'prescriptive');
  const topDiagnostic   = sortedInsights.find((i) => i.layer === 'diagnostic');
  const topPredictive   = sortedInsights.find((i) => i.layer === 'predictive');
  const topVoice        = sortedInsights.find((i) => i.category === 'voice.topic');

  // Trust summary
  const avgTrust = hasInsights
    ? Math.round(sortedInsights.reduce((s, i) => s + i.trust_score, 0) / sortedInsights.length)
    : null;
  const lastGenerated = sortedInsights[0]?.generated_at ?? null;

  // ── Surveys-loaded-but-survey-not-found guard ────────────────────────────
  // Only show "not found" after surveys have finished loading AND the surveyId
  // doesn't match any survey in the array (or loading returned 0 surveys).
  const surveyNotFound = !surveysLoading && !survey && !!surveyId;

  if (surveyNotFound) {
    return (
      <div className="max-w-3xl mx-auto w-full pt-12">
        <div className="glass-card-premium rounded-2xl p-12 text-center">
          <div className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-5"
            style={{ background: 'linear-gradient(135deg, rgba(180,19,64,0.10), rgba(180,19,64,0.06))' }}>
            <Icon name="search_off" size={32} style={{ color: '#b41340' }} />
          </div>
          <h2 className="text-xl font-black font-headline mb-2">{t('experience.intelligence.notFound.title')}</h2>
          <p className="text-sm text-on-surface-variant mb-5 max-w-xs mx-auto">
            {t('experience.intelligence.notFound.body')}
          </p>
          <Link to={ROUTES.EXPERIENCE}>
            <Button className="font-bold text-white border-0"
              style={{ background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))' }}>
              <Icon name="arrow_back" size={15} /> {t('experience.intelligence.notFound.backCta')}
            </Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={200}>

      {/* ── Insight audit drawer ────────────────────────────────────────── */}
      <Sheet open={!!auditInsight} onOpenChange={(open) => { if (!open) setAuditInsight(null); }}>
        <SheetContent side="right" className="w-full max-w-sm overflow-y-auto">
          {auditInsight && (
            <>
              <SheetHeader>
                <SheetTitle className="text-sm font-black">{t('experience.audit.title')}</SheetTitle>
              </SheetHeader>
              <div className="mt-6 space-y-4 text-xs">
                <div className="p-3 rounded-xl bg-muted/40 border border-outline-variant/20">
                  <p className="font-bold uppercase tracking-wide text-on-surface-variant mb-1">{t('experience.audit.modelLabel')}</p>
                  <p className="font-mono text-on-surface break-all">{auditInsight.audit_json?.model ?? '—'}</p>
                </div>
                <div className="p-3 rounded-xl bg-muted/40 border border-outline-variant/20">
                  <p className="font-bold uppercase tracking-wide text-on-surface-variant mb-1">{t('experience.audit.verifierLabel')}</p>
                  <p className="text-on-surface leading-relaxed">
                    {auditInsight.audit_json?.verifier_notes
                      ? `${auditInsight.audit_json.verifier_pass ? t('experience.audit.verifierPass') : t('experience.audit.verifierFail')} — ${auditInsight.audit_json.verifier_notes}`
                      : '—'}
                  </p>
                </div>
                {auditInsight.trust_json && (
                  <div className="p-3 rounded-xl bg-muted/40 border border-outline-variant/20 space-y-2">
                    <p className="font-bold uppercase tracking-wide text-on-surface-variant mb-1">{t('experience.audit.trustMetrics')}</p>
                    {([
                      { labelKey: 'experience.audit.coverage',    value: auditInsight.trust_json.coverage,    suffix: '%' },
                      { labelKey: 'experience.audit.consistency', value: auditInsight.trust_json.consistency, suffix: '%' },
                      { labelKey: 'experience.audit.statistical', value: auditInsight.trust_json.statistical, suffix: '' },
                      { labelKey: 'experience.audit.grounding',   value: auditInsight.trust_json.grounding,   suffix: '' },
                      { labelKey: 'experience.audit.sampleSize',  value: auditInsight.trust_json.sample_size, suffix: '' },
                    ] as const).map(({ labelKey, value, suffix }) => (
                      <div key={labelKey} className="flex justify-between items-center">
                        <span className="text-on-surface-variant">{t(labelKey)}</span>
                        <span className="font-black text-on-surface">{value != null ? `${value}${suffix}` : '—'}</span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="p-3 rounded-xl border-2 text-center"
                  style={{
                    borderColor: auditInsight.trust_score >= 80 ? '#059669' : auditInsight.trust_score >= 60 ? '#d97706' : '#94a3b8',
                    background:  auditInsight.trust_score >= 80 ? '#ecfdf5' : auditInsight.trust_score >= 60 ? '#fffbeb' : '#f8fafc',
                  }}>
                  <p className="font-bold uppercase tracking-wide text-on-surface-variant mb-1">{t('experience.audit.trustScore')}</p>
                  <p className="text-3xl font-black font-headline" style={{
                    color: auditInsight.trust_score >= 80 ? '#059669' : auditInsight.trust_score >= 60 ? '#d97706' : '#94a3b8',
                  }}>
                    {auditInsight.trust_score}<span className="text-sm font-bold opacity-60">{t('experience.audit.scoreMax')}</span>
                  </p>
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      <div className="max-w-7xl mx-auto w-full space-y-5 pt-6 md:pt-8">

        {/* ══════════════════════════════════════════════════════════════════
            § 1  STICKY COMMAND STRIP
        ══════════════════════════════════════════════════════════════════ */}
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
          className="glass-card-premium rounded-2xl px-5 py-3.5 sticky top-0 z-20 flex items-center gap-4 flex-wrap"
          style={{ boxShadow: '0 4px 24px rgba(0,0,0,0.07), inset 0 1px 0 rgba(255,255,255,0.9)' }}
        >
          <Link to={ROUTES.EXPERIENCE}
            className="text-[10px] font-bold text-on-surface-variant hover:text-primary transition-colors flex items-center gap-1">
            <Icon name="arrow_back" size={12} /> {t('experience.nav.backToExperience')}
          </Link>
          <span className="text-outline-variant text-xs">/</span>

          <div className="flex items-center gap-2 flex-1 min-w-0">
            {isActive && <span className="flex items-center gap-1 text-[10px] font-black text-emerald-600 flex-shrink-0"><LiveDot color="#059669" size={5} />{t('experience.common.live')}</span>}
            <h1 className="font-headline font-bold text-sm truncate">{survey?.title ?? '…'}</h1>
          </div>

          {/* KPI chips */}
          <div className="flex items-center divide-x divide-outline-variant/30">
            {nps != null && (
              <div className="px-3 text-center">
                <div className="text-[9px] font-black uppercase tracking-widest text-on-surface-variant leading-none mb-0.5">{t('experience.common.nps')}</div>
                <div className="text-lg font-black font-headline leading-none" style={{ color: npsColor(nps) }}>
                  {npsLabel(nps)}
                </div>
              </div>
            )}
            {csat != null && (
              <div className="px-3 text-center">
                <div className="text-[9px] font-black uppercase tracking-widest text-on-surface-variant leading-none mb-0.5">{t('experience.common.csat')}</div>
                <div className="text-lg font-black font-headline leading-none">{csat.toFixed(1)}</div>
              </div>
            )}
            <div className="px-3 text-center">
              <div className="text-[9px] font-black uppercase tracking-widest text-on-surface-variant leading-none mb-0.5">{t('experience.common.responses')}</div>
              <div className="text-lg font-black font-headline leading-none">{resCount.toLocaleString()}</div>
            </div>
          </div>

          {/* Sub-nav — Intelligence is active on this page */}
          <div className="flex items-center gap-1 flex-wrap">
            {([
              { label: t('experience.nav.intelligence'), icon: 'auto_awesome', path: toPath(ROUTES.EXPERIENCE_SURVEY, { surveyId: surveyId! }), active: true },
              { label: t('experience.nav.topics'),       icon: 'hub',          path: toPath(ROUTES.EXPERIENCE_SURVEY_TOPICS, { surveyId: surveyId! }) },
              { label: t('experience.nav.advanced'),     icon: 'analytics',    path: `${ROUTES.ADVANCED_INSIGHTS}?survey=${surveyId}` },
              { label: t('experience.nav.trends'),       icon: 'timeline',     path: toPath(ROUTES.EXPERIENCE_SURVEY_TRENDS, { surveyId: surveyId! }) },
              { label: t('experience.nav.report'),       icon: 'description',  path: toPath(ROUTES.EXPERIENCE_SURVEY_REPORT, { surveyId: surveyId! }) },
              { label: t('experience.nav.trail'),        icon: 'history',      path: toPath(ROUTES.INSIGHT_TRAIL, { surveyId: surveyId! }) },
              { label: t('experience.nav.customAnalysis'), icon: 'tune',       path: toPath(ROUTES.CUSTOM_ANALYSIS, { surveyId: surveyId! }) },
              { label: t('experience.nav.settings'),     icon: 'settings',     path: toPath(ROUTES.INSIGHT_SETTINGS, { surveyId: surveyId! }) },
            ] as const).map((item) => (
              <Link key={item.label} to={item.path}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-full text-[11px] font-bold transition-all"
                style={'active' in item && item.active ? {
                  background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))',
                  color: 'white',
                  boxShadow: '0 2px 8px color-mix(in srgb, var(--color-primary) 25%, transparent)',
                } : {
                  color: 'var(--color-on-surface-variant)',
                }}>
                <Icon name={item.icon} size={12} />{item.label}
              </Link>
            ))}
          </div>

          {/* Regenerate */}
          <Button size="sm" onClick={handleGenerate} disabled={generating || legacyGenerating}
            className="text-xs font-bold text-white border-0 flex-shrink-0"
            style={{ background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))' }}>
            {(generating || legacyGenerating)
              ? <><span className="w-3 h-3 rounded-full border-2 border-white/30 border-t-white animate-spin" />{t('experience.intelligence.generate.generating')}</>
              : <><Icon name="auto_awesome" size={13} />{t('experience.intelligence.generate.button')}</>}
          </Button>
        </motion.div>

        {/* Survey status badge */}
        {survey && survey.status !== 'active' && <SurveyStatusBadge status={survey.status} />}

        {/* Persistent error banner */}
        {genError && !generating && (
          <div className="flex items-start gap-3 px-4 py-3 rounded-xl border text-sm"
            style={{ background: '#fff1f2', borderColor: '#fecdd3', color: '#b41340' }}>
            <Icon name="error_outline" size={16} style={{ flexShrink: 0, marginTop: 1 }} />
            <div className="flex-1">
              <p className="font-bold">{t('experience.intelligence.generate.errorBannerTitle')}</p>
              <p className="text-xs mt-0.5 opacity-80">{genError}</p>
            </div>
            <button onClick={() => setGenError(null)}
              className="text-xs font-bold opacity-60 hover:opacity-100 transition-opacity flex-shrink-0">
              {t('experience.intelligence.generate.dismiss')}
            </button>
          </div>
        )}

        {/* Background-generation banner — overlay dismissed, pipeline still running */}
        <AnimatePresence>
          {genBackground && (
            <motion.div
              key="intel-bg-banner"
              initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.25 }}
              className="flex items-center gap-3 px-4 py-3 rounded-xl text-sm"
              style={{ background: '#eff2ff', border: '1px solid color-mix(in srgb, var(--color-primary) 25%, transparent)', color: '#1e40af' }}
            >
              <span className="w-2 h-2 rounded-full flex-shrink-0"
                style={{ background: 'var(--color-primary)', animation: 'pulse-glow 2s ease-in-out infinite' }} />
              <span className="flex-1 font-medium">{t('experience.intelligence.generate.backgroundBanner')}</span>
              <span className="text-xs opacity-60">{t('experience.intelligence.generate.readyToastBody')}</span>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Completion toast */}
        <AnimatePresence>
          {genToast && (
            <motion.div
              key="intel-ready-toast"
              initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
              className="flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium"
              style={{ background: '#d1fae5', border: '1px solid #059669', color: '#065f46' }}
            >
              <Icon name="check_circle" size={18} style={{ color: '#059669', flexShrink: 0 }} />
              <span className="flex-1">{genToast}</span>
              <button onClick={() => setGenToast(null)}
                className="ml-auto hover:opacity-70 transition-opacity"
                aria-label={t('experience.intelligence.generate.dismiss')}>
                <Icon name="close" size={16} />
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ══════════════════════════════════════════════════════════════════
            § 2  TIER PROGRESSION BANNER
        ══════════════════════════════════════════════════════════════════ */}
        {tier !== 'full_report' && (
          <TierBanner
            tier={tier} resCount={resCount}
            onGenerate={handleGenerate}
            isGenerating={generating || legacyGenerating}
            surveyStatus={survey?.status ?? 'active'}
          />
        )}

        {/* ══════════════════════════════════════════════════════════════════
            § 3  PIPELINE ANIMATION
        ══════════════════════════════════════════════════════════════════ */}
        <GeneratingOverlay
          generating={generating}
          nodesDone={nodesDone}
          genError={!hasInsights ? genError : null}
          nodes={PIPELINE_NODES}
          focusSurvey={survey}
          onRetry={handleGenerate}
        />

        {/* ══════════════════════════════════════════════════════════════════
            § 4  HERO
            No insights → Conversation Studio dark crystal hero
            Has insights → Editorial narrative brief with crystal_opening
        ══════════════════════════════════════════════════════════════════ */}
        {!generating && (
          <AnimatePresence mode="wait">
            {hasInsights ? (
              <motion.div key="editorial-hero"
                initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}>
                <EditorialHero
                  nps={nps} resCount={resCount}
                  crystalOpening={crystalOpening}
                  topInsight={sortedInsights[0] ?? null}
                  onGenerate={handleGenerate}
                  isGenerating={generating}
                />
              </motion.div>
            ) : !agenticLoading ? (
              <motion.div key="crystal-hero"
                initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                transition={{ duration: 0.6 }}>
                <CrystalHeroEmpty
                  tier={tier} resCount={resCount}
                  onGenerate={handleGenerate}
                  isGenerating={generating || legacyGenerating}
                  surveyId={surveyId!}
                  surveyTitle={survey?.title}
                />
              </motion.div>
            ) : null}
          </AnimatePresence>
        )}

        {/* ══════════════════════════════════════════════════════════════════
            § 5  METRIC TILES (Cockpit KPI strip + Editorial gauge style)
            Only shown when we have real metrics
        ══════════════════════════════════════════════════════════════════ */}
        {hasInsights && !generating && (
          <MetricTiles
            nps={nps} csat={csat} resCount={resCount}
            sparkline={survey?.sparkline}
            topPrescriptive={topPrescriptive ?? null}
            hasInsights={hasInsights}
          />
        )}

        {/* ══════════════════════════════════════════════════════════════════
            § 6  INDUSTRY NUDGE — only when org.industry is unset
        ══════════════════════════════════════════════════════════════════ */}
        {orgIndustry === null && !nudgeDismissed && (
          <motion.div
            initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35 }}
            className="flex items-center gap-3 px-4 py-3 rounded-xl border flex-wrap"
            style={{ background: 'rgba(234,179,8,0.06)', borderColor: 'rgba(234,179,8,0.3)' }}
          >
            <Icon name="lightbulb" fill={1} size={18} style={{ color: '#b45309', flexShrink: 0 }} />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold" style={{ color: '#92400e' }}>
                {t('insights.industryNudgeTitle')}
              </p>
              <p className="text-xs mt-0.5" style={{ color: '#b45309' }}>
                {t('insights.industryNudgeDesc')}
              </p>
            </div>
            <Link to={ROUTES.SETTINGS}
              className="shrink-0 text-[11px] font-bold px-3 py-1.5 rounded-full flex items-center gap-1 hover:opacity-90 transition-opacity"
              style={{ background: '#b45309', color: '#fff' }}>
              <Icon name="settings" size={13} />
              {t('insights.industryNudgeCta')}
            </Link>
            <button onClick={() => setNudgeDismissed(true)}
              className="shrink-0 p-1 rounded-full opacity-60 hover:opacity-100 transition-opacity"
              style={{ color: '#b45309' }} aria-label="Dismiss">
              <Icon name="close" size={16} />
            </button>
          </motion.div>
        )}

        {/* ══════════════════════════════════════════════════════════════════
            § 7  ANOMALY ALERTS — rising negative topics from pipeline
        ══════════════════════════════════════════════════════════════════ */}
        {hasInsights && !generating && (() => {
          const anomalies = topics.filter(
            (tp) => tp.trending === 'up' && (tp.sentiment_score ?? 0) < -0.3 && !dismissedTopics.has(tp.id),
          );
          if (!anomalies.length) return null;
          return (
            <motion.div
              initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, staggerChildren: 0.05 }}
              className="space-y-2"
            >
              {anomalies.map((tp, i) => (
                <motion.div key={tp.id}
                  initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.3, delay: i * 0.06 }}
                  className="flex items-center gap-3 rounded-xl px-4 py-3 border"
                  style={{ background: '#fff1f2', borderColor: '#fecdd3' }}
                >
                  <Icon name="warning" fill={1} size={18} style={{ color: '#b41340', flexShrink: 0 }} />
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-sm" style={{ color: '#9f1239' }}>
                      {t('insights.anomalyRising')} <span className="font-black">{tp.name}</span>
                    </p>
                    <p className="text-xs mt-0.5" style={{ color: '#be123c' }}>
                      {tp.volume} {t('insights.anomalyMentions')}
                      {tp.sentiment_score != null ? ` · ${tp.sentiment_score.toFixed(2)}` : ''}
                      {tp.effort_score != null ? ` · ${t('insights.anomalyEffort')} ${tp.effort_score.toFixed(1)}` : ''}
                    </p>
                  </div>
                  <button
                    onClick={() => openCrystal(
                      `Why is "${tp.name}" rising negatively? What are customers saying and what should we do?`,
                      { focused_topic: tp.name },
                    )}
                    className="shrink-0 text-[11px] font-bold px-3 py-1.5 rounded-full flex items-center gap-1 hover:opacity-90 transition-opacity"
                    style={{ background: '#b41340', color: '#fff' }}
                  >
                    <Icon name="psychology" size={13} />
                    {t('insights.anomalyAskCrystal')}
                  </button>
                  <button
                    onClick={() => setDismissedTopics((prev) => new Set([...prev, tp.id]))}
                    className="shrink-0 p-1 rounded-full opacity-60 hover:opacity-100 transition-opacity"
                    style={{ color: '#b41340' }} aria-label="Dismiss"
                  >
                    <Icon name="close" size={16} />
                  </button>
                </motion.div>
              ))}
            </motion.div>
          );
        })()}

        {/* ══════════════════════════════════════════════════════════════════
            § 8  FEATURED INSIGHT + FULL INSIGHT GRID
            Matches /app/insights: featured NPS card, layer+type filters,
            2-column masonry with inline citations, reliability badge,
            Helpful | Pin | Ask Crystal per-card actions.
        ══════════════════════════════════════════════════════════════════ */}
        {hasInsights && !generating && sortedInsights.length > 0 && (
          <InsightGrid
            insights={sortedInsights}
            onAskCrystal={(q, ctx) => openCrystal(q, ctx)}
            onAudit={(ins) => setAuditInsight(ins)}
            insightFeedback={insightFeedback}
            onThumb={handleThumb}
            onPin={handlePin}
          />
        )}

        {/* ══════════════════════════════════════════════════════════════════
            § 8  CRYSTAL ASK BAR (always accessible, Conversation Studio)
        ══════════════════════════════════════════════════════════════════ */}
        {!generating && (
          <CrystalAskBar
            surveyId={surveyId!}
            hasInsights={hasInsights}
            topInsight={sortedInsights[0] ?? null}
            onAsk={(q) => openCrystal(q)}
          />
        )}

        {/* ══════════════════════════════════════════════════════════════════
            § 9  TRUST FOOTER (Cockpit trust panel)
        ══════════════════════════════════════════════════════════════════ */}
        {hasInsights && !generating && (
          <TrustFooter
            insights={sortedInsights}
            avgTrust={avgTrust}
            lastGenerated={lastGenerated}
            resCount={resCount}
          />
        )}

      </div>
    </TooltipProvider>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// § 4a  EDITORIAL HERO — shown when insights exist
// Crystal opening text (LLM-generated portfolio brief) + top insight headline
// ══════════════════════════════════════════════════════════════════════════════
function EditorialHero({
  nps, resCount, crystalOpening, topInsight, onGenerate, isGenerating,
}: {
  nps: number | null; resCount: number; crystalOpening: string | null;
  topInsight: AgenticInsight | null; onGenerate: () => void; isGenerating: boolean;
}) {
  const { t } = useTranslation();
  return (
    <motion.section
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
      className="flex items-start gap-6"
    >
      {/* Holographic orb (Editorial pattern) */}
      <div
        className="w-28 h-28 rounded-2xl flex items-center justify-center flex-shrink-0 holographic hidden md:flex"
        style={{
          background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))',
          boxShadow: '0 10px 30px -10px color-mix(in srgb, var(--color-primary) 40%, transparent), inset 0 2px 4px rgba(255,255,255,0.2)',
          animation: 'float-bob 6s ease-in-out infinite',
        }}
      >
        <Icon name="diamond" size={40} style={{ color: 'white' }} />
      </div>

      <div className="flex-1 min-w-0">
        <div className="text-[10px] font-black uppercase tracking-[0.2em] text-tertiary mb-2">
          {t('experience.intelligence.hero.editorialTagline')}
        </div>

        {/* Headline: short and punchy — always use topInsight.headline, never the long narrative */}
        <h2 className="text-xl md:text-2xl font-black font-headline tracking-tight leading-snug mb-3 max-w-3xl text-on-surface">
          {topInsight ? topInsight.headline
            : t('experience.intelligence.hero.responsesCount', { n: resCount.toLocaleString() })}
        </h2>

        {/* crystalOpening is a full narrative paragraph — render as body text, not heading */}
        {(crystalOpening || topInsight?.narrative) && (
          <GlassCard className="p-5 max-w-3xl mb-4">
            <p className="text-sm leading-relaxed font-medium text-on-surface">
              {(() => {
                const text = crystalOpening ?? topInsight?.narrative ?? '';
                const truncated = text.length > 300 ? text.slice(0, 300) + '…' : text;
                return truncated;
              })()}
              {topInsight?.citations_json.slice(0, 3).map((c, ci) => (
                <CitationChip key={c.response_id ?? ci} id={(c.response_id ?? '').slice(-4) || String(ci + 1)} title={c.quote} />
              ))}
            </p>
            <div className="flex items-center gap-3 mt-4 pt-4 border-t border-outline-variant/25">
              <ConfidenceChip value={topInsight?.trust_score ?? 0} />
              <span className="text-xs text-on-surface-variant">
                {topInsight?.citations_json.length ?? 0} cited responses · n={resCount.toLocaleString()}
              </span>
              <div className="flex-1" />
              <Button variant="outline" size="sm" className="text-xs"
                onClick={() => onGenerate()} disabled={isGenerating}>
                <Icon name="refresh" size={13} /> {t('experience.intelligence.hero.refresh')}
              </Button>
            </div>
          </GlassCard>
        )}
      </div>
    </motion.section>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// § 4b  CRYSTAL HERO EMPTY — shown when no insights yet (Conversation Studio)
// ══════════════════════════════════════════════════════════════════════════════
function CrystalHeroEmpty({
  tier, resCount, onGenerate, isGenerating, surveyId, surveyTitle,
}: {
  tier: ReturnType<typeof computeTier>; resCount: number;
  onGenerate: () => void; isGenerating: boolean;
  surveyId: string; surveyTitle?: string;
}) {
  const { t } = useTranslation();
  const tierKey = tier === 'full_report' ? 'growing_picture' : tier;
  const msg = {
    headline: t(`experience.intelligence.tier.${tierKey}.headline`),
    sub:      t(`experience.intelligence.tier.${tierKey}.body`),
  };
  const canGenerate = tier !== 'collecting';

  return (
    <div
      className="relative overflow-hidden rounded-2xl text-white text-center px-8 py-14"
      style={{
        background:
          'radial-gradient(ellipse at 25% 0%, color-mix(in srgb, var(--color-primary) 50%, transparent) 0%, transparent 55%),' +
          'radial-gradient(ellipse at 75% 20%, color-mix(in srgb, var(--color-tertiary) 40%, transparent) 0%, transparent 55%),' +
          'linear-gradient(180deg, #07091F 0%, #0F0822 70%, #080A22 100%)',
      }}
    >
      {/* Perspective grid floor */}
      <div className="absolute inset-x-0 bottom-0 pointer-events-none" style={{
        height: '40%',
        backgroundImage: 'linear-gradient(color-mix(in srgb, var(--color-primary-container) 7%, transparent) 1px, transparent 1px), linear-gradient(90deg, color-mix(in srgb, var(--color-primary-container) 7%, transparent) 1px, transparent 1px)',
        backgroundSize: '56px 56px',
        transform: 'perspective(800px) rotateX(45deg)', transformOrigin: 'bottom',
        maskImage: 'linear-gradient(to top, rgba(0,0,0,0.4), transparent)',
      }} />

      <div className="relative z-10">
        {/* Crystal orb (Conversation Studio CSS) */}
        <div className="flex justify-center mb-6">
          <div style={{ width: 120, height: 120, position: 'relative', filter: 'drop-shadow(0 20px 40px color-mix(in srgb, var(--color-primary) 50%, transparent))' }}>
            <div style={{ position: 'absolute', inset: 0, background: 'conic-gradient(from 0deg at 50% 50%, var(--color-primary-container) 0%, var(--color-tertiary-container) 25%, var(--color-secondary-container) 50%, var(--color-tertiary-container) 75%, var(--color-primary-container) 100%)', clipPath: 'polygon(50% 0%, 100% 30%, 100% 70%, 50% 100%, 0% 70%, 0% 30%)', animation: 'exp-hub-spin 20s linear infinite', filter: 'blur(0.5px)' }} />
            <div style={{ position: 'absolute', inset: '18%', background: 'conic-gradient(from 180deg at 50% 50%, #ffffff 0%, var(--color-primary-container) 33%, var(--color-tertiary-container) 66%, #ffffff 100%)', clipPath: 'polygon(50% 0%, 100% 30%, 100% 70%, 50% 100%, 0% 70%, 0% 30%)', animation: 'exp-hub-spin 10s linear infinite reverse', opacity: 0.75 }} />
            <div style={{ position: 'absolute', inset: '38%', background: 'radial-gradient(circle, #ffffff, var(--color-secondary-container))', borderRadius: '50%', filter: 'blur(5px)', animation: 'pulse-glow 2.5s ease-in-out infinite' }} />
          </div>
        </div>

        <div className="text-[10px] font-black uppercase tracking-[0.3em] text-cyan-300/75 mb-3">
          {t('experience.intelligence.hero.tagline')} · {surveyTitle ?? t('nav.experience')}
        </div>
        <h2 className="text-2xl md:text-3xl font-black font-headline tracking-tight mb-3">
          {msg.headline}
        </h2>
        <p className="text-sm text-white/55 mb-7 max-w-md mx-auto">{msg.sub}</p>

        <div className="flex items-center justify-center gap-3 flex-wrap">
          {canGenerate && (
            <Button
              onClick={onGenerate} disabled={isGenerating}
              className="font-bold text-white border-0 shadow-xl px-6"
              style={{ background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))' }}>
              {isGenerating
                ? <><span className="w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />{t('experience.intelligence.generate.generating')}</>
                : <><Icon name="auto_awesome" size={16} />{t('experience.intelligence.generate.button')}</>}
            </Button>
          )}
          {tier === 'collecting' && (
            <Link to={ROUTES.RESPONDENTS}>
              <Button variant="outline" className="font-bold border-white/20 text-white bg-white/10 hover:bg-white/20 px-6">
                <Icon name="share" size={15} /> {t('experience.intelligence.tierBanner.share')}
              </Button>
            </Link>
          )}
        </div>

        {/* Progress arc + response count */}
        <div className="flex items-center justify-center gap-3 mt-6">
          <ProgressArc tier={tier} responseCount={resCount} size="sm" />
          <span className="text-[11px] text-white/50">
            {t('experience.intelligence.hero.responsesCount', { n: resCount.toLocaleString() })}
          </span>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// § 5  METRIC TILES (Cockpit KPI strip style)
// Real data: nps_score, avg_csat, top prescriptive insight, sparkline
// ══════════════════════════════════════════════════════════════════════════════
function MetricTiles({
  nps, csat, resCount, sparkline, topPrescriptive, hasInsights,
}: {
  nps: number | null; csat: number | null; resCount: number;
  sparkline?: number[]; topPrescriptive: AgenticInsight | null; hasInsights: boolean;
}) {
  const { t } = useTranslation();
  const ci = npsCI(nps, resCount);
  const ciPos = nps != null ? Math.round(((nps + 100) / 200) * 100) : 50;

  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.1 }}
      className="grid grid-cols-1 md:grid-cols-3 gap-4"
    >
      {/* NPS tile */}
      <GlassCard className="p-6">
        <div className="flex items-center justify-between mb-3">
          <span className="text-[10px] font-black uppercase tracking-widest text-on-surface-variant">{t('experience.intelligence.metrics.nps')}</span>
          {nps != null && <span className="text-[10px] font-bold text-emerald-600 flex items-center gap-0.5"><Icon name="trending_up" size={12} /></span>}
        </div>
        <div className="flex items-baseline gap-2 mb-1">
          <span className="text-5xl font-black font-headline" style={{ color: npsColor(nps) }}>
            {npsLabel(nps)}
          </span>
          {ci > 0 && <span className="text-on-surface-variant text-sm font-mono">±{ci}</span>}
        </div>
        <CIBar position={ciPos} width={120} />
        {/* Sparkline: survey.sparkline = daily response counts (7d), not NPS values.
            Shows response velocity as activity context under the NPS number. */}
        {sparkline && sparkline.length >= 3 ? (
          <>
            <MiniSparkline points={sparkline.slice(-7)} />
            <div className="text-[9px] text-on-surface-variant/50 mt-0.5">{t('experience.intelligence.metrics.sparklineLabel')}</div>
          </>
        ) : (
          <div className="mt-3 h-10 flex items-end gap-0.5 opacity-20">
            {[4,5,3,7,5,8,6].map((h, i) => (
              <div key={i} className="flex-1 rounded-t-sm bg-primary" style={{ height: `${h * 4}px` }} />
            ))}
          </div>
        )}
      </GlassCard>

      {/* CSAT tile */}
      <GlassCard className="p-6">
        <div className="flex items-center justify-between mb-3">
          <span className="text-[10px] font-black uppercase tracking-widest text-on-surface-variant">{t('experience.intelligence.metrics.csat')}</span>
          <span className="text-[10px] text-on-surface-variant/60">{t('experience.intelligence.metrics.csatScale')}</span>
        </div>
        <div className="flex items-baseline gap-2 mb-3">
          <span className="text-5xl font-black font-headline">
            {csat != null ? csat.toFixed(1) : '—'}
          </span>
          {csat != null && <span className="text-on-surface-variant text-sm">{t('experience.intelligence.metrics.csatSuffix')}</span>}
        </div>
        {csat != null && (
          <div className="flex items-end gap-1.5 h-10">
            {[25, 38, 55, 78, 92].map((h, i) => (
              <div key={i} className="flex-1 rounded-t-sm"
                style={{ height: `${h}%`, background: i === 4 ? 'linear-gradient(to top, var(--color-secondary), var(--color-primary))' : `color-mix(in srgb, var(--color-secondary) ${(0.25 + i * 0.14) * 100}%, transparent)` }} />
            ))}
          </div>
        )}
        {csat == null && (
          <p className="text-xs text-on-surface-variant/60">
            {hasInsights
              ? t('experience.intelligence.metrics.csatNoQuestion')
              : t('experience.intelligence.metrics.csatNoInsights')}
          </p>
        )}
      </GlassCard>

      {/* Top Action tile — from real prescriptive insight */}
      {topPrescriptive ? (
        <div className="rounded-2xl p-6 holographic text-white relative overflow-hidden"
          style={{ background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))' }}>
          <div className="flex items-center justify-between mb-3 relative z-10">
            <span className="text-[10px] font-black uppercase tracking-widest opacity-90">{t('experience.intelligence.metrics.topAction')}</span>
            <ConfidenceChip value={topPrescriptive.trust_score} dark />
          </div>
          <h3 className="text-lg font-black font-headline leading-tight mb-2 relative z-10">
            {topPrescriptive.recommended_action?.label ?? topPrescriptive.headline}
          </h3>
          {topPrescriptive.metric_json?.value != null && (
            <p className="text-sm font-bold opacity-90 mb-3 relative z-10">
              {t('experience.intelligence.metrics.projectedImpact', { n: topPrescriptive.metric_json.value.toFixed(1) })}
            </p>
          )}
          <div className="flex items-center gap-2 relative z-10">
            <Button size="sm" className="bg-white text-primary hover:bg-white/90 text-xs font-bold">
              <Icon name="flag" size={13} /> {t('experience.intelligence.metrics.createTicket')}
            </Button>
            {topPrescriptive.citations_json.length > 0 && (
              <span className="text-xs opacity-80">{t('experience.intelligence.metrics.cited', { n: String(topPrescriptive.citations_json.length) })}</span>
            )}
          </div>
        </div>
      ) : (
        <GlassCard className="p-6 flex flex-col items-center justify-center text-center">
          <Icon name="flag" size={28} style={{ color: 'var(--color-primary)', marginBottom: 8, opacity: 0.4 }} />
          <p className="text-sm text-on-surface-variant">{t('experience.intelligence.metrics.prescriptiveEmpty')}</p>
        </GlassCard>
      )}
    </motion.div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// § 8  INSIGHT GRID — Featured insight + layer/type filters + 2-col masonry cards
// Matches /app/insights: FEATURED INSIGHT card, layer badge, reliability badge,
// inline citation quotes, Helpful | Pin | Ask Crystal per-card action bar.
// ══════════════════════════════════════════════════════════════════════════════

function InsightGrid({
  insights, onAskCrystal, onAudit, insightFeedback, onThumb, onPin,
}: {
  insights: AgenticInsight[];
  onAskCrystal: (q: string, ctx?: { focused_topic?: string }) => void;
  onAudit: (ins: AgenticInsight) => void;
  insightFeedback: Record<string, { thumbs?: 'up' | 'down' | null; pinned?: boolean }>;
  onThumb: (id: string, thumbs: 'up' | 'down') => void;
  onPin: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [filterLayer,    setFilterLayer]    = useState<AgenticInsight['layer'] | 'all'>('all');
  const [filterCategory, setFilterCategory] = useState<string>('all');

  const availableLayers = useMemo(() => {
    const present = new Set(insights.map((i) => i.layer));
    return (['descriptive','diagnostic','predictive','prescriptive'] as const).filter((l) => present.has(l));
  }, [insights]);

  const availableCategories = useMemo(() => {
    const cats = [...new Set(insights.map((i) => i.category).filter(Boolean))];
    return cats.sort();
  }, [insights]);

  const filtered = useMemo(() => insights.filter((ins) => {
    if (filterLayer    !== 'all' && ins.layer    !== filterLayer)    return false;
    if (filterCategory !== 'all' && ins.category !== filterCategory) return false;
    return true;
  }), [insights, filterLayer, filterCategory]);

  // Hero: pick the single most actionable, evidence-backed insight.
  // Priority order: prescriptive with action → diagnostic with narrative+citations
  // → any with real narrative+citations → skip featured entirely.
  // Metric-only restatements (no narrative, no citations) are never featured.
  const heroInsight = (() => {
    const hasEvidence = (i: AgenticInsight) =>
      i.citations_json.length > 0 &&
      i.narrative?.trim().length > 0 &&
      !/^[^:]{1,60}:\s/.test(i.narrative);

    // 1. Best prescriptive: has a recommended action + evidence
    const bestPrescriptive = insights
      .filter((i) => i.layer === 'prescriptive' && i.recommended_action && hasEvidence(i))
      .sort((a, b) => b.priority - a.priority || b.trust_score - a.trust_score)[0];
    if (bestPrescriptive) return bestPrescriptive;

    // 2. Best diagnostic: has narrative + citations + trust ≥ 65
    const bestDiagnostic = insights
      .filter((i) => i.layer === 'diagnostic' && i.trust_score >= 65 && hasEvidence(i))
      .sort((a, b) => b.priority - a.priority || b.trust_score - a.trust_score)[0];
    if (bestDiagnostic) return bestDiagnostic;

    // 3. Any insight with real evidence, sorted by priority × trust
    const anyWithEvidence = insights
      .filter(hasEvidence)
      .sort((a, b) => (b.priority * b.trust_score) - (a.priority * a.trust_score))[0];
    if (anyWithEvidence) return anyWithEvidence;

    // 4. Nothing worth featuring — return null to hide the section
    return null;
  })();

  function prettifyCategory(cat: string) {
    const MAP: Record<string, string> = {
      'voice.topic': t('experience.insightGrid.category.topics'),
      'metric.nps':  t('experience.insightGrid.category.nps'),
      'metric.csat': t('experience.insightGrid.category.csat'),
      'metric.ces':  t('experience.insightGrid.category.ces'),
      'meta.bias':   t('experience.insightGrid.category.bias'),
    };
    return MAP[cat] ?? (cat.split('.').pop()?.replace(/_/g, ' ') ?? cat);
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.1 }}
      className="space-y-5"
    >
      {/* ── Featured insight card ──────────────────────────────────────── */}
      {heroInsight && (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}>
          <GlassCard className="p-6 overflow-hidden relative"
            style={{ background: 'linear-gradient(135deg, color-mix(in srgb, var(--color-primary) 6%, transparent) 0%, color-mix(in srgb, var(--color-tertiary) 4%, transparent) 100%)', borderColor: 'color-mix(in srgb, var(--color-primary) 20%, transparent)' }}>

            {/* Header row: featured label + layer badge + reliability */}
            <div className="flex items-center gap-2 mb-3 flex-wrap">
              <span className="text-[10px] font-black uppercase tracking-[0.2em] text-primary">
                {t('experience.insightGrid.featuredLabel')}
              </span>
              {/* Layer badge — uses real layer, not hardcoded "NPS" */}
              <span className="px-2 py-0.5 rounded-md text-[10px] font-bold"
                style={{ background: LAYER_CONFIG[heroInsight.layer]?.bg ?? '#e0f2fe', color: LAYER_CONFIG[heroInsight.layer]?.color ?? '#0369a1' }}>
                {t(`surveyInsights.layers.${heroInsight.layer}.label`)}
              </span>
              {prettifyCategory(heroInsight.category) && (
                <span className="text-[10px] text-on-surface-variant/60 font-medium">
                  {prettifyCategory(heroInsight.category)}
                </span>
              )}
              <div className="flex-1" />
              <span className={`text-[10px] font-bold ${heroInsight.trust_score >= 80 ? 'text-emerald-700' : heroInsight.trust_score >= 60 ? 'text-amber-700' : 'text-on-surface-variant'}`}>
                {heroInsight.trust_score >= 80 ? t('experience.insightGrid.reliable') : heroInsight.trust_score >= 60 ? t('experience.insightGrid.indicative') : t('experience.insightGrid.lowSignal')}
              </span>
            </div>

            {/* Headline */}
            <h2 className="text-xl font-black font-headline leading-snug mb-3 text-on-surface">
              {heroInsight.headline}
            </h2>

            {/* Narrative — the business explanation */}
            {heroInsight.narrative && !/^[^:]{1,60}:\s/.test(heroInsight.narrative) && (
              <p className="text-sm text-on-surface-variant leading-relaxed mb-4 max-w-2xl">
                {heroInsight.narrative.length > 320 ? heroInsight.narrative.slice(0, 320) + '…' : heroInsight.narrative}
              </p>
            )}

            {/* Top citation quote — real customer voice */}
            {heroInsight.citations_json[0]?.quote && (
              <div className="px-3 py-2.5 rounded-xl mb-4 text-sm italic leading-relaxed"
                style={{ background: 'var(--color-surface-container)', borderLeft: `3px solid ${LAYER_CONFIG[heroInsight.layer]?.color ?? '#2a4bd9'}` }}>
                "{heroInsight.citations_json[0].quote.slice(0, 160)}{heroInsight.citations_json[0].quote.length > 160 ? '…' : ''}"
                <span className="block text-[10px] not-italic text-on-surface-variant/60 mt-1">
                  {t('experience.insightGrid.featuredCited', {
                    n: String(heroInsight.citations_json.length),
                    word: heroInsight.citations_json.length === 1
                      ? t('experience.insightGrid.featuredCitedSingular')
                      : t('experience.insightGrid.featuredCitedPlural'),
                  })}
                </span>
              </div>
            )}

            {/* Recommended action — the punchline for prescriptive insights */}
            {heroInsight.recommended_action && (
              <div className="flex items-start gap-2 p-3 rounded-xl bg-primary/5 border border-primary/15 mb-4">
                <Icon name="bolt" size={15} style={{ color: 'var(--color-primary)', flexShrink: 0, marginTop: 1 }} />
                <div>
                  <p className="text-xs font-black text-primary mb-0.5">{t('experience.insightGrid.featuredAction')}</p>
                  <p className="text-sm font-semibold text-on-surface leading-snug">
                    {heroInsight.recommended_action.label}
                  </p>
                  {heroInsight.recommended_action.target && (
                    <p className="text-[11px] text-on-surface-variant mt-0.5 font-mono">
                      {heroInsight.recommended_action.target}
                    </p>
                  )}
                </div>
              </div>
            )}

            {/* Footer: trust + ask */}
            <div className="flex items-center gap-3 pt-3 border-t border-outline-variant/20">
              <span className="text-[10px] text-on-surface-variant/60">
                {t('experience.insightGrid.featuredTrust', {
                  score: String(heroInsight.trust_score),
                  n: String(heroInsight.citations_json.length),
                })}
              </span>
              <div className="flex-1" />
              <button
                onClick={() => onAskCrystal(heroInsight.headline)}
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-bold hover:bg-primary/10 transition-colors"
                style={{ color: 'var(--color-primary)' }}>
                <Icon name="psychology" size={13} /> {t('experience.insightGrid.askCrystal')}
              </button>
            </div>

            <div
              className="absolute -right-8 -top-8 w-32 h-32 rounded-full pointer-events-none"
              style={{ background: 'radial-gradient(circle, color-mix(in srgb, var(--color-primary) 12%, transparent), transparent 70%)' }}
            />
          </GlassCard>
        </motion.div>
      )}

      {/* ── Filters ────────────────────────────────────────────────────── */}
      {(availableLayers.length > 1 || availableCategories.length > 1) && (
        <div className="space-y-2 px-1">
          {availableLayers.length > 1 && (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[10px] font-black uppercase tracking-widest text-on-surface-variant w-12 shrink-0">
                {t('surveyInsights.filters.layerLabel')}
              </span>
              <div className="flex gap-1.5 flex-wrap">
                <FilterPill active={filterLayer === 'all'} onClick={() => setFilterLayer('all')}>
                  {t('surveyInsights.filters.all')} ({insights.length})
                </FilterPill>
                {availableLayers.map((layer) => {
                  const cfg = LAYER_CONFIG[layer];
                  const count = insights.filter((i) => i.layer === layer).length;
                  return (
                    <FilterPill key={layer} active={filterLayer === layer}
                      activeColor={cfg.color} activeBg={cfg.bg}
                      onClick={() => setFilterLayer(filterLayer === layer ? 'all' : layer)}>
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
                <FilterPill active={filterCategory === 'all'} onClick={() => setFilterCategory('all')}>
                  {t('surveyInsights.filters.all')}
                </FilterPill>
                {availableCategories.map((cat) => {
                  const count = insights.filter((i) => i.category === cat).length;
                  return (
                    <FilterPill key={cat} active={filterCategory === cat}
                      onClick={() => setFilterCategory(filterCategory === cat ? 'all' : cat)}>
                      {prettifyCategory(cat)} ({count})
                    </FilterPill>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Count divider ──────────────────────────────────────────────── */}
      <div className="flex items-center gap-3">
        <div className="h-px flex-1 bg-outline-variant/25" />
        <span className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-[0.22em] text-on-surface-variant">
          <Icon name="auto_awesome" size={12} />
          {t('experience.insightGrid.generatedCount', { n: String(filtered.length) })}
        </span>
        <div className="h-px flex-1 bg-outline-variant/25" />
      </div>

      {/* ── 2-column insight cards ─────────────────────────────────────── */}
      {filtered.length === 0 ? (
        <div className="py-10 text-center">
          <p className="text-sm text-on-surface-variant mb-3">{t('surveyInsights.filters.noResults')}</p>
          <button onClick={() => { setFilterLayer('all'); setFilterCategory('all'); }}
            className="text-xs font-bold text-primary hover:underline">
            {t('surveyInsights.filters.clearFilters')}
          </button>
        </div>
      ) : (
        <motion.div variants={{ hidden: {}, visible: { transition: { staggerChildren: 0.05 } } }}
          initial="hidden" animate="visible"
          className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {filtered.map((insight, i) => {
            const layerCfg = LAYER_CONFIG[insight.layer] ?? LAYER_CONFIG.descriptive;
            const fb = insightFeedback[insight.id] ?? {};
            return (
              <motion.div key={insight.id}
                variants={{ hidden: { opacity: 0, y: 14 }, visible: { opacity: 1, y: 0, transition: { duration: 0.45, ease: [0.22, 1, 0.36, 1] as [number,number,number,number] } } }}
                custom={i}
                className="group"
              >
                <GlassCard className="p-5 h-full flex flex-col overflow-hidden transition-shadow duration-200 hover:shadow-lg">
                  {/* Coloured top accent bar */}
                  <div className="-mx-5 -mt-5 mb-4 h-[3px] rounded-t-2xl"
                    style={{ background: layerCfg.color }} />

                  {/* Row 1: layer badge + reliability badge */}
                  <div className="flex items-center gap-2 mb-2 flex-wrap">
                    <span className="px-2 py-0.5 rounded-md text-[10px] font-bold tracking-wide"
                      style={{ background: layerCfg.bg, color: layerCfg.color }}>
                      {t(`surveyInsights.layers.${insight.layer}.label`)}
                    </span>
                    {insight.metric_json?.dominant_sentiment && (
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold ${
                        insight.metric_json.dominant_sentiment === 'positive' ? 'bg-emerald-50 text-emerald-700' :
                        insight.metric_json.dominant_sentiment === 'negative' ? 'bg-red-50 text-red-700' :
                        'bg-muted text-on-surface-variant'}`}>
                        <span className="w-1.5 h-1.5 rounded-full" style={{
                          background: insight.metric_json.dominant_sentiment === 'positive' ? '#059669' :
                                      insight.metric_json.dominant_sentiment === 'negative' ? '#dc2626' : '#94a3b8'
                        }} />
                        {insight.metric_json.dominant_sentiment}
                      </span>
                    )}
                    <div className="flex-1" />
                    <button
                      className={`text-[10px] font-bold cursor-pointer hover:underline transition-colors ${
                        insight.trust_score >= 80 ? 'text-emerald-700' :
                        insight.trust_score >= 60 ? 'text-amber-700' : 'text-on-surface-variant'}`}
                      onClick={() => onAudit(insight)}
                      title={t('experience.insightGrid.auditTooltip')}
                    >
                      {insight.trust_score >= 80 ? t('experience.insightGrid.reliable') :
                       insight.trust_score >= 60 ? t('experience.insightGrid.indicative') : t('experience.insightGrid.lowSignal')}
                    </button>
                  </div>

                  {/* Headline */}
                  <h3 className="text-sm font-black font-headline leading-snug mb-2">
                    {stripCitationRefs(insight.headline)}
                  </h3>

                  {/* Narrative — strip LLM citation markers before display */}
                  {(() => {
                    const raw = stripCitationRefs(insight.narrative ?? '');
                    const isRawDump = /^[^:]{1,60}:\s/.test(raw) && raw.split(' ').length < 14;
                    return !isRawDump && raw.length > 0 ? (
                      <p className="text-xs text-on-surface-variant leading-relaxed flex-1 mb-3">
                        {raw.length > 200 ? raw.slice(0, 200) + '…' : raw}
                      </p>
                    ) : <div className="flex-1" />;
                  })()}

                  {/* Inline citation quotes — real verbatims from respondents */}
                  {insight.citations_json.length > 0 && (
                    <div className="space-y-1.5 mb-3">
                      {insight.citations_json.slice(0, 2).map((c, ci) => (
                        <div key={c.response_id ?? `${insight.id}-c${ci}`}
                          className="px-3 py-2 rounded-lg text-xs leading-relaxed text-on-surface italic"
                          style={{
                            background: 'var(--color-surface-container)',
                            borderLeft: `2px solid ${SENTIMENT_BORDER[c.sentiment] ?? 'var(--color-outline-variant)'}`,
                          }}>
                          {(() => { const q = stripCitationRefs(c.quote ?? ''); return `"${q.length > 120 ? q.slice(0, 120) + '…' : q}"`; })()}
                        </div>
                      ))}
                      {insight.citations_json.length > 2 && (
                        <button
                          onClick={() => onAskCrystal(insight.headline)}
                          className="text-[10px] font-bold text-primary hover:underline px-1">
                          {t('experience.insightGrid.moreQuotes', { n: String(insight.citations_json.length - 2) })}
                        </button>
                      )}
                    </div>
                  )}

                  {/* Recommended action */}
                  {insight.recommended_action && (
                    <div className="flex items-start gap-2 p-2.5 rounded-lg bg-primary/5 border border-primary/15 mb-3">
                      <Icon name="bolt" size={13} style={{ color: 'var(--color-primary)', flexShrink: 0, marginTop: 1 }} />
                      <div>
                        <p className="text-xs font-semibold text-on-surface leading-snug">
                          {insight.recommended_action.label}
                        </p>
                        {insight.recommended_action.target && (
                          <p className="text-[10px] text-on-surface-variant mt-0.5 font-mono">
                            {insight.recommended_action.target}
                          </p>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Action bar: Helpful | Pin | Ask Crystal + category */}
                  <div className="flex items-center gap-1 pt-2.5 border-t border-outline-variant/20">
                    <Button size="sm" variant="ghost"
                      className={`text-xs gap-1 px-2 h-7 transition-colors ${fb.thumbs === 'up' ? 'text-emerald-600' : ''}`}
                      onClick={() => onThumb(insight.id, 'up')}>
                      <Icon name="thumb_up" size={13} style={fb.thumbs === 'up' ? { color: '#059669' } : undefined} />
                      {t('experience.insightGrid.helpful')}
                    </Button>
                    <Button size="sm" variant="ghost"
                      className={`text-xs gap-1 px-2 h-7 transition-colors ${fb.pinned ? 'text-primary' : ''}`}
                      onClick={() => onPin(insight.id)}>
                      <Icon name="push_pin" size={13} style={fb.pinned ? { color: 'var(--color-primary)' } : undefined} />
                      {fb.pinned ? t('experience.insightGrid.pinned') : t('experience.insightGrid.pin')}
                    </Button>
                    <Button size="sm" variant="ghost"
                      className="text-xs gap-1 px-2 h-7 text-primary hover:bg-primary/8"
                      onClick={() => onAskCrystal(insight.headline)}>
                      <Icon name="psychology" size={13} style={{ color: 'var(--color-primary)' }} />
                      {t('experience.insightGrid.askCrystal')}
                    </Button>
                    <div className="flex-1" />
                    <span className="text-[10px] text-on-surface-variant/50 capitalize">
                      {prettifyCategory(insight.category)}
                    </span>
                  </div>
                </GlassCard>
              </motion.div>
            );
          })}
        </motion.div>
      )}
    </motion.div>
  );
}

// ── Filter pill ───────────────────────────────────────────────────────────────
function FilterPill({
  children, active, onClick, activeColor, activeBg,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
  activeColor?: string;
  activeBg?: string;
}) {
  return (
    <button onClick={onClick}
      className="px-2.5 py-1 rounded-full text-xs font-bold transition-all border"
      style={active
        ? { background: activeBg ?? 'var(--color-primary)', color: activeColor ?? 'white', borderColor: activeColor ?? 'var(--color-primary)' }
        : { background: 'transparent', color: 'var(--color-on-surface-variant)', borderColor: 'var(--color-outline-variant)' }
      }>
      {children}
    </button>
  );
}


// ══════════════════════════════════════════════════════════════════════════════
// § 8  CRYSTAL ASK BAR (always visible inline)
// ══════════════════════════════════════════════════════════════════════════════
function CrystalAskBar({
  hasInsights, topInsight, onAsk, surveyId,
}: {
  hasInsights: boolean; topInsight: AgenticInsight | null;
  onAsk: (q: string) => void; surveyId: string;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');

  // Dynamic prompt chips: driven by what insights exist, all text from locale
  const chips = hasInsights && topInsight
    ? [
        { icon: 'help',         label: `Why: "${topInsight.headline.slice(0, 40)}${topInsight.headline.length > 40 ? '…' : ''}"?`, q: `Explain why: ${topInsight.headline}` },
        { icon: 'lightbulb',   label: t('experience.intelligence.askBar.chipFix'),       q: t('experience.intelligence.askBar.queryFix') },
        { icon: 'warning',     label: t('experience.intelligence.askBar.chipAnomalies'), q: t('experience.intelligence.askBar.queryAnomalies') },
        { icon: 'compare',     label: t('experience.intelligence.askBar.chipSegment'),   q: t('experience.intelligence.askBar.querySegment') },
      ]
    : [
        { icon: 'trending_down', label: t('experience.intelligence.askBar.chipDrop'),    q: t('experience.intelligence.askBar.queryDrop') },
        { icon: 'warning',       label: t('experience.intelligence.askBar.chipSegment'), q: t('experience.intelligence.askBar.querySegment') },
        { icon: 'lightbulb',     label: t('experience.intelligence.askBar.chipCsat'),    q: t('experience.intelligence.askBar.queryCsat') },
        { icon: 'compare',       label: t('experience.intelligence.askBar.chipCompare'), q: t('experience.intelligence.askBar.queryCompare') },
      ];

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, delay: 0.25 }}
    >
      <GlassCard className="p-5 holographic">
        <div className="flex items-center gap-3 mb-3 relative z-10">
          <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
            style={{ background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))' }}>
            <Icon name="psychology" size={20} style={{ color: 'white' }} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[10px] font-black uppercase tracking-widest text-tertiary mb-0.5">{t('experience.intelligence.askBar.label')}</div>
            <form onSubmit={(e) => { e.preventDefault(); if (query.trim()) { onAsk(query); setQuery(''); } }}
              className="flex items-center gap-2">
              <input type="text" value={query} onChange={(e) => setQuery(e.target.value)}
                placeholder={t('experience.intelligence.askBar.placeholder')}
                className="flex-1 text-sm bg-transparent focus:outline-none placeholder:text-on-surface-variant/50 text-on-surface" />
              <Button type="submit" size="sm"
                className="text-xs font-bold text-white border-0 flex-shrink-0"
                style={{ background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))' }}>
                <Icon name="arrow_upward" size={14} /> {t('experience.intelligence.askBar.submit')}
              </Button>
            </form>
          </div>
          <kbd className="px-2 py-1 rounded bg-white/70 border border-outline-variant/30 text-xs font-bold flex-shrink-0">{t('experience.intelligence.askBar.kbd')}</kbd>
        </div>
        <div className="flex flex-wrap gap-2 relative z-10">
          {chips.map((c) => (
            <button key={c.label} onClick={() => onAsk(c.q)}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold bg-surface-container hover:bg-surface-container-high transition-colors">
              <Icon name={c.icon} size={11} style={{ color: 'var(--color-primary)' }} />
              {c.label}
            </button>
          ))}
        </div>
      </GlassCard>
    </motion.div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// § 9  TRUST FOOTER (Cockpit trust panel)
// ══════════════════════════════════════════════════════════════════════════════
function TrustFooter({
  insights, avgTrust, lastGenerated, resCount,
}: {
  insights: AgenticInsight[]; avgTrust: number | null; lastGenerated: string | null; resCount: number;
}) {
  const { t }      = useTranslation();
  const verified   = insights.filter((i) => i.audit_json?.verifier_pass).length;
  const reliable   = insights.filter((i) => i.trust_score >= 80).length;
  const citedTotal = insights.reduce((s, i) => s + i.citations_json.length, 0);
  const lastScan   = lastGenerated ? new Date(lastGenerated).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

  return (
    <motion.footer
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4, delay: 0.3 }}
      className="flex items-center justify-center gap-6 flex-wrap py-3 border-t border-outline-variant/20 text-xs text-on-surface-variant"
    >
      <span className="flex items-center gap-1.5">
        <span className="w-2 h-2 rounded-full bg-emerald-500" style={{ animation: 'pulse-glow 2.5s ease-in-out infinite' }} />
        <span className="font-bold">{t('experience.intelligence.trust.live')}</span>
        {' '}·{' '}{t('experience.intelligence.trust.lastScan', { time: lastScan })}
      </span>
      <span>·</span>
      <span>{t('experience.intelligence.trust.validity')}{' '}<strong className="text-emerald-600">{t('experience.intelligence.trust.verified', { n: String(verified), total: String(insights.length) })}</strong></span>
      <span>·</span>
      <span>{t('experience.intelligence.trust.reliable', { n: String(reliable) })}</span>
      <span>·</span>
      <span>{t('experience.intelligence.trust.cited', { n: String(citedTotal), total: resCount.toLocaleString() })}</span>
      {avgTrust != null && (
        <>
          <span>·</span>
          <span>{t('experience.intelligence.trust.avgTrust')}{' '}<strong className={avgTrust >= 80 ? 'text-emerald-600' : avgTrust >= 60 ? 'text-amber-600' : 'text-on-surface-variant'}>{avgTrust}/100</strong></span>
        </>
      )}
    </motion.footer>
  );
}

// ── Mini sparkline ─────────────────────────────────────────────────────────────
function MiniSparkline({ points }: { points: number[] }) {
  const valid = points.filter((v) => typeof v === 'number' && isFinite(v));
  if (valid.length < 2) return null;
  const W = 200, H = 40;
  const min = Math.min(...valid) - 1, max = Math.max(...valid) + 1, range = max - min || 1;
  const xs = valid.map((_, i) => (i / (valid.length - 1)) * W);
  const ys = valid.map((v) => H - ((v - min) / range) * H * 0.85 - H * 0.08);
  const d  = xs.map((x, i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${ys[i].toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-10 mt-3">
      <defs>
        <linearGradient id="spark-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--color-primary)" stopOpacity="0.25" />
          <stop offset="1" stopColor="var(--color-primary)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${d} L${W},${H} L0,${H} Z`} fill="url(#spark-fill)" />
      <path d={d} stroke="var(--color-primary)" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ── Survey status badge (paused / closed / draft) ─────────────────────────────
function SurveyStatusBadge({ status }: { status: string }) {
  const { t } = useTranslation();
  const cfg =
    status === 'paused' ? { bg: '#fef3c7', border: '#fbbf24', color: '#92400e', icon: 'pause_circle',  label: t('experience.intelligence.status.paused') } :
    status === 'closed' ? { bg: '#f1f5f9', border: '#94a3b8', color: '#475569', icon: 'lock',          label: t('experience.intelligence.status.closed') } :
                          { bg: '#f0fdf4', border: '#86efac', color: '#166534', icon: 'drafts',        label: t('experience.intelligence.status.draft') };
  return (
    <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl border text-xs font-semibold"
      style={{ background: cfg.bg, borderColor: cfg.border, color: cfg.color }}>
      <Icon name={cfg.icon} size={14} />{cfg.label}
    </div>
  );
}

// ── Tier progression banner ────────────────────────────────────────────────────
type Tier = 'collecting' | 'first_voices' | 'early_signals' | 'growing_picture' | 'full_report';

// Visual-only config — text strings resolved via t() inside TierBanner
const TIER_VISUAL: Record<Exclude<Tier, 'full_report'>, {
  iconColor: string; icon: string; showGenerate: boolean; responseGoal: number | null;
}> = {
  collecting:      { iconColor: '#94a3b8', icon: 'hourglass_top', showGenerate: false, responseGoal: 10  },
  first_voices:    { iconColor: 'var(--color-primary)', icon: 'hearing',        showGenerate: true,  responseGoal: 40  },
  early_signals:   { iconColor: 'var(--color-tertiary)', icon: 'sensors',        showGenerate: true,  responseGoal: 70  },
  growing_picture: { iconColor: '#059669', icon: 'bar_chart',      showGenerate: true,  responseGoal: 100 },
};

function TierBanner({
  tier, resCount, onGenerate, isGenerating, surveyStatus,
}: {
  tier: Exclude<Tier, 'full_report'>; resCount: number;
  onGenerate: () => void; isGenerating: boolean; surveyStatus: string;
}) {
  const { t } = useTranslation();
  const visual = TIER_VISUAL[tier];
  const meta   = {
    ...visual,
    headline: t(`experience.intelligence.tierBanner.${tier}.headline`),
    sub:      t(`experience.intelligence.tierBanner.${tier}.body`),
  };
  const goal  = meta.responseGoal;
  const pct   = goal ? Math.min(100, Math.round((resCount / goal) * 100)) : 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="flex items-center gap-4 px-5 py-3.5 rounded-2xl border flex-wrap"
      style={{ background: `color-mix(in srgb, ${meta.iconColor} 3%, transparent)`, borderColor: `color-mix(in srgb, ${meta.iconColor} 13%, transparent)` }}
    >
      <ProgressArc tier={tier} responseCount={resCount} size="sm" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-bold text-on-surface">{meta.headline}</span>
          <span className="text-[10px] font-mono text-on-surface-variant">
            {resCount.toLocaleString()} {t('common.responses')}{goal ? ` · ${t('experience.intelligence.tierBanner.goal', { n: String(goal) })}` : ''}
          </span>
        </div>
        <p className="text-xs text-on-surface-variant mt-0.5 max-w-xl">{meta.sub}</p>
        {goal && (
          <div className="mt-2 h-1 rounded-full bg-outline-variant/20 max-w-xs overflow-hidden">
            <div className="h-full rounded-full transition-all duration-700"
              style={{ width: `${pct}%`, background: `linear-gradient(to right, ${meta.iconColor}, color-mix(in srgb, ${meta.iconColor} 60%, transparent))` }} />
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        {meta.showGenerate && surveyStatus !== 'closed' && (
          <Button size="sm" onClick={onGenerate} disabled={isGenerating}
            className="text-xs font-bold text-white border-0"
            style={{ background: `linear-gradient(135deg, ${meta.iconColor}, var(--color-tertiary))` }}>
            {isGenerating
              ? <span className="w-3 h-3 rounded-full border-2 border-white/30 border-t-white animate-spin" />
              : <Icon name="auto_awesome" size={13} />}
            {isGenerating ? t('experience.intelligence.generate.generating') : t('experience.intelligence.tierBanner.generate')}
          </Button>
        )}
        {tier === 'collecting' && (
          <Link to={ROUTES.RESPONDENTS}>
            <Button size="sm" variant="outline" className="text-xs font-bold">
              <Icon name="share" size={13} /> {t('experience.intelligence.tierBanner.share')}
            </Button>
          </Link>
        )}
      </div>
    </motion.div>
  );
}
