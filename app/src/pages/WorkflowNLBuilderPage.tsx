import { useState, useRef, useEffect, useCallback, lazy, Suspense, type ReactNode } from 'react';
import { motion, type Variants } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from '../lib/i18n';
import { useSetPageTitle } from '../contexts/pageTitle';
import { useApi } from '../hooks/useApi';
import { invalidate } from '../lib/dataBus';
import { PageHeader } from '../components/PageHeader';
import { Icon } from '../components/Icon';
import { ROUTES } from '../constants/routes';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { ParseWorkflowNLError, type ParseWorkflowNLResult } from '../lib/api';
import type { EngineNode } from '../lib/workflowCanvas';

// Lazy-loaded exactly like HeroCanvas — never a direct top-level import, so
// Three.js stays out of this page's main chunk. Small (~96px) ambient 3D
// accent shown only during the thinking state (BUILDER_SPEC_WAVE2.md §3a).
const NLThinkingCrystal = lazy(() =>
  import('../components/three/NLThinkingCrystal').then((m) => ({ default: m.NLThinkingCrystal }))
);

const NL_TIMEOUT_MS = 20000;
const LOW_CONFIDENCE_THRESHOLD = 0.6;
const HIGH_CONFIDENCE_THRESHOLD = 0.85;
const THINKING_SLOW_MS = 8000;

interface Trigger { type: string; label: string; category: string }
interface ActionDef { action: string; label: string; category: string }

type ViewState =
  | { kind: 'input' }
  | { kind: 'thinking' }
  | { kind: 'confirm'; result: ParseWorkflowNLResult; warnings: string[] }
  | { kind: 'low-confidence'; result: ParseWorkflowNLResult; warnings: string[] }
  | { kind: 'unparseable'; message: string; suggestions: string[] }
  | { kind: 'timeout' };

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

export function WorkflowNLBuilderPage() {
  const { t } = useTranslation();
  useSetPageTitle(t('workflows.nlBuilder.title'));
  const api = useApi();
  const navigate = useNavigate();

  const [description, setDescription] = useState('');
  const [view, setView] = useState<ViewState>({ kind: 'input' });
  const [thinkingSlow, setThinkingSlow] = useState(false);
  const [triggers, setTriggers] = useState<Trigger[]>([]);
  const [actionDefs, setActionDefs] = useState<ActionDef[]>([]);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const slowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const examples = t('workflows.nlBuilder.examples') as unknown as string[];

  useEffect(() => {
    api.getWorkflowRegistry().then((r) => {
      setTriggers(r.triggers as Trigger[]);
      setActionDefs(r.actions as ActionDef[]);
    }).catch(() => {});
  }, [api]);

  // Cancel any in-flight request on unmount so a stale response can't resolve
  // after the user has left and trigger a state update on an unmounted page.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      if (slowTimerRef.current) clearTimeout(slowTimerRef.current);
    };
  }, []);

  const thinking = view.kind === 'thinking';

  const generate = useCallback(async () => {
    if (!description.trim() || thinking) return;
    // Synchronous state update before the async call starts — a second click
    // can't race in and fire a second request.
    setView({ kind: 'thinking' });
    setThinkingSlow(false);

    const controller = new AbortController();
    abortRef.current = controller;
    const clientTimeout = setTimeout(() => controller.abort(), NL_TIMEOUT_MS);
    slowTimerRef.current = setTimeout(() => { if (mountedRef.current) setThinkingSlow(true); }, THINKING_SLOW_MS);

    try {
      const result = await api.parseWorkflowNL(description.trim(), controller.signal);
      if (!mountedRef.current) return;

      // Registry drift — the API referenced a trigger/action type not present in
      // the current registry catalog. Render defensively rather than crash, and
      // flag it with a warning if the API didn't already.
      const driftWarnings: string[] = [];
      const knownTrigger = triggers.some((tr) => tr.type === result.triggerType);
      if (!knownTrigger && result.triggerType) {
        driftWarnings.push(t('workflows.nlBuilder.registryDriftWarning', { type: result.triggerType }));
      }
      for (const n of result.nodes ?? []) {
        if (n.type === 'action' && n.action && !actionDefs.some((a) => a.action === n.action)) {
          driftWarnings.push(t('workflows.nlBuilder.registryDriftWarning', { type: n.action }));
        }
      }
      const warnings = [...(result.warnings ?? []), ...driftWarnings];

      if (result.confidence < LOW_CONFIDENCE_THRESHOLD) {
        setView({ kind: 'low-confidence', result, warnings });
      } else {
        setView({ kind: 'confirm', result, warnings });
      }
    } catch (err) {
      if (!mountedRef.current) return;
      if (err instanceof ParseWorkflowNLError) {
        if (err.code === 'ABORTED') {
          // Could be the 20s client timeout or navigate-away; navigate-away
          // unmounts before this runs (mountedRef guards it), so a resolved
          // ABORTED here is always the client-side timeout.
          setView({ kind: 'timeout' });
        } else if (err.code === 'UNPARSEABLE') {
          setView({ kind: 'unparseable', message: err.message, suggestions: err.suggestions ?? [] });
        } else if (err.code === 'TIMEOUT') {
          setView({ kind: 'timeout' });
        } else {
          setView({ kind: 'unparseable', message: err.message, suggestions: [] });
        }
      } else {
        setView({ kind: 'unparseable', message: err instanceof Error ? err.message : 'Failed to parse workflow', suggestions: [] });
      }
    } finally {
      clearTimeout(clientTimeout);
      if (slowTimerRef.current) clearTimeout(slowTimerRef.current);
      abortRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [description, thinking, api, triggers, actionDefs, t]);

  function useExample(example: string) {
    setDescription(example);
    textareaRef.current?.focus();
  }

  function discard() {
    setView({ kind: 'input' });
    // Textarea keeps its value per spec — user may want to tweak wording.
  }

  function editInCanvas(result: ParseWorkflowNLResult) {
    navigate(ROUTES.WORKFLOW_CANVAS, {
      state: {
        seed: {
          name: result.name, description: result.description, triggerType: result.triggerType, nodes: result.nodes, edges: result.edges,
          // Wave 12 Phase 2 (TRACKER.md) — carry Crystal's inferred scope
          // through to the canvas builder so "Edit in canvas" doesn't lose it.
          // Omitted entirely when absent/org, matching createWorkflow()'s
          // convention below (never sends a bare `scopeType: undefined`).
          ...(result.scopeType && result.scopeType !== 'org' ? { scopeType: result.scopeType } : {}),
          ...(result.scopeType === 'survey' && result.scopeSurveyId ? { scopeSurveyId: result.scopeSurveyId } : {}),
          ...(result.scopeType === 'tag' && result.scopeTagId ? { scopeTagId: result.scopeTagId } : {}),
        },
      },
    });
  }

  async function createWorkflow(result: ParseWorkflowNLResult) {
    await api.createGraphWorkflow({
      name: result.name, description: result.description, triggerType: result.triggerType,
      nodes: result.nodes, edges: result.edges, status: 'draft',
      // Wave 12 Phase 2 (TRACKER.md) — scope is strictly additive: omit the
      // keys entirely when absent or 'org' so a parse result with no scope
      // hint produces a byte-identical payload to pre-Wave-12 behavior
      // (server already defaults absent scopeType to 'org').
      ...(result.scopeType && result.scopeType !== 'org' ? { scopeType: result.scopeType } : {}),
      ...(result.scopeType === 'survey' && result.scopeSurveyId ? { scopeSurveyId: result.scopeSurveyId } : {}),
      ...(result.scopeType === 'tag' && result.scopeTagId ? { scopeTagId: result.scopeTagId } : {}),
    });
    invalidate('workflows');
    navigate(ROUTES.WORKFLOWS);
  }

  function buildManually() {
    navigate(ROUTES.WORKFLOW_CANVAS);
  }

  return (
    <div className="max-w-2xl mx-auto w-full">
      <PageHeader
        crumbs={[{ label: t('nav.workflows'), path: ROUTES.WORKFLOWS }, { label: t('workflows.nlBuilder.title') }]}
        title={t('workflows.nlBuilder.title')}
        subtitle={t('workflows.nlBuilder.subtitle')}
      />

      <Card className="p-6">
        <Textarea
          ref={textareaRef}
          autoFocus
          rows={4}
          disabled={thinking}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              generate();
            }
          }}
          placeholder={t('workflows.nlBuilder.placeholder')}
        />

        <div className="mt-3">
          <p className="text-xs font-semibold text-on-surface-variant mb-2">{t('workflows.nlBuilder.examplesLabel')}</p>
          <div className="flex flex-wrap gap-2">
            {examples.map((ex) => (
              <button
                key={ex}
                type="button"
                disabled={thinking}
                title={ex}
                onClick={() => useExample(ex)}
                className="rounded-full border border-border px-3 py-1.5 text-xs text-on-surface-variant hover:border-primary hover:text-primary transition-colors disabled:opacity-50 disabled:pointer-events-none"
              >
                {ex.length > 50 ? `${ex.slice(0, 50)}…` : ex}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-4">
          <Button onClick={generate} disabled={!description.trim() || thinking}>
            {thinking ? (
              <span className="flex items-center gap-2">
                <span className="w-4 h-4 rounded-full border-2 border-t-transparent animate-spin border-current" />
                {t('workflows.nlBuilder.thinkingLabel')}
              </span>
            ) : t('workflows.nlBuilder.generateButton')}
          </Button>
        </div>

        {thinking && (
          <ThinkingState slow={thinkingSlow} />
        )}

        {view.kind === 'confirm' && (
          <ConfirmCard
            result={view.result}
            warnings={view.warnings}
            triggers={triggers}
            actionDefs={actionDefs}
            onDiscard={discard}
            onEditInCanvas={() => editInCanvas(view.result)}
            onCreate={() => createWorkflow(view.result)}
          />
        )}

        {view.kind === 'low-confidence' && (
          <LowConfidenceState
            result={view.result}
            warnings={view.warnings}
            triggers={triggers}
            actionDefs={actionDefs}
            onEditInCanvas={() => editInCanvas(view.result)}
            onReword={discard}
          />
        )}

        {view.kind === 'unparseable' && (
          <UnparseableState
            message={view.message}
            examples={examples}
            onExample={useExample}
          />
        )}

        {view.kind === 'timeout' && (
          <TimeoutState onTryAgain={generate} onBuildManually={buildManually} />
        )}
      </Card>
    </div>
  );
}

// ── Thinking state (§2.4a) ──────────────────────────────────────────────────────
// The 3D accent (§3a) is mounted for exactly as long as this component is —
// it's rendered only while `view.kind === 'thinking'` in the parent, so it
// mounts the instant thinking starts and hard-unmounts (no fade) the instant
// the parse request resolves for any reason (success, low-confidence, error,
// abort/timeout), since all of those transitions unmount ThinkingState itself.
function ThinkingState({ slow }: { slow: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="mt-6 flex items-start gap-4" data-testid="nl-thinking-state">
      <ThinkingCrystalAccent />
      <div className="flex-1 space-y-2">
        <p className="text-xs text-on-surface-variant mb-3">
          {slow ? t('workflows.nlBuilder.thinkingSlow') : t('workflows.nlBuilder.thinkingSubtext')}
        </p>
        <div className="skeleton h-10 rounded-xl" />
        <div className="skeleton h-10 rounded-xl" style={{ opacity: 0.6 }} />
        <div className="skeleton h-10 rounded-xl" />
      </div>
    </div>
  );
}

// Ambient "Crystal is working" visual, small (~96px) and purely decorative.
// Gated behind prefers-reduced-motion per app/CLAUDE.md's existing Canvas
// rule — falls back to the project's existing CSS Crystal treatment (zero
// WebGL) rather than a new fallback component.
function ThinkingCrystalAccent() {
  if (prefersReducedMotion()) {
    return <CssCrystalFallback />;
  }
  return (
    <div style={{ width: 96, height: 96 }} data-testid="nl-thinking-crystal-3d">
      <Suspense fallback={null}>
        <NLThinkingCrystal />
      </Suspense>
    </div>
  );
}

// Verbatim copy (at 96px scale) of the CSS Crystal alternative already used in
// ExperienceHubPage / SurveyIntelligencePage — see app/CLAUDE.md's "CSS
// Crystal Alternative" section. No new fallback designed.
function CssCrystalFallback() {
  return (
    <div data-testid="nl-thinking-crystal-css" style={{ width: 96, height: 96, position: 'relative', filter: 'drop-shadow(0 10px 22px rgba(42,75,217,0.45))' }}>
      <div style={{ position: 'absolute', inset: 0,
        background: 'conic-gradient(from 0deg at 50% 50%, #879aff 0%, #d299ff 25%, #82deff 50%, #d299ff 75%, #879aff 100%)',
        clipPath: 'polygon(50% 0%, 100% 30%, 100% 70%, 50% 100%, 0% 70%, 0% 30%)',
        animation: 'exp-hub-spin 20s linear infinite', filter: 'blur(0.5px)' }} />
      <div style={{ position: 'absolute', inset: '18%',
        background: 'conic-gradient(from 180deg at 50% 50%, #ffffff 0%, #879aff 33%, #d299ff 66%, #ffffff 100%)',
        clipPath: 'polygon(50% 0%, 100% 30%, 100% 70%, 50% 100%, 0% 70%, 0% 30%)',
        animation: 'exp-hub-spin 10s linear infinite reverse', opacity: 0.78 }} />
      <div style={{ position: 'absolute', inset: '38%',
        background: 'radial-gradient(circle, #ffffff, #82deff)',
        borderRadius: '50%', filter: 'blur(5px)', animation: 'pulse-glow 2.5s ease-in-out infinite' }} />
      <style>{`@keyframes exp-hub-spin { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }`}</style>
    </div>
  );
}

// ── Crystal fill animation variants (§2.6) ──────────────────────────────────────
function useCrystalFillVariants() {
  const reduced = prefersReducedMotion();
  const container: Variants = {
    hidden: {},
    visible: { transition: reduced ? { duration: 0 } : { staggerChildren: 0.09, delayChildren: 0.05 } },
  };
  const row: Variants = {
    hidden: reduced ? { opacity: 1, y: 0, scale: 1 } : { opacity: 0, y: 12, scale: 0.97 },
    visible: { opacity: 1, y: 0, scale: 1, transition: reduced ? { duration: 0 } : { duration: 0.38, ease: [0.22, 1, 0.36, 1] } },
  };
  const footer: Variants = {
    hidden: reduced ? { opacity: 1, y: 0 } : { opacity: 0, y: 8 },
    visible: { opacity: 1, y: 0, transition: reduced ? { duration: 0 } : { delay: 0.79, duration: 0.2 } },
  };
  return { container, row, footer };
}

function triggerLabelFor(triggerType: string, triggers: Trigger[]): string {
  return triggers.find((tr) => tr.type === triggerType)?.label ?? triggerType;
}

function actionLabelFor(action: string, actionDefs: ActionDef[]): string {
  return actionDefs.find((a) => a.action === action)?.label ?? action;
}

function TriggerSummaryRow({ triggerType, triggers, variants }: { triggerType: string; triggers: Trigger[]; variants: Variants }) {
  return (
    <motion.div variants={variants} className="flex items-center gap-2 py-1.5">
      <span className="w-6 h-6 rounded-md flex items-center justify-center text-white flex-shrink-0" style={{ background: '#2a4bd9' }}>
        <Icon name="bolt" size={13} />
      </span>
      <span className="text-xs font-bold text-on-surface-variant uppercase">WHEN</span>
      <span className="text-sm text-on-surface">{triggerLabelFor(triggerType, triggers)}</span>
    </motion.div>
  );
}

// Resolves a Crystal-inferred scope (Wave 12 Phase 2, TRACKER.md) to a
// human-readable label. Absent/'org' renders the exact same "Org-wide" copy
// ScopeStepPanelContent.tsx uses elsewhere in the product (workflows.builder.
// sentence.scope.orgLabel) — kept as its own nlBuilder.scopeOrgWide key since
// this page has its own locale namespace, but the English string is
// byte-identical by design. Survey/tag names are resolved client-side via
// api.getSurvey/api.listTags since ParseWorkflowNLResult only carries an id.
function ScopeSummaryRow({ scopeType, scopeSurveyId, scopeTagId, variants }: {
  scopeType?: 'org' | 'survey' | 'tag'; scopeSurveyId?: string; scopeTagId?: string; variants: Variants;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const [resolvedName, setResolvedName] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (scopeType === 'survey' && scopeSurveyId) {
      setResolving(true);
      api.getSurvey(scopeSurveyId)
        .then((res) => { if (!cancelled) setResolvedName(res.survey?.title ?? null); })
        .catch(() => { if (!cancelled) setResolvedName(null); })
        .finally(() => { if (!cancelled) setResolving(false); });
    } else if (scopeType === 'tag' && scopeTagId) {
      setResolving(true);
      api.listTags()
        .then((res) => { if (!cancelled) setResolvedName(res.tags?.find((tg) => tg.id === scopeTagId)?.name ?? null); })
        .catch(() => { if (!cancelled) setResolvedName(null); })
        .finally(() => { if (!cancelled) setResolving(false); });
    } else {
      setResolvedName(null);
      setResolving(false);
    }
    return () => { cancelled = true; };
  }, [scopeType, scopeSurveyId, scopeTagId, api]);

  let label: ReactNode;
  if (scopeType === 'survey' && scopeSurveyId) {
    label = resolving
      ? <span className="skeleton inline-block h-4 w-24 rounded align-middle" />
      : (resolvedName ?? t('workflows.nlBuilder.scopeSurveyFallback'));
  } else if (scopeType === 'tag' && scopeTagId) {
    label = resolving
      ? <span className="skeleton inline-block h-4 w-24 rounded align-middle" />
      : (resolvedName ?? t('workflows.nlBuilder.scopeTagFallback'));
  } else {
    label = t('workflows.nlBuilder.scopeOrgWide');
  }

  return (
    <motion.div variants={variants} className="flex items-center gap-2 py-1.5" data-testid="scope-summary-row">
      <span className="w-6 h-6 rounded-md flex items-center justify-center text-white flex-shrink-0" style={{ background: '#7c3aed' }}>
        <Icon name={scopeType === 'survey' ? 'description' : scopeType === 'tag' ? 'sell' : 'public'} size={13} />
      </span>
      <span className="text-xs font-bold text-on-surface-variant uppercase">ON</span>
      <span className="text-sm text-on-surface">{label}</span>
    </motion.div>
  );
}

function ConditionSummaryRow({ node, variants }: { node: EngineNode; variants: Variants }) {
  const rule = node.conditions?.rules?.[0];
  return (
    <motion.div variants={variants} className="flex items-center gap-2 py-1.5">
      <span className="w-6 h-6 rounded-md flex items-center justify-center text-white flex-shrink-0" style={{ background: '#d97706' }}>
        <Icon name="filter_alt" size={13} />
      </span>
      <span className="text-xs font-bold text-on-surface-variant uppercase">IF</span>
      <span className="text-sm text-on-surface">{rule?.field} {rule?.op} {String(rule?.value ?? '')}</span>
    </motion.div>
  );
}

function ActionSummaryRow({ node, index, actionDefs, variants }: { node: EngineNode; index: number; actionDefs: ActionDef[]; variants: Variants }) {
  return (
    <motion.div variants={variants} className="flex items-center gap-2 py-1.5">
      <span className="w-6 h-6 rounded-md flex items-center justify-center text-white flex-shrink-0" style={{ background: '#059669' }}>
        <Icon name="play_arrow" size={13} />
      </span>
      {index === 1 && <span className="text-xs font-bold text-on-surface-variant uppercase">THEN</span>}
      <span className="text-sm text-on-surface">{index}. {actionLabelFor(node.action ?? '', actionDefs)}</span>
    </motion.div>
  );
}

function WarningsList({ warnings, variants }: { warnings: string[]; variants: Variants }) {
  const { t } = useTranslation();
  return (
    <motion.div variants={variants} className="mt-2 p-3 rounded-lg bg-warning/10">
      <p className="text-xs font-semibold text-warning mb-1 flex items-center gap-1">
        <Icon name="warning" size={13} />{t('workflows.nlBuilder.assumedHeading')}
      </p>
      <ul className="text-xs text-on-surface-variant list-disc list-inside">
        {warnings.map((w, i) => <li key={i}>{w}</li>)}
      </ul>
    </motion.div>
  );
}

function ConfidenceBadge({ confidence, variants }: { confidence: number; variants: Variants }) {
  const { t } = useTranslation();
  const isHigh = confidence >= HIGH_CONFIDENCE_THRESHOLD;
  const label = isHigh ? t('workflows.nlBuilder.confidenceHigh') : t('workflows.nlBuilder.confidenceMedium');
  const filledDots = isHigh ? 5 : 3;
  const dotColor = isHigh ? '#059669' : '#d97706';
  return (
    <motion.div variants={variants} className="flex items-center gap-2 mt-3" data-testid="confidence-badge" data-tier={isHigh ? 'high' : 'medium'}>
      <span className="flex gap-0.5">
        {Array.from({ length: 5 }).map((_, i) => (
          <span key={i} className="w-1.5 h-1.5 rounded-full" style={{ background: i < filledDots ? dotColor : '#e5e7eb' }} />
        ))}
      </span>
      <span className="text-xs font-semibold text-on-surface-variant">Confidence: {label}</span>
    </motion.div>
  );
}

function ConfirmCard({ result, warnings, triggers, actionDefs, onDiscard, onEditInCanvas, onCreate }: {
  result: ParseWorkflowNLResult; warnings: string[]; triggers: Trigger[]; actionDefs: ActionDef[];
  onDiscard: () => void; onEditInCanvas: () => void; onCreate: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(result.name);
  const { container, row, footer } = useCrystalFillVariants();
  const conditionNodes = result.nodes.filter((n) => n.type === 'condition');
  const actionNodes = result.nodes.filter((n) => n.type === 'action');

  return (
    <motion.div variants={container} initial="hidden" animate="visible" className="mt-6" data-testid="nl-confirm-card">
      <p className="text-sm font-semibold text-on-surface mb-3 flex items-center gap-1.5">
        <Icon name="auto_awesome" size={16} className="text-primary" />{t('workflows.nlBuilder.confirmHeading')}
      </p>
      <Input value={name} onChange={(e) => setName(e.target.value)} className="mb-3 font-semibold" />

      <TriggerSummaryRow triggerType={result.triggerType} triggers={triggers} variants={row} />
      <ScopeSummaryRow scopeType={result.scopeType} scopeSurveyId={result.scopeSurveyId} scopeTagId={result.scopeTagId} variants={row} />
      {conditionNodes.map((n) => <ConditionSummaryRow key={n.id} node={n} variants={row} />)}
      {actionNodes.map((n, i) => <ActionSummaryRow key={n.id} node={n} index={i + 1} actionDefs={actionDefs} variants={row} />)}

      {warnings.length > 0 && <WarningsList warnings={warnings} variants={row} />}
      <ConfidenceBadge confidence={result.confidence} variants={row} />

      <motion.div variants={footer} className="flex items-center gap-2 mt-4">
        <Button variant="outline" onClick={onEditInCanvas}>{t('workflows.nlBuilder.editInCanvas')}</Button>
        <Button variant="ghost" onClick={onDiscard}>{t('workflows.nlBuilder.discard')}</Button>
        <Button onClick={() => onCreate()}>{t('workflows.nlBuilder.createWorkflow')}</Button>
      </motion.div>
    </motion.div>
  );
}

function LowConfidenceState({ result, warnings, triggers, actionDefs, onEditInCanvas, onReword }: {
  result: ParseWorkflowNLResult; warnings: string[]; triggers: Trigger[]; actionDefs: ActionDef[];
  onEditInCanvas: () => void; onReword: () => void;
}) {
  const { t } = useTranslation();
  const conditionNodes = result.nodes.filter((n) => n.type === 'condition');
  const actionNodes = result.nodes.filter((n) => n.type === 'action');
  const { row } = useCrystalFillVariants();

  return (
    <div className="mt-6" data-testid="nl-low-confidence-state">
      <p className="text-sm font-semibold text-warning mb-1 flex items-center gap-1.5">
        <Icon name="warning" size={16} />{t('workflows.nlBuilder.lowConfidenceHeading')}
      </p>
      <p className="text-sm text-on-surface-variant mb-3">{t('workflows.nlBuilder.lowConfidenceBody')}</p>

      <div className="p-3 rounded-xl border border-dashed border-border" style={{ opacity: 0.7 }}>
        <TriggerSummaryRow triggerType={result.triggerType} triggers={triggers} variants={row} />
        <ScopeSummaryRow scopeType={result.scopeType} scopeSurveyId={result.scopeSurveyId} scopeTagId={result.scopeTagId} variants={row} />
        {conditionNodes.map((n) => <ConditionSummaryRow key={n.id} node={n} variants={row} />)}
        {actionNodes.map((n, i) => <ActionSummaryRow key={n.id} node={n} index={i + 1} actionDefs={actionDefs} variants={row} />)}
      </div>

      {warnings.length > 0 && (
        <div className="mt-2 p-3 rounded-lg bg-warning/10">
          <ul className="text-xs text-on-surface-variant list-disc list-inside">
            {warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      )}

      {/* No "Create Workflow" button — deliberate guardrail, not an oversight. */}
      <div className="flex items-center gap-2 mt-4">
        <Button variant="outline" onClick={onEditInCanvas}>{t('workflows.nlBuilder.editInCanvas')}</Button>
        <Button variant="ghost" onClick={onReword}>{t('workflows.nlBuilder.tryRewording')}</Button>
      </div>
    </div>
  );
}

function UnparseableState({ message, examples, onExample }: { message: string; examples: string[]; onExample: (ex: string) => void }) {
  const { t } = useTranslation();
  return (
    <div className="mt-6" data-testid="nl-unparseable-state">
      <p className="text-sm font-semibold text-error mb-1 flex items-center gap-1.5">
        <Icon name="cancel" size={16} />{t('workflows.nlBuilder.unparseableHeading')}
      </p>
      <p className="text-sm text-on-surface-variant mb-3">{message}</p>
      <p className="text-xs font-semibold text-on-surface-variant mb-1">{t('workflows.nlBuilder.unparseableHint')}</p>
      <ul className="text-xs text-on-surface-variant list-disc list-inside mb-3">
        <li>{t('workflows.nlBuilder.unparseableHintTrigger')}</li>
        <li>{t('workflows.nlBuilder.unparseableHintAction')}</li>
      </ul>
      <div className="flex flex-wrap gap-2">
        {examples.map((ex) => (
          <button
            key={ex}
            type="button"
            title={ex}
            onClick={() => onExample(ex)}
            className="rounded-full border border-border px-3 py-1.5 text-xs text-on-surface-variant hover:border-primary hover:text-primary transition-colors"
          >
            {ex.length > 50 ? `${ex.slice(0, 50)}…` : ex}
          </button>
        ))}
      </div>
    </div>
  );
}

function TimeoutState({ onTryAgain, onBuildManually }: { onTryAgain: () => void; onBuildManually: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="mt-6" data-testid="nl-timeout-state">
      <p className="text-sm font-semibold text-on-surface mb-1 flex items-center gap-1.5">
        <Icon name="schedule" size={16} />{t('workflows.nlBuilder.timeoutHeading')}
      </p>
      <p className="text-sm text-on-surface-variant mb-3">{t('workflows.nlBuilder.timeoutBody')}</p>
      <div className="flex items-center gap-2">
        <Button variant="outline" onClick={onTryAgain}>{t('workflows.nlBuilder.tryAgain')}</Button>
        <Button variant="ghost" onClick={onBuildManually}>{t('workflows.nlBuilder.buildManually')} →</Button>
      </div>
    </div>
  );
}
