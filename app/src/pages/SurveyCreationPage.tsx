import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';
import { SurveyTypeGallery } from '../components/SurveyTypeGallery';
import { useApi } from '../hooks/useApi';
import { ROUTES, toPath } from '../constants/routes';
import { useTranslation } from '../lib/i18n';
import { useSetPageTitle } from '../contexts/pageTitle';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { Template } from '../types';

interface GenerationError {
  heading: string;
  description: string;
  retryable: boolean;
}

// Maps agent error_log text to a locale key pair so callers resolve via t()
function classifyAgentError(errorLog: string[]): { headingKey: string; descriptionKey: string } {
  const raw = errorLog.join(' ').toLowerCase();
  if (raw.includes('timeout') || raw.includes('timed out')) {
    return { headingKey: 'create.error.timeoutHeading', descriptionKey: 'create.error.timeoutDescription' };
  }
  if (raw.includes('rate') || raw.includes('quota') || raw.includes('limit')) {
    return { headingKey: 'create.error.busyHeading', descriptionKey: 'create.error.busyDescription' };
  }
  return { headingKey: 'create.error.failedHeading', descriptionKey: 'create.error.failedDescription' };
}

// ── Helper: build a starter prompt when a category chip is clicked on empty textarea ──
function buildStarterPrompt(tmpl: Template): string {
  if (tmpl.description) return tmpl.description;
  return `Collect ${tmpl.label} feedback from my audience`;
}

// ── Category chip ──────────────────────────────────────────────────────────────
interface CategoryChipProps {
  tmpl:       Template;
  selected:   boolean;
  onSelect:   (tmpl: Template) => void;
}
function CategoryChip({ tmpl, selected, onSelect }: CategoryChipProps) {
  return (
    <button
      type="button"
      onClick={() => onSelect(tmpl)}
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold transition-all border"
      style={{
        background:   selected ? tmpl.color : tmpl.bg,
        color:        selected ? '#ffffff' : tmpl.color,
        borderColor:  tmpl.color + '55',
        boxShadow:    selected ? `0 4px 12px ${tmpl.color}44` : 'none',
        transform:    selected ? 'translateY(-1px)' : 'none',
      }}
    >
      <Icon name={tmpl.icon || 'quiz'} fill={1} size={11} />
      {tmpl.shortLabel || tmpl.label}
    </button>
  );
}

// ── Skeleton chips while templates load ───────────────────────────────────────
function ChipSkeleton() {
  return (
    <div className="flex gap-2 flex-wrap">
      {Array.from({ length: 6 }, (_, i) => (
        <div
          key={i}
          className="h-7 rounded-full animate-pulse bg-surface-container-low"
          style={{ width: 72 + (i % 3) * 20 }}
        />
      ))}
    </div>
  );
}

export function SurveyCreationPage() {
  const { t } = useTranslation();
  useSetPageTitle(t('create.pageTitle'));
  const navigate    = useNavigate();
  const location    = useLocation();

  const isManual       = location.state?.mode === 'manual';
  const preselectedId  = (location.state?.preselectedTemplateId || null) as string | null;
  const fromTemplate   = (location.state?.fromTemplate || null) as Template | null;

  // step: 'gallery' (manual only) | 'manual-name' | 'intent' | 'generating'
  const [step, setStep] = useState<'gallery' | 'manual-name' | 'intent' | 'generating'>(
    isManual ? 'gallery' : 'intent'
  );
  const [selectedTypeId, setSelectedTypeId] = useState<string | null>(fromTemplate?.id || preselectedId);
  const [surveyName,     setSurveyName]     = useState<string>('');
  const [intent,         setIntent]         = useState<string>('');
  const [surveyAudience, setSurveyAudience] = useState<string>('');
  const [surveyUseCase,  setSurveyUseCase]  = useState<string>('');
  const [helpOpen,        setHelpOpen]        = useState<boolean>(false);
  const [copilotRunId,    setCopilotRunId]    = useState<string | null>(null);
  const [agentsDone,      setAgentsDone]      = useState<string[]>([]);
  const [generationError, setGenerationError] = useState<GenerationError | null>(null);

  const nameInputRef = useRef<HTMLInputElement>(null);
  const textareaRef  = useRef<HTMLTextAreaElement>(null);
  // Ref (not state) so the async polling loop reads the current value without a stale closure
  const cancelledRef = useRef<boolean>(false);
  const api         = useApi();

  const [templates,        setTemplates]        = useState<Template[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(true);

  useEffect(() => {
    api.listTemplates()
      .then((data) => setTemplates(data.templates || []))
      .catch(() => setTemplates([]))
      .finally(() => setTemplatesLoading(false));
  }, [api]);

  const templateMap = useMemo<Record<string, Template>>(
    () => Object.fromEntries(templates.map((tmpl) => [tmpl.id, tmpl])),
    [templates],
  );

  // Top 8 system templates sorted: recommended first, then by label
  const recommendedChips = useMemo<Template[]>(() => {
    return templates
      .filter((t) => t.isSystem)
      .sort((a, b) => ((b.recommended ? 1 : 0) - (a.recommended ? 1 : 0)) || a.label.localeCompare(b.label))
      .slice(0, 8);
  }, [templates]);

  const selectedType: Template | null = selectedTypeId
    ? (templateMap[selectedTypeId] || (fromTemplate?.id === selectedTypeId ? fromTemplate : null))
    : null;

  const rawSuggestions    = t('create.suggestions');
  const SUGGESTIONS: string[] = Array.isArray(rawSuggestions) ? rawSuggestions as string[] : [];

  const rawHelptips  = t('create.input.helpTips');
  const HELP_TIPS = Array.isArray(rawHelptips)
    ? (rawHelptips as Array<{ icon: string; title: string; body: string }>)
    : [];

  const rawGeneratingSteps = t('create.generating.steps');
  const GENERATING_STEPS: string[] = Array.isArray(rawGeneratingSteps) ? rawGeneratingSteps as string[] : [];

  useEffect(() => {
    if (step === 'intent') textareaRef.current?.focus();
    if (step === 'manual-name') {
      const type = selectedTypeId ? templateMap[selectedTypeId] : null;
      if (!surveyName) setSurveyName(type?.label || '');
      setTimeout(() => nameInputRef.current?.focus(), 50);
    }
  }, [step]);  // eslint-disable-line react-hooks/exhaustive-deps

  function handleManualStart(typeId: string | null) {
    const type = typeId ? templateMap[typeId] : null;
    const resolvedName = surveyName.trim() || type?.label || t('create.generating.untitled') as string;
    navigate(toPath(ROUTES.BUILDER, { surveyId: 'new' }), {
      state: {
        title:        resolvedName,
        questions:    type?.questions || [],
        surveyTypeId: typeId || null,
        fromTemplate: type || null,
        templateId:   typeId || null,
      },
    });
  }

  function handleChipSelect(tmpl: Template) {
    if (selectedTypeId === tmpl.id) {
      setSelectedTypeId(null);
    } else {
      setSelectedTypeId(tmpl.id);
      if (!intent.trim()) {
        setIntent(buildStarterPrompt(tmpl));
        setTimeout(() => textareaRef.current?.focus(), 50);
      }
    }
  }

  function handleCancel() {
    cancelledRef.current = true;

    // Tell the backend to cancel the run before stopping the UI — fire-and-forget
    // so the UI responds instantly. If this fails (service down), the frontend has
    // already stopped polling and stale-run cleanup will handle it server-side.
    if (copilotRunId) {
      api.cancelRun(copilotRunId).catch(() => {
        // Non-fatal: polling is already stopped via cancelledRef
      });
    }

    setCopilotRunId(null);
    setAgentsDone([]);
    setStep('intent');
    // No error banner — user deliberately cancelled
  }

  function handleBuildManually() {
    const resolvedName = surveyName.trim() || intent.slice(0, 80) || t('create.generating.untitled') as string;
    navigate(toPath(ROUTES.BUILDER, { surveyId: 'new' }), {
      state: {
        title:        resolvedName,
        questions:    selectedType?.questions || [],
        surveyTypeId: selectedTypeId,
        fromTemplate: selectedType || null,
        templateId:   selectedTypeId,
      },
    });
  }

  async function handleGenerate() {
    if (!intent.trim()) return;
    cancelledRef.current = false;
    setGenerationError(null);
    setStep('generating');
    setAgentsDone([]);
    setCopilotRunId(null);

    // Try agents pipeline first; fall back to legacy if unavailable
    try {
      const { run_id } = await api.startRun({
        intent:       intent.trim(),
        surveyTypeId: selectedTypeId ?? undefined,
        orgContext:   { target_audience: surveyAudience || undefined, use_case: surveyUseCase || undefined },
      });
      setCopilotRunId(run_id);

      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        if (cancelledRef.current) return;

        const status = await api.getRunStatus(run_id);
        if (cancelledRef.current) return;

        const done = (status.stream_events as Array<{ event: string; agent?: string }>)
          .filter((e) => e.event === 'agent_complete' && e.agent)
          .map((e) => e.agent as string);
        setAgentsDone(done);

        if (status.status === 'failed') {
          const { headingKey, descriptionKey } = classifyAgentError(
            (status.error_log as string[] | undefined) ?? [],
          );
          setGenerationError({
            heading:     t(headingKey) as string,
            description: t(descriptionKey) as string,
            retryable:   true,
          });
          setStep('intent');
          return;
        }

        if (status.status === 'completed') {
          const resolvedTitle = surveyName.trim() || intent.slice(0, 80) || t('create.generating.untitled') as string;
          navigate(toPath(ROUTES.BUILDER, { surveyId: 'new' }), {
            state: {
              title:           resolvedTitle,
              questions:       status.questions || [],
              surveyTypeId:    selectedTypeId,
              intent,
              fromTemplate:    selectedType,
              templateId:      selectedTypeId,
              runId:           run_id,
              recommendations: status.recommendations || [],
              openCrystal:     true,
              metadata:        { audience: surveyAudience || undefined, use_case: surveyUseCase || undefined },
            },
          });
          return;
        }
      }

      // Polling deadline exceeded — stay on creation page
      if (!cancelledRef.current) {
        setGenerationError({
          heading:     t('create.error.timeoutHeading') as string,
          description: t('create.error.timeoutDescription') as string,
          retryable:   true,
        });
        setStep('intent');
      }
    } catch {
      if (cancelledRef.current) return;
      // Agents service unreachable — try legacy endpoint
      const resolvedTitleFallback = surveyName.trim() || intent.slice(0, 80);
      try {
        const result = await api.generateSurvey(intent, selectedTypeId ?? undefined) as { questions: unknown[] };
        navigate(toPath(ROUTES.BUILDER, { surveyId: 'new' }), {
          state: { title: resolvedTitleFallback, questions: result.questions || [], surveyTypeId: selectedTypeId, intent },
        });
      } catch {
        if (!cancelledRef.current) {
          setGenerationError({
            heading:     t('create.error.unavailableHeading') as string,
            description: t('create.error.unavailableDescription') as string,
            retryable:   false,
          });
          setStep('intent');
        }
      }
    }
  }

  return (
    <div className="w-full flex flex-col">
      <div className="flex justify-center">
        <div className={`w-full ${step === 'gallery' ? 'max-w-5xl' : step === 'manual-name' ? 'max-w-md' : 'max-w-2xl'}`}>
          <PageHeader
            crumbs={[
              { label: t('nav.surveys'), path: ROUTES.SURVEYS },
              { label: t('create.pageTitle') },
            ]}
            title={step !== 'gallery' ? t('create.pageTitle') : undefined}
          />
        </div>
      </div>

      <main className="flex flex-1 items-start justify-center pb-16">

        {/* ── Manual mode: template gallery ── */}
        {step === 'gallery' && (
          <SurveyTypeGallery
            templates={templates}
            isLoading={templatesLoading}
            selectedTypeId={selectedTypeId}
            onSelect={setSelectedTypeId}
            onContinue={() => {
              if (selectedTypeId) {
                setSurveyName('');  // reset so the effect can pre-fill from template label
                setStep('manual-name');
              } else {
                handleManualStart(null);
              }
            }}
            onSkip={() => handleManualStart(null)}
            continueLabel={t('create.typeGallery.startBuildingButton')}
          />
        )}

        {/* ── Step: Manual name entry ── */}
        {step === 'manual-name' && (() => {
          const type = selectedTypeId ? templateMap[selectedTypeId] : null;
          return (
            <div className="w-full max-w-md">
              <div
                className="glass-card rounded-2xl overflow-hidden"
                style={{ boxShadow: '0 40px 100px -20px color-mix(in srgb, var(--color-primary) 10%, transparent)', border: '1px solid rgba(255,255,255,0.3)' }}
              >
                {/* Template context header */}
                {type && (
                  <div
                    className="px-8 py-4 flex items-center gap-3"
                    style={{ background: type.bg, borderBottom: `1px solid ${type.color}22` }}
                  >
                    <div
                      className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
                      style={{ background: type.color + '22', color: type.color }}
                    >
                      <Icon name={type.icon || 'quiz'} fill={1} size={16} />
                    </div>
                    <div>
                      <p className="text-sm font-extrabold font-headline text-on-surface">{type.label}</p>
                      <p className="text-xs text-on-surface-variant">{type.estimatedMinutes}m · {type.questionCount} questions</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setStep('gallery')}
                      className="ml-auto text-xs font-bold rounded-full px-3 py-1 transition-colors"
                      style={{ background: type.color + '18', color: type.color }}
                    >
                      Change
                    </button>
                  </div>
                )}

                <div className="px-8 py-8 space-y-6">
                  <div>
                    <h2 className="text-xl font-extrabold tracking-tight font-headline text-on-surface mb-1">
                      Name your survey
                    </h2>
                    <p className="text-sm text-on-surface-variant">
                      Give it a clear internal name — you can rename it later.
                    </p>
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-xs font-bold text-on-surface-variant uppercase tracking-widest">
                      Survey name
                    </label>
                    <Input
                      ref={nameInputRef}
                      value={surveyName}
                      onChange={(e) => setSurveyName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleManualStart(selectedTypeId); }}
                      placeholder={type ? `e.g., ${type.label} — Q3 2025` : 'e.g., Customer Satisfaction Q3 2025'}
                      className="w-full text-sm font-semibold bg-surface-container-low border-0 rounded-xl px-4 py-3 h-auto focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:ring-offset-0"
                    />
                  </div>

                  <Button
                    onClick={() => handleManualStart(selectedTypeId)}
                    className="w-full py-3 h-auto font-bold font-headline text-white rounded-xl"
                    style={{ background: type ? `linear-gradient(135deg, ${type.color}, var(--color-primary))` : 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))' }}
                  >
                    <span className="flex items-center justify-center gap-2">
                      <Icon name="edit_note" size={18} />
                      Start Building
                    </span>
                  </Button>
                </div>
              </div>
            </div>
          );
        })()}

        {/* ── Step: Intent input ── */}
        {step === 'intent' && (
          <div className="w-full max-w-2xl">
            <div
              className="glass-card rounded-2xl overflow-hidden"
              style={{ boxShadow: '0 40px 100px -20px color-mix(in srgb, var(--color-primary) 12%, transparent)', border: '1px solid rgba(255,255,255,0.3)' }}
            >
              {/* Error banner */}
              <AnimatePresence initial={false}>
                {generationError && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="overflow-hidden"
                  >
                    <div className="mx-6 mt-6 rounded-xl p-4 flex flex-col gap-3"
                      style={{ background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.25)' }}>
                      {/* Message row */}
                      <div className="flex items-start gap-3">
                        <Icon name="error" fill={1} size={16} className="flex-shrink-0 mt-0.5" style={{ color: '#dc2626' }} />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-bold" style={{ color: '#dc2626' }}>{generationError.heading}</p>
                          <p className="text-xs mt-0.5" style={{ color: '#b91c1c' }}>{generationError.description}</p>
                        </div>
                        <button
                          type="button"
                          onClick={() => setGenerationError(null)}
                          className="flex-shrink-0 transition-opacity hover:opacity-60"
                          style={{ color: '#dc2626' }}
                        >
                          <Icon name="close" size={14} />
                        </button>
                      </div>
                      {/* Action row */}
                      <div className="flex items-center gap-2 pl-7">
                        {generationError.retryable && (
                          <button
                            type="button"
                            onClick={handleGenerate}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-colors"
                            style={{ background: 'rgba(220,38,38,0.1)', color: '#dc2626' }}
                          >
                            <Icon name="refresh" size={12} />
                            {t('create.error.retryButton')}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={handleBuildManually}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-colors text-on-surface-variant hover:text-on-surface"
                          style={{ background: 'rgba(0,0,0,0.05)' }}
                        >
                          <Icon name="edit_note" size={12} />
                          {t('create.error.buildManuallyButton')}
                        </button>
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Header */}
              <div className="px-10 pt-10 pb-6 text-center">
                <div
                  className="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-5 shadow-lg"
                  style={{ background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))', transform: 'rotate(-3deg)' }}
                >
                  <Icon name="diamond" fill={1} size={28} className="text-white" />
                </div>
                <h1 className="text-3xl font-extrabold tracking-tighter mb-2 font-headline text-on-surface">
                  {t('create.input.heading')}
                </h1>
                <p className="text-sm text-on-surface-variant">
                  {t('create.input.description')}
                </p>
              </div>

              <div className="px-10 pb-10 space-y-5">
                {/* Survey name input — prominent, first field */}
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black tracking-[0.2em] uppercase text-on-surface-variant">
                    Survey name <span className="text-on-surface-variant/50 font-normal normal-case tracking-normal">(optional)</span>
                  </label>
                  <Input
                    ref={nameInputRef}
                    value={surveyName}
                    onChange={(e) => setSurveyName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Tab') { e.preventDefault(); textareaRef.current?.focus(); } }}
                    placeholder="e.g., Customer Onboarding NPS — Q3 2025"
                    className="w-full text-sm font-semibold bg-surface-container-low border-0 rounded-xl px-4 py-3 h-auto focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:ring-offset-0"
                  />
                </div>

                {/* Survey context — audience + use-case for specialist routing */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-black tracking-[0.2em] uppercase text-on-surface-variant">
                      {t('create.contextAudienceLabel')}
                    </label>
                    <select
                      value={surveyAudience}
                      onChange={(e) => setSurveyAudience(e.target.value)}
                      className="w-full text-sm bg-surface-container-low text-on-surface border-0 rounded-xl px-4 py-3 h-auto focus:ring-2 focus:ring-primary/30 focus:outline-none"
                    >
                      <option value="">{t('create.contextAudiencePlaceholder')}</option>
                      <option value="B2B Customers">B2B Customers</option>
                      <option value="B2C Consumers">B2C Consumers</option>
                      <option value="Internal Employees">Internal Employees</option>
                      <option value="Mixed">Mixed</option>
                      <option value="Partners / Vendors">Partners / Vendors</option>
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-black tracking-[0.2em] uppercase text-on-surface-variant">
                      {t('create.contextUseCaseLabel')}
                    </label>
                    <select
                      value={surveyUseCase}
                      onChange={(e) => setSurveyUseCase(e.target.value)}
                      className="w-full text-sm bg-surface-container-low text-on-surface border-0 rounded-xl px-4 py-3 h-auto focus:ring-2 focus:ring-primary/30 focus:outline-none"
                    >
                      <option value="">{t('create.contextUseCasePlaceholder')}</option>
                      <option value="Customer Experience (CX)">Customer Experience (CX)</option>
                      <option value="Employee Experience (EX)">Employee Experience (EX)</option>
                      <option value="Product Feedback">Product Feedback</option>
                      <option value="Market Research">Market Research</option>
                      <option value="Brand Tracking">Brand Tracking</option>
                      <option value="Event Feedback">Event Feedback</option>
                    </select>
                  </div>
                </div>

                {/* Textarea */}
                <div className="relative">
                  <Textarea
                    ref={textareaRef}
                    value={intent}
                    onChange={(e) => setIntent(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleGenerate(); }}
                    placeholder={t('create.input.placeholder') as string}
                    rows={4}
                    className="w-full resize-none text-sm leading-relaxed bg-surface-container-low font-body text-on-surface rounded-xl p-4 border-0 focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:ring-offset-0 outline-none"
                  />
                  {intent.length > 0 && (
                    <span className="absolute bottom-3 right-3 text-[10px] text-on-surface-variant/50 font-mono">
                      {intent.length}
                    </span>
                  )}
                </div>

                {/* Category recommendation chips */}
                <div>
                  <p className="text-[10px] font-black tracking-[0.2em] uppercase mb-2.5 text-on-surface-variant">
                    {t('create.input.categoryLabel')}
                  </p>
                  {templatesLoading ? (
                    <ChipSkeleton />
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {recommendedChips.map((tmpl) => (
                        <CategoryChip
                          key={tmpl.id}
                          tmpl={tmpl}
                          selected={selectedTypeId === tmpl.id}
                          onSelect={handleChipSelect}
                        />
                      ))}
                    </div>
                  )}
                </div>

                {/* Help accordion */}
                <div className="rounded-xl overflow-hidden border border-border/40">
                  <button
                    type="button"
                    onClick={() => setHelpOpen((o) => !o)}
                    className="w-full flex items-center gap-2 px-4 py-3 text-xs font-bold text-on-surface-variant hover:text-on-surface hover:bg-surface-container-low transition-colors"
                  >
                    <Icon name="lightbulb" fill={helpOpen ? 1 : 0} size={14} className={helpOpen ? 'text-primary' : ''} />
                    <span>{t('create.input.helpTitle')}</span>
                    <Icon name={helpOpen ? 'expand_less' : 'expand_more'} size={14} className="ml-auto" />
                  </button>
                  <AnimatePresence initial={false}>
                    {helpOpen && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        className="overflow-hidden"
                      >
                        <div className="px-4 pb-4 pt-1 bg-surface-container-low/50 space-y-4">
                          <div className="grid grid-cols-2 gap-3">
                            {HELP_TIPS.map((tip) => (
                              <div key={tip.title} className="flex items-start gap-2">
                                <div
                                  className="w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5"
                                  style={{ background: 'color-mix(in srgb, var(--color-primary) 8%, transparent)', color: 'var(--color-primary)' }}
                                >
                                  <Icon name={tip.icon} fill={1} size={12} />
                                </div>
                                <div>
                                  <p className="text-xs font-bold text-on-surface">{tip.title}</p>
                                  <p className="text-[11px] text-on-surface-variant leading-tight">{tip.body}</p>
                                </div>
                              </div>
                            ))}
                          </div>
                          <div
                            className="rounded-xl p-3 border border-border/40"
                            style={{ background: 'color-mix(in srgb, var(--color-primary) 3%, transparent)' }}
                          >
                            <p className="text-[9px] font-black uppercase tracking-[0.2em] text-primary/60 mb-1.5">Example prompt</p>
                            <p className="text-xs text-on-surface italic leading-relaxed">
                              &ldquo;{t('create.input.helpExample')}&rdquo;
                            </p>
                            <button
                              type="button"
                              onClick={() => { setIntent(t('create.input.helpExample') as string); textareaRef.current?.focus(); }}
                              className="mt-2 text-[10px] font-bold text-primary hover:text-primary/70 flex items-center gap-1 transition-colors"
                            >
                              <Icon name="arrow_upward" size={11} />
                              Use this example
                            </button>
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                {/* Generate button */}
                <Button
                  onClick={handleGenerate}
                  disabled={!intent.trim()}
                  className="w-full py-4 h-auto text-white font-bold text-base font-headline rounded-xl"
                  style={{
                    background: intent.trim()
                      ? selectedType
                        ? `linear-gradient(135deg, ${selectedType.color}, var(--color-tertiary))`
                        : 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))'
                      : '#dfe3e6',
                    color:     intent.trim() ? '#ffffff' : '#9a9d9f',
                    cursor:    intent.trim() ? 'pointer' : 'not-allowed',
                    boxShadow: intent.trim() ? '0 16px 40px -10px color-mix(in srgb, var(--color-primary) 35%, transparent)' : 'none',
                    transition: 'all 0.2s',
                  }}
                >
                  <span className="flex items-center justify-center gap-2">
                    <Icon name="diamond" fill={1} size={18} />
                    {selectedType
                      ? t('create.input.generateButtonTyped', { type: selectedType.shortLabel })
                      : t('create.input.generateButton')}
                    <span className="text-xs opacity-60 font-normal ml-1">{t('create.input.keyboardHint')}</span>
                  </span>
                </Button>

                {/* Quick suggestion prompts */}
                <div>
                  <p className="text-[10px] font-black tracking-[0.2em] uppercase mb-2.5 text-on-surface-variant">
                    {t('create.input.suggestionsLabel')}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {SUGGESTIONS.map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => { setIntent(s); textareaRef.current?.focus(); }}
                        className="px-3 py-1.5 text-xs font-semibold transition-all rounded-full"
                        style={{
                          background: intent === s ? 'var(--color-primary)' : '#eef1f3',
                          color:      intent === s ? '#ffffff' : '#595c5e',
                        }}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── Step: Generating ── */}
        {step === 'generating' && (() => {
          const displayName = surveyName.trim() || (intent.trim().length > 0
            ? intent.trim().slice(0, 45) + (intent.trim().length > 45 ? '…' : '')
            : null);
          return (
          <div className="flex flex-col items-center justify-center gap-8 pt-20">
            {/* Survey name pill — shown above the spinner so users immediately know what's being built */}
            {displayName && (
              <div
                className="flex items-center gap-2 px-4 py-2 rounded-full text-sm font-semibold"
                style={{
                  background: 'color-mix(in srgb, var(--color-primary) 7%, transparent)',
                  border: '1px solid color-mix(in srgb, var(--color-primary) 15%, transparent)',
                  color: 'var(--color-primary)',
                  maxWidth: '28rem',
                }}
              >
                <Icon name="description" fill={1} size={14} style={{ flexShrink: 0 }} />
                <span className="truncate">{displayName}</span>
              </div>
            )}
            <div className="relative w-32 h-32">
              <div className="absolute inset-0 rounded-full animate-ping"
                style={{ background: 'color-mix(in srgb, var(--color-primary) 15%, transparent)', animationDuration: '1.5s' }} />
              <div className="absolute inset-4 rounded-full animate-pulse"
                style={{ background: 'color-mix(in srgb, var(--color-primary) 25%, transparent)' }} />
              <div className="absolute inset-8 rounded-full flex items-center justify-center"
                style={{ background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))' }}>
                <Icon name="diamond" fill={1} size={28} className="text-white" />
              </div>
            </div>
            <div className="text-center">
              <h2 className="text-2xl font-extrabold tracking-tighter mb-2 font-headline text-on-surface">
                {t('create.generating.heading')}
              </h2>
              <p className="text-sm text-on-surface-variant">
                {t('create.generating.description')}
              </p>
            </div>
            {/* Agent pipeline progress — shown when using agents service */}
            {copilotRunId ? (
              <div className="flex flex-wrap justify-center gap-2 max-w-sm">
                {[
                  { name: 'creator',     label: 'Survey Creator',  icon: 'edit_note' },
                  { name: 'qc',          label: 'Quality Check',   icon: 'fact_check' },
                  { name: 'compliance',  label: 'Compliance',      icon: 'shield' },
                  { name: 'recommender', label: 'Recommendations', icon: 'auto_awesome' },
                ].map(({ name, label, icon }) => {
                  const done    = agentsDone.includes(name);
                  const running = !done && agentsDone.length === ['creator', 'qc', 'compliance', 'recommender'].indexOf(name);
                  return (
                    <div key={name} className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold"
                      style={{
                        background: done ? '#f0fdf4' : running ? '#eff2ff' : '#f3f4f6',
                        color:      done ? '#16a34a' : running ? '#4f6ef7' : '#9ca3af',
                        border: `1px solid ${done ? '#bbf7d0' : running ? '#c7d2fe' : '#e5e7eb'}`,
                        boxShadow:  running ? '0 4px 12px color-mix(in srgb, var(--color-primary) 12%, transparent)' : 'none',
                        transition: 'all 0.3s ease',
                      }}>
                      {done
                        ? <Icon name="check_circle" fill={1} size={12} />
                        : running
                        ? <span className="w-3 h-3 rounded-full border-2 border-[#4f6ef7] border-t-transparent animate-spin inline-block" />
                        : <Icon name={icon} size={12} />
                      }
                      {label}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="flex gap-2 flex-wrap justify-center">
                {GENERATING_STEPS.map((label, i) => (
                  <div key={label}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold text-primary bg-white"
                    style={{ boxShadow: '0 4px 12px color-mix(in srgb, var(--color-primary) 12%, transparent)', animation: `fadeIn 0.5s ${i * 0.3}s both` }}>
                    <Icon name="check_circle" fill={1} size={12} />
                    {label}
                  </div>
                ))}
              </div>
            )}
            {/* Cancel */}
            <button
              type="button"
              onClick={handleCancel}
              className="flex items-center gap-1.5 text-sm font-semibold text-on-surface-variant hover:text-on-surface transition-colors mt-2"
            >
              <Icon name="close" size={14} />
              {t('create.generating.cancelButton')}
            </button>
          </div>
          );
        })()}
      </main>
    </div>
  );
}
