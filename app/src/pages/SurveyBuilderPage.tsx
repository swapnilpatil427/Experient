import { useState, useCallback, useRef, useEffect } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';
import { PublishModal, PublishSuccessModal } from '../components/SurveyActionModal';
import { Spinner, OverlayLoader } from '../components/LoadingStates';
import { useSurveys } from '../hooks/useSurveys';
import { useApi } from '../hooks/useApi';
import { useTranslation } from '../lib/i18n';
import { ROUTES } from '../constants/routes';
import { QTYPE_META, QTYPE_GROUPS, createQuestion, mapAiToBuilderQuestion } from '../constants/questionTypes';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { useCrystalPanel } from '../contexts/crystalPanel';
import { TagSelector } from '../components/TagSelector';
import type { Question, Template, SkipLogicRule, DisplayLogic } from '../types';
import type { SurveyTag } from '../lib/api';

// ─────────────────────────────────────────────────────────────────────────────
// Internal types
// ─────────────────────────────────────────────────────────────────────────────

interface QtypeMeta {
  label: string;
  icon: string;
  color: string;
  bg: string;
  group: string;
  desc: string;
}

// Re-use exported types — local aliases for readability
type SkipRule = SkipLogicRule;

interface SurveySettings {
  description: string;
  intent: string;
  thankYouMessage: string;
  templateId: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// QUESTION TYPE PALETTE
// ─────────────────────────────────────────────────────────────────────────────

interface TypeTileProps {
  meta: QtypeMeta;
  typeKey: string;
  onAdd: (type: string) => void;
}

function TypeTile({ meta, typeKey, onAdd }: TypeTileProps) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={() => onAdd(typeKey)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-left transition-all"
      style={{
        background: hovered ? meta.bg : 'transparent',
        transform: hovered ? 'perspective(600px) translateZ(4px)' : 'none',
        boxShadow: hovered ? `0 4px 16px ${meta.color}22` : 'none',
      }}
    >
      <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
        style={{ background: meta.bg, color: meta.color }}>
        <Icon name={meta.icon} size={15} />
      </div>
      <div className="min-w-0">
        <div className="text-xs font-bold truncate text-foreground">{meta.label}</div>
        <div className="text-[10px] truncate text-muted-foreground">{meta.desc}</div>
      </div>
    </button>
  );
}

interface QuestionPaletteProps {
  onAdd: (type: string) => void;
}

function QuestionPalette({ onAdd }: QuestionPaletteProps) {
  return (
    <div className="h-full flex flex-col bg-background">
      {/* Scrollable type list */}
      <div className="flex-1 overflow-y-auto py-4 min-h-0">
        {QTYPE_GROUPS.map((group) => {
          const types = Object.entries(QTYPE_META).filter(([, m]) => (m as QtypeMeta).group === group);
          return (
            <div key={group} className="mb-2">
              <div className="px-4 mb-1">
                <span className="text-[10px] font-black uppercase tracking-widest text-muted-foreground/60">{group}</span>
              </div>
              {types.map(([key, meta]) => (
                <div key={key} className="px-2">
                  <TypeTile meta={meta as QtypeMeta} typeKey={key} onAdd={onAdd} />
                </div>
              ))}
            </div>
          );
        })}
      </div>

    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// INLINE ANSWER PREVIEW (shown inside question cards)
// ─────────────────────────────────────────────────────────────────────────────

interface TypePreviewProps {
  q: Question;
}

function TypePreview({ q }: TypePreviewProps) {
  const bg = '#f5f7f9';
  switch (q.type) {
    case 'nps':
      return (
        <div className="flex gap-0.5 mt-3">
          {Array.from({ length: 11 }, (_, i) => (
            <div key={i} className="flex-1 h-8 rounded flex items-center justify-center text-[10px] font-bold"
              style={{ background: i <= 6 ? '#fff0f0' : i <= 8 ? '#fef3c7' : '#d1fae5', color: i <= 6 ? '#b41340' : i <= 8 ? '#d97706' : '#059669' }}>
              {i}
            </div>
          ))}
        </div>
      );
    case 'csat': {
      const csatStyle = ((q as unknown as Record<string, unknown>).csatStyle as string) || 'emoji';
      if (csatStyle === 'stars') {
        return (
          <div className="flex gap-1 mt-3">
            {Array.from({ length: 5 }, (_, i) => (
              <Icon key={i} name="star" fill={1} size={22} style={{ color: '#fbbf24' }} />
            ))}
          </div>
        );
      }
      if (csatStyle === 'numbers') {
        return (
          <div className="flex gap-1.5 mt-3">
            {[1, 2, 3, 4, 5].map((n) => (
              <div key={n} className="flex-1 h-8 rounded-lg flex items-center justify-center text-xs font-bold" style={{ background: bg }}>
                {n}
              </div>
            ))}
          </div>
        );
      }
      return (
        <div className="flex gap-3 mt-3">
          {['😠', '😕', '😐', '😊', '😍'].map((e, i) => (
            <div key={i} className="flex flex-col items-center gap-1">
              <div className="w-10 h-10 rounded-full flex items-center justify-center text-xl" style={{ background: bg }}>{e}</div>
              <span className="text-[9px] text-muted-foreground">{i + 1}</span>
            </div>
          ))}
        </div>
      );
    }
    case 'rating':
      return (
        <div className="flex gap-1 mt-3">
          {Array.from({ length: (q as { scaleMax?: number }).scaleMax || 5 }, (_, i) => (
            <Icon key={i} name="star" fill={1} size={22} style={{ color: '#fbbf24' }} />
          ))}
        </div>
      );
    case 'slider': {
      const sq = q as { labelLow?: string; labelHigh?: string; min?: number; max?: number };
      return (
        <div className="mt-3 px-1">
          <div className="relative h-2 rounded-full bg-[#dfe3e6]">
            <div className="absolute left-0 top-0 h-full rounded-full w-1/3 bg-gradient-to-br from-[var(--color-primary)] to-[var(--color-tertiary)]" />
            <div className="absolute top-1/2 left-1/3 -translate-x-1/2 -translate-y-1/2 w-4 h-4 rounded-full bg-white shadow-md border-2 border-[var(--color-primary)]" />
          </div>
          <div className="flex justify-between mt-1">
            <span className="text-[10px] text-muted-foreground">{sq.labelLow || sq.min}</span>
            <span className="text-[10px] text-muted-foreground">{sq.labelHigh || sq.max}</span>
          </div>
        </div>
      );
    }
    case 'multiple_choice':
    case 'checkbox': {
      const cq = q as { options?: string[]; allowOther?: boolean };
      return (
        <div className="mt-3 space-y-1.5">
          {(cq.options || []).slice(0, 4).map((opt: string, i: number) => (
            <div key={i} className="flex items-center gap-2.5 px-3 py-2 rounded-lg" style={{ background: bg }}>
              <div className={`w-4 h-4 border-2 flex-shrink-0 ${q.type === 'checkbox' ? 'rounded' : 'rounded-full'} border-[#dfe3e6]`} />
              <span className="text-sm text-[#595c5e]">{opt}</span>
            </div>
          ))}
          {cq.allowOther && (
            <div className="flex items-center gap-2.5 px-3 py-2 rounded-lg" style={{ background: bg }}>
              <div className={`w-4 h-4 border-2 flex-shrink-0 ${q.type === 'checkbox' ? 'rounded' : 'rounded-full'} border-[#dfe3e6]`} />
              <span className="text-sm italic text-[#abadaf]">Other (specify)</span>
            </div>
          )}
        </div>
      );
    }
    case 'dropdown': {
      const dq = q as { placeholder?: string };
      return (
        <div className="mt-3 flex items-center justify-between px-3 py-2.5 rounded-lg border border-[#dfe3e6]" style={{ background: bg }}>
          <span className="text-sm text-[#abadaf]">{dq.placeholder || 'Choose an option...'}</span>
          <Icon name="expand_more" size={18} style={{ color: '#abadaf' }} />
        </div>
      );
    }
    case 'ranking': {
      const rq = q as { options?: string[] };
      return (
        <div className="mt-3 space-y-1.5">
          {(rq.options || []).slice(0, 3).map((opt: string, i: number) => (
            <div key={i} className="flex items-center gap-2.5 px-3 py-2 rounded-lg" style={{ background: bg }}>
              <span className="w-5 h-5 rounded flex items-center justify-center text-[10px] font-bold flex-shrink-0 bg-[#dfe3e6] text-[#595c5e]">{i + 1}</span>
              <span className="text-sm flex-1 text-[#595c5e]">{opt}</span>
              <Icon name="drag_indicator" size={16} style={{ color: '#dfe3e6' }} />
            </div>
          ))}
        </div>
      );
    }
    case 'open_text': {
      const oq = q as { placeholder?: string };
      return (
        <div className="mt-3 rounded-lg h-16 flex items-center px-3 border-[1.5px] border-dashed border-[#dfe3e6]" style={{ background: bg }}>
          <span className="text-sm italic text-[#abadaf]">{oq.placeholder || 'Respondent types here…'}</span>
        </div>
      );
    }
    case 'short_text': {
      const stq = q as { placeholder?: string };
      return (
        <div className="mt-3 rounded-lg h-10 flex items-center px-3 border-[1.5px] border-[#dfe3e6]" style={{ background: bg }}>
          <span className="text-sm italic text-[#abadaf]">{stq.placeholder || 'Short answer…'}</span>
        </div>
      );
    }
    case 'matrix': {
      const mq = q as { columns?: string[]; rows?: string[] };
      return (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr>
                <th className="text-left py-1 pr-2 font-normal text-[#abadaf]" style={{ width: '35%' }}></th>
                {(mq.columns || []).slice(0, 4).map((col: string, i: number) => (
                  <th key={i} className="py-1 px-1 text-center font-semibold text-[#595c5e]">{col}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(mq.rows || []).slice(0, 3).map((row: string, i: number) => (
                <tr key={i} style={{ background: i % 2 === 0 ? bg : 'transparent' }}>
                  <td className="py-1.5 pr-2 font-medium text-[#595c5e]">{row}</td>
                  {(mq.columns || []).slice(0, 4).map((_: string, j: number) => (
                    <td key={j} className="py-1.5 px-1 text-center">
                      <div className="w-3.5 h-3.5 rounded-full border-2 mx-auto border-[#dfe3e6]" />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case 'date': {
      const dateq = q as { dateType?: string };
      return (
        <div className="mt-3 flex items-center gap-2 px-3 py-2.5 rounded-lg border border-[#dfe3e6]" style={{ background: bg }}>
          <Icon name="calendar_today" size={16} style={{ color: '#abadaf' }} />
          <span className="text-sm text-[#abadaf]">
            {dateq.dateType === 'time' ? 'HH:MM' : dateq.dateType === 'datetime' ? 'DD/MM/YYYY  HH:MM' : 'DD / MM / YYYY'}
          </span>
        </div>
      );
    }
    case 'statement':
      return (
        <div className="mt-2 h-px rounded bg-gradient-to-r from-[var(--color-primary)] to-transparent opacity-20" />
      );
    default:
      return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// QUESTION CARD
// ─────────────────────────────────────────────────────────────────────────────

interface QuestionCardProps {
  q: Question;
  index: number;
  total: number;
  selected: boolean;
  onSelect: (id: string) => void;
  onUpdate: (id: string, updates: Partial<Question>) => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
  isDragging: boolean;
  isDragOver: boolean;
  onDragStart: () => void;
  onDragOver: () => void;
  onDrop: () => void;
}

function QuestionCard({ q, index, selected, onSelect, onUpdate, onDelete, onDuplicate, isDragging, isDragOver, onDragStart, onDragOver, onDrop }: QuestionCardProps) {
  const meta = (QTYPE_META[q.type as keyof typeof QTYPE_META] || QTYPE_META.open_text) as QtypeMeta;
  const [hovered, setHovered] = useState(false);
  const [editingText, setEditingText] = useState(false);
  const titleRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editingText) titleRef.current?.focus();
  }, [editingText]);

  const qAny = q as unknown as Record<string, unknown>;
  const hasSkipLogic    = Array.isArray(qAny.skipLogic) && (qAny.skipLogic as unknown[]).length > 0;
  const hasDisplayLogic = !!qAny.displayLogic;

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={(e: React.DragEvent<HTMLDivElement>) => { e.preventDefault(); onDragOver(); }}
      onDrop={onDrop}
      onClick={() => onSelect(q.id)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="relative rounded-2xl cursor-pointer transition-all"
      style={{
        background:  'white',
        border:      selected ? '2px solid var(--color-primary)' : isDragOver ? '2px dashed var(--color-primary)' : '1px solid rgba(171,173,175,0.15)',
        opacity:     isDragging ? 0.4 : 1,
        transform:   hovered && !selected ? 'perspective(1200px) rotateX(-0.5deg) translateY(-2px)' : 'none',
        boxShadow:   selected
          ? '0 0 0 4px color-mix(in srgb, var(--color-primary) 8%, transparent), 0 16px 40px color-mix(in srgb, var(--color-primary) 12%, transparent)'
          : hovered
            ? '0 16px 48px rgba(0,0,0,0.1)'
            : '0 4px 16px rgba(0,0,0,0.04)',
        transition:  'all 0.2s ease',
        marginBottom: isDragOver ? 0 : undefined,
      }}
    >
      {/* Drag handle */}
      <div
        className="absolute left-0 top-0 bottom-0 flex flex-col items-center justify-center gap-1 w-7 cursor-grab rounded-l-2xl transition-opacity"
        style={{ opacity: hovered || selected ? 1 : 0 }}
      >
        {[0,1,2,3].map((i) => (
          <div key={i} className="w-1.5 h-1.5 rounded-full bg-[#dfe3e6]" />
        ))}
      </div>

      <div className="pl-7 pr-5 pt-5 pb-5">
        {/* Header */}
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] font-black uppercase tracking-widest px-2.5 py-1 rounded-full flex items-center gap-1"
              style={{ background: meta.bg, color: meta.color }}>
              <Icon name={meta.icon} size={11} />
              Q{String(index + 1).padStart(2, '0')} · {meta.label}
            </span>
            {q.required && (
              <span className="text-[10px] font-bold text-error uppercase tracking-wider">Required</span>
            )}
            {hasSkipLogic && (
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full flex items-center gap-1 bg-[color-mix(in_srgb,var(--color-primary)_8%,transparent)] text-[var(--color-primary)]">
                <Icon name="schema" size={10} />skip
              </span>
            )}
            {hasDisplayLogic && (
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full flex items-center gap-1 bg-[rgba(5,150,105,0.08)] text-[var(--color-success)]">
                <Icon name="visibility" size={10} />conditional
              </span>
            )}
          </div>

          {/* Actions */}
          <div className="flex items-center gap-1" style={{ opacity: hovered || selected ? 1 : 0, transition: 'opacity 0.15s' }}>
            <Button
              variant="ghost"
              size="icon"
              onClick={(e: React.MouseEvent) => { e.stopPropagation(); onDuplicate(q.id); }}
              title="Duplicate"
              className="h-7 w-7 rounded-lg hover:bg-[#eef1f3]"
            >
              <Icon name="content_copy" size={15} className="text-muted-foreground" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={(e: React.MouseEvent) => { e.stopPropagation(); onDelete(q.id); }}
              title="Delete"
              className="h-7 w-7 rounded-lg hover:bg-[#fff0f0] text-destructive"
            >
              <Icon name="delete" size={15} />
            </Button>
          </div>
        </div>

        {/* Question text */}
        {q.type === 'statement' ? (
          <h3 className="text-lg font-extrabold font-headline text-foreground">{q.question || 'Section Title'}</h3>
        ) : (
          <div
            onClick={(e: React.MouseEvent) => { e.stopPropagation(); setEditingText(true); }}
            title="Click to edit question text"
            className={cn(
              'cursor-text rounded-lg transition-all',
              !editingText && 'hover:bg-[color-mix(in_srgb,var(--color-primary)_4%,transparent)] hover:ring-1 hover:ring-[color-mix(in_srgb,var(--color-primary)_15%,transparent)]',
            )}
          >
            {editingText ? (
              <Textarea
                ref={titleRef}
                value={q.question}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => onUpdate(q.id, { question: e.target.value } as Partial<Question>)}
                onBlur={() => setEditingText(false)}
                rows={2}
                className="w-full resize-none text-base font-semibold rounded-lg px-3 py-2 font-headline text-foreground border border-[color-mix(in_srgb,var(--color-primary)_30%,transparent)] focus-visible:ring-1 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_40%,transparent)] bg-white"
              />
            ) : (
              <div className="group px-3 py-2 flex items-start gap-2 min-h-[40px]">
                <p className={cn('text-base font-semibold font-headline leading-snug flex-1', q.question ? 'text-foreground' : 'text-muted-foreground/40 italic')}>
                  {q.question || 'Click to enter question text…'}
                </p>
                <Icon name="edit" size={13} className="text-muted-foreground/30 flex-shrink-0 mt-1 opacity-0 group-hover:opacity-100 transition-opacity" />
              </div>
            )}
          </div>
        )}

        {/* Answer preview */}
        {q.type !== 'statement' && <TypePreview q={q} />}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PROPERTIES PANEL
// ─────────────────────────────────────────────────────────────────────────────

interface OptionsEditorProps {
  options: string[];
  onChange: (opts: string[]) => void;
}

function OptionsEditor({ options, onChange }: OptionsEditorProps) {
  const add    = () => onChange([...options, `Option ${options.length + 1}`]);
  const remove = (i: number) => onChange(options.filter((_: string, j: number) => j !== i));
  const edit   = (i: number, v: string) => onChange(options.map((o: string, j: number) => (j === i ? v : o)));
  return (
    <div className="space-y-2">
      {options.map((opt: string, i: number) => (
        <div key={i} className="flex items-center gap-2">
          <div className="w-5 h-5 flex items-center justify-center rounded flex-shrink-0 text-[10px] font-bold bg-[#e5e9eb] text-[#595c5e]">{i + 1}</div>
          <Input
            value={opt}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => edit(i, e.target.value)}
            className="flex-1 text-xs h-8 rounded-lg bg-[#f5f7f9] border-[#dfe3e6] text-foreground focus-visible:ring-1"
          />
          <Button
            variant="ghost"
            size="icon"
            onClick={() => remove(i)}
            className="h-7 w-7 rounded hover:bg-[#fff0f0]"
          >
            <Icon name="close" size={14} className="text-destructive" />
          </Button>
        </div>
      ))}
      <Button
        variant="outline"
        onClick={add}
        className="w-full text-xs font-bold h-8 rounded-lg bg-[#f5f7f9] text-[var(--color-primary)] border-dashed border-[#c7d2fe] hover:bg-[#e0e7ff]"
      >
        <Icon name="add" size={14} /> Add option
      </Button>
    </div>
  );
}

interface RowsColumnsEditorProps {
  rows: string[];
  columns: string[];
  onRowsChange: (rows: string[]) => void;
  onColumnsChange: (cols: string[]) => void;
}

function RowsColumnsEditor({ rows, columns, onRowsChange, onColumnsChange }: RowsColumnsEditorProps) {
  const addRow    = () => onRowsChange([...rows, `Row ${rows.length + 1}`]);
  const addCol    = () => onColumnsChange([...columns, `Column ${columns.length + 1}`]);
  const editRow   = (i: number, v: string) => onRowsChange(rows.map((r: string, j: number) => (j === i ? v : r)));
  const editCol   = (i: number, v: string) => onColumnsChange(columns.map((c: string, j: number) => (j === i ? v : c)));
  const removeRow = (i: number) => onRowsChange(rows.filter((_: string, j: number) => j !== i));
  const removeCol = (i: number) => onColumnsChange(columns.filter((_: string, j: number) => j !== i));

  return (
    <div className="space-y-4">
      <div>
        <div className="text-xs font-bold mb-2 text-[#595c5e]">Rows</div>
        <div className="space-y-1.5">
          {rows.map((r: string, i: number) => (
            <div key={i} className="flex items-center gap-2">
              <Input value={r} onChange={(e: React.ChangeEvent<HTMLInputElement>) => editRow(i, e.target.value)}
                className="flex-1 text-xs h-7 rounded-lg bg-[#f5f7f9] border-[#dfe3e6] text-foreground focus-visible:ring-1" />
              <Button variant="ghost" size="icon" onClick={() => removeRow(i)} className="w-5 h-5 p-0">
                <Icon name="close" size={13} className="text-destructive" />
              </Button>
            </div>
          ))}
          <Button variant="ghost" size="sm" onClick={addRow}
            className="text-xs font-bold text-primary flex items-center gap-1 h-auto px-2 py-1.5">
            <Icon name="add" size={13} /> Add row
          </Button>
        </div>
      </div>
      <div>
        <div className="text-xs font-bold mb-2 text-[#595c5e]">Columns</div>
        <div className="space-y-1.5">
          {columns.map((c: string, i: number) => (
            <div key={i} className="flex items-center gap-2">
              <Input value={c} onChange={(e: React.ChangeEvent<HTMLInputElement>) => editCol(i, e.target.value)}
                className="flex-1 text-xs h-7 rounded-lg bg-[#f5f7f9] border-[#dfe3e6] text-foreground focus-visible:ring-1" />
              <Button variant="ghost" size="icon" onClick={() => removeCol(i)} className="w-5 h-5 p-0">
                <Icon name="close" size={13} className="text-destructive" />
              </Button>
            </div>
          ))}
          <Button variant="ghost" size="sm" onClick={addCol}
            className="text-xs font-bold text-primary flex items-center gap-1 h-auto px-2 py-1.5">
            <Icon name="add" size={13} /> Add column
          </Button>
        </div>
      </div>
    </div>
  );
}

interface SkipLogicEditorProps {
  q: Question;
  allQuestions: Question[];
  onChange: (rules: SkipRule[]) => void;
}

function SkipLogicEditor({ q, allQuestions, onChange }: SkipLogicEditorProps) {
  const qAny = q as unknown as Record<string, unknown>;
  const rules: SkipRule[]  = (qAny.skipLogic as SkipRule[]) || [];
  const others  = allQuestions.filter((x) => x.id !== q.id);

  // Operators available per question type category
  const NUMERIC_OPS   = ['lt', 'lte', 'gt', 'gte', 'eq', 'neq', 'answered', 'not_answered'];
  const CHOICE_OPS    = ['eq', 'neq', 'contains', 'answered', 'not_answered'];
  const TEXT_OPS      = ['answered', 'not_answered', 'contains', 'eq', 'neq'];
  const DEFAULT_OPS   = ['eq', 'neq', 'answered', 'not_answered'];

  const NUMERIC_TYPES = new Set(['nps', 'rating', 'slider', 'csat']);
  const CHOICE_TYPES  = new Set(['multiple_choice', 'checkbox', 'dropdown', 'ranking']);
  const TEXT_TYPES    = new Set(['open_text', 'short_text']);

  const ALL_OP_LABELS: Record<string, string> = {
    eq:          'equals',
    neq:         'not equals',
    lt:          'less than',
    lte:         'less than or equal',
    gt:          'greater than',
    gte:         'greater than or equal',
    contains:    'contains',
    answered:    'is answered',
    not_answered:'is not answered',
  };

  function getOpsForType(type: string): string[] {
    if (NUMERIC_TYPES.has(type))  return NUMERIC_OPS;
    if (CHOICE_TYPES.has(type))   return CHOICE_OPS;
    if (TEXT_TYPES.has(type))     return TEXT_OPS;
    return DEFAULT_OPS;
  }

  const availableOps = getOpsForType(q.type);
  const qOptions: string[] = (qAny.options as string[]) || [];
  const isChoiceType = CHOICE_TYPES.has(q.type);

  // Smart default operator when adding a new rule
  function defaultOperator(): string {
    if (NUMERIC_TYPES.has(q.type)) return 'lt';
    if (CHOICE_TYPES.has(q.type))  return 'eq';
    return 'answered';
  }

  // Smart default value when adding a new rule
  function defaultValue(): string {
    if (q.type === 'nps')    return '7';
    if (q.type === 'rating') return String((qAny.scaleMax as number) ?? 3);
    if (q.type === 'slider') return String((qAny.min as number) ?? 0);
    if (qOptions.length > 0) return qOptions[0];
    return '';
  }

  // Numeric hint placeholder
  function valuePlaceholder(): string {
    if (q.type === 'nps')    return '0–10';
    if (q.type === 'rating') return `1–${(qAny.scaleMax as number) ?? 5}`;
    if (q.type === 'slider') return `${(qAny.min as number) ?? 0}–${(qAny.max as number) ?? 100}`;
    if (q.type === 'csat')   return '1–5';
    return 'Value…';
  }

  type OpKey = SkipLogicRule['condition']['operator'];

  // When operator changes, reset value if it no longer makes sense
  function handleOperatorChange(ruleId: string, newOp: string) {
    const op = newOp as OpKey;
    const noVal = op === 'answered' || op === 'not_answered';
    updateCond(ruleId, { operator: op, value: noVal ? '' : defaultValue() });
  }

  const addRule = () => onChange([
    ...rules,
    {
      id:          `sl_${Date.now()}`,
      condition:   { operator: defaultOperator() as OpKey, value: defaultValue() },
      destination: others[0]?.id || 'END_SURVEY',
    },
  ]);
  const removeRule  = (id: string) => onChange(rules.filter((r) => r.id !== id));
  const updateRule  = (id: string, patch: Partial<SkipRule>) => onChange(rules.map((r) => r.id === id ? { ...r, ...patch } : r));
  const updateCond  = (id: string, patch: Partial<SkipRule['condition']>) => onChange(rules.map((r) => r.id === id ? { ...r, condition: { ...r.condition, ...patch } } : r));

  const noValueNeeded = (op: string) => op === 'answered' || op === 'not_answered';

  return (
    <div className="space-y-3">
      {rules.map((rule) => {
        const needsValue = !noValueNeeded(rule.condition.operator);
        return (
          <div key={rule.id} className="rounded-xl p-3 space-y-2 bg-[color-mix(in_srgb,var(--color-primary)_4%,transparent)] border border-[color-mix(in_srgb,var(--color-primary)_12%,transparent)]">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-black uppercase tracking-widest text-[var(--color-primary)]">If answer…</span>
              <Button variant="ghost" size="icon" onClick={() => removeRule(rule.id)} className="h-6 w-6 rounded">
                <Icon name="close" size={14} className="text-destructive" />
              </Button>
            </div>

            {/* Operator selector — filtered to relevant operators for this question type */}
            <Select
              value={availableOps.includes(rule.condition.operator) ? rule.condition.operator : availableOps[0]}
              onValueChange={(v: string) => handleOperatorChange(rule.id, v)}
            >
              <SelectTrigger className="w-full text-xs h-8 rounded-lg bg-[#f5f7f9] border-[#dfe3e6] text-foreground">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {availableOps.map((op) => (
                  <SelectItem key={op} value={op}>{ALL_OP_LABELS[op]}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Value input — options dropdown for choice types, plain input for others */}
            {needsValue && (
              isChoiceType && qOptions.length > 0 ? (
                <Select
                  value={String(rule.condition.value ?? '')}
                  onValueChange={(v: string) => updateCond(rule.id, { value: v })}
                >
                  <SelectTrigger className="w-full text-xs h-8 rounded-lg bg-[#f5f7f9] border-[#dfe3e6] text-foreground">
                    <SelectValue placeholder="Select option…" />
                  </SelectTrigger>
                  <SelectContent>
                    {qOptions.map((opt: string) => (
                      <SelectItem key={opt} value={opt}>{opt}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  type={NUMERIC_TYPES.has(q.type) ? 'number' : 'text'}
                  value={String(rule.condition.value ?? '')}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateCond(rule.id, { value: e.target.value })}
                  placeholder={valuePlaceholder()}
                  className="w-full text-xs h-8 rounded-lg bg-[#f5f7f9] border-[#dfe3e6] text-foreground focus-visible:ring-1"
                />
              )
            )}

            {/* Destination selector */}
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-black uppercase tracking-widest text-[var(--color-primary)]">Then…</span>
              <Select value={rule.destination} onValueChange={(v: string) => updateRule(rule.id, { destination: v })}>
                <SelectTrigger className="flex-1 text-xs h-8 rounded-lg bg-[#f5f7f9] border-[#dfe3e6] text-foreground">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {others.map((x) => (
                    <SelectItem key={x.id} value={x.id}>
                      Jump to Q{allQuestions.indexOf(x) + 1}: {x.question.slice(0, 40) || `(Q${allQuestions.indexOf(x) + 1})`}
                    </SelectItem>
                  ))}
                  <SelectItem value="END_SURVEY">End survey</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        );
      })}
      <Button
        variant="outline"
        onClick={addRule}
        className="w-full text-xs font-bold h-8 rounded-xl bg-[color-mix(in_srgb,var(--color-primary)_5%,transparent)] text-[var(--color-primary)] border-dashed border-[color-mix(in_srgb,var(--color-primary)_20%,transparent)] hover:bg-[color-mix(in_srgb,var(--color-primary)_8%,transparent)]"
      >
        <Icon name="add" size={14} /> Add skip rule
      </Button>
    </div>
  );
}

interface DisplayLogicEditorProps {
  q: Question;
  allQuestions: Question[];
  onChange: (dl: DisplayLogic | null) => void;
}

function DisplayLogicEditor({ q, allQuestions, onChange }: DisplayLogicEditorProps) {
  const qAny = q as unknown as Record<string, unknown>;
  const dl = (qAny.displayLogic as DisplayLogic) || null;
  const others = allQuestions.filter((x) => x.id !== q.id);
  const OPERATORS = ['eq','neq','lt','gt','lte','gte','contains','answered'];
  const OP_LABELS: Record<string, string> = { eq:'equals', neq:'not equals', lt:'less than', gt:'greater than', lte:'≤', gte:'≥', contains:'contains', answered:'is answered' };

  if (!dl) {
    return (
      <Button
        variant="outline"
        onClick={() => {
          if (others.length === 0) return;
          onChange({ sourceQuestionId: others[0].id, operator: 'eq', value: '' });
        }}
        disabled={others.length === 0}
        className="w-full text-xs font-bold h-9 rounded-xl bg-[rgba(5,150,105,0.05)] text-[var(--color-success)] border-dashed border-[rgba(5,150,105,0.2)] hover:bg-[rgba(5,150,105,0.08)] disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <Icon name="add" size={14} /> Add display condition
      </Button>
    );
  }

  const qIndex = (id: string) => allQuestions.findIndex((x) => x.id === id);

  return (
    <div className="rounded-xl p-3 space-y-2 bg-[rgba(5,150,105,0.04)] border border-[rgba(5,150,105,0.12)]">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-black uppercase tracking-widest text-[var(--color-success)]">Show only if…</span>
        <Button variant="ghost" size="icon" onClick={() => onChange(null)} className="h-6 w-6 rounded">
          <Icon name="close" size={14} className="text-destructive" />
        </Button>
      </div>
      <Select value={dl.sourceQuestionId || undefined} onValueChange={(v: string) => onChange({ ...dl, sourceQuestionId: v })}>
        <SelectTrigger className="w-full text-xs h-8 rounded-lg bg-[#f5f7f9] border-[#dfe3e6] text-foreground">
          <SelectValue placeholder="Select question…" />
        </SelectTrigger>
        <SelectContent>
          {others.map((x) => (
            <SelectItem key={x.id} value={x.id}>Q{qIndex(x.id) + 1}: {x.question.slice(0, 40) || `(Q${qIndex(x.id) + 1})`}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={dl.operator} onValueChange={(v: string) => onChange({ ...dl, operator: v })}>
        <SelectTrigger className="w-full text-xs h-8 rounded-lg bg-[#f5f7f9] border-[#dfe3e6] text-foreground">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {OPERATORS.map((op) => <SelectItem key={op} value={op}>{OP_LABELS[op]}</SelectItem>)}
        </SelectContent>
      </Select>
      {dl.operator !== 'answered' && (
        <Input type="text" value={String(dl.value ?? '')} onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange({ ...dl, value: e.target.value })}
          placeholder="Value…" className="w-full text-xs h-8 rounded-lg bg-[#f5f7f9] border-[#dfe3e6] text-foreground focus-visible:ring-1" />
      )}
    </div>
  );
}

interface PropertiesPanelProps {
  q: Question | null;
  allQuestions: Question[];
  onUpdate: (id: string, updates: Partial<Question>) => void;
  onClose: () => void;
}

function PropertiesPanel({ q, allQuestions, onUpdate, onClose }: PropertiesPanelProps) {
  if (!q) return null;
  const meta = (QTYPE_META[q.type as keyof typeof QTYPE_META] || QTYPE_META.open_text) as QtypeMeta;
  const u    = (patch: Partial<Question>) => onUpdate(q.id, patch);
  const qAny = q as unknown as Record<string, unknown>;

  const TYPES_LIST = Object.entries(QTYPE_META).map(([k, v]) => ({ value: k, label: (v as QtypeMeta).label }));

  return (
    <div className="h-full flex flex-col overflow-y-auto bg-[#fafbfc]">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 sticky top-0 z-10 bg-[#fafbfc] border-b border-[rgba(171,173,175,0.1)]">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: meta.bg, color: meta.color }}>
            <Icon name={meta.icon} size={15} />
          </div>
          <span className="text-sm font-extrabold font-headline text-foreground">Properties</span>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} className="h-7 w-7 rounded-lg hover:bg-[#eef1f3]">
          <Icon name="close" size={18} className="text-muted-foreground" />
        </Button>
      </div>

      <div className="flex-1 px-5 py-4 space-y-5 overflow-y-auto">
        {/* Question text */}
        <div>
          <Label className="text-[10px] font-black uppercase tracking-widest block mb-1.5 text-muted-foreground">Question Text</Label>
          <Textarea value={q.question} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => u({ question: e.target.value } as Partial<Question>)}
            rows={3} placeholder="Enter your question…"
            className="w-full resize-none text-sm px-3 py-2.5 rounded-[10px] bg-white border-[#dfe3e6] text-foreground focus-visible:ring-1" />
        </div>

        {/* Question type */}
        <div>
          <Label className="text-[10px] font-black uppercase tracking-widest block mb-1.5 text-muted-foreground">Question Type</Label>
          <Select value={q.type} onValueChange={(newType: string) => {
            const fresh = createQuestion(newType) as Question;
            onUpdate(q.id, {
              ...fresh,
              id: q.id,
              question: q.question,
              required: q.required,
              skipLogic: [],      // clear — logic conditions were for old type
              displayLogic: null, // clear — source conditions may be incompatible
            } as Partial<Question>);
          }}>
            <SelectTrigger className="w-full text-sm h-10 rounded-[10px] bg-white border-[#dfe3e6] text-foreground">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TYPES_LIST.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        {/* Required toggle */}
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold text-foreground">Required</div>
            <div className="text-xs text-muted-foreground">Respondent must answer</div>
          </div>
          <Switch
            checked={!!q.required}
            onCheckedChange={(checked: boolean) => u({ required: checked } as Partial<Question>)}
          />
        </div>

        {/* Type-specific settings */}
        {(q.type === 'rating') && (
          <div className="space-y-3">
            <Separator />
            <Label className="text-[10px] font-black uppercase tracking-widest block text-muted-foreground">Scale Max</Label>
            <div className="flex gap-2">
              {[5, 7, 10].map((n) => (
                <Button key={n} onClick={() => u({ scaleMax: n } as Partial<Question>)}
                  variant={(qAny.scaleMax as number) === n ? 'default' : 'outline'}
                  size="sm"
                  className={cn('flex-1 rounded-lg text-xs', (qAny.scaleMax as number) !== n && 'bg-[#f5f7f9] border-[#dfe3e6] text-[#595c5e] hover:bg-[#e0e7ff]')}>
                  1–{n}
                </Button>
              ))}
            </div>
            <Label className="text-[10px] font-black uppercase tracking-widest block text-muted-foreground">Display Style</Label>
            <div className="flex gap-2">
              {['stars','numbers'].map((s) => (
                <Button key={s} onClick={() => u({ ratingStyle: s } as Partial<Question>)}
                  variant={(qAny.ratingStyle as string) === s ? 'default' : 'outline'}
                  size="sm"
                  className={cn('flex-1 rounded-lg text-xs capitalize', (qAny.ratingStyle as string) !== s && 'bg-[#f5f7f9] border-[#dfe3e6] text-[#595c5e] hover:bg-[#e0e7ff]')}>
                  {s}
                </Button>
              ))}
            </div>
          </div>
        )}

        {(q.type === 'nps') && (
          <div className="space-y-3">
            <Separator />
            <div>
              <Label className="text-[10px] font-black uppercase tracking-widest block mb-1 text-muted-foreground">Low end label</Label>
              <Input value={(qAny.labelLow as string) || ''} onChange={(e: React.ChangeEvent<HTMLInputElement>) => u({ labelLow: e.target.value } as Partial<Question>)} placeholder="Not at all likely"
                className="w-full text-xs h-8 rounded-lg bg-white border-[#dfe3e6] text-foreground focus-visible:ring-1" />
            </div>
            <div>
              <Label className="text-[10px] font-black uppercase tracking-widest block mb-1 text-muted-foreground">High end label</Label>
              <Input value={(qAny.labelHigh as string) || ''} onChange={(e: React.ChangeEvent<HTMLInputElement>) => u({ labelHigh: e.target.value } as Partial<Question>)} placeholder="Extremely likely"
                className="w-full text-xs h-8 rounded-lg bg-white border-[#dfe3e6] text-foreground focus-visible:ring-1" />
            </div>
          </div>
        )}

        {(q.type === 'csat') && (
          <div className="space-y-3">
            <Separator />
            <Label className="text-[10px] font-black uppercase tracking-widest block text-muted-foreground">Display Style</Label>
            <div className="flex gap-2">
              {[['emoji', '😊 Emoji'], ['stars', '⭐ Stars'], ['numbers', '1–5 Numbers']].map(([s, label]) => (
                <Button key={s} onClick={() => u({ csatStyle: s } as Partial<Question>)}
                  size="sm"
                  className={cn(
                    'flex-1 rounded-lg text-xs',
                    (qAny.csatStyle as string) === s
                      ? 'bg-[var(--color-warning)] text-white border-[var(--color-warning)]'
                      : 'bg-[#f5f7f9] text-[#595c5e] border-[#dfe3e6] hover:bg-[#fef3c7]'
                  )}>
                  {label}
                </Button>
              ))}
            </div>
          </div>
        )}

        {(q.type === 'slider') && (
          <div className="space-y-3">
            <Separator />
            <div className="grid grid-cols-2 gap-2">
              {[['min', 'Min'], ['max', 'Max'], ['step', 'Step']].map(([k, l]) => (
                <div key={k}>
                  <Label className="text-[10px] font-black uppercase tracking-widest block mb-1 text-muted-foreground">{l}</Label>
                  <Input type="number" value={(qAny[k] as number) ?? ''} onChange={(e: React.ChangeEvent<HTMLInputElement>) => u({ [k]: Number(e.target.value) } as Partial<Question>)}
                    className="w-full text-xs h-8 rounded-lg bg-white border-[#dfe3e6] text-foreground focus-visible:ring-1" />
                </div>
              ))}
            </div>
            <div>
              <Label className="text-[10px] font-black uppercase tracking-widest block mb-1 text-muted-foreground">Low label</Label>
              <Input value={(qAny.labelLow as string) || ''} onChange={(e: React.ChangeEvent<HTMLInputElement>) => u({ labelLow: e.target.value } as Partial<Question>)}
                className="w-full text-xs h-8 rounded-lg bg-white border-[#dfe3e6] text-foreground focus-visible:ring-1" />
            </div>
            <div>
              <Label className="text-[10px] font-black uppercase tracking-widest block mb-1 text-muted-foreground">High label</Label>
              <Input value={(qAny.labelHigh as string) || ''} onChange={(e: React.ChangeEvent<HTMLInputElement>) => u({ labelHigh: e.target.value } as Partial<Question>)}
                className="w-full text-xs h-8 rounded-lg bg-white border-[#dfe3e6] text-foreground focus-visible:ring-1" />
            </div>
          </div>
        )}

        {(['multiple_choice','checkbox','dropdown','ranking'].includes(q.type)) && (
          <div className="space-y-3">
            <Separator />
            <Label className="text-[10px] font-black uppercase tracking-widest block text-muted-foreground">Options</Label>
            <OptionsEditor options={(qAny.options as string[]) || []} onChange={(opts: string[]) => u({ options: opts } as Partial<Question>)} />
            {(q.type === 'multiple_choice' || q.type === 'checkbox') && (
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-[#595c5e]">Allow "Other"</span>
                <Switch
                  checked={!!(qAny.allowOther)}
                  onCheckedChange={(checked: boolean) => u({ allowOther: checked } as Partial<Question>)}
                />
              </div>
            )}
            {q.type === 'checkbox' && (
              <div>
                <Label className="text-[10px] font-black uppercase tracking-widest block mb-1 text-muted-foreground">Max selections</Label>
                <Input type="number" min={1} value={(qAny.maxSelections as number) || ''} onChange={(e: React.ChangeEvent<HTMLInputElement>) => u({ maxSelections: e.target.value ? Number(e.target.value) : null } as Partial<Question>)}
                  placeholder="No limit"
                  className="w-full text-xs h-8 rounded-lg bg-white border-[#dfe3e6] text-foreground focus-visible:ring-1" />
              </div>
            )}
          </div>
        )}

        {q.type === 'matrix' && (
          <div className="space-y-3">
            <Separator />
            <RowsColumnsEditor
              rows={(qAny.rows as string[]) || []} columns={(qAny.columns as string[]) || []}
              onRowsChange={(r: string[]) => u({ rows: r } as Partial<Question>)} onColumnsChange={(c: string[]) => u({ columns: c } as Partial<Question>)} />
            <Label className="text-[10px] font-black uppercase tracking-widest block text-muted-foreground">Cell type</Label>
            <div className="flex gap-2">
              {['radio','checkbox'].map((t) => (
                <Button key={t} onClick={() => u({ matrixType: t } as Partial<Question>)}
                  size="sm"
                  className={cn(
                    'flex-1 rounded-lg text-xs capitalize',
                    (qAny.matrixType as string) === t
                      ? 'bg-[#6d28d9] text-white border-[#6d28d9]'
                      : 'bg-[#f5f7f9] text-[#595c5e] border-[#dfe3e6] hover:bg-purple-50'
                  )}>
                  {t}
                </Button>
              ))}
            </div>
          </div>
        )}

        {(q.type === 'open_text' || q.type === 'short_text') && (
          <div className="space-y-3">
            <Separator />
            <div>
              <Label className="text-[10px] font-black uppercase tracking-widest block mb-1 text-muted-foreground">Placeholder text</Label>
              <Input value={(qAny.placeholder as string) || ''} onChange={(e: React.ChangeEvent<HTMLInputElement>) => u({ placeholder: e.target.value } as Partial<Question>)}
                className="w-full text-xs h-8 rounded-lg bg-white border-[#dfe3e6] text-foreground focus-visible:ring-1" />
            </div>
            <div>
              <Label className="text-[10px] font-black uppercase tracking-widest block mb-1 text-muted-foreground">Max characters</Label>
              <Input type="number" value={(qAny.maxLength as number) || ''} onChange={(e: React.ChangeEvent<HTMLInputElement>) => u({ maxLength: e.target.value ? Number(e.target.value) : null } as Partial<Question>)}
                placeholder="No limit"
                className="w-full text-xs h-8 rounded-lg bg-white border-[#dfe3e6] text-foreground focus-visible:ring-1" />
            </div>
            {q.type === 'short_text' && (
              <div>
                <Label className="text-[10px] font-black uppercase tracking-widest block mb-1 text-muted-foreground">Validation</Label>
                <Select value={(qAny.validation as string) || '__none__'} onValueChange={(v: string) => u({ validation: v === '__none__' ? null : v } as Partial<Question>)}>
                  <SelectTrigger className="w-full text-xs h-8 rounded-lg bg-white border-[#dfe3e6] text-foreground">
                    <SelectValue placeholder="None" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">None</SelectItem>
                    <SelectItem value="email">Email address</SelectItem>
                    <SelectItem value="url">URL</SelectItem>
                    <SelectItem value="number">Number only</SelectItem>
                    <SelectItem value="phone">Phone number</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
        )}

        {q.type === 'date' && (
          <div className="space-y-3">
            <Separator />
            <Label className="text-[10px] font-black uppercase tracking-widest block text-muted-foreground">Date Type</Label>
            <div className="flex gap-2">
              {[['date', 'Date'], ['time', 'Time'], ['datetime', 'Date & Time']].map(([t, label]) => (
                <Button key={t} onClick={() => u({ dateType: t } as Partial<Question>)}
                  size="sm"
                  className={cn(
                    'flex-1 rounded-lg text-xs',
                    (qAny.dateType as string) === t
                      ? 'bg-[#0f766e] text-white border-[#0f766e]'
                      : 'bg-[#f5f7f9] text-[#595c5e] border-[#dfe3e6] hover:bg-teal-50'
                  )}>
                  {label}
                </Button>
              ))}
            </div>
          </div>
        )}

        {/* Skip Logic */}
        <div>
          <Separator className="mb-4" />
          <Label className="text-[10px] font-black uppercase tracking-widest block mb-3 flex items-center gap-1.5 text-muted-foreground">
            <Icon name="schema" size={12} /> Skip Logic
          </Label>
          <SkipLogicEditor q={q} allQuestions={allQuestions} onChange={(sl: SkipRule[]) => u({ skipLogic: sl } as unknown as Partial<Question>)} />
        </div>

        {/* Display Logic */}
        <div>
          <Separator className="mb-4" />
          <Label className="text-[10px] font-black uppercase tracking-widest block mb-3 flex items-center gap-1.5 text-muted-foreground">
            <Icon name="visibility" size={12} /> Display Condition
          </Label>
          <DisplayLogicEditor q={q} allQuestions={allQuestions} onChange={(dl: DisplayLogic | null) => u({ displayLogic: dl } as Partial<Question>)} />
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PREVIEW MODE — fully interactive
// ─────────────────────────────────────────────────────────────────────────────

interface PreviewModeProps {
  questions: Question[];
  title: string;
  thankYouMessage: string;
  settings: SurveySettings;
  onClose: () => void;
}

function PreviewMode({ questions, title, thankYouMessage, settings, onClose }: PreviewModeProps) {
  const { t } = useTranslation();
  const [current, setCurrent] = useState(0);
  const [answers, setAnswers]  = useState<Record<string, unknown>>({});
  const [done, setDone]        = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const q = questions[current];
  const val = answers[q?.id];
  const setAnswer = (v: unknown) => q && setAnswers((prev) => ({ ...prev, [q.id]: v }));
  const canContinue = !q?.required || q?.type === 'statement' || val !== undefined;
  const progress = questions.length > 0 ? ((current + 1) / questions.length) * 100 : 0;

  const advance = () => {
    if (!q) return;
    const qAny = q as unknown as Record<string, unknown>;
    const skipLogic = (qAny.skipLogic as SkipRule[]) || [];
    const rule = skipLogic.find((r: SkipRule) => {
      const v = answers[q.id];
      const { operator, value } = r.condition;
      const num = Number(v), cmp = Number(value);
      if (operator === 'answered')     return v !== undefined && v !== '';
      if (operator === 'not_answered') return v === undefined || v === '';
      if (operator === 'eq')           return String(v) === String(value);
      if (operator === 'neq')          return String(v) !== String(value);
      if (operator === 'lt')           return !isNaN(num) && num < cmp;
      if (operator === 'lte')          return !isNaN(num) && num <= cmp;
      if (operator === 'gt')           return !isNaN(num) && num > cmp;
      if (operator === 'gte')          return !isNaN(num) && num >= cmp;
      if (operator === 'contains')     return String(v).includes(String(value));
      return false;
    });
    if (rule) {
      if (rule.destination === 'END_SURVEY') { setDone(true); return; }
      const idx = questions.findIndex((x) => x.id === rule.destination);
      if (idx !== -1) { setCurrent(idx); return; }
    }
    if (current < questions.length - 1) setCurrent(current + 1);
    else setDone(true);
  };

  interface QuestionInputProps {
    q: Question;
  }

  function QuestionInput({ q }: QuestionInputProps) {
    const v = answers[q.id];
    const ch = (newVal: unknown) => setAnswers((prev) => ({ ...prev, [q.id]: newVal }));
    const qAny = q as unknown as Record<string, unknown>;

    switch (q.type) {
      case 'nps':
        return (
          <div className="mt-5">
            <div className="flex gap-1">
              {Array.from({ length: 11 }, (_, i) => (
                <button key={i} onClick={() => ch(i)}
                  className="flex-1 py-3 rounded-xl text-sm font-bold transition-all active:scale-95"
                  style={{
                    background: v === i ? (i <= 6 ? '#b41340' : i <= 8 ? '#d97706' : '#059669') : '#eef1f3',
                    color: v === i ? '#fff' : '#595c5e',
                    transform: v === i ? 'scale(1.08)' : 'scale(1)',
                    boxShadow: v === i ? '0 4px 12px rgba(0,0,0,0.15)' : 'none',
                  }}>
                  {i}
                </button>
              ))}
            </div>
            <div className="flex justify-between mt-2 px-1">
              <span className="text-xs font-semibold" style={{ color: '#b41340' }}>{(qAny.labelLow as string) || t('fill.npsLabelLow')}</span>
              <span className="text-xs font-semibold" style={{ color: '#059669' }}>{(qAny.labelHigh as string) || t('fill.npsLabelHigh')}</span>
            </div>
          </div>
        );
      case 'csat': {
        const style = (qAny.csatStyle as string) || 'emoji';
        if (style === 'emoji') {
          const emojis: [string, string][] = [['😠','Very Bad'],['😕','Bad'],['😐','Neutral'],['😊','Good'],['😍','Excellent']];
          return (
            <div className="flex gap-3 mt-5 justify-center">
              {emojis.map(([emoji, label], i) => (
                <button key={i} onClick={() => ch(i + 1)}
                  className="flex flex-col items-center gap-1.5 p-3 rounded-2xl transition-all active:scale-95"
                  style={{
                    background: v === i + 1 ? '#e0e7ff' : '#f5f7f9',
                    border: v === i + 1 ? '2px solid var(--color-primary)' : '2px solid transparent',
                  }}>
                  <span className="text-3xl">{emoji}</span>
                  <span className="text-[10px] font-bold text-muted-foreground">{label}</span>
                </button>
              ))}
            </div>
          );
        }
        return (
          <div className="flex gap-2 mt-5">
            {Array.from({ length: 5 }, (_, i) => (
              <button key={i + 1} onClick={() => ch(i + 1)}
                className="flex-1 py-4 rounded-xl font-black text-xl transition-all active:scale-95"
                style={{ background: (v as number) >= i + 1 ? '#d97706' : '#eef1f3', color: (v as number) >= i + 1 ? '#fff' : '#c4c4c4' }}>
                {style === 'stars' ? '★' : i + 1}
              </button>
            ))}
          </div>
        );
      }
      case 'rating':
        return (
          <div className="flex gap-2 mt-5">
            {Array.from({ length: (qAny.scaleMax as number) || 5 }, (_, i) => (
              <button key={i + 1} onClick={() => ch(i + 1)}
                className="flex-1 py-4 rounded-xl font-black text-xl transition-all active:scale-95"
                style={{
                  background: (v as number) >= i + 1 ? 'var(--color-primary)' : '#eef1f3',
                  color: (v as number) >= i + 1 ? '#fff' : '#c4c4c4',
                  boxShadow: (v as number) >= i + 1 ? '0 8px 20px color-mix(in srgb, var(--color-primary) 20%, transparent)' : 'none',
                }}>
                {(qAny.ratingStyle as string) === 'numbers' ? i + 1 : '★'}
              </button>
            ))}
          </div>
        );
      case 'multiple_choice':
        return (
          <div className="flex flex-col gap-2.5 mt-5">
            {((qAny.options as string[]) || []).map((opt: string) => (
              <button key={opt} onClick={() => ch(opt)}
                className="flex items-center gap-3 px-5 py-4 rounded-xl text-left transition-all active:scale-95"
                style={{
                  background: v === opt ? '#e0e7ff' : '#eef1f3',
                  border: v === opt ? '2px solid var(--color-primary)' : '2px solid transparent',
                  color: v === opt ? 'var(--color-primary)' : '#2c2f31',
                }}>
                <div className="w-5 h-5 rounded-full flex-shrink-0 flex items-center justify-center"
                  style={{ border: v === opt ? '2px solid var(--color-primary)' : '2px solid #d0d5d8', background: v === opt ? 'var(--color-primary)' : 'transparent' }}>
                  {v === opt && <div className="w-2 h-2 rounded-full bg-white" />}
                </div>
                <span className="font-semibold text-sm">{opt}</span>
              </button>
            ))}
            {(qAny.allowOther as boolean) && (
              <div className="flex items-center gap-3 px-5 py-4 rounded-xl bg-[#eef1f3] border-2 border-transparent">
                <div className="w-5 h-5 rounded-full border-2 border-[#d0d5d8] flex-shrink-0" />
                <span className="font-semibold text-sm text-[#abadaf] italic">Other (specify)…</span>
              </div>
            )}
          </div>
        );
      case 'checkbox': {
        const arrVal = Array.isArray(v) ? (v as string[]) : [];
        const toggle = (opt: string) => ch(arrVal.includes(opt) ? arrVal.filter((x: string) => x !== opt) : [...arrVal, opt]);
        return (
          <div className="flex flex-col gap-2.5 mt-5">
            {((qAny.options as string[]) || []).map((opt: string) => (
              <button key={opt} onClick={() => toggle(opt)}
                className="flex items-center gap-3 px-5 py-4 rounded-xl text-left transition-all active:scale-95"
                style={{
                  background: arrVal.includes(opt) ? '#e0e7ff' : '#eef1f3',
                  border: arrVal.includes(opt) ? '2px solid var(--color-primary)' : '2px solid transparent',
                }}>
                <div className="w-5 h-5 rounded flex-shrink-0 flex items-center justify-center"
                  style={{ border: arrVal.includes(opt) ? '2px solid var(--color-primary)' : '2px solid #d0d5d8', background: arrVal.includes(opt) ? 'var(--color-primary)' : 'transparent' }}>
                  {arrVal.includes(opt) && <Icon name="check" size={12} style={{ color: '#fff' }} />}
                </div>
                <span className="font-semibold text-sm" style={{ color: arrVal.includes(opt) ? 'var(--color-primary)' : '#2c2f31' }}>{opt}</span>
              </button>
            ))}
          </div>
        );
      }
      case 'dropdown':
        return (
          <select value={(v as string) || ''} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => ch(e.target.value)}
            className="w-full mt-5 px-4 py-3 rounded-[10px] text-sm font-semibold bg-[#f5f7f9] border border-[#dfe3e6] text-foreground appearance-none cursor-pointer focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]">
            <option value="">{(qAny.placeholder as string) || 'Choose an option…'}</option>
            {((qAny.options as string[]) || []).map((opt: string) => <option key={opt} value={opt}>{opt}</option>)}
          </select>
        );
      case 'open_text':
        return (
          <textarea value={(v as string) || ''} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => ch(e.target.value)}
            placeholder={(qAny.placeholder as string) || t('fill.textareaPlaceholder')}
            rows={4}
            className="w-full mt-5 resize-none text-sm px-4 py-3 rounded-[10px] bg-[#f5f7f9] border border-[#dfe3e6] text-foreground focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] placeholder:text-[#abadaf]" />
        );
      case 'short_text':
        return (
          <input type="text" value={(v as string) || ''} onChange={(e: React.ChangeEvent<HTMLInputElement>) => ch(e.target.value)}
            placeholder={(qAny.placeholder as string) || 'Type your answer…'}
            className="w-full mt-5 px-4 py-3 rounded-[10px] text-sm font-medium bg-[#f5f7f9] border border-[#dfe3e6] text-foreground focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
        );
      case 'slider': {
        const min = (qAny.min as number) ?? 0;
        const max = (qAny.max as number) ?? 100;
        const step = (qAny.step as number) ?? 1;
        const cur = (v as number) ?? min;
        return (
          <div className="mt-6 px-2">
            <div className="flex justify-between text-xs font-semibold text-muted-foreground mb-3">
              <span>{(qAny.labelLow as string) || min}</span>
              <span className="text-base font-bold text-foreground">{cur}</span>
              <span>{(qAny.labelHigh as string) || max}</span>
            </div>
            <input type="range" min={min} max={max} step={step} value={cur}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => ch(Number(e.target.value))}
              className="w-full accent-[var(--color-primary)]" />
          </div>
        );
      }
      case 'date': {
        const inputType = (qAny.dateType as string) === 'time' ? 'time' : (qAny.dateType as string) === 'datetime' ? 'datetime-local' : 'date';
        return (
          <input type={inputType} value={(v as string) || ''} onChange={(e: React.ChangeEvent<HTMLInputElement>) => ch(e.target.value)}
            className="w-full mt-5 px-4 py-3 rounded-[10px] text-sm font-medium bg-[#f5f7f9] border border-[#dfe3e6] text-foreground focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]" />
        );
      }
      case 'matrix': {
        const rows = (qAny.rows as string[]) || [];
        const cols = (qAny.columns as string[]) || [];
        const multi = (qAny.matrixType as string) === 'checkbox';
        const matVal = (v as Record<string, string | string[]>) || {};
        const toggle = (row: string, col: string) => {
          if (multi) {
            const prev = (matVal[row] as string[]) || [];
            ch({ ...matVal, [row]: prev.includes(col) ? prev.filter((c: string) => c !== col) : [...prev, col] });
          } else {
            ch({ ...matVal, [row]: col });
          }
        };
        const isSel = (row: string, col: string) => multi ? ((matVal[row] as string[]) || []).includes(col) : matVal[row] === col;
        return (
          <div className="mt-5 overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr>
                  <th className="text-left py-2 pr-4 w-1/3" />
                  {cols.map((c: string) => <th key={c} className="py-2 px-2 text-center text-xs font-bold text-muted-foreground">{c}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((row: string, ri: number) => (
                  <tr key={row} style={{ background: ri % 2 === 0 ? '#f5f7f9' : 'transparent' }}>
                    <td className="py-3 pr-4 font-semibold text-sm text-foreground">{row}</td>
                    {cols.map((col: string) => (
                      <td key={col} className="py-3 px-2 text-center">
                        <button onClick={() => toggle(row, col)}
                          className={`w-5 h-5 mx-auto flex items-center justify-center ${multi ? 'rounded' : 'rounded-full'}`}
                          style={{ border: isSel(row, col) ? '2px solid var(--color-primary)' : '2px solid #d0d5d8', background: isSel(row, col) ? 'var(--color-primary)' : 'transparent' }}>
                          {isSel(row, col) && <Icon name="check" size={11} style={{ color: '#fff' }} />}
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
      case 'ranking': {
        const opts = (qAny.options as string[]) || [];
        const ranked = Array.isArray(v) && (v as string[]).length ? (v as string[]) : opts;
        const move = (from: number, to: number) => {
          const next = [...ranked];
          const [item] = next.splice(from, 1);
          next.splice(to, 0, item);
          ch(next);
        };
        return (
          <div className="mt-5 space-y-2">
            {ranked.map((opt: string, i: number) => (
              <div key={opt} className="flex items-center gap-3 px-4 py-3 rounded-xl bg-[#f5f7f9] border border-[#dfe3e6]">
                <span className="w-6 h-6 rounded-lg flex items-center justify-center text-xs font-black bg-[#e0e7ff] text-[var(--color-primary)] flex-shrink-0">{i + 1}</span>
                <span className="flex-1 text-sm font-semibold text-foreground">{opt}</span>
                <div className="flex flex-col gap-0.5">
                  <button onClick={() => { if (i > 0) move(i, i - 1); }} disabled={i === 0}
                    className="w-6 h-5 flex items-center justify-center rounded text-muted-foreground hover:bg-[#dfe3e6] disabled:opacity-30">
                    <Icon name="arrow_drop_up" size={16} />
                  </button>
                  <button onClick={() => { if (i < ranked.length - 1) move(i, i + 1); }} disabled={i === ranked.length - 1}
                    className="w-6 h-5 flex items-center justify-center rounded text-muted-foreground hover:bg-[#dfe3e6] disabled:opacity-30">
                    <Icon name="arrow_drop_down" size={16} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        );
      }
      default: return null;
    }
  }

  // Suppress unused variable warning — setAnswer is kept for potential future use
  void setAnswer;

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center py-6 bg-black/60 backdrop-blur-sm overflow-y-auto">
      <div className="relative w-full max-w-xl mx-4 rounded-3xl overflow-hidden bg-white shadow-[0_40px_100px_rgba(0,0,0,0.35)]">

        {/* Header bar */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[rgba(171,173,175,0.12)] bg-[#fafbfc]">
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-widest bg-[#e0e7ff] text-[var(--color-primary)]">
              <Icon name="play_arrow" size={12} />Preview
            </div>
            <span className="text-sm font-semibold text-foreground truncate max-w-[200px]">{title}</span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSettingsOpen((prev) => !prev)}
              className={cn(
                'rounded-full gap-1.5 h-auto py-1.5 px-3 text-xs font-bold',
                settingsOpen
                  ? 'bg-[color-mix(in_srgb,var(--color-primary)_8%,transparent)] text-[var(--color-primary)]'
                  : 'text-muted-foreground hover:bg-[#eef1f3]'
              )}
            >
              <Icon name="settings" size={13} />Settings
            </Button>
            <Button variant="ghost" size="icon" onClick={onClose}
              className="w-8 h-8 rounded-full bg-[#eef1f3] hover:bg-[#dfe3e6]">
              <Icon name="close" size={16} className="text-[#595c5e]" />
            </Button>
          </div>
        </div>

        {/* Settings panel (collapsible) */}
        {settingsOpen && settings && (
          <div className="px-6 py-4 border-b border-[rgba(171,173,175,0.12)] bg-[#f5f7f9] space-y-3">
            <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Survey Configuration</p>
            {settings.description && (
              <div>
                <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/70 mb-1">Description</p>
                <p className="text-sm text-foreground">{settings.description}</p>
              </div>
            )}
            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/70 mb-1">Thank You Message</p>
              {settings.thankYouMessage
                ? <p className="text-sm text-foreground bg-white rounded-xl px-3 py-2 border border-[#dfe3e6]">{settings.thankYouMessage}</p>
                : <p className="text-xs italic text-[#abadaf]">Not configured — close preview and open Settings to add one.</p>
              }
            </div>
            {settings.intent && (
              <div>
                <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/70 mb-1">Survey Goal</p>
                <p className="text-sm text-muted-foreground">{settings.intent}</p>
              </div>
            )}
          </div>
        )}

        {/* Progress bar */}
        <div className="h-1 w-full bg-[#eef1f3]">
          <div className="h-full transition-all bg-gradient-to-r from-[var(--color-primary)] to-[var(--color-tertiary)]"
            style={{ width: done ? '100%' : `${progress}%` }} />
        </div>

        {/* Main content */}
        <div className="px-8 py-8 max-h-[65vh] overflow-y-auto">
          {done ? (
            <div className="text-center py-6">
              <div className="w-20 h-20 rounded-2xl flex items-center justify-center mx-auto mb-6"
                style={{ background: 'linear-gradient(135deg, #059669, #10b981)', boxShadow: '0 12px 32px rgba(5,150,105,0.3)' }}>
                <Icon name="check_circle" fill={1} size={40} style={{ color: '#fff' }} />
              </div>
              <h2 className="text-2xl font-extrabold font-headline text-foreground">
                {t('fill.thankYou.heading')}
              </h2>
              <p className="mt-3 text-base leading-relaxed text-muted-foreground max-w-xs mx-auto">
                {thankYouMessage || t('fill.thankYou.message')}
              </p>
              {!thankYouMessage && (
                <p className="mt-3 text-xs px-3 py-2 rounded-xl text-[#d97706] bg-[rgba(217,119,6,0.06)] border border-[rgba(217,119,6,0.15)] inline-flex items-center gap-1.5">
                  <Icon name="info" size={13} />
                  No custom message set — open Settings to configure one
                </p>
              )}
              <Button onClick={onClose}
                className="mt-6 px-6 py-3 rounded-xl h-auto font-bold text-white"
                style={{ background: 'linear-gradient(135deg, #059669, #047857)' }}>
                Close Preview
              </Button>
            </div>
          ) : q ? (
            <>
              {(() => {
                const isStatement = (q as Question).type === 'statement';
                return (
                  <>
                    {!isStatement && (
                      <div className="mb-4 flex items-center justify-between">
                        <span className="text-xs font-bold text-muted-foreground/50">
                          {current + 1} / {questions.filter((x) => x.type !== 'statement').length}
                        </span>
                        {q.required && (
                          <span className="text-[10px] font-black uppercase tracking-wider text-[#b41340]">Required</span>
                        )}
                      </div>
                    )}
                    {isStatement ? (
                      <h2 className="text-2xl font-extrabold font-headline mb-6 text-foreground">{q.question}</h2>
                    ) : (
                      <h2 className="text-xl font-extrabold font-headline text-foreground leading-snug">
                        {q.question || <span className="text-muted-foreground/40 italic">No question text entered</span>}
                      </h2>
                    )}
                    {!isStatement && <QuestionInput q={q} />}
                    <div className="flex gap-3 mt-8">
                      <Button onClick={() => setCurrent(Math.max(0, current - 1))}
                        disabled={current === 0}
                        className="px-5 rounded-xl h-auto py-3 bg-[#eef1f3] text-[#595c5e] hover:bg-[#dfe3e6] font-bold disabled:opacity-30">
                        ← Back
                      </Button>
                      <Button onClick={advance}
                        disabled={!isStatement && !canContinue}
                        className="flex-1 px-6 rounded-xl h-auto py-3 font-bold text-white transition-all"
                        style={{
                          background: canContinue || isStatement
                            ? 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))'
                            : '#eef1f3',
                          color: canContinue || isStatement ? 'white' : '#abadaf',
                        }}>
                        {current === questions.length - 1 ? 'Submit →' : 'Continue →'}
                      </Button>
                    </div>
                  </>
                );
              })()}

            </>
          ) : null}
        </div>

        {/* Footer hint */}
        <div className="px-6 py-3 border-t border-[rgba(171,173,175,0.08)] flex items-center justify-between bg-[#fafbfc]">
          <span className="text-[10px] text-muted-foreground/60">Preview mode — responses are not saved</span>
          {thankYouMessage && (
            <span className="text-[10px] font-bold text-[var(--color-success)] flex items-center gap-1">
              <Icon name="check_circle" size={11} />Thank you message configured
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// LOGIC VIEW
// ─────────────────────────────────────────────────────────────────────────────

interface LogicViewProps {
  questions: Question[];
}

function LogicView({ questions }: LogicViewProps) {
  const qIndex = (id: string) => questions.findIndex((x) => x.id === id);
  return (
    <div className="max-w-2xl mx-auto py-8 px-4">
      <h2 className="text-2xl font-extrabold font-headline mb-8 text-foreground">Survey Flow</h2>
      <div className="space-y-2">
        {questions.map((q: Question, i: number) => {
          const meta = (QTYPE_META[q.type as keyof typeof QTYPE_META] || QTYPE_META.open_text) as QtypeMeta;
          const qAny = q as unknown as Record<string, unknown>;
          const skipLogic = (qAny.skipLogic as SkipRule[]) || [];
          const hasLogic = skipLogic.length > 0 || !!qAny.displayLogic;
          const displayLogic = qAny.displayLogic as DisplayLogic | null;
          return (
            <div key={q.id} className="rounded-2xl overflow-hidden border border-[rgba(171,173,175,0.15)]">
              <div className="flex items-center gap-3 px-5 py-3.5 bg-white">
                <span className="text-xs font-black px-2 py-0.5 rounded-full" style={{ background: meta.bg, color: meta.color }}>Q{i + 1}</span>
                <span className="text-xs font-semibold flex-1 truncate text-foreground">{q.question || '(untitled)'}</span>
                <span className="text-[10px] font-bold text-muted-foreground">{meta.label}</span>
              </div>
              {hasLogic && (
                <div className="px-5 py-3 space-y-1.5 bg-[#f5f7f9] border-t border-[rgba(171,173,175,0.1)]">
                  {displayLogic && (
                    <div className="flex items-center gap-2 text-xs text-[var(--color-success)]">
                      <Icon name="visibility" size={12} />
                      <span>Show only if Q{qIndex(displayLogic.sourceQuestionId) + 1} {displayLogic.operator} {displayLogic.value}</span>
                    </div>
                  )}
                  {skipLogic.map((rule: SkipRule, ri: number) => (
                    <div key={ri} className="flex items-center gap-2 text-xs text-[var(--color-primary)]">
                      <Icon name="schema" size={12} />
                      <span>
                        If answer {rule.condition.operator} {rule.condition.operator !== 'answered' ? `"${rule.condition.value}"` : ''} →{' '}
                        {rule.destination === 'END_SURVEY' ? 'End survey' : `Jump to Q${qIndex(rule.destination) + 1}`}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {i < questions.length - 1 && !hasLogic && (
                <div className="flex items-center px-5 py-1 bg-[#f5f7f9] border-t border-[rgba(171,173,175,0.08)]">
                  <Icon name="arrow_downward" size={12} style={{ color: '#dfe3e6' }} />
                  <span className="text-[10px] ml-1 text-[#dfe3e6]">continue</span>
                </div>
              )}
            </div>
          );
        })}
        <div className="flex items-center gap-2 px-5 py-3 rounded-2xl bg-white border border-[rgba(171,173,175,0.15)]">
          <Icon name="flag" fill={1} size={14} className="text-[var(--color-success)]" />
          <span className="text-xs font-bold text-[var(--color-success)]">End of survey</span>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SURVEY SETTINGS PANEL
// ─────────────────────────────────────────────────────────────────────────────

interface SurveySettingsPanelProps {
  surveyId: string;
  initialTags: SurveyTag[];
  onTagsChange: (tags: SurveyTag[]) => void;
  settings: SurveySettings;
  onChange: (settings: SurveySettings) => void;
  onClose: () => void;
  fromTemplate: Template | null;
}

function SurveySettingsPanel({ surveyId, initialTags, onTagsChange, settings, onChange, onClose, fromTemplate }: SurveySettingsPanelProps) {
  const { t } = useTranslation();
  const api = useApi();
  const u = (patch: Partial<SurveySettings>) => onChange({ ...settings, ...patch });

  const [tags, setTags] = useState<SurveyTag[]>(initialTags);

  // Re-sync when panel reopens (initialTags may have been updated by parent)
  useEffect(() => { setTags(initialTags); }, [initialTags]);

  async function handleAddTag(tag: SurveyTag) {
    const updated = [...tags, tag];
    setTags(updated);
    onTagsChange(updated);
    try {
      await api.addTagsToSurvey(surveyId, [tag.id]);
    } catch {
      setTags(tags);
      onTagsChange(tags);
    }
  }

  async function handleRemoveTag(tagId: string) {
    const updated = tags.filter(t => t.id !== tagId);
    setTags(updated);
    onTagsChange(updated);
    try {
      await api.removeTagFromSurvey(surveyId, tagId);
    } catch {
      setTags(tags);
      onTagsChange(tags);
    }
  }

  return (
    <div className="h-full flex flex-col overflow-y-auto bg-[#fafbfc]">
      <div className="flex items-center justify-between px-5 py-4 sticky top-0 z-10 bg-[#fafbfc] border-b border-[rgba(171,173,175,0.1)]">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg flex items-center justify-center bg-[color-mix(in_srgb,var(--color-primary)_8%,transparent)]">
            <Icon name="settings" size={15} style={{ color: 'var(--color-primary)' }} />
          </div>
          <span className="text-sm font-extrabold font-headline text-foreground">{t('builder.settings.heading')}</span>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} className="h-7 w-7 rounded-lg hover:bg-[#eef1f3]">
          <Icon name="close" size={18} className="text-muted-foreground" />
        </Button>
      </div>

      <div className="flex-1 px-5 py-4 space-y-5 overflow-y-auto">

        {/* Template info — read-only, sourced from template record */}
        {fromTemplate && (
          <div className="rounded-xl p-3.5 space-y-2.5"
            style={{ background: 'color-mix(in srgb, var(--color-tertiary) 5%, transparent)', border: '1px solid color-mix(in srgb, var(--color-tertiary) 12%, transparent)' }}>
            <p className="text-[10px] font-black uppercase tracking-widest" style={{ color: 'var(--color-tertiary)' }}>
              {t('builder.settings.templateLabel')}
            </p>
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0"
                style={{ background: fromTemplate.bg || '#f3e8ff', color: fromTemplate.color || 'var(--color-tertiary)' }}>
                <Icon name={fromTemplate.icon || 'library_books'} size={13} />
              </div>
              <span className="text-sm font-bold text-foreground">{fromTemplate.label}</span>
            </div>
            {fromTemplate.category && (
              <span className="inline-block text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full"
                style={{ background: 'color-mix(in srgb, var(--color-tertiary) 10%, transparent)', color: 'var(--color-tertiary)' }}>
                {fromTemplate.category}
              </span>
            )}
            {fromTemplate.tags && fromTemplate.tags.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {fromTemplate.tags.slice(0, 6).map((tag: string) => (
                  <span key={tag} className="text-[10px] px-2 py-0.5 rounded-full font-medium"
                    style={{ background: 'color-mix(in srgb, var(--color-tertiary) 8%, transparent)', color: 'var(--color-tertiary)' }}>
                    {tag}
                  </span>
                ))}
              </div>
            )}
            {fromTemplate.estimatedMinutes !== undefined && fromTemplate.estimatedMinutes > 0 && (
              <p className="text-[10px] text-muted-foreground flex items-center gap-1 mt-1">
                <Icon name="schedule" size={11} />
                ~{fromTemplate.estimatedMinutes} min to complete
              </p>
            )}
          </div>
        )}

        {/* Tags — immediate save to API, no pending state needed */}
        <div>
          <Label className="text-[10px] font-black uppercase tracking-widest block mb-1.5 text-muted-foreground">
            {t('builder.settings.tagsLabel')}
          </Label>
          <TagSelector
            selectedTags={tags}
            onAdd={handleAddTag}
            onRemove={handleRemoveTag}
          />
          <p className="text-[10px] text-muted-foreground/60 mt-1.5 flex items-center gap-1">
            <Icon name="info" size={10} />{t('groups.tagHint')}
          </p>
        </div>

        <Separator />

        <div>
          <Label className="text-[10px] font-black uppercase tracking-widest block mb-1.5 text-muted-foreground">
            {t('builder.settings.descriptionLabel')}
          </Label>
          <Textarea
            value={settings.description || ''}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => u({ description: e.target.value })}
            rows={3}
            placeholder={t('builder.settings.descriptionPlaceholder')}
            className="w-full resize-none text-sm px-3 py-2.5 rounded-[10px] bg-white border-[#dfe3e6] text-foreground focus-visible:ring-1"
          />
        </div>

        <div>
          <Label className="text-[10px] font-black uppercase tracking-widest block mb-1.5 text-muted-foreground">
            {t('builder.settings.intentLabel')}
          </Label>
          <Textarea
            value={settings.intent || ''}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => u({ intent: e.target.value })}
            rows={3}
            placeholder={t('builder.settings.intentPlaceholder')}
            className="w-full resize-none text-sm px-3 py-2.5 rounded-[10px] bg-white border-[#dfe3e6] text-foreground focus-visible:ring-1"
          />
        </div>

        <Separator />

        <div>
          <Label className="text-[10px] font-black uppercase tracking-widest block mb-1.5 text-muted-foreground">
            {t('builder.settings.thankYouMessageLabel')}
          </Label>
          <Textarea
            value={settings.thankYouMessage || ''}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => u({ thankYouMessage: e.target.value })}
            rows={3}
            placeholder={t('builder.settings.thankYouMessagePlaceholder')}
            className="w-full resize-none text-sm px-3 py-2.5 rounded-[10px] bg-white border-[#dfe3e6] text-foreground focus-visible:ring-1"
          />
          {/* Live preview */}
          {settings.thankYouMessage && (
            <div className="mt-2 rounded-xl px-3 py-2.5 border border-[rgba(5,150,105,0.15)]"
              style={{ background: 'rgba(5,150,105,0.04)' }}>
              <p className="text-[10px] font-bold uppercase tracking-widest text-[var(--color-success)] mb-1 flex items-center gap-1">
                <Icon name="visibility" size={10} />Preview
              </p>
              <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">{settings.thankYouMessage}</p>
            </div>
          )}
          {!settings.thankYouMessage && (
            <p className="text-[10px] text-muted-foreground/60 mt-1.5 flex items-center gap-1">
              <Icon name="info" size={10} />Shown to respondents after they submit. Supports line breaks.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN PAGE
// ─────────────────────────────────────────────────────────────────────────────
export function SurveyBuilderPage() {
  const { surveyId: surveyIdParam } = useParams<{ surveyId: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const { t } = useTranslation();

  const pending = (location.state as Record<string, unknown>) || null;
  const api = useApi();

  // Phase A (survey-builder convergence) — the builder used to mount its own
  // independent chat (XperiqCopilot, ExperientCopilot.tsx); it now routes
  // through the same global Crystal panel every other page uses. See
  // contexts/crystalPanel.tsx for the builderChatHandler/builderQuestionsHydrator/
  // builderRecommendation* fields this page registers below.
  const {
    openCrystal,
    setScope: setCrystalScope,
    setCrystalData,
    setBuilderContext,
    setBuilderChatHandler,
    setBuilderQuestionsHydrator,
    setBuilderRecommendations,
    setBuilderRecommendationHandler,
  } = useCrystalPanel();

  // Edit mode: surveyIdParam is a real DB id (not 'new')
  const isEditMode = !!surveyIdParam && surveyIdParam !== 'new';
  const hasStateQuestions = isEditMode
    ? ((pending?.questions as unknown[])?.length > 0)
    : Array.isArray(pending?.questions);
  const needsDbLoad = isEditMode && !hasStateQuestions;

  const [isLoading,    setIsLoading]    = useState(needsDbLoad);
  const [questions, setQuestions] = useState<Question[]>(() => {
    if ((pending?.questions as Question[])?.length) return (pending.questions as Question[]).map(mapAiToBuilderQuestion);
    return [createQuestion('nps') as Question, createQuestion('open_text') as Question];
  });
  const [surveyTitle,  setSurveyTitle]  = useState((pending?.title as string)?.slice(0, 80) || '');
  const [surveyTypeId, setSurveyTypeId] = useState<string | null>((pending?.surveyTypeId as string) || null);
  const [surveyId,     setSurveyId]     = useState<string | null>(
    surveyIdParam && surveyIdParam !== 'new' ? surveyIdParam : ((pending?.id as string) || null)
  );
  // Agent run ID — set when survey was created via agents pipeline; enables copilotRefine
  const [copilotRunId, setCopilotRunId] = useState<string | null>((pending?.runId as string) || null);
  // Recommendations from the agents pipeline — shown in Crystal on first open
  const [copilotRecs] = useState<import('../lib/api').Recommendation[]>(
    (pending?.recommendations as import('../lib/api').Recommendation[]) || []
  );
  // Auto-open Crystal after AI generation completes
  const autoOpenCrystal = !!(pending?.openCrystal);

  const fromTemplate = (pending?.fromTemplate as Template) || null;

  const [surveyTags, setSurveyTags] = useState<SurveyTag[]>((pending?.tags as SurveyTag[]) || []);

  // Only survey-run-specific fields — template data (tags, estimated_minutes, etc.) is
  // derived from the template record via template_id, never duplicated on the survey.
  const [surveySettings, setSurveySettings] = useState<SurveySettings>({
    description:      (pending?.description as string) || '',
    intent:           (pending?.intent as string) || '',
    thankYouMessage:  (pending?.thankYouMessage as string) || '',
    templateId:       (pending?.templateId as string) || (fromTemplate?.id) || null,
  });

  // Load full survey from DB when opening by URL without state data
  useEffect(() => {
    if (!needsDbLoad) return;
    api.getSurvey(surveyIdParam as string)
      .then((rawData: unknown) => {
        const data = rawData as Record<string, unknown>;
        const s = (data?.survey as Record<string, unknown>) || data;
        if (s) {
          setSurveyTitle((s.title as string) || '');
          setSurveyTypeId((s.survey_type_id as string) || null);
          setSurveySettings({
            description:     (s.description as string) || '',
            intent:          (s.intent as string) || '',
            thankYouMessage: (s.thank_you_message as string) || '',
            templateId:      (s.template_id as string) || null,
          });
          setSurveyTags((s.tags as SurveyTag[]) || []);
          if ((s.questions as Question[])?.length) {
            setQuestions((s.questions as Question[]).map(mapAiToBuilderQuestion));
          }
        }
      })
      .catch(() => {})
      .finally(() => setIsLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const [selectedId,  setSelectedId]  = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mode,        setMode]        = useState<'build' | 'preview' | 'logic'>('build');
  const [saving,           setSaving]           = useState(false);
  const [saved,            setSaved]            = useState(false);
  const [saveError,        setSaveError]        = useState<string | null>(null);
  const [launching,        setLaunching]        = useState(false);
  const [showPublishModal, setShowPublishModal] = useState(false);
  const [publishSuccessUrl, setPublishSuccessUrl] = useState<string | null>(null);
  const [autoSaving,       setAutoSaving]       = useState(false);
  const [autoSavedAt,      setAutoSavedAt]      = useState<Date | null>(null);
  const autosaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Tracks whether user has made any changes since data was loaded — prevents autosave from
  // firing immediately after page load when state is populated from the API.
  const isDirtyRef = useRef(false);
  const { createSurvey, updateSurvey, publishSurvey } = useSurveys();

  // Drag state via refs (no re-renders mid-drag)
  const dragIndexRef = useRef<number | null>(null);
  const [dragOver,    setDragOver]    = useState<number | null>(null);

  const selectedQ = questions.find((q) => q.id === selectedId) || null;
  const panelOpen = (!!selectedId || settingsOpen) && mode === 'build';

  // ── Handlers ──────────────────────────────────────────────────────────────
  const addQuestion  = useCallback((type: string) => {
    isDirtyRef.current = true;
    const q = createQuestion(type) as Question;
    setQuestions((prev) => [...prev, q]);
    setSelectedId(q.id);
    // Scroll to end
    setTimeout(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }), 50);
  }, []);

  const updateQuestion = useCallback((id: string, patch: Partial<Question>) => {
    isDirtyRef.current = true;
    setQuestions((prev) => prev.map((q) => (q.id === id ? { ...q, ...patch } as unknown as Question : q)));
  }, []);

  const deleteQuestion = useCallback((id: string) => {
    isDirtyRef.current = true;
    setQuestions((prev) => {
      const filtered = prev.filter((q) => q.id !== id);
      return filtered.map((q) => {
        const qAny = q as unknown as Record<string, unknown>;
        const skipLogic = (qAny.skipLogic as SkipRule[]) || [];
        return {
          ...q,
          skipLogic: skipLogic.filter((rule: SkipRule) => rule.destination !== id),
        } as unknown as Question;
      });
    });
    setSelectedId((s) => (s === id ? null : s));
  }, []);

  const duplicateQuestion = useCallback((id: string) => {
    isDirtyRef.current = true;
    const src = questions.find((q) => q.id === id);
    if (!src) return;
    const copy = { ...src, id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, question: src.question + ' (copy)' } as Question;
    setQuestions((prev) => {
      const idx = prev.findIndex((q) => q.id === id);
      const next = [...prev];
      next.splice(idx + 1, 0, copy);
      return next;
    });
    setSelectedId(copy.id);
  }, [questions]);

  const reorder = useCallback((fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex) return;
    isDirtyRef.current = true;
    setQuestions((prev) => {
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      // Remove skip logic rules that are now backward (destination is before source)
      return next.map((q, idx) => {
        const qAny = q as unknown as Record<string, unknown>;
        const skipLogic = qAny.skipLogic as SkipRule[] | undefined;
        if (!skipLogic?.length) return q;
        const forwardIds = new Set(next.slice(idx + 1).map(fq => fq.id));
        forwardIds.add('END_SURVEY');
        const validRules = skipLogic.filter(r => forwardIds.has(r.destination));
        if (validRules.length === skipLogic.length) return q;
        return { ...q, skipLogic: validRules } as Question;
      });
    });
  }, []);

  const handleAiCommand = useCallback(async (
    message: string,
    conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [],
  ) => {
    let result: Record<string, unknown>;
    if (copilotRunId) {
      // Use agent pipeline when a run is available — returns changes/suggestions/compliance_risk
      result = await api.copilotRefine(copilotRunId, {
        message,
        questions,
        surveyTypeId: surveyTypeId ?? undefined,
        intent: surveySettings.intent || surveyTitle,
        conversationHistory,
      }) as unknown as Record<string, unknown>;
    } else {
      // Legacy fallback for surveys created without the agents pipeline
      result = await api.refineSurvey(questions, message, {
        surveyTypeId,
        intent: surveySettings.intent || surveyTitle,
        description: surveySettings.description,
        templateId: surveySettings.templateId,
      }) as unknown as Record<string, unknown>;
    }
    if (result.questions && result.response_type !== 'answer') {
      isDirtyRef.current = true;
      setQuestions((result.questions as Question[]).map(mapAiToBuilderQuestion) as Question[]);
    }
    return result;
  }, [api, copilotRunId, questions, surveyTypeId, surveyTitle, surveySettings]);

  const handleApplyRecommendation = useCallback(async (action: string) => {
    if (!copilotRunId) return;
    const result = await api.applyRecommendation(copilotRunId, action, {
      orgContext:    undefined,
      surveyTypeId:  surveyTypeId ?? undefined,
      intent:        surveySettings.intent || surveyTitle,
    });
    if (result.questions?.length) {
      isDirtyRef.current = true;
      setQuestions(result.questions.map(mapAiToBuilderQuestion) as Question[]);
    }
    // Return message + compliance_risk so the recommendation's ActionProposalCard
    // (rendered by the global Crystal panel — see contexts/crystalPanel.tsx's
    // builderRecommendationHandler) can show the real, non-hardcoded result.
    return {
      recommendations:  result.recommendations,
      message:          result.message || undefined,
      compliance_risk:  result.compliance_risk || undefined,
    };
  }, [api, copilotRunId, surveyTypeId, surveySettings, surveyTitle]);

  // Applies a Copilot-refined question list to local state in place — the
  // counterpart CrystalPanel's executeAction calls (via builderQuestionsHydrator)
  // when an edit_survey/edit_survey_questions proposal is applied while this
  // exact builder page is open, instead of navigating to the same route.
  const applyBuilderQuestions = useCallback((qs: unknown[]) => {
    if (!Array.isArray(qs) || !qs.length) return;
    isDirtyRef.current = true;
    setQuestions((qs as Question[]).map(mapAiToBuilderQuestion) as Question[]);
  }, []);

  // ── Crystal chassis wiring (Phase A) ────────────────────────────────────────
  // Scope Crystal to this survey and register the builder-specific handlers,
  // mirroring the exact pattern WorkflowBuilderPage/WorkflowCanvasPage already
  // use for builderContext/builderDraftHydrator (AppShell.tsx's
  // `hasOwnCrystalFab`). Cleanup on unmount resets every field so leaving the
  // builder never leaves a stale handler wired into the global panel.
  useEffect(() => {
    setCrystalScope(surveyId ?? 'all');
    setBuilderContext({ kind: 'survey_builder' });
    return () => {
      setCrystalScope('all');
      setBuilderContext(null);
      setCrystalData([], []);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surveyId]);

  useEffect(() => {
    setBuilderChatHandler(handleAiCommand);
    return () => setBuilderChatHandler(null);
  }, [handleAiCommand, setBuilderChatHandler]);

  useEffect(() => {
    setBuilderQuestionsHydrator(applyBuilderQuestions);
    return () => setBuilderQuestionsHydrator(null);
  }, [applyBuilderQuestions, setBuilderQuestionsHydrator]);

  useEffect(() => {
    setBuilderRecommendationHandler(copilotRunId ? handleApplyRecommendation : null);
    return () => setBuilderRecommendationHandler(null);
  }, [copilotRunId, handleApplyRecommendation, setBuilderRecommendationHandler]);

  // Recommendations from the agents pipeline are seeded once — `copilotRecs`
  // is referentially stable for the page's lifetime (set via a bare useState
  // initializer, never updated), matching the ref-guard in CrystalPanel.tsx's
  // seeding effect.
  useEffect(() => {
    setBuilderRecommendations(copilotRecs.length > 0 ? copilotRecs : null);
    return () => setBuilderRecommendations(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-open Crystal after AI generation completes — matches the old
  // XperiqCopilot's autoOpenCrystal/initialMessage behavior, minus the
  // bespoke greeting text (Crystal's own default welcome view covers it now).
  useEffect(() => {
    if (autoOpenCrystal) openCrystal();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOpenCrystal]);

  const buildPayload = () => ({
    title: surveyTitle,
    questions: questions.map(({ id, type, question, required, ...rest }) => {
      const restAny = rest as Record<string, unknown>;
      return {
        id,
        type,
        question:     question || '',
        required:     !!required,
        skipLogic:    (restAny.skipLogic as SkipRule[]) || [],
        displayLogic: (restAny.displayLogic as DisplayLogic | null) || null,
        ...rest,
      };
    }),
    survey_type_id:    surveyTypeId,
    description:       surveySettings.description || null,
    intent:            surveySettings.intent || null,
    thank_you_message: surveySettings.thankYouMessage || null,
    template_id:       surveySettings.templateId || null,
    metadata:          (pending?.metadata as Record<string, unknown>) || undefined,
  });

  const doSave = async () => {
    const payload = buildPayload();
    if (surveyId) {
      await updateSurvey(surveyId, {
        title:             payload.title,
        questions:         payload.questions as unknown as Question[],
        survey_type_id:    payload.survey_type_id,
        description:       payload.description,
        intent:            payload.intent,
        thank_you_message: payload.thank_you_message,
        template_id:       payload.template_id,
      });
      return { id: surveyId };
    }
    const result = await createSurvey(payload as unknown as Partial<import('../types').Survey>) as { id?: string } | null;
    if (result?.id) setSurveyId(result.id);
    return result;
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await doSave();
      isDirtyRef.current = false;
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed. Try again.');
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    if (!surveyId || !isDirtyRef.current) return;
    if (autosaveRef.current) clearTimeout(autosaveRef.current);
    autosaveRef.current = setTimeout(async () => {
      setAutoSaving(true);
      try {
        await doSave();
        isDirtyRef.current = false;
        setAutoSavedAt(new Date());
      } catch (err) {
        console.error('[autosave] failed:', err);
      } finally {
        setAutoSaving(false);
      }
    }, 30_000);
    return () => {
      if (autosaveRef.current) clearTimeout(autosaveRef.current);
    };
  }, [questions, surveyTitle, surveySettings]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleLaunch = async (launchSettings: import('../components/SurveyActionModal').LaunchSettings) => {
    setLaunching(true);
    setSaveError(null);
    try {
      const survey = await doSave() as { id?: string } | null;
      isDirtyRef.current = false;
      const id = survey?.id || surveyId;
      if (id) {
        const result = await publishSurvey(id, {
          maxResponses: launchSettings.maxResponses ? parseInt(launchSettings.maxResponses, 10) : null,
          autoCloseAt:  launchSettings.autoCloseAt ? new Date(launchSettings.autoCloseAt).toISOString() : null,
          allowMultipleResponses: launchSettings.allowMultiple,
          passwordProtected: launchSettings.passwordProtected,
          password: launchSettings.password || undefined,
        }) as { publishToken?: string } | null;
        const token = result?.publishToken;
        if (token) {
          setShowPublishModal(false);
          setPublishSuccessUrl(`${window.location.origin}/s/${token}`);
        }
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Publish failed. Try again.');
    } finally {
      setLaunching(false);
    }
  };

  // ── Layout constants ──────────────────────────────────────────────────────
  const PALETTE_W  = 224; // 14rem
  const PROPS_W    = 320; // 20rem

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center gap-4 flex-col min-h-[60vh]">
        <Spinner size={36} />
        <p className="text-sm font-semibold text-on-surface-variant">Loading survey…</p>
      </div>
    );
  }

  return (
    <>
      <OverlayLoader visible={launching} message="Publishing survey…" />

      {/* Preview overlay */}
      {mode === 'preview' && (
        <PreviewMode
          questions={questions}
          title={surveyTitle}
          thankYouMessage={surveySettings.thankYouMessage}
          settings={surveySettings}
          onClose={() => setMode('build')}
        />
      )}

      {/* Publish confirmation */}
      <PublishModal
        open={showPublishModal}
        onClose={() => setShowPublishModal(false)}
        onConfirm={handleLaunch}
        busy={launching}
        surveyTitle={surveyTitle}
      />

      {/* Publish success */}
      <PublishSuccessModal
        open={!!publishSuccessUrl}
        onClose={() => setPublishSuccessUrl(null)}
        shareUrl={publishSuccessUrl || ''}
        onViewSurvey={() => { if (publishSuccessUrl) window.open(publishSuccessUrl, '_blank'); }}
        onGoToList={() => navigate(ROUTES.SURVEYS)}
      />

      {/* ── Question Type Palette ── */}
      <aside
        className="fixed z-30 overflow-hidden bg-white hidden md:block"
        style={{
          left:    'var(--sidebar-width)',
          top:     '4rem',
          width:   PALETTE_W,
          height:  'calc(100vh - 4rem)',
          borderRight: '1px solid rgba(171,173,175,0.12)',
        }}
      >
        <QuestionPalette onAdd={addQuestion} />
      </aside>

      {/* ── Canvas ── */}
      <div
        className="builder-canvas"
        style={{
          marginRight:  panelOpen ? PROPS_W : 0,
          paddingBottom: 120,
          transition:   'margin-right 0.3s cubic-bezier(0.4,0,0.2,1)',
          minHeight:    'calc(100vh - 4rem)',
        }}
      >
        {/* PageHeader: breadcrumb + editable title + action buttons */}
        <div className="max-w-3xl mx-auto px-6">
          <PageHeader
            crumbs={[
              { label: t('nav.surveys'), path: ROUTES.SURVEYS },
              { label: surveyTitle || t('builder.untitled') },
            ]}
            title={
              <input
                value={surveyTitle}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => { isDirtyRef.current = true; setSurveyTitle(e.target.value); }}
                placeholder={t('builder.untitled')}
                className="text-2xl md:text-[1.75rem] font-extrabold tracking-tight font-headline text-on-surface leading-tight bg-transparent border-none outline-none w-full block px-0 focus:ring-0 placeholder:text-muted-foreground/40"
                style={{ boxShadow: 'none' }}
              />
            }
            actions={
              <div className="flex flex-col items-end gap-1">
                <div className="flex items-center gap-2">
                  {surveyId && !autoSaving && autoSavedAt && !saveError && (
                    <span className="text-xs text-muted-foreground hidden sm:block">
                      {`${t('builder.autosaved')} ${autoSavedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}
                    </span>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => { setSettingsOpen((v) => !v); setSelectedId(null); }}
                    className={cn(
                      'rounded-full gap-1.5',
                      settingsOpen
                        ? 'bg-[color-mix(in_srgb,var(--color-primary)_8%,transparent)] text-[var(--color-primary)] border-[color-mix(in_srgb,var(--color-primary)_20%,transparent)] hover:bg-[color-mix(in_srgb,var(--color-primary)_12%,transparent)]'
                        : 'bg-[#f5f7f9] text-[#595c5e] border-[#dfe3e6] hover:bg-[#eef1f3]'
                    )}
                  >
                    <Icon name="settings" size={15} />{t('builder.settings.settingsButton')}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleSave}
                    disabled={saving || autoSaving || launching}
                    className={cn(
                      'rounded-full flex items-center gap-1.5 active:scale-95',
                      saveError
                        ? 'bg-[var(--color-error,#ef4444)] text-white border-[var(--color-error,#ef4444)] hover:opacity-90'
                        : saved
                          ? 'bg-[var(--color-success)] text-white border-[var(--color-success)] hover:opacity-90'
                          : 'bg-[#eef1f3] text-[#595c5e] border-[#dfe3e6] hover:bg-[#dfe3e6]'
                    )}
                  >
                    {(saving || autoSaving)
                      ? <><Spinner size={14} color="#595c5e" />{autoSaving ? t('builder.autosaving') : t('common.saving')}</>
                      : saveError
                        ? <><Icon name="error" size={15} />Save failed</>
                        : <><Icon name={saved ? 'check' : 'save'} size={15} />{saved ? t('common.saved') : t('common.save')}</>
                    }
                  </Button>
                  <Button
                    variant="success"
                    size="sm"
                    onClick={() => setShowPublishModal(true)}
                    disabled={saving || launching}
                    className="rounded-full gap-1.5 shadow-[0_8px_20px_-4px_rgba(5,150,105,0.3)]"
                  >
                    <Icon name="rocket_launch" size={15} />Launch
                  </Button>
                </div>
                {saveError && (
                  <span className="text-xs text-red-500 pr-1">{saveError}</span>
                )}
              </div>
            }
          />
        </div>

        {/* Mode tab bar */}
        <div className="flex items-center gap-1 max-w-3xl mx-auto px-6 mb-6">
          {([['build', 'edit', 'Build'], ['logic', 'schema', 'Logic'], ['preview', 'play_arrow', 'Preview']] as [string, string, string][]).map(([m, icon, label]) => (
            <button
              key={m}
              onClick={() => setMode(m as 'build' | 'preview' | 'logic')}
              className={cn(
                'flex items-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-full transition-all',
                mode === m
                  ? 'bg-[#eff2ff] text-[#4338ca]'
                  : 'text-[#9ca3af] hover:text-[#374151] hover:bg-[#f3f4f6]'
              )}
            >
              <Icon name={icon} size={14} />{label}
            </button>
          ))}
        </div>

        {mode === 'logic' ? (
          <LogicView questions={questions} />
        ) : mode === 'preview' ? null : (
          <div className="max-w-3xl mx-auto px-6 space-y-4">
            {/* Template intelligence banner */}
            {fromTemplate?.intelligence && (
              <div className="rounded-2xl p-4 flex items-start gap-3"
                style={{ background: 'color-mix(in srgb, var(--color-tertiary) 5%, transparent)', border: '1px solid color-mix(in srgb, var(--color-tertiary) 12%, transparent)' }}>
                <Icon name="auto_awesome" size={16} style={{ color: 'var(--color-tertiary)', marginTop: 2 }} />
                <div>
                  <p className="text-xs font-bold mb-0.5" style={{ color: 'var(--color-tertiary)' }}>
                    AI Intelligence Active — {fromTemplate.label}
                  </p>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    {(fromTemplate.intelligence as Record<string, unknown>)['scoringNarrative'] as string || 'Template intelligence is guiding AI suggestions for this survey.'}
                  </p>
                </div>
              </div>
            )}

            {/* Question count badge */}
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold px-3 py-1 rounded-full bg-[#e0e7ff] text-[var(--color-primary)]">
                  {questions.length} question{questions.length !== 1 ? 's' : ''}
                </span>
                {questions.some((q) => {
                  const qAny = q as unknown as Record<string, unknown>;
                  return Array.isArray(qAny.skipLogic) && (qAny.skipLogic as unknown[]).length > 0;
                }) && (
                  <span className="text-xs font-bold px-3 py-1 rounded-full flex items-center gap-1 bg-[color-mix(in_srgb,var(--color-primary)_8%,transparent)] text-[var(--color-primary)]">
                    <Icon name="schema" size={11} />Skip logic active
                  </span>
                )}
              </div>
              {selectedId && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setSelectedId(null)}
                  className="text-xs font-bold px-3 rounded-full bg-[#eef1f3] text-[#595c5e] hover:bg-[#dfe3e6]"
                >
                  Deselect
                </Button>
              )}
            </div>

            {/* Question cards */}
            {questions.map((q: Question, i: number) => (
              <QuestionCard
                key={q.id}
                q={q}
                index={i}
                total={questions.length}
                selected={selectedId === q.id}
                onSelect={setSelectedId}
                onUpdate={updateQuestion}
                onDelete={deleteQuestion}
                onDuplicate={duplicateQuestion}
                isDragging={dragIndexRef.current === i}
                isDragOver={dragOver === i}
                onDragStart={() => { dragIndexRef.current = i; }}
                onDragOver={() => setDragOver(i)}
                onDrop={() => {
                  if (dragIndexRef.current !== null) reorder(dragIndexRef.current, i);
                  dragIndexRef.current = null;
                  setDragOver(null);
                }}
              />
            ))}

            {/* Add question button */}
            <Button
              variant="ghost"
              onClick={() => addQuestion('open_text')}
              onDragOver={(e: React.DragEvent<HTMLButtonElement>) => { e.preventDefault(); setDragOver(questions.length); }}
              onDrop={() => {
                if (dragIndexRef.current !== null) reorder(dragIndexRef.current, questions.length - 1);
                dragIndexRef.current = null;
                setDragOver(null);
              }}
              className={cn(
                'w-full h-auto py-5 rounded-2xl border-2 border-dashed flex items-center justify-center gap-3 transition-all group',
                'border-[#dfe3e6] hover:border-[var(--color-primary)] hover:bg-[color-mix(in_srgb,var(--color-primary)_3%,transparent)] bg-transparent',
                dragOver === questions.length && 'border-[var(--color-primary)] bg-[color-mix(in_srgb,var(--color-primary)_4%,transparent)]'
              )}
            >
              <div className="w-10 h-10 rounded-full flex items-center justify-center transition-all group-hover:scale-110 bg-[color-mix(in_srgb,var(--color-primary)_8%,transparent)]">
                <Icon name="add" size={22} className="text-[var(--color-primary)]" />
              </div>
              <span className="text-sm font-bold text-[var(--color-primary)]">Add Question</span>
              <span className="text-xs text-muted-foreground">or drag a type from the left panel</span>
            </Button>
          </div>
        )}
      </div>

      {/* ── Properties / Settings Panel ── */}
      <aside
        className="fixed z-30 overflow-hidden bg-[#fafbfc] hidden md:block"
        style={{
          right:     0,
          top:       '4rem',
          width:     panelOpen ? PROPS_W : 0,
          height:    'calc(100vh - 4rem)',
          transition: 'width 0.3s cubic-bezier(0.4,0,0.2,1)',
          borderLeft: '1px solid rgba(171,173,175,0.12)',
        }}
      >
        <div className="w-[320px] h-full overflow-hidden">
          {settingsOpen ? (
            <SurveySettingsPanel
              surveyId={surveyIdParam ?? ''}
              initialTags={surveyTags}
              onTagsChange={setSurveyTags}
              settings={surveySettings}
              onChange={(v: SurveySettings) => { isDirtyRef.current = true; setSurveySettings(v); }}
              onClose={() => setSettingsOpen(false)}
              fromTemplate={fromTemplate}
            />
          ) : (
            <PropertiesPanel
              q={selectedQ}
              allQuestions={questions}
              onUpdate={updateQuestion}
              onClose={() => setSelectedId(null)}
            />
          )}
        </div>
      </aside>

      {/* Decorative glow */}
      <div className="fixed pointer-events-none -z-10 rounded-full"
        style={{ top: '-5%', right: '-10%', width: 600, height: 600, background: 'rgba(224,231,255,0.25)', filter: 'blur(150px)' }} />

      {/* Crystal chat chassis convergence (Phase A) — this page used to mount
          its own independent chat (XperiqCopilot, ExperientCopilot.tsx). It
          now uses the same global CrystalPanel every other page uses (mounted
          once in AppShell), scoped/wired via useCrystalPanel() above — AppShell
          no longer suppresses Crystal on this route. No panel JSX to render here. */}
    </>
  );
}
