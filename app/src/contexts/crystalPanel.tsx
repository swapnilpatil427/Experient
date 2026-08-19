import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import type { SurveyScope } from '../components/SurveyScopePicker';
import type { AgenticInsight, SurveyTopic, ActionProposal } from '../types';
import type { Recommendation } from '../lib/api';

export interface CrystalCtx {
  window?: 'all_time' | '30d' | '7d';
  focused_topic?: string;
  // Tag Report pages inject these so Crystal automatically scopes to the tag
  // being viewed, without touching `scope`/`SurveyScope` (survey_id | 'all').
  focused_tag_id?: string;
  focused_tag_name?: string;
  // Org Dashboard's "Ask a follow-up" (CrystalBriefCard / WeeklyBriefTeaserCard)
  // grounds the chat in the specific brief being viewed — threaded through to
  // the streaming request body as `brief_id`. `openCrystal(query, ctx)` replaces
  // `crystalCtx` wholesale; omitting `ctx` clears any prior grounding fields.
  focused_brief_id?: string;
}

// Wave 14 (docs/automation-hub/WAVE14_UNIFIED_BUILDER_SPEC.md §3.1) — a
// flat, already-human-readable summary of the builder's in-progress draft
// (not the raw EngineNode[]/EngineEdge[] graph), reusing the same display
// strings already computed for the sentence's own pills
// (triggerPillLabel/actionLabel()/scopePillLabel — WorkflowBuilderPage.tsx).
export interface BuilderDraftSummary {
  mode: 'sentence' | 'canvas';
  triggerType?: string;
  scopeSelection: { scopeType: 'org' | 'survey' | 'tag'; scopeSurveyId?: string; scopeTagId?: string; surveyName?: string; tagName?: string };
  conditionClauses: Array<{ field: string; op: string; value: string }>;
  actions: Array<{ action: string; label: string }>;
  workflowName: string;
  isEditMode: boolean;
}

// Additive union member — a NEW exported type, distinct from the existing
// `scope: SurveyScope` field's declared type. Not currently used to type the
// `scope` field itself (see `builderContext` below, kept as a separate sibling
// flag instead of folding this into `scope`'s type — a smaller, more surgical
// diff that avoids touching every existing `scope === 'all'` comparison
// already sprinkled through CrystalPanel.tsx).
export type PanelScope = SurveyScope | { kind: 'workflow_builder' };

// Phase A (survey-builder convergence) — SurveyBuilderPage.tsx converges onto
// this same `builderContext` field, following the exact Wave 14 pattern the two
// workflow-builder pages already use. Unlike `workflow_builder` (whose entire
// chat is a normal Crystal conversation — the page only ever intercepts the
// RESULTING `create_workflow` proposal via `builderDraftHydrator`), the survey
// builder's chat used to be a fully separate, deterministic instant-apply
// editor (XperiqCopilot's `onRefine`/`onApplyRecommendation` props, calling the
// Copilot agent directly). That determinism is deliberately preserved, not
// routed through Crystal's own conversation (which cannot guarantee every
// imperative edit instruction gets recognized as an `edit_survey` proposal) —
// see `builderChatHandler`/`builderRecommendationHandler` below.
export type BuilderContext = { kind: 'workflow_builder' } | { kind: 'survey_builder' };

interface CrystalPanelContextValue {
  isOpen:         boolean;
  initialQuery:   string;
  crystalCtx:     CrystalCtx;
  scope:          SurveyScope;
  // Page-injected data — set by pages that load agentic insights / topics
  agenticInsights: AgenticInsight[];
  topics:          SurveyTopic[];
  openCrystal:     (query?: string, ctx?: CrystalCtx) => void;
  closeCrystal:    () => void;
  toggleCrystal:   () => void;
  setScope:        (scope: SurveyScope) => void;
  setCrystalCtx:   (ctx: CrystalCtx) => void;
  // Inject page-level insight / topic data so the global panel is always context-aware
  setCrystalData:  (agenticInsights: AgenticInsight[], topics: SurveyTopic[]) => void;
  // Wave 14 — orthogonal "what kind of page is this" flag, set by the
  // Automation Hub builder pages on mount/unmount. Not a survey scope, so it
  // doesn't touch the `scope`/`setScope` contract above at all.
  builderContext:         BuilderContext | null;
  builderDraft:            BuilderDraftSummary | null;
  builderDraftHydrator:    ((proposal: ActionProposal) => boolean) | null;
  setBuilderContext:       (ctx: BuilderContext | null) => void;
  setBuilderDraft:         (draft: BuilderDraftSummary | null) => void;
  setBuilderDraftHydrator: (hydrator: ((proposal: ActionProposal) => boolean) | null) => void;

  // ── Survey-builder convergence (Phase A) ──────────────────────────────────
  // Mirrors builderDraftHydrator's registered-callback pattern exactly, for
  // the two survey-editing affordances XperiqCopilot used to own directly.
  // All four are `null` everywhere except while SurveyBuilderPage is mounted —
  // a strict no-op for every other Crystal conversation.
  //
  // Free-text chat: called instead of Crystal's normal SSE conversation when
  // registered — wraps SurveyBuilderPage's existing `handleAiCommand`, which is
  // unchanged and still calls the Copilot agent (api.copilotRefine/api.refineSurvey)
  // directly; only the chat chassis changed, not this business logic.
  builderChatHandler: ((message: string, history: Array<{ role: 'user' | 'assistant'; content: string }>) => Promise<Record<string, unknown>>) | null;
  setBuilderChatHandler: (handler: ((message: string, history: Array<{ role: 'user' | 'assistant'; content: string }>) => Promise<Record<string, unknown>>) | null) => void;

  // Applies a Copilot-refined question list to the builder's own local state
  // in place. Needed because CrystalPanel's existing edit_survey/
  // edit_survey_questions proposal handler navigates to the same builder
  // route with new `location.state` — a no-op if that route is already
  // mounted (SurveyBuilderPage only reads `location.state` once, via useState
  // initializers).
  builderQuestionsHydrator: ((questions: unknown[]) => void) | null;
  setBuilderQuestionsHydrator: (hydrator: ((questions: unknown[]) => void) | null) => void;

  // Recommendation cards (label/reason/priority/cta) seeded from the agents
  // pipeline at survey-creation time — injected once into CrystalPanel's own
  // actionProposals tray (rendered via ActionProposalCard, type
  // 'apply_recommendation') rather than a bespoke card in ExperientCopilot.tsx.
  builderRecommendations: Recommendation[] | null;
  setBuilderRecommendations: (recs: Recommendation[] | null) => void;

  // Executes a recommendation action — wraps SurveyBuilderPage's existing
  // `handleApplyRecommendation` (api.applyRecommendation), called from
  // executeAction's new 'apply_recommendation' case.
  builderRecommendationHandler: ((action: string) => Promise<{ recommendations?: Recommendation[]; message?: string; compliance_risk?: string } | void>) | null;
  setBuilderRecommendationHandler: (handler: ((action: string) => Promise<{ recommendations?: Recommendation[]; message?: string; compliance_risk?: string } | void>) | null) => void;
}

const CrystalPanelContext = createContext<CrystalPanelContextValue>({
  isOpen: false,
  initialQuery: '',
  crystalCtx: {},
  scope: 'all',
  agenticInsights: [],
  topics: [],
  openCrystal: () => {},
  closeCrystal: () => {},
  toggleCrystal: () => {},
  setScope: () => {},
  setCrystalCtx: () => {},
  setCrystalData: () => {},
  builderContext: null,
  builderDraft: null,
  builderDraftHydrator: null,
  setBuilderContext: () => {},
  setBuilderDraft: () => {},
  setBuilderDraftHydrator: () => {},
  builderChatHandler: null,
  setBuilderChatHandler: () => {},
  builderQuestionsHydrator: null,
  setBuilderQuestionsHydrator: () => {},
  builderRecommendations: null,
  setBuilderRecommendations: () => {},
  builderRecommendationHandler: null,
  setBuilderRecommendationHandler: () => {},
});

export function CrystalPanelProvider({ children }: { children: ReactNode }) {
  const [isOpen,          setIsOpen]          = useState(false);
  const [initialQuery,    setInitialQuery]    = useState('');
  const [scope,           setScope]           = useState<SurveyScope>('all');
  const [crystalCtx,      setCrystalCtx]      = useState<CrystalCtx>({});
  const [agenticInsights, setAgenticInsights] = useState<AgenticInsight[]>([]);
  const [topics,          setTopics]          = useState<SurveyTopic[]>([]);
  const [builderContext,      setBuilderContext]      = useState<BuilderContext | null>(null);
  const [builderDraft,        setBuilderDraft]        = useState<BuilderDraftSummary | null>(null);
  const [builderDraftHydrator, setBuilderDraftHydratorState] = useState<((proposal: ActionProposal) => boolean) | null>(null);
  const [builderChatHandler, setBuilderChatHandlerState] = useState<((message: string, history: Array<{ role: 'user' | 'assistant'; content: string }>) => Promise<Record<string, unknown>>) | null>(null);
  const [builderQuestionsHydrator, setBuilderQuestionsHydratorState] = useState<((questions: unknown[]) => void) | null>(null);
  const [builderRecommendations, setBuilderRecommendations] = useState<Recommendation[] | null>(null);
  const [builderRecommendationHandler, setBuilderRecommendationHandlerState] = useState<((action: string) => Promise<{ recommendations?: Recommendation[]; message?: string; compliance_risk?: string } | void>) | null>(null);

  // Stored function, not a lazy-init/functional updater — useState's setter
  // treats a bare function argument as `(prev) => next`, which would invoke
  // the hydrator instead of storing it. Always pass the functional-updater
  // form so the hydrator itself is what lands in state.
  const setBuilderDraftHydrator = useCallback((hydrator: ((proposal: ActionProposal) => boolean) | null) => {
    setBuilderDraftHydratorState(() => hydrator);
  }, []);

  // Same bare-function-vs-updater pitfall as setBuilderDraftHydrator above.
  const setBuilderChatHandler = useCallback((handler: ((message: string, history: Array<{ role: 'user' | 'assistant'; content: string }>) => Promise<Record<string, unknown>>) | null) => {
    setBuilderChatHandlerState(() => handler);
  }, []);

  const setBuilderQuestionsHydrator = useCallback((hydrator: ((questions: unknown[]) => void) | null) => {
    setBuilderQuestionsHydratorState(() => hydrator);
  }, []);

  const setBuilderRecommendationHandler = useCallback((handler: ((action: string) => Promise<{ recommendations?: Recommendation[]; message?: string; compliance_risk?: string } | void>) | null) => {
    setBuilderRecommendationHandlerState(() => handler);
  }, []);

  const openCrystal = useCallback((query = '', ctx?: CrystalCtx) => {
    setInitialQuery(query);
    // Replace wholesale — omitting `ctx` clears any prior focused_brief_id /
    // focused_topic / tag scoping so a generic open doesn't inherit stale grounding.
    setCrystalCtx(ctx ?? {});
    setIsOpen(true);
  }, []);

  const closeCrystal  = useCallback(() => setIsOpen(false), []);
  const toggleCrystal = useCallback(() => setIsOpen((prev) => !prev), []);

  const setCrystalData = useCallback((ai: AgenticInsight[], tp: SurveyTopic[]) => {
    setAgenticInsights(ai);
    setTopics(tp);
  }, []);

  return (
    <CrystalPanelContext.Provider
      value={{
        isOpen, initialQuery, crystalCtx, scope, agenticInsights, topics,
        openCrystal, closeCrystal, toggleCrystal, setScope, setCrystalCtx, setCrystalData,
        builderContext, builderDraft, builderDraftHydrator,
        setBuilderContext, setBuilderDraft, setBuilderDraftHydrator,
        builderChatHandler, setBuilderChatHandler,
        builderQuestionsHydrator, setBuilderQuestionsHydrator,
        builderRecommendations, setBuilderRecommendations,
        builderRecommendationHandler, setBuilderRecommendationHandler,
      }}
    >
      {children}
    </CrystalPanelContext.Provider>
  );
}

export function useCrystalPanel() {
  return useContext(CrystalPanelContext);
}
