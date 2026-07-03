import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from '../lib/i18n';
import { useApi } from '../hooks/useApi';
import { useSetPageTitle } from '../contexts/pageTitle';
import { useCrystalPanel } from '../contexts/crystalPanel';
import { Icon } from '../components/Icon';
import { Button } from '@/components/ui/button';
import { GlassCard } from './insights/shared';
import { PageHeader } from '../components/PageHeader';
import { ROUTES, toPath } from '../constants/routes';
import type { GroupInsightRun, GroupInsight, SurveyTag } from '../lib/api';
import type { Survey } from '../types';

const stagger = { hidden: {}, visible: { transition: { staggerChildren: 0.07 } } };
const rise = {
  hidden:  { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.45, ease: [0.22, 1, 0.36, 1] as [number,number,number,number] } },
};

const LAYER_COLOR: Record<string, string> = {
  descriptive:  '#2a4bd9',
  diagnostic:   '#d97706',
  predictive:   '#8b5cf6',
  prescriptive: '#059669',
};

const GAP_SEVERITY_COLOR: Record<string, string> = {
  critical: '#b41340',
  moderate: '#d97706',
  low:      '#64748b',
};

// ── Crystal Orb (CSS only) ────────────────────────────────────────────────────
function CrystalOrb({ size = 80 }: { size?: number }) {
  return (
    <div style={{ width: size, height: size, position: 'relative', filter: 'drop-shadow(0 8px 20px color-mix(in srgb, var(--color-primary) 40%, transparent))' }}>
      <div style={{
        position: 'absolute', inset: 0,
        background: 'conic-gradient(from 0deg at 50% 50%, var(--color-primary-container) 0%, var(--color-tertiary-container) 25%, var(--color-secondary-container) 50%, var(--color-tertiary-container) 75%, var(--color-primary-container) 100%)',
        clipPath: 'polygon(50% 0%, 100% 30%, 100% 70%, 50% 100%, 0% 70%, 0% 30%)',
        animation: 'exp-hub-spin 20s linear infinite',
      }} />
      <div style={{
        position: 'absolute', inset: '18%',
        background: 'conic-gradient(from 180deg at 50% 50%, #ffffff 0%, var(--color-primary-container) 33%, var(--color-tertiary-container) 66%, #ffffff 100%)',
        clipPath: 'polygon(50% 0%, 100% 30%, 100% 70%, 50% 100%, 0% 70%, 0% 30%)',
        animation: 'exp-hub-spin 10s linear infinite reverse',
        opacity: 0.78,
      }} />
      <div style={{
        position: 'absolute', inset: '38%',
        background: 'radial-gradient(circle, #ffffff, var(--color-secondary-container))',
        borderRadius: '50%', filter: 'blur(4px)',
        animation: 'pulse-glow 2.5s ease-in-out infinite',
      }} />
      <style>{`@keyframes exp-hub-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

// ── Streaming progress view ───────────────────────────────────────────────────
function StreamingView({ run, surveyCount }: { run: GroupInsightRun; surveyCount: number }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center justify-center py-24 gap-6">
      <CrystalOrb size={88} />
      <div className="text-center">
        <h2 className="text-2xl font-black font-headline text-on-surface mb-1">
          {t('groups.generatingReport', { count: surveyCount })}
        </h2>
        <p className="text-sm text-on-surface-variant">{t('groups.streamEvents.themes')}</p>
      </div>
      {run.stream_events.length > 0 && (
        <motion.div
          className="w-full max-w-md space-y-1.5"
          variants={stagger} initial="hidden" animate="visible"
        >
          {run.stream_events.slice(-6).map((evt, i) => (
            <motion.div
              key={i}
              variants={rise}
              className="flex items-center gap-2 text-sm text-on-surface-variant px-3 py-1.5 rounded-lg bg-surface-container"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-primary shrink-0 animate-pulse" />
              {String(evt.data?.message ?? evt.event)}
            </motion.div>
          ))}
        </motion.div>
      )}
    </div>
  );
}

// ── Gap card ──────────────────────────────────────────────────────────────────
function GapCard({ insight, onCreateSurvey }: { insight: GroupInsight; onCreateSurvey: () => void }) {
  const { t } = useTranslation();
  const severity = String((insight as GroupInsight & { severity?: string }).severity ?? 'moderate');
  const color = GAP_SEVERITY_COLOR[severity] ?? GAP_SEVERITY_COLOR.moderate;
  const severityLabel = ({
    critical: t('groups.gapSeverity.critical'),
    moderate: t('groups.gapSeverity.moderate'),
    low: t('groups.gapSeverity.low'),
  } as Record<string, string>)[severity] ?? t('groups.gapSeverity.moderate');
  return (
    <GlassCard className="overflow-hidden">
      <div className="h-1 w-full" style={{ background: color }} />
      <div className="p-4">
        <div className="flex items-start justify-between gap-2 mb-2">
          <div>
            <span className="text-[10px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded"
              style={{ background: `${color}20`, color }}>
              {severityLabel}
            </span>
          </div>
          <Button variant="ghost" size="sm" onClick={onCreateSurvey}
            className="rounded-lg text-xs shrink-0 gap-1"
            style={{ color: 'var(--color-primary)' }}>
            <Icon name="add_circle" size={13} />
            {t('groups.createSuggestedSurvey')}
          </Button>
        </div>
        <h4 className="font-bold text-on-surface text-sm mb-1">{insight.headline}</h4>
        <p className="text-xs text-on-surface-variant leading-relaxed">{insight.narrative}</p>
      </div>
    </GlassCard>
  );
}

// ── Suggest card ──────────────────────────────────────────────────────────────
function SuggestCard({ insight, onCreateSurvey }: { insight: GroupInsight; onCreateSurvey: () => void }) {
  const { t } = useTranslation();
  return (
    <GlassCard className="p-4 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <h4 className="font-bold text-on-surface text-sm">{insight.headline}</h4>
        <Button variant="default" size="sm" onClick={onCreateSurvey}
          className="rounded-lg text-xs shrink-0 gap-1"
          style={{ background: 'var(--color-primary)' }}>
          <Icon name="add" size={12} />
          {t('groups.createSuggestedSurvey')}
        </Button>
      </div>
      <p className="text-xs text-on-surface-variant leading-relaxed">{insight.narrative}</p>
      {insight.suggested_survey_types && insight.suggested_survey_types.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {insight.suggested_survey_types.map((st) => (
            <span key={st} className="tag-topic">{st}</span>
          ))}
        </div>
      )}
    </GlassCard>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export function GroupReportPage() {
  const { t } = useTranslation();
  const { tagId, runId } = useParams<{ tagId: string; runId?: string }>();
  const navigate = useNavigate();
  const api = useApi();
  const { setScope } = useCrystalPanel();

  const [run,         setRun]         = useState<GroupInsightRun | null>(null);
  const [insights,    setInsights]    = useState<GroupInsight[]>([]);
  const [tag,         setTag]         = useState<SurveyTag | null>(null);
  const [groupSurveys, setGroupSurveys] = useState<Survey[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState<string | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useSetPageTitle(
    tag ? t('groups.groupReportTitle', { name: tag.name }) : t('groups.generateReport'),
  );

  // Scope Crystal panel
  useEffect(() => {
    if (tagId) setScope(tagId);
    return () => { setScope('all'); };
  }, [tagId, setScope]);

  // Load tag + surveys
  useEffect(() => {
    if (!tagId) return;
    api.getTagSurveys(tagId).then(res => {
      setTag(res.tag);
      setGroupSurveys(res.surveys);
    }).catch(() => {});
  }, [tagId, api]);

  // Load run
  const loadRun = useCallback(async () => {
    if (!tagId) return;

    try {
      let resolvedRunId = runId;

      if (!resolvedRunId) {
        // latest report mode
        const latest = await api.getLatestGroupReport(tagId);
        if (!latest) {
          setLoading(false);
          return;
        }
        resolvedRunId = latest.run.id;
        navigate(toPath(ROUTES.GROUP_REPORT, { tagId, runId: resolvedRunId }), { replace: true });
      }

      const data = await api.getGroupInsightRun(resolvedRunId);
      setRun(data.run);
      setInsights(data.insights);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [tagId, runId, api, navigate]);

  useEffect(() => { loadRun(); }, [loadRun]);

  // Poll while pending/running
  useEffect(() => {
    if (!run || !runId) return;
    if (run.status === 'pending' || run.status === 'running') {
      pollRef.current = setInterval(async () => {
        try {
          const status = await api.getGroupInsightRunStatus(runId);
          setRun(status);
          if (status.status === 'completed' || status.status === 'failed') {
            if (pollRef.current) clearInterval(pollRef.current);
            if (status.status === 'completed') {
              const data = await api.getGroupInsightRun(runId);
              setRun(data.run);
              setInsights(data.insights);
            }
          }
        } catch { /* ignore */ }
      }, 3000);
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [run?.status, runId, api]);

  // Derived data
  const execSummary  = insights.filter(i => i.layer === 'descriptive').sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))[0];
  const crossThemes  = insights.filter(i => i.category === 'group.theme');
  const gapInsights  = insights.filter(i => i.category === 'group.gap');
  const suggestInsights = insights.filter(i => i.category === 'group.suggest');

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto w-full flex items-center justify-center py-32">
        <CrystalOrb size={64} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-7xl mx-auto w-full">
        <div className="banner-error mt-8">{error}</div>
      </div>
    );
  }

  if (!run && !loading) {
    return (
      <div className="max-w-7xl mx-auto w-full">
        <PageHeader
          crumbs={[{ label: t('nav.surveys'), path: ROUTES.SURVEYS }, { label: t('groups.generateReport') }]}
          title={t('groups.generateReport')}
        />
        <div className="rounded-xl border border-border p-12 text-center">
          <Icon name="analytics" size={40} className="text-muted-foreground mx-auto mb-4" />
          <p className="text-on-surface-variant">{t('groups.noTagsYet')}</p>
          <Button className="mt-4" onClick={() => navigate(ROUTES.SURVEYS)}
            style={{ background: 'var(--color-primary)' }}>
            {t('nav.surveys')}
          </Button>
        </div>
      </div>
    );
  }

  const isStreaming = run && (run.status === 'pending' || run.status === 'running');

  return (
    <div className="max-w-7xl mx-auto w-full">
      <PageHeader
        crumbs={[
          { label: t('nav.surveys'), path: ROUTES.SURVEYS },
          { label: tag?.name ?? t('groups.generateReport') },
        ]}
        title={tag ? t('groups.groupReportTitle', { name: tag.name }) : t('groups.generateReport')}
        subtitle={t('groups.surveysInGroup', { count: Number(groupSurveys.length) })}
      />

      <AnimatePresence mode="wait">
        {isStreaming ? (
          <motion.div key="streaming" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <StreamingView run={run!} surveyCount={groupSurveys.length} />
          </motion.div>
        ) : (
          <motion.div key="report" variants={stagger} initial="hidden" animate="visible" className="space-y-8">

            {/* Executive Summary */}
            {execSummary && (
              <motion.section variants={rise}>
                <h2 className="text-lg font-bold font-headline text-on-surface mb-3 flex items-center gap-2">
                  <span className="w-7 h-7 rounded-xl flex items-center justify-center"
                    style={{ background: `${LAYER_COLOR.descriptive}15`, color: LAYER_COLOR.descriptive }}>
                    <Icon name="summarize" size={15} />
                  </span>
                  {t('groups.executiveSummary')}
                </h2>
                <GlassCard className="p-5">
                  <h3 className="font-bold text-on-surface mb-2">{execSummary.headline}</h3>
                  <p className="text-sm text-on-surface-variant leading-relaxed">{execSummary.narrative}</p>
                </GlassCard>
              </motion.section>
            )}

            {/* Cross-Survey Themes */}
            {crossThemes.length > 0 && (
              <motion.section variants={rise}>
                <h2 className="text-lg font-bold font-headline text-on-surface mb-3 flex items-center gap-2">
                  <span className="w-7 h-7 rounded-xl flex items-center justify-center"
                    style={{ background: `${LAYER_COLOR.diagnostic}15`, color: LAYER_COLOR.diagnostic }}>
                    <Icon name="bubble_chart" size={15} />
                  </span>
                  Cross-Survey Themes
                </h2>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {crossThemes.map((ins) => (
                    <motion.div key={ins.id} variants={rise}>
                      <GlassCard className="p-4">
                        <h4 className="font-bold text-on-surface text-sm mb-1">{ins.headline}</h4>
                        <p className="text-xs text-on-surface-variant leading-relaxed">{ins.narrative}</p>
                        {ins.trust_score != null && (
                          <div className="mt-2 flex items-center gap-1.5">
                            <div className="h-1 flex-1 rounded-full bg-border overflow-hidden">
                              <div className="h-full rounded-full"
                                style={{ width: `${ins.trust_score}%`, background: 'var(--color-primary)' }} />
                            </div>
                            <span className="text-[10px] text-muted-foreground">{ins.trust_score}%</span>
                          </div>
                        )}
                      </GlassCard>
                    </motion.div>
                  ))}
                </div>
              </motion.section>
            )}

            {/* Coverage Gaps */}
            {gapInsights.length > 0 && (
              <motion.section variants={rise}>
                <h2 className="text-lg font-bold font-headline text-on-surface mb-3 flex items-center gap-2">
                  <span className="w-7 h-7 rounded-xl flex items-center justify-center"
                    style={{ background: '#d9770615', color: '#d97706' }}>
                    <Icon name="warning" size={15} />
                  </span>
                  {t('groups.missingData')}
                </h2>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {gapInsights.map((ins) => (
                    <motion.div key={ins.id} variants={rise}>
                      <GapCard insight={ins} onCreateSurvey={() => navigate(ROUTES.CREATE)} />
                    </motion.div>
                  ))}
                </div>
              </motion.section>
            )}

            {/* Suggested Surveys */}
            {suggestInsights.length > 0 && (
              <motion.section variants={rise}>
                <h2 className="text-lg font-bold font-headline text-on-surface mb-3 flex items-center gap-2">
                  <span className="w-7 h-7 rounded-xl flex items-center justify-center"
                    style={{ background: '#05966915', color: '#059669' }}>
                    <Icon name="auto_awesome" size={15} />
                  </span>
                  {t('groups.suggestedSurveys')}
                </h2>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {suggestInsights.map((ins) => (
                    <motion.div key={ins.id} variants={rise}>
                      <SuggestCard insight={ins} onCreateSurvey={() => navigate(ROUTES.CREATE)} />
                    </motion.div>
                  ))}
                </div>
              </motion.section>
            )}

            {/* Empty state when completed but no insights */}
            {run?.status === 'completed' && insights.length === 0 && (
              <motion.div variants={rise} className="rounded-xl border border-border p-12 text-center">
                <Icon name="analytics" size={40} className="text-muted-foreground mx-auto mb-4" />
                <p className="text-on-surface-variant text-sm">{t('groups.noTagsYet')}</p>
              </motion.div>
            )}

          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
