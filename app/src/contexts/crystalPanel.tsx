import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import type { SurveyScope } from '../components/SurveyScopePicker';
import type { AgenticInsight, SurveyTopic } from '../types';

export interface CrystalCtx {
  window?: 'all_time' | '30d' | '7d';
  focused_topic?: string;
  // Tag Report pages inject these so Crystal automatically scopes to the tag
  // being viewed, without touching `scope`/`SurveyScope` (survey_id | 'all').
  focused_tag_id?: string;
  focused_tag_name?: string;
}

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
});

export function CrystalPanelProvider({ children }: { children: ReactNode }) {
  const [isOpen,          setIsOpen]          = useState(false);
  const [initialQuery,    setInitialQuery]    = useState('');
  const [scope,           setScope]           = useState<SurveyScope>('all');
  const [crystalCtx,      setCrystalCtx]      = useState<CrystalCtx>({});
  const [agenticInsights, setAgenticInsights] = useState<AgenticInsight[]>([]);
  const [topics,          setTopics]          = useState<SurveyTopic[]>([]);

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
      }}
    >
      {children}
    </CrystalPanelContext.Provider>
  );
}

export function useCrystalPanel() {
  return useContext(CrystalPanelContext);
}
