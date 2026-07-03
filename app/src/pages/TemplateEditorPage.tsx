import React, { useState, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { useSetPageTitle } from '../contexts/pageTitle';
import { useApi } from '../hooks/useApi';
import { ROUTES } from '../constants/routes';
import { SURVEY_CATEGORIES } from '../constants/surveyTypes';
import { QTYPE_META, QTYPE_GROUPS, createQuestion } from '../constants/questionTypes';
import { useTranslation } from '../lib/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { PageHeader } from '../components/PageHeader';
import type { Question, Template } from '../types';

// ── Prop interfaces ────────────────────────────────────────────────────────────

interface TagInputProps {
  tags: string[];
  onChange: (tags: string[]) => void;
  placeholder: string;
}

interface QuestionRowProps {
  question: Question;
  index: number;
  onUpdate: (patch: Partial<Question>) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  isFirst: boolean;
  isLast: boolean;
}

interface TypePickerProps {
  onSelect: (type: string) => void;
  onClose: () => void;
}

interface EditorFormState {
  label: string;
  shortLabel: string;
  description: string;
  category: string;
  icon: string;
  color: string;
  bg: string;
  tags: string[];
  intelligence: {
    scoringNarrative: string;
    audienceDescription: string;
    customInstructions: string;
  };
}

type EditorFormErrors = Partial<Record<string, string>>;

// ── Tag Input ─────────────────────────────────────────────────────────────────

function TagInput({ tags, onChange, placeholder }: TagInputProps) {
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
      style={{ background: '#f5f6f7', border: '1.5px solid #eef1f3' }}
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

// ── Question Row ──────────────────────────────────────────────────────────────

function QuestionRow({ question, index, onUpdate, onRemove, onMoveUp, onMoveDown, isFirst, isLast }: QuestionRowProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const meta = QTYPE_META[question.type] || { label: question.type, icon: 'help_outline', color: '#595c5e', bg: '#f5f6f7' };

  return (
    <div
      className="flex items-start gap-3 p-4 rounded-2xl bg-white transition-all"
      style={{ border: '1.5px solid #eef1f3', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}
    >
      {/* Drag handle / index */}
      <div className="flex flex-col items-center gap-1 pt-1 flex-shrink-0">
        <button
          onClick={onMoveUp}
          disabled={isFirst}
          className="w-5 h-5 rounded flex items-center justify-center text-on-surface-variant hover:text-on-surface disabled:opacity-20"
        >
          <Icon name="expand_less" size={14} />
        </button>
        <span className="text-[10px] font-black text-on-surface-variant">{index + 1}</span>
        <button
          onClick={onMoveDown}
          disabled={isLast}
          className="w-5 h-5 rounded flex items-center justify-center text-on-surface-variant hover:text-on-surface disabled:opacity-20"
        >
          <Icon name="expand_more" size={14} />
        </button>
      </div>

      {/* Type badge */}
      <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5"
        style={{ background: meta.bg, color: meta.color }}>
        <Icon name={meta.icon} fill={1} size={16} />
      </div>

      {/* Question body */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-[10px] font-black px-2 py-0.5 rounded-full"
            style={{ background: meta.bg, color: meta.color }}>
            {meta.label}
          </span>
          {question.required && (
            <span className="text-[10px] font-bold text-error uppercase">Required</span>
          )}
        </div>
        {editing ? (
          <input
            autoFocus
            value={question.question}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => onUpdate({ question: e.target.value })}
            onBlur={() => setEditing(false)}
            onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => e.key === 'Enter' && setEditing(false)}
            className="w-full text-sm font-semibold text-on-surface bg-surface-container-low rounded-lg px-2.5 py-1.5 outline-none"
            style={{ border: '1.5px solid var(--color-primary)' }}
          />
        ) : (
          <p
            className="text-sm font-semibold text-on-surface cursor-text leading-snug"
            onClick={() => setEditing(true)}
          >
            {question.question || <span className="text-on-surface-variant italic">{t('templates.editor.questionPlaceholder')}</span>}
          </p>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1 flex-shrink-0">
        <button
          onClick={() => onUpdate({ required: !question.required })}
          className="w-7 h-7 rounded-lg flex items-center justify-center transition-colors"
          style={{ color: question.required ? '#b41340' : '#abadb0' }}
          title={question.required ? 'Mark optional' : 'Mark required'}
        >
          <Icon name="star" fill={question.required ? 1 : 0} size={14} />
        </button>
        <button
          onClick={onRemove}
          className="w-7 h-7 rounded-lg flex items-center justify-center text-on-surface-variant hover:text-error hover:bg-[#fff0f0] transition-colors"
        >
          <Icon name="delete" size={14} />
        </button>
      </div>
    </div>
  );
}

// ── Type Picker ───────────────────────────────────────────────────────────────

function TypePicker({ onSelect, onClose }: TypePickerProps) {
  const { t } = useTranslation();

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(4px)' }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden"
        style={{ boxShadow: '0 40px 80px -20px color-mix(in srgb, var(--color-primary) 18%, transparent)' }}>
        <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: '#f0f2f4' }}>
          <h3 className="text-sm font-extrabold font-headline text-on-surface">{t('templates.editor.typePickerHeading')}</h3>
          <button onClick={onClose} className="w-7 h-7 rounded-lg flex items-center justify-center text-on-surface-variant hover:bg-surface-container">
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="p-4 max-h-[60vh] overflow-y-auto space-y-4">
          {QTYPE_GROUPS.map((group) => {
            const types = Object.entries(QTYPE_META).filter(([, m]) => m.group === group);
            return (
              <div key={group}>
                <p className="text-[10px] font-black uppercase tracking-widest text-on-surface-variant mb-2">{group}</p>
                <div className="grid grid-cols-2 gap-1.5">
                  {types.map(([type, meta]) => (
                    <button
                      key={type}
                      onClick={() => { onSelect(type); onClose(); }}
                      className="flex items-center gap-2.5 p-3 rounded-xl text-left transition-all hover:scale-[1.01]"
                      style={{ background: meta.bg, border: `1.5px solid ${meta.color}22` }}
                    >
                      <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
                        style={{ background: meta.color + '22', color: meta.color }}>
                        <Icon name={meta.icon} fill={1} size={15} />
                      </div>
                      <div>
                        <p className="text-xs font-bold text-on-surface leading-none mb-0.5">{meta.label}</p>
                        <p className="text-[10px] text-on-surface-variant">{meta.desc}</p>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export function TemplateEditorPage() {
  const { t } = useTranslation();
  useSetPageTitle(t('templates.editor.pageTitle'), t('templates.pageSubtitle'));
  const navigate = useNavigate();
  const location = useLocation();
  const api = useApi();

  const fromTemplate = (location.state?.fromTemplate || null) as Template | null;
  const fromSurvey   = (location.state?.fromSurvey   || null) as (Partial<Template> & { title?: string }) | null;
  const source = fromTemplate || fromSurvey;
  const sourceIntel = source?.intelligence as Record<string, unknown> | null | undefined;

  const [form, setForm] = useState<EditorFormState>({
    label:       source?.label || (fromSurvey as { title?: string } | null)?.title || '',
    shortLabel:  source?.shortLabel || '',
    description: source?.description || '',
    category:    source?.category || 'cx',
    icon:        source?.icon  || 'quiz',
    color:       source?.color || 'var(--color-primary)',
    bg:          source?.bg    || '#e0e7ff',
    tags:        source?.tags || [],
    intelligence: {
      scoringNarrative:    (sourceIntel?.scoringNarrative    as string) || '',
      audienceDescription: (sourceIntel?.audienceDescription as string) || '',
      customInstructions:  (sourceIntel?.customInstructions  as string) || '',
    },
  });

  const [questions, setQuestions] = useState<Question[]>(() =>
    (source?.questions || []).map((q) => ({
      ...q,
      id: q.id || `q_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    }))
  );

  const [errors, setErrors]   = useState<EditorFormErrors>({});
  const [saving, setSaving]   = useState(false);
  const [saveError, setSaveError] = useState('');
  const [aiOpen, setAiOpen]   = useState(false);
  const [typePicker, setTypePicker] = useState(false);

  function set<K extends keyof EditorFormState>(key: K, val: EditorFormState[K]) {
    setForm((f) => ({ ...f, [key]: val }));
    if (errors[key]) setErrors((e) => ({ ...e, [key]: '' }));
  }

  function setIntel(key: keyof EditorFormState['intelligence'], val: string) {
    setForm((f) => ({ ...f, intelligence: { ...f.intelligence, [key]: val } }));
  }

  function addQuestion(type: string) {
    setQuestions((prev) => [...prev, createQuestion(type) as Question]);
  }

  function updateQuestion(id: string, patch: Partial<Question>) {
    setQuestions((prev) => prev.map((q) => (q.id === id ? { ...q, ...patch } as Question : q)));
  }

  function removeQuestion(id: string) {
    setQuestions((prev) => prev.filter((q) => q.id !== id));
  }

  function moveQuestion(id: string, dir: number) {
    setQuestions((prev) => {
      const idx = prev.findIndex((q) => q.id === id);
      if (idx < 0) return prev;
      const next = [...prev];
      const swap = idx + dir;
      if (swap < 0 || swap >= next.length) return prev;
      [next[idx], next[swap]] = [next[swap], next[idx]];
      return next;
    });
  }

  function validate(): EditorFormErrors {
    const errs: EditorFormErrors = {};
    if (!form.label.trim()) errs.label = t('templates.editor.errors.labelRequired');
    if (!form.description.trim()) errs.description = t('templates.editor.errors.descriptionRequired');
    return errs;
  }

  const handleSave = useCallback(async () => {
    const errs = validate();
    if (Object.keys(errs).length) { setErrors(errs); return; }
    setSaving(true);
    setSaveError('');
    try {
      await api.createTemplate({
        ...form,
        questions,
        questionCount: String(questions.length),
        clonedFromId: fromTemplate?.id || null,
      });
      navigate(ROUTES.TEMPLATES);
    } catch (err) {
      setSaveError((err as Error).message || t('templates.editor.errors.saveFailed'));
      setSaving(false);
    }
  }, [form, questions, fromTemplate, api, navigate, t]); // eslint-disable-line react-hooks/exhaustive-deps

  const nonAllCats = SURVEY_CATEGORIES.filter((c) => c.id !== 'all');

  return (
    <>
        <div className="max-w-7xl mx-auto w-full">

          <PageHeader
            crumbs={[
              { label: t('nav.templates'), path: ROUTES.TEMPLATES },
              { label: t('templates.editor.pageTitle') }
            ]}
            title={t('templates.editor.pageTitle')}
          />

          <div className="max-w-3xl">

          {/* Back + heading */}
          <div className="flex items-center gap-3 mb-6">
            <Button variant="ghost" size="sm"
              onClick={() => navigate(ROUTES.TEMPLATES)}
              className="flex items-center gap-1.5 text-xs font-bold text-on-surface-variant px-0 hover:text-on-surface">
              <Icon name="arrow_back" size={16} />
              {t('templates.editor.backButton')}
            </Button>
          </div>

          {/* Source hint banner */}
          {(fromTemplate || fromSurvey) && (
            <div className="mb-6 flex items-start gap-3 px-4 py-3 rounded-xl"
              style={{ background: fromTemplate ? fromTemplate.bg || '#e0e7ff' : '#f5f6f7', border: `1.5px solid color-mix(in srgb, ${fromTemplate?.color || 'var(--color-primary)'} 13%, transparent)` }}>
              <Icon name={fromTemplate ? 'content_copy' : 'auto_awesome'} fill={1} size={18}
                style={{ color: fromTemplate?.color || 'var(--color-primary)', flexShrink: 0, marginTop: 1 }} />
              <p className="text-xs font-semibold text-on-surface leading-relaxed">
                {fromTemplate
                  ? t('templates.editor.fromTemplateHint', { label: fromTemplate.label })
                  : t('templates.editor.fromSurveyHint')}
              </p>
            </div>
          )}

          <div className="space-y-6">

            {/* ── Basics ── */}
            <div className="bg-white rounded-2xl p-6 space-y-5"
              style={{ border: '1.5px solid #eef1f3', boxShadow: '0 2px 12px rgba(0,0,0,0.04)' }}>
              <h2 className="text-sm font-extrabold font-headline text-on-surface">{t('templates.editor.detailsHeading')}</h2>

              {/* Label */}
              <div>
                <label className="block text-xs font-bold text-on-surface-variant mb-1.5">
                  {t('templates.editor.labelLabel')} <span className="text-error">*</span>
                </label>
                <Input
                  value={form.label}
                  onChange={(e) => set('label', e.target.value)}
                  placeholder={t('templates.editor.labelPlaceholder')}
                  className="w-full text-sm font-semibold bg-surface-container-low rounded-[10px] focus-visible:ring-0 focus-visible:ring-offset-0 border-0"
                  style={errors.label ? { border: '1.5px solid #b41340' } : {}}
                />
                {errors.label && (
                  <p className="text-xs font-semibold text-error mt-1 flex items-center gap-1">
                    <Icon name="error_outline" size={12} />{errors.label}
                  </p>
                )}
              </div>

              {/* Short label */}
              <div>
                <label className="block text-xs font-bold text-on-surface-variant mb-1.5">
                  {t('templates.editor.shortLabelLabel')}
                </label>
                <div className="relative">
                  <Input
                    value={form.shortLabel}
                    onChange={(e) => set('shortLabel', e.target.value)}
                    placeholder={t('templates.editor.shortLabelPlaceholder')}
                    maxLength={12}
                    className="w-full text-sm bg-surface-container-low rounded-[10px] focus-visible:ring-0 focus-visible:ring-offset-0 border-0 pr-12"
                  />
                  <span className={`absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-bold ${form.shortLabel.length > 12 ? 'text-error' : 'text-on-surface-variant'}`}>
                    {form.shortLabel.length}/12
                  </span>
                </div>
              </div>

              {/* Description */}
              <div>
                <label className="block text-xs font-bold text-on-surface-variant mb-1.5">
                  {t('templates.editor.descriptionLabel')} <span className="text-error">*</span>
                </label>
                <textarea
                  value={form.description}
                  onChange={(e) => set('description', e.target.value)}
                  placeholder={t('templates.editor.descriptionPlaceholder')}
                  rows={3}
                  className="w-full resize-none text-sm rounded-xl px-3 py-2.5 outline-none text-on-surface placeholder:text-on-surface-variant"
                  style={errors.description
                    ? { border: '1.5px solid #b41340', background: '#f5f6f7' }
                    : { border: '1.5px solid transparent', background: '#f5f6f7' }}
                />
                {errors.description && (
                  <p className="text-xs font-semibold text-error mt-1 flex items-center gap-1">
                    <Icon name="error_outline" size={12} />{errors.description}
                  </p>
                )}
              </div>

              {/* Category */}
              <div>
                <label className="block text-xs font-bold text-on-surface-variant mb-2">
                  {t('templates.editor.categoryLabel')}
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
                  {t('templates.editor.tagsLabel')}
                  <span className="ml-1 font-normal opacity-60">(optional)</span>
                </label>
                <TagInput
                  tags={form.tags}
                  onChange={(tags) => set('tags', tags)}
                  placeholder={t('templates.editor.tagsPlaceholder')}
                />
                <p className="text-[10px] text-on-surface-variant mt-1">{t('templates.editor.tagsHint')}</p>
              </div>
            </div>

            {/* ── Questions ── */}
            <div className="bg-white rounded-2xl p-6"
              style={{ border: '1.5px solid #eef1f3', boxShadow: '0 2px 12px rgba(0,0,0,0.04)' }}>
              <div className="flex items-center justify-between mb-5">
                <div>
                  <h2 className="text-sm font-extrabold font-headline text-on-surface">
                    {t('templates.editor.questionsHeading')}
                    {questions.length > 0 && (
                      <span className="ml-2 text-xs font-bold px-2 py-0.5 rounded-full"
                        style={{ background: '#e0e7ff', color: 'var(--color-primary)' }}>
                        {questions.length}
                      </span>
                    )}
                  </h2>
                </div>
                <Button size="sm"
                  onClick={() => setTypePicker(true)}
                  className="flex items-center gap-1.5 text-xs font-bold rounded-xl text-white"
                  style={{ background: 'var(--color-primary)' }}>
                  <Icon name="add" size={14} />
                  {t('templates.editor.addQuestion')}
                </Button>
              </div>

              {questions.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 gap-3 rounded-2xl"
                  style={{ background: '#f9fafb', border: '1.5px dashed #dfe3e6' }}>
                  <div className="w-12 h-12 rounded-2xl flex items-center justify-center"
                    style={{ background: '#e0e7ff' }}>
                    <Icon name="quiz" fill={1} size={22} style={{ color: 'var(--color-primary)' }} />
                  </div>
                  <p className="text-sm text-on-surface-variant text-center max-w-xs leading-relaxed">
                    {t('templates.editor.noQuestions')}
                  </p>
                  <Button size="sm" onClick={() => setTypePicker(true)}
                    className="text-xs font-bold rounded-xl text-white"
                    style={{ background: 'var(--color-primary)' }}>
                    <Icon name="add" size={14} className="mr-1" />
                    {t('templates.editor.addQuestion')}
                  </Button>
                </div>
              ) : (
                <div className="space-y-3">
                  {questions.map((q, idx) => (
                    <QuestionRow
                      key={q.id}
                      question={q}
                      index={idx}
                      isFirst={idx === 0}
                      isLast={idx === questions.length - 1}
                      onUpdate={(patch) => updateQuestion(q.id, patch)}
                      onRemove={() => removeQuestion(q.id)}
                      onMoveUp={() => moveQuestion(q.id, -1)}
                      onMoveDown={() => moveQuestion(q.id, 1)}
                    />
                  ))}
                </div>
              )}
            </div>

            {/* ── AI Intelligence ── */}
            <div className="bg-white rounded-2xl overflow-hidden"
              style={{ border: '1.5px solid #e0e7ff', boxShadow: '0 2px 12px rgba(0,0,0,0.04)' }}>
              <button
                type="button"
                onClick={() => setAiOpen((v) => !v)}
                className="w-full flex items-center justify-between px-5 py-4 text-left transition-colors hover:bg-[#f8f9ff]"
                style={{ background: aiOpen ? '#f8f9ff' : '#fafbff' }}
              >
                <span className="flex items-center gap-2 text-sm font-extrabold font-headline" style={{ color: 'var(--color-primary)' }}>
                  <Icon name="psychology" size={16} />
                  {t('templates.modal.aiSettings.sectionLabel')}
                </span>
                <Icon name={aiOpen ? 'expand_less' : 'expand_more'} size={18} className="text-on-surface-variant" />
              </button>
              {aiOpen && (
                <div className="px-5 pb-5 pt-3 space-y-4" style={{ background: '#f8f9ff' }}>
                  <p className="text-xs text-on-surface-variant">{t('templates.modal.aiSettings.sectionHint')}</p>
                  {(
                    [
                      { key: 'scoringNarrative',    labelKey: 'scoringNarrativeLabel',    placeholderKey: 'scoringNarrativePlaceholder' },
                      { key: 'audienceDescription', labelKey: 'audienceDescriptionLabel', placeholderKey: 'audienceDescriptionPlaceholder' },
                      { key: 'customInstructions',  labelKey: 'customInstructionsLabel',  placeholderKey: 'customInstructionsPlaceholder' },
                    ] as Array<{ key: keyof EditorFormState['intelligence']; labelKey: string; placeholderKey: string }>
                  ).map(({ key, labelKey, placeholderKey }) => (
                    <div key={key}>
                      <label className="block text-[10px] font-bold text-on-surface-variant mb-1">
                        {t(`templates.modal.aiSettings.${labelKey}`)}
                      </label>
                      <textarea
                        value={form.intelligence[key]}
                        onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setIntel(key, e.target.value)}
                        placeholder={t(`templates.modal.aiSettings.${placeholderKey}`)}
                        rows={3}
                        className={`w-full resize-none text-xs bg-white rounded-xl px-3 py-2.5 outline-none text-on-surface placeholder:text-on-surface-variant${key === 'customInstructions' ? ' font-mono' : ''}`}
                        style={{ border: '1.5px solid #e0e7ff' }}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Save error */}
            {saveError && (
              <div className="flex items-start gap-2 px-4 py-3 rounded-xl" style={{ background: '#fff0f0' }}>
                <Icon name="error_outline" fill={1} size={16} className="text-error flex-shrink-0 mt-0.5" />
                <p className="text-sm font-semibold text-error">{saveError}</p>
              </div>
            )}

            {/* Save CTA */}
            <div className="flex gap-3">
              <Button variant="ghost" onClick={() => navigate(ROUTES.TEMPLATES)} disabled={saving}
                className="px-5 rounded-xl font-bold text-sm"
                style={{ background: '#f0f2f4', color: '#595c5e' }}>
                {t('common.cancel')}
              </Button>
              <Button
                onClick={handleSave}
                disabled={saving}
                className="flex-1 rounded-xl font-bold text-sm text-white h-12"
                style={{ background: saving ? '#94a3b8' : 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))' }}
              >
                {saving ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                    {t('templates.editor.savingLabel')}
                  </span>
                ) : (
                  <span className="flex items-center justify-center gap-2">
                    <Icon name="bookmark_add" size={18} />
                    {t('templates.editor.saveButton')}
                  </span>
                )}
              </Button>
            </div>
          </div>
          </div>
        </div>

      {typePicker && (
        <TypePicker
          onSelect={addQuestion}
          onClose={() => setTypePicker(false)}
        />
      )}
    </>
  );
}
