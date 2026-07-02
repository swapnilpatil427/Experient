import { useState, useEffect, useMemo } from 'react';
import { Icon } from '../components/Icon';
import { useSetPageTitle } from '../contexts/pageTitle';
import { useWorkflows } from '../hooks/useWorkflows';
import { useApi } from '../hooks/useApi';
import { useNavigate } from 'react-router-dom';
import type { WorkflowTemplate, WorkflowExecution, WorkflowExecutionStep, WorkflowAuditEvent, SurveyTag } from '../lib/api';
import type { Workflow, WorkflowCondition, WorkflowAction, Survey } from '../types';
import { GRADIENTS } from '../constants/colors';
import { ROUTES } from '../constants/routes';
import { useTranslation } from '../lib/i18n';
import { resolveEditRoute } from '../lib/workflowEditRoute';
import type { EngineNode, EngineEdge } from '../lib/workflowCanvas';
import { scopeRailColorVar } from '../lib/workflowScopeDisplay';
import { WorkflowScopeChip } from '../components/workflows/WorkflowScopeChip';
import { ScopeFilterBar, type ScopeFilterValue } from '../components/workflows/ScopeFilterBar';
import { PageHeader } from '../components/PageHeader';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';

type RegistryTrigger = { type: string; label: string; category: string };

// status → Badge variant, matching this codebase's existing pill convention
// (live=green, paused=yellow, draft=neutral, destructive=red).
const STATUS_BADGE_VARIANT: Record<Workflow['status'], 'live' | 'paused' | 'draft' | 'destructive' | 'neutral'> = {
  active: 'live',
  paused: 'paused',
  draft: 'draft',
  error: 'destructive',
  archived: 'neutral',
};

function statusLabel(t: (k: string) => string, status: Workflow['status']): string {
  return t(`workflows.status.${status}`);
}

function successRate(wf: Workflow): number | null {
  if (!wf.run_count) return null;
  const successes = wf.success_count ?? 0;
  return Math.round((successes / wf.run_count) * 100);
}

function formatLastRun(t: (k: string) => string, wf: Workflow): string {
  if (!wf.last_run_at) return t('workflows.card.neverRun');
  return new Date(wf.last_run_at).toLocaleString();
}

function triggerLabel(wf: Workflow, triggers: RegistryTrigger[]): string | null {
  if (!wf.trigger_type) return null;
  const match = triggers.find((tr) => tr.type === wf.trigger_type);
  return match?.label ?? wf.trigger_type;
}

const WORKFLOW_VISUALS = {
  w1: {
    badgeBg: 'rgba(180,19,64,0.1)',  badgeColor: '#b41340',
    iconGradient: GRADIENTS.primaryLight, iconBg: 'rgba(42,75,217,0.08)',
    conditionColor: '#b41340', actionColor: '#00647c',
  },
  w2: {
    badgeBg: 'rgba(131,41,200,0.1)', badgeColor: '#8329c8',
    iconGradient: GRADIENTS.purple,  iconBg: 'rgba(131,41,200,0.08)',
    conditionColor: '#8329c8',       actionColor: '#2a4bd9',
  },
  w3: {
    badgeBg: 'rgba(217,119,6,0.1)',  badgeColor: '#d97706',
    iconGradient: GRADIENTS.warning, iconBg: 'rgba(217,119,6,0.08)',
    conditionColor: '#b41340',       actionColor: '#059669',
  },
};

const DEFAULT_VISUALS = {
  badgeBg: 'rgba(42,75,217,0.1)', badgeColor: '#2a4bd9',
  iconGradient: GRADIENTS.primaryLight, iconBg: 'rgba(42,75,217,0.08)',
  conditionColor: '#2a4bd9',      actionColor: '#8329c8',
};

function getVisuals(wf: Workflow) {
  return (WORKFLOW_VISUALS as Record<string, typeof DEFAULT_VISUALS>)[wf.id] || DEFAULT_VISUALS;
}

function formatCondition(wf: Workflow): { field: string; operator: string; value: string } {
  const cond: WorkflowCondition = wf.condition ?? {};
  return {
    field:    cond.field    ?? '',
    operator: cond.operator ?? '=',
    value:    cond.value != null ? String(cond.value) : '',
  };
}

function formatAction(wf: Workflow): string {
  const act: WorkflowAction = wf.action ?? {};
  const { type, config } = act;
  if (type === 'email')  return `Send Email to ${(config?.to as string | undefined) || 'team'}`;
  if (type === 'tag')    return `Tag as ${(config?.tag as string | undefined) || 'beta-cohort'}`;
  if (type === 'notify') return `Notify ${(config?.team as string | undefined) || 'team'}`;
  return type ?? '';
}

// Graph-shape workflows (trigger_type/nodes/edges) don't have a single condition/action
// pair — only render the legacy "IF ... THEN ..." rule line when one exists.
function hasLegacyRule(wf: Workflow): boolean {
  return Boolean(wf.condition?.field || wf.action?.type);
}

export function WorkflowsPage() {
  const { t } = useTranslation();
  useSetPageTitle(t('workflows.pageTitle'), t('workflows.pageSubtitle'));
  const { workflows, loading, error, toggleWorkflow, deleteWorkflow, testWorkflow } = useWorkflows();
  const api = useApi();
  const navigate = useNavigate();

  const [triggers, setTriggers] = useState<RegistryTrigger[]>([]);
  const [historyWorkflow, setHistoryWorkflow] = useState<Workflow | null>(null);
  // Audit trail (Wave 11, Nina — TRACKER.md Wave 11 Part 1) — config-CHANGE
  // history, a distinct concept from `historyWorkflow` above (execution/run
  // history). Separate state + dialog so the two "History" concepts don't
  // collide in one modal.
  const [auditLogWorkflow, setAuditLogWorkflow] = useState<Workflow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Workflow | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ id: string; status: string; conditionsPassed?: boolean; durationMs?: number } | null>(null);

  // Scope name resolution — the list response only has scope_survey_id/
  // scope_tag_id (ids), not names, so lookups are built client-side from a
  // one-time fetch (both already cheap/used elsewhere on this page's siblings).
  // Wave 6, BUILDER_REDESIGN_V2_CONCEPT.md §2 — chips must render in the
  // initial DOM, no interaction required, so this fetch is unconditional on mount.
  const [scopeSurveys, setScopeSurveys] = useState<Survey[]>([]);
  const [scopeTags, setScopeTags] = useState<SurveyTag[]>([]);
  const [scopeFilter, setScopeFilter] = useState<ScopeFilterValue>({ kind: 'all' });

  useEffect(() => {
    api.getWorkflowRegistry().then((r) => setTriggers(r.triggers as RegistryTrigger[])).catch(() => {});
    api.listSurveys({ limit: 200 }).then((res) => setScopeSurveys(res.surveys ?? [])).catch(() => {});
    api.listTags({}).then((res) => setScopeTags(res.tags ?? [])).catch(() => {});
  }, [api]);

  const surveyNameById = useMemo(() => new Map(scopeSurveys.map((s) => [s.id, s.title])), [scopeSurveys]);
  const tagById = useMemo(() => new Map(scopeTags.map((tg) => [tg.id, tg])), [scopeTags]);

  const scopeFilteredWorkflows = useMemo(() => {
    if (scopeFilter.kind === 'all') return workflows;
    if (scopeFilter.kind === 'org') return workflows.filter((wf) => (wf.scope_type ?? 'org') === 'org');
    if (scopeFilter.kind === 'survey') return workflows.filter((wf) => wf.scope_type === 'survey' && wf.scope_survey_id === scopeFilter.surveyId);
    return workflows.filter((wf) => wf.scope_type === 'tag' && wf.scope_tag_id === scopeFilter.tagId);
  }, [workflows, scopeFilter]);

  const handleTest = async (wf: Workflow) => {
    setTestingId(wf.id);
    setTestResult(null);
    try {
      const result = await testWorkflow(wf.id);
      setTestResult({ id: wf.id, status: result.status, conditionsPassed: result.conditionsPassed, durationMs: result.durationMs });
    } catch {
      setTestResult({ id: wf.id, status: 'error' });
    } finally {
      setTestingId(null);
    }
  };

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    await deleteWorkflow(deleteTarget.id);
    setDeleteTarget(null);
  };

  return (
    <>
        <div className="max-w-7xl mx-auto w-full">
          <PageHeader
            crumbs={[{ label: t('nav.workflows'), icon: 'account_tree', path: ROUTES.WORKFLOWS }]}
            title={t('workflows.mainHeading')}
            subtitle={t('workflows.mainDescription')}
            actions={
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  onClick={() => navigate(ROUTES.SETTINGS_INTEGRATIONS)}
                  className="rounded-xl"
                  style={{ background: 'rgba(42,75,217,0.08)', color: 'var(--color-primary)', border: 'none' }}
                >
                  <Icon name="cable" size={16} className="mr-1.5" />
                  {t('integrationsSettings.entryPointLabel')}
                </Button>
                <Button variant="outline" onClick={() => navigate(ROUTES.WORKFLOW_NL_BUILD)}>
                  <Icon name="auto_awesome" size={16} className="mr-1.5" />
                  {t('workflows.buildWithCrystal')}
                </Button>
                {/* DEEP_AUDIT_FIX_SPECS.md Issue 2 / Rohan DEEP_AUDIT_UX_FINDINGS.md
                    L-1 — "Build Visually" and "New Workflow" used to navigate to the
                    identical route with no distinguishing behavior; "New Workflow"
                    is now deleted entirely (not repurposed into a dropdown — a
                    dropdown-of-3-things next to the same 3 things as individual
                    buttons has no clear reason to exist) and "Build Visually" is
                    promoted to the sole primary/solid CTA. Using the real `Button`
                    `variant="default"` also fixes finding V-1 (the old "New
                    Workflow" button's hardcoded `style={{ background: '#2a4bd9' }}`
                    bypassed the brand-theming system) for free. */}
                <Button
                  variant="default"
                  onClick={() => navigate(ROUTES.WORKFLOW_BUILD)}
                  title={t('workflows.buildVisuallyTooltip')}
                  className="flex-col items-start h-auto py-2"
                >
                  <span className="flex items-center gap-1.5">
                    <Icon name="account_tree" size={16} />
                    {t('workflows.buildVisually')}
                  </span>
                  <span className="text-[11px] font-normal opacity-80 pl-[22px]">{t('workflows.buildVisuallySubtext')}</span>
                </Button>
                <Button
                  variant="outline"
                  onClick={() => navigate(ROUTES.WORKFLOW_CANVAS)}
                  title={t('workflows.buildOnCanvasTooltip')}
                  className="flex-col items-start h-auto py-2"
                >
                  <span className="flex items-center gap-1.5">
                    <Icon name="schema" size={16} />
                    {t('workflows.buildOnCanvas')}
                  </span>
                  <span className="text-[11px] font-normal text-on-surface-variant pl-[22px]">{t('workflows.buildOnCanvasSubtext')}</span>
                </Button>
              </div>
            }
          />

          {/* Stats row */}
          <div className="grid grid-cols-3 gap-4 mb-8">
            {[
              { labelKey: 'workflows.stats.active',        value: workflows.filter((w) => w.status === 'active').length, color: '#059669', bg: '#d1fae5' },
              { labelKey: 'workflows.stats.triggersToday', value: workflows.reduce((a, w) => a + (w.trigger_count || 0), 0), color: '#2a4bd9', bg: '#e0e7ff' },
              { labelKey: 'workflows.stats.paused',        value: workflows.filter((w) => w.status === 'paused').length, color: '#d97706', bg: '#fef3c7' },
            ].map((stat) => (
              <Card key={stat.labelKey} className="p-4 rounded-2xl bg-white border-0"
                style={{ boxShadow: '0 4px 20px rgba(0,0,0,0.04)' }}>
                <p className="label-caps mb-1">{t(stat.labelKey)}</p>
                <p className="text-3xl font-black font-headline" style={{ color: stat.color }}>
                  {stat.value}
                </p>
              </Card>
            ))}
          </div>

          {/* Pending approvals */}
          <PendingApprovals />

          {/* Pre-built templates */}
          <WorkflowTemplates />

          {/* Error banner — data hook falls back to mock data, but we still surface the failure */}
          {!loading && error && (
            <div className="flex items-center gap-2 px-4 py-3 mb-6 rounded-xl text-sm font-semibold text-error" style={{ background: '#fff0f0' }}>
              <Icon name="error_outline" size={16} />
              {t('workflows.loadError')}
            </div>
          )}

          {/* Loading */}
          {loading && (
            <div data-testid="workflows-loading" className="flex items-center justify-center py-20">
              <div className="w-8 h-8 rounded-full border-2 border-t-transparent animate-spin border-primary" />
            </div>
          )}

          {/* Scope filter bar (Wave 6) — client-side filter over the already-loaded list */}
          {!loading && workflows.length > 0 && (
            <ScopeFilterBar
              value={scopeFilter}
              onChange={setScopeFilter}
              surveyOptions={scopeSurveys.map((s) => ({ id: s.id, title: s.title }))}
              tagOptions={scopeTags.map((tg) => ({ id: tg.id, name: tg.name }))}
            />
          )}

          {/* Workflow cards */}
          {!loading && workflows.length > 0 && (
            <div className="flex flex-col gap-5">
              {scopeFilteredWorkflows.map((wf) => {
                const visuals = getVisuals(wf);
                const cond = formatCondition(wf);
                const actionLabel = formatAction(wf);
                const triggerCount = wf.trigger_count ?? 0;
                const iconName = 'bolt';
                const badge = wf.name || 'Workflow';
                const trigLabel = triggerLabel(wf, triggers);
                const rate = successRate(wf);
                const isBusy = testingId === wf.id;
                const lastResult = testResult?.id === wf.id ? testResult : null;
                const scopeType = wf.scope_type ?? 'org';
                const railColor = scopeRailColorVar(wf.scope_type);
                const resolvedSurveyName = wf.scope_survey_id ? (surveyNameById.get(wf.scope_survey_id) ?? null) : undefined;
                const resolvedTag = wf.scope_tag_id ? tagById.get(wf.scope_tag_id) : undefined;
                const resolvedTagName = wf.scope_tag_id ? (resolvedTag?.name ?? null) : undefined;

                return (
                  <Card
                    key={wf.id}
                    className="group relative overflow-hidden rounded-2xl p-1 transition-all duration-500 bg-white hover:-translate-y-1"
                    style={{ boxShadow: '0 4px 20px rgba(0,0,0,0.04)', borderLeft: `4px solid ${railColor}`, borderTop: 0, borderRight: 0, borderBottom: 0 }}
                    onMouseEnter={(e) => { e.currentTarget.style.boxShadow = '0 40px 60px -10px rgba(44,47,49,0.08)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.boxShadow = '0 4px 20px rgba(0,0,0,0.04)'; }}
                  >
                    <div
                      className="flex flex-col md:flex-row items-center gap-6 p-6 md:p-8 rounded-2xl"
                      style={{ background: wf.status === 'paused' ? '#f9fafb' : '#ffffff' }}
                    >
                      <div className="relative w-20 h-20 flex items-center justify-center shrink-0">
                        <div className="absolute inset-0 rounded-3xl transition-transform duration-500"
                          style={{ background: visuals.iconBg, transform: 'rotate(6deg)' }} />
                        <div className="absolute inset-0 rounded-3xl"
                          style={{ background: visuals.iconBg, transform: 'rotate(-3deg)' }} />
                        <div className="relative z-10 flex items-center justify-center w-14 h-14 rounded-2xl shadow-lg"
                          style={{ background: visuals.iconGradient, opacity: wf.status === 'paused' ? 0.6 : 1 }}>
                          <Icon name={iconName} fill={1} size={28} className="text-white" />
                        </div>
                      </div>

                      <div className="flex-1 space-y-2 text-center md:text-left min-w-0">
                        <div className="flex flex-wrap items-center justify-center md:justify-start gap-3">
                          <WorkflowScopeChip
                            scopeType={wf.scope_type}
                            surveyName={resolvedSurveyName}
                            tagName={resolvedTagName}
                            tagIsProgram={Boolean(resolvedTag?.program_config)}
                          />
                          <Badge
                            variant="secondary"
                            className="px-2 py-1 text-[10px] font-bold rounded uppercase tracking-tight"
                            style={{ background: visuals.badgeBg, color: visuals.badgeColor }}
                          >
                            {badge}
                          </Badge>
                          <span className="text-xs text-muted-foreground">{t('workflows.card.triggerCount', { count: triggerCount })}</span>
                          <Badge variant={STATUS_BADGE_VARIANT[wf.status]}>{statusLabel(t, wf.status)}</Badge>
                          {trigLabel && <span className="text-xs text-on-surface-variant">{trigLabel}</span>}
                        </div>

                        {wf.description && (
                          <p className="text-xs text-on-surface-variant">{wf.description}</p>
                        )}

                        {/* Scope subtext — sentence-affinity phrasing, matches the builder's voice */}
                        {scopeType === 'survey' && resolvedSurveyName && (
                          <p className="text-xs text-on-surface-variant" data-testid="workflow-scope-subtext">
                            {t('workflows.card.scope.subtextSurvey', { name: resolvedSurveyName })}
                          </p>
                        )}
                        {scopeType === 'tag' && resolvedTagName && (
                          <p className="text-xs text-on-surface-variant" data-testid="workflow-scope-subtext">
                            {t('workflows.card.scope.subtextTag', { count: resolvedTag?.survey_count ?? 0, name: resolvedTagName })}
                          </p>
                        )}

                        {hasLegacyRule(wf) && (
                          <div className="flex flex-wrap items-center justify-center md:justify-start gap-2 text-xl font-black font-headline">
                            <span className="text-muted-foreground font-medium text-sm">{t('common.if')}</span>
                            <span className="text-primary">{cond.field}</span>
                            {cond.operator && <span className="text-on-surface-variant text-sm">{cond.operator}</span>}
                            <span style={{ color: visuals.conditionColor }}>{cond.value}</span>
                            <span className="text-muted-foreground font-medium text-sm">{t('common.then')}</span>
                            <span style={{ color: visuals.actionColor }}>{actionLabel}</span>
                          </div>
                        )}

                        {/* Run stats — surfaced from GET /api/workflows */}
                        <div className="flex flex-wrap items-center justify-center md:justify-start gap-x-4 gap-y-1 text-xs text-on-surface-variant pt-1">
                          <span>{t('workflows.card.runCount', { count: wf.run_count ?? 0 })}</span>
                          {rate != null && <span>{t('workflows.card.successRate', { rate })}</span>}
                          <span>{t('workflows.card.lastRun', { when: formatLastRun(t, wf) })}</span>
                        </div>

                        {lastResult && (
                          <p
                            data-testid={`test-result-${wf.id}`}
                            className={`text-xs font-semibold ${lastResult.status === 'error' || lastResult.status === 'failed' ? 'text-error' : 'text-success'}`}
                          >
                            {lastResult.status === 'error' || lastResult.status === 'failed'
                              ? t('workflows.card.testFailed')
                              : t('workflows.card.testSucceeded', { ms: lastResult.durationMs ?? 0 })}
                          </p>
                        )}
                      </div>

                      {/* Hover quick-actions — always visible on touch, revealed on hover for desktop density */}
                      <div className="flex flex-wrap items-center justify-center gap-2 shrink-0 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => toggleWorkflow(wf.id)}
                          className="flex items-center gap-1.5 px-4 py-2.5 font-bold text-xs rounded-xl active:scale-95 font-headline text-on-surface bg-surface-container"
                          style={{ boxShadow: '0 4px 0 #c7c4d7' }}
                        >
                          <Icon name={wf.status === 'active' ? 'pause_circle' : 'play_circle'} size={16} />
                          {wf.status === 'active' ? t('workflows.controls.pause') : t('workflows.controls.resume')}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={t('workflows.controls.test')}
                          disabled={isBusy}
                          onClick={() => handleTest(wf)}
                          className="w-9 h-9 rounded-xl text-on-surface-variant hover:text-on-surface"
                        >
                          {isBusy
                            ? <div className="w-4 h-4 rounded-full border-2 border-t-transparent animate-spin border-current" />
                            : <Icon name="science" size={16} />}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={t('workflows.controls.history')}
                          onClick={() => setHistoryWorkflow(wf)}
                          className="w-9 h-9 rounded-xl text-on-surface-variant hover:text-on-surface"
                        >
                          <Icon name="history" size={16} />
                        </Button>
                        {/* Audit trail entry point (Wave 11, Nina —
                            GET /:id/audit-log). Distinct icon (manage_history)
                            from the run-history button above so the two
                            concepts (WHEN did this fire vs. WHO changed this)
                            aren't visually conflated. */}
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={t('workflows.controls.auditLog')}
                          onClick={() => setAuditLogWorkflow(wf)}
                          className="w-9 h-9 rounded-xl text-on-surface-variant hover:text-on-surface"
                        >
                          <Icon name="manage_history" size={16} />
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => {
                            // The list response already includes nodes/edges — no
                            // extra fetch needed here; only the builder itself
                            // (re-)fetches, since a bookmarked/shared URL may land
                            // there with no list data in memory.
                            const target = resolveEditRoute(
                              (wf.nodes ?? []) as EngineNode[],
                              (wf.edges ?? []) as EngineEdge[],
                            );
                            navigate(target, { state: { workflowId: wf.id } });
                          }}
                          className="flex items-center gap-1.5 px-4 py-2.5 font-bold text-xs rounded-xl active:scale-95 font-headline text-on-surface bg-surface-container"
                          style={{ boxShadow: '0 4px 0 #c7c4d7' }}
                        >
                          <Icon name="edit" size={16} />
                          {t('workflows.controls.edit')}
                        </Button>
                        <Button
                          variant="destructive"
                          size="icon"
                          aria-label={t('workflows.controls.delete')}
                          onClick={() => setDeleteTarget(wf)}
                          className="p-2.5 rounded-xl active:scale-95"
                          style={{ background: 'rgba(180,19,64,0.06)', boxShadow: '0 4px 0 rgba(180,19,64,0.1)' }}
                        >
                          <Icon name="delete" size={18} className="text-error" />
                        </Button>
                      </div>
                    </div>
                  </Card>
                );
              })}
            </div>
          )}

          {/* Empty state */}
          {!loading && workflows.length === 0 && (
            <div className="text-center py-20">
              <div className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-4 bg-surface-container-low">
                <Icon name="account_tree" size={32} className="text-muted-foreground" />
              </div>
              <h3 className="text-xl font-bold mb-2 font-headline text-on-surface">
                {t('workflows.empty.heading')}
              </h3>
              <p className="text-sm mb-6 text-on-surface-variant">
                {t('workflows.empty.description')}
              </p>
              <Button
                onClick={() => navigate(ROUTES.WORKFLOW_BUILD)}
                variant="gradient"
                className="px-6 py-3 text-white font-bold text-sm transition-all active:scale-95 font-headline rounded-xl"
              >
                {t('workflows.empty.cta')}
              </Button>
            </div>
          )}
        </div>

      {/* Run history */}
      <Dialog open={historyWorkflow != null} onOpenChange={(open) => { if (!open) setHistoryWorkflow(null); }}>
        <DialogContent className="w-full max-w-lg p-8 rounded-2xl bg-white" style={{ boxShadow: '0 40px 80px -20px rgba(0,0,0,0.25)' }}>
          <DialogHeader>
            <DialogTitle className="text-2xl font-extrabold tracking-tighter font-headline text-on-surface">
              {t('workflows.history.heading')}
            </DialogTitle>
          </DialogHeader>
          {historyWorkflow && <RunHistory workflow={historyWorkflow} />}
        </DialogContent>
      </Dialog>

      {/* Audit trail (Wave 11, Nina — GET /:id/audit-log) — config-change
          history, a distinct concept from Run history above. */}
      <Dialog open={auditLogWorkflow != null} onOpenChange={(open) => { if (!open) setAuditLogWorkflow(null); }}>
        <DialogContent className="w-full max-w-lg p-8 rounded-2xl bg-white" style={{ boxShadow: '0 40px 80px -20px rgba(0,0,0,0.25)' }}>
          <DialogHeader>
            <DialogTitle className="text-2xl font-extrabold tracking-tighter font-headline text-on-surface">
              {t('workflows.auditLog.heading')}
            </DialogTitle>
          </DialogHeader>
          {auditLogWorkflow && <AuditLogHistory workflow={auditLogWorkflow} />}
        </DialogContent>
      </Dialog>

      {/* Delete confirmation — destructive action, requires explicit confirm */}
      <Dialog open={deleteTarget != null} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <DialogContent className="w-full max-w-sm p-8 rounded-2xl bg-white" style={{ boxShadow: '0 40px 80px -20px rgba(0,0,0,0.25)' }}>
          <div className="w-12 h-12 rounded-2xl flex items-center justify-center mx-auto mb-4" style={{ background: '#fff0f0' }}>
            <Icon name="delete_forever" fill={1} size={24} className="text-error" />
          </div>
          <DialogHeader>
            <DialogTitle className="text-base font-extrabold font-headline text-on-surface text-center">
              {t('workflows.deleteModal.heading')}
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-on-surface-variant text-center mb-2">
            {t('workflows.deleteModal.description', { name: deleteTarget?.name ?? '' })}
          </p>
          <DialogFooter className="flex gap-3 mt-2">
            <Button
              variant="secondary"
              onClick={() => setDeleteTarget(null)}
              className="flex-1 py-3 font-bold text-sm rounded-xl font-headline bg-surface-container text-on-surface"
            >
              {t('workflows.deleteModal.cancelButton')}
            </Button>
            <Button
              variant="destructive"
              onClick={handleDeleteConfirm}
              className="flex-1 py-3 font-bold text-sm rounded-xl font-headline"
            >
              {t('workflows.deleteModal.confirmButton')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// status -> icon/color. The backend only ever writes 'completed' for a
// successful run (Maya DEEP_AUDIT_PM_FINDINGS.md Top-5 #4) — the previous
// `exec.status === 'success'` comparison was dead code that could never match,
// so every successful run rendered with the same neutral gray icon as a
// skipped/waiting/cooldown-suppressed one.
const STATUS_ICON: Record<string, { icon: string; className: string }> = {
  completed: { icon: 'check_circle', className: 'text-success' },
  failed: { icon: 'cancel', className: 'text-error' },
  skipped: { icon: 'skip_next', className: 'text-warning' },
  waiting: { icon: 'hourglass_empty', className: 'text-warning' },
  cooldown: { icon: 'schedule', className: 'text-muted-foreground' },
};

function statusIconFor(status: string): { icon: string; className: string } {
  return STATUS_ICON[status] ?? { icon: 'schedule', className: 'text-muted-foreground' };
}

function statusLabelFor(t: (k: string) => string, status: string): string {
  const key = `workflows.history.status.${status}`;
  const label = t(key);
  return label === key ? status : label;
}

// Per-step skip-reason machine code (workflowEngine.ts's `output.reason`) ->
// human copy. Not backend-humanized like error_message (a graceful skip never
// populates error_message at all), so this mapping lives on the frontend.
function skipReasonText(t: (k: string) => string, reason: string | undefined): string | null {
  if (!reason) return null;
  const key = `workflows.history.skipReason.${reason}`;
  const label = t(key);
  return label === key ? reason : label;
}

// One execution's per-step detail (Maya Top-5 #4/§9a, Rohan R-1/R-2) — a
// skipped step shows its human-readable skip reason (previously invisible:
// "3 steps" and nothing else), a failed step shows the humanized error with
// the raw exception available behind a "Technical details" disclosure.
function ExecutionStepRow({ step }: { step: WorkflowExecutionStep }) {
  const { t } = useTranslation();
  const { icon, className } = statusIconFor(step.status);
  const skipReason = step.status === 'skipped' ? skipReasonText(t, step.output?.reason) : null;

  return (
    <div className="flex items-start gap-2 py-1.5 pl-1 border-l-2 border-border ml-2">
      <Icon name={icon} size={14} className={`${className} mt-0.5 shrink-0`} />
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-on-surface">{step.nodeType}</p>
        {skipReason && <p className="text-xs text-warning">{skipReason}</p>}
        {step.errorMessage && (
          <div className="text-xs text-error">
            <p>{step.errorMessage.message}</p>
            {step.errorMessage.matched && step.errorMessage.raw !== step.errorMessage.message && (
              <details className="mt-0.5">
                <summary className="cursor-pointer text-on-surface-variant hover:text-on-surface">
                  {t('workflows.history.technicalDetails')}
                </summary>
                <p className="mt-0.5 font-mono text-[11px] text-on-surface-variant break-all">{step.errorMessage.raw}</p>
              </details>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// Recent execution history for a single workflow (GET /api/workflows/:id/executions).
function RunHistory({ workflow }: { workflow: Workflow }) {
  const { t } = useTranslation();
  const api = useApi();
  const [executions, setExecutions] = useState<WorkflowExecution[]>([]);
  const [loading, setLoading] = useState(true);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [retryResult, setRetryResult] = useState<{ id: string; success: boolean } | null>(null);

  const load = () => {
    setLoading(true);
    api.getWorkflowExecutions(workflow.id)
      .then(({ executions }) => setExecutions(executions))
      .catch(() => setExecutions([]))
      .finally(() => setLoading(false));
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [api, workflow.id]);

  // Retry endpoint (api.retryWorkflowExecution) already existed and was
  // already tested, but had zero UI call sites anywhere in app/src (Maya 1c) —
  // a failed execution could never actually be retried from the product.
  async function handleRetry(execId: string) {
    setRetryingId(execId);
    setRetryResult(null);
    try {
      await api.retryWorkflowExecution(execId);
      setRetryResult({ id: execId, success: true });
      load();
    } catch {
      setRetryResult({ id: execId, success: false });
    } finally {
      setRetryingId(null);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-10">
        <div className="w-6 h-6 rounded-full border-2 border-t-transparent animate-spin border-primary" />
      </div>
    );
  }

  if (executions.length === 0) {
    return <p className="text-sm text-on-surface-variant text-center py-10">{t('workflows.history.empty')}</p>;
  }

  return (
    <div className="flex flex-col gap-2 max-h-96 overflow-y-auto">
      {executions.map((exec) => {
        const { icon, className } = statusIconFor(exec.status);
        // Only show retry-relevance chrome when it's actually informative —
        // don't clutter every row with a "0 attempts" badge (Rohan's spec).
        const showRetryStatus = (exec.attempt_count ?? 0) > 0 || exec.dead_letter;
        const isRetrying = retryingId === exec.id;
        const lastRetryResult = retryResult?.id === exec.id ? retryResult : null;

        return (
          <div key={exec.id} className="flex flex-col gap-2 p-3 rounded-xl bg-surface-container-low">
            <div className="flex items-center gap-3">
              <Icon name={icon} size={18} className={className} />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-on-surface">
                  {new Date(exec.triggered_at).toLocaleString()}
                </p>
                <p className="text-xs text-on-surface-variant">
                  {statusLabelFor(t, exec.status)} · {t('workflows.history.stepCount', { count: exec.step_count })}
                  {exec.duration_ms != null && ` · ${exec.duration_ms}ms`}
                </p>
                {exec.error_message && (
                  <div className="text-xs text-error mt-1">
                    <p>{exec.error_message.message}</p>
                    {exec.error_message.matched && exec.error_message.raw !== exec.error_message.message && (
                      <details className="mt-0.5">
                        <summary className="cursor-pointer text-on-surface-variant hover:text-on-surface">
                          {t('workflows.history.technicalDetails')}
                        </summary>
                        <p className="mt-0.5 font-mono text-[11px] text-on-surface-variant break-all">{exec.error_message.raw}</p>
                      </details>
                    )}
                  </div>
                )}
                {showRetryStatus && (
                  <p className={`text-xs mt-1 font-medium ${exec.dead_letter ? 'text-error' : 'text-warning'}`}>
                    {exec.dead_letter ? t('workflows.history.retriesExhausted') : t('workflows.history.willRetry')}
                  </p>
                )}
                {lastRetryResult && (
                  <p className={`text-xs mt-1 ${lastRetryResult.success ? 'text-success' : 'text-error'}`}>
                    {lastRetryResult.success ? t('workflows.history.retrySucceeded') : t('workflows.history.retryFailed')}
                  </p>
                )}
              </div>
              {exec.status === 'failed' && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={isRetrying}
                  onClick={() => handleRetry(exec.id)}
                  className="shrink-0"
                >
                  {isRetrying ? t('workflows.history.retrying') : t('workflows.history.retryButton')}
                </Button>
              )}
            </div>
            {exec.steps?.length > 0 && (
              <div className="flex flex-col">
                {exec.steps.map((step) => <ExecutionStepRow key={step.nodeId} step={step} />)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Human-readable one-line summary of an audit event's `summary` jsonb blob.
// The backend's diffChangedFields shape is `{ field: { before, after } }` for
// 'updated'/'created' events; 'status_changed' carries `{ status: { after } }`.
function auditSummaryLine(t: (k: string, vars?: Record<string, unknown>) => string, event: WorkflowAuditEvent): string {
  const summary = event.summary ?? {};
  if (event.action === 'created') {
    const name = (summary as { name?: string }).name;
    return name ? t('workflows.auditLog.summaryCreatedWithName', { name }) : t('workflows.auditLog.action.created');
  }
  if (event.action === 'deleted') {
    const name = (summary as { name?: string }).name;
    return name ? t('workflows.auditLog.summaryDeletedWithName', { name }) : t('workflows.auditLog.action.deleted');
  }
  if (event.action === 'status_changed') {
    const status = (summary as { status?: { after?: string } }).status?.after;
    return status ? t('workflows.auditLog.summaryStatusChange', { status }) : t('workflows.auditLog.action.status_changed');
  }
  // 'updated' — count the changed fields (excluding bookkeeping columns the
  // backend already strips before writing the diff).
  const count = Object.keys(summary).length;
  if (count === 0) return t('workflows.auditLog.action.updated');
  return count === 1
    ? t('workflows.auditLog.summaryFieldsChangedOne')
    : t('workflows.auditLog.summaryFieldsChanged', { count, s: 's' });
}

// Audit trail (Wave 11, Nina — TRACKER.md Wave 11 Part 1, GET
// /:id/audit-log). A minimal paginated list — actor, action, timestamp,
// one-line summary of what changed. The backend/data model is the
// substantive work here; this is deliberately a straightforward list view,
// not an elaborate diff viewer.
function AuditLogHistory({ workflow }: { workflow: Workflow }) {
  const { t } = useTranslation();
  const api = useApi();
  const [events, setEvents] = useState<WorkflowAuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);

  useEffect(() => {
    setLoading(true);
    setLoadError(false);
    api.getWorkflowAuditLog(workflow.id, { page: 1 })
      .then((res) => {
        setEvents(res.events);
        setPage(res.page);
        setHasMore(res.page < res.pages);
      })
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, workflow.id]);

  function loadMore() {
    setLoadingMore(true);
    api.getWorkflowAuditLog(workflow.id, { page: page + 1 })
      .then((res) => {
        setEvents((prev) => [...prev, ...res.events]);
        setPage(res.page);
        setHasMore(res.page < res.pages);
      })
      .catch(() => setLoadError(true))
      .finally(() => setLoadingMore(false));
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-10">
        <div className="w-6 h-6 rounded-full border-2 border-t-transparent animate-spin border-primary" />
      </div>
    );
  }

  if (loadError) {
    return <p className="text-sm text-error text-center py-10">{t('workflows.auditLog.loadError')}</p>;
  }

  if (events.length === 0) {
    return <p className="text-sm text-on-surface-variant text-center py-10">{t('workflows.auditLog.empty')}</p>;
  }

  return (
    <div className="flex flex-col gap-2 max-h-96 overflow-y-auto" data-testid="audit-log-list">
      {events.map((event) => (
        <div key={event.id} className="flex items-start gap-3 p-3 rounded-xl bg-surface-container-low" data-testid={`audit-log-event-${event.id}`}>
          <Icon name="manage_history" size={18} className="text-on-surface-variant mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-on-surface">
              {event.actorUserId ?? t('workflows.auditLog.unknownActor')}
              <span className="font-normal text-on-surface-variant"> · {t(`workflows.auditLog.action.${event.action}`)}</span>
            </p>
            <p className="text-xs text-on-surface-variant">{auditSummaryLine(t, event)}</p>
            <p className="text-xs text-on-surface-variant">{new Date(event.createdAt).toLocaleString()}</p>
          </div>
        </div>
      ))}
      {hasMore && (
        <Button variant="outline" size="sm" disabled={loadingMore} onClick={loadMore} className="self-center mt-1">
          {loadingMore ? t('workflows.auditLog.loadingMore') : t('workflows.auditLog.loadMore')}
        </Button>
      )}
    </div>
  );
}

// Workflows paused awaiting human approval (flow.approval step).
function PendingApprovals() {
  const { t } = useTranslation();
  const api = useApi();
  const [approvals, setApprovals] = useState<Array<{ id: string; execution_id: string; workflow_name: string; requested_at: string }>>([]);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    api.listWorkflowApprovals().then(({ approvals }) => setApprovals(approvals)).catch(() => {});
  }, [api]);

  if (approvals.length === 0) return null;

  async function decide(execId: string, decision: 'approve' | 'reject') {
    setBusy(execId);
    try { await api.decideApproval(execId, decision); setApprovals((p) => p.filter((a) => a.execution_id !== execId)); }
    catch { /* ignore */ }
    finally { setBusy(null); }
  }

  return (
    <div className="mb-8">
      <p className="label-caps mb-3">{t('workflows.approvals.heading')}</p>
      <div className="flex flex-col gap-2">
        {approvals.map((a) => (
          <Card key={a.id} className="p-4 rounded-2xl bg-white border-0 flex items-center gap-3" style={{ boxShadow: '0 4px 20px rgba(0,0,0,0.04)' }}>
            <Icon name="approval" size={20} className="text-warning" />
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-on-surface truncate">{a.workflow_name}</p>
              <p className="text-xs text-on-surface-variant">{t('workflows.approvals.waiting')}</p>
            </div>
            <Button variant="outline" size="sm" disabled={busy === a.execution_id} onClick={() => decide(a.execution_id, 'approve')}>
              {t('workflows.approvals.approve')}
            </Button>
            <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" disabled={busy === a.execution_id} onClick={() => decide(a.execution_id, 'reject')}>
              {t('workflows.approvals.reject')}
            </Button>
          </Card>
        ))}
      </div>
    </div>
  );
}

// Pre-built workflow templates — navigates into a builder pre-filled with the
// template; nothing is persisted until the user explicitly saves there (Wave 9,
// see docs/automation-hub/TEMPLATE_FLOW_AND_RECIPIENT_TARGETING_SPEC.md §Issue 1).
// This click is a synchronous navigation only — no API call, no loading state,
// no invalidate() — since no mutation happens here anymore.
function WorkflowTemplates() {
  const { t } = useTranslation();
  const api = useApi();
  const navigate = useNavigate();
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);

  useEffect(() => {
    api.listWorkflowTemplates().then(({ templates }) => setTemplates(templates)).catch(() => {});
  }, [api]);

  if (templates.length === 0) return null;

  function useTemplate(tpl: WorkflowTemplate) {
    const nodes = (tpl.nodes ?? []) as EngineNode[];
    const edges = (tpl.edges ?? []) as EngineEdge[];
    const target = resolveEditRoute(nodes, edges);
    navigate(target, {
      state: {
        seed: {
          name: tpl.name,
          description: tpl.description,
          triggerType: tpl.trigger_type ?? undefined,
          nodes,
          edges,
        },
      },
    });
  }

  return (
    <div className="mb-8">
      <p className="label-caps mb-3">{t('workflows.templatesHeading')}</p>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {templates.map((tpl) => (
          <Card key={tpl.slug} className="p-4 rounded-2xl bg-white border-0" style={{ boxShadow: '0 4px 20px rgba(0,0,0,0.04)' }}>
            <div className="flex items-start justify-between gap-2">
              <p className="font-bold text-on-surface">{tpl.name}</p>
              {tpl.is_featured && <Badge variant="purple" className="text-[10px]">{t('workflows.featured')}</Badge>}
            </div>
            <p className="text-sm text-on-surface-variant mt-1 mb-3">{tpl.description}</p>
            <Button variant="outline" size="sm" onClick={() => useTemplate(tpl)}>
              <Icon name="add" size={14} className="mr-1" />
              {t('workflows.useTemplate')}
            </Button>
          </Card>
        ))}
      </div>
    </div>
  );
}
