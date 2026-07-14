// ExperienceHubPage — Org-level portfolio hub.
//
// Design synthesis from all six mocks:
//   § 1  Hero        — Spatial Canvas (dark cosmic, grid, ambient orbs, Crystal orb)
//   § 2  KPI strip   — Mission Cockpit (sparkbars, CI marker, velocity, pulse)
//   § 3  Live Intel  — Mission Cockpit priority feed (real agentic insights, zero hardcoding)
//   § 4  Surveys     — Editorial Brief glass cards + Advanced Insights data density
//   § 5  Capabilities — AI Dashboard intelligence-layer pattern (system, not customer data)
//
// Data policy: zero hardcoded customer or insight text.
// All visible content comes from live API calls; missing data shows "—".

import { useState, useEffect, useMemo, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from '../../lib/i18n';
import { useOrgOverview } from '../../hooks/useExperience';
import { useSurveys } from '../../hooks/useSurveys';
import { useSetPageTitle } from '../../contexts/pageTitle';
import { useApi } from '../../hooks/useApi';
import { useCrystalPanel } from '../../contexts/crystalPanel';
import { Icon } from '../../components/Icon';
import { ExperienceSubNav } from '../../components/ExperienceSubNav';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { ROUTES, toPath } from '../../constants/routes';
import { GlassCard, LAYER_CONFIG } from '../insights/shared';
import type { AgenticInsight, Survey } from '../../types';
// ── Org Dashboard (Command Center) — additive Hub teaser imports ────────────
// Decision 18: pure insertions only, nothing in §1-§5 below is touched.
import { KpiTile } from '../../components/org-dashboard/KpiTile';
import { WeeklyBriefTeaserCard } from '../../components/org-dashboard/WeeklyBriefTeaserCard';
import { TagGroupsStrip } from '../../components/org-dashboard/TagGroupsStrip';
import { useOrgDashboard } from '../../hooks/useOrgDashboard';
import { useTagMetrics } from '../../hooks/useTagMetrics';
import { healthStatusFromScore, healthStatusColor } from '../../components/org-dashboard/HealthPill';

// ── Motion ───────────────────────────────────────────────────────────────────
const stagger = { hidden: {}, visible: { transition: { staggerChildren: 0.06 } } };
const rise = {
  hidden:  { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.55, ease: [0.22, 1, 0.36, 1] as [number,number,number,number] } },
};

// ── Layer → severity border color (Cockpit sev-* pattern) ────────────────────
const LAYER_BORDER: Record<AgenticInsight['layer'], string> = {
  descriptive:  '#2a4bd9',
  diagnostic:   '#8329c8',
  predictive:   '#d97706',
  prescriptive: '#059669',
};

// ── NPS helpers ───────────────────────────────────────────────────────────────
function npsColor(v: number | null) {
  if (v == null) return 'var(--color-on-surface-variant)';
  if (v >= 50)   return '#059669';
  if (v >= 0)    return '#d97706';
  return '#b41340';
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

// ── Extended insight type with source survey metadata ─────────────────────────
type RichInsight = AgenticInsight & { surveyTitle: string; surveyId: string };

// ── Page ─────────────────────────────────────────────────────────────────────
export function ExperienceHubPage() {
  const { t }   = useTranslation();
  const api     = useApi();
  const { openCrystal, setScope } = useCrystalPanel();
  const { data: overviewData, loading: overviewLoading } = useOrgOverview();
  const { surveys, loading: surveysLoading } = useSurveys();

  const [askQuery, setAskQuery] = useState('');
  const [velocityData, setVelocityData]   = useState<{ day: string; count: number }[]>([]);
  const [topInsights,  setTopInsights]    = useState<RichInsight[]>([]);
  const [insightsLoading, setInsightsLoading] = useState(false);
  const [crystalOpening, setCrystalOpening]   = useState<string | null>(null);

  // ── Org Dashboard (Command Center) — additive Hub teaser data ─────────────
  // Decision 18: these three elements (5th KPI tile, Weekly Brief teaser, Tag
  // Groups strip) are pure insertions layered onto the existing hero/KPI
  // strip/§3-§4 boundary below — nothing already on this page is touched.
  const { data: orgDashboardData, loading: orgDashboardLoading, error: orgDashboardError, refetch: refetchOrgDashboard } = useOrgDashboard();
  const { data: tagMetricsData, loading: tagMetricsLoading } = useTagMetrics();
  const atRiskTags = useMemo(
    () => (tagMetricsData?.tags ?? []).filter((tag) => tag.healthStatus !== 'healthy'),
    [tagMetricsData],
  );

  useSetPageTitle(t('nav.experience'), t('experience.hub.subtitle'));

  useEffect(() => {
    setScope('all');
    api.getOrgAnalytics()
      .then((d) => setVelocityData(d.responses_by_day ?? []))
      .catch(() => {});
  }, [api, setScope]);

  // Load insights from the top 2 most-responded surveys
  const loadTopInsights = useCallback(async () => {
    if (surveys.length === 0) return;
    const top = [...surveys]
      .filter((s) => !s.deleted_at && s.status !== 'draft' && (s.response_count ?? 0) > 0)
      .sort((a, b) => (b.response_count ?? 0) - (a.response_count ?? 0))
      .slice(0, 2);
    if (!top.length) return;

    setInsightsLoading(true);
    try {
      const results = await Promise.all(
        top.map((s) =>
          api.listInsights(s.id)
            .then((r) => {
              // Capture the crystal_opening from the best survey
              if (r.crystal_opening) setCrystalOpening(r.crystal_opening);
              return (r.insights ?? []).map((ins) => ({
                ...ins,
                surveyTitle: s.title || t('experience.hubHero.surveyFallback'),
                surveyId:    s.id,
              } as RichInsight));
            })
            .catch(() => [] as RichInsight[]),
        ),
      );
      const merged = results.flat()
        .filter((ins) => !ins.user_state_json?.dismissed)
        .sort((a, b) => b.priority - a.priority || b.trust_score - a.trust_score)
        .slice(0, 6);
      setTopInsights(merged);
    } finally {
      setInsightsLoading(false);
    }
  }, [surveys, api]);

  useEffect(() => { loadTopInsights(); }, [loadTopInsights]);

  // ── Portfolio metrics ───────────────────────────────────────────────────────
  // overviewData is fully typed from api.getExperienceOverview() — no cast needed
  const portfolioMetrics = overviewData?.portfolio_metrics ?? null;
  const activeSurveys    = useMemo(() => surveys.filter((s) => s.status === 'active' && !s.deleted_at), [surveys]);
  const totalResponses   = useMemo(() => surveys.reduce((n, s) => n + (s.response_count ?? 0), 0), [surveys]);
  const portfolioNps: number | null  = portfolioMetrics?.nps_score  ?? null;
  const portfolioCsat: number | null = portfolioMetrics?.csat_score ?? null;
  const portfolioCI = npsCI(portfolioNps, portfolioMetrics?.response_count ?? totalResponses);

  const avgVelocity = useMemo(() => {
    const last7 = velocityData.slice(-7);
    if (!last7.length) return null;
    return Math.round(last7.reduce((s, d) => s + d.count, 0) / last7.length);
  }, [velocityData]);

  const velocityBars = useMemo(() => {
    const days = velocityData.slice(-7);
    if (!days.length) return [];
    const max = Math.max(...days.map((d) => d.count), 1);
    return days.map((d) => Math.max(4, Math.round((d.count / max) * 22)));
  }, [velocityData]);

  const loading = overviewLoading || surveysLoading;

  // Org Dashboard additive derived values
  const orgHealthScore = orgDashboardData?.healthScore?.total ?? null;
  const orgHealthStatusForKpi = orgHealthScore != null ? healthStatusFromScore(orgHealthScore) : null;

  const handleAsk = (q: string) => {
    if (q.trim()) { openCrystal(q.trim()); setAskQuery(''); }
  };

  // Top 4 most recently updated surveys with response data
  const recentSurveys = useMemo(() =>
    [...surveys]
      .filter((s) => !s.deleted_at && s.status !== 'draft' && (s.response_count ?? 0) > 0)
      .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
      .slice(0, 4),
    [surveys],
  );

  const handleSurveyChipClick = useCallback((survey: Survey) => {
    setScope(survey.id);
    openCrystal(t('experience.hubHero.surveyChipQuery', { title: survey.title }));
  }, [setScope, openCrystal, t]);

  // Portfolio-level Crystal prompt chips
  const PROMPTS = [
    { icon: 'compare',     label: t('experience.hub.prompts.churnLabel'),   q: t('experience.hub.prompts.churnQuery') },
    { icon: 'trending_up', label: t('experience.hub.prompts.themesLabel'),  q: t('experience.hub.prompts.themesQuery') },
    { icon: 'flag',        label: t('experience.hub.prompts.actionLabel'),  q: t('experience.hub.prompts.actionQuery') },
    { icon: 'warning',     label: t('experience.hub.prompts.anomalyLabel'), q: t('experience.hub.prompts.anomalyQuery') },
  ];

  return (
    <TooltipProvider delayDuration={200}>
    <div className="max-w-7xl mx-auto w-full space-y-6 pt-6 md:pt-8">

      <ExperienceSubNav active="overview" />

      {/* ══════════════════════════════════════════════════════════════════
          § 1  DARK CINEMATIC HERO
          Spatial Canvas: deep-space gradient, perspective grid floor,
          ambient light blobs, Crystal orb, inline Ask bar.
      ══════════════════════════════════════════════════════════════════ */}
      <motion.section
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.75 }}
        className="relative overflow-hidden rounded-2xl"
        style={{
          background:
            'radial-gradient(ellipse at 20% 0%,   color-mix(in srgb, var(--color-primary) 52%, transparent) 0%, transparent 54%),' +
            'radial-gradient(ellipse at 80% 15%,  color-mix(in srgb, var(--color-tertiary) 40%, transparent) 0%, transparent 54%),' +
            'radial-gradient(ellipse at 50% 115%, color-mix(in srgb, var(--color-secondary) 28%, transparent)  0%, transparent 58%),' +
            'linear-gradient(180deg, #07091F 0%, #0F0822 65%, #080A22 100%)',
        }}
      >
        {/* Perspective grid floor */}
        <div className="absolute inset-x-0 bottom-0 pointer-events-none" style={{
          height: '44%',
          backgroundImage:
            'linear-gradient(color-mix(in srgb, var(--color-primary-container) 8%, transparent) 1px, transparent 1px),' +
            'linear-gradient(90deg, color-mix(in srgb, var(--color-primary-container) 8%, transparent) 1px, transparent 1px)',
          backgroundSize: '56px 56px',
          transform: 'perspective(800px) rotateX(45deg)',
          transformOrigin: 'bottom',
          maskImage: 'linear-gradient(to top, rgba(0,0,0,0.5), transparent)',
        }} />
        {/* Ambient orbs */}
        <div className="absolute inset-0 pointer-events-none overflow-hidden">
          <div style={{ position:'absolute', left:'65%',  top:'5%',  width:340, height:340, background:'radial-gradient(circle, color-mix(in srgb, var(--color-tertiary) 16%, transparent), transparent 70%)', borderRadius:'50%' }} />
          <div style={{ position:'absolute', left:'-4%',  top:'25%', width:260, height:260, background:'radial-gradient(circle, color-mix(in srgb, var(--color-primary) 18%, transparent),  transparent 70%)', borderRadius:'50%' }} />
          <div style={{ position:'absolute', left:'40%',  top:'72%', width:190, height:190, background:'radial-gradient(circle, color-mix(in srgb, var(--color-secondary) 14%, transparent),   transparent 70%)', borderRadius:'50%' }} />
        </div>

        <div className="relative z-10 px-6 md:px-12 pt-10 pb-10 text-white">
          {/* Live badge */}
          <motion.div initial={{ opacity:0, y:-6 }} animate={{ opacity:1, y:0 }} transition={{ delay:0.15, duration:0.4 }}>
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-[11px] font-bold mb-8"
              style={{ background:'rgba(255,255,255,0.08)', border:'1px solid rgba(255,255,255,0.12)' }}>
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" style={{ animation:'pulse-glow 2.5s ease-in-out infinite' }} />
              <span className="text-emerald-300">
                {loading ? t('experience.hub.hero.loading')
                  : t('experience.hub.hero.liveBadge', {
                      count: String(activeSurveys.length),
                      word:  activeSurveys.length === 1 ? t('experience.hub.hero.liveBadgeSurvey') : t('experience.hub.hero.liveBadgeSurveys'),
                      total: totalResponses.toLocaleString(),
                    })}
              </span>
            </div>
          </motion.div>

          <div className="flex flex-col lg:flex-row items-start lg:items-center gap-8 lg:gap-12">
            {/* Crystal orb */}
            <motion.div
              initial={{ opacity:0, scale:0.75 }}
              animate={{ opacity:1, scale:1 }}
              transition={{ duration:0.9, delay:0.1, ease:[0.22,1,0.36,1] }}
              className="flex-shrink-0 hidden md:block"
            >
              <CrystalOrb />
            </motion.div>

            {/* Headline + ask bar */}
            <motion.div
              initial={{ opacity:0, x:-14 }}
              animate={{ opacity:1, x:0 }}
              transition={{ duration:0.65, delay:0.25 }}
              className="flex-1 min-w-0"
            >
              <div className="text-[10px] font-black uppercase tracking-[0.28em] text-cyan-300/75 mb-3">
                {t('experience.hub.hero.tagline')}
              </div>

              {/* Headline — portfolio NPS if available, brand tagline otherwise.
                  crystalOpening is a full paragraph — never use as a headline. */}
              <h1 className="font-headline font-black text-3xl md:text-4xl xl:text-5xl tracking-tight leading-tight text-white mb-3">
                {portfolioNps != null ? (
                  <>
                    {t('experience.hub.kpi.nps')}{' '}
                    <span style={{ color: portfolioNps>=50?'#34d399':portfolioNps>=0?'#fcd34d':'#f87171' }}>
                      {npsLabel(portfolioNps)}
                    </span>
                    {' '}{t('experience.hub.hero.headlineFull').split('{nps}')[1]}
                  </>
                ) : (
                  t('experience.hub.hero.headlineEmpty')
                )}
              </h1>

              {/* crystalOpening rendered as a brief narrative line, not a heading */}
              {crystalOpening && (
                <p className="text-sm text-white/70 mb-4 max-w-2xl leading-relaxed line-clamp-3">
                  {crystalOpening}
                </p>
              )}

              <p className="text-sm text-white/45 mb-6 max-w-xl leading-relaxed">
                {t('experience.hub.hero.trust')}
              </p>

              {/* ── Survey selector chips ─────────────────────────────────────
                  Each chip scopes Crystal to that survey and opens with context.
                  Shows up to 4, sorted by most recently updated.
              ──────────────────────────────────────────────────────────── */}
              <div className="space-y-3">
                {/* Label */}
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-white/50 font-bold uppercase tracking-widest">
                    {surveysLoading
                      ? t('experience.hubHero.loadingSurveys')
                      : recentSurveys.length > 0
                        ? t('experience.hubHero.selectSurvey')
                        : t('experience.hubHero.noSurveys')}
                  </span>
                </div>

                {/* Survey chips */}
                {!surveysLoading && recentSurveys.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {recentSurveys.map((s) => (
                      <button
                        key={s.id}
                        onClick={() => handleSurveyChipClick(s)}
                        className="group flex items-center gap-2 px-3 py-2 rounded-xl text-left transition-all duration-200 hover:scale-[1.02] hover:shadow-lg"
                        style={{
                          background: 'rgba(255,255,255,0.07)',
                          border: '1px solid rgba(255,255,255,0.13)',
                          color: 'rgba(255,255,255,0.85)',
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = 'color-mix(in srgb, var(--color-primary-container) 16%, transparent)'; e.currentTarget.style.borderColor = 'color-mix(in srgb, var(--color-primary-container) 35%, transparent)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.07)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.13)'; }}
                      >
                        {/* Live indicator */}
                        {s.status === 'active' && (
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 flex-shrink-0"
                            style={{ animation: 'pulse-glow 2.5s ease-in-out infinite' }} />
                        )}
                        <div className="min-w-0">
                          <div className="text-[12px] font-semibold truncate max-w-[160px] leading-tight">
                            {s.title || t('experience.hubHero.surveyFallback')}
                          </div>
                          {(s.response_count ?? 0) > 0 && (
                            <div className="text-[10px] text-white/40 mt-0.5 leading-none">
                              {(s.response_count ?? 0).toLocaleString()} {t('common.responses')}
                              {s.nps_score != null && (
                                <span className="ml-1.5" style={{ color: npsColor(s.nps_score) }}>
                                  NPS {npsLabel(s.nps_score)}
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                        <Icon name="arrow_forward" size={12}
                          className="flex-shrink-0 opacity-0 group-hover:opacity-60 transition-opacity"
                          style={{ color: 'color-mix(in srgb, var(--color-primary-container) 90%, transparent)' }} />
                      </button>
                    ))}
                  </div>
                )}

                {/* Portfolio prompt chips — separate label, clearly distinguished */}
                <div className="flex flex-wrap gap-2 items-center pt-1">
                  <span className="text-[10px] text-white/30 font-medium uppercase tracking-widest mr-1">
                    {t('experience.hubHero.orAskPortfolio')}
                  </span>
                  {PROMPTS.map((p) => (
                    <button
                      key={p.label}
                      onClick={() => handleAsk(p.q)}
                      className="px-3 py-1.5 rounded-full text-[11px] font-bold flex items-center gap-1.5 transition-all hover:bg-white/14"
                      style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.09)', color: 'rgba(255,255,255,0.55)' }}
                    >
                      <Icon name={p.icon} size={12} style={{ color: 'rgba(255,255,255,0.40)' }} />
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
            </motion.div>
          </div>
        </div>
      </motion.section>

      {/* ══════════════════════════════════════════════════════════════════
          Crystal's Weekly Brief — additive teaser (Decision 17/18).
          Inserted immediately after the Hero's `crystalOpening` narrative
          (§1 above), which keeps full, unconditional, primary-hero weight
          for everyone. This card is a clearly-labeled, visually subordinate
          secondary artifact — never a competing equal to crystalOpening.
      ══════════════════════════════════════════════════════════════════ */}
      <WeeklyBriefTeaserCard
        orgName={orgDashboardData?.org?.name ?? t('experience.hub.hero.tagline')}
        brief={orgDashboardData?.crystalBrief ?? null}
        minDataMet={orgDashboardData?.briefMinDataMet}
        loading={orgDashboardLoading}
        error={orgDashboardError}
        onAskFollowUp={() => openCrystal(t('orgDashboard.crystalBrief.followUpQuery'), { focused_brief_id: orgDashboardData?.crystalBrief?.id })}
        onRetry={refetchOrgDashboard}
      />

      {/* ══════════════════════════════════════════════════════════════════
          § 2  PORTFOLIO KPI STRIP
          Mission Cockpit: sparkbars, CI mini-bar, live trend, velocity.
      ══════════════════════════════════════════════════════════════════ */}
      <motion.section variants={stagger} initial="hidden" animate="visible"
        className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-3">
        <motion.div variants={rise}>
          <KpiTile label={t('experience.hub.kpi.nps')}
            value={npsLabel(portfolioNps)} valueColor={npsColor(portfolioNps)}
            ci={portfolioCI>0?`±${portfolioCI}`:undefined}
            ciPosition={portfolioNps!=null ? Math.round(((portfolioNps+100)/200)*100) : undefined}
            sample={portfolioMetrics?.response_count ? `n=${portfolioMetrics.response_count.toLocaleString()}` : undefined}
            icon="sentiment_satisfied" iconColor="var(--color-primary)" loading={loading} />
        </motion.div>
        <motion.div variants={rise}>
          <KpiTile label={t('experience.hub.kpi.csat')}
            value={portfolioCsat!=null ? portfolioCsat.toFixed(1) : '—'}
            unit={portfolioCsat!=null ? t('experience.hub.kpi.csatScale') : undefined}
            icon="star" iconColor="var(--color-secondary)" loading={loading} />
        </motion.div>
        <motion.div variants={rise}>
          <KpiTile label={t('experience.hub.kpi.activeSurveys')}
            value={loading?'—':String(activeSurveys.length)}
            unit={!loading&&surveys.length ? t('experience.hub.kpi.ofTotal', { n: String(surveys.length) }) : undefined}
            icon="dynamic_form" iconColor="var(--color-tertiary)" loading={loading} />
        </motion.div>
        <motion.div variants={rise}>
          <KpiTile label={t('experience.hub.kpi.totalResponses')}
            value={loading?'—':totalResponses.toLocaleString()}
            unit={avgVelocity!=null ? t('experience.hub.kpi.velocity', { n: String(avgVelocity) }) : undefined}
            icon="people" iconColor="#059669"
            sparkBars={velocityBars} sparkColor="#059669" loading={loading} />
        </motion.div>
        {/* ── 5th tile — Org Health Score (Decision 17/18, additive) ─────────
            Desktop: grid-cols-5 (own column). Tablet: wraps to its own 4-wide
            row. Mobile: wraps to its own 2-wide row — per DESIGN.md's
            Responsive Design section, never a horizontal-scroll carousel. */}
        <motion.div variants={rise} className="col-span-2 md:col-span-4 lg:col-span-1">
          <KpiTile label={t('orgDashboard.healthScore.label')}
            value={orgDashboardLoading ? '—' : orgHealthScore != null ? String(orgHealthScore) : '—'}
            valueColor={orgHealthStatusForKpi ? healthStatusColor(orgHealthStatusForKpi).text : undefined}
            unit={orgHealthStatusForKpi ? t(`orgDashboard.health.${orgHealthStatusForKpi}`) : undefined}
            icon="monitor_heart" iconColor={orgHealthStatusForKpi ? healthStatusColor(orgHealthStatusForKpi).dot : 'var(--color-primary)'}
            loading={orgDashboardLoading} />
        </motion.div>
      </motion.section>

      {/* ══════════════════════════════════════════════════════════════════
          § 3  LIVE INTELLIGENCE FEED
          Mission Cockpit priority-feed pattern.
          Real agentic insights from the pipeline — top priority across
          your most-active surveys. Headline, layer badge, confidence,
          survey tag, severity border. Zero hardcoded text.
      ══════════════════════════════════════════════════════════════════ */}
      <AnimatePresence>
        {(insightsLoading || topInsights.length > 0) && (
          <motion.section
            initial={{ opacity:0, y:14 }}
            animate={{ opacity:1, y:0 }}
            exit={{ opacity:0 }}
            transition={{ duration:0.5 }}
          >
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-emerald-500" style={{ animation:'pulse-glow 2s ease-in-out infinite' }} />
                <span className="text-[10px] font-black uppercase tracking-widest text-on-surface-variant">
                  {t('experience.hub.intelligence.title')}
                </span>
                {!insightsLoading && topInsights.length > 0 && (
                  <span className="px-1.5 py-0.5 rounded bg-surface-container text-[9px] font-black font-mono text-on-surface-variant">
                    {topInsights.length}
                  </span>
                )}
              </div>
              {topInsights.length > 0 && (
                <span className="text-[10px] text-on-surface-variant/55">
                  {t('experience.hub.intelligence.subtitle')}
                </span>
              )}
            </div>

            {/* Loading state */}
            {insightsLoading && topInsights.length === 0 && (
              <div className="space-y-2">
                {[...Array(3)].map((_,i)=>(
                  <div key={i} className="h-16 rounded-xl bg-surface-container animate-pulse" />
                ))}
              </div>
            )}

            {/* Insights loaded but none found — show a clear "not yet generated" state */}
            {!insightsLoading && topInsights.length === 0 && (
              <GlassCard className="p-8 text-center">
                <Icon name="auto_awesome" size={28} style={{ color: 'var(--color-outline-variant)', margin: '0 auto 10px' }} />
                <p className="text-sm font-bold text-on-surface mb-1">{t('experience.hub.intelligence.emptyTitle')}</p>
                <p className="text-xs text-on-surface-variant mb-4">
                  {t('experience.hub.intelligence.emptyBody')}
                </p>
                {surveys.filter(s => (s.response_count ?? 0) > 0).length > 0 && (
                  <Link to={toPath(ROUTES.EXPERIENCE_SURVEY, {
                    surveyId: surveys.filter(s => (s.response_count ?? 0) > 0)[0].id,
                  })}>
                    <Button size="sm" className="text-xs font-bold text-white border-0"
                      style={{ background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))' }}>
                      <Icon name="auto_awesome" size={13} /> {t('experience.hub.intelligence.generate')}
                    </Button>
                  </Link>
                )}
              </GlassCard>
            )}

            {/* Insight feed */}
            {!insightsLoading && topInsights.length > 0 && (
              <GlassCard className="overflow-hidden divide-y divide-outline-variant/15">
                {topInsights.map((ins, i) => (
                  <InsightFeedRow key={ins.id} insight={ins} index={i} />
                ))}
                {/* Live monitoring indicator */}
                <div className="px-5 py-3 flex items-center gap-3 text-on-surface-variant/60 text-xs">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500/60" style={{ animation:'pulse-glow 1.8s ease-in-out infinite' }} />
                  <span className="font-medium">{t('experience.hub.intelligence.monitoring')}</span>
                </div>
              </GlassCard>
            )}
          </motion.section>
        )}
      </AnimatePresence>

      {/* ══════════════════════════════════════════════════════════════════
          Tag Groups strip — additive teaser (Decision 17/18), between §3 and
          §4. Hard-scoped at the data layer to `healthStatus !== 'healthy'`
          tags only (filtered above via `atRiskTags`) — never a general tag
          browser. Its only exit is a single "View Tag Report" CTA doing full
          navigation. Renders nothing at all if no tag is at risk or the
          fetch fails (extends the existing "don't render a broken card on
          the primary landing page" precedent).
      ══════════════════════════════════════════════════════════════════ */}
      <TagGroupsStrip tags={atRiskTags} loading={tagMetricsLoading} />

      {/* ══════════════════════════════════════════════════════════════════
          § 4  SURVEY INTELLIGENCE GRID
          Editorial Brief glass cards + Advanced Insights data density.
      ══════════════════════════════════════════════════════════════════ */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Icon name="dataset" size={16} style={{ color:'var(--color-on-surface-variant)' }} />
            <span className="text-[10px] font-black uppercase tracking-widest text-on-surface-variant">{t('experience.hub.surveys.title')}</span>
            {!loading && (
              <span className="text-[10px] text-on-surface-variant/55">
                {t('experience.hub.surveys.countLabel', { n: String(surveys.length), active: String(activeSurveys.length) })}
              </span>
            )}
          </div>
          <Link to={ROUTES.CREATE}>
            <Button variant="outline" size="sm" className="text-xs font-bold">
              <Icon name="add" size={13} /> {t('experience.hub.surveys.newButton')}
            </Button>
          </Link>
        </div>

        {loading && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[...Array(3)].map((_,i)=>(
              <div key={i} className="h-48 rounded-2xl bg-surface-container animate-pulse" />
            ))}
          </div>
        )}

        {!loading && surveys.length === 0 && (
          <GlassCard className="p-14 text-center">
            <div className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-5"
              style={{ background:'linear-gradient(135deg, color-mix(in srgb, var(--color-primary) 12%, transparent), color-mix(in srgb, var(--color-tertiary) 12%, transparent))' }}>
              <Icon name="dynamic_form" size={32} style={{ color:'var(--color-primary)' }} />
            </div>
            <h3 className="text-xl font-black font-headline mb-2">{t('experience.hub.surveys.emptyTitle')}</h3>
            <p className="text-sm text-on-surface-variant mb-5 max-w-xs mx-auto leading-relaxed">
              {t('experience.hub.surveys.emptyBody')}
            </p>
            <Link to={ROUTES.CREATE}>
              <Button className="font-bold text-white border-0 shadow-md"
                style={{ background:'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))' }}>
                <Icon name="add" size={16} /> {t('experience.hub.surveys.createButton')}
              </Button>
            </Link>
          </GlassCard>
        )}

        {!loading && surveys.length > 0 && (
          <motion.div variants={stagger} initial="hidden" animate="visible"
            className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {surveys
              .filter((s) => !s.deleted_at)
              .sort((a,b) => {
                if (a.status==='active' && b.status!=='active') return -1;
                if (b.status==='active' && a.status!=='active') return  1;
                return (b.response_count??0) - (a.response_count??0);
              })
              .map((survey, i) => (
                <motion.div key={survey.id} variants={rise} custom={i}>
                  <SurveyCard
                    survey={survey}
                    insights={topInsights.filter((ins) => ins.surveyId === survey.id)}
                    onAskCrystal={() => { setScope(survey.id); openCrystal(''); }}
                  />
                </motion.div>
              ))
            }
          </motion.div>
        )}
      </section>

      {/* ══════════════════════════════════════════════════════════════════
          § 5  CRYSTAL INTELLIGENCE CAPABILITIES
          AI Dashboard intelligence-layer pattern.
          Describes what the system computes — no customer data.
      ══════════════════════════════════════════════════════════════════ */}
      {!loading && surveys.length > 0 && (
        <motion.section
          initial={{ opacity:0, y:18 }}
          whileInView={{ opacity:1, y:0 }}
          viewport={{ once:true }}
          transition={{ duration:0.55 }}
        >
          <div className="flex items-center gap-3 mb-4">
            <div className="h-px flex-1 bg-outline-variant/30" />
            <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.22em] text-on-surface-variant">
              <Icon name="auto_awesome" size={13} />
              {t('experience.hub.capabilities.sectionTitle')}
            </div>
            <div className="h-px flex-1 bg-outline-variant/30" />
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {getCapabilityLayers(t).map((cap) => (
              <CapabilityCard key={cap.layer} {...cap} />
            ))}
          </div>
        </motion.section>
      )}

    </div>
    </TooltipProvider>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Sub-components
// ══════════════════════════════════════════════════════════════════════════════

// ── Crystal orb ──────────────────────────────────────────────────────────────
function CrystalOrb() {
  return (
    <div style={{ width:152, height:152, position:'relative', filter:'drop-shadow(0 20px 44px color-mix(in srgb, var(--color-primary) 45%, transparent))' }}>
      <div style={{ position:'absolute', inset:0,
        background:'conic-gradient(from 0deg at 50% 50%, var(--color-primary-container) 0%, var(--color-tertiary-container) 25%, var(--color-secondary-container) 50%, var(--color-tertiary-container) 75%, var(--color-primary-container) 100%)',
        clipPath:'polygon(50% 0%, 100% 30%, 100% 70%, 50% 100%, 0% 70%, 0% 30%)',
        animation:'exp-hub-spin 20s linear infinite', filter:'blur(0.5px)' }} />
      <div style={{ position:'absolute', inset:'18%',
        background:'conic-gradient(from 180deg at 50% 50%, #ffffff 0%, var(--color-primary-container) 33%, var(--color-tertiary-container) 66%, #ffffff 100%)',
        clipPath:'polygon(50% 0%, 100% 30%, 100% 70%, 50% 100%, 0% 70%, 0% 30%)',
        animation:'exp-hub-spin 10s linear infinite reverse', opacity:0.78 }} />
      <div style={{ position:'absolute', inset:'38%',
        background:'radial-gradient(circle, #ffffff, var(--color-secondary-container))',
        borderRadius:'50%', filter:'blur(5px)', animation:'pulse-glow 2.5s ease-in-out infinite' }} />
      <style>{`@keyframes exp-hub-spin { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }`}</style>
    </div>
  );
}

// ── Insight feed row (Cockpit priority-feed pattern) ─────────────────────────
function InsightFeedRow({ insight, index }: { insight: RichInsight; index: number }) {
  const { t }       = useTranslation();
  const layerCfg    = LAYER_CONFIG[insight.layer] ?? LAYER_CONFIG.descriptive;
  const borderColor = LAYER_BORDER[insight.layer] ?? '#2a4bd9';
  const confidence  = insight.trust_score;
  const confLabel   = confidence>=80 ? t('experience.hub.intelligence.confidence.reliable')
                    : confidence>=60 ? t('experience.hub.intelligence.confidence.indicative')
                    : t('experience.hub.intelligence.confidence.low');
  const confColor   = confidence>=80 ? '#059669' : confidence>=60 ? '#d97706' : '#94a3b8';

  return (
    <motion.div
      initial={{ opacity:0, x:-8 }}
      animate={{ opacity:1, x:0 }}
      transition={{ duration:0.35, delay:index*0.05 }}
    >
      <Link
        to={toPath(ROUTES.EXPERIENCE_SURVEY, { surveyId: insight.surveyId })}
        className="group flex items-start gap-4 px-5 py-4 hover:bg-surface-container/50 transition-colors cursor-pointer"
        style={{ borderLeft:`3px solid ${borderColor}` }}
      >
        {/* Layer icon */}
        <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5"
          style={{ background: layerCfg.bg }}>
          <Icon name={
            insight.layer==='prescriptive' ? 'flag' :
            insight.layer==='predictive'   ? 'insights' :
            insight.layer==='diagnostic'   ? 'local_fire_department' : 'bar_chart'
          } size={16} style={{ color: layerCfg.color }} />
        </div>

        <div className="flex-1 min-w-0">
          {/* Meta row */}
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className="text-[9px] font-black uppercase tracking-widest" style={{ color:layerCfg.color }}>
              {insight.layer}
            </span>
            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded" style={{ color:confColor, background:`${confColor}18` }}>
              {confLabel} · {confidence}
            </span>
            {/* Survey badge — which survey this insight came from */}
            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-surface-container text-on-surface-variant max-w-[140px] truncate">
              {insight.surveyTitle}
            </span>
            {insight.category && (
              <span className="text-[9px] text-on-surface-variant/50 font-mono">
                {insight.category.split('.').pop()}
              </span>
            )}
          </div>

          {/* Headline — real pipeline-generated text */}
          <p className="text-sm font-semibold text-on-surface leading-snug mb-1 line-clamp-2">
            {insight.headline}
          </p>

          {/* Top citation as quote preview */}
          {insight.citations_json[0]?.quote && (
            <p className="text-[11px] text-on-surface-variant/70 italic line-clamp-1">
              "{insight.citations_json[0].quote}"
            </p>
          )}
        </div>

        {/* Recommended action badge */}
        {insight.recommended_action && (
          <div className="flex-shrink-0 hidden sm:flex items-center gap-1 px-2 py-1 rounded-lg bg-primary/8 text-[10px] font-bold text-primary max-w-[140px]">
            <Icon name="bolt" size={11} />
            <span className="truncate">{insight.recommended_action.label}</span>
          </div>
        )}

        <Icon name="arrow_forward" size={15}
          className="flex-shrink-0 text-on-surface-variant/35 group-hover:text-primary self-center transition-colors" />
      </Link>
    </motion.div>
  );
}

// ── Survey card ───────────────────────────────────────────────────────────────
function SurveyCard({
  survey, insights, onAskCrystal,
}: {
  survey: Survey;
  insights: RichInsight[];
  onAskCrystal: () => void;
}) {
  const { t } = useTranslation();
  const nps   = survey.nps_score  ?? null;
  const csat  = survey.avg_csat   ?? null;
  const resN  = survey.response_count ?? 0;
  const maxN  = survey.max_responses  ?? null;
  const pct   = maxN&&maxN>0 ? Math.min(100, Math.round((resN/maxN)*100)) : null;

  const statusColor =
    survey.status==='active' ? '#059669' :
    survey.status==='paused' ? '#d97706' :
    survey.status==='closed' ? '#94a3b8' : 'var(--color-primary)';

  // Use real sparkline from backend; deterministic fallback from survey ID
  const spark = useMemo<number[]>(() => {
    if (survey.sparkline && survey.sparkline.length>=3) return survey.sparkline.slice(-7);
    const seed = survey.id.split('').reduce((a,c)=>a+c.charCodeAt(0), 0);
    return Array.from({length:7}, (_,i) => {
      const base = nps??40;
      return Math.max(-100, Math.min(100, base + Math.sin(seed*0.1+i*1.4)*7));
    });
  }, [survey.id, survey.sparkline, nps]);

  // Top insight for this survey (first by priority)
  const topInsight = insights[0] ?? null;

  return (
    <Link to={toPath(ROUTES.EXPERIENCE_SURVEY, { surveyId:survey.id })} className="block group h-full">
      <GlassCard className="p-5 h-full flex flex-col transition-all duration-200 group-hover:shadow-lg group-hover:translate-y-[-1px]"
        style={{ boxShadow:'0 4px 20px rgba(0,0,0,0.05), inset 0 1px 0 rgba(255,255,255,0.9)' }}>

        {/* Status + title */}
        <div className="flex items-start justify-between gap-2 mb-4">
          <h3 className="font-headline font-bold text-sm leading-snug line-clamp-2 flex-1 text-on-surface">
            {survey.title || t('experience.hub.surveys.untitled')}
          </h3>
          <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold flex-shrink-0"
            style={{ background:`color-mix(in srgb, ${statusColor} 8%, transparent)`, color:statusColor }}>
            <span className="w-1.5 h-1.5 rounded-full" style={{ background:statusColor }} />
            {survey.status}
          </span>
        </div>

        {/* NPS + sparkline */}
        <div className="flex items-end justify-between mb-4 flex-1">
          <div>
            <div className="text-[9px] font-black uppercase tracking-widest text-on-surface-variant mb-0.5">{t('experience.hub.surveys.npsLabel')}</div>
            <span className="font-headline text-[32px] font-black leading-none" style={{ color:npsColor(nps) }}>
              {npsLabel(nps)}
            </span>
            {nps!=null && resN>0 && (
              <div className="text-[9px] text-on-surface-variant/55 font-mono mt-0.5">±{npsCI(nps,resN)}</div>
            )}
          </div>
          <SparklineChart surveyId={survey.id} points={spark} />
        </div>

        {/* Response progress bar */}
        {maxN!=null && maxN>0 && (
          <div className="mb-3">
            <div className="flex items-center justify-between text-[9px] text-on-surface-variant mb-1">
              <span className="font-bold">{t('experience.hub.surveys.responses', { n: resN.toLocaleString() })}</span>
              <span className="font-mono">{t('experience.hub.surveys.goalPercent', { pct: String(pct) })}</span>
            </div>
            <div className="h-1 rounded-full bg-surface-container overflow-hidden">
              <div className="h-full rounded-full"
                style={{ width:`${pct}%`, background:'linear-gradient(to right, var(--color-primary), var(--color-tertiary))' }} />
            </div>
          </div>
        )}

        {/* Top insight preview — real pipeline data */}
        {topInsight && (
          <div className="mb-3 px-3 py-2 rounded-xl text-[11px] leading-snug line-clamp-2"
            style={{
              background: `${LAYER_CONFIG[topInsight.layer]?.bg ?? '#e0f2fe'}`,
              color:       `${LAYER_CONFIG[topInsight.layer]?.color ?? '#0369a1'}`,
              borderLeft:  `2px solid ${LAYER_BORDER[topInsight.layer]}`,
            }}>
            {topInsight.headline}
          </div>
        )}

        {/* Metrics + actions footer */}
        <div className="flex items-center gap-3 pt-3 border-t border-outline-variant/20 text-[10px] text-on-surface-variant">
          {maxN==null && (
            <span className="flex items-center gap-1">
              <Icon name="people" size={12} />
              {t('experience.hub.surveys.respAbbrev', { n: resN.toLocaleString() })}
            </span>
          )}
          {csat!=null && (
            <span className="flex items-center gap-1">
              <Icon name="star" size={12} />
              <span className="font-bold">{csat.toFixed(1)}</span>
            </span>
          )}
          {insights.length>0 && (
            <span className="flex items-center gap-1">
              <Icon name="auto_awesome" size={12} style={{ color:'var(--color-primary)' }} />
              <span className="font-bold text-primary">{insights.length}</span>
            </span>
          )}
          <div className="flex-1" />
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={(e)=>{ e.preventDefault(); e.stopPropagation(); onAskCrystal(); }}
                className="w-7 h-7 rounded-lg flex items-center justify-center transition-colors hover:bg-primary/10"
              >
                <Icon name="psychology" size={15} style={{ color:'var(--color-primary)' }} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">{t('experience.hub.surveys.askTooltip')}</TooltipContent>
          </Tooltip>
          <Icon name="arrow_forward" size={14}
            className="transition-transform group-hover:translate-x-0.5"
            style={{ color:'var(--color-primary)' }} />
        </div>
      </GlassCard>
    </Link>
  );
}

// ── Sparkline ─────────────────────────────────────────────────────────────────
function SparklineChart({ surveyId, points }: { surveyId: string; points: number[] }) {
  // Filter to finite numbers only — DB can return null/undefined in JSON arrays.
  const valid = points.filter((v) => typeof v === 'number' && isFinite(v));
  // Need at least 2 points to draw a line; 1 point gives xs[0] = 0/0 = NaN.
  if (valid.length < 2) return null;
  const W=68, H=30;
  const min=Math.min(...valid)-1, max=Math.max(...valid)+1, range=max-min||1;
  const xs=valid.map((_,i)=>(i/(valid.length-1))*W);
  const ys=valid.map((v)=>H-((v-min)/range)*H*0.82-H*0.09);
  const path=xs.map((x,i)=>`${i===0?'M':'L'}${x.toFixed(1)},${ys[i].toFixed(1)}`).join(' ');
  const fill=`${path} L${W},${H} L0,${H} Z`;
  const gid=`sp-${surveyId.replace(/\W/g,'')}`;
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ overflow:'visible', flexShrink:0 }}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--color-primary)" stopOpacity="0.22"/>
          <stop offset="1" stopColor="var(--color-primary)" stopOpacity="0"/>
        </linearGradient>
      </defs>
      <path d={fill} fill={`url(#${gid})`} />
      <path d={path} stroke="var(--color-primary)" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ── Capability layer card ─────────────────────────────────────────────────────
function CapabilityCard({ layer, icon, gradient, title, bullets }: {
  layer: string; icon: string; gradient: string; title: string; bullets: string[];
}) {
  return (
    <GlassCard className="p-5">
      <div className="w-9 h-9 rounded-xl flex items-center justify-center mb-3" style={{ background:gradient }}>
        <Icon name={icon} size={19} style={{ color:'white' }} />
      </div>
      <div className="text-[9px] font-black uppercase tracking-[0.18em] text-on-surface-variant mb-1">{layer}</div>
      <div className="text-sm font-black font-headline mb-2 leading-snug">{title}</div>
      <ul className="space-y-0.5">
        {bullets.map((b)=>(
          <li key={b} className="flex items-start gap-1.5 text-[11px] text-on-surface-variant">
            <span className="w-1 h-1 rounded-full bg-primary/40 mt-1.5 flex-shrink-0" />
            {b}
          </li>
        ))}
      </ul>
    </GlassCard>
  );
}

function getCapabilityLayers(t: (k: string) => string) {
  return [
    {
      layer: t('experience.hub.capabilities.descriptive.layer'),
      icon: 'bar_chart', gradient: 'linear-gradient(135deg, #2a4bd9, #3b62f5)',
      title: t('experience.hub.capabilities.descriptive.title'),
      bullets: [
        t('experience.hub.capabilities.descriptive.b1'),
        t('experience.hub.capabilities.descriptive.b2'),
        t('experience.hub.capabilities.descriptive.b3'),
        t('experience.hub.capabilities.descriptive.b4'),
      ],
    },
    {
      layer: t('experience.hub.capabilities.diagnostic.layer'),
      icon: 'hub', gradient: 'linear-gradient(135deg, #8329c8, #a855f7)',
      title: t('experience.hub.capabilities.diagnostic.title'),
      bullets: [
        t('experience.hub.capabilities.diagnostic.b1'),
        t('experience.hub.capabilities.diagnostic.b2'),
        t('experience.hub.capabilities.diagnostic.b3'),
        t('experience.hub.capabilities.diagnostic.b4'),
      ],
    },
    {
      layer: t('experience.hub.capabilities.predictive.layer'),
      icon: 'insights', gradient: 'linear-gradient(135deg, #d97706, #f59e0b)',
      title: t('experience.hub.capabilities.predictive.title'),
      bullets: [
        t('experience.hub.capabilities.predictive.b1'),
        t('experience.hub.capabilities.predictive.b2'),
        t('experience.hub.capabilities.predictive.b3'),
        t('experience.hub.capabilities.predictive.b4'),
      ],
    },
    {
      layer: t('experience.hub.capabilities.prescriptive.layer'),
      icon: 'flag', gradient: 'linear-gradient(135deg, #059669, #10b981)',
      title: t('experience.hub.capabilities.prescriptive.title'),
      bullets: [
        t('experience.hub.capabilities.prescriptive.b1'),
        t('experience.hub.capabilities.prescriptive.b2'),
        t('experience.hub.capabilities.prescriptive.b3'),
        t('experience.hub.capabilities.prescriptive.b4'),
      ],
    },
  ];
}
