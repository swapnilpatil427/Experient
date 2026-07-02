// Crystal Panel — the large right-side AI conversation panel for Insights.
// Default width: 55% of the content area. Expandable to 100%.
// Slides in from the right over the Insights page content.
// Wired to the Crystal hero ask bar, ⌘K shortcut, and SideNav Crystal item.

import { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { invalidate } from '../lib/dataBus';
import { useTranslation } from '../lib/i18n';
import type { EscalationPackage } from '../lib/api';
import { ROUTES, toPath } from '../constants/routes';
import type { ActionProposal } from '../types';
import { AnimatePresence, motion } from 'framer-motion';
import { Icon } from './Icon';
import { Button } from '@/components/ui/button';
import { useCrystalPanel, type CrystalCtx } from '../contexts/crystalPanel';
import { GlassCard, CitationChip, ConfidenceChip, SENTIMENT_BORDER } from '../pages/insights/shared';
import { InsightDocumentCard, type InsightDocument } from './insights/InsightDocumentCard';
import { ManualRunDialog } from './insights/ManualRunDialog';
import type { ManualRunMode } from '../types';
import { useApi } from '../hooks/useApi';
import { useAppAuth } from '../lib/auth';
import { useBrand } from '../contexts/brandContext';
import type { SurveyScope } from './SurveyScopePicker';
import type { Insight, Survey, AgenticInsight, SurveyTopic } from '../types';

// Streaming is always enabled — no env flag needed.
// Falls back to REST only when the streaming endpoint is unreachable.
const CRYSTAL_STREAMING = true;

interface Message {
  id: string;
  role: 'user' | 'crystal';
  content: string;
  timestamp: Date;
  confidence?: number;
  citations?: CrystalCitation[];  // rich citation objects from streaming API
  suggestions?: string[];          // follow-up prompts from the real API
  thumbs?: 'up' | 'down' | null;
  pinned?: boolean;
  documents?: InsightDocument[];   // render_hint==='document' tool results
}

// Citation object returned from the streaming crystal endpoint
interface CrystalVerbatim {
  response_id: string;
  quote:       string;
  sentiment?:  'positive' | 'negative' | 'neutral';
  topic?:      string | null;  // which topic this verbatim belongs to
}

interface CrystalCitation {
  id:            string;
  quote?:        string;
  sentiment?:    'positive' | 'negative' | 'neutral';
  // Source attribution — enriched from citation_context event or REST response
  headline?:     string;
  survey_title?: string;
  survey_id?:    string;
  layer?:        string;
  category?:     string;
  verbatims?:    CrystalVerbatim[];  // actual customer responses from the insight
  topic_name?:   string;             // for voice.topic insights — enables deep dive nav
}

// Lookup map returned by the backend alongside every Crystal response.
// Maps insight_id → source metadata including verbatim responses.
type CitationMap = Record<string, Omit<CrystalCitation, 'id' | 'quote' | 'sentiment'>>;

// Streaming state during a live SSE response
type StreamingPhase =
  | { phase: 'thinking'; tool?: string; message?: string }
  | { phase: 'observation'; tool?: string; summary?: string }
  | { phase: 'synthesizing' }
  | null;

interface CrystalPanelProps {
  scope: SurveyScope;
  surveys: Survey[];
  insights?: Insight | null;
  // agenticInsights / topics can still be passed as props for backward compat,
  // but the global panel reads them from context (set by whichever page is active).
  agenticInsights?: AgenticInsight[];
  topics?: SurveyTopic[];
  initialMode?: 'support' | 'analyst';
}

function classifyAsSupport(message: string): boolean {
  const lower = message.toLowerCase();
  const keywords = [
    'help', 'error', 'broken', 'issue', 'problem', 'not working', 'bug', 'crash',
    'how do i', 'how to', 'can i', 'support', 'docs', 'documentation', 'setup',
    'configure', 'stuck', 'fails', 'failing', "can't", 'cannot', 'wrong',
    'unexpected', 'missing feature', 'feature request',
  ];
  return keywords.some((kw) => lower.includes(kw));
}

const SINGLE_PROMPTS = [
  { icon: 'trending_down', label: 'Why did NPS drop recently?' },
  { icon: 'warning', label: 'Highest churn-risk segment?' },
  { icon: 'lightbulb', label: 'What would raise CSAT most?' },
  { icon: 'compare', label: 'Compare to last quarter' },
];

const ALL_PROMPTS = [
  { icon: 'compare', label: 'Which survey has highest churn risk?' },
  { icon: 'trending_up', label: 'Themes appearing in 3+ surveys' },
  { icon: 'balance', label: 'Are surveys over-sampling one segment?' },
  { icon: 'lightbulb', label: 'Top portfolio action right now?' },
];

export function CrystalPanel({
  scope, surveys, insights = null,
  agenticInsights: propAgentic,
  topics: propTopics,
  initialMode,
}: CrystalPanelProps) {
  const {
    isOpen, initialQuery, crystalCtx, setCrystalCtx, closeCrystal,
    setScope,
    // Context-injected data from the active page (falls back to prop values)
    agenticInsights: ctxAgentic,
    topics: ctxTopics,
  } = useCrystalPanel();

  // Prefer prop values (page explicitly passed richer data) over context values
  const agenticInsights = propAgentic ?? ctxAgentic;
  const topics          = propTopics  ?? ctxTopics;
  const [isExpanded, setIsExpanded] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isThinking, setIsThinking] = useState(false);
  const [streamingState, setStreamingState] = useState<StreamingPhase>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [isListening, setIsListening] = useState(false);
  // citationMap: insight_id → source metadata (survey, headline, layer).
  // Populated from citation_context SSE event or REST response citation_map field.
  const [citationMap, setCitationMap] = useState<CitationMap>({});
  const citationMapRef = useRef<CitationMap>({});
  // Keep ref in sync so submitQuery can read latest without closure issues.
  useEffect(() => { citationMapRef.current = citationMap; }, [citationMap]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Tracks the last initialQuery that was auto-submitted by the effect below.
  // Deliberately separate from the general submit path — overwriting this ref
  // in submitQuery() would corrupt the guard and cause the initial query to
  // re-fire every time the user clicks a suggestion chip.
  const autoSubmittedQuery = useRef('');
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  // Always track latest scope in a ref so submitQuery never uses a stale closure.
  // Critical when setScope() and openCrystal() are called together — the ref
  // guarantees the correct scope is used even if React hasn't re-rendered yet.
  const scopeRef = useRef(scope);
  useEffect(() => { scopeRef.current = scope; }, [scope]);
  const api = useApi();
  const { getToken, userId, orgId } = useAppAuth();
  const { brandName } = useBrand();
  const { t } = useTranslation();
  const location = useLocation();
  const [escalationPackage, setEscalationPackage] = useState<EscalationPackage | null>(null);
  const [lastSupportResolved, setLastSupportResolved] = useState(false);
  const [feedbackThanks, setFeedbackThanks] = useState<string | null>(null);

  const isSupportMode = (
    initialMode === 'support' ||
    location.pathname.includes('/support') ||
    new URLSearchParams(location.search).get('mode') === 'support' ||
    (messages.length > 0 &&
      messages[messages.length - 1].role === 'user' &&
      classifyAsSupport(messages[messages.length - 1].content))
  );

  const isAll = scope === 'all';
  const activeSurveys = surveys.filter((s) => s.status === 'active' && !s.deleted_at);
  const focusSurvey = !isAll ? surveys.find((s) => s.id === scope) : null;

  // Prefer real agentic NPS over legacy insights fallback
  const npsInsight = agenticInsights.find(
    (i) => i.category === 'metric.nps',
  );
  const nps = npsInsight?.metric_json?.value ?? insights?.nps_score ?? null;

  // Response count from agentic trust data or survey metadata
  const responseCount = agenticInsights[0]?.trust_json?.sample_size ?? focusSurvey?.response_count ?? 0;

  // Dynamic starter prompts: inject top topics if available
  const dynamicPrompts = !isAll && topics.length > 0
    ? [
        ...(topics[0] ? [{ icon: 'topic', label: `What's driving "${topics[0].name}"?` }] : []),
        ...(topics.find(t => (t.sentiment_score ?? 0) < -0.3)
          ? [{ icon: 'warning', label: `Why is "${topics.find(t => (t.sentiment_score ?? 0) < -0.3)!.name}" negative?` }]
          : [{ icon: 'trending_down', label: 'Why did NPS drop recently?' }]
        ),
        { icon: 'lightbulb', label: 'What should I fix first?' },
        { icon: 'emoji_events', label: 'What are customers praising most?' },
      ]
    : (isAll ? ALL_PROMPTS : SINGLE_PROMPTS);

  const WINDOW_LABELS: Record<string, string> = {
    all_time: 'All time',
    '30d': 'Last 30 days',
    '7d': 'Last 7 days',
  };

  const submitQuery = useCallback(
    async (query: string, overrideCtx?: CrystalCtx) => {
      if (!query.trim() || isThinking) return;
      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: 'user', content: query.trim(), timestamp: new Date() },
      ]);
      setIsThinking(true);
      setStreamingState(null);
      setStreamError(null);

      const activeCtx = overrideCtx ?? crystalCtx;

      // ── Support mode path ─────────────────────────────────────────────────
      if (isSupportMode) {
        try {
          const resp = await api.crystalSupport(query.trim(), {
            scope,
            focused_topic: activeCtx.focused_topic,
          });
          setEscalationPackage(resp.escalation_package ?? null);
          setLastSupportResolved(resp.resolved);
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: 'crystal',
              content: resp.answer,
              timestamp: new Date(),
              suggestions: resp.suggestions ?? [],
            },
          ]);
        } catch {
          setStreamError('Support request failed. Please try again.');
        } finally {
          setIsThinking(false);
          setStreamingState(null);
        }
        return;
      }

      // ── Streaming path (VITE_CRYSTAL_STREAMING=true) ──────────────────────
      // Handles both survey scope and org ('all') scope. Org scope uses
      // streamScope='org' and calls /api/experience/org/crystal/stream which
      // runs Crystal against the full portfolio (all active surveys + cross-survey tools).
      if (CRYSTAL_STREAMING) {
        try {
          const token = await getToken();
          const BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';
          // Read from ref to get the latest scope even if React batching hasn't
          // propagated the prop update yet (e.g. when setScope + openCrystal are
          // called together from the hub page survey chip handler).
          const currentScope = scopeRef.current;
          const currentIsAll = currentScope === 'all';
          const streamScope = currentIsAll ? 'org' : 'survey';
          // IMPORTANT: never send 'all' as survey_id — the agents service treats
          // any non-empty survey_id as a UUID and runs check_survey_access on it.
          // Org scope passes '' so the access check is skipped entirely.
          const surveyIdForBody = currentIsAll ? '' : currentScope;
          const currentFocusSurvey = !currentIsAll
            ? surveys.find((s) => s.id === currentScope)
            : null;
          const response = await fetch(
            `${BASE}/api/experience/${streamScope}/crystal/stream`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
              },
              body: JSON.stringify({
                survey_id: surveyIdForBody,
                message: query.trim(),
                insights: agenticInsights ?? [],
                topics: topics ?? [],
                survey_title: currentFocusSurvey?.title ?? '',
                survey_response_count: responseCount ?? 0,
                metrics: {},
                conversation_history: messages
                  .filter((m) => m.role !== 'user' || true)
                  .map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content })),
                scope: streamScope,
                window: activeCtx.window,
                focused_topic: activeCtx.focused_topic,
              }),
            },
          );

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }

          const reader = response.body?.getReader();
          const decoder = new TextDecoder();
          if (!reader) throw new Error('No response stream');

          let buffer = '';
          let answerReceived = false;
          let streamDone = false;
          while (!streamDone) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            // Process complete SSE lines from the buffer
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              const data = line.slice(6).trim();
              if (data === '[DONE]') { streamDone = true; break; }
              try {
                const event = JSON.parse(data) as {
                  type: string;
                  tool?: string;
                  message?: string;
                  summary?: string;
                  answer?: string;
                  citations?: Array<{ id: string; quote?: string; sentiment?: 'positive' | 'negative' | 'neutral' }>;
                  insight_refs?: string[];
                  suggestions?: string[];
                  map?: CitationMap;
                  proposals?: ActionProposal[];
                  documents?: InsightDocument[];
                  render_hint?: string;
                };
                if (event.type === 'citation_context' && event.map) {
                  const merged = { ...citationMapRef.current, ...event.map };
                  setCitationMap(merged);
                  citationMapRef.current = merged;
                  setMessages((prev) => {
                    if (!prev.length) return prev;
                    const last = prev[prev.length - 1];
                    if (last.role !== 'crystal' || !last.citations?.length) return prev;
                    return [
                      ...prev.slice(0, -1),
                      { ...last, citations: enrichCitationsFromMap(last.citations, merged) },
                    ];
                  });
                } else if (event.type === 'thinking') {
                  setStreamingState({ phase: 'thinking', tool: event.tool, message: event.message });
                } else if (event.type === 'observation') {
                  setStreamingState({ phase: 'observation', tool: event.tool, summary: event.summary });
                } else if (event.type === 'synthesizing') {
                  setStreamingState({ phase: 'synthesizing' });
                } else if (event.type === 'answer') {
                  answerReceived = true;
                  setStreamingState(null);
                  const normCitations = buildCitationsFromAnswer(
                    event.citations ?? [],
                    event.insight_refs,
                    event.answer ?? '',
                    citationMapRef.current,
                  );
                  const { text: cleanedAnswer } = parseInlineCitations(event.answer ?? '');
                  // render_hint==='document' (or explicit documents[]) → surface report doc card(s).
                  const docs = event.documents ?? [];
                  setMessages((prev) => [
                    ...prev,
                    {
                      id: crypto.randomUUID(),
                      role: 'crystal',
                      content: cleanedAnswer,
                      timestamp: new Date(),
                      citations: normCitations,
                      suggestions: event.suggestions ?? [],
                      documents: docs.length ? docs : undefined,
                    },
                  ]);
                } else if (event.type === 'action_proposals' && event.proposals?.length) {
                  setActionProposals(event.proposals);
                } else if (event.type === 'error') {
                  answerReceived = true;  // error counts as a response — don't show generic fallback
                  setStreamingState(null);
                  setStreamError(event.message ?? 'An error occurred');
                  setMessages((prev) => [
                    ...prev,
                    {
                      id: crypto.randomUUID(),
                      role: 'crystal',
                      content: event.message ?? 'Something went wrong. Please try again.',
                      timestamp: new Date(),
                    },
                  ]);
                }
              } catch {
                // ignore malformed SSE lines
              }
            }
          }
          // Guard: if stream closed without any answer or error event, fall back to
          // Unified fallback — one endpoint handles any scope automatically.
          // survey_id present → survey context; absent → org/portfolio context.
          if (!answerReceived) {
            try {
              const history = messages.map((m) => ({
                role: m.role === 'user' ? 'user' : 'assistant',
                content: m.content,
              }));
              const data = await api.crystalChat2(query, {
                surveyId:           currentIsAll ? undefined : currentScope,
                focusedTopic:       activeCtx.focused_topic,
                conversationHistory: history,
              });
              // Merge REST citation_map into state before building citations
              const restCitationMap = (data.citation_map ?? {}) as CitationMap;
              if (Object.keys(restCitationMap).length > 0) {
                setCitationMap((prev) => ({ ...prev, ...restCitationMap }));
                citationMapRef.current = { ...citationMapRef.current, ...restCitationMap };
              }
              const mergedMap = { ...citationMapRef.current, ...restCitationMap };
              const { text: cleanedAnswer, extraIds } = parseInlineCitations(data.answer ?? '');

              // Collect IDs from ALL possible sources:
              // - insight_refs (backend preferred field)
              // - citations (Crystal's raw output field — same IDs, different key)
              // - extraIds from multi-UUID blocks stripped by parseInlineCitations
              // - inlineRefs from single [uuid] refs still present in the answer text
              const seenIds = new Set<string>();
              const citations: CrystalCitation[] = [];

              const addId = (rawId: string) => {
                const id = resolveId(rawId.toLowerCase(), mergedMap);
                if (seenIds.has(id)) return;
                seenIds.add(id);
                const meta = mergedMap[id];
                citations.push(meta ? { id, ...meta } : { id });
              };

              // 1. Explicit IDs from agent response
              [...(data.insight_refs ?? []), ...(data.citations ?? [])
                .filter((c: unknown) => typeof c === 'string')]
                .forEach(addId);

              // 2. Multi-UUID blocks stripped from text
              extraIds.forEach(addId);

              // 3. Single [uuid] refs still in the cleaned answer text
              (cleanedAnswer.match(/\[[0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\]/gi) ?? [])
                .map((m) => m.slice(1, -1))
                .forEach(addId);
              setMessages((prev) => [
                ...prev,
                {
                  id: crypto.randomUUID(),
                  role: 'crystal',
                  content: cleanedAnswer,
                  timestamp: new Date(),
                  citations,
                  suggestions: data.suggestions ?? [],
                },
              ]);
            } catch {
              setMessages((prev) => [
                ...prev,
                {
                  id: crypto.randomUUID(),
                  role: 'crystal',
                  content: 'Crystal is unavailable right now. Make sure the agents service is running.',
                  timestamp: new Date(),
                },
              ]);
            }
          }
        } catch (err) {
          const isOutOfCredits = err instanceof Error && err.message.includes('402');
          const isServiceDown = err instanceof Error && (
            err.message.includes('fetch') || err.message.includes('503') || err.message.includes('502')
          );
          setStreamingState(null);
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: 'crystal',
              content: isOutOfCredits
                ? 'You\'re out of AI credits. Open Billing & Credits (the credits pill, top-right) to upgrade your plan or add a top-up — then ask again.'
                : isServiceDown
                ? 'The agents service isn\'t reachable right now. Make sure it\'s running and try again.'
                : 'Something went wrong. Please try your question again.',
              timestamp: new Date(),
            },
          ]);
        } finally {
          setIsThinking(false);
          setStreamingState(null);
          invalidate('credits');  // a turn may have consumed credits — refresh the chip
        }
        return;
      }

      // ── Legacy path ────────────────────────────────────────────────────────
      // Org-level portfolio queries have no non-streaming REST endpoint.
      // Surface a clean user-facing message with no technical details.
      if (isAll) {
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: 'crystal',
            content: 'Portfolio analysis isn\'t available right now. Try opening a specific survey from the hub to get insights.',
            timestamp: new Date(),
            suggestions: ['Open a survey instead →'],
          },
        ]);
        setIsThinking(false);
        return;
      }
      try {
        const { answer, suggestions, insight_refs } = await api.crystalChat(scope, query, {
          window: activeCtx.window,
          focused_topic: activeCtx.focused_topic,
        });
        // Map legacy string refs to CrystalCitation objects
        const citations: CrystalCitation[] = (insight_refs ?? []).map((id) => ({ id }));
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: 'crystal',
            content: answer,
            timestamp: new Date(),
            citations,
            suggestions,
          },
        ]);
      } catch (err) {
        const isOutOfCredits = err instanceof Error && err.message.includes('402');
        const isServiceDown = err instanceof Error && (
          err.message.includes('fetch') || err.message.includes('503') || err.message.includes('502')
        );
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: 'crystal',
            content: isOutOfCredits
              ? 'You\'re out of AI credits. Open Billing & Credits (the credits pill, top-right) to upgrade your plan or add a top-up — then ask again.'
              : isServiceDown
              ? 'The agents service isn\'t reachable right now. Make sure it\'s running on :8001 and try again.'
              : 'Something went wrong. Please try your question again.',
            timestamp: new Date(),
          },
        ]);
      } finally {
        setIsThinking(false);
        invalidate('credits');  // a turn may have consumed credits — refresh the chip
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isAll, isThinking, api, scope, crystalCtx, getToken, agenticInsights, topics, focusSurvey, responseCount, messages],
  );

  // Auto-submit when panel opens with a pre-loaded query.
  // Uses autoSubmittedQuery (not lastSubmittedQuery) so that suggestion chip
  // clicks — which call submitQuery() directly — cannot corrupt the guard and
  // accidentally re-fire the original initialQuery on every message update.
  useEffect(() => {
    if (isOpen && initialQuery && initialQuery !== autoSubmittedQuery.current) {
      autoSubmittedQuery.current = initialQuery;
      setInput('');
      submitQuery(initialQuery);
    }
  }, [isOpen, initialQuery, submitQuery]);

  // Auto-scroll to latest message
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isThinking]);

  // Focus input when panel opens
  useEffect(() => {
    if (isOpen && inputRef.current) {
      const timer = setTimeout(() => inputRef.current?.focus(), 350);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  // Reset expanded state when closed
  useEffect(() => {
    if (!isOpen) setIsExpanded(false);
  }, [isOpen]);

  const handleMic = useCallback(() => {
    const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognitionCtor) return;

    if (isListening && recognitionRef.current) {
      recognitionRef.current.stop();
      setIsListening(false);
      return;
    }

    const recognition = new SpeechRecognitionCtor();
    recognition.lang = 'en-US';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognitionRef.current = recognition;

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      const transcript = event.results[0][0].transcript;
      setInput(prev => (prev ? `${prev} ${transcript}` : transcript));
    };
    recognition.onend = () => setIsListening(false);
    recognition.onerror = () => setIsListening(false);

    recognition.start();
    setIsListening(true);
  }, [isListening]);

  const handlePin = useCallback((id: string) => {
    setMessages(prev => prev.map(m => m.id === id ? { ...m, pinned: !m.pinned } : m));
  }, []);

  const handleThumbsUp = useCallback((id: string) => {
    setMessages(prev => prev.map(m => {
      if (m.id !== id) return m;
      const newThumbs = m.thumbs === 'up' ? null : 'up';
      // Persist to all cited insight IDs (fire-and-forget)
      if (!isAll && m.citations?.length) {
        m.citations.forEach(c => {
          api.updateInsightFeedback(c.id, { thumbs: newThumbs }).catch(() => {});
        });
      }
      return { ...m, thumbs: newThumbs };
    }));
  }, [api, isAll]);

  const handleThumbsDown = useCallback((id: string) => {
    setMessages(prev => prev.map(m => {
      if (m.id !== id) return m;
      const newThumbs = m.thumbs === 'down' ? null : 'down';
      // Persist to all cited insight IDs (fire-and-forget)
      if (!isAll && m.citations?.length) {
        m.citations.forEach(c => {
          api.updateInsightFeedback(c.id, { thumbs: newThumbs }).catch(() => {});
        });
      }
      return { ...m, thumbs: newThumbs };
    }));
  }, [api, isAll]);

  // ── Action Proposals ─────────────────────────────────────────────────────────
  const navigate = useNavigate();
  const [actionProposals, setActionProposals] = useState<ActionProposal[]>([]);
  const [executingAction, setExecutingAction] = useState<string | null>(null);
  // Manual-run dialog opened from a Crystal report proposal
  // (trigger_manual_insight_run / generate_intelligence_report).
  const [manualRunDialog, setManualRunDialog] = useState<{ open: boolean; mode: ManualRunMode }>({
    open: false,
    mode: 'expert',
  });

  const note = useCallback((content: string) => {
    setMessages(prev => [...prev, {
      id: crypto.randomUUID(), role: 'crystal' as const, content, timestamp: new Date(),
    }]);
  }, []);

  const executeAction = useCallback(async (proposal: ActionProposal) => {
    if (executingAction) return;
    setExecutingAction(proposal.id);
    const surveyId = focusSurvey?.id;

    const track = (status: 'accepted' | 'succeeded' | 'failed', outcomeRef?: string, errorDetail?: string) => {
      if (!api.recordProposalOutcome) return;
      api.recordProposalOutcome(surveyId ?? 'global', {
        proposalKey:       proposal.id,
        type:              proposal.type,
        params:            proposal.params,
        priority:          proposal.priority,
        businessRationale: proposal.business_rationale,
        confidence:        proposal.confidence,
        status,
        outcomeRef,
        errorDetail,
      }).catch(() => {});
    };

    track('accepted');
    try {
      switch (proposal.type) {
        case 'create_followup_survey':
        case 'create_survey': {
          const intent = (proposal.params.intent as string) || proposal.description;
          const typeId  = (proposal.params.survey_type as string) || undefined;
          const result  = await api.startRun({ intent, surveyTypeId: typeId });
          track('succeeded', result.run_id);
          navigate(toPath(ROUTES.BUILDER, { surveyId: 'new' }), {
            state: { intent, surveyTypeId: typeId, runId: result.run_id, openCrystal: true },
          });
          break;
        }
        case 'edit_survey_questions':
        case 'edit_survey': {
          if (!surveyId) { track('failed', undefined, 'no survey in scope'); break; }
          const msg = (proposal.params.message as string) || proposal.description;
          const runStatus = await api.getInsightRunStatus(surveyId);
          const currentRun = runStatus.run_id;
          if (!currentRun) { track('failed', undefined, 'no run for survey'); break; }
          const refined = await api.copilotRefine(currentRun, { message: msg, questions: [] });
          track('succeeded', currentRun);
          navigate(toPath(ROUTES.BUILDER, { surveyId }), {
            state: { id: surveyId, runId: currentRun, questions: refined.questions ?? [], openCrystal: true },
          });
          break;
        }
        case 'distribute_to_segment':
        case 'distribute': {
          if (!surveyId) { track('failed', undefined, 'no survey in scope'); break; }
          track('succeeded', surveyId);
          navigate(toPath(ROUTES.BUILDER, { surveyId }), { state: { openTab: 'distribute' } });
          break;
        }
        case 'create_workflow': {
          if (!surveyId) { track('failed', undefined, 'no survey in scope'); break; }
          // Primary path: modern graph shape emitted by CrystalOS's reconciled
          // `execute_propose_workflow` (Wave 3) — `params.nodes`/`params.edges`/
          // `params.trigger_type` (snake_case on the wire; `_normalize_proposal`
          // passes `params` through untouched). Falls back to the legacy flat
          // `trigger`/`action_type`/`action_config` shape only so a stale/cached
          // proposal from before this fix doesn't crash — new proposals always
          // carry `nodes`/`edges` and take the primary path.
          const nodes = proposal.params.nodes as unknown[] | undefined;
          const edges = proposal.params.edges as unknown[] | undefined;
          if (Array.isArray(nodes) && Array.isArray(edges)) {
            const created = await api.createGraphWorkflow({
              name:        (proposal.params.name as string) || proposal.title,
              description: (proposal.params.description as string) || proposal.description,
              triggerType: (proposal.params.trigger_type as string) || 'manual',
              nodes,
              edges,
              status:      'draft',
            });
            invalidate('workflows');
            track('succeeded', (created as { workflow?: { id?: string } })?.workflow?.id);
            note(`Workflow created: "${proposal.title}". Open Workflows to manage it.`);
            break;
          }

          // Legacy fallback — old flat shape, kept only for stale proposals.
          const wf = {
            name:          (proposal.params.name as string) || proposal.title,
            trigger:       (proposal.params.trigger as string) || proposal.params.trigger_event as string,
            action_type:   (proposal.params.action_type as string) || 'notify',
            action_config: (proposal.params.action_config as Record<string, unknown>) || {},
            survey_id:     surveyId,
            enabled:       true,
          };
          const created = await api.createWorkflow(wf);
          invalidate('workflows');
          track('succeeded', (created as { id?: string })?.id);
          note(`Workflow created: "${proposal.title}". Open Workflows to manage it.`);
          break;
        }
        case 'create_alert': {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const createAlertFn = (api as Record<string, any>).createAlertRule;
          if (createAlertFn) {
            const created = await createAlertFn({
              alertType:       (proposal.params.alert_type as string) || 'S-03',
              name:            (proposal.params.name as string) || proposal.title,
              description:     proposal.description,
              surveyId:        surveyId ?? null,
              severity:        (proposal.params.severity as string) || 'warning',
              thresholdConfig: (proposal.params.threshold_config as Record<string, unknown>) || {},
            });
            invalidate('alerts');
            track('succeeded', (created as { rule?: { id?: string } })?.rule?.id);
          } else {
            track('succeeded');
          }
          note(`Alert created: "${proposal.title}". Open Alerts to manage it.`);
          break;
        }
        case 'schedule_rerun': {
          if (!surveyId) { track('failed', undefined, 'no survey in scope'); break; }
          await api.triggerInsightGeneration(surveyId, { trigger: 'manual' });
          invalidate('insights');
          track('succeeded', surveyId);
          note('Insight regeneration triggered. The insights view will refresh when it completes.');
          break;
        }
        case 'view_template': {
          track('succeeded');
          navigate(ROUTES.TEMPLATES);
          break;
        }

        // ── Tier 3 — Closed-Loop Action Platform ──────────────────────────────
        case 'create_case': {
          try {
            const caseData = await api.createCase({
              contact_id:    proposal.params.contact_id as string | undefined,
              response_id:   proposal.params.response_id as string | undefined,
              survey_id:     proposal.params.survey_id as string | undefined,
              insight_id:    proposal.params.insight_id as string | undefined,
              title:         proposal.params.title as string,
              description:   proposal.params.description as string | undefined,
              severity:      proposal.params.severity as string,
              category:      proposal.params.category as string,
              driver_ref:    proposal.params.driver_ref as string | undefined,
              owner_user_id: proposal.params.owner_user_id as string | undefined,
              owner_label:   proposal.params.owner_label as string | undefined,
            } as Parameters<typeof api.createCase>[0]);
            invalidate('cases');
            track('succeeded', caseData.id);
            note(`Case created: "${caseData.title}". Open Cases to track it.`);
          } catch (err) {
            track('failed', undefined, String(err));
            throw err;
          }
          break;
        }
        case 'assign_owner': {
          try {
            await api.updateCase(proposal.params.case_id as string, {
              owner_user_id: proposal.params.owner_user_id as string,
              owner_label:   proposal.params.owner_label as string | undefined,
            } as Parameters<typeof api.updateCase>[1]);
            invalidate('cases');
            track('succeeded', proposal.params.case_id as string);
          } catch (err) {
            track('failed', undefined, String(err));
            throw err;
          }
          break;
        }
        case 'send_slack_alert': {
          // Actual sending happens server-side when the case is created.
          track('succeeded');
          break;
        }

        // ── Insight Pipeline v2 — report proposals (Phase 6) ───────────────────
        case 'view_report':
        case 'trigger_manual_insight_run':
        case 'generate_intelligence_report': {
          const intent = resolveReportProposalAction(proposal, surveyId);
          if (intent.kind === 'navigate') {
            track('succeeded', proposal.params.report_id as string | undefined);
            navigate(intent.url);
          } else if (intent.kind === 'open_dialog') {
            track('succeeded', surveyId);
            setManualRunDialog({ open: true, mode: intent.mode });
          } else {
            track('failed', undefined, intent.reason);
          }
          break;
        }

        default:
          track('failed', undefined, `unhandled proposal type: ${proposal.type}`);
          submitQuery(`Help me with: ${proposal.title}`);
      }
      setActionProposals(prev => prev.filter(p => p.id !== proposal.id));
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      track('failed', undefined, detail);
      note(`Couldn't complete "${proposal.title}": ${detail}`);
    } finally {
      setExecutingAction(null);
    }
  }, [api, executingAction, focusSurvey, navigate, submitQuery, note]);

  // "Ticket" button on a Crystal answer → create a CX case (ticket) from the insight.
  // The click is itself the confirmation gesture, so we run the wired create_case path directly.
  // We capture full diagnostic provenance so the case can be traced back to the exact insight,
  // survey, run, user, and brand that produced it. Only the must-have, queryable refs
  // (survey_id, insight_id) become structured columns; everything else lives in the description,
  // which is persisted in the DB too.
  const handleCreateTicket = useCallback((message: Message) => {
    // Matches the backend's strict RFC-4122 zod .uuid() so a structured ref never 400s the
    // whole case creation. Synthetic citation ids (e.g. "metric.nps") fall through to the
    // description only.
    const isUuid = (v?: string | null): v is string =>
      !!v && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);

    const body = (message.content || '').trim();
    const firstLine = body.split('\n').map((s) => s.trim()).find(Boolean) || '';
    const title = (crystalCtx.focused_topic
      ? `Follow-up: ${crystalCtx.focused_topic}`
      : firstLine || 'Crystal follow-up'
    ).slice(0, 120);

    // Citation ids map to insight_id. Some are synthetic (e.g. "metric.nps"), so keep the full
    // list for the audit trail but only a real UUID can populate the structured insight_id column.
    const citationIds = (message.citations ?? []).map((c) => c.id).filter(Boolean);
    const surveyId  = isUuid(focusSurvey?.id) ? focusSurvey?.id
      : (message.citations ?? []).map((c) => c.survey_id).find(isUuid);
    const insightId = citationIds.find(isUuid);

    const diag = [
      '',
      '———  Diagnostic context (auto-captured)  ———',
      'Source: Crystal insight → Ticket button',
      `Survey: ${focusSurvey?.title ?? '—'}${surveyId ? ` (${surveyId})` : ''}`,
      `Scope: ${scope}`,
      `Topic: ${crystalCtx.focused_topic ?? '—'}`,
      `Insight ID(s): ${citationIds.length ? citationIds.join(', ') : '—'}`,
      `Crystal message ID: ${message.id}`,
      `Confidence: ${message.confidence != null ? message.confidence : '—'}`,
      `Brand: ${brandName ?? '—'}`,
      `Org ID: ${orgId ?? '—'}`,
      `Created by (user ID): ${userId ?? '—'}`,
      `Captured at: ${new Date().toISOString()}`,
      'Run trace: derive run_id from the insight ID via the insights / agent_runs tables.',
    ].join('\n');

    // Preserve the full diagnostic block; truncate the insight body if needed (DB cap 5000).
    const maxBody = Math.max(0, 4998 - diag.length);
    const description = `${body.slice(0, maxBody)}\n${diag}`.slice(0, 5000);

    const proposal: ActionProposal = {
      id:                    `ticket-${message.id}`,
      type:                  'create_case',
      priority:              'medium',
      title,
      description,
      params: {
        title,
        description,
        survey_id:  surveyId,
        insight_id: insightId,
        driver_ref: crystalCtx.focused_topic,
      },
      business_rationale:    'Created from a Crystal insight.',
      confidence:            message.confidence,
      requires_confirmation: true,
    };
    void executeAction(proposal);
  }, [crystalCtx.focused_topic, focusSurvey, scope, brandName, orgId, userId, executeAction]);

  const dismissAction = useCallback((actionId: string) => {
    const proposal = actionProposals.find(p => p.id === actionId);
    setActionProposals(prev => prev.filter(p => p.id !== actionId));
    if (proposal && api.recordProposalOutcome) {
      api.recordProposalOutcome(focusSurvey?.id ?? 'global', {
        proposalKey: proposal.id,
        type:        proposal.type,
        params:      proposal.params,
        priority:    proposal.priority,
        status:      'dismissed',
      }).catch(() => {});
    }
  }, [api, focusSurvey, actionProposals]);

  const handleSubmit = () => {
    if (input.trim()) {
      submitQuery(input.trim());
      setInput('');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const panelWidth = isExpanded
    ? 'calc((100vw - var(--sidebar-width)) * 0.55)'
    : 'calc((100vw - var(--sidebar-width)) * 0.28)';

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Subtle directional shadow on the left edge of the panel — non-interactive */}
          {!isExpanded && (
            <motion.div
              key="crystal-shadow"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.25 }}
              className="fixed z-40 pointer-events-none"
              style={{
                top: '4rem',
                bottom: 0,
                right: 'calc((100vw - var(--sidebar-width)) * 0.28)',
                width: 64,
                background:
                  'linear-gradient(to right, transparent, rgba(42,75,217,0.06) 50%, rgba(42,75,217,0.10))',
              }}
            />
          )}

          {/* Panel */}
          <motion.div
            key="crystal-panel"
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
            className="fixed z-50 flex flex-col"
            style={{
              top: '4rem',
              bottom: 0,
              right: 0,
              width: panelWidth,
              borderLeft: '1px solid rgba(42,75,217,0.18)',
              background: 'var(--surface, #fff)',
              boxShadow: '-8px 0 40px rgba(0,0,0,0.10), -2px 0 8px rgba(42,75,217,0.07)',
              transition: 'width 0.3s cubic-bezier(0.22,1,0.36,1)',
            }}
          >
            {/* ── Header ─────────────────────────────────────────────────── */}
            <div
              className="flex-shrink-0 flex items-center gap-3 px-5 py-3.5 border-b"
              style={{
                borderColor: 'rgba(42,75,217,0.12)',
                background:
                  'linear-gradient(to bottom, rgba(42,75,217,0.035) 0%, transparent 100%)',
              }}
            >
              {/* Crystal gem icon */}
              <div
                className="w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0"
                style={{ background: 'linear-gradient(135deg, #2a4bd9, #8329c8)' }}
              >
                <Icon name="diamond" size={16} style={{ color: 'white' }} />
              </div>

              {/* Title + scope context strip */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 leading-none mb-0.5">
                  <span className="font-black text-sm text-on-surface">Crystal</span>
                  <span
                    className="text-[10px] font-bold px-1.5 py-0.5 rounded-full"
                    style={{ background: 'rgba(42,75,217,0.08)', color: '#2a4bd9' }}
                  >
                    Xperiq Copilot
                  </span>
                  {isSupportMode && (
                    <span
                      className="text-[10px] font-bold px-1.5 py-0.5 rounded-full"
                      style={{ background: 'rgba(245,158,11,0.12)', color: '#b45309' }}
                    >
                      {t('crystal.supportMode')}
                    </span>
                  )}
                </div>
                <div className="text-[10px] text-on-surface-variant truncate">
                  {isAll
                    ? `Ask across ${activeSurveys.length} active survey${activeSurveys.length !== 1 ? 's' : ''}${nps != null ? ` · Portfolio NPS ${nps}` : ''}`
                    : focusSurvey
                      ? `${focusSurvey.title} · ${responseCount.toLocaleString()} responses${nps != null ? ` · NPS ${nps}` : ''}${crystalCtx.focused_topic ? ` · ${crystalCtx.focused_topic}` : ''}`
                      : 'Ask anything about this survey'}
                </div>
              </div>

              {/* Clear conversation */}
              {messages.length > 0 && (
                <button
                  onClick={() => setMessages([])}
                  className="text-[10px] font-bold text-on-surface-variant hover:text-on-surface flex items-center gap-1 px-2 py-1 rounded-lg hover:bg-muted transition-colors"
                  title="Clear conversation"
                >
                  <Icon name="delete_sweep" size={14} />
                  Clear
                </button>
              )}

              {/* Expand / collapse */}
              <button
                onClick={() => setIsExpanded((e) => !e)}
                className="w-8 h-8 rounded-lg flex items-center justify-center text-on-surface-variant hover:bg-primary/10 hover:text-primary transition-colors flex-shrink-0"
                title={isExpanded ? 'Collapse panel' : 'Expand panel'}
              >
                <Icon name={isExpanded ? 'close_fullscreen' : 'open_in_full'} size={16} />
              </button>

              {/* Close */}
              <button
                onClick={closeCrystal}
                className="w-8 h-8 rounded-lg flex items-center justify-center text-on-surface-variant hover:bg-red-50 hover:text-red-500 transition-colors flex-shrink-0"
                title="Close Crystal (⌘K)"
              >
                <Icon name="close" size={16} />
              </button>
            </div>

            {/* ── Agent mode + context strip ────────────────────────────── */}
            <div className="flex-shrink-0 flex items-center gap-2 px-5 py-2 flex-wrap"
              style={{ background: 'rgba(42,75,217,0.04)', borderBottom: '1px solid rgba(42,75,217,0.08)' }}>
              {/* What Crystal is looking at — derived from scope, not hardcoded */}
              <Icon name="diamond" size={11} style={{ color: '#2a4bd9', flexShrink: 0 }} />
              {isAll ? (
                <span className="text-[10px] text-on-surface-variant">
                  {activeSurveys.length > 0
                    ? `${activeSurveys.length} active survey${activeSurveys.length !== 1 ? 's' : ''} · latest reports`
                    : 'Portfolio — no surveys yet'}
                </span>
              ) : (
                <>
                  {focusSurvey && (
                    <span className="text-[10px] font-semibold text-on-surface-variant truncate max-w-[150px]">
                      {focusSurvey.title}
                    </span>
                  )}
                  {crystalCtx.focused_topic && (
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full flex items-center gap-1"
                      style={{ background: '#ecfdf5', color: '#059669' }}>
                      <Icon name="topic" size={10} />
                      {crystalCtx.focused_topic}
                    </span>
                  )}
                  {crystalCtx.window && crystalCtx.window !== 'all_time' && (
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full flex items-center gap-1"
                      style={{ background: '#eef2ff', color: '#4f46e5' }}>
                      <Icon name="schedule" size={10} />
                      {WINDOW_LABELS[crystalCtx.window] ?? crystalCtx.window}
                    </span>
                  )}
                </>
              )}

              <div className="ml-auto flex items-center gap-1.5">
                {/* Return to portfolio — shown when scoped to a survey */}
                {!isAll && (
                  <button
                    className="text-[10px] font-bold flex items-center gap-0.5 px-2 py-0.5 rounded-full transition-colors hover:bg-primary/10"
                    style={{ color: 'var(--color-primary)' }}
                    onClick={() => { setScope('all'); setCrystalCtx({}); }}
                    title="Switch Crystal to portfolio view across all surveys"
                  >
                    <Icon name="corporate_fare" size={10} />
                    Portfolio
                  </button>
                )}
                {/* Clear filters */}
                {!isAll && (crystalCtx.window || crystalCtx.focused_topic) && (
                  <button className="text-[10px] text-on-surface-variant hover:text-on-surface"
                    onClick={() => setCrystalCtx({})}>
                    clear
                  </button>
                )}
              </div>
            </div>

            {/* ── Time window quick-filter ──────────────────────────────── */}
            {!isAll && messages.length === 0 && (
              <div className="flex-shrink-0 flex items-center gap-1.5 px-5 pt-3 pb-0">
                <span className="text-[10px] text-on-surface-variant font-semibold mr-1">Window:</span>
                {(['all_time', '30d', '7d'] as const).map(w => (
                  <button key={w}
                    onClick={() => setCrystalCtx({ ...crystalCtx, window: w })}
                    className="text-[10px] font-bold px-2 py-0.5 rounded-full transition-all"
                    style={{
                      background: (crystalCtx.window ?? 'all_time') === w ? '#4f46e5' : 'rgba(0,0,0,0.06)',
                      color: (crystalCtx.window ?? 'all_time') === w ? '#fff' : '#64748b',
                    }}>
                    {WINDOW_LABELS[w]}
                  </button>
                ))}
              </div>
            )}

            {/* ── Conversation ───────────────────────────────────────────── */}
            <div
              ref={scrollRef}
              className="flex-1 overflow-y-auto overscroll-contain"
              style={{ scrollBehavior: 'smooth' }}
            >
              {messages.length === 0 && !isThinking ? (
                <EmptyState
                  prompts={dynamicPrompts}
                  isAll={isAll}
                  onPromptClick={(p) => submitQuery(p)}
                />
              ) : (
                <div className="px-5 py-5 space-y-5">
                  {messages.map((msg) =>
                    msg.role === 'user' ? (
                      <UserBubble key={msg.id} message={msg} />
                    ) : (
                      <CrystalBubble
                        key={msg.id}
                        message={msg}
                        isAll={isAll}
                        onFollowUp={submitQuery}
                        onPin={handlePin}
                        onThumbsUp={handleThumbsUp}
                        onThumbsDown={handleThumbsDown}
                        onCreateTicket={handleCreateTicket}
                      />
                    ),
                  )}
                  {isThinking && (
                    <CrystalThinkingBubble state={streamingState} isThinking={isThinking} />
                  )}
                  {streamError && !isThinking && (
                    <div className="text-xs text-red-500 px-2">{streamError}</div>
                  )}

                  {/* ── Action proposals — confirm cards (Crystal proposes, app executes) ── */}
                  {actionProposals.length > 0 && !isThinking && (
                    <div className="space-y-2">
                      {actionProposals.map((p) => (
                        <ActionProposalCard
                          key={p.id}
                          proposal={p}
                          isExecuting={executingAction === p.id}
                          onApply={() => executeAction(p)}
                          onDismiss={() => dismissAction(p.id)}
                        />
                      ))}
                    </div>
                  )}

                  {/* ── Support mode: escalation CTA card ─────────────── */}
                  {isSupportMode && escalationPackage && !lastSupportResolved && !isThinking && (
                    <div
                      className="mx-2 my-2 rounded-xl p-3 flex flex-col gap-2"
                      style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)' }}
                    >
                      <div className="flex items-center gap-1.5">
                        <Icon name="support_agent" size={14} style={{ color: '#b45309' }} />
                        <span className="text-xs font-bold" style={{ color: '#b45309' }}>
                          {t('crystal.escalationNeeded')}
                        </span>
                      </div>
                      <p className="text-xs text-on-surface-variant">{escalationPackage.description}</p>
                      <button
                        onClick={async () => {
                          try {
                            await api.createSupportTicket({
                              subject: escalationPackage.description,
                              priority: escalationPackage.priority,
                              description: JSON.stringify(escalationPackage.context),
                            });
                            setEscalationPackage(null);
                          } catch { /* silently ignore */ }
                        }}
                        className="self-start text-xs font-bold px-3 py-1.5 rounded-lg transition-colors"
                        style={{ background: 'rgba(245,158,11,0.15)', color: '#92400e' }}
                      >
                        {t('crystal.createTicket')}
                      </button>
                    </div>
                  )}

                  {/* ── Support mode: thumbs feedback ──────────────────── */}
                  {isSupportMode && messages.length > 0 && !isThinking && (
                    <div className="mx-2 my-1 flex items-center gap-2">
                      {feedbackThanks ? (
                        <span className="text-[10px] text-on-surface-variant">{feedbackThanks}</span>
                      ) : (
                        <>
                          <span className="text-[10px] text-on-surface-variant">{t('support.feedbackHelpful')}</span>
                          <button
                            className="p-1 rounded-lg hover:bg-emerald-50 transition-colors"
                            title={t('crystal.thumbsUp')}
                            onClick={async () => {
                              const lastMsg = messages[messages.length - 1];
                              if (lastMsg.role === 'crystal') {
                                await api.submitDocFeedback({ doc_key: lastMsg.id, helpful: true }).catch(() => {});
                                setFeedbackThanks(t('support.feedbackThanks'));
                              }
                            }}
                          >
                            <Icon name="thumb_up" size={13} />
                          </button>
                          <button
                            className="p-1 rounded-lg hover:bg-red-50 transition-colors"
                            title={t('crystal.thumbsDown')}
                            onClick={async () => {
                              const lastMsg = messages[messages.length - 1];
                              if (lastMsg.role === 'crystal') {
                                await api.submitDocFeedback({ doc_key: lastMsg.id, helpful: false }).catch(() => {});
                                setFeedbackThanks(t('support.feedbackThanks'));
                              }
                            }}
                          >
                            <Icon name="thumb_down" size={13} />
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* ── Input bar ──────────────────────────────────────────────── */}
            <div
              className="flex-shrink-0 px-4 py-3 border-t"
              style={{ borderColor: 'rgba(42,75,217,0.1)' }}
            >
              <div
                className="flex items-end gap-2 p-2 rounded-xl"
                style={{
                  background: 'rgba(42,75,217,0.04)',
                  border: '1px solid rgba(42,75,217,0.14)',
                }}
              >
                <button
                  className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 self-end mb-0.5 hover:bg-primary/10 transition-colors"
                  onClick={handleMic}
                  title={isListening ? 'Stop listening' : 'Speak your question'}
                  style={isListening ? { background: 'rgba(220,38,38,0.1)', color: '#dc2626' } : undefined}
                >
                  <Icon name={isListening ? 'mic_off' : 'mic'} size={18} className={isListening ? '' : 'text-on-surface-variant'} />
                </button>
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => {
                    setInput(e.target.value);
                    // Auto-grow
                    e.target.style.height = 'auto';
                    e.target.style.height = `${Math.min(e.target.scrollHeight, 128)}px`;
                  }}
                  onKeyDown={handleKeyDown}
                  placeholder={
                    isSupportMode
                      ? t('crystal.supportPlaceholder')
                      : isAll
                        ? 'Ask anything across your surveys…'
                        : 'Ask anything about this survey…'
                  }
                  rows={1}
                  className="flex-1 bg-transparent resize-none focus:outline-none text-sm text-on-surface placeholder:text-on-surface-variant/50 py-1.5 px-1 overflow-y-auto"
                  style={{ lineHeight: '1.55', maxHeight: 128 }}
                />
                <Button
                  size="sm"
                  onClick={handleSubmit}
                  disabled={!input.trim() || isThinking}
                  className="flex-shrink-0 font-bold text-white border-0 self-end text-xs"
                  style={{
                    background:
                      !input.trim() || isThinking
                        ? undefined
                        : 'linear-gradient(135deg, #2a4bd9, #8329c8)',
                  }}
                >
                  <Icon name="arrow_upward" size={15} />
                  Ask
                </Button>
              </div>
              <p className="text-[10px] text-on-surface-variant text-center mt-2">
                ⌘K to close · Shift+Enter for new line · Every answer cites real responses
              </p>
            </div>

            {/* Manual-run dialog opened from a Crystal report proposal */}
            {focusSurvey?.id && (
              <ManualRunDialog
                open={manualRunDialog.open}
                onClose={() => setManualRunDialog((s) => ({ ...s, open: false }))}
                surveyId={focusSurvey.id}
                initialMode={manualRunDialog.mode}
                onViewReport={(rid) => {
                  setManualRunDialog((s) => ({ ...s, open: false }));
                  if (rid) navigate(toPath(ROUTES.INSIGHT_REPORT, { surveyId: focusSurvey.id, reportId: rid }));
                }}
                onViewTrail={() => {
                  setManualRunDialog((s) => ({ ...s, open: false }));
                  navigate(toPath(ROUTES.INSIGHT_TRAIL, { surveyId: focusSurvey.id }));
                }}
              />
            )}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

// ── Empty state — shown before any messages ───────────────────────────────────
function EmptyState({
  prompts,
  isAll,
  onPromptClick,
}: {
  prompts: Array<{ icon: string; label: string }>;
  isAll: boolean;
  onPromptClick: (p: string) => void;
}) {
  return (
    <div className="h-full flex flex-col items-center justify-center text-center px-6 py-10">
      <MiniCrystal />
      <div className="text-[10px] font-black uppercase tracking-[0.2em] text-tertiary mb-2 mt-5">
        Crystal · Xperiq Copilot
      </div>
      <p className="font-black text-sm text-on-surface mb-1">
        {isAll ? 'Ask anything across your surveys' : 'Ask anything about this survey'}
      </p>
      <p className="text-xs text-on-surface-variant mb-7 max-w-xs">
        Every answer cites real customer quotes. Numbers come from analytics — not the LLM.
      </p>
      <div className="w-full max-w-sm space-y-2">
        {prompts.map((p) => (
          <button
            key={p.label}
            onClick={() => onPromptClick(p.label)}
            className="w-full text-left px-4 py-3 rounded-xl text-sm font-medium flex items-center gap-3 transition-all hover:bg-primary/8 border border-border/40 hover:border-primary/25 group"
          >
            <Icon name={p.icon} size={16} className="text-primary/70 group-hover:text-primary flex-shrink-0" />
            <span className="flex-1">{p.label}</span>
            <Icon
              name="arrow_forward"
              size={14}
              className="text-on-surface-variant/50 group-hover:text-primary flex-shrink-0 transition-colors"
            />
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Mini Crystal centerpiece (for empty state) ────────────────────────────────
function MiniCrystal() {
  return (
    <>
      <style>{`
        @keyframes spin-crystal-panel {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
      `}</style>
      <div
        className="relative mx-auto"
        style={{
          width: 64,
          height: 64,
          filter: 'drop-shadow(0 8px 20px rgba(42,75,217,0.3))',
        }}
      >
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background:
              'conic-gradient(from 0deg at 50% 50%, #879aff 0%, #d299ff 25%, #82deff 50%, #d299ff 75%, #879aff 100%)',
            clipPath: 'polygon(50% 0%, 100% 30%, 100% 70%, 50% 100%, 0% 70%, 0% 30%)',
            animation: 'spin-crystal-panel 20s linear infinite',
            filter: 'blur(0.5px)',
          }}
        />
        <div
          style={{
            position: 'absolute',
            inset: '20%',
            background:
              'conic-gradient(from 180deg at 50% 50%, #ffffff 0%, #879aff 33%, #d299ff 66%, #ffffff 100%)',
            clipPath: 'polygon(50% 0%, 100% 30%, 100% 70%, 50% 100%, 0% 70%, 0% 30%)',
            animation: 'spin-crystal-panel 10s linear infinite reverse',
            opacity: 0.75,
          }}
        />
        <div
          style={{
            position: 'absolute',
            inset: '38%',
            background: 'radial-gradient(circle, #ffffff, #82deff)',
            borderRadius: '50%',
            filter: 'blur(3px)',
            animation: 'pulse-glow 2.5s ease-in-out infinite',
          }}
        />
      </div>
    </>
  );
}

// ── User message bubble ───────────────────────────────────────────────────────
function UserBubble({ message }: { message: Message }) {
  return (
    <div className="flex justify-end">
      <div
        className="rounded-2xl rounded-br-sm px-4 py-3 max-w-[85%] text-white"
        style={{ background: 'linear-gradient(135deg, #2a4bd9, #8329c8)' }}
      >
        <div className="text-[10px] font-bold uppercase tracking-widest opacity-70 mb-0.5">You</div>
        <div className="text-sm font-medium leading-relaxed">{message.content}</div>
      </div>
    </div>
  );
}

// ── Citation helpers ──────────────────────────────────────────────────────────

// Matches full UUIDs AND the 8-char short form Crystal sometimes emits (first UUID segment).
// Crystal is instructed to use full UUIDs but occasionally abbreviates — handle both.
const UUID_RE = /\b[0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\b/gi;
const FULL_UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/** Resolve a short (8-char) ID to a full UUID from the citationMap. */
function resolveId(id: string, map: CitationMap): string {
  if (map[id]) return id;                              // exact match
  const lower = id.toLowerCase();
  const match = Object.keys(map).find((k) => k.toLowerCase().startsWith(lower));
  return match ?? id;                                  // prefix match or original
}

/** Enrich citation objects with headline / verbatims from the citation map. */
function enrichCitationsFromMap(citations: CrystalCitation[], map: CitationMap): CrystalCitation[] {
  return citations.map((c) => {
    const resolvedId = resolveId(c.id, map);
    const meta = map[resolvedId];
    return meta ? { ...c, id: resolvedId, ...meta } : { ...c, id: resolvedId };
  });
}

/** Build normalised citations from SSE/REST answer payload + citation map. */
function buildCitationsFromAnswer(
  rawCitations: unknown[],
  insightRefs: unknown[] | undefined,
  answerText: string,
  map: CitationMap,
): CrystalCitation[] {
  const normCitations: CrystalCitation[] = rawCitations.map((c) => {
    const base = typeof c === 'string' ? { id: c } : (c as CrystalCitation);
    const resolvedId = resolveId(base.id, map);
    const meta = map[resolvedId];
    return meta ? { ...base, id: resolvedId, ...meta } : { ...base, id: resolvedId };
  });

  const { text: cleanedAnswer, extraIds } = parseInlineCitations(answerText);
  const inlineRefs = (cleanedAnswer.match(/\[[0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\]/gi) ?? [])
    .map((m) => m.slice(1, -1).toLowerCase());

  const existingIds = new Set(normCitations.map((c) => c.id.toLowerCase()));
  const addId = (rawId: string) => {
    const id = resolveId(rawId, map);
    if (existingIds.has(id.toLowerCase())) return;
    const meta = map[id];
    normCitations.push(meta ? { id, ...meta } : { id });
    existingIds.add(id.toLowerCase());
  };

  [...(insightRefs ?? []), ...extraIds, ...inlineRefs]
    .filter((id): id is string => typeof id === 'string' && !!id)
    .forEach((id) => addId(id));

  return normCitations;
}

/**
 * Extracts citation IDs from Crystal's answer text.
 * - Multi-ID blocks "[uuid, uuid, ...]" → strip from text, collect IDs
 * - Single [uuid] or [8chars] refs → left in text for CitedText to render inline
 * Handles both full UUIDs and the 8-char abbreviated form Crystal sometimes emits.
 */
function parseInlineCitations(text: string): { text: string; extraIds: string[] } {
  const extraIds: string[] = [];
  // Strip multi-ID blocks (comma-separated IDs) and collect their IDs
  const cleaned = text.replace(/\[([^\]]*[0-9a-f]{8}[^\]]*,[^\]]*)\]/gi, (_match, inner) => {
    const ids = inner.match(/[0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?/gi) ?? [];
    ids.forEach((id: string) => extraIds.push(id.toLowerCase()));
    return '';
  }).replace(/\s{2,}/g, ' ').trim();
  return { text: cleaned, extraIds: [...new Set(extraIds)] };
}

// ── Citation helpers ─────────────────────────────────────────────────────────
import { Link } from 'react-router-dom';

const LAYER_COLORS: Record<string, string> = {
  prescriptive: '#059669',
  diagnostic:   '#7c3aed',
  predictive:   '#d97706',
  descriptive:  '#2a4bd9',
};

/**
 * Inline citation chip: "[1]" superscript with a hover tooltip showing
 * the source survey name, insight headline, and a navigation link.
 * Keeps answer text clean while still showing provenance on demand.
 */
function InlineCitation({ citation, index }: { citation: CrystalCitation; index: number }) {
  const [open, setOpen] = useState(false);
  const navPath = citation.survey_id
    ? toPath(ROUTES.EXPERIENCE_SURVEY, { surveyId: citation.survey_id })
    : null;
  const displayText = citation.headline || citation.quote;
  const layerColor  = LAYER_COLORS[citation.layer ?? ''] ?? '#64748b';

  return (
    <span className="relative inline-block align-super" style={{ fontSize: '0.65em' }}>
      <button
        className="font-bold px-1 py-0 rounded transition-colors leading-none"
        style={{
          background: open ? 'var(--color-primary)' : 'rgba(42,75,217,0.10)',
          color: open ? 'white' : 'var(--color-primary)',
        }}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        aria-label={`Source ${index + 1}${citation.survey_title ? ': ' + citation.survey_title : ''}`}
      >
        {index + 1}
      </button>
      {open && (
        <div
          className="absolute z-50 bottom-full left-1/2 mb-2 w-56 rounded-xl shadow-xl overflow-hidden"
          style={{
            transform: 'translateX(-50%)',
            background: 'var(--color-surface)',
            border: '1px solid rgba(42,75,217,0.15)',
          }}
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
        >
          {/* Source header */}
          <div className="px-3 py-2" style={{ background: `${layerColor}12`, borderBottom: `1px solid ${layerColor}20` }}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-bold truncate" style={{ color: 'var(--color-on-surface)' }}>
                {citation.survey_title || `Source ${index + 1}`}
              </span>
              {citation.layer && (
                <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded flex-shrink-0"
                  style={{ background: `${layerColor}18`, color: layerColor }}>
                  {citation.layer}
                </span>
              )}
            </div>
          </div>
          {/* Quote / headline */}
          {displayText && (
            <div className="px-3 py-2">
              <p className="text-[11px] text-on-surface leading-snug line-clamp-3">
                &ldquo;{displayText}&rdquo;
              </p>
            </div>
          )}
          {/* First verbatim quote */}
          {citation.verbatims && citation.verbatims[0]?.quote && (
            <div className="px-3 py-1.5 border-t border-outline-variant/15">
              <p className="text-[10px] text-on-surface-variant leading-snug italic line-clamp-2">
                &ldquo;{citation.verbatims[0].quote}&rdquo;
              </p>
            </div>
          )}
          {/* Navigation */}
          {navPath && (
            <div className="px-3 pb-2 flex items-center gap-2">
              <Link to={navPath}
                className="text-[10px] font-bold flex items-center gap-1 hover:underline"
                style={{ color: 'var(--color-primary)' }}>
                View survey <Icon name="arrow_forward" size={9} />
              </Link>
            </div>
          )}
          {!displayText && !navPath && (
            <div className="px-3 py-2">
              <p className="text-[10px] text-on-surface-variant font-mono">{citation.id.slice(-8)}</p>
            </div>
          )}
        </div>
      )}
    </span>
  );
}

/**
 * Renders Crystal's answer text with inline citations replaced by
 * numbered superscripts. Non-UUID text is rendered as-is.
 * Usage: <CitedText content="..." citations={[...]} />
 */
function CitedText({ content, citations }: { content: string; citations: CrystalCitation[] }) {
  if (!citations.length) return <>{content}</>;

  // Build lookup: full UUID → index AND short 8-char prefix → index
  const idToIdx = new Map<string, number>();
  citations.forEach((c, i) => {
    idToIdx.set(c.id.toLowerCase(), i);
    // Also index by first 8 chars for short-form citations like [ba58f64c]
    idToIdx.set(c.id.toLowerCase().slice(0, 8), i);
  });

  // Split on bracketed full UUIDs OR short 8-char hex IDs
  const splitRe = /(\[[0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\])/gi;
  const parts = content.split(splitRe);

  return (
    <>
      {parts.map((part, i) => {
        // Match either full UUID or short ID inside brackets
        const m = part.match(/^\[([0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?)\]$/i);
        if (m) {
          const raw = m[1].toLowerCase();
          // Try exact match first, then prefix match
          const idx = idToIdx.get(raw) ?? idToIdx.get(raw.slice(0, 8));
          if (idx !== undefined) {
            return <InlineCitation key={i} citation={citations[idx]} index={idx} />;
          }
          // Unknown ID — show as plain text rather than breaking layout
          return <span key={i} className="text-on-surface-variant text-xs">[{raw.slice(0, 8)}]</span>;
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}

const SENTIMENT_DOT: Record<string, string> = {
  positive: '#16a34a',
  negative: '#dc2626',
  neutral:  '#94a3b8',
};

/** Smart navigation path based on insight category and available data. */
function insightNavPath(c: CrystalCitation): { label: string; path: string } | null {
  if (!c.survey_id) return null;
  if (c.category === 'voice.topic' && c.topic_name) {
    // Topic insights → topic analysis hub (filters by topic)
    return {
      label: `Explore "${c.topic_name}" in ${c.survey_title || 'survey'}`,
      path: `${toPath(ROUTES.EXPERIENCE_SURVEY_TOPICS, { surveyId: c.survey_id })}?topic=${encodeURIComponent(c.topic_name)}`,
    };
  }
  // All other insights → survey Intelligence page
  return {
    label: `View ${c.survey_title || 'survey'} Intelligence`,
    path: toPath(ROUTES.EXPERIENCE_SURVEY, { surveyId: c.survey_id }),
  };
}

// ── Citation display strategy ─────────────────────────────────────────────────
// Determines what to show in the sources footer based on available context.
// Add new strategies here as Crystal expands to new data domains.
type CitationStrategy =
  | 'responses-only'   // single survey — source is implicit, show verbatims directly
  | 'attributed';      // org/multi-survey — must show which survey each finding is from

function getCitationStrategy(isAll: boolean): CitationStrategy {
  return isAll ? 'attributed' : 'responses-only';
}

// ── Shared verbatim list ──────────────────────────────────────────────────────
function VerbatimList({ verbatims }: { verbatims: CrystalVerbatim[] }) {
  return (
    <div className="space-y-1.5">
      {verbatims.map((v, i) => (
        <div key={i}
          className="px-2.5 py-2 rounded-lg text-[11px] leading-snug"
          style={{
            background: 'var(--color-surface)',
            borderLeft: `3px solid ${SENTIMENT_DOT[v.sentiment ?? 'neutral']}`,
          }}>
          {v.topic && (
            <span className="inline-block text-[9px] font-bold px-1.5 py-0.5 rounded mb-1 mr-1"
              style={{ background: 'rgba(42,75,217,0.08)', color: '#2a4bd9' }}>
              {v.topic}
            </span>
          )}
          <span className="italic text-on-surface">&ldquo;{v.quote}&rdquo;</span>
        </div>
      ))}
    </div>
  );
}

// ── Sources footer ────────────────────────────────────────────────────────────
// Strategy 'responses-only': survey is implied — show responses directly.
// Strategy 'attributed':     show which survey each finding comes from.
// New strategies can be added above and wired here without touching callers.
function SourcesFooter({ citations, isAll }: { citations: CrystalCitation[]; isAll: boolean }) {
  const [expanded,           setExpanded]           = useState(false);
  const [showResponsesFor,   setShowResponsesFor]   = useState<string | null>(null);
  const strategy = getCitationStrategy(isAll);

  const withData = citations.filter((c) => c.headline || (c.verbatims && c.verbatims.length > 0));
  const bare     = citations.filter((c) => !c.headline && (!c.verbatims || !c.verbatims.length));

  if (withData.length === 0 && bare.length === 0) return null;

  // ── responses-only ────────────────────────────────────────────────────────
  if (strategy === 'responses-only') {
    const allVerbatims = withData.flatMap((c) => c.verbatims ?? []);
    if (allVerbatims.length === 0) return null;

    return (
      <div className="mt-2 pt-2 border-t border-outline-variant/15">
        <button
          className="flex items-center gap-1.5 text-[10px] text-on-surface-variant hover:text-on-surface transition-colors w-full text-left mb-1"
          onClick={() => setExpanded((e) => !e)}
        >
          <Icon name="format_quote" size={11} />
          <span className="font-semibold">
            {allVerbatims.length} response{allVerbatims.length !== 1 ? 's' : ''}
          </span>
          <Icon name={expanded ? 'expand_less' : 'expand_more'} size={12} className="ml-auto" />
        </button>
        {expanded && <VerbatimList verbatims={allVerbatims} />}
      </div>
    );
  }

  // ── attributed (org scope) ────────────────────────────────────────────────
  const surveyNames = [...new Set(withData.map((c) => c.survey_title).filter(Boolean))];

  return (
    <div className="mt-2 pt-2 border-t border-outline-variant/15">
      <button
        className="flex items-center gap-1.5 text-[10px] text-on-surface-variant hover:text-on-surface transition-colors w-full text-left"
        onClick={() => setExpanded((e) => !e)}
      >
        <Icon name="library_books" size={11} />
        <span className="font-semibold">
          {withData.length} source{withData.length !== 1 ? 's' : ''}
          {!expanded && surveyNames.length > 0 && (
            <span className="font-normal text-on-surface-variant/70 ml-1">
              — {surveyNames.slice(0, 2).join(', ')}{surveyNames.length > 2 ? '…' : ''}
            </span>
          )}
        </span>
        <Icon name={expanded ? 'expand_less' : 'expand_more'} size={12} className="ml-auto" />
      </button>

      {expanded && (
        <div className="mt-2 space-y-3">
          {withData.map((c, i) => {
            const layerColor   = LAYER_COLORS[c.layer ?? ''] ?? '#64748b';
            const nav          = insightNavPath(c);
            const hasResponses = c.verbatims && c.verbatims.length > 0;
            const showing      = showResponsesFor === c.id;

            return (
              <div key={c.id} className="rounded-xl overflow-hidden border"
                style={{ borderColor: 'rgba(42,75,217,0.10)', background: 'var(--color-surface-container, rgba(0,0,0,0.02))' }}>

                {/* Survey + layer header */}
                <div className="flex items-center gap-2 px-3 py-2"
                  style={{ background: `${layerColor}0c`, borderBottom: `1px solid ${layerColor}18` }}>
                  <span className="text-[10px] font-bold px-1.5 py-0.5 rounded"
                    style={{ background: 'rgba(42,75,217,0.10)', color: '#2a4bd9', minWidth: 18, textAlign: 'center' }}>
                    {i + 1}
                  </span>
                  <span className="text-[10px] font-semibold truncate text-on-surface">
                    {c.survey_title || `Source ${i + 1}`}
                  </span>
                  {c.layer && (
                    <span className="ml-auto text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded flex-shrink-0"
                      style={{ background: `${layerColor}15`, color: layerColor }}>
                      {c.layer}
                    </span>
                  )}
                </div>

                {c.headline && (
                  <p className="px-3 pt-2 pb-1 text-[11px] text-on-surface font-medium leading-snug">
                    {c.headline}
                  </p>
                )}

                {showing && hasResponses && (
                  <div className="px-3 pb-2 mt-1">
                    <VerbatimList verbatims={c.verbatims!} />
                  </div>
                )}

                <div className="flex items-center gap-2 px-3 pb-2 pt-1 flex-wrap">
                  {hasResponses && (
                    <button
                      className="text-[10px] font-bold flex items-center gap-1 px-2.5 py-1 rounded-full transition-colors"
                      style={{
                        background: showing ? 'var(--color-primary)' : 'rgba(42,75,217,0.08)',
                        color: showing ? 'white' : 'var(--color-primary)',
                      }}
                      onClick={() => setShowResponsesFor(showing ? null : c.id)}
                    >
                      <Icon name="format_quote" size={11} />
                      {showing ? 'Hide' : `${c.verbatims!.length} response${c.verbatims!.length !== 1 ? 's' : ''}`}
                    </button>
                  )}
                  {nav && (
                    <Link to={nav.path}
                      className="text-[10px] font-bold flex items-center gap-1 hover:underline ml-auto"
                      style={{ color: 'var(--color-primary)' }}>
                      {nav.label.length > 38 ? nav.label.slice(0, 36) + '…' : nav.label}
                      <Icon name="arrow_forward" size={9} />
                    </Link>
                  )}
                </div>
              </div>
            );
          })}
          {bare.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {bare.map((c) => <CitationChip key={c.id} id={c.id} />)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Crystal answer bubble ─────────────────────────────────────────────────────
function CrystalBubble({
  message,
  isAll,
  onFollowUp,
  onPin,
  onThumbsUp,
  onThumbsDown,
  onCreateTicket,
}: {
  message: Message;
  isAll: boolean;
  onFollowUp: (q: string) => void;
  onPin: (id: string) => void;
  onThumbsUp: (id: string) => void;
  onThumbsDown: (id: string) => void;
  onCreateTicket: (message: Message) => void;
}) {
  return (
    <div className="flex gap-3">
      <div
        className="w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center mt-0.5"
        style={{ background: 'linear-gradient(135deg, #2a4bd9, #8329c8)' }}
      >
        <Icon name="diamond" size={14} style={{ color: 'white' }} />
      </div>
      <GlassCard className="rounded-2xl rounded-bl-sm px-4 py-4 flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-[10px] font-bold uppercase tracking-widest text-tertiary">Crystal</span>
          {message.pinned && (
            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full flex items-center gap-0.5"
              style={{ background: '#eef2ff', color: '#4f46e5' }}>
              <Icon name="push_pin" size={10} fill={1} /> Pinned
            </span>
          )}
          {message.confidence !== undefined && <ConfidenceChip value={message.confidence} />}
        </div>
        {/* Answer text — inline citations rendered as numbered superscripts */}
        <div className="text-sm leading-relaxed mb-3">
          <CitedText content={message.content} citations={message.citations ?? []} />
        </div>

        {/* Insight report document cards (render_hint==='document') */}
        {message.documents && message.documents.length > 0 && (
          <div className="space-y-2 mb-3">
            {message.documents.map((doc, i) => (
              <InsightDocumentCard key={i} doc={doc} />
            ))}
          </div>
        )}

        {/* Sources footer — behaviour adapts to scope */}
        {message.citations && message.citations.length > 0 && (
          <SourcesFooter citations={message.citations} isAll={isAll} />
        )}
        {message.suggestions && message.suggestions.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-3 pt-3 border-t border-outline-variant/20">
            {message.suggestions.map((s) => (
              <button
                key={s}
                onClick={() => onFollowUp(s)}
                className="px-2.5 py-1 rounded-full text-[11px] font-bold border border-primary/30 text-primary hover:bg-primary/5 transition-colors"
              >
                {s}
              </button>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2 mt-3">
          <Button
            size="sm"
            variant={message.pinned ? 'default' : 'outline'}
            className="text-xs"
            onClick={() => onPin(message.id)}
            title={message.pinned ? 'Unpin this response' : 'Pin this response'}
            style={message.pinned ? { background: '#4f46e5', color: '#fff' } : undefined}
          >
            <Icon name="push_pin" size={13} fill={message.pinned ? 1 : 0} />
            {message.pinned ? 'Pinned' : 'Pin'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="text-xs"
            title="Slack integration coming soon"
            onClick={() => {/* Slack integration — not yet connected */}}
          >
            <Icon name="ios_share" size={13} /> Slack
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="text-xs"
            title="Create a case from this insight"
            onClick={() => onCreateTicket(message)}
          >
            <Icon name="flag" size={13} /> Ticket
          </Button>
          <div className="flex-1" />
          <Button
            size="icon"
            variant="ghost"
            className="w-7 h-7"
            onClick={() => onThumbsUp(message.id)}
            title="Good answer"
            style={message.thumbs === 'up' ? { color: '#059669', background: '#d1fae5' } : undefined}
          >
            <Icon name="thumb_up" size={13} fill={message.thumbs === 'up' ? 1 : 0} />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="w-7 h-7"
            onClick={() => onThumbsDown(message.id)}
            title="Needs improvement"
            style={message.thumbs === 'down' ? { color: '#b41340', background: '#fee2e2' } : undefined}
          >
            <Icon name="thumb_down" size={13} fill={message.thumbs === 'down' ? 1 : 0} />
          </Button>
        </div>
      </GlassCard>
    </div>
  );
}

// ── Tool metadata — human labels, icons, accent colours per Crystal tool ──────
const TOOL_META: Record<string, { label: string; icon: string; color: string }> = {
  get_survey_overview:      { label: 'Reading survey overview',        icon: 'analytics',       color: '#2a4bd9' },
  get_topic_details:        { label: 'Exploring topic details',        icon: 'account_tree',    color: '#8329c8' },
  get_metric_history:       { label: 'Pulling metric history',         icon: 'trending_up',     color: '#059669' },
  get_insights_list:        { label: 'Loading AI insights',            icon: 'auto_awesome',    color: '#d97706' },
  get_verbatims:            { label: 'Reading customer voices',        icon: 'format_quote',    color: '#0284c7' },
  get_benchmark_comparison: { label: 'Comparing to benchmarks',        icon: 'leaderboard',     color: '#7c3aed' },
  get_driver_analysis:      { label: 'Analysing experience drivers',   icon: 'hub',             color: '#dc2626' },
  get_segment_breakdown:    { label: 'Breaking down segments',         icon: 'donut_small',     color: '#ea580c' },
  get_checkpoint_history:   { label: 'Reviewing historical trend',     icon: 'history',         color: '#0891b2' },
  compare_surveys:          { label: 'Comparing surveys side-by-side', icon: 'compare',         color: '#9333ea' },
  get_org_portfolio:        { label: 'Scanning your portfolio',        icon: 'corporate_fare',  color: '#2a4bd9' },
  get_cross_survey_themes:  { label: 'Finding shared themes',          icon: 'bubble_chart',    color: '#8329c8' },
  get_anomaly_events:       { label: 'Checking for anomalies',         icon: 'warning',         color: '#dc2626' },
};

type AccumulatedStep = {
  id:          string;
  phase:       'thinking' | 'observation' | 'synthesizing';
  tool?:       string;
  message?:    string;
  summary?:    string;
  startedAt:   number;   // ms since thinking began
  completedAt?: number;  // ms since thinking began
};

// ── Crystal Thinking Bubble — unified loader shown for all thinking phases ────
function CrystalThinkingBubble({
  state,
  isThinking,
}: {
  state: NonNullable<StreamingPhase> | null;
  isThinking: boolean;
}) {
  const [steps, setSteps]         = useState<AccumulatedStep[]>([]);
  const [elapsed, setElapsed]     = useState(0);
  const startRef                  = useRef<number>(Date.now());
  const prevStateRef              = useRef<NonNullable<StreamingPhase> | null>(null);

  // Reset accumulated steps when a new query starts
  useEffect(() => {
    if (isThinking) {
      setSteps([]);
      setElapsed(0);
      startRef.current = Date.now();
      prevStateRef.current = null;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);   // intentionally fires only on mount of this instance

  // Live elapsed counter (100ms tick while thinking)
  useEffect(() => {
    if (!isThinking) return;
    const iv = setInterval(() => setElapsed(Date.now() - startRef.current), 100);
    return () => clearInterval(iv);
  }, [isThinking]);

  // Accumulate steps as streaming events arrive
  useEffect(() => {
    if (!state) return;
    const now = Date.now() - startRef.current;
    const prev = prevStateRef.current;

    // Same tool still thinking — just update message, don't add new step
    if (
      prev &&
      prev.phase === state.phase &&
      (prev as { tool?: string }).tool === (state as { tool?: string }).tool &&
      state.phase === 'thinking'
    ) {
      setSteps((s) =>
        s.map((step, i) =>
          i === s.length - 1 ? { ...step, message: (state as { message?: string }).message } : step,
        ),
      );
      prevStateRef.current = state;
      return;
    }

    setSteps((prev_steps) => {
      // Mark last step complete
      const updated = prev_steps.map((s, i) =>
        i === prev_steps.length - 1 && s.completedAt == null
          ? { ...s, completedAt: now }
          : s,
      );
      // Don't add duplicate synthesizing step
      if (state.phase === 'synthesizing' && updated.some((s) => s.phase === 'synthesizing')) {
        return updated;
      }
      return [
        ...updated,
        {
          id:        crypto.randomUUID(),
          phase:     state.phase,
          tool:      (state as { tool?: string }).tool,
          message:   (state as { message?: string }).message,
          summary:   (state as { summary?: string }).summary,
          startedAt: now,
        },
      ];
    });
    prevStateRef.current = state;
  }, [state]);

  const isSynthesizing = state?.phase === 'synthesizing';
  const totalSteps     = steps.length;
  const doneSteps      = steps.filter((s) => s.completedAt != null).length;

  return (
    <>
      <style>{`
        @keyframes crystal-spin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
        @keyframes crystal-pulse {
          0%, 100% { opacity: 0.85; transform: scale(1); }
          50%       { opacity: 1;    transform: scale(1.08); }
        }
        @keyframes aurora-flow {
          0%   { background-position: 0%   50%; }
          50%  { background-position: 100% 50%; }
          100% { background-position: 0%   50%; }
        }
        @keyframes step-in {
          from { opacity: 0; transform: translateY(6px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes check-pop {
          0%   { transform: scale(0); opacity: 0; }
          60%  { transform: scale(1.3); }
          100% { transform: scale(1); opacity: 1; }
        }
        @keyframes dot-pulse {
          0%, 100% { box-shadow: 0 0 0 0 currentColor; opacity: 0.6; }
          50%       { box-shadow: 0 0 0 4px transparent; opacity: 1; }
        }
        @keyframes shimmer-text {
          0%   { background-position: -200% center; }
          100% { background-position:  200% center; }
        }
      `}</style>

      <div className="flex gap-3">
        {/* Crystal orb — rotates while thinking, pulses while synthesizing */}
        <div className="flex-shrink-0 mt-0.5">
          <div
            style={{
              width: 32, height: 32, position: 'relative',
              filter: `drop-shadow(0 0 8px rgba(42,75,217,${isSynthesizing ? 0.7 : 0.4}))`,
              animation: isSynthesizing
                ? 'crystal-pulse 1.5s ease-in-out infinite'
                : 'crystal-spin 4s linear infinite',
              transition: 'filter 0.6s ease',
            }}
          >
            <div style={{
              position: 'absolute', inset: 0,
              background: 'conic-gradient(from 0deg, #879aff 0%, #d299ff 30%, #82deff 55%, #d299ff 78%, #879aff 100%)',
              clipPath: 'polygon(50% 0%, 100% 30%, 100% 70%, 50% 100%, 0% 70%, 0% 30%)',
            }} />
            <div style={{
              position: 'absolute', inset: '32%',
              background: 'radial-gradient(circle, #fff, #82deff)',
              borderRadius: '50%', filter: 'blur(2px)',
            }} />
          </div>
        </div>

        {/* Step card */}
        <div
          className="flex-1 min-w-0 rounded-2xl rounded-tl-sm overflow-hidden"
          style={{
            background: 'var(--color-surface-container, rgba(255,255,255,0.05))',
            border: '1px solid rgba(42,75,217,0.15)',
          }}
        >
          {/* Header bar — aurora gradient while synthesizing */}
          <div
            className="px-4 py-2.5 flex items-center justify-between"
            style={isSynthesizing ? {
              background: 'linear-gradient(270deg, #2a4bd9, #8329c8, #0284c7, #2a4bd9)',
              backgroundSize: '300% 300%',
              animation: 'aurora-flow 3s ease infinite',
            } : {
              background: 'rgba(42,75,217,0.07)',
              borderBottom: '1px solid rgba(42,75,217,0.09)',
            }}
          >
            <span
              className="text-[10px] font-bold uppercase tracking-widest"
              style={{ color: isSynthesizing ? 'rgba(255,255,255,0.9)' : 'var(--color-primary, #2a4bd9)' }}
            >
              {isSynthesizing
                ? 'Crystal · Writing your answer'
                : steps.length === 0
                  ? 'Crystal · Interpreting'
                  : `Crystal · Reasoning`}
            </span>
            <span
              className="text-[10px] tabular-nums"
              style={{ color: isSynthesizing ? 'rgba(255,255,255,0.6)' : 'var(--color-on-surface-variant, #888)' }}
            >
              {(elapsed / 1000).toFixed(1)}s
            </span>
          </div>

          {/* Steps list */}
          <div className="px-4 py-3 space-y-2.5">
            {steps.length === 0 ? (
              /* Initial state — waiting for first streaming event */
              <div className="flex items-center gap-2.5">
                <div className="flex gap-1">
                  {[0, 1, 2].map((i) => (
                    <div
                      key={i}
                      style={{
                        width: 5, height: 5, borderRadius: '50%',
                        background: 'var(--color-primary, #2a4bd9)',
                        animation: `dot-pulse 1.2s ease-in-out ${i * 0.2}s infinite`,
                      }}
                    />
                  ))}
                </div>
                <span className="text-xs" style={{ color: 'var(--color-on-surface-variant, #888)' }}>
                  Thinking…
                </span>
              </div>
            ) : (
              steps.map((step, idx) => {
                const meta      = step.tool ? TOOL_META[step.tool] : null;
                const isDone    = step.completedAt != null;
                const isActive  = !isDone && idx === steps.length - 1;
                const stepColor = meta?.color ?? (
                  step.phase === 'synthesizing' ? '#2a4bd9' :
                  step.phase === 'observation'  ? '#059669' : '#8329c8'
                );
                const stepDuration = isDone
                  ? ((step.completedAt! - step.startedAt) / 1000).toFixed(1) + 's'
                  : null;
                const label = meta?.label
                  ?? (step.phase === 'synthesizing' ? 'Synthesising answer'
                    : step.phase === 'observation'  ? 'Processing results'
                    : step.message ?? 'Reasoning');

                return (
                  <div
                    key={step.id}
                    className="flex items-start gap-2.5"
                    style={{ animation: 'step-in 0.25s ease both' }}
                  >
                    {/* Step indicator */}
                    <div className="flex-shrink-0 mt-0.5 relative" style={{ width: 14, height: 14 }}>
                      {isDone ? (
                        <div
                          style={{
                            width: 14, height: 14, borderRadius: '50%',
                            background: stepColor,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            animation: 'check-pop 0.3s cubic-bezier(0.34,1.56,0.64,1) both',
                          }}
                        >
                          <svg width="8" height="6" viewBox="0 0 8 6" fill="none">
                            <path d="M1 3l2 2 4-4" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        </div>
                      ) : isActive ? (
                        <div style={{
                          width: 14, height: 14, borderRadius: '50%',
                          border: `2px solid ${stepColor}`,
                          borderTopColor: 'transparent',
                          animation: 'crystal-spin 0.8s linear infinite',
                        }} />
                      ) : (
                        <div style={{
                          width: 14, height: 14, borderRadius: '50%',
                          border: '2px solid rgba(128,128,128,0.25)',
                        }} />
                      )}
                    </div>

                    {/* Step content */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <span
                          className="text-[11px] font-medium leading-tight truncate"
                          style={{
                            color: isDone
                              ? 'var(--color-on-surface-variant, #888)'
                              : isActive
                                ? 'var(--color-on-surface, #111)'
                                : 'var(--color-on-surface-variant, #888)',
                            ...(isActive && !isDone ? {
                              background: `linear-gradient(90deg, ${stepColor}, #8329c8, ${stepColor})`,
                              backgroundSize: '200% auto',
                              WebkitBackgroundClip: 'text',
                              WebkitTextFillColor: 'transparent',
                              animation: 'shimmer-text 2s linear infinite',
                            } : {}),
                          }}
                        >
                          {label}
                        </span>
                        {stepDuration && (
                          <span className="text-[10px] tabular-nums flex-shrink-0"
                            style={{ color: 'var(--color-on-surface-variant, #888)', opacity: 0.65 }}>
                            {stepDuration}
                          </span>
                        )}
                      </div>
                      {/* Observation summary — shows what was found */}
                      {step.summary && (
                        <p className="text-[10px] mt-0.5 line-clamp-1"
                          style={{ color: 'var(--color-on-surface-variant, #888)', opacity: 0.75 }}>
                          {step.summary}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Bottom progress bar — fills as steps complete */}
          {totalSteps > 0 && (
            <div style={{ height: 2, background: 'rgba(42,75,217,0.08)' }}>
              <div
                style={{
                  height: '100%',
                  background: isSynthesizing
                    ? 'linear-gradient(90deg, #2a4bd9, #8329c8, #82deff)'
                    : `linear-gradient(90deg, #2a4bd9, #8329c8)`,
                  backgroundSize: isSynthesizing ? '200% 100%' : '100% 100%',
                  animation: isSynthesizing ? 'aurora-flow 1.5s ease infinite' : undefined,
                  width: isSynthesizing
                    ? '100%'
                    : `${Math.min(100, (doneSteps / Math.max(totalSteps, 1)) * 100)}%`,
                  transition: 'width 0.4s ease',
                }}
              />
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// Removed: StreamingBubble, ThinkingBubble — replaced by CrystalThinkingBubble
// Removed: MiniNPSChart (was hardcoded fake data tied to buildDemoResponse)
// Removed: buildDemoResponse (was returning identical hardcoded text for any unrecognized query)
// Crystal now calls the real /api/insights/:surveyId/crystal endpoint.

// ── ActionProposalCard ─────────────────────────────────────────────────────────
// Renders a single action proposal from Crystal as a confirmation card.
// User must click "Apply" to execute — Crystal never acts autonomously.

// ── Report-proposal dispatch (pure, unit-testable) ─────────────────────────────
// Maps a view_report / trigger_manual_insight_run / generate_intelligence_report
// proposal to a concrete frontend intent: navigate to the report viewer (read-only)
// or open the ManualRunDialog in a given mode (confirm → POST /runs).
export type ReportProposalIntent =
  | { kind: 'navigate'; url: string }
  | { kind: 'open_dialog'; mode: ManualRunMode }
  | { kind: 'noop'; reason: string };

export function resolveReportProposalAction(
  proposal: ActionProposal,
  surveyId: string | undefined,
): ReportProposalIntent {
  if (proposal.type === 'view_report') {
    const url = proposal.params.url as string | undefined;
    const reportId = proposal.params.report_id as string | undefined;
    if (url) return { kind: 'navigate', url };
    if (surveyId && reportId) {
      return { kind: 'navigate', url: toPath(ROUTES.INSIGHT_REPORT, { surveyId, reportId }) };
    }
    return { kind: 'noop', reason: 'view_report missing url and report id' };
  }
  if (!surveyId) return { kind: 'noop', reason: 'no survey in scope' };
  if (proposal.type === 'trigger_manual_insight_run') {
    const raw = String(proposal.params.mode ?? 'expert');
    const mode: ManualRunMode =
      raw.includes('quick') ? 'quick' : raw.includes('refresh') ? 'refresh' : 'expert';
    return { kind: 'open_dialog', mode };
  }
  // generate_intelligence_report → Expert mode (confirm shows estimated credits).
  return { kind: 'open_dialog', mode: 'expert' };
}

const ACTION_TYPE_ICONS: Record<string, string> = {
  create_survey:          'add_circle',
  create_followup_survey: 'add_circle',
  edit_survey:            'edit',
  edit_survey_questions:  'edit',
  distribute:             'send',
  distribute_to_segment:  'send',
  workflow:               'settings_automation',
  create_workflow:        'settings_automation',
  create_alert:           'notifications_active',
  schedule_rerun:         'refresh',
  export_insights:        'download',
  view_template:          'library_books',
  template:               'library_books',
  // Tier 3
  create_case:            'work',
  assign_owner:           'person_check',
  send_slack_alert:       'chat',
  // Insight Pipeline v2 — report proposals
  view_report:                'description',
  trigger_manual_insight_run: 'auto_awesome',
  generate_intelligence_report: 'auto_awesome',
};

const PRIORITY_COLORS: Record<string, string> = {
  critical: '#dc2626',
  high:     '#d97706',
  medium:   '#2a4bd9',
  low:      '#6b7280',
};

const PARAM_LABELS: Record<string, string> = {
  alert_type: 'Alert type', threshold_config: 'Threshold', severity: 'Severity',
  metric: 'Metric', condition: 'Trigger', name: 'Name', trigger: 'Trigger',
  action_type: 'Action', intent: 'Goal', survey_type: 'Survey type',
  audience: 'Audience', channel: 'Channel', message: 'Change',
  title: 'Title', category: 'Category', owner_label: 'Assigned to',
  driver_ref: 'Driver', evidence_count: 'Supporting verbatims',
};

function humanizeParams(params: Record<string, unknown>): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = [];
  for (const [k, v] of Object.entries(params || {})) {
    if (v == null || v === '' || k === 'survey_id' || k === 'contact_id' || k === 'response_id') continue;
    let value: string;
    if (typeof v === 'object') {
      const entries = Object.entries(v as Record<string, unknown>);
      if (entries.length === 0) continue;
      value = entries.map(([kk, vv]) => `${kk}: ${vv}`).join(', ');
    } else {
      value = String(v);
    }
    const label = PARAM_LABELS[k] ?? k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    out.push({ label, value: value.slice(0, 120) });
  }
  return out;
}

export function ActionProposalCard({
  proposal,
  isExecuting,
  onApply,
  onDismiss,
}: {
  proposal: ActionProposal;
  isExecuting: boolean;
  onApply: () => void;
  onDismiss: () => void;
}) {
  const iconName    = ACTION_TYPE_ICONS[proposal.type] ?? 'auto_fix_high';
  const priorityClr = PRIORITY_COLORS[proposal.priority] ?? '#2a4bd9';
  const ctaLabel    = proposal.cta_label ?? (proposal.type === 'create_case' ? 'Create Case' : 'Apply');
  const willDo      = humanizeParams(proposal.params || {});
  const [showDetails, setShowDetails] = useState(false);

  return (
    <div
      style={{
        background:   'rgba(42,75,217,0.04)',
        border:       `1px solid ${priorityClr}30`,
        borderRadius: '0.75rem',
        padding:      '0.75rem',
        position:     'relative',
      }}
    >
      {/* Priority badge */}
      {proposal.priority !== 'medium' && (
        <span
          style={{
            position:      'absolute',
            top:           '0.5rem',
            right:         '0.5rem',
            fontSize:      '0.6rem',
            fontWeight:    700,
            color:         priorityClr,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}
        >
          {proposal.priority}
        </span>
      )}

      <div className="flex items-start gap-3">
        {/* Icon */}
        <div
          style={{
            width:           32,
            height:          32,
            borderRadius:    '0.5rem',
            background:      `${priorityClr}15`,
            display:         'flex',
            alignItems:      'center',
            justifyContent:  'center',
            flexShrink:      0,
          }}
        >
          <span className="material-symbols-outlined" style={{ fontSize: 16, color: priorityClr }}>
            {iconName}
          </span>
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <p style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--color-on-surface, #1a1a2e)', marginBottom: '0.2rem' }}>
            {proposal.title}
          </p>
          <p style={{ fontSize: '0.75rem', color: 'var(--color-on-surface-variant, #666)', lineHeight: 1.4 }}>
            {proposal.description}
          </p>

          {/* create_case specifics */}
          {proposal.type === 'create_case' && (
            <div style={{ marginTop: '0.5rem', display: 'flex', flexWrap: 'wrap', gap: '0.3rem' }}>
              {!!proposal.params.severity && (
                <span style={{ fontSize: '0.65rem', fontWeight: 700, padding: '0.15rem 0.5rem', borderRadius: 99, background: `${priorityClr}15`, color: priorityClr }}>
                  {String(proposal.params.severity).toUpperCase()}
                </span>
              )}
              {!!proposal.params.owner_label && (
                <span style={{ fontSize: '0.65rem', fontWeight: 700, padding: '0.15rem 0.5rem', borderRadius: 99, background: 'rgba(0,100,124,0.1)', color: '#00647c' }}>
                  → {String(proposal.params.owner_label)}
                </span>
              )}
              {!!proposal.params.driver_ref && (
                <span style={{ fontSize: '0.65rem', padding: '0.15rem 0.5rem', borderRadius: 99, background: 'rgba(131,41,200,0.1)', color: '#8329c8' }}>
                  {String(proposal.params.driver_ref)}
                </span>
              )}
              {!!proposal.params.evidence_count && (
                <span style={{ fontSize: '0.65rem', padding: '0.15rem 0.5rem', borderRadius: 99, background: 'rgba(107,114,128,0.08)', color: '#6b7280' }}>
                  {Number(proposal.params.evidence_count)} verbatims
                </span>
              )}
            </div>
          )}

          {/* Details toggle */}
          {willDo.length > 0 && (
            <button
              onClick={() => setShowDetails(!showDetails)}
              style={{ marginTop: '0.4rem', fontSize: '0.7rem', color: priorityClr, textDecoration: 'underline', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
            >
              {showDetails ? 'Hide details' : 'What will happen'}
            </button>
          )}

          {showDetails && (
            <div style={{ marginTop: '0.4rem', padding: '0.5rem', background: `${priorityClr}08`, borderRadius: '0.5rem' }}>
              {willDo.map(({ label, value }) => (
                <div key={label} style={{ fontSize: '0.7rem', display: 'flex', gap: '0.3rem', marginBottom: '0.15rem' }}>
                  <span style={{ color: 'var(--color-on-surface-variant, #888)', flexShrink: 0 }}>{label}:</span>
                  <span style={{ color: 'var(--color-on-surface, #111)', fontWeight: 500 }}>{value}</span>
                </div>
              ))}
            </div>
          )}

          {/* Action buttons */}
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.6rem' }}>
            <button
              onClick={onApply}
              disabled={isExecuting}
              style={{
                fontSize:       '0.7rem',
                fontWeight:     700,
                padding:        '0.35rem 0.8rem',
                borderRadius:   '0.5rem',
                background:     isExecuting ? '#dfe3e6' : priorityClr,
                color:          '#fff',
                border:         'none',
                cursor:         isExecuting ? 'not-allowed' : 'pointer',
                display:        'flex',
                alignItems:     'center',
                gap:            '0.3rem',
                transition:     'opacity 0.15s',
              }}
            >
              {isExecuting ? (
                <span style={{ width: 12, height: 12, borderRadius: '50%', border: '2px solid rgba(255,255,255,0.4)', borderTopColor: '#fff', display: 'inline-block', animation: 'crystal-spin 0.8s linear infinite' }} />
              ) : null}
              {ctaLabel}
            </button>
            <button
              onClick={onDismiss}
              style={{ fontSize: '0.7rem', color: 'var(--color-on-surface-variant, #888)', background: 'none', border: 'none', cursor: 'pointer', padding: '0.35rem 0.4rem' }}
            >
              Dismiss
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

