import React, { useState, useRef, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Icon } from './Icon';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useTranslation } from '../lib/i18n';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface RefineResult {
  questions?:       unknown[];
  explanation?:     string;
  response_type?:   'edit' | 'answer';
  changes?:         Array<{ question_id?: string; what_changed?: string; action?: string }>;
  suggestions?:     string[];
  compliance_risk?: string;
  actions?:         CopilotAction[];
  recommendations?: Recommendation[];
}

export interface Recommendation {
  action:     string;
  label:      string;
  reason:     string;
  priority:   'high' | 'medium' | 'low';
  cta:        string;
  confidence: number;
}

interface CopilotAction {
  type: string;
  payload?: unknown;
}

interface CopilotContext {
  surveyTitle?:  string;
  questionCount?: number;
  surveyType?:   string;
  isBuilder?:    boolean;
  runId?:        string;     // agent run ID — enables CRUD endpoints
  complianceRisk?: string;   // "low" | "medium" | "high"
  surveySettings?: {
    intent?: string;
    description?: string;
  };
  templateInfo?: {
    label?: string;
    id?: string;
  } | null;
}

interface ChatMessage {
  role:             'ai' | 'user';
  text:             string;
  changes?:         RefineResult['changes'];
  suggestions?:     string[];
  risk?:            string;
  recommendations?: Recommendation[];
}

export interface XperiqCopilotProps {
  context?:                 CopilotContext;
  onRefine?:                (message: string, history: Array<{ role: 'user' | 'assistant'; content: string }>) => Promise<RefineResult>;
  onAction?:                (action: CopilotAction) => void;
  onApplyRecommendation?:   (action: string) => Promise<{ recommendations?: Recommendation[]; message?: string; compliance_risk?: string } | void>;
  recommendations?:         Recommendation[];
  quickCommands?:           string[];
  initiallyOpen?:           boolean;
  initialMessage?:          string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const LOADING_STATUSES = [
  'Reading your survey…',
  'Analyzing the request…',
  'Preparing changes…',
  'Almost ready…',
];

const BUILDER_COMMANDS = [
  'Add a follow-up "why?" after the first question',
  'Reorder questions by difficulty level',
  'Make all questions required',
  'Add skip logic: if NPS < 7, jump to last question',
  'Add a demographic question at the end',
];
const GENERIC_COMMANDS = [
  'Add a multiple choice question about pricing',
  'Make all questions required',
  'Add a follow-up open text question',
  'Add skip logic to the first question',
];

function buildGreeting({ surveyTitle, questionCount, surveyType, surveySettings, templateInfo }: CopilotContext): string {
  const type = surveyType || templateInfo?.label;
  const desc = surveySettings?.intent || surveySettings?.description;
  if (questionCount) {
    let msg = `I'm looking at your${type ? ` ${type}` : ''} survey "${surveyTitle || 'Untitled'}" — ${questionCount} question${questionCount !== 1 ? 's' : ''}.`;
    if (desc) msg += ` Goal: ${desc.slice(0, 80)}${desc.length > 80 ? '…' : ''}`;
    msg += ' Tell me what to change and I\'ll apply it instantly.';
    return msg;
  }
  return `Hi, I'm Crystal — Xperiq's AI copilot. Tell me what you'd like to do and I'll handle it.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

// onAction is scaffolded for future UI commands (open panels, highlight questions, etc.)
export function XperiqCopilot({ context = {}, onRefine, onAction, onApplyRecommendation, recommendations, quickCommands, initiallyOpen = false, initialMessage }: XperiqCopilotProps) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(initiallyOpen);
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    const msgs: ChatMessage[] = [{ role: 'ai', text: buildGreeting(context) }];
    if (initialMessage) msgs.push({ role: 'ai', text: initialMessage });
    if (recommendations?.length) {
      msgs.push({
        role: 'ai',
        text: `Here's what I recommend for your survey:`,
        recommendations,
      });
    }
    return msgs;
  });
  const [applyingRec, setApplyingRec] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingStatusIdx, setLoadingStatusIdx] = useState(0);
  const [unread, setUnread] = useState(0);
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 640);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const commands = quickCommands || (context.isBuilder ? BUILDER_COMMANDS : GENERIC_COMMANDS);

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 640);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setIsOpen((o) => !o);
      }
      if (e.key === 'Escape' && isOpen) setIsOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) {
      setUnread(0);
      setTimeout(() => inputRef.current?.focus(), 120);
    }
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isOpen]);

  useEffect(() => {
    if (!loading) { setLoadingStatusIdx(0); return; }
    const interval = setInterval(() => {
      setLoadingStatusIdx((i) => Math.min(i + 1, LOADING_STATUSES.length - 1));
    }, 2500);
    return () => clearInterval(interval);
  }, [loading]);

  const send = useCallback(async (text?: string) => {
    const msg = (text || input).trim();
    if (!msg || loading || !onRefine) return;
    setInput('');
    setMessages((prev) => [...prev, { role: 'user', text: msg }]);
    setLoading(true);
    try {
      // Build conversation history from prior messages (exclude initial greeting, map 'ai'→'assistant')
      const history = messages
        .slice(1)           // skip the greeting
        .slice(-8)          // last 4 exchanges (8 messages)
        .map((m) => ({
          role: (m.role === 'ai' ? 'assistant' : 'user') as 'user' | 'assistant',
          content: m.text,
        }));
      const result = await onRefine(msg, history);
      if (result?.actions?.length && onAction) {
        result.actions.forEach((action) => onAction(action));
      }
      const isAnswer = result?.response_type === 'answer';
      const count = result?.questions?.length;
      const explanation = result?.explanation
        || (isAnswer ? '' : count ? `✓ Applied — survey updated to ${count} question${count !== 1 ? 's' : ''}.` : '✓ Done! Changes applied.');
      setMessages((prev) => [...prev, {
        role: 'ai',
        text: explanation,
        changes:         isAnswer ? [] : result?.changes,
        suggestions:     result?.suggestions,
        risk:            result?.compliance_risk,
        recommendations: result?.recommendations?.length ? result.recommendations : undefined,
      }]);
      if (!isOpen) setUnread((u) => u + 1);
    } catch {
      setMessages((prev) => [...prev, { role: 'ai', text: 'Something went wrong. Please try again.' }]);
    } finally {
      setLoading(false);
      if (isOpen) setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [input, loading, onRefine, onAction, isOpen, messages]);

  const applyRecommendation = useCallback(async (rec: Recommendation) => {
    if (!onApplyRecommendation || applyingRec) return;
    setApplyingRec(rec.action);
    try {
      const applyResult = await onApplyRecommendation(rec.action);
      const result = applyResult as { recommendations?: Recommendation[]; message?: string; compliance_risk?: string } | undefined;
      const followUps       = result?.recommendations;
      const resultMessage   = result?.message;
      const complianceRisk  = result?.compliance_risk;

      // Remove the applied card from all messages
      setMessages((prev) => prev.map((m) =>
        m.recommendations
          ? { ...m, recommendations: m.recommendations.filter((r) => r.action !== rec.action) }
          : m
      ));

      // Show the actual result message from the server (not a hardcoded string)
      const displayText = resultMessage || `✓ ${rec.label} applied.`;
      setMessages((prev) => [...prev, {
        role:            'ai',
        text:            displayText,
        risk:            complianceRisk,          // shows compliance badge if present
        recommendations: followUps?.length ? followUps : undefined,
      }]);

      if (!isOpen) setUnread((u) => u + 1);
    } catch {
      setMessages((prev) => [...prev, { role: 'ai', text: 'Could not apply that recommendation. Try again.' }]);
    } finally {
      setApplyingRec(null);
    }
  }, [onApplyRecommendation, applyingRec, isOpen]);

  const hasContext = context.surveyTitle || context.questionCount != null;

  return (
    <>
      {/* Bubble */}
      <div className="fixed bottom-4 right-4 sm:bottom-6 sm:right-6 z-50 flex flex-col items-end gap-2.5">
        <AnimatePresence>
          {!isOpen && messages.length <= 1 && (
            <motion.div
              initial={{ opacity: 0, y: 6, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ delay: 1.5, duration: 0.18 }}
              onClick={() => setIsOpen(true)}
              className="cursor-pointer bg-white rounded-2xl px-3.5 py-2.5 flex items-center gap-2"
              style={{ boxShadow: '0 4px 16px color-mix(in srgb, var(--color-primary) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--color-primary) 10%, transparent)' }}
            >
              <span className="text-xs font-black"
                style={{ background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
                Crystal
              </span>
              <kbd className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-[#f3f4f6] text-[#6b7280] border border-[#e5e7eb]">⌘K</kbd>
            </motion.div>
          )}
        </AnimatePresence>

        <button
          onClick={() => setIsOpen((o) => !o)}
          title={t('crystal.builderTooltip')}
          className="relative w-14 h-14 rounded-full flex items-center justify-center transition-transform hover:scale-110 active:scale-95"
          style={{ background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))', boxShadow: '0 6px 24px color-mix(in srgb, var(--color-primary) 38%, transparent)' }}
          aria-label={t('crystal.openBuilderAriaLabel')}
        >
          <AnimatePresence mode="wait">
            <motion.span
              key={isOpen ? 'x' : 'spark'}
              initial={{ scale: 0, rotate: -80 }}
              animate={{ scale: 1, rotate: 0 }}
              exit={{ scale: 0, rotate: 80 }}
              transition={{ duration: 0.14 }}
              className="flex items-center justify-center"
            >
              <Icon name={isOpen ? 'close' : 'auto_awesome'} fill={1} size={24} style={{ color: 'white' }} />
            </motion.span>
          </AnimatePresence>
          {unread > 0 && !isOpen && (
            <span className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-error text-white text-[10px] font-black flex items-center justify-center">
              {unread}
            </span>
          )}
        </button>
      </div>

      {/* Drawer */}
      <AnimatePresence>
        {isOpen && (
          <>
            {/* Backdrop — full screen on mobile, side-only on desktop */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-40 sm:hidden"
              style={{ background: 'rgba(0,0,0,0.32)' }}
              onClick={() => setIsOpen(false)}
            />

            <motion.div
              initial={isMobile ? { opacity: 0, y: '100%' } : { opacity: 0, x: 24, scale: 0.97 }}
              animate={isMobile ? { opacity: 1, y: 0 } : { opacity: 1, x: 0, scale: 1 }}
              exit={isMobile ? { opacity: 0, y: '100%' } : { opacity: 0, x: 24, scale: 0.97 }}
              transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
              className="fixed z-50 flex flex-col bg-white overflow-hidden
                         inset-x-0 bottom-0 rounded-t-2xl
                         sm:inset-x-auto sm:bottom-20 sm:right-4 sm:rounded-2xl sm:w-[430px]
                         md:bottom-24 md:right-6 md:w-[460px]
                         lg:w-[500px]"
              style={{
                maxHeight: isMobile ? '88dvh' : 'calc(100vh - 110px)',
                boxShadow: '0 20px 60px -8px color-mix(in srgb, var(--color-primary) 18%, transparent), 0 0 0 1px color-mix(in srgb, var(--color-primary) 8%, transparent)',
              }}
            >
              {/* Drag handle — mobile only */}
              <div className="sm:hidden flex justify-center pt-2.5 pb-1 flex-shrink-0">
                <div className="w-10 h-1 rounded-full bg-[#e5e7eb]" />
              </div>

              {/* Header */}
              <div className="flex items-center gap-3 px-4 py-3 flex-shrink-0 border-b" style={{ borderColor: 'color-mix(in srgb, var(--color-primary) 10%, transparent)', background: 'linear-gradient(to bottom, color-mix(in srgb, var(--color-primary) 3.5%, transparent), transparent)' }}>
                <div className="w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0"
                  style={{ background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))' }}>
                  <Icon name="diamond" size={16} style={{ color: 'white' }} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 leading-none mb-0.5">
                    <span className="text-sm font-black text-on-surface">Crystal</span>
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full" style={{ background: 'color-mix(in srgb, var(--color-primary) 8%, transparent)', color: 'var(--color-primary)' }}>{t('crystal.builderBadge')}</span>
                  </div>
                  <div className="text-[10px] text-[#9ca3af] font-medium">Survey Intelligence · Builder</div>
                </div>
                <div className="flex items-center gap-2.5">
                  <div className="flex items-center gap-1.5">
                    <div className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                    <span className="text-[10px] text-[#9ca3af] font-bold">LIVE</span>
                  </div>
                  <kbd className="hidden md:block text-[9px] font-bold px-1.5 py-0.5 rounded bg-[#f3f4f6] text-[#9ca3af] border border-[#e5e7eb]">⌘K</kbd>
                  <button
                    onClick={() => setIsOpen(false)}
                    className="w-7 h-7 rounded-full flex items-center justify-center transition-colors hover:bg-[#f3f4f6] text-[#9ca3af] hover:text-[#374151]"
                    aria-label="Close"
                  >
                    <Icon name="close" size={16} />
                  </button>
                </div>
              </div>

              {/* Context strip — shows survey + settings + template */}
              {hasContext && (
                <div className="px-4 py-2.5 border-b flex-shrink-0 bg-[#f8f9ff] border-l-[3px]" style={{ borderBottomColor: 'color-mix(in srgb, var(--color-primary) 6%, transparent)', borderLeftColor: 'var(--color-primary)' }}>
                  <div className="flex items-center gap-2">
                    <Icon name="edit_note" size={13} style={{ color: '#818cf8', flexShrink: 0 }} />
                    <span className="text-[11px] font-semibold text-primary truncate flex-1">
                      {context.surveyTitle || 'Untitled Survey'}
                    </span>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      {context.questionCount != null && (
                        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-[#eef2ff] text-primary">
                          {context.questionCount}q
                        </span>
                      )}
                      {(context.surveyType || context.templateInfo?.label) && (
                        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-[#f3e8ff] text-[#7c3aed] max-w-[80px] truncate">
                          {context.surveyType || context.templateInfo?.label}
                        </span>
                      )}
                    </div>
                  </div>
                  {(context.surveySettings?.intent || context.surveySettings?.description) && (
                    <p className="text-[10px] text-[#9ca3af] mt-1 truncate pl-[21px]">
                      {(context.surveySettings.intent || context.surveySettings.description)!.slice(0, 90)}
                    </p>
                  )}
                </div>
              )}

              {/* Messages */}
              <ScrollArea className="flex-1 px-4 py-3" style={{ minHeight: 160 }}>
                <div className="space-y-3">
                  {messages.map((msg, i) => (
                    <div key={i} className={`flex gap-2 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                      {msg.role === 'ai' && (
                        <div className="w-6 h-6 rounded-full flex-shrink-0 mt-0.5 flex items-center justify-center"
                          style={{ background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))' }}>
                          <Icon name="diamond" size={11} style={{ color: 'white' }} />
                        </div>
                      )}
                      <div className="flex flex-col gap-1.5 max-w-[84%]">
                        <div
                          className="px-3.5 py-2.5 rounded-2xl text-sm leading-relaxed"
                          style={
                            msg.role === 'user'
                              ? { background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))', color: 'white', borderBottomRightRadius: 4 }
                              : { background: 'color-mix(in srgb, var(--color-primary) 4%, transparent)', color: '#1e1e2e', border: '1px solid color-mix(in srgb, var(--color-primary) 10%, transparent)', borderBottomLeftRadius: 4 }
                          }
                        >
                          {msg.text}
                        </div>
                        {/* Compliance risk badge */}
                        {msg.risk && msg.risk !== 'low' && (
                          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg self-start"
                            style={{ background: msg.risk === 'high' ? '#fef2f2' : '#fffbeb', border: `1px solid ${msg.risk === 'high' ? '#fecaca' : '#fde68a'}` }}>
                            <Icon name="warning" size={11} style={{ color: msg.risk === 'high' ? '#ef4444' : '#f59e0b' }} />
                            <span className="text-[10px] font-semibold" style={{ color: msg.risk === 'high' ? '#dc2626' : '#d97706' }}>
                              {msg.risk === 'high' ? 'High compliance risk' : 'Review compliance'}
                            </span>
                          </div>
                        )}
                        {/* Change summary chips */}
                        {msg.changes && msg.changes.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-0.5">
                            {msg.changes.slice(0, 4).map((c, ci) => (
                              <span key={ci} className="text-[10px] px-2 py-0.5 rounded-full font-medium"
                                style={{ background: '#f0fdf4', color: '#16a34a', border: '1px solid #bbf7d0' }}>
                                {c.action === 'removed' ? '− ' : c.action === 'added' ? '+ ' : '✎ '}
                                {c.what_changed || `q${(c.question_id || '').slice(-4)}`}
                              </span>
                            ))}
                            {msg.changes.length > 4 && (
                              <span className="text-[10px] px-2 py-0.5 rounded-full font-medium"
                                style={{ background: '#f0fdf4', color: '#16a34a', border: '1px solid #bbf7d0' }}>
                                +{msg.changes.length - 4} more
                              </span>
                            )}
                          </div>
                        )}
                        {/* Recommendation cards */}
                        {msg.recommendations && msg.recommendations.length > 0 && (
                          <div className="flex flex-col gap-2 mt-1">
                            {msg.recommendations.map((rec) => {
                              const priorityColor = rec.priority === 'high'
                                ? { bg: '#fef2f2', border: '#fecaca', text: '#dc2626' }
                                : rec.priority === 'medium'
                                ? { bg: '#fffbeb', border: '#fde68a', text: '#d97706' }
                                : { bg: '#f0fdf4', border: '#bbf7d0', text: '#16a34a' };
                              const isApplying = applyingRec === rec.action;
                              return (
                                <div key={rec.action}
                                  className="rounded-xl p-3 flex flex-col gap-2"
                                  style={{ background: '#fafbff', border: '1px solid color-mix(in srgb, var(--color-primary) 12%, transparent)' }}
                                >
                                  <div className="flex items-start justify-between gap-2">
                                    <span className="text-[12px] font-semibold text-[#1e1e2e] leading-snug">{rec.label}</span>
                                    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full flex-shrink-0"
                                      style={{ background: priorityColor.bg, color: priorityColor.text, border: `1px solid ${priorityColor.border}` }}>
                                      {rec.priority}
                                    </span>
                                  </div>
                                  <p className="text-[10px] text-[#6b7280] leading-relaxed">{rec.reason}</p>
                                  {onApplyRecommendation && (
                                    <button
                                      onClick={() => applyRecommendation(rec)}
                                      disabled={!!applyingRec}
                                      className="self-start text-[11px] font-semibold px-3 py-1.5 rounded-lg transition-all disabled:opacity-40"
                                      style={{ background: 'color-mix(in srgb, var(--color-primary) 8%, transparent)', color: 'var(--color-primary)', border: '1px solid color-mix(in srgb, var(--color-primary) 18%, transparent)' }}
                                      onMouseEnter={(e) => { if (!applyingRec) e.currentTarget.style.background = 'color-mix(in srgb, var(--color-primary) 16%, transparent)'; }}
                                      onMouseLeave={(e) => { e.currentTarget.style.background = 'color-mix(in srgb, var(--color-primary) 8%, transparent)'; }}
                                    >
                                      {isApplying ? (
                                        <span className="flex items-center gap-1.5">
                                          <span className="w-3 h-3 rounded-full border-2 border-t-transparent animate-spin inline-block" style={{ borderColor: 'var(--color-primary)', borderTopColor: 'transparent' }} />
                                          Applying…
                                        </span>
                                      ) : rec.cta}
                                    </button>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                        {/* Follow-up suggestion chips */}
                        {msg.suggestions && msg.suggestions.length > 0 && (
                          <div className="flex flex-col gap-1 mt-1">
                            {msg.suggestions.slice(0, 3).map((s, si) => (
                              <button key={si}
                                onClick={() => send(s)}
                                disabled={loading}
                                className="text-left text-[11px] px-2.5 py-1.5 rounded-xl font-medium transition-colors disabled:opacity-40"
                                style={{ background: 'color-mix(in srgb, var(--color-primary) 6%, transparent)', color: 'var(--color-primary)', border: '1px solid color-mix(in srgb, var(--color-primary) 15%, transparent)' }}
                                onMouseEnter={(e) => { e.currentTarget.style.background = 'color-mix(in srgb, var(--color-primary) 12%, transparent)'; }}
                                onMouseLeave={(e) => { e.currentTarget.style.background = 'color-mix(in srgb, var(--color-primary) 6%, transparent)'; }}
                              >
                                {s}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                  {loading && (
                    <div className="flex gap-2 justify-start">
                      <div className="w-6 h-6 rounded-full flex-shrink-0 mt-0.5 flex items-center justify-center"
                        style={{ background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))' }}>
                        <motion.div
                          animate={{ scale: [1, 1.2, 1] }}
                          transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}
                          className="flex items-center justify-center"
                        >
                          <Icon name="diamond" size={11} style={{ color: 'white' }} />
                        </motion.div>
                      </div>
                      <div className="px-4 py-3 rounded-2xl flex flex-col gap-2"
                        style={{ background: 'color-mix(in srgb, var(--color-primary) 4%, transparent)', border: '1px solid color-mix(in srgb, var(--color-primary) 10%, transparent)', borderBottomLeftRadius: 4 }}>
                        <div className="flex gap-1 items-center">
                          {[0, 1, 2].map((j) => (
                            <div key={j} className="w-1.5 h-1.5 rounded-full animate-bounce"
                              style={{ background: 'var(--color-primary)', animationDelay: `${j * 0.15}s` }} />
                          ))}
                        </div>
                        <AnimatePresence mode="wait">
                          <motion.span
                            key={loadingStatusIdx}
                            initial={{ opacity: 0, y: 4 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -4 }}
                            transition={{ duration: 0.2 }}
                            className="text-[11px] font-medium"
                            style={{ color: 'var(--color-primary)' }}
                          >
                            {LOADING_STATUSES[loadingStatusIdx]}
                          </motion.span>
                        </AnimatePresence>
                      </div>
                    </div>
                  )}
                  <div ref={bottomRef} />
                </div>
              </ScrollArea>

              {/* Quick commands */}
              {messages.length <= 1 && onRefine && (
                <div className="px-4 py-3 border-t flex-shrink-0" style={{ borderColor: 'color-mix(in srgb, var(--color-primary) 6%, transparent)' }}>
                  <p className="text-[10px] font-bold uppercase tracking-widest text-[#9ca3af] mb-2">Try asking</p>
                  <div className="flex flex-col gap-1.5">
                    {commands.slice(0, 4).map((cmd) => (
                      <button
                        key={cmd}
                        onClick={() => send(cmd)}
                        disabled={loading}
                        className="text-left px-3 py-2 text-xs font-medium rounded-xl transition-colors disabled:opacity-40 truncate"
                        style={{ background: 'color-mix(in srgb, var(--color-primary) 6%, transparent)', color: 'var(--color-primary)', border: '1px solid color-mix(in srgb, var(--color-primary) 12%, transparent)' }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = 'color-mix(in srgb, var(--color-primary) 12%, transparent)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = 'color-mix(in srgb, var(--color-primary) 6%, transparent)'; }}
                      >
                        {cmd}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Input */}
              <div className="px-4 pb-4 pt-2.5 flex-shrink-0">
                <div
                  className="flex items-end gap-2 rounded-xl px-3 py-2.5 transition-all"
                  style={{ background: '#f9fafb', border: '1.5px solid color-mix(in srgb, var(--color-primary) 10%, transparent)' }}
                  onFocusCapture={(e) => { (e.currentTarget as HTMLDivElement).style.borderColor = 'color-mix(in srgb, var(--color-primary) 30%, transparent)'; }}
                  onBlurCapture={(e) => { (e.currentTarget as HTMLDivElement).style.borderColor = 'color-mix(in srgb, var(--color-primary) 10%, transparent)'; }}
                >
                  <Textarea
                    ref={inputRef}
                    value={input}
                    onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setInput(e.target.value)}
                    onKeyDown={(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
                      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
                    }}
                    placeholder={onRefine ? 'Describe a change… (↵ to send)' : 'Open a survey to start…'}
                    rows={2}
                    disabled={loading || !onRefine}
                    className="flex-1 resize-none text-sm bg-transparent border-none outline-none text-[#374151] placeholder:text-[#d1d5db] focus-visible:ring-0 focus-visible:ring-offset-0 p-0"
                  />
                  <button
                    onClick={() => send()}
                    disabled={!input.trim() || loading || !onRefine}
                    className="w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center transition-all hover:scale-110 active:scale-95 disabled:opacity-35"
                    style={{
                      background: input.trim() && !loading && onRefine ? 'var(--color-primary)' : '#e5e7eb',
                      color: input.trim() && !loading && onRefine ? 'white' : '#9ca3af',
                    }}
                    aria-label="Send"
                  >
                    <Icon name="send" size={15} />
                  </button>
                </div>
                <p className="text-[10px] text-[#d1d5db] text-center mt-1.5 font-medium">
                  ↵ send · ⇧↵ newline · ⌘K toggle
                </p>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
