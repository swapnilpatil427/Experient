import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import type { SurveyScope } from '../components/SurveyScopePicker';
import type { AgenticInsight, SurveyTopic, ActionProposal } from '../types';

export interface CrystalCtx {
  window?: 'all_time' | '30d' | '7d';
  focused_topic?: string;
  // Tag Report pages inject these so Crystal automatically scopes to the tag
  // being viewed, without touching `scope`/`SurveyScope` (survey_id | 'all').
  focused_tag_id?: string;
  focused_tag_name?: string;
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
  builderContext:         { kind: 'workflow_builder' } | null;
  builderDraft:            BuilderDraftSummary | null;
  builderDraftHydrator:    ((proposal: ActionProposal) => boolean) | null;
  setBuilderContext:       (ctx: { kind: 'workflow_builder' } | null) => void;
  setBuilderDraft:         (draft: BuilderDraftSummary | null) => void;
  setBuilderDraftHydrator: (hydrator: ((proposal: ActionProposal) => boolean) | null) => void;
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
});

export function CrystalPanelProvider({ children }: { children: ReactNode }) {
  const [isOpen,          setIsOpen]          = useState(false);
  const [initialQuery,    setInitialQuery]    = useState('');
  const [scope,           setScope]           = useState<SurveyScope>('all');
  const [crystalCtx,      setCrystalCtx]      = useState<CrystalCtx>({});
  const [agenticInsights, setAgenticInsights] = useState<AgenticInsight[]>([]);
  const [topics,          setTopics]          = useState<SurveyTopic[]>([]);
  const [builderContext,      setBuilderContext]      = useState<{ kind: 'workflow_builder' } | null>(null);
  const [builderDraft,        setBuilderDraft]        = useState<BuilderDraftSummary | null>(null);
  const [builderDraftHydrator, setBuilderDraftHydratorState] = useState<((proposal: ActionProposal) => boolean) | null>(null);

  // Stored function, not a lazy-init/functional updater — useState's setter
  // treats a bare function argument as `(prev) => next`, which would invoke
  // the hydrator instead of storing it. Always pass the functional-updater
  // form so the hydrator itself is what lands in state.
  const setBuilderDraftHydrator = useCallback((hydrator: ((proposal: ActionProposal) => boolean) | null) => {
    setBuilderDraftHydratorState(() => hydrator);
  }, []);

  const openCrystal = useCallback((query = '', ctx?: CrystalCtx) => {
    setInitialQuery(query);
    if (ctx) setCrystalCtx(ctx);
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
      }}
    >
      {children}
    </CrystalPanelContext.Provider>
  );
}

export function useCrystalPanel() {
  return useContext(CrystalPanelContext);
}
