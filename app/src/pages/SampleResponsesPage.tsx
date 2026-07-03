import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Icon }           from '../components/Icon';
import { PageHeader }     from '../components/PageHeader';
import { useSetPageTitle } from '../contexts/pageTitle';
import { useApi }         from '../hooks/useApi';
import { ROUTES, toPath } from '../constants/routes';
import { useTranslation } from '../lib/i18n';
import { Button }         from '@/components/ui/button';
import type { Survey }    from '../types';

// ── types ─────────────────────────────────────────────────────────────────────

type PersonaMix = 'realistic' | 'critical' | 'positive' | 'mixed';

interface GenerateResult {
  count:   number;
  message: string;
}

// ── constants ─────────────────────────────────────────────────────────────────

const COUNT_OPTIONS = [10, 25, 50, 100];

const MIX_META: Record<PersonaMix, { icon: string; color: string }> = {
  realistic: { icon: 'balance',        color: '#2a4bd9' },
  critical:  { icon: 'report',         color: '#b41340' },
  positive:  { icon: 'sentiment_very_satisfied', color: '#059669' },
  mixed:     { icon: 'shuffle',        color: '#8329c8' },
};

const QUESTION_TYPE_ICONS: Record<string, string> = {
  nps:             'trending_up',
  csat:            'sentiment_satisfied',
  rating:          'star',
  slider:          'tune',
  multiple_choice: 'radio_button_checked',
  checkbox:        'check_box',
  dropdown:        'arrow_drop_down_circle',
  ranking:         'format_list_numbered',
  open_text:       'chat_bubble_outline',
  short_text:      'short_text',
  matrix:          'grid_on',
  date:            'calendar_today',
  statement:       'info',
};

// Estimated total seconds for the generation (batches now run in PARALLEL).
// 25 responses = 5 batches × ~30s each, but all running concurrently → ~35s total.
// EST_SECS_PER_BATCH is now used as the base time for ONE parallel run, not per-sequential-batch.
const EST_SECS_PER_BATCH = 30;

function estimatedSeconds(count: number): number {
  return Math.ceil(count / 5) * EST_SECS_PER_BATCH;
}

// ── sub-components ────────────────────────────────────────────────────────────

interface CountSelectorProps {
  value:    number;
  onChange: (n: number) => void;
}

function CountSelector({ value, onChange }: CountSelectorProps) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {COUNT_OPTIONS.map((n) => (
        <button
          key={n}
          onClick={() => onChange(n)}
          className={`px-4 py-2 rounded-xl text-sm font-bold transition-all ${
            value === n
              ? 'bg-primary text-white shadow-sm'
              : 'bg-surface-container text-on-surface-variant hover:bg-[color-mix(in_srgb,var(--color-primary)_6%,transparent)] border border-[#dfe3e6]'
          }`}
        >
          {n}
        </button>
      ))}
    </div>
  );
}

interface MixCardProps {
  mix:      PersonaMix;
  selected: boolean;
  label:    string;
  description: string;
  onClick:  () => void;
}

function MixCard({ mix, selected, label, description, onClick }: MixCardProps) {
  const meta = MIX_META[mix];
  return (
    <motion.button
      whileHover={{ y: -2 }}
      whileTap={{ scale: 0.98 }}
      onClick={onClick}
      className={`w-full text-left rounded-2xl p-4 transition-all border-2 ${
        selected
          ? 'border-primary bg-primary/5'
          : 'border-[#dfe3e6] bg-white hover:border-primary/30 hover:bg-primary/[0.02]'
      }`}
    >
      <div className="flex items-start gap-3">
        <div
          className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
          style={{ background: `${meta.color}18`, color: meta.color }}
        >
          <Icon name={meta.icon} size={18} />
        </div>
        <div className="min-w-0">
          <p className="font-bold text-sm text-on-surface mb-0.5">{label}</p>
          <p className="text-xs text-on-surface-variant leading-relaxed">{description}</p>
        </div>
        {selected && (
          <div className="w-5 h-5 rounded-full bg-primary flex items-center justify-center shrink-0 ml-auto">
            <Icon name="check" size={12} style={{ color: '#fff' }} />
          </div>
        )}
      </div>
    </motion.button>
  );
}

// ── generating panel ─────────────────────────────────────────────────────────

interface GeneratingPanelProps {
  count:      number;
  elapsed:    number;
  estSeconds: number;
  t:          (key: string, vars?: Record<string, string>) => string;
}

function GeneratingPanel({ count, elapsed, estSeconds, t }: GeneratingPanelProps) {
  const totalBatches  = Math.ceil(count / 5);
  const currentBatch  = Math.min(Math.floor(elapsed / EST_SECS_PER_BATCH) + 1, totalBatches);
  const doneResponses = Math.min((currentBatch - 1) * 5, count);
  const remaining     = Math.max(estSeconds - elapsed, 0);

  // Phase: analyze (first 1.5s), then batch-by-batch, then saving (last 2s)
  const phase =
    elapsed < 1.5 ? 'analyze'
    : elapsed >= estSeconds - 2 ? 'saving'
    : 'batch';

  const phaseLabel =
    phase === 'analyze' ? t('sampleResponses.genPhaseAnalyze')
    : phase === 'saving' ? t('sampleResponses.genPhaseSaving')
    : t('sampleResponses.genPhaseBatch', {
        batch: String(currentBatch),
        total: String(totalBatches),
      });

  const progressPct = Math.min(elapsed / Math.max(estSeconds, 1), 0.97);

  const steps = [
    { key: 'analyze', label: t('sampleResponses.genPhaseAnalyze'),  done: elapsed >= 1.5 },
    { key: 'batch',   label: t('sampleResponses.genPhaseBatch', { batch: String(totalBatches), total: String(totalBatches) }), done: phase === 'saving' },
    { key: 'saving',  label: t('sampleResponses.genPhaseSaving'),    done: false },
  ];

  return (
    <motion.div
      key="generating"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="rounded-2xl p-6 flex flex-col gap-5"
      style={{
        background: 'linear-gradient(135deg,color-mix(in srgb, var(--color-primary) 6%, transparent),color-mix(in srgb, var(--color-tertiary) 4%, transparent))',
        border: '1px solid color-mix(in srgb, var(--color-primary) 15%, transparent)',
      }}
    >
      {/* Header row */}
      <div className="flex items-center gap-3">
        <div className="relative w-12 h-12 shrink-0">
          <motion.div
            className="absolute inset-0 rounded-full"
            style={{ background: 'linear-gradient(135deg,var(--color-primary),var(--color-tertiary))' }}
            animate={{ scale: [1, 1.1, 1], opacity: [0.75, 1, 0.75] }}
            transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut' }}
          />
          <div className="absolute inset-0 flex items-center justify-center">
            <Icon name="auto_awesome" size={22} style={{ color: '#fff' }} />
          </div>
        </div>
        <div className="min-w-0">
          <p className="font-bold text-sm font-headline text-on-surface">{t('sampleResponses.generating')}</p>
          <p className="text-xs text-on-surface-variant mt-0.5 truncate">{phaseLabel}</p>
        </div>
      </div>

      {/* Step tracker */}
      <div className="space-y-2">
        {steps.map((step, i) => {
          const isActive = (
            (step.key === 'analyze' && phase === 'analyze') ||
            (step.key === 'batch'   && phase === 'batch')   ||
            (step.key === 'saving'  && phase === 'saving')
          );
          return (
            <div key={step.key} className="flex items-center gap-2.5">
              <div className="w-5 h-5 rounded-full shrink-0 flex items-center justify-center border-2 transition-all"
                style={{
                  borderColor: step.done ? '#059669' : isActive ? 'var(--color-primary)' : 'rgba(171,173,175,0.4)',
                  background:  step.done ? '#059669' : isActive ? 'color-mix(in srgb, var(--color-primary) 10%, transparent)' : 'transparent',
                }}
              >
                {step.done
                  ? <Icon name="check" size={11} style={{ color: '#fff' }} />
                  : isActive
                    ? <motion.div
                        className="w-2 h-2 rounded-full"
                        style={{ background: 'var(--color-primary)' }}
                        animate={{ scale: [1, 1.4, 1] }}
                        transition={{ duration: 0.9, repeat: Infinity }}
                      />
                    : <span className="text-[9px] font-bold text-on-surface-variant opacity-50">{i + 1}</span>
                }
              </div>
              <span className={`text-xs leading-snug transition-all ${
                step.done    ? 'text-[#059669] line-through opacity-60'
                : isActive   ? 'text-on-surface font-semibold'
                : 'text-on-surface-variant opacity-50'
              }`}>
                {step.key === 'batch' && isActive
                  ? t('sampleResponses.genPhaseBatch', { batch: String(currentBatch), total: String(totalBatches) })
                  : step.label
                }
              </span>
            </div>
          );
        })}
      </div>

      {/* Real progress bar */}
      <div>
        <div className="flex justify-between text-[10px] text-on-surface-variant mb-1.5">
          <span>{t('sampleResponses.genProgress', { done: String(doneResponses), total: String(count) })}</span>
          <span>{t('sampleResponses.genElapsed', { elapsed: String(elapsed), remaining: String(remaining) })}</span>
        </div>
        <div className="w-full h-2 rounded-full bg-[color-mix(in_srgb,var(--color-primary)_10%,transparent)] overflow-hidden">
          <motion.div
            className="h-full rounded-full"
            style={{ background: 'linear-gradient(90deg,var(--color-primary),var(--color-tertiary))', width: `${progressPct * 100}%` }}
            transition={{ duration: 0.5, ease: 'easeOut' }}
            animate={{ width: `${progressPct * 100}%` }}
          />
        </div>
        <p className="text-[10px] text-on-surface-variant opacity-60 mt-1 text-right">
          {Math.round(progressPct * 100)}%
        </p>
      </div>
    </motion.div>
  );
}

// ── main page ─────────────────────────────────────────────────────────────────

export function SampleResponsesPage() {
  const { t }       = useTranslation();
  const { surveyId } = useParams<{ surveyId: string }>();
  const navigate    = useNavigate();
  const api         = useApi();

  useSetPageTitle(t('sampleResponses.pageTitle'));

  // survey loading
  const [survey,  setSurvey]  = useState<Survey | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  // generation config
  const [count,  setCount]  = useState<number>(25);
  const [mix,    setMix]    = useState<PersonaMix>('realistic');

  // generation state
  type GenState = 'idle' | 'generating' | 'done' | 'error';
  const [genState,  setGenState]  = useState<GenState>('idle');
  const [result,    setResult]    = useState<GenerateResult | null>(null);
  const [genError,  setGenError]  = useState<string | null>(null);
  const [elapsed,   setElapsed]   = useState<number>(0);

  // load survey
  useEffect(() => {
    if (!surveyId) return;
    api.getSurvey(surveyId)
      .then(({ survey: s }) => { setSurvey(s); setLoading(false); })
      .catch((err) => { setLoadErr(err.message); setLoading(false); });
  }, [surveyId]); // eslint-disable-line react-hooks/exhaustive-deps

  // elapsed timer while generating
  useEffect(() => {
    if (genState !== 'generating') { setElapsed(0); return; }
    const start = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 500);
    return () => clearInterval(timer);
  }, [genState]);

  async function handleGenerate() {
    if (!surveyId || !survey) return;
    setGenState('generating');
    setResult(null);
    setGenError(null);
    try {
      const res = await api.generateSampleResponses(surveyId, { count, personaMix: mix });
      setResult(res);
      setGenState('done');
    } catch (err) {
      setGenError(err instanceof Error ? err.message : String(err));
      setGenState('error');
    }
  }

  const questions  = survey?.questions || [];
  const estSeconds = estimatedSeconds(count);

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto w-full">
        <div className="flex items-center justify-center py-32">
          <div className="w-8 h-8 rounded-full border-2 animate-spin"
            style={{ borderColor: 'color-mix(in srgb, var(--color-primary) 20%, transparent)', borderTopColor: 'var(--color-primary)' }} />
        </div>
      </div>
    );
  }

  if (loadErr || !survey) {
    return (
      <div className="max-w-7xl mx-auto w-full">
        <div className="banner-error mt-6">{loadErr || 'Survey not found'}</div>
      </div>
    );
  }

  const crumbs = [
    { label: t('nav.surveys'),                 icon: 'poll',              path: ROUTES.SURVEYS },
    { label: survey.title,                                                 path: toPath(ROUTES.RESPONSE_DASHBOARD, { surveyId: survey.id }) },
    { label: t('sampleResponses.breadcrumb') },
  ];

  return (
    <div className="max-w-7xl mx-auto w-full">
      <PageHeader
        crumbs={crumbs}
        title={t('sampleResponses.pageTitle')}
        subtitle={t('sampleResponses.subtitle')}
      />

      {/* Warning banner */}
      <motion.div
        initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}
        className="flex items-start gap-3 px-4 py-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-sm mb-6"
      >
        <Icon name="info" size={18} className="shrink-0 mt-0.5" />
        <span>{t('sampleResponses.warningBanner')}</span>
      </motion.div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-6 items-start">

        {/* ── Left: Config ── */}
        <div className="space-y-6">

          {/* Count selector */}
          <motion.div
            initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}
            className="rounded-2xl p-6"
            style={{
              background: 'rgba(255,255,255,0.78)',
              backdropFilter: 'blur(16px)',
              boxShadow: '0 4px 24px rgba(0,0,0,0.04), inset 0 1px 0 rgba(255,255,255,0.8)',
              border: '1px solid rgba(255,255,255,0.6)',
            }}
          >
            <h2 className="font-bold text-sm font-headline text-on-surface mb-4 flex items-center gap-2">
              <Icon name="tag" size={16} className="text-primary" />
              {t('sampleResponses.countLabel')}
            </h2>
            <CountSelector value={count} onChange={setCount} />
            <p className="text-xs text-on-surface-variant mt-3">
              {t('sampleResponses.estimatedTime', { seconds: String(estSeconds) })}
            </p>
          </motion.div>

          {/* Persona mix */}
          <motion.div
            initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}
            className="rounded-2xl p-6"
            style={{
              background: 'rgba(255,255,255,0.78)',
              backdropFilter: 'blur(16px)',
              boxShadow: '0 4px 24px rgba(0,0,0,0.04), inset 0 1px 0 rgba(255,255,255,0.8)',
              border: '1px solid rgba(255,255,255,0.6)',
            }}
          >
            <h2 className="font-bold text-sm font-headline text-on-surface mb-4 flex items-center gap-2">
              <Icon name="people" size={16} className="text-primary" />
              {t('sampleResponses.mixLabel')}
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {(['realistic', 'critical', 'positive', 'mixed'] as PersonaMix[]).map((m) => (
                <MixCard
                  key={m}
                  mix={m}
                  selected={mix === m}
                  label={t(`sampleResponses.mixOptions.${m}`)}
                  description={t(`sampleResponses.mixDescriptions.${m}`)}
                  onClick={() => setMix(m)}
                />
              ))}
            </div>
          </motion.div>

          {/* Generate button */}
          <motion.div
            initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }}
          >
            <AnimatePresence mode="wait">
              {genState === 'idle' || genState === 'error' ? (
                <motion.div key="idle" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                  <Button
                    variant="gradient"
                    size="lg"
                    className="w-full rounded-xl font-headline text-base py-6"
                    onClick={handleGenerate}
                    disabled={questions.length === 0}
                  >
                    <Icon name="auto_awesome" size={20} />
                    {t('sampleResponses.generateButton', { count: String(count) })}
                  </Button>
                  {questions.length === 0 && (
                    <p className="text-xs text-destructive mt-2 text-center">{t('sampleResponses.noQuestions')}</p>
                  )}
                  {genState === 'error' && genError && (
                    <motion.div
                      initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
                      className="mt-3 flex items-start gap-2 px-4 py-3 rounded-xl bg-red-50 border border-red-200 text-red-700 text-sm"
                    >
                      <Icon name="error" size={16} className="shrink-0 mt-0.5" />
                      <span>{genError}</span>
                    </motion.div>
                  )}
                </motion.div>
              ) : genState === 'generating' ? (
                <GeneratingPanel
                  key="generating"
                  count={count}
                  elapsed={elapsed}
                  estSeconds={estSeconds}
                  t={t}
                />
              ) : (
                /* done */
                <motion.div
                  key="done"
                  initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0 }}
                  className="rounded-2xl p-6 flex flex-col items-center gap-4 text-center"
                  style={{
                    background: 'linear-gradient(135deg,rgba(5,150,105,0.06),rgba(5,150,105,0.02))',
                    border: '1px solid rgba(5,150,105,0.2)',
                  }}
                >
                  <motion.div
                    initial={{ scale: 0 }} animate={{ scale: 1 }}
                    transition={{ type: 'spring', damping: 12, stiffness: 200 }}
                    className="w-16 h-16 rounded-full flex items-center justify-center"
                    style={{ background: 'linear-gradient(135deg,#059669,#10b981)' }}
                  >
                    <Icon name="check_circle" size={32} style={{ color: '#fff' }} />
                  </motion.div>
                  <div>
                    <p className="font-bold text-lg text-on-surface font-headline">
                      {t('sampleResponses.successHeading')}
                    </p>
                    <p className="text-sm text-on-surface-variant mt-1">
                      {result && t('sampleResponses.successMessage', { count: String(result.count) })}
                    </p>
                  </div>
                  <div className="flex gap-3 w-full">
                    <Button
                      variant="gradient"
                      size="sm"
                      className="flex-1 rounded-xl"
                      onClick={() => navigate(toPath(ROUTES.RESPONSE_DASHBOARD, { surveyId: survey.id }))}
                    >
                      <Icon name="forum" size={15} />
                      {t('sampleResponses.viewResponses')}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1 rounded-xl"
                      onClick={() => { setGenState('idle'); setResult(null); }}
                    >
                      <Icon name="refresh" size={15} />
                      {t('sampleResponses.generateMore')}
                    </Button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        </div>

        {/* ── Right: Survey preview ── */}
        <motion.div
          initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.12 }}
          className="rounded-2xl p-6 sticky top-6"
          style={{
            background: 'rgba(255,255,255,0.78)',
            backdropFilter: 'blur(16px)',
            boxShadow: '0 4px 24px rgba(0,0,0,0.04), inset 0 1px 0 rgba(255,255,255,0.8)',
            border: '1px solid rgba(255,255,255,0.6)',
          }}
        >
          <h2 className="font-bold text-sm font-headline text-on-surface mb-1 flex items-center gap-2">
            <Icon name="poll" size={15} className="text-primary" />
            {t('sampleResponses.questionsHeading')}
          </h2>
          <p className="text-xs text-on-surface-variant mb-4">{survey.title}</p>

          {questions.length === 0 ? (
            <p className="text-sm text-on-surface-variant italic">{t('sampleResponses.noQuestions')}</p>
          ) : (
            <div className="space-y-2">
              {questions.map((q, i) => {
                const iconName = QUESTION_TYPE_ICONS[q.type] || 'help_outline';
                return (
                  <div key={q.id} className="flex items-start gap-2.5 py-2.5 border-b border-[rgba(171,173,175,0.15)] last:border-0">
                    <span className="text-xs font-bold text-on-surface-variant shrink-0 w-5 pt-0.5">{i + 1}.</span>
                    <div className="w-6 h-6 rounded-lg flex items-center justify-center shrink-0 bg-surface-container">
                      <Icon name={iconName} size={13} className="text-on-surface-variant" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm text-on-surface leading-snug line-clamp-2">{q.question}</p>
                      <span className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant opacity-60">{q.type.replace(/_/g, ' ')}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Summary chip */}
          <div className="mt-4 flex items-center gap-2 px-3 py-2 rounded-xl bg-primary/5 border border-primary/10">
            <Icon name="auto_awesome" size={14} className="text-primary" />
            <span className="text-xs text-primary font-semibold">
              {count} responses × {questions.length} questions
            </span>
          </div>
        </motion.div>

      </div>
    </div>
  );
}
