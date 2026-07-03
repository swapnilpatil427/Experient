import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { useSetPageTitle } from '../contexts/pageTitle';
import { useApi } from '../hooks/useApi';
import { ROUTES, toPath } from '../constants/routes';
import { SURVEY_CATEGORIES } from '../constants/surveyTypes';
import { useTranslation } from '../lib/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { PageHeader } from '../components/PageHeader';
import type { Template } from '../types';

const SCORING_METHOD_LABELS = {
  nps: 'Net Promoter Score',
  csat_percentage: 'CSAT %',
  ces_mean: 'Customer Effort Score',
  average: '5-pt Average',
  sus: 'System Usability Scale',
  pmf: 'Product-Market Fit',
};

// ── Prop interfaces ────────────────────────────────────────────────────────────

interface ModalShellProps {
  onClose: () => void;
  children: React.ReactNode;
  maxWidth?: string;
}

interface TemplatePreviewProps {
  template: Template;
  compact?: boolean;
}

interface UseModalProps {
  template: Template;
  onClose: () => void;
}

interface DeleteModalProps {
  template: Template;
  onDelete: (id: string) => Promise<void>;
  onClose: () => void;
}

interface TagInputProps {
  tags: string[];
  onChange: (tags: string[]) => void;
  placeholder: string;
  hasError?: boolean;
}

interface FieldErrorProps {
  msg?: string;
}

interface BenchmarkValues {
  poor?: number | null;
  average?: number | null;
  good?: number | null;
  excellent?: number | null;
  world_class?: number | null;
  [key: string]: number | null | undefined;
}

interface BenchmarkBarProps {
  benchmarks: BenchmarkValues;
  unit?: string;
  t: (key: string) => string;
}

interface InfoModalProps {
  template: Template;
  onClose: () => void;
  onUseClick: (template: Template) => void;
}

interface TemplateModalProps {
  template: (Partial<Template> & { isNew?: boolean }) | null;
  categories: typeof SURVEY_CATEGORIES;
  onSave: (formData: Partial<Template> & { isNew?: boolean }) => Promise<void>;
  onClose: () => void;
}

interface TemplateCardProps {
  template: Template;
  onUseClick: (template: Template) => void;
  onEdit: (template: Template) => void;
  onDelete: (template: Template) => void;
  onInfoClick: (template: Template) => void;
}

// ── Shared modal shell ─────────────────────────────────────────────────────────

function ModalShell({ onClose, children, maxWidth = 'max-w-md' }: ModalShellProps) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(6px)' }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className={`bg-white rounded-2xl shadow-2xl w-full ${maxWidth} overflow-hidden`}
        style={{ boxShadow: '0 40px 80px -20px color-mix(in srgb, var(--color-primary) 22%, transparent)' }}
      >
        {children}
      </div>
    </div>
  );
}

// ── Template preview strip (reused in Clone + Use modals) ─────────────────────

function TemplatePreview({ template, compact = false }: TemplatePreviewProps) {
  const cat = SURVEY_CATEGORIES.find((c) => c.id === template.category);
  return (
    <div
      className="flex items-start gap-4 p-5 rounded-xl"
      style={{ background: template.bg || '#e0e7ff' }}
    >
      <div
        className="w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0"
        style={{ background: template.color || 'var(--color-primary)', color: '#fff' }}
      >
        <Icon name={template.icon || 'quiz'} fill={1} size={22} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap mb-1">
          <span className="text-sm font-extrabold font-headline text-on-surface">{template.label}</span>
          <span
            className="text-[10px] font-black px-2 py-0.5 rounded-full"
            style={{ background: `color-mix(in srgb, ${template.color || 'var(--color-primary)'} 13%, transparent)`, color: template.color || 'var(--color-primary)' }}
          >
            {template.shortLabel}
          </span>
          {cat && (
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full"
              style={{ background: cat.color + '18', color: cat.color }}>
              {cat.shortLabel}
            </span>
          )}
        </div>
        {!compact && (
          <p className="text-xs text-on-surface-variant leading-relaxed mb-2">{template.description}</p>
        )}
        <div className="flex items-center gap-2 flex-wrap">
          {(template.metrics || []).slice(0, 3).map((m) => (
            <span key={m} className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-white/60 text-on-surface-variant">
              {m}
            </span>
          ))}
          <span className="text-[10px] text-on-surface-variant ml-auto flex items-center gap-1">
            <Icon name="help_outline" size={11} />
            {template.questionCount || (template.questions || []).length}q
            <span className="mx-0.5 opacity-40">·</span>
            <Icon name="schedule" size={11} />
            {template.estimatedMinutes || 0}m
          </span>
        </div>
      </div>
    </div>
  );
}

// ── Use Modal ─────────────────────────────────────────────────────────────────

function UseModal({ template, onClose }: UseModalProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  function goAI() {
    navigate(ROUTES.CREATE, { state: { fromTemplate: template, skipTypeSelection: true } });
    onClose();
  }

  function goManual() {
    navigate(toPath(ROUTES.BUILDER, { surveyId: 'new' }), {
      state: {
        title:        template.label,
        questions:    template.questions || [],
        surveyTypeId: template.id,
        fromTemplate: template,
      },
    });
    onClose();
  }

  return (
    <ModalShell onClose={onClose}>
      {/* Header */}
      <div className="flex items-center justify-between px-6 pt-6 pb-4">
        <h2 className="text-lg font-extrabold font-headline text-on-surface">
          {t('templates.useModal.heading')}
        </h2>
        <Button variant="ghost" size="icon" onClick={onClose} className="w-8 h-8 rounded-xl text-on-surface-variant">
          <Icon name="close" size={18} />
        </Button>
      </div>

      {/* Template preview */}
      <div className="px-6 pb-5">
        <TemplatePreview template={template} />
      </div>

      {/* Divider + choose mode */}
      <div className="px-6 pb-3">
        <p className="text-xs font-bold uppercase tracking-widest text-on-surface-variant mb-4">
          {t('templates.useModal.chooseMode')}
        </p>
        <div className="space-y-3">
          {/* AI option */}
          <button
            onClick={goAI}
            className="w-full flex items-start gap-4 p-4 rounded-2xl text-left transition-all duration-150 active:scale-[0.98] group"
            style={{ background: '#f0f4ff', border: '1.5px solid #c7d2fe' }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--color-primary)'; e.currentTarget.style.background = '#e0e7ff'; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = '#c7d2fe'; e.currentTarget.style.background = '#f0f4ff'; }}
          >
            <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 bg-gradient-to-br from-[var(--color-primary)] to-[var(--color-tertiary)]">
              <Icon name="auto_awesome" fill={1} size={20} className="text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between mb-0.5">
                <span className="text-sm font-extrabold font-headline text-on-surface">
                  {t('templates.useModal.aiOptionTitle')}
                </span>
                <Icon name="arrow_forward" size={16} className="text-primary opacity-0 group-hover:opacity-100 transition-opacity" />
              </div>
              <p className="text-xs text-on-surface-variant leading-relaxed">
                {t('templates.useModal.aiOptionDesc')}
              </p>
            </div>
          </button>

          {/* Manual option */}
          <button
            onClick={goManual}
            className="w-full flex items-start gap-4 p-4 rounded-2xl text-left transition-all duration-150 active:scale-[0.98] group"
            style={{ background: '#f9fafb', border: '1.5px solid #eef1f3' }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = '#abadb0'; e.currentTarget.style.background = '#f0f2f4'; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = '#eef1f3'; e.currentTarget.style.background = '#f9fafb'; }}
          >
            <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
              style={{ background: '#e5e9eb' }}>
              <Icon name="edit_note" fill={1} size={20} className="text-on-surface-variant" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between mb-0.5">
                <span className="text-sm font-extrabold font-headline text-on-surface">
                  {t('templates.useModal.manualOptionTitle')}
                </span>
                <Icon name="arrow_forward" size={16} className="text-on-surface-variant opacity-0 group-hover:opacity-100 transition-opacity" />
              </div>
              <p className="text-xs text-on-surface-variant leading-relaxed">
                {t('templates.useModal.manualOptionDesc')}
              </p>
            </div>
          </button>
        </div>
      </div>

      <div className="px-6 pb-6 pt-2">
        <Button variant="ghost" onClick={onClose} className="w-full rounded-xl text-sm font-bold text-on-surface-variant">
          {t('common.cancel')}
        </Button>
      </div>
    </ModalShell>
  );
}

// ── Delete Modal ──────────────────────────────────────────────────────────────

function DeleteModal({ template, onDelete, onClose }: DeleteModalProps) {
  const { t } = useTranslation();
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');

  async function handleDelete() {
    setDeleting(true);
    setError('');
    try {
      await onDelete(template.id);
    } catch (err) {
      setError((err as Error).message || 'Failed to delete. Please try again.');
      setDeleting(false);
    }
  }

  return (
    <ModalShell onClose={onClose} maxWidth="max-w-sm">
      <div className="p-6">
        <div className="w-12 h-12 rounded-2xl flex items-center justify-center mx-auto mb-4"
          style={{ background: '#fff0f0' }}>
          <Icon name="delete_forever" fill={1} size={24} className="text-error" />
        </div>
        <h2 className="text-base font-extrabold font-headline text-on-surface text-center mb-1">
          {t('templates.deleteModal.heading')}
        </h2>
        <p className="text-sm text-on-surface-variant text-center mb-5 leading-relaxed">
          {t('templates.deleteModal.description', { label: template.label })}
        </p>
        {error && (
          <div className="mb-4 px-3 py-2 rounded-xl text-xs font-semibold text-error" style={{ background: '#fff0f0' }}>
            {error}
          </div>
        )}
        <div className="flex gap-3">
          <Button onClick={onClose} disabled={deleting}
            className="flex-1 rounded-xl font-bold text-sm"
            style={{ background: '#f0f2f4', color: '#595c5e' }}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleDelete} disabled={deleting}
            className="flex-1 rounded-xl font-bold text-sm text-white"
            style={{ background: deleting ? '#94a3b8' : '#b41340' }}>
            {deleting ? (
              <span className="flex items-center justify-center gap-2">
                <span className="w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                {t('common.loading')}
              </span>
            ) : t('templates.deleteModal.confirmButton')}
          </Button>
        </div>
      </div>
    </ModalShell>
  );
}

// ── Tag Input ─────────────────────────────────────────────────────────────────

function TagInput({ tags, onChange, placeholder, hasError }: TagInputProps) {
  const [input, setInput] = useState<string>('');

  function commit() {
    const clean = input.trim().toLowerCase().replace(/,/g, '');
    if (clean && !tags.includes(clean)) onChange([...tags, clean]);
    setInput('');
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(); }
    if (e.key === 'Backspace' && !input && tags.length) onChange(tags.slice(0, -1));
  }

  return (
    <div
      className="flex flex-wrap gap-1.5 p-2 min-h-[44px] rounded-xl cursor-text"
      style={{
        background: '#f5f6f7',
        border: `1.5px solid ${hasError ? '#b41340' : '#eef1f3'}`,
        transition: 'border-color 0.15s',
      }}
      onClick={(e) => e.currentTarget.querySelector('input')?.focus()}
    >
      {tags.map((tag) => (
        <span key={tag} className="flex items-center gap-1 px-2.5 py-0.5 text-xs font-bold rounded-full"
          style={{ background: '#e0e7ff', color: 'var(--color-primary)' }}>
          {tag}
          <button type="button" onClick={() => onChange(tags.filter((tg) => tg !== tag))}
            className="hover:opacity-60 leading-none text-sm">×</button>
        </span>
      ))}
      <input
        value={input}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => input.trim() && commit()}
        placeholder={tags.length === 0 ? placeholder : ''}
        className="flex-1 min-w-[100px] text-xs bg-transparent outline-none text-on-surface placeholder:text-on-surface-variant py-0.5"
      />
    </div>
  );
}

// ── Field error helper ─────────────────────────────────────────────────────────

function FieldError({ msg }: FieldErrorProps) {
  if (!msg) return null;
  return (
    <p className="text-xs font-semibold text-error mt-1 flex items-center gap-1">
      <Icon name="error_outline" size={12} />
      {msg}
    </p>
  );
}

// ── Benchmark bar ─────────────────────────────────────────────────────────────

function BenchmarkBar({ benchmarks, unit, t }: BenchmarkBarProps) {
  if (!benchmarks || !Object.keys(benchmarks).length) {
    return <p className="text-xs text-on-surface-variant italic">{t('templates.infoModal.noBenchmarks')}</p>;
  }
  const tiers = [
    { key: 'poor',        label: t('templates.infoModal.poor'),       color: '#ef4444', value: benchmarks.poor },
    { key: 'average',     label: t('templates.infoModal.average'),    color: '#f97316', value: benchmarks.average },
    { key: 'good',        label: t('templates.infoModal.good'),       color: '#84cc16', value: benchmarks.good },
    { key: 'excellent',   label: t('templates.infoModal.excellent'),  color: '#22c55e', value: benchmarks.excellent },
    { key: 'world_class', label: t('templates.infoModal.worldClass'), color: '#15803d', value: benchmarks.world_class },
  ].filter((tier) => tier.value !== undefined && tier.value !== null);

  return (
    <div>
      <div className="flex rounded-full overflow-hidden h-2 mb-2.5">
        {tiers.map((tier) => (
          <div key={tier.key} className="flex-1" style={{ background: tier.color }} />
        ))}
      </div>
      <div className="flex justify-between">
        {tiers.map((tier) => (
          <div key={tier.key} className="flex flex-col items-center gap-0.5" style={{ flex: 1 }}>
            <span className="text-[10px] font-extrabold leading-none" style={{ color: tier.color }}>
              {tier.value}{unit ? '' : ''}
            </span>
            <span className="text-[9px] text-on-surface-variant leading-none">{tier.label}</span>
          </div>
        ))}
      </div>
      {unit && (
        <p className="text-[9px] text-on-surface-variant mt-1.5 text-right">{unit}</p>
      )}
    </div>
  );
}

// ── Info Modal ─────────────────────────────────────────────────────────────────

function InfoModal({ template, onClose, onUseClick }: InfoModalProps) {
  const { t } = useTranslation();
  const cat = SURVEY_CATEGORIES.find((c) => c.id === template.category);
  const intel = (template.intelligence || {}) as Record<string, unknown>;
  const scoring = (template.scoring || {}) as Record<string, unknown>;
  const scoringMethod = scoring.method as string | undefined;
  const scoringLabel = scoringMethod ? ((SCORING_METHOD_LABELS as Record<string, string>)[scoringMethod] || scoringMethod) : null;
  const sampleQuestions = (template.questions || []).slice(0, 3);

  return (
    <ModalShell onClose={onClose} maxWidth="max-w-2xl">
      {/* Hero banner */}
      <div className="relative px-6 pt-6 pb-5 rounded-t-2xl"
        style={{ background: `linear-gradient(135deg, ${template.bg || '#e0e7ff'}, ${(template.bg || '#e0e7ff')}cc)` }}>
        <button onClick={onClose}
          className="absolute top-4 right-4 w-8 h-8 rounded-xl flex items-center justify-center text-on-surface-variant hover:bg-black/10 transition-colors">
          <Icon name="close" size={18} />
        </button>
        <div className="flex items-start gap-4">
          <div className="w-14 h-14 rounded-2xl flex items-center justify-center flex-shrink-0"
            style={{ background: template.color || 'var(--color-primary)', boxShadow: `0 8px 24px color-mix(in srgb, ${template.color || 'var(--color-primary)'} 27%, transparent)` }}>
            <Icon name={template.icon || 'quiz'} fill={1} size={26} className="text-white" />
          </div>
          <div className="flex-1 min-w-0 pr-8">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <h2 className="text-lg font-extrabold font-headline text-on-surface leading-tight">{template.label}</h2>
              <span className="text-[10px] font-black px-2 py-0.5 rounded-full"
                style={{ background: `color-mix(in srgb, ${template.color || 'var(--color-primary)'} 13%, transparent)`, color: template.color || 'var(--color-primary)' }}>
                {template.shortLabel}
              </span>
              {cat && (
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full"
                  style={{ background: cat.color + '20', color: cat.color }}>
                  {cat.label}
                </span>
              )}
            </div>
            {/* At-a-glance pills */}
            <div className="flex items-center gap-2 flex-wrap">
              <span className="flex items-center gap-1 text-[11px] font-semibold text-on-surface-variant">
                <Icon name="help_outline" size={12} />
                {t('templates.infoModal.questionCount', { n: template.questionCount || (template.questions || []).length })}
              </span>
              <span className="text-on-surface-variant opacity-30 text-xs">·</span>
              <span className="flex items-center gap-1 text-[11px] font-semibold text-on-surface-variant">
                <Icon name="schedule" size={12} />
                {t('templates.infoModal.estimatedTime', { n: template.estimatedMinutes || 0 })}
              </span>
              {scoringLabel && (
                <>
                  <span className="text-on-surface-variant opacity-30 text-xs">·</span>
                  <span className="flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full"
                    style={{ background: `color-mix(in srgb, ${template.color || 'var(--color-primary)'} 9%, transparent)`, color: template.color || 'var(--color-primary)' }}>
                    <Icon name="analytics" size={11} />
                    {scoringLabel}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Scrollable body */}
      <div className="px-6 py-5 space-y-5 max-h-[60vh] overflow-y-auto">

        {/* What it measures */}
        <div>
          <h3 className="text-xs font-black uppercase tracking-widest text-on-surface-variant mb-2">
            {t('templates.infoModal.whatItMeasures')}
          </h3>
          <p className="text-sm text-on-surface leading-relaxed mb-3">{template.description}</p>
          {(template.metrics || []).length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {(template.metrics || []).map((m) => (
                <span key={m} className="text-[10px] font-bold px-2.5 py-1 rounded-full"
                  style={{ background: `color-mix(in srgb, ${template.color || 'var(--color-primary)'} 8%, transparent)`, color: template.color || 'var(--color-primary)' }}>
                  {m}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Benchmarks */}
        {!!scoring.benchmarks && Object.keys(scoring.benchmarks as object).length > 0 && (
          <div>
            <h3 className="text-xs font-black uppercase tracking-widest text-on-surface-variant mb-3">
              {t('templates.infoModal.benchmarks')}
            </h3>
            <BenchmarkBar benchmarks={scoring.benchmarks as BenchmarkValues} unit={scoring.unit as string | undefined} t={t} />
          </div>
        )}

        {/* AI Intelligence */}
        {!!(intel.scoringNarrative || intel.audienceDescription || intel.customInstructions) && (
          <div className="rounded-xl p-4" style={{ background: '#f8f9ff', border: '1.5px solid #e0e7ff' }}>
            <h3 className="text-xs font-black uppercase tracking-widest mb-3 flex items-center gap-1.5"
              style={{ color: 'var(--color-primary)' }}>
              <Icon name="psychology" size={14} />
              {t('templates.infoModal.aiIntelligence')}
            </h3>
            <div className="space-y-3">
              {!!intel.scoringNarrative && (
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-wide text-on-surface-variant mb-1">
                    {t('templates.infoModal.scoringNarrativeLabel')}
                  </p>
                  <p className="text-xs text-on-surface leading-relaxed">{intel.scoringNarrative as string}</p>
                </div>
              )}
              {!!intel.audienceDescription && (
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-wide text-on-surface-variant mb-1">
                    {t('templates.infoModal.audienceLabel')}
                  </p>
                  <p className="text-xs text-on-surface leading-relaxed">{intel.audienceDescription as string}</p>
                </div>
              )}
              {!!intel.customInstructions && (
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-wide text-on-surface-variant mb-1">
                    {t('templates.infoModal.customInstructionsLabel')}
                  </p>
                  <p className="text-xs text-on-surface leading-relaxed font-mono bg-white rounded-lg px-2.5 py-2"
                    style={{ border: '1px solid #e0e7ff' }}>
                    {intel.customInstructions as string}
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Sample questions */}
        {sampleQuestions.length > 0 && (
          <div>
            <h3 className="text-xs font-black uppercase tracking-widest text-on-surface-variant mb-2.5">
              {t('templates.infoModal.sampleQuestions')}
            </h3>
            <div className="space-y-2">
              {sampleQuestions.map((q, i) => (
                <div key={q.id || i} className="flex items-start gap-2.5 px-3 py-2.5 rounded-xl"
                  style={{ background: '#f5f6f7' }}>
                  <span className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-black flex-shrink-0 mt-0.5"
                    style={{ background: `color-mix(in srgb, ${template.color || 'var(--color-primary)'} 9%, transparent)`, color: template.color || 'var(--color-primary)' }}>
                    {i + 1}
                  </span>
                  <span className="text-xs text-on-surface leading-relaxed">{q.question}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Tags */}
        {(template.tags || []).length > 0 && (
          <div>
            <h3 className="text-xs font-black uppercase tracking-widest text-on-surface-variant mb-2">
              {t('templates.infoModal.tagsLabel')}
            </h3>
            <div className="flex flex-wrap gap-1.5">
              {(template.tags || []).map((tag) => (
                <span key={tag} className="text-[10px] font-bold px-2.5 py-1 rounded-full bg-muted text-muted-foreground">
                  {tag}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* CTA Footer */}
      <div className="px-6 py-4 border-t" style={{ borderColor: '#f0f2f4' }}>
        <Button size="sm"
          onClick={() => { onUseClick(template); onClose(); }}
          className="w-full rounded-xl font-bold text-sm text-white gap-2 py-2.5"
          style={{ background: template.color || 'var(--color-primary)' }}>
          <Icon name="arrow_forward" size={16} />
          {t('templates.infoModal.useButton')}
        </Button>
      </div>
    </ModalShell>
  );
}

// ── Template Create / Edit Modal ───────────────────────────────────────────────

interface TemplateFormState {
  label: string;
  shortLabel: string;
  description: string;
  category: string;
  tags: string[];
  intelligence: {
    scoringNarrative: string;
    audienceDescription: string;
    customInstructions: string;
  };
}

type FormErrors = Partial<Record<string, string>>;

function TemplateModal({ template, categories, onSave, onClose }: TemplateModalProps) {
  const { t } = useTranslation();
  const templateIntel = template?.intelligence as Record<string, unknown> | null | undefined;
  const [form, setForm] = useState<TemplateFormState>({
    label:       template?.label       || '',
    shortLabel:  template?.shortLabel  || '',
    description: template?.description || '',
    category:    template?.category    || 'cx',
    tags:        template?.tags        || [],
    intelligence: {
      scoringNarrative:    (templateIntel?.scoringNarrative    as string) || '',
      audienceDescription: (templateIntel?.audienceDescription as string) || '',
      customInstructions:  (templateIntel?.customInstructions  as string) || '',
    },
  });
  const [errors, setErrors] = useState<FormErrors>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [aiOpen, setAiOpen] = useState(false);

  function set<K extends keyof TemplateFormState>(key: K, val: TemplateFormState[K]) {
    setForm((f) => ({ ...f, [key]: val }));
    if (errors[key]) setErrors((e) => ({ ...e, [key]: '' }));
  }

  function setIntel(key: keyof TemplateFormState['intelligence'], val: string) {
    setForm((f) => ({ ...f, intelligence: { ...f.intelligence, [key]: val } }));
  }

  function validate(): FormErrors {
    const errs: FormErrors = {};
    const label = form.label.trim();
    const shortLabel = form.shortLabel.trim();
    const desc = form.description.trim();

    if (!label)              errs.label       = t('templates.modal.errors.labelRequired');
    else if (label.length < 2) errs.label      = t('templates.modal.errors.labelTooShort');

    if (!shortLabel)               errs.shortLabel = t('templates.modal.errors.shortLabelRequired');
    else if (shortLabel.length > 12) errs.shortLabel = t('templates.modal.errors.shortLabelTooLong');

    if (!desc)               errs.description = t('templates.modal.errors.descriptionRequired');
    else if (desc.length < 10) errs.description = t('templates.modal.errors.descriptionTooShort');

    return errs;
  }

  async function handleSave() {
    const errs = validate();
    if (Object.keys(errs).length) { setErrors(errs); return; }
    setSaving(true);
    setSaveError('');
    try {
      await onSave({ ...template, ...form });
    } catch (err) {
      setSaveError((err as Error).message || t('templates.modal.errors.saveFailed'));
      setSaving(false);
    }
  }

  const nonAllCats = categories.filter((c) => c.id !== 'all');

  return (
    <ModalShell onClose={onClose} maxWidth="max-w-lg">
      {/* Header */}
      <div className="flex items-center justify-between px-6 pt-6 pb-2">
        <div>
          <h2 className="text-lg font-extrabold font-headline text-on-surface">
            {template?.id ? t('templates.modal.editHeading') : t('templates.modal.createHeading')}
          </h2>
          {!template?.id && (
            <p className="text-xs text-on-surface-variant mt-0.5">
              {t('templates.modal.createSubheading')}
            </p>
          )}
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} className="w-8 h-8 rounded-xl text-on-surface-variant">
          <Icon name="close" size={18} />
        </Button>
      </div>

      <div className="px-6 pb-6 space-y-4 mt-4 max-h-[70vh] overflow-y-auto">
        {/* Label */}
        <div>
          <label className="block text-xs font-bold text-on-surface-variant mb-1.5">
            {t('templates.modal.labelPlaceholder')} <span className="text-error">*</span>
          </label>
          <Input
            value={form.label}
            onChange={(e) => set('label', e.target.value)}
            placeholder="e.g., Customer Onboarding NPS"
            className={`w-full text-sm font-semibold bg-surface-container-low rounded-[10px] focus-visible:ring-0 focus-visible:ring-offset-0 ${errors.label ? 'border-error' : 'border-0'}`}
            style={errors.label ? { borderColor: '#b41340', borderWidth: '1.5px' } : {}}
          />
          <FieldError msg={errors.label} />
        </div>

        {/* Short label */}
        <div>
          <label className="block text-xs font-bold text-on-surface-variant mb-1.5">
            {t('templates.modal.shortLabelPlaceholder')} <span className="text-error">*</span>
          </label>
          <div className="relative">
            <Input
              value={form.shortLabel}
              onChange={(e) => set('shortLabel', e.target.value)}
              placeholder="e.g., Onboarding NPS"
              maxLength={12}
              className={`w-full text-sm bg-surface-container-low rounded-[10px] focus-visible:ring-0 focus-visible:ring-offset-0 pr-12 ${errors.shortLabel ? 'border-error' : 'border-0'}`}
              style={errors.shortLabel ? { borderColor: '#b41340', borderWidth: '1.5px' } : {}}
            />
            <span className={`absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-bold ${form.shortLabel.length > 12 ? 'text-error' : 'text-on-surface-variant'}`}>
              {form.shortLabel.length}/12
            </span>
          </div>
          <FieldError msg={errors.shortLabel} />
        </div>

        {/* Description */}
        <div>
          <label className="block text-xs font-bold text-on-surface-variant mb-1.5">
            {t('templates.modal.descriptionPlaceholder')} <span className="text-error">*</span>
          </label>
          <textarea
            value={form.description}
            onChange={(e) => set('description', e.target.value)}
            placeholder="Describe what this template measures and when to use it…"
            rows={3}
            className="w-full resize-none text-sm bg-surface-container-low rounded-xl px-3 py-2.5 outline-none text-on-surface placeholder:text-on-surface-variant"
            style={errors.description ? { border: '1.5px solid #b41340' } : { border: '1.5px solid transparent', background: '#f5f6f7' }}
          />
          <div className="flex items-start justify-between mt-0.5">
            <FieldError msg={errors.description} />
            <span className="text-[10px] text-on-surface-variant ml-auto">
              {form.description.length} chars
            </span>
          </div>
        </div>

        {/* Category */}
        <div>
          <label className="block text-xs font-bold text-on-surface-variant mb-2">
            {t('templates.modal.categoryLabel')} <span className="text-error">*</span>
          </label>
          <div className="flex flex-wrap gap-1.5">
            {nonAllCats.map((cat) => (
              <button
                key={cat.id}
                type="button"
                onClick={() => set('category', cat.id)}
                className="flex items-center gap-1 text-xs font-bold px-2.5 py-1.5 rounded-full transition-all"
                style={{
                  background: form.category === cat.id ? cat.color : '#f0f2f4',
                  color: form.category === cat.id ? '#fff' : '#595c5e',
                  boxShadow: form.category === cat.id ? `0 3px 8px ${cat.color}44` : 'none',
                }}
              >
                <Icon name={cat.icon} size={11} />
                {cat.shortLabel}
              </button>
            ))}
          </div>
        </div>

        {/* Tags */}
        <div>
          <label className="block text-xs font-bold text-on-surface-variant mb-1.5">
            {t('templates.modal.tagsLabel')}
            <span className="ml-1 font-normal opacity-60">(optional)</span>
          </label>
          <TagInput
            tags={form.tags}
            onChange={(tags) => set('tags', tags)}
            placeholder={t('templates.modal.tagsPlaceholder')}
          />
          <p className="text-[10px] text-on-surface-variant mt-1">
            {t('templates.modal.tagsHint')}
          </p>
        </div>

        {/* AI Intelligence accordion */}
        <div className="rounded-xl overflow-hidden" style={{ border: '1.5px solid #e0e7ff' }}>
          <button
            type="button"
            onClick={() => setAiOpen((v) => !v)}
            className="w-full flex items-center justify-between px-4 py-3 text-left transition-colors hover:bg-[#f8f9ff]"
            style={{ background: aiOpen ? '#f8f9ff' : '#fafbff' }}
          >
            <span className="flex items-center gap-2 text-xs font-bold" style={{ color: 'var(--color-primary)' }}>
              <Icon name="psychology" size={14} />
              {t('templates.modal.aiSettings.sectionLabel')}
            </span>
            <Icon name={aiOpen ? 'expand_less' : 'expand_more'} size={16} className="text-on-surface-variant" />
          </button>
          {aiOpen && (
            <div className="px-4 pb-4 pt-2 space-y-3" style={{ background: '#f8f9ff' }}>
              <p className="text-[10px] text-on-surface-variant">{t('templates.modal.aiSettings.sectionHint')}</p>
              <div>
                <label className="block text-[10px] font-bold text-on-surface-variant mb-1">
                  {t('templates.modal.aiSettings.scoringNarrativeLabel')}
                </label>
                <textarea
                  value={form.intelligence.scoringNarrative}
                  onChange={(e) => setIntel('scoringNarrative', e.target.value)}
                  placeholder={t('templates.modal.aiSettings.scoringNarrativePlaceholder')}
                  rows={3}
                  className="w-full resize-none text-xs bg-white rounded-xl px-3 py-2.5 outline-none text-on-surface placeholder:text-on-surface-variant"
                  style={{ border: '1.5px solid #e0e7ff' }}
                />
              </div>
              <div>
                <label className="block text-[10px] font-bold text-on-surface-variant mb-1">
                  {t('templates.modal.aiSettings.audienceDescriptionLabel')}
                </label>
                <textarea
                  value={form.intelligence.audienceDescription}
                  onChange={(e) => setIntel('audienceDescription', e.target.value)}
                  placeholder={t('templates.modal.aiSettings.audienceDescriptionPlaceholder')}
                  rows={3}
                  className="w-full resize-none text-xs bg-white rounded-xl px-3 py-2.5 outline-none text-on-surface placeholder:text-on-surface-variant"
                  style={{ border: '1.5px solid #e0e7ff' }}
                />
              </div>
              <div>
                <label className="block text-[10px] font-bold text-on-surface-variant mb-1">
                  {t('templates.modal.aiSettings.customInstructionsLabel')}
                </label>
                <textarea
                  value={form.intelligence.customInstructions}
                  onChange={(e) => setIntel('customInstructions', e.target.value)}
                  placeholder={t('templates.modal.aiSettings.customInstructionsPlaceholder')}
                  rows={3}
                  className="w-full resize-none text-xs bg-white rounded-xl px-3 py-2.5 outline-none text-on-surface placeholder:text-on-surface-variant font-mono"
                  style={{ border: '1.5px solid #e0e7ff' }}
                />
              </div>
            </div>
          )}
        </div>

        {/* Save error */}
        {saveError && (
          <div className="flex items-start gap-2 px-3 py-2.5 rounded-xl" style={{ background: '#fff0f0' }}>
            <Icon name="error_outline" fill={1} size={16} className="text-error flex-shrink-0 mt-0.5" />
            <p className="text-xs font-semibold text-error">{saveError}</p>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex gap-3 px-6 pb-6">
        <Button onClick={onClose} disabled={saving}
          className="flex-1 rounded-xl font-bold text-sm"
          style={{ background: '#f0f2f4', color: '#595c5e' }}>
          {t('common.cancel')}
        </Button>
        <Button
          onClick={handleSave}
          disabled={saving}
          className="flex-1 rounded-xl font-bold text-sm text-white"
          style={{ background: saving ? '#94a3b8' : 'var(--color-primary)' }}
        >
          {saving ? (
            <span className="flex items-center justify-center gap-2">
              <span className="w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
              {t('common.saving')}
            </span>
          ) : t('templates.modal.saveButton')}
        </Button>
      </div>
    </ModalShell>
  );
}

// ── Template Card ─────────────────────────────────────────────────────────────

function TemplateCard({ template, onUseClick, onEdit, onDelete, onInfoClick }: TemplateCardProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <div
      className="relative flex flex-col rounded-2xl p-5 bg-white transition-all duration-200 hover:shadow-lg cursor-pointer"
      style={{
        border: '1.5px solid #eef1f3',
        boxShadow: '0 2px 12px rgba(0,0,0,0.04)',
        minHeight: '220px',
        transition: 'box-shadow 0.2s, transform 0.15s',
      }}
      onClick={() => onInfoClick(template)}
      onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-1px)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.transform = 'translateY(0)'; }}
    >
      {/* Type badge */}
      <div className="absolute top-3 right-3">
        {template.isSystem ? (
          <Badge className="text-[10px] font-black uppercase tracking-widest border-0 px-2 py-0.5"
            style={{ background: `color-mix(in srgb, ${template.color || 'var(--color-primary)'} 9%, transparent)`, color: template.color || 'var(--color-primary)' }}>
            {t('templates.systemBadge')}
          </Badge>
        ) : template.clonedFromId ? (
          <Badge className="text-[10px] font-black uppercase tracking-widest border-0 px-2 py-0.5"
            style={{ background: '#fef3c7', color: '#d97706' }}>
            {t('templates.clonedBadge')}
          </Badge>
        ) : (
          <Badge className="text-[10px] font-black uppercase tracking-widest border-0 px-2 py-0.5"
            style={{ background: '#d1fae5', color: '#059669' }}>
            {t('templates.customBadge')}
          </Badge>
        )}
      </div>

      {/* Icon */}
      <div className="w-11 h-11 rounded-xl flex items-center justify-center mb-3 flex-shrink-0"
        style={{ background: template.bg || '#e0e7ff', color: template.color || 'var(--color-primary)' }}>
        <Icon name={template.icon || 'quiz'} fill={1} size={22} />
      </div>

      {/* Label + short label */}
      <div className="flex items-center gap-2 mb-1 flex-wrap pr-16">
        <span className="text-sm font-extrabold font-headline leading-tight text-on-surface">
          {template.label}
        </span>
        <span className="text-[10px] font-black px-2 py-0.5 rounded-full flex-shrink-0"
          style={{ background: `color-mix(in srgb, ${template.color || 'var(--color-primary)'} 10%, transparent)`, color: template.color || 'var(--color-primary)' }}>
          {template.shortLabel}
        </span>
      </div>

      {/* Description */}
      <p className="text-xs leading-relaxed mb-3 flex-1 text-on-surface-variant"
        style={{ display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2, overflow: 'hidden' } as React.CSSProperties}>
        {template.description}
      </p>

      {/* Metrics */}
      {(template.metrics || []).length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-3">
          {(template.metrics || []).slice(0, 3).map((m) => (
            <span key={m} className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
              {m}
            </span>
          ))}
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between mt-auto pt-3 border-t" style={{ borderColor: '#f0f2f4' }}>
        <span className="text-[10px] text-on-surface-variant font-semibold flex items-center gap-1">
          <Icon name="help_outline" size={12} />
          {template.questionCount || (template.questions || []).length}q
          <span className="mx-1 opacity-40">·</span>
          <Icon name="schedule" size={12} />
          {template.estimatedMinutes || 0}m
        </span>
        <div className="flex items-center gap-1">
          {template.isSystem ? (
            <Button size="sm"
              onClick={(e) => { e.stopPropagation(); navigate(ROUTES.TEMPLATE_EDITOR, { state: { fromTemplate: template } }); }}
              className="text-xs font-bold rounded-full px-3 h-7 gap-1"
              style={{ background: '#f0f2f4', color: '#595c5e' }}>
              <Icon name="content_copy" size={12} />
              {t('templates.customizeButton')}
            </Button>
          ) : (
            <>
              <Button variant="ghost" size="icon"
                onClick={(e) => { e.stopPropagation(); onEdit(template); }}
                className="w-7 h-7 rounded-lg text-on-surface-variant hover:text-on-surface">
                <Icon name="edit" size={14} />
              </Button>
              <Button variant="ghost" size="icon"
                onClick={(e) => { e.stopPropagation(); onDelete(template); }}
                className="w-7 h-7 rounded-lg text-error hover:bg-[#fff0f0]">
                <Icon name="delete" size={14} />
              </Button>
            </>
          )}
          <Button size="sm"
            onClick={(e) => { e.stopPropagation(); onUseClick(template); }}
            className="text-xs font-bold rounded-full px-3 h-7 text-white gap-1"
            style={{ background: template.color || 'var(--color-primary)' }}>
            <Icon name="arrow_forward" size={12} />
            {t('templates.useButton')}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export function TemplateLibraryPage() {
  const { t } = useTranslation();
  useSetPageTitle(t('templates.pageTitle'), t('templates.pageSubtitle'));
  const navigate = useNavigate();
  const api = useApi();

  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [catSearch, setCatSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState('all');

  // Modal states
  const [editModal, setEditModal] = useState<(Partial<Template> & { isNew?: boolean }) | null>(null);
  const [useModal, setUseModal] = useState<Template | null>(null);
  const [deleteModal, setDeleteModal] = useState<Template | null>(null);
  const [infoModal, setInfoModal] = useState<Template | null>(null);

  const loadTemplates = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.listTemplates();
      setTemplates(data.templates || []);
    } catch (err) {
      setError(t('templates.errorLoading', { message: (err as Error).message }));
    } finally {
      setLoading(false);
    }
  }, [api]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { loadTemplates(); }, [loadTemplates]);

  // Derived lists
  const systemTemplates = useMemo(() => templates.filter((tmpl) => tmpl.isSystem), [templates]);
  const orgTemplates    = useMemo(() => templates.filter((tmpl) => !tmpl.isSystem), [templates]);

  const searchFiltered = useMemo(() => {
    if (!search.trim()) return templates;
    const q = search.toLowerCase();
    return templates.filter((tmpl) =>
      tmpl.label.toLowerCase().includes(q) ||
      (tmpl.shortLabel || '').toLowerCase().includes(q) ||
      (tmpl.description || '').toLowerCase().includes(q) ||
      (tmpl.tags || []).some((tag) => tag.includes(q)),
    );
  }, [templates, search]);

  const visibleCategories = useMemo(() => {
    if (!catSearch.trim()) return SURVEY_CATEGORIES;
    const q = catSearch.toLowerCase();
    return SURVEY_CATEGORIES.filter(
      (c) => c.id === 'all' || c.label.toLowerCase().includes(q) || c.shortLabel.toLowerCase().includes(q),
    );
  }, [catSearch]);

  function applyFilters(list: Template[]) {
    const base = activeCategory === 'all' ? list : list.filter((tmpl) => tmpl.category === activeCategory);
    if (!search.trim()) return base;
    const q = search.toLowerCase();
    return base.filter((tmpl) =>
      tmpl.label.toLowerCase().includes(q) ||
      (tmpl.shortLabel || '').toLowerCase().includes(q) ||
      (tmpl.description || '').toLowerCase().includes(q) ||
      (tmpl.tags || []).some((tag) => tag.includes(q)),
    );
  }

  const filteredSystem = useMemo(() => applyFilters(systemTemplates), [systemTemplates, activeCategory, search]); // eslint-disable-line react-hooks/exhaustive-deps
  const filteredOrg    = useMemo(() => applyFilters(orgTemplates),    [orgTemplates, activeCategory, search]);    // eslint-disable-line react-hooks/exhaustive-deps

  // Handlers
  async function handleSave(formData: Partial<Template> & { isNew?: boolean }) {
    if (formData.id && !formData.isSystem) {
      await api.updateTemplate(formData.id, formData);
      setTemplates((prev) => prev.map((tmpl) => (tmpl.id === formData.id ? { ...tmpl, ...formData } as Template : tmpl)));
    } else {
      const data = await api.createTemplate(formData) as { template: Template };
      setTemplates((prev) => [...prev, data.template]);
    }
    setEditModal(null);
  }

  async function handleDelete(id: string) {
    await api.deleteTemplate(id);
    setTemplates((prev) => prev.filter((tmpl) => tmpl.id !== id));
    setDeleteModal(null);
  }

  const hasResults = filteredSystem.length > 0 || filteredOrg.length > 0;

  return (
    <>
        <div className="max-w-7xl mx-auto w-full">

          <PageHeader
            crumbs={[{ label: t('nav.templates'), path: ROUTES.TEMPLATES }]}
            title={t('templates.pageTitle')}
            subtitle={t('templates.systemLibraryDescription', { n: filteredSystem.length + filteredOrg.length })}
            actions={
              <Button
                onClick={() => setEditModal({ isNew: true })}
                className="flex items-center gap-2 font-bold text-sm text-white rounded-xl px-5 py-2.5"
                style={{ background: 'var(--color-primary)' }}
              >
                <Icon name="add" size={18} />
                {t('templates.createButton')}
              </Button>
            }
          />

          {/* Search */}
          <div className="flex flex-col gap-3 mb-8">
            <div className="relative">
              <Icon name="search" size={18}
                className="absolute left-4 top-1/2 -translate-y-1/2 text-on-surface-variant pointer-events-none" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('templates.searchPlaceholder')}
                className="w-full pl-11 pr-10 py-3 text-sm rounded-[10px] bg-white text-on-surface font-body"
                style={{ border: '1.5px solid #eef1f3', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}
              />
              {search && (
                <Button onClick={() => setSearch('')} variant="ghost" size="icon"
                  className="absolute right-3 top-1/2 -translate-y-1/2 p-1 rounded-full w-auto h-auto text-muted-foreground">
                  <Icon name="close" size={16} />
                </Button>
              )}
            </div>

            {/* Category filter input */}
            <div className="relative">
              <Icon name="filter_list" size={14}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant pointer-events-none" />
              <input
                type="text"
                value={catSearch}
                onChange={(e) => setCatSearch(e.target.value)}
                placeholder={t('templates.categoryFilterPlaceholder')}
                className="w-full pl-8 pr-8 py-2 text-xs rounded-xl text-on-surface font-body outline-none"
                style={{ background: '#f5f6f7', border: '1px solid #eef1f3' }}
              />
              {catSearch && (
                <button onClick={() => setCatSearch('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-on-surface">
                  <Icon name="close" size={13} />
                </button>
              )}
            </div>

            {/* Category pills */}
            <div className="flex gap-2 overflow-x-auto pb-1" style={{ scrollbarWidth: 'none' }}>
              {visibleCategories.map((cat) => {
                const isActive = activeCategory === cat.id;
                const matchCount = cat.id === 'all'
                  ? searchFiltered.length
                  : searchFiltered.filter((tmpl) => tmpl.category === cat.id).length;
                const isZero = cat.id !== 'all' && !!search.trim() && matchCount === 0;
                return (
                  <button
                    key={cat.id}
                    onClick={() => !isZero && setActiveCategory(cat.id)}
                    disabled={isZero}
                    className="flex items-center gap-1.5 px-4 py-2 rounded-full text-xs font-bold transition-all flex-shrink-0"
                    style={{
                      background: isActive ? cat.color : '#ffffff',
                      color: isActive ? '#ffffff' : '#595c5e',
                      border: isActive ? `1.5px solid ${cat.color}` : '1.5px solid #eef1f3',
                      boxShadow: isActive ? `0 4px 12px ${cat.color}33` : 'none',
                      opacity: isZero ? 0.3 : 1,
                      cursor: isZero ? 'not-allowed' : 'pointer',
                    }}
                  >
                    <span style={{ color: isActive ? '#ffffff' : cat.color, display: 'flex' }}>
                      <Icon name={cat.icon} size={14} />
                    </span>
                    {cat.shortLabel}
                    <span className="text-[10px] opacity-70 ml-0.5">({matchCount})</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Error state */}
          {error && (
            <div className="mb-6 flex items-start gap-3 px-4 py-3 rounded-xl" style={{ background: '#fff0f0' }}>
              <Icon name="error_outline" fill={1} size={18} className="text-error flex-shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="text-sm font-semibold text-error">{error}</p>
              </div>
              <Button variant="ghost" size="sm" onClick={loadTemplates}
                className="text-xs font-bold text-error rounded-lg px-2 py-1 h-auto">
                {t('common.refresh')}
              </Button>
            </div>
          )}

          {/* Loading */}
          {loading ? (
            <div className="flex flex-col items-center justify-center py-24 gap-4">
              <div className="w-10 h-10 rounded-full border-2 animate-spin"
                style={{ borderColor: 'color-mix(in srgb, var(--color-primary) 15%, transparent)', borderTopColor: 'var(--color-primary)' }} />
              <p className="text-sm font-semibold text-on-surface-variant">{t('common.loading')}</p>
            </div>
          ) : !hasResults ? (
            <div className="flex flex-col items-center justify-center py-24 gap-4">
              <div className="w-14 h-14 rounded-2xl flex items-center justify-center bg-surface-container">
                <Icon name="search_off" size={28} className="text-on-surface-variant" />
              </div>
              <p className="text-sm font-semibold text-on-surface-variant">{t('templates.noResults')}</p>
              <Button onClick={() => setSearch('')} variant="secondary" size="sm"
                className="text-xs font-bold px-4 py-2 rounded-full"
                style={{ background: '#e0e7ff', color: 'var(--color-primary)' }}>
                {t('templates.clearSearch')}
              </Button>
            </div>
          ) : (
            <div className="space-y-10">
              {/* Experient Library */}
              {filteredSystem.length > 0 && (
                <section>
                  <div className="mb-4">
                    <h2 className="text-lg font-extrabold font-headline text-on-surface">
                      {t('templates.systemLibraryHeading')}
                    </h2>
                    <p className="text-sm text-on-surface-variant mt-0.5">
                      {t('templates.systemLibraryDescription', { n: filteredSystem.length })}
                    </p>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '12px' }}>
                    {filteredSystem.map((tmpl) => (
                      <TemplateCard
                        key={tmpl.id}
                        template={tmpl}
                        onUseClick={setUseModal}
                        onInfoClick={setInfoModal}
                        onEdit={() => {}}
                        onDelete={() => {}}
                      />
                    ))}
                  </div>
                </section>
              )}

              {/* Your Templates */}
              <section id="org-templates">
                <div className="mb-4">
                  <h2 className="text-lg font-extrabold font-headline text-on-surface">
                    {t('templates.orgLibraryHeading')}
                  </h2>
                  <p className="text-sm text-on-surface-variant mt-0.5">
                    {filteredOrg.length > 0
                      ? t('templates.orgLibraryDescription')
                      : t('templates.orgLibraryEmpty')}
                  </p>
                </div>
                {filteredOrg.length > 0 && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '12px' }}>
                    {filteredOrg.map((tmpl) => (
                      <TemplateCard
                        key={tmpl.id}
                        template={tmpl}
                        onUseClick={setUseModal}
                        onInfoClick={setInfoModal}
                        onEdit={(tpl) => setEditModal(tpl)}
                        onDelete={(tpl) => setDeleteModal(tpl)}
                      />
                    ))}
                  </div>
                )}
              </section>
            </div>
          )}
        </div>

      {/* Use modal */}
      {useModal && (
        <UseModal
          template={useModal}
          onClose={() => setUseModal(null)}
        />
      )}

      {/* Create / Edit modal */}
      {editModal !== null && (
        <TemplateModal
          template={editModal?.isNew ? null : editModal}
          categories={SURVEY_CATEGORIES}
          onSave={handleSave}
          onClose={() => setEditModal(null)}
        />
      )}

      {/* Delete modal */}
      {deleteModal && (
        <DeleteModal
          template={deleteModal}
          onDelete={handleDelete}
          onClose={() => setDeleteModal(null)}
        />
      )}

      {/* Info modal */}
      {infoModal && (
        <InfoModal
          template={infoModal}
          onClose={() => setInfoModal(null)}
          onUseClick={(tmpl) => { setInfoModal(null); setUseModal(tmpl); }}
        />
      )}
    </>
  );
}
