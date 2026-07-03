// SurveyReportPage — Full intelligence report for a survey.
//
// Shows the LLM-synthesised full report from run_full_report():
//   § 1  Executive summary (report.executive_summary)
//   § 2  Priority actions  (report.priority_action)
//   § 3  8 detailed themes (report.full_theme)
//   § 4  Cross-theme patterns
//
// report.* insights are separate from voice.topic insights (Intelligence page).
// They are the synthesised view combining established prior findings + fresh responses.

import { useState, useEffect, useMemo, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useTranslation } from '../../lib/i18n';
import { useApi } from '../../hooks/useApi';
import { useSurveys } from '../../hooks/useSurveys';
import { useSetPageTitle } from '../../contexts/pageTitle';
import { useCrystalPanel } from '../../contexts/crystalPanel';
import { Icon } from '../../components/Icon';
import { Button } from '../../components/ui/button';
import { GlassCard } from '../insights/shared';
import { ROUTES, toPath } from '../../constants/routes';
import { stripCitationRefs } from '../../lib/utils';
import type { AgenticInsight } from '../../types';

const stagger = { hidden: {}, visible: { transition: { staggerChildren: 0.07 } } };
const rise = {
  hidden:  { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.45, ease: [0.22, 1, 0.36, 1] as [number,number,number,number] } },
};

const PRIORITY_COLOR: Record<string, string> = {
  critical: '#b41340',
  high:     '#d97706',
  medium:   '#2a4bd9',
  low:      '#64748b',
};
const PRIORITY_BG: Record<string, string> = {
  critical: '#fff1f2',
  high:     '#fffbeb',
  medium:   '#eef2ff',
  low:      '#f8fafc',
};
const HORIZON_LABEL: Record<string, string> = {
  immediate:   'Immediate',
  short_term:  'Short term',
  long_term:   'Long term',
};

const SENTIMENT_BORDER: Record<string, string> = {
  positive: '#16a34a',
  negative: '#dc2626',
  neutral:  '#94a3b8',
  mixed:    '#d97706',
};

function reliabilityLabel(trust: number) {
  if (trust >= 80) return { label: 'Reliable',   color: '#059669', bg: '#ecfdf5' };
  if (trust >= 60) return { label: 'Indicative', color: '#d97706', bg: '#fffbeb' };
  return               { label: 'Low signal',  color: '#94a3b8', bg: '#f8fafc' };
}

// ── Theme card ────────────────────────────────────────────────────────────────
function ThemeCard({ ins, onAskCrystal, surveyId }: {
  ins: AgenticInsight;
  onAskCrystal: (q: string, ctx?: { focused_topic?: string }) => void;
  surveyId: string;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const metric = ins.metric_json as Record<string, unknown> | null;
  const isNew  = Boolean(metric?.is_new_theme);
  const confirmsPrior = Boolean(metric?.confirms_prior);
  const sentiment  = String(metric?.sentiment ?? 'neutral') as keyof typeof SENTIMENT_BORDER;
  const freq       = Number(metric?.frequency_estimate ?? 0);
  const trend      = String(metric?.trend_direction ?? 'unknown');
  const topicName  = String(metric?.topic_name ?? metric?.theme ?? ins.headline);
  const bizImpact  = String(metric?.business_impact ?? '');
  const rootCause  = String(metric?.root_cause_hypothesis ?? '');
  const ra = ins.recommended_action;
  const rel = reliabilityLabel(ins.trust_score);

  return (
    <motion.div variants={rise}>
      <GlassCard className="overflow-hidden">
        {/* Accent bar colour-coded by sentiment */}
        <div className="h-[3px]"
          style={{ background: SENTIMENT_BORDER[sentiment] ?? '#94a3b8' }} />

        <div className="p-5">
          {/* Header row */}
          <div className="flex items-start gap-3 mb-3">
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-1.5 mb-1.5">
                {isNew && (
                  <span className="text-[9px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded"
                    style={{ background: '#f0fdf4', color: '#15803d' }}>
                    New finding
                  </span>
                )}
                {confirmsPrior && (
                  <span className="text-[9px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded"
                    style={{ background: '#eff6ff', color: '#1d4ed8' }}>
                    Confirmed ↑
                  </span>
                )}
                {trend !== 'unknown' && trend !== 'stable' && (
                  <span className="text-[9px] font-bold px-1.5 py-0.5 rounded"
                    style={{
                      background: trend === 'improving' ? '#f0fdf4' : '#fff1f2',
                      color:      trend === 'improving' ? '#15803d' : '#b41340',
                    }}>
                    {trend === 'improving' ? '↑ Improving' : '↓ Declining'}
                  </span>
                )}
                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded"
                  style={{ background: rel.bg, color: rel.color }}>
                  {rel.label}
                </span>
              </div>
              <h3 className="font-bold text-base text-on-surface leading-snug">
                {ins.headline}
              </h3>
              {freq > 0 && (
                <p className="text-xs text-on-surface-variant mt-0.5">
                  {freq} mention{freq !== 1 ? 's' : ''} · {sentiment} sentiment
                </p>
              )}
            </div>
            <button
              onClick={() => setExpanded(e => !e)}
              className="flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center transition-colors hover:bg-muted"
            >
              <Icon name={expanded ? 'expand_less' : 'expand_more'} size={16}
                style={{ color: 'var(--color-on-surface-variant)' }} />
            </button>
          </div>

          {/* Narrative */}
          {ins.narrative && (
            <p className="text-sm text-on-surface leading-relaxed mb-3">
              {stripCitationRefs(ins.narrative)}
            </p>
          )}

          {/* Verbatim quotes */}
          {ins.citations_json && ins.citations_json.length > 0 && (
            <div className="space-y-1.5 mb-3">
              {(expanded ? ins.citations_json : ins.citations_json.slice(0, 2)).map((c, i) => (
                <div key={c.response_id ?? i}
                  className="px-3 py-2 rounded-lg text-xs leading-snug italic text-on-surface"
                  style={{
                    background: 'var(--color-surface-container)',
                    borderLeft: `3px solid ${SENTIMENT_BORDER[c.sentiment] ?? '#94a3b8'}`,
                  }}>
                  {(() => { const q = stripCitationRefs(c.quote ?? ''); return <>&ldquo;{q.length > 200 ? q.slice(0, 200) + '…' : q}&rdquo;</>; })()}
                </div>
              ))}
              {!expanded && ins.citations_json.length > 2 && (
                <button onClick={() => setExpanded(true)}
                  className="text-[10px] font-bold text-primary hover:underline px-1">
                  +{ins.citations_json.length - 2} more response{ins.citations_json.length - 2 !== 1 ? 's' : ''}
                </button>
              )}
            </div>
          )}

          {/* Expanded: business impact + root cause */}
          {expanded && (bizImpact || rootCause) && (
            <div className="space-y-2 mb-3 pt-2 border-t border-outline-variant/20">
              {bizImpact && (
                <div>
                  <span className="text-[10px] font-bold uppercase tracking-wide text-on-surface-variant">
                    Business impact
                  </span>
                  <p className="text-xs text-on-surface mt-0.5">{bizImpact}</p>
                </div>
              )}
              {rootCause && (
                <div>
                  <span className="text-[10px] font-bold uppercase tracking-wide text-on-surface-variant">
                    Root cause
                  </span>
                  <p className="text-xs text-on-surface mt-0.5">{rootCause}</p>
                </div>
              )}
            </div>
          )}

          {/* Recommended action */}
          {ra && (
            <div className="flex items-start gap-2 px-3 py-2.5 rounded-xl mt-2"
              style={{ background: 'color-mix(in srgb, var(--color-primary) 6%, transparent)', border: '1px solid color-mix(in srgb, var(--color-primary) 12%, transparent)' }}>
              <Icon name="lightbulb" size={14} style={{ color: 'var(--color-primary)', flexShrink: 0, marginTop: 1 }} />
              <div className="min-w-0">
                <p className="text-xs font-semibold text-on-surface">{ra.label}</p>
                {ra.estimated_impact && (
                  <p className="text-[10px] text-on-surface-variant mt-0.5">{ra.estimated_impact}</p>
                )}
              </div>
              <span className="flex-shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded"
                style={{ background: '#eef2ff', color: 'var(--color-primary)' }}>
                {HORIZON_LABEL[ra.time_horizon ?? ''] ?? ra.time_horizon}
              </span>
            </div>
          )}

          {/* Footer actions */}
          <div className="flex items-center gap-3 mt-3 pt-3 border-t border-outline-variant/15">
            <button
              onClick={() => onAskCrystal(`Tell me more about the "${ins.headline}" finding`, { focused_topic: topicName })}
              className="text-[10px] font-bold flex items-center gap-1 text-primary hover:underline">
              <Icon name="psychology" size={11} />
              Ask Crystal
            </button>
            {topicName && (
              <Link
                to={`${toPath(ROUTES.EXPERIENCE_SURVEY_TOPICS, { surveyId })}?topic=${encodeURIComponent(topicName)}`}
                className="text-[10px] font-bold flex items-center gap-1 text-on-surface-variant hover:text-on-surface ml-auto">
                Explore topic <Icon name="arrow_forward" size={10} />
              </Link>
            )}
          </div>
        </div>
      </GlassCard>
    </motion.div>
  );
}

// ── Sub-nav ───────────────────────────────────────────────────────────────────
function ReportSubNav({ surveyId, onExport, exporting }: {
  surveyId: string;
  onExport: (fmt: 'pdf' | 'pptx' | 'html') => void;
  exporting: boolean;
}) {
  const { t } = useTranslation();
  const [exportOpen, setExportOpen] = useState(false);
  const dropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!exportOpen) return;
    const close = (e: MouseEvent) => {
      if (!dropRef.current?.contains(e.target as Node)) setExportOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [exportOpen]);

  const navItems = [
    { label: t('experience.nav.intelligence'), icon: 'auto_awesome', path: toPath(ROUTES.EXPERIENCE_SURVEY, { surveyId }) },
    { label: t('experience.nav.topics'),       icon: 'hub',          path: toPath(ROUTES.EXPERIENCE_SURVEY_TOPICS, { surveyId }) },
    { label: t('experience.nav.advanced'),     icon: 'analytics',    path: `${ROUTES.ADVANCED_INSIGHTS}?survey=${surveyId}` },
    { label: t('experience.nav.trends'),       icon: 'timeline',     path: toPath(ROUTES.EXPERIENCE_SURVEY_TRENDS, { surveyId }) },
    { label: t('experience.nav.report'),       icon: 'description',  path: toPath(ROUTES.EXPERIENCE_SURVEY_REPORT, { surveyId }), active: true },
  ] as const;

  const exportOptions = [
    { fmt: 'pdf'  as const, label: t('experience.report.exportPdf'),  icon: 'picture_as_pdf' },
    { fmt: 'pptx' as const, label: t('experience.report.exportPptx'), icon: 'slideshow' },
    { fmt: 'html' as const, label: t('experience.report.exportHtml'), icon: 'code' },
  ];

  return (
    <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35 }}
      className="glass-card-premium rounded-2xl px-4 py-3 sticky top-0 z-20 flex items-center gap-3 flex-wrap"
      style={{ boxShadow: '0 4px 24px rgba(0,0,0,0.07), inset 0 1px 0 rgba(255,255,255,0.9)' }}>

      {/* Pills */}
      <div className="flex items-center gap-1 flex-wrap">
        {navItems.map(item => (
          <Link key={item.label} to={item.path}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-[11px] font-bold transition-all"
            style={'active' in item && item.active
              ? { background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))', color: 'white', boxShadow: '0 2px 8px color-mix(in srgb, var(--color-primary) 25%, transparent)' }
              : { background: 'var(--color-surface-container)', color: 'var(--color-on-surface-variant)' }
            }>
            <Icon name={item.icon} size={12} />{item.label}
          </Link>
        ))}
      </div>

      <div className="flex-1" />

      {/* Export dropdown */}
      <div className="relative" ref={dropRef}>
        <Button size="sm"
          disabled={exporting}
          onClick={() => setExportOpen(o => !o)}
          className="text-xs font-bold text-white border-0 flex items-center gap-1.5 flex-shrink-0"
          style={{ background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))' }}>
          <Icon name={exporting ? 'hourglass_empty' : 'download'} size={13} />
          {exporting ? t('experience.report.exporting') : t('experience.report.export')}
          {!exporting && <Icon name="expand_more" size={13} />}
        </Button>
        {exportOpen && (
          <div className="absolute right-0 top-full mt-1.5 w-48 rounded-xl overflow-hidden"
            style={{ background: 'var(--color-surface)', boxShadow: '0 8px 32px rgba(0,0,0,0.14)', border: '1px solid var(--color-outline-variant)' }}>
            {exportOptions.map(opt => (
              <button key={opt.fmt}
                className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-xs font-medium text-on-surface hover:bg-surface-container transition-colors text-left"
                onClick={() => { setExportOpen(false); onExport(opt.fmt); }}>
                <Icon name={opt.icon} size={14} style={{ color: 'var(--color-primary)' }} />
                {opt.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </motion.div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export function SurveyReportPage() {
  const { t } = useTranslation();
  const { surveyId } = useParams<{ surveyId: string }>();
  const api = useApi();
  const { surveys } = useSurveys();
  const { openCrystal, setScope } = useCrystalPanel();

  const survey = surveys.find(s => s.id === surveyId);
  useSetPageTitle(survey?.title ?? t('experience.nav.report'), t('experience.report.subtitle'));

  const [insights, setInsights] = useState<AgenticInsight[]>([]);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [exportToast, setExportToast] = useState<string | null>(null);

  useEffect(() => {
    if (!surveyId) return;
    setScope(surveyId);
    api.listInsights(surveyId)
      .then(r => setInsights(r.insights ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [api, surveyId, setScope]);

  // Partition by category
  const execSummary = useMemo(() =>
    insights.find(i => i.category === 'report.executive_summary'),
    [insights]);

  const priorityActions = useMemo(() =>
    insights
      .filter(i => i.category === 'report.priority_action')
      .sort((a, b) => b.priority - a.priority),
    [insights]);

  const themes = useMemo(() =>
    insights
      .filter(i => i.category === 'report.full_theme')
      .sort((a, b) => b.priority - a.priority),
    [insights]);

  const crossTheme = useMemo(() => {
    const es = insights.find(i => i.category === 'report.executive_summary');
    return (es?.metric_json as any)?.cross_theme_patterns ?? '';
  }, [insights]);

  const hasReport = execSummary || themes.length > 0 || priorityActions.length > 0;

  const handleAskCrystal = (q: string, ctx?: { focused_topic?: string }) => {
    openCrystal(q, ctx);
  };

  const handleExport = async (format: 'pdf' | 'pptx' | 'html') => {
    if (!surveyId || exporting) return;
    setExporting(true);
    setExportToast(null);
    try {
      const { blob, format: delivered } = await api.downloadReport(surveyId, format);
      const ext = delivered === 'html' ? 'html' : delivered === 'pptx' ? 'pptx' : 'pdf';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${survey?.title ?? 'report'}.${ext}`;
      a.click();
      URL.revokeObjectURL(url);
      if (delivered !== format) setExportToast(t('experience.report.exportFallback'));
    } catch {
      // silent — user sees no download
    } finally {
      setExporting(false);
    }
  };

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto w-full pt-6 md:pt-8 space-y-5">
        <ReportSubNav surveyId={surveyId!} onExport={handleExport} exporting={exporting} />
        <div className="space-y-4">
          {[1,2,3].map(i => (
            <div key={i} className="skeleton h-32 rounded-2xl" />
          ))}
        </div>
      </div>
    );
  }

  if (!hasReport) {
    return (
      <div className="max-w-4xl mx-auto w-full pt-6 md:pt-8 space-y-5">
        <ReportSubNav surveyId={surveyId!} onExport={handleExport} exporting={exporting} />
        <div className="py-20 text-center">
          <Icon name="description" size={48} style={{ color: 'var(--color-on-surface-variant)', opacity: 0.3 }} />
          <p className="text-on-surface-variant mt-4 text-sm">
            {t('experience.report.noReport')}
          </p>
          <p className="text-xs text-on-surface-variant/60 mt-1">
            {t('experience.report.generateHint')}
          </p>
          <Link
            to={toPath(ROUTES.EXPERIENCE_SURVEY, { surveyId: surveyId! })}
            className="mt-4 inline-flex items-center gap-1.5 text-sm font-bold text-primary hover:underline">
            <Icon name="arrow_back" size={14} />
            Back to Intelligence
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto w-full pt-6 md:pt-8 space-y-6">

      {/* ── Sub-nav + export ──────────────────────────────────────────── */}
      <ReportSubNav surveyId={surveyId!} onExport={handleExport} exporting={exporting} />

      {/* ── Export fallback toast ─────────────────────────────────────── */}
      {exportToast && (
        <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}
          className="flex items-center gap-2.5 px-4 py-2.5 rounded-xl text-xs font-medium"
          style={{ background: '#fffbeb', border: '1px solid #fbbf24', color: '#92400e' }}>
          <Icon name="info" size={14} style={{ color: '#d97706', flexShrink: 0 }} />
          {exportToast}
          <button onClick={() => setExportToast(null)} className="ml-auto hover:opacity-70">
            <Icon name="close" size={14} />
          </button>
        </motion.div>
      )}

      {/* ── § 1  Executive Summary ────────────────────────────────────── */}
      {execSummary && (
        <motion.section initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}>
          <GlassCard className="p-6" style={{ border: '1px solid color-mix(in srgb, var(--color-primary) 15%, transparent)' }}>
            <div className="flex items-center gap-2 mb-3">
              <span className="text-[10px] font-black uppercase tracking-widest"
                style={{ color: 'var(--color-primary)' }}>
                Executive Summary
              </span>
              {execSummary.metric_json && (
                <span className="text-[10px] text-on-surface-variant">
                  · {(execSummary.metric_json as any).response_count?.toLocaleString()} responses
                  {(execSummary.metric_json as any).prior_insights_used > 0 && (
                    <span> · {(execSummary.metric_json as any).prior_insights_used} prior findings referenced</span>
                  )}
                </span>
              )}
            </div>
            <p className="text-base text-on-surface leading-relaxed font-medium">
              {execSummary.narrative}
            </p>
            {crossTheme && (
              <div className="mt-4 pt-4 border-t border-outline-variant/20">
                <span className="text-[10px] font-bold uppercase tracking-wide text-on-surface-variant block mb-1">
                  Cross-theme patterns
                </span>
                <p className="text-sm text-on-surface leading-relaxed">{crossTheme}</p>
              </div>
            )}
            <div className="flex items-center gap-3 mt-4 pt-4 border-t border-outline-variant/15">
              <button
                onClick={() => handleAskCrystal('Walk me through the key findings in this report and what I should act on first')}
                className="text-xs font-bold flex items-center gap-1.5 text-primary hover:underline">
                <Icon name="psychology" size={13} /> Ask Crystal about this report
              </button>
            </div>
          </GlassCard>
        </motion.section>
      )}

      {/* ── § 2  Priority Actions ─────────────────────────────────────── */}
      {priorityActions.length > 0 && (
        <motion.section
          variants={stagger} initial="hidden" animate="visible">
          <h2 className="text-sm font-black uppercase tracking-widest text-on-surface-variant mb-3 flex items-center gap-2">
            <Icon name="flag" size={14} />
            Priority Actions
          </h2>
          <div className="space-y-2">
            {priorityActions.map((pa, i) => {
              const ra = pa.recommended_action;
              const priority = ra?.priority ?? 'medium';
              return (
                <motion.div key={pa.id} variants={rise}>
                  <div className="flex items-start gap-3 p-4 rounded-xl border"
                    style={{
                      background: PRIORITY_BG[priority] ?? '#f8fafc',
                      borderColor: `${PRIORITY_COLOR[priority] ?? '#94a3b8'}30`,
                    }}>
                    <span className="text-[9px] font-black uppercase tracking-widest mt-0.5 px-2 py-1 rounded flex-shrink-0"
                      style={{ background: PRIORITY_COLOR[priority] + '18', color: PRIORITY_COLOR[priority] }}>
                      {priority}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-on-surface">{pa.headline}</p>
                      {pa.narrative && (
                        <p className="text-xs text-on-surface-variant mt-0.5 leading-snug">{pa.narrative}</p>
                      )}
                    </div>
                    <span className="flex-shrink-0 text-[9px] font-bold text-on-surface-variant">
                      {HORIZON_LABEL[ra?.time_horizon ?? ''] ?? ''}
                    </span>
                  </div>
                </motion.div>
              );
            })}
          </div>
        </motion.section>
      )}

      {/* ── § 3  Themes ───────────────────────────────────────────────── */}
      {themes.length > 0 && (
        <motion.section variants={stagger} initial="hidden" animate="visible">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-black uppercase tracking-widest text-on-surface-variant flex items-center gap-2">
              <Icon name="account_tree" size={14} />
              {themes.length} Theme{themes.length !== 1 ? 's' : ''}
              <span className="text-[10px] font-normal text-on-surface-variant/60 normal-case tracking-normal">
                · mix of confirmed findings and new discoveries
              </span>
            </h2>
          </div>
          <div className="space-y-4">
            {themes.map(th => (
              <ThemeCard
                key={th.id}
                ins={th}
                onAskCrystal={handleAskCrystal}
                surveyId={surveyId!}
              />
            ))}
          </div>
        </motion.section>
      )}

      {/* ── Bottom: nav to Intelligence ───────────────────────────────── */}
      <div className="pb-8 flex items-center justify-center gap-4 text-xs text-on-surface-variant">
        <Link to={toPath(ROUTES.EXPERIENCE_SURVEY, { surveyId: surveyId! })}
          className="flex items-center gap-1 hover:text-on-surface transition-colors">
          <Icon name="insights" size={13} /> View Intelligence
        </Link>
        <span>·</span>
        <Link to={toPath(ROUTES.EXPERIENCE_SURVEY_TOPICS, { surveyId: surveyId! })}
          className="flex items-center gap-1 hover:text-on-surface transition-colors">
          <Icon name="account_tree" size={13} /> Explore Topics
        </Link>
      </div>

    </div>
  );
}
