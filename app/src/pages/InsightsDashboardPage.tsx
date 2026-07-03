// Insights Dashboard — Crystal Command.
// Crystal (Experient Copilot) is the AI thread throughout: dark cinematic hero →
// portfolio brief → live metrics → deeper findings bento → Crystal Q&A →
// auto-surfaced findings.
// See docs/insights/SURVEY_SCOPE_UX.md and docs/insights/ARCHITECTURE.md.

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useSearchParams, useNavigate, Link } from 'react-router-dom';
import { useSetPageTitle } from '../contexts/pageTitle';
import { useInsights } from '../hooks/useInsights';
import { useApi } from '../hooks/useApi';
import { useSurveys } from '../hooks/useSurveys';
import { ROUTES } from '../constants/routes';
import { useTranslation } from '../lib/i18n';
import { PageHeader } from '../components/PageHeader';
import { Icon } from '../components/Icon';
import { Button } from '@/components/ui/button';
import { SurveyScopePicker, type SurveyScope } from '../components/SurveyScopePicker';
import { UnifiedInsightsView } from './insights/UnifiedInsightsView';
import { useCrystalPanel } from '../contexts/crystalPanel';
import { useInvalidation } from '../lib/dataBus';
import type { AgenticInsight, SurveyTopic, LatestCheckpoint, RecentCheckpointPoint } from '../types';

const SCOPE_STORAGE_KEY = 'insights_scope';

// Exported so tests can mock this module and shrink timeouts to 1 tick.
export const POLL_INTERVAL_MS  = 3_000;
export const POLL_TIMEOUT_S    = 300;   // seconds; timeout = POLL_TIMEOUT_S / (POLL_INTERVAL_MS/1000) ticks
export const BG_POLL_INTERVAL_MS = 10_000;

// Pipeline nodes for the generating overlay
const INSIGHT_NODES = [
  { id: 'ingest',   label: 'Loading Responses',  icon: 'download'             },
  { id: 'embed',    label: 'Building Embeddings', icon: 'memory'               },
  { id: 'metrics',  label: 'Computing Metrics',   icon: 'analytics'            },
  { id: 'absa',     label: 'Sentiment Analysis',  icon: 'sentiment_satisfied'  },
  { id: 'cluster',  label: 'Clustering Topics',   icon: 'hub'                  },
  { id: 'topics',   label: 'Discovering Topics',  icon: 'topic'                },
  { id: 'narrate',  label: 'Narrating Insights',  icon: 'edit_note'            },
  { id: 'verify',   label: 'Verifying Claims',    icon: 'fact_check'           },
  { id: 'evaluate', label: 'Evaluating Quality',  icon: 'verified'             },
  { id: 'publish',  label: 'Publishing Results',  icon: 'publish'              },
] as const;

export function InsightsDashboardPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const api = useApi();
  const [searchParams, setSearchParams] = useSearchParams();
  useSetPageTitle(t('insights.pageTitle'), t('insights.dateFilter'));

  const { surveys, loading: surveysLoading } = useSurveys();
  const { setScope: setCrystalScope, openCrystal, setCrystalData } = useCrystalPanel();

  // ── Scope: URL is the source of truth. ?survey=ID for single survey, nothing for 'all'. ──
  const scope = useMemo<SurveyScope>(
    () => searchParams.get('survey') ?? 'all',
    [searchParams],
  );

  // On first mount with no URL param: restore last-used scope (validated against
  // loaded surveys) or auto-select the first active survey.
  // Wait for surveys to load so we never restore a stale/deleted survey ID.
  useEffect(() => {
    if (searchParams.get('survey')) return;
    if (surveysLoading || surveys.length === 0) return;
    const saved = localStorage.getItem(SCOPE_STORAGE_KEY);
    if (saved && saved !== 'all' && surveys.some((s) => s.id === saved)) {
      setSearchParams({ survey: saved }, { replace: true });
      return;
    }
    const active = surveys.find((s) => s.status === 'active') ?? surveys[0];
    if (active) {
      setSearchParams({ survey: active.id }, { replace: true });
    }
  }, [surveys, surveysLoading]); // eslint-disable-line react-hooks/exhaustive-deps

  // If URL scope references a survey that no longer exists, fall back to 'all'.
  useEffect(() => {
    if (scope !== 'all' && !surveysLoading && surveys.length > 0 && !surveys.some((s) => s.id === scope)) {
      setSearchParams({}, { replace: true });
    }
  }, [scope, surveys, surveysLoading, setSearchParams]);

  const handleScopeChange = (next: SurveyScope) => {
    setCrystalScope(next);
    if (next === 'all') {
      setSearchParams({});
    } else {
      setSearchParams({ survey: next });
    }
    try {
      window.localStorage.setItem(SCOPE_STORAGE_KEY, next);
    } catch {
      // Safari private mode — ignore
    }
  };

  // ── Legacy insights (for the demo hero/brief sections) ───────────────────
  // Only resolve to a survey ID after surveys have loaded and the ID is confirmed
  // to exist — prevents stale localStorage/URL IDs from triggering 404 API calls.
  const focusSurveyId = useMemo(() => {
    if (surveysLoading || surveys.length === 0) return undefined;
    if (scope === 'all') return surveys.find((s) => s.status === 'active')?.id;
    return surveys.some((s) => s.id === scope) ? scope : undefined;
  }, [scope, surveys, surveysLoading]);
  const focusSurvey = surveys.find((s) => s.id === focusSurveyId);
  const { insights, generating: legacyGenerating, regenerate } = useInsights(focusSurveyId);

  // ── Org analytics (for cross-survey KPI cards) ───────────────────────────
  const [orgNps, setOrgNps] = useState<number | null>(null);
  const [orgIndustry, setOrgIndustry] = useState<string | null | undefined>(undefined);
  const [nudgeDismissed, setNudgeDismissed] = useState(false);
  const [dismissedAnomalies, setDismissedAnomalies] = useState<Set<string>>(new Set());

  useEffect(() => {
    api.getOrgAnalytics()
      .then(d => setOrgNps(d.avg_nps))
      .catch(() => {});
    api.getOrgProfile()
      .then(d => setOrgIndustry(d?.profile?.industry ?? null))
      .catch(() => setOrgIndustry(null));
  }, [api]);

  // ── Topics (from survey_topics table) ────────────────────────────────────
  const [topics, setTopics] = useState<SurveyTopic[]>([]);

  useEffect(() => {
    if (!focusSurveyId) { setTopics([]); return; }
    api.listTopics(focusSurveyId)
      .then(({ topics: t }) => setTopics(t ?? []))
      .catch(() => setTopics([]));
  }, [api, focusSurveyId]);

  // ── Agentic insights (real pipeline data) ────────────────────────────────
  const [agenticInsights, setAgenticInsights] = useState<AgenticInsight[]>([]);
  const [agenticLoading,  setAgenticLoading]  = useState(false);
  // ── Phase 0.5 — investigation trajectory (Enhanced Header Band) ───────────
  const [latestCheckpoint,  setLatestCheckpoint]  = useState<LatestCheckpoint | null>(null);
  const [priorCheckpoints,  setPriorCheckpoints]  = useState<RecentCheckpointPoint[]>([]);
  const [runStatus,         setRunStatus]         = useState<string | null>(null);
  const [generating,      setGenerating]      = useState(false);
  const [nodesDone,       setNodesDone]       = useState<string[]>([]);
  const [genError,        setGenError]        = useState<string | null>(null);
  // genBackground: overlay dismissed, pipeline still running — background poll active
  const [genBackground,   setGenBackground]   = useState(false);
  const [genToast,        setGenToast]        = useState<string | null>(null);
  const pollRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const bgPollRef  = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadAgentic = useCallback(async () => {
    if (!focusSurveyId) {
      setAgenticInsights([]);
      setLatestCheckpoint(null);
      setPriorCheckpoints([]);
      setRunStatus(null);
      setCrystalData([], []);
      return;
    }
    setAgenticLoading(true);
    const surveyId = focusSurveyId;
    try {
      const { insights: list, run_status, latest_checkpoint } = await api.listInsights(surveyId);
      const loaded = list ?? [];
      setAgenticInsights(loaded);
      setRunStatus(run_status ?? null);
      setLatestCheckpoint(latest_checkpoint ?? null);
      setCrystalData(loaded, topics);
      // Sparkline trail — Phase 4 endpoint; tolerates absence (returns []).
      if (latest_checkpoint) {
        api.getRecentCheckpoints(surveyId, 5)
          .then(setPriorCheckpoints)
          .catch(() => setPriorCheckpoints([]));
      } else {
        setPriorCheckpoints([]);
      }
    } catch {
      setAgenticInsights([]);
      setLatestCheckpoint(null);
      setPriorCheckpoints([]);
    } finally {
      setAgenticLoading(false);
    }
  }, [api, focusSurveyId, topics, setCrystalData]);

  // Subscribe to DataBus: a Crystal-driven mutation or checkpoint write that
  // invalidates 'insights' should refresh the band + drawer.
  useInvalidation('insights', loadAgentic);

  useEffect(() => {
    loadAgentic();
    return () => {
      if (pollRef.current)   clearInterval(pollRef.current);
      if (bgPollRef.current) clearInterval(bgPollRef.current);
    };
  }, [loadAgentic]);

  // Background poll: slower cadence, runs after the overlay is dismissed.
  // Notifies the user when the pipeline finally completes.
  const startBackgroundPoll = useCallback((surveyId: string) => {
    if (bgPollRef.current) clearInterval(bgPollRef.current);
    bgPollRef.current = setInterval(async () => {
      try {
        const { status } = await api.getInsightRunStatus(surveyId);
        if (status === 'completed') {
          clearInterval(bgPollRef.current!);
          await loadAgentic();
          setGenBackground(false);
          setGenToast(t('insights.generate.readyToast'));
        } else if (status === 'failed') {
          clearInterval(bgPollRef.current!);
          setGenBackground(false);
          setGenError(t('insights.generate.errorFailed'));
        }
      } catch { /* keep polling */ }
    }, BG_POLL_INTERVAL_MS);
  }, [api, loadAgentic, t]);

  const handleGenerate = useCallback(async (
    triggerArg?: unknown,
  ) => {
    // Tolerate being used both as a direct onClick handler (receives a
    // MouseEvent) and as an explicit trigger caller. Only honor a string.
    const trigger: 'manual' | 'regenerate' =
      triggerArg === 'regenerate' ? 'regenerate' : 'manual';
    if (!focusSurveyId || generating) return;
    setGenerating(true);
    setNodesDone([]);
    setGenError(null);
    setGenBackground(false);
    setGenToast(null);
    if (bgPollRef.current) clearInterval(bgPollRef.current);
    try {
      await api.triggerInsightGeneration(focusSurveyId, { trigger });
    } catch {
      setGenError(t('insights.generate.errorStart'));
      setGenerating(false);
      return;
    }
    let elapsed = 0;
    pollRef.current = setInterval(async () => {
      elapsed += 3;
      try {
        const { status, stream_events } = await api.getInsightRunStatus(focusSurveyId);
        const completed = (stream_events as Array<{ event: string; agent: string }>)
          .filter(e => e.event === 'node_complete')
          .map(e => e.agent);
        setNodesDone(completed);
        if (status === 'failed') {
          clearInterval(pollRef.current!);
          setGenError(t('insights.generate.errorFailed'));
          setGenerating(false);
          return;
        }
        if (status === 'completed') {
          clearInterval(pollRef.current!);
          setNodesDone(INSIGHT_NODES.map(n => n.id));
          await new Promise(r => setTimeout(r, 700));
          await loadAgentic();
          setGenerating(false);
          setNodesDone([]);
          return;
        }
      } catch { /* keep polling */ }
      // Overlay timeout: dismiss generating UI, keep polling in background.
      if (elapsed >= POLL_TIMEOUT_S) {
        clearInterval(pollRef.current!);
        setGenerating(false);
        setNodesDone([]);
        setGenBackground(true);
        startBackgroundPoll(focusSurveyId);
      }
    }, POLL_INTERVAL_MS);
  }, [api, focusSurveyId, generating, loadAgentic, startBackgroundPoll, t]);

  const subtitle =
    scope === 'all'
      ? t('insights.pageSubtitle')
      : focusSurvey
        ? `${focusSurvey.title} · ${(focusSurvey.response_count ?? 0).toLocaleString()} responses`
        : t('insights.pageSubtitle');

  return (
    <div className="space-y-6 max-w-7xl mx-auto w-full">
      <PageHeader
        crumbs={[{ label: t('nav.insights'), icon: 'psychology', path: ROUTES.INSIGHTS }]}
        title={t('insights.pageTitle')}
        subtitle={subtitle}
        actions={
          <div className="flex items-center gap-2 flex-wrap">
            <SurveyScopePicker surveys={surveys} scope={scope} onChange={handleScopeChange} />
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleGenerate('manual')}
              disabled={generating || !focusSurveyId}
              className="text-xs h-auto py-2 px-3"
              title={!focusSurveyId ? 'Pick a survey to run the insight pipeline' : undefined}
            >
              <Icon
                name={generating ? 'hourglass_top' : 'refresh'}
                size={16}
                style={{ animation: generating ? 'spin 1s linear infinite' : undefined }}
              />
              {generating ? t('common.regenerating') : t('insights.refreshButton')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const dest = focusSurveyId
                  ? `${ROUTES.INSIGHTS_TOPICS}?survey=${focusSurveyId}`
                  : ROUTES.INSIGHTS_TOPICS;
                navigate(dest);
              }}
              className="text-xs h-auto py-2 px-3 gap-1.5"
              title={!focusSurveyId ? 'Select a survey to explore topics' : undefined}
            >
              <Icon name="hub" size={16} />
              {t('insights.topicsButton')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate(ROUTES.ADVANCED_INSIGHTS)}
              className="text-xs h-auto py-2 px-3 gap-1.5"
            >
              <Icon name="analytics" size={16} />
              {t('insights.advancedButton')}
            </Button>
          </div>
        }
      />

      {/* Industry not configured — nudge to set it for specialist agent routing */}
      {orgIndustry === null && !nudgeDismissed && (
        <div className="flex items-center gap-3 px-4 py-3 rounded-xl border"
          style={{ background: 'rgba(234,179,8,0.06)', borderColor: 'rgba(234,179,8,0.3)' }}>
          <Icon name="lightbulb" fill={1} size={18} style={{ color: '#b45309', flexShrink: 0 }} />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold" style={{ color: '#92400e' }}>
              {t('insights.industryNudgeTitle')}
            </p>
            <p className="text-xs mt-0.5" style={{ color: '#b45309' }}>
              {t('insights.industryNudgeDesc')}
            </p>
          </div>
          <Link
            to={ROUTES.SETTINGS}
            className="shrink-0 text-[11px] font-bold px-3 py-1.5 rounded-full flex items-center gap-1 transition-all hover:opacity-90"
            style={{ background: '#b45309', color: '#fff' }}
          >
            <Icon name="settings" size={13} />
            {t('insights.industryNudgeCta')}
          </Link>
          <button
            onClick={() => setNudgeDismissed(true)}
            className="shrink-0 p-1 rounded-full opacity-60 hover:opacity-100 transition-opacity"
            aria-label="Dismiss"
            style={{ color: '#b45309' }}
          >
            <Icon name="close" size={16} />
          </button>
        </div>
      )}

      {/* Anomaly callouts — topics that are trending up with negative sentiment */}
      {(() => {
        const anomalies = topics.filter(tp =>
          tp.trending === 'up' && (tp.sentiment_score ?? 0) < -0.3 && !dismissedAnomalies.has(tp.id),
        );
        if (!anomalies.length) return null;
        return (
          <div className="space-y-2">
            {anomalies.map(tp => (
              <div key={tp.id} className="flex items-center gap-3 rounded-xl px-4 py-3 border"
                style={{ background: '#fff1f2', borderColor: '#fecdd3' }}>
                <Icon name="warning" fill={1} size={18} style={{ color: '#b41340', flexShrink: 0 }} />
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-sm" style={{ color: '#9f1239' }}>
                    {t('insights.anomalyRising')} <span className="font-black">{tp.name}</span>
                  </p>
                  <p className="text-xs mt-0.5" style={{ color: '#be123c' }}>
                    {tp.volume} {t('insights.anomalyMentions')} · {tp.sentiment_score != null ? tp.sentiment_score.toFixed(2) : '—'}
                    {tp.effort_score != null ? ` · ${t('insights.anomalyEffort')} ${tp.effort_score.toFixed(1)}` : ''}
                  </p>
                </div>
                <button
                  onClick={() => openCrystal(`Why is "${tp.name}" rising negatively? What are customers saying?`, { focused_topic: tp.name })}
                  className="shrink-0 text-[11px] font-bold px-3 py-1.5 rounded-full flex items-center gap-1 transition-all hover:opacity-90"
                  style={{ background: '#b41340', color: '#fff' }}>
                  <Icon name="psychology" size={13} />
                  {t('insights.anomalyAskCrystal')}
                </button>
                <button
                  onClick={() => setDismissedAnomalies(prev => new Set([...prev, tp.id]))}
                  className="shrink-0 p-1 rounded-full opacity-60 hover:opacity-100 transition-opacity"
                  aria-label="Dismiss"
                  style={{ color: '#b41340' }}
                >
                  <Icon name="close" size={16} />
                </button>
              </div>
            ))}
          </div>
        );
      })()}

      {/* Background-generation banner — pipeline still running after overlay dismissed */}
      <AnimatePresence>
        {genBackground && (
          <motion.div
            key="gen-background-banner"
            data-testid="bg-banner"
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.25 }}
            className="flex items-center gap-3 px-4 py-3 rounded-xl text-sm"
            style={{ background: '#eff2ff', border: '1px solid color-mix(in srgb, var(--color-primary) 25%, transparent)', color: '#1e40af' }}
          >
            <span
              className="w-2 h-2 rounded-full flex-shrink-0"
              style={{ background: 'var(--color-primary)', animation: 'pulse-glow 2s ease-in-out infinite' }}
            />
            <span className="flex-1 font-medium">{t('insights.generate.backgroundBanner')}</span>
            <span className="text-xs opacity-60">{t('insights.generate.readyToastBody')}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Completion toast — slides in when background generation finishes */}
      <AnimatePresence>
        {genToast && (
          <motion.div
            key="gen-toast"
            data-testid="ready-toast"
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            className="flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium"
            style={{ background: '#d1fae5', border: '1px solid #059669', color: '#065f46' }}
          >
            <Icon name="check_circle" size={18} style={{ color: '#059669', flexShrink: 0 }} />
            <span className="flex-1">{genToast}</span>
            <button
              onClick={() => setGenToast(null)}
              className="ml-auto hover:opacity-70 transition-opacity"
              aria-label={t('insights.generate.dismiss')}
            >
              <Icon name="close" size={16} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <UnifiedInsightsView
        insights={insights}
        scope={scope}
        surveys={surveys}
        agenticInsights={agenticInsights}
        agenticLoading={agenticLoading}
        generating={generating}
        nodesDone={nodesDone}
        genError={genError}
        onGenerate={handleGenerate}
        focusSurvey={focusSurvey}
        orgAvgNps={orgNps}
        latestCheckpoint={latestCheckpoint}
        priorCheckpoints={priorCheckpoints}
        runStatus={runStatus}
        onGenerateTrigger={(trigger) => handleGenerate(trigger)}
        onRefresh={() => handleGenerate('manual')}
      />

      {/* Crystal Panel is mounted globally in AppShell; data injected via setCrystalData() */}
    </div>
  );
}
