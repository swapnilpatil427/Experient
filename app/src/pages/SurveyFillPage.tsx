import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Icon } from '../components/Icon';
import { LogoFull } from '../components/Logo';
import { useTranslation } from '../lib/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Card } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import type {
  Survey,
  Question,
  NpsQuestion,
  CsatQuestion,
  RatingQuestion,
  SliderQuestion,
  ChoiceQuestion,
  TextQuestion,
  MatrixQuestion,
  DateQuestion,
  StatementQuestion,
} from '../types';

const BASE = import.meta.env.VITE_API_URL || 'http://localhost:5001/experient-prod/us-central1/api';

// ── Answer value union ────────────────────────────────────────────────────────

type AnswerValue = unknown;
type AnswersMap = Record<string, AnswerValue>;

// ── Sub-component props ───────────────────────────────────────────────────────

interface NpsQuestionProps {
  q: NpsQuestion;
  value: AnswerValue;
  onChange: (v: number) => void;
}

function NpsQuestion({ q, value, onChange }: NpsQuestionProps) {
  const { t } = useTranslation();
  return (
    <div className="mt-4">
      {/* grid-cols-11 ensures all 11 buttons (0–10) always fit in one row */}
      <div className="grid gap-1.5" style={{ gridTemplateColumns: 'repeat(11, minmax(0, 1fr))' }}>
        {Array.from({ length: 11 }, (_, i) => {
          const zoneColorSelected   = i <= 6 ? '#b41340' : i <= 8 ? '#d97706' : '#059669';
          const zoneBgUnselected    = i <= 6 ? 'rgba(180,19,64,0.07)' : i <= 8 ? 'rgba(217,119,6,0.07)' : 'rgba(5,150,105,0.07)';
          const zoneColorUnselected = i <= 6 ? '#b41340cc' : i <= 8 ? '#d97706cc' : '#059669cc';
          return (
            <button
              key={i}
              type="button"
              onClick={() => onChange(i)}
              className="aspect-square rounded-xl text-sm font-bold transition-all active:scale-95 w-full"
              style={{
                background: value === i ? zoneColorSelected : zoneBgUnselected,
                color: value === i ? '#ffffff' : zoneColorUnselected,
                transform: value === i ? 'scale(1.08)' : 'scale(1)',
                boxShadow: value === i ? `0 8px 20px ${zoneColorSelected}40` : 'none',
              } as React.CSSProperties}
            >
              {i}
            </button>
          );
        })}
      </div>
      <div className="flex justify-between mt-2 px-0.5">
        <span className="text-xs font-semibold text-error">{q.labelLow || t('fill.npsLabelLow')}</span>
        <span className="text-xs font-semibold text-success">{q.labelHigh || t('fill.npsLabelHigh')}</span>
      </div>
    </div>
  );
}

interface CsatQuestionProps {
  q: CsatQuestion;
  value: AnswerValue;
  onChange: (v: number) => void;
}

function CsatQuestion({ q, value, onChange }: CsatQuestionProps) {
  const style = q.csatStyle || 'emoji';
  if (style === 'emoji') {
    const emojis: [string, string][] = [['😠', 'Very Bad'], ['😕', 'Bad'], ['😐', 'Neutral'], ['😊', 'Good'], ['😍', 'Excellent']];
    return (
      <div className="flex gap-3 mt-4 justify-center">
        {emojis.map(([emoji, label], i) => (
          <button key={i} onClick={() => onChange(i + 1)}
            className="flex flex-col items-center gap-1.5 p-3 rounded-2xl transition-all active:scale-95"
            style={{
              background: value === i + 1 ? '#e0e7ff' : '#f5f7f9',
              border: value === i + 1 ? '2px solid var(--color-primary)' : '2px solid transparent',
              transform: value === i + 1 ? 'scale(1.1)' : 'scale(1)',
            } as React.CSSProperties}>
            <span className="text-3xl">{emoji}</span>
            <span className="text-[10px] font-bold text-muted-foreground">{label}</span>
          </button>
        ))}
      </div>
    );
  }
  const max = 5;
  return (
    <div className="flex gap-2 mt-4">
      {Array.from({ length: max }, (_, i) => (
        <Button key={i + 1} onClick={() => onChange(i + 1)} variant="secondary"
          className="flex-1 py-4 rounded-xl font-black text-xl transition-all active:scale-95 border-0"
          style={{
            background: (value as number) >= i + 1 ? '#d97706' : '#eef1f3',
            color: (value as number) >= i + 1 ? '#fff' : '#c4c4c4',
          } as React.CSSProperties}>
          {style === 'stars' ? '★' : i + 1}
        </Button>
      ))}
    </div>
  );
}

// ── Visual AI question types ────────────────────────────────────────────────
interface EmojiRatingQ { question: string; emojiSet?: string[] }
function EmojiRatingQuestion({ q, value, onChange }: { q: EmojiRatingQ; value: AnswerValue; onChange: (v: number) => void }) {
  const emojis = (q.emojiSet && q.emojiSet.length ? q.emojiSet : ['😡', '🙁', '😐', '🙂', '😍']);
  return (
    <div className="flex gap-3 mt-4 justify-center flex-wrap">
      {emojis.map((emoji, i) => (
        <button key={i} onClick={() => onChange(i + 1)}
          className="p-3 rounded-2xl transition-all active:scale-95"
          style={{
            background: value === i + 1 ? '#fce7f3' : '#f5f7f9',
            border: value === i + 1 ? '2px solid #db2777' : '2px solid transparent',
            transform: value === i + 1 ? 'scale(1.15)' : 'scale(1)',
          } as React.CSSProperties}>
          <span className="text-3xl">{emoji}</span>
        </button>
      ))}
    </div>
  );
}

interface ImageChoiceOption { label: string; imageUrl?: string }
interface ImageChoiceQ { question: string; options?: ImageChoiceOption[] }
function ImageChoiceQuestion({ q, value, onChange }: { q: ImageChoiceQ; value: AnswerValue; onChange: (v: string) => void }) {
  const options = q.options || [];
  return (
    <div className="grid grid-cols-2 gap-3 mt-4">
      {options.map((opt, i) => {
        const selected = value === opt.label;
        return (
          <button key={i} onClick={() => onChange(opt.label)}
            className="rounded-2xl overflow-hidden transition-all active:scale-95 text-left"
            style={{ border: selected ? '3px solid #7c3aed' : '3px solid transparent', background: '#f5f7f9' }}>
            {opt.imageUrl
              ? <img src={opt.imageUrl} alt={opt.label} className="w-full h-28 object-cover" />
              : <div className="w-full h-28 flex items-center justify-center text-muted-foreground"><span className="material-symbols-outlined">image</span></div>}
            <div className="px-3 py-2 text-sm font-semibold text-on-surface">{opt.label}</div>
          </button>
        );
      })}
    </div>
  );
}

interface ImageUploadQ { question: string; blurFaces?: boolean; requireConsent?: boolean }
function ImageUploadQuestion({ q, value, onChange }: { q: ImageUploadQ; value: AnswerValue; onChange: (v: string) => void }) {
  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => onChange(String(reader.result)); // data URL (dev); cloud upload + face-blur on the server in prod
    reader.readAsDataURL(file);
  }
  return (
    <div className="mt-4">
      {value ? (
        <img src={value as string} alt="upload preview" className="w-full max-h-64 object-contain rounded-xl border border-border" />
      ) : (
        <label className="flex flex-col items-center justify-center gap-2 h-40 rounded-xl border-2 border-dashed border-border cursor-pointer hover:bg-muted/40 transition-colors">
          <span className="material-symbols-outlined text-3xl text-muted-foreground">add_a_photo</span>
          <span className="text-sm text-muted-foreground">Tap to upload a photo</span>
          <input type="file" accept="image/*" className="hidden" onChange={handleFile} />
        </label>
      )}
      {q.blurFaces && <p className="text-[11px] text-muted-foreground mt-2">Faces are automatically blurred for privacy.</p>}
    </div>
  );
}

interface AnnotationMark { x: number; y: number }
interface AnnotationQ { question: string; imageUrl?: string; maxMarks?: number }
function AnnotationQuestion({ q, value, onChange }: { q: AnnotationQ; value: AnswerValue; onChange: (v: AnnotationMark[]) => void }) {
  const marks = Array.isArray(value) ? (value as unknown as AnnotationMark[]) : [];
  const maxMarks = q.maxMarks || 5;
  function place(e: React.MouseEvent<HTMLDivElement>) {
    if (marks.length >= maxMarks) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.round(((e.clientX - rect.left) / rect.width) * 1000) / 10;  // % to 0.1
    const y = Math.round(((e.clientY - rect.top) / rect.height) * 1000) / 10;
    onChange([...marks, { x, y }]);
  }
  return (
    <div className="mt-4">
      <div
        onClick={place}
        className="relative w-full rounded-xl overflow-hidden border border-border cursor-crosshair select-none"
        style={{ minHeight: 200, background: q.imageUrl ? undefined : '#f5f7f9' }}
        role="button"
        aria-label="Click to mark the image"
      >
        {q.imageUrl
          ? <img src={q.imageUrl} alt="annotate" className="w-full block pointer-events-none" />
          : <div className="h-48 flex items-center justify-center text-muted-foreground">Image area — tap to mark</div>}
        {marks.map((m, i) => (
          <span key={i}
            className="absolute -translate-x-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-[#ea580c] text-white text-xs font-bold flex items-center justify-center shadow"
            style={{ left: `${m.x}%`, top: `${m.y}%` }}>{i + 1}</span>
        ))}
      </div>
      <div className="flex items-center justify-between mt-2 text-xs text-muted-foreground">
        <span>{marks.length} / {maxMarks} marks</span>
        {marks.length > 0 && <button onClick={() => onChange([])} className="underline">Clear</button>}
      </div>
    </div>
  );
}

interface RatingQuestionProps {
  q: RatingQuestion;
  value: AnswerValue;
  onChange: (v: number) => void;
}

function RatingQuestion({ q, value, onChange }: RatingQuestionProps) {
  const max = q.scaleMax || 5;
  return (
    <div className="flex gap-2 mt-4">
      {Array.from({ length: max }, (_, i) => (
        <Button key={i + 1} onClick={() => onChange(i + 1)} variant="secondary"
          className="flex-1 py-4 rounded-xl font-black text-xl transition-all active:scale-95 border-0"
          style={{
            background: (value as number) >= i + 1 ? 'var(--color-primary)' : '#eef1f3',
            color: (value as number) >= i + 1 ? '#ffffff' : '#c4c4c4',
            boxShadow: (value as number) >= i + 1 ? '0 8px 20px color-mix(in srgb, var(--color-primary) 20%, transparent)' : 'none',
          } as React.CSSProperties}>
          {q.ratingStyle === 'numbers' ? i + 1 : '★'}
        </Button>
      ))}
    </div>
  );
}

interface MultipleChoiceQuestionProps {
  question: ChoiceQuestion;
  value: AnswerValue;
  onChange: (v: string) => void;
}

function MultipleChoiceQuestion({ question, value, onChange }: MultipleChoiceQuestionProps) {
  return (
    <div className="flex flex-col gap-3 mt-4">
      {(question.options || []).map((opt) => (
        <button key={opt} onClick={() => onChange(opt)}
          className="flex items-center gap-3 px-5 py-4 rounded-xl text-left transition-all active:scale-95"
          style={{
            background: value === opt ? '#e0e7ff' : '#eef1f3',
            border: value === opt ? '2px solid var(--color-primary)' : '2px solid transparent',
            color: value === opt ? 'var(--color-primary)' : '#2c2f31',
          } as React.CSSProperties}>
          <div className="w-5 h-5 rounded-full flex-shrink-0 flex items-center justify-center"
            style={{ border: value === opt ? '2px solid var(--color-primary)' : '2px solid #d0d5d8', background: value === opt ? 'var(--color-primary)' : 'transparent' }}>
            {value === opt && <div className="w-2 h-2 rounded-full bg-white" />}
          </div>
          <span className="font-semibold text-sm">{opt}</span>
        </button>
      ))}
    </div>
  );
}

interface CheckboxQuestionProps {
  question: ChoiceQuestion;
  value: string[];
  onChange: (v: string[]) => void;
}

function CheckboxQuestion({ question, value = [], onChange }: CheckboxQuestionProps) {
  const toggle = (opt: string) => {
    const next = value.includes(opt) ? value.filter((v) => v !== opt) : [...value, opt];
    onChange(next);
  };
  return (
    <div className="flex flex-col gap-3 mt-4">
      {(question.options || []).map((opt) => (
        <button key={opt} onClick={() => toggle(opt)}
          className="flex items-center gap-3 px-5 py-4 rounded-xl text-left transition-all active:scale-95"
          style={{
            background: value.includes(opt) ? '#e0e7ff' : '#eef1f3',
            border: value.includes(opt) ? '2px solid var(--color-primary)' : '2px solid transparent',
          } as React.CSSProperties}>
          <div className="w-5 h-5 rounded flex-shrink-0 flex items-center justify-center"
            style={{ border: value.includes(opt) ? '2px solid var(--color-primary)' : '2px solid #d0d5d8', background: value.includes(opt) ? 'var(--color-primary)' : 'transparent' }}>
            {value.includes(opt) && <Icon name="check" size={12} style={{ color: '#fff' }} />}
          </div>
          <span className="font-semibold text-sm" style={{ color: value.includes(opt) ? 'var(--color-primary)' : '#2c2f31' }}>{opt}</span>
        </button>
      ))}
    </div>
  );
}

interface DropdownQuestionProps {
  question: ChoiceQuestion;
  value: AnswerValue;
  onChange: (v: string) => void;
}

function DropdownQuestion({ question, value, onChange }: DropdownQuestionProps) {
  return (
    <select
      value={(value as string) || ''}
      onChange={(e: React.ChangeEvent<HTMLSelectElement>) => onChange(e.target.value)}
      className="w-full mt-4 px-4 py-3 rounded-[10px] text-sm font-semibold bg-[#f5f7f9] border border-[#dfe3e6] text-on-surface appearance-none cursor-pointer focus:outline-none focus:ring-2 focus:ring-primary"
    >
      <option value="">{question.placeholder || 'Choose an option…'}</option>
      {(question.options || []).map((opt) => (
        <option key={opt} value={opt}>{opt}</option>
      ))}
    </select>
  );
}

interface OpenTextQuestionProps {
  q: TextQuestion;
  value: AnswerValue;
  onChange: (v: string) => void;
}

function OpenTextQuestion({ q, value, onChange }: OpenTextQuestionProps) {
  const { t } = useTranslation();
  return (
    <Textarea
      value={(value as string) || ''}
      onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value)}
      placeholder={q?.placeholder || t('fill.textareaPlaceholder')}
      rows={4}
      className="w-full mt-4 resize-none text-sm leading-relaxed bg-surface-container-low font-body text-on-surface rounded-[10px] border-0 focus-visible:ring-2 focus-visible:ring-primary"
    />
  );
}

interface ShortTextQuestionProps {
  q: TextQuestion;
  value: AnswerValue;
  onChange: (v: string) => void;
}

function ShortTextQuestion({ q, value, onChange }: ShortTextQuestionProps) {
  return (
    <input
      type="text"
      value={(value as string) || ''}
      onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
      placeholder={q?.placeholder || 'Type your answer…'}
      className="w-full mt-4 px-4 py-3 rounded-[10px] text-sm font-medium bg-[#f5f7f9] border border-[#dfe3e6] text-on-surface focus:outline-none focus:ring-2 focus:ring-primary"
    />
  );
}

interface SliderQuestionProps {
  q: SliderQuestion;
  value: AnswerValue;
  onChange: (v: number) => void;
}

function SliderQuestion({ q, value, onChange }: SliderQuestionProps) {
  const min = q.min ?? 0;
  const max = q.max ?? 100;
  const step = q.step ?? 1;
  const current = (value as number) ?? min;
  return (
    <div className="mt-6 px-2">
      <div className="flex justify-between text-xs font-semibold text-muted-foreground mb-3">
        <span>{q.labelLow || min}</span>
        <span className="text-base font-bold text-on-surface">{current}</span>
        <span>{q.labelHigh || max}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={current}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(Number(e.target.value))}
        className="w-full accent-primary"
      />
    </div>
  );
}

interface RankingQuestionProps {
  question: ChoiceQuestion;
  value: string[];
  onChange: (v: string[]) => void;
}

function RankingQuestion({ question, value = [], onChange }: RankingQuestionProps) {
  const opts = question.options || [];
  const ranked = value.length ? value : opts;
  const move = (from: number, to: number) => {
    const next = [...ranked];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    onChange(next);
  };
  return (
    <div className="mt-4 space-y-2">
      {ranked.map((opt, i) => (
        <div key={opt} className="flex items-center gap-3 px-4 py-3 rounded-xl bg-[#f5f7f9] border border-[#dfe3e6]">
          <span className="w-6 h-6 rounded-lg flex items-center justify-center text-xs font-black bg-[#e0e7ff] text-[var(--color-primary)]">{i + 1}</span>
          <span className="flex-1 text-sm font-semibold text-on-surface">{opt}</span>
          <div className="flex flex-col gap-0.5">
            <button onClick={() => { if (i > 0) move(i, i - 1); }}
              disabled={i === 0}
              className="w-6 h-5 flex items-center justify-center rounded text-muted-foreground hover:bg-[#dfe3e6] disabled:opacity-30">
              <Icon name="arrow_drop_up" size={16} />
            </button>
            <button onClick={() => { if (i < ranked.length - 1) move(i, i + 1); }}
              disabled={i === ranked.length - 1}
              className="w-6 h-5 flex items-center justify-center rounded text-muted-foreground hover:bg-[#dfe3e6] disabled:opacity-30">
              <Icon name="arrow_drop_down" size={16} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

interface MatrixQuestionProps {
  question: MatrixQuestion;
  value: Record<string, string | string[]>;
  onChange: (v: Record<string, string | string[]>) => void;
}

function MatrixQuestion({ question, value = {}, onChange }: MatrixQuestionProps) {
  const rows = question.rows || [];
  const cols = question.columns || [];
  const multi = question.matrixType === 'checkbox';
  const toggle = (row: string, col: string) => {
    if (multi) {
      const prev = (value[row] as string[]) || [];
      const next = prev.includes(col) ? prev.filter((c) => c !== col) : [...prev, col];
      onChange({ ...value, [row]: next });
    } else {
      onChange({ ...value, [row]: col });
    }
  };
  const isSelected = (row: string, col: string): boolean =>
    multi ? ((value[row] as string[]) || []).includes(col) : value[row] === col;
  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr>
            <th className="text-left py-2 pr-4 text-xs font-bold text-muted-foreground w-1/3" />
            {cols.map((col) => (
              <th key={col} className="py-2 px-2 text-center text-xs font-bold text-muted-foreground">{col}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={row} style={{ background: ri % 2 === 0 ? '#f5f7f9' : 'transparent' }}>
              <td className="py-3 pr-4 font-semibold text-on-surface">{row}</td>
              {cols.map((col) => (
                <td key={col} className="py-3 px-2 text-center">
                  <button onClick={() => toggle(row, col)}
                    className={`w-5 h-5 mx-auto flex items-center justify-center transition-all ${multi ? 'rounded' : 'rounded-full'}`}
                    style={{
                      border: isSelected(row, col) ? '2px solid var(--color-primary)' : '2px solid #d0d5d8',
                      background: isSelected(row, col) ? 'var(--color-primary)' : 'transparent',
                    } as React.CSSProperties}>
                    {isSelected(row, col) && <Icon name="check" size={11} style={{ color: '#fff' }} />}
                  </button>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface DateQuestionProps {
  q: DateQuestion;
  value: AnswerValue;
  onChange: (v: string) => void;
}

function DateQuestion({ q, value, onChange }: DateQuestionProps) {
  const type = q.dateType === 'time' ? 'time' : q.dateType === 'datetime' ? 'datetime-local' : 'date';
  return (
    <input
      type={type}
      value={(value as string) || ''}
      onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
      className="w-full mt-4 px-4 py-3 rounded-[10px] text-sm font-medium bg-[#f5f7f9] border border-[#dfe3e6] text-on-surface focus:outline-none focus:ring-2 focus:ring-primary"
    />
  );
}

interface StatementBlockProps {
  q: StatementQuestion;
}

function StatementBlock({ q: _q }: StatementBlockProps) {
  return (
    <div className="mt-2">
      <div className="h-px rounded bg-gradient-to-r from-primary to-transparent opacity-20 mt-4" />
    </div>
  );
}

// ── Error screen ──────────────────────────────────────────────────────────────

type SurveyErrorType = 'not_found' | 'closed' | 'paused' | 'network';

interface SurveyErrorScreenProps {
  type: SurveyErrorType;
  onRetry?: () => void;
}

function SurveyErrorScreen({ type, onRetry }: SurveyErrorScreenProps) {
  const { t } = useTranslation();
  const SURVEY_ERROR_CONFIG: Record<SurveyErrorType, { icon: string; color: string }> = {
    not_found: { icon: 'search_off',    color: '#6b7280' },
    closed:    { icon: 'lock',          color: '#7c3aed' },
    paused:    { icon: 'pause_circle',  color: '#d97706' },
    network:   { icon: 'wifi_off',      color: '#dc2626' },
  };
  const cfg = SURVEY_ERROR_CONFIG[type] || SURVEY_ERROR_CONFIG.not_found;
  const keyMap: Record<SurveyErrorType, string> = { not_found: 'notFound', closed: 'closed', paused: 'paused', network: 'network' };
  const key = keyMap[type] || 'notFound';

  return (
    <div
      className="min-h-screen flex items-center justify-center px-6"
      style={{ background: 'radial-gradient(circle at 50% 30%, #e0e7ff 0%, #f5f7f9 70%)' }}
    >
      <div className="text-center max-w-md">
        <div
          className="w-20 h-20 rounded-2xl flex items-center justify-center mx-auto mb-8 shadow-lg"
          style={{ background: `${cfg.color}18`, border: `1px solid ${cfg.color}30` } as React.CSSProperties}
        >
          <Icon name={cfg.icon} size={40} style={{ color: cfg.color }} />
        </div>
        <h1 className="text-3xl font-extrabold tracking-tighter mb-3 font-headline text-on-surface">
          {t(`fill.errors.${key}.heading`)}
        </h1>
        <p className="text-base leading-relaxed mb-8 text-on-surface-variant">
          {t(`fill.errors.${key}.description`)}
        </p>
        {type === 'network' && onRetry && (
          <Button
            onClick={onRetry}
            className="rounded-xl font-bold px-6"
            style={{ background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))', color: '#fff', border: 'none' } as React.CSSProperties}
          >
            {t('fill.errors.network.retry')}
          </Button>
        )}
        <div className="mt-10 flex items-center justify-center">
          <LogoFull height={18} />
        </div>
      </div>
    </div>
  );
}

// ── Password gate component ───────────────────────────────────────────────────
function PasswordGate({ token, onUnlocked }: { token: string; onUnlocked: () => void }) {
  const { t } = useTranslation();
  const pg = 'passwordGate';
  const [password,    setPassword]    = useState('');
  const [showPass,    setShowPass]    = useState(false);
  const [submitting,  setSubmitting]  = useState(false);
  const [wrongPass,   setWrongPass]   = useState(false);

  const handleSubmit = async () => {
    if (!password.trim()) return;
    setSubmitting(true);
    setWrongPass(false);
    try {
      const res = await fetch(`${BASE}/api/public/surveys/${token}/verify-password`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ password }),
      });
      const data = await res.json().catch(() => ({})) as { valid?: boolean };
      if (data.valid) {
        sessionStorage.setItem(`survey_pwd_${token}`, '1');
        onUnlocked();
      } else {
        setWrongPass(true);
      }
    } catch {
      setWrongPass(true);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-container-low px-4">
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-sm"
      >
        <div className="text-center mb-8">
          <LogoFull height={32} />
        </div>
        <Card className="p-8 rounded-3xl border-white/60 shadow-xl flex flex-col items-center gap-5">
          <div
            className="w-14 h-14 rounded-2xl flex items-center justify-center"
            style={{ background: 'color-mix(in srgb, var(--color-primary) 10%, transparent)' }}
          >
            <Icon name="lock" size={28} className="text-primary" fill={1} />
          </div>
          <div className="text-center">
            <h2 className="text-xl font-extrabold font-headline text-on-surface">
              {t(`${pg}.heading`)}
            </h2>
            <p className="text-sm text-on-surface-variant mt-1">{t(`${pg}.description`)}</p>
          </div>

          <div className="w-full flex flex-col gap-2">
            <div className="relative">
              <Input
                type={showPass ? 'text' : 'password'}
                placeholder={t(`${pg}.placeholder`)}
                value={password}
                onChange={(e) => { setPassword(e.target.value); setWrongPass(false); }}
                onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); }}
                className="rounded-xl pr-14 text-base"
                autoFocus
              />
              <button
                type="button"
                onClick={() => setShowPass((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-muted-foreground hover:text-on-surface"
              >
                {showPass ? t(`${pg}.hidePassword`) : t(`${pg}.showPassword`)}
              </button>
            </div>
            {wrongPass && (
              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="text-sm text-red-600 font-medium"
              >
                {t(`${pg}.wrongPassword`)}
              </motion.p>
            )}
          </div>

          <Button
            onClick={handleSubmit}
            disabled={submitting || !password.trim()}
            className="w-full py-3 font-bold rounded-xl text-white"
            style={{ background: 'linear-gradient(135deg, var(--color-primary), var(--color-primary-container))' }}
          >
            {submitting ? t(`${pg}.submitting`) : t(`${pg}.submitButton`)}
          </Button>
        </Card>
      </motion.div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function SurveyFillPage() {
  const { token } = useParams<{ token: string }>();
  const { t } = useTranslation();
  const [survey, setSurvey] = useState<Survey | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [errorType, setErrorType] = useState<SurveyErrorType | null>(null);
  const [retryKey, setRetryKey] = useState<number>(0);
  const [answers, setAnswers] = useState<AnswersMap>({});
  const [currentQ, setCurrentQ] = useState<number>(0);
  const [direction, setDirection] = useState<number>(1);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [submitted, setSubmitted] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [retryAfterSecs, setRetryAfterSecs] = useState<number | null>(null);
  const [passwordUnlocked, setPasswordUnlocked] = useState<boolean>(false);

  useEffect(() => {
    // Restore session-level password bypass
    if (token && sessionStorage.getItem(`survey_pwd_${token}`)) {
      setPasswordUnlocked(true);
    }
  }, [token]);

  useEffect(() => {
    setLoading(true);
    setErrorType(null);
    setSurvey(null);
    async function load() {
      try {
        const res = await fetch(`${BASE}/api/public/surveys/${token}`);
        if (res.ok) {
          const data = await res.json();
          setSurvey(data.survey);
        } else if (res.status === 404) {
          setErrorType('not_found');
        } else if (res.status === 403) {
          const data = await res.json().catch(() => ({}));
          setErrorType(data.error === 'survey_paused' ? 'paused' : 'closed');
        } else {
          setErrorType('network');
        }
      } catch {
        setErrorType('network');
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [token, retryKey]);

  const questions: Question[] = survey?.questions || [];
  const q = questions[currentQ];
  const qType = q?.type as string | undefined;
  const progress = questions.length > 0 ? ((currentQ) / questions.length) * 100 : 0;
  const isLast = currentQ === questions.length - 1;
  const canContinue = q?.type === 'statement' || !q?.required || answers[q?.id] !== undefined;

  const setAnswer = (id: string, value: AnswerValue) => setAnswers((prev) => ({ ...prev, [id]: value }));

  const handleNext = () => {
    if (currentQ < questions.length - 1) {
      setDirection(1);
      setCurrentQ((n) => n + 1);
    }
  };

  const handleBack = () => {
    if (currentQ > 0) {
      setDirection(-1);
      setCurrentQ((n) => n - 1);
    }
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const payload = {
        publishToken: token,
        answers: Object.entries(answers).map(([questionId, value]) => ({
          questionId,
          type: questions.find((qItem) => qItem.id === questionId)?.type,
          value: String(value),
        })),
      };
      const res = await fetch(`${BASE}/api/surveys/${survey!.id}/responses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        setSubmitted(true);
      } else if (res.status === 429) {
        const data = await res.json().catch(() => ({}));
        setRetryAfterSecs(data.retryAfter || null);
        setError('rate_limited');
      } else {
        setError('submit_failed');
      }
    } catch {
      setError('submit_failed');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-surface gap-5">
        <motion.div
          animate={{ rotate: 360 }}
          transition={{ duration: 1.2, ease: 'linear', repeat: Infinity }}
          className="w-10 h-10 rounded-full border-2 border-t-transparent"
          style={{ borderColor: 'color-mix(in srgb, var(--color-primary) 20%, transparent)', borderTopColor: 'var(--color-primary)' } as React.CSSProperties}
        />
        <p className="text-sm font-semibold text-on-surface-variant">{t('fill.loading')}</p>
      </div>
    );
  }

  if (errorType) {
    return <SurveyErrorScreen type={errorType} onRetry={() => setRetryKey((k) => k + 1)} />;
  }

  // Password gate — show before survey if password_protected and not yet verified
  if (survey?.password_protected && !passwordUnlocked) {
    return <PasswordGate token={token!} onUnlocked={() => setPasswordUnlocked(true)} />;
  }

  if (submitted) {
    return (
      <div
        className="min-h-screen flex items-center justify-center px-6"
        style={{ background: 'radial-gradient(circle at 50% 30%, #e0e7ff 0%, #f5f7f9 70%)' }}
      >
        <div className="text-center max-w-md">
          <motion.div
            initial={{ scale: 0.5, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: 'spring', damping: 12, stiffness: 200 }}
            className="w-24 h-24 rounded-2xl flex items-center justify-center mx-auto mb-8 shadow-xl"
            style={{ background: 'linear-gradient(135deg, #059669, #10b981)' }}
          >
            <Icon name="check_circle" fill={1} size={48} className="text-white" />
          </motion.div>
          <h1 className="text-4xl font-extrabold tracking-tighter mb-4 font-headline text-on-surface">
            {t('fill.thankYou.heading')}
          </h1>
          <p className="text-lg leading-relaxed mb-10 text-on-surface-variant">
            {survey?.thank_you_message || t('fill.thankYou.message')}
          </p>
          <div className="flex items-center justify-center gap-1.5 opacity-50 hover:opacity-80 transition-opacity">
            <span className="text-[10px] font-bold tracking-widest uppercase text-muted-foreground">{t('fill.poweredBy')}</span>
            <LogoFull height={16} />
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    const isRateLimited = error === 'rate_limited';
    return (
      <div
        className="min-h-screen flex items-center justify-center px-6"
        style={{ background: 'radial-gradient(circle at 50% 30%, #fee2e2 0%, #f5f7f9 70%)' }}
      >
        <div className="text-center max-w-md">
          <div
            className="w-20 h-20 rounded-2xl flex items-center justify-center mx-auto mb-8 shadow-lg"
            style={{ background: '#dc262618', border: '1px solid #dc262630' } as React.CSSProperties}
          >
            <Icon name={isRateLimited ? 'timer_off' : 'error_outline'} size={40} style={{ color: '#dc2626' }} />
          </div>
          <h1 className="text-3xl font-extrabold tracking-tighter mb-3 font-headline text-on-surface">
            {t('fill.submitError.heading')}
          </h1>
          <p className="text-base leading-relaxed mb-8 text-on-surface-variant">
            {isRateLimited
              ? retryAfterSecs
                ? t('fill.submitError.rateLimitedWait', { minutes: Math.ceil(retryAfterSecs / 60) })
                : t('fill.submitError.rateLimited')
              : t('fill.submitError.description')}
          </p>
          {!isRateLimited && (
            <Button
              onClick={() => { setError(null); handleSubmit(); }}
              className="rounded-xl font-bold px-6"
              style={{ background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))', color: '#fff', border: 'none' } as React.CSSProperties}
            >
              {t('fill.submitError.retry')}
            </Button>
          )}
          <div className="mt-10 flex items-center justify-center gap-1.5 opacity-50">
            <span className="text-[10px] font-bold tracking-widest uppercase text-muted-foreground">{t('fill.poweredBy')}</span>
            <LogoFull height={16} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="min-h-screen relative"
      style={{ background: 'radial-gradient(circle at 50% -10%, #e0e7ff 0%, #f5f7f9 60%)' }}
    >
      {/* Background blobs */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden z-0">
        <div
          className="absolute rounded-full"
          style={{ top: '-15%', left: '-10%', width: '40%', height: '40%', background: 'color-mix(in srgb, var(--color-primary) 12%, transparent)', filter: 'blur(120px)' } as React.CSSProperties}
        />
        <div
          className="absolute rounded-full"
          style={{ bottom: '-10%', right: '-10%', width: '50%', height: '50%', background: 'color-mix(in srgb, var(--color-tertiary) 12%, transparent)', filter: 'blur(150px)' } as React.CSSProperties}
        />
      </div>

      {/* Progress bar */}
      <div className="fixed top-0 left-0 w-full z-50">
        <Progress
          value={progress}
          className="h-[3px] rounded-none bg-surface-container [&>div]:bg-gradient-to-r [&>div]:from-primary [&>div]:to-[var(--color-tertiary)] [&>div]:transition-all [&>div]:duration-500"
        />
      </div>

      {/* Header */}
      <header className="fixed top-1 left-0 w-full z-40 glass-nav flex items-center justify-between h-14 px-6"
        style={{ boxShadow: '0 8px 32px rgba(31,38,135,0.07)' }}>
        <LogoFull height={22} />
        <span className="text-xs font-semibold text-muted-foreground">
          {t('fill.progress', { current: currentQ + 1, total: questions.length })}
        </span>
      </header>

      <main className="relative z-10 flex items-start justify-center pt-20 pb-32 px-4 min-h-screen">
        <div className="w-full max-w-xl pt-8">
          {/* Survey title */}
          {currentQ === 0 && survey && (
            <div className="text-center mb-10 animate-fade-up">
              <h1 className="text-3xl font-extrabold tracking-tighter mb-2 font-headline text-gradient">
                {survey.title}
              </h1>
              {survey.description && (
                <p className="text-sm max-w-sm mx-auto leading-relaxed text-on-surface-variant">
                  {survey.description}
                </p>
              )}
            </div>
          )}

          {/* Question card */}
          <AnimatePresence mode="wait" initial={false} custom={direction}>
          {q && (
            <motion.div
              key={q.id}
              custom={direction}
              initial={{ opacity: 0, x: direction * 48, scale: 0.97 }}
              animate={{ opacity: 1, x: 0, scale: 1, transition: { duration: 0.32, ease: [0.22, 1, 0.36, 1] } }}
              exit={{ opacity: 0, x: direction * -32, scale: 0.97, transition: { duration: 0.26, ease: [0.22, 1, 0.36, 1] } }}
            >
            <Card
              className="glass-card-premium p-8 rounded-2xl"
              style={{ boxShadow: '0 40px 100px -20px color-mix(in srgb, var(--color-primary) 14%, transparent), 0 0 0 1px rgba(255,255,255,0.6) inset' }}
            >
              <div className="mb-6">
                <h2 className="text-xl font-bold leading-tight font-headline text-on-surface">
                  {q.question}
                  {q.required && <span className="text-primary ml-1">*</span>}
                </h2>
              </div>

              {q.type === 'nps' && <NpsQuestion q={q as NpsQuestion} value={answers[q.id]} onChange={(v) => setAnswer(q.id, v)} />}
              {q.type === 'csat' && <CsatQuestion q={q as CsatQuestion} value={answers[q.id]} onChange={(v) => setAnswer(q.id, v)} />}
              {q.type === 'rating' && <RatingQuestion q={q as RatingQuestion} value={answers[q.id]} onChange={(v) => setAnswer(q.id, v)} />}
              {q.type === 'multiple_choice' && <MultipleChoiceQuestion question={q as ChoiceQuestion} value={answers[q.id]} onChange={(v) => setAnswer(q.id, v)} />}
              {q.type === 'checkbox' && <CheckboxQuestion question={q as ChoiceQuestion} value={(answers[q.id] as string[]) || []} onChange={(v) => setAnswer(q.id, v)} />}
              {q.type === 'dropdown' && <DropdownQuestion question={q as ChoiceQuestion} value={answers[q.id]} onChange={(v) => setAnswer(q.id, v)} />}
              {q.type === 'open_text' && <OpenTextQuestion q={q as TextQuestion} value={answers[q.id]} onChange={(v) => setAnswer(q.id, v)} />}
              {q.type === 'short_text' && <ShortTextQuestion q={q as TextQuestion} value={answers[q.id]} onChange={(v) => setAnswer(q.id, v)} />}
              {q.type === 'slider' && <SliderQuestion q={q as SliderQuestion} value={answers[q.id]} onChange={(v) => setAnswer(q.id, v)} />}
              {q.type === 'ranking' && <RankingQuestion question={q as ChoiceQuestion} value={(answers[q.id] as string[]) || []} onChange={(v) => setAnswer(q.id, v)} />}
              {q.type === 'matrix' && <MatrixQuestion question={q as MatrixQuestion} value={(answers[q.id] as Record<string, string | string[]>) || {}} onChange={(v) => setAnswer(q.id, v)} />}
              {q.type === 'date' && <DateQuestion q={q as DateQuestion} value={answers[q.id]} onChange={(v) => setAnswer(q.id, v)} />}
              {q.type === 'statement' && <StatementBlock q={q as StatementQuestion} />}
              {qType === 'emoji_rating' && <EmojiRatingQuestion q={q as unknown as EmojiRatingQ} value={answers[q.id]} onChange={(v) => setAnswer(q.id, v)} />}
              {qType === 'image_choice' && <ImageChoiceQuestion q={q as unknown as ImageChoiceQ} value={answers[q.id]} onChange={(v) => setAnswer(q.id, v)} />}
              {qType === 'image_upload' && <ImageUploadQuestion q={q as unknown as ImageUploadQ} value={answers[q.id]} onChange={(v) => setAnswer(q.id, v)} />}
              {qType === 'annotation' && <AnnotationQuestion q={q as unknown as AnnotationQ} value={answers[q.id]} onChange={(v) => setAnswer(q.id, v)} />}

              {/* Navigation */}
              <div className="flex gap-3 mt-8">
                {currentQ > 0 && (
                  <Button
                    onClick={handleBack}
                    variant="secondary"
                    className="px-5 py-3 font-bold text-sm active:scale-95 font-headline bg-surface-container-low text-on-surface-variant rounded-xl border-0"
                  >
                    {t('fill.backButton')}
                  </Button>
                )}
                <Button
                  onClick={isLast ? handleSubmit : handleNext}
                  disabled={!canContinue || submitting}
                  className="flex-1 py-3 font-bold text-base transition-all active:scale-95 flex items-center justify-center gap-2 font-headline rounded-xl border-0"
                  style={{
                    background: canContinue
                      ? 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))'
                      : '#dfe3e6',
                    color: canContinue ? '#ffffff' : '#9a9d9f',
                    cursor: canContinue ? 'pointer' : 'not-allowed',
                    boxShadow: canContinue ? '0 10px 30px color-mix(in srgb, var(--color-primary) 25%, transparent)' : 'none',
                  } as React.CSSProperties}
                >
                  {submitting ? (
                    <><motion.div
                      animate={{ rotate: 360 }}
                      transition={{ duration: 0.9, ease: 'linear', repeat: Infinity }}
                      className="w-5 h-5 rounded-full border-2 border-t-transparent border-white"
                    />Submitting…</>
                  ) : isLast ? (
                    <>
                      <Icon name="send" size={18} />
                      {t('fill.submitButton')}
                    </>
                  ) : (
                    <>
                      {t('fill.continueButton')}
                      <Icon name="arrow_forward" size={18} />
                    </>
                  )}
                </Button>
              </div>
            </Card>
            </motion.div>
          )}
          </AnimatePresence>

          {error && (
            <div className="mt-4 p-3 rounded-xl text-sm font-semibold text-center bg-error/10 text-error">
              {error}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
