/**
 * CrystalPanel — action execution and navigation tests.
 *
 * Strategy: render CrystalPanel with isOpen=true via mocked context,
 * then trigger SSE `action_proposals` via a mocked fetch to populate
 * actionProposals state, and click the "Apply" button to exercise
 * each executeAction branch.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

// ── vi.mock calls MUST be at the top level (hoisted by vitest) ────────────────

vi.mock('../../lib/i18n', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

vi.mock('framer-motion', () => ({
  motion: {
    div:     (p: React.HTMLAttributes<HTMLDivElement> & { children?: React.ReactNode }) => <div {...p} />,
    section: (p: React.HTMLAttributes<HTMLElement>   & { children?: React.ReactNode }) => <section {...p} />,
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../../contexts/pageTitle', () => ({ useSetPageTitle: vi.fn() }));
vi.mock('../../hooks/useSurveys',   () => ({ useSurveys: vi.fn() }));

// ── Shared insight components that CrystalPanel imports ──────────────────────
vi.mock('../../pages/insights/shared', () => ({
  GlassCard: ({ children, className, style }: React.ComponentProps<'div'>) => (
    <div className={className} style={style}>{children}</div>
  ),
  CitationChip: ({ id }: { id: string }) => <span data-testid={`citation-${id}`}>{id}</span>,
  ConfidenceChip: ({ value }: { value: number }) => <span>{value}</span>,
  SENTIMENT_BORDER: { positive: '#16a34a', negative: '#dc2626', neutral: '#94a3b8', mixed: '#d97706' },
}));

// ── Icon — render as a plain span so tests don't need the webfont ─────────────
vi.mock('../../components/Icon', () => ({
  Icon: ({ name }: { name: string }) => <span data-icon={name} />,
}));

// ── InsightDocumentCard — stub so CrystalPanel's document rendering doesn't ──
// ── need a full DOM environment for PDF/doc previews ─────────────────────────
vi.mock('../../components/insights/InsightDocumentCard', () => ({
  InsightDocumentCard: ({ doc }: { doc: { title?: string | null } }) => (
    <div data-testid="insight-document-card">{doc.title ?? ''}</div>
  ),
}));

// ── Stable mock references for crystalPanel context ──────────────────────────
const mockCloseCrystal  = vi.fn();
const mockSetScope      = vi.fn();
const mockSetCrystalCtx = vi.fn();

vi.mock('../../contexts/crystalPanel', () => ({
  useCrystalPanel: vi.fn(() => ({
    isOpen:          true,
    initialQuery:    '',
    crystalCtx:      {},
    scope:           'survey-abc',
    agenticInsights: [],
    topics:          [],
    closeCrystal:    mockCloseCrystal,
    setScope:        mockSetScope,
    setCrystalCtx:   mockSetCrystalCtx,
    openCrystal:     vi.fn(),
    toggleCrystal:   vi.fn(),
    setCrystalData:  vi.fn(),
  })),
}));

// ── Stable API mock ───────────────────────────────────────────────────────────
const mockApi = {
  startRun:                 vi.fn().mockResolvedValue({ run_id: 'run-123' }),
  getInsightRunStatus:      vi.fn().mockResolvedValue({ run_id: 'run-456', status: 'completed', stream_events: [] }),
  copilotRefine:            vi.fn().mockResolvedValue({}),
  createWorkflow:           vi.fn().mockResolvedValue({ id: 'wf-1' }),
  createGraphWorkflow:      vi.fn().mockResolvedValue({ workflow: { id: 'wf-graph-1' } }),
  createAlertRule:          vi.fn().mockResolvedValue({ rule: { id: 'al-1' } }),
  triggerInsightGeneration: vi.fn().mockResolvedValue({}),
  dismissAction:            vi.fn().mockResolvedValue({}),
  recordProposalOutcome:    vi.fn().mockResolvedValue(undefined),
  crystalChat:              vi.fn().mockResolvedValue({ answer: 'ok', suggestions: [], insight_refs: [] }),
  crystalChat2:             vi.fn().mockResolvedValue({ answer: 'ok', suggestions: [], insight_refs: [] }),
  updateInsightFeedback:    vi.fn().mockResolvedValue({}),
};

// ── Capture client-side navigation (replaces window.location.href) ────────────
const mockNavigate = vi.fn();
vi.mock('react-router-dom', async (importActual) => {
  const actual = await importActual<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('../../hooks/useApi', () => ({
  useApi:  () => mockApi,
  default: () => mockApi,
}));

// ── Auth mock ─────────────────────────────────────────────────────────────────
vi.mock('../../lib/auth', () => ({
  useAppAuth: () => ({
    userId:     'dev-user',
    orgId:      'dev-org',
    isSignedIn: true,
    isLoaded:   true,
    getToken:   vi.fn().mockResolvedValue('tok'),
    signOut:    vi.fn(),
  }),
  AppAuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// ── import component AFTER all vi.mock declarations ──────────────────────────
import { CrystalPanel, resolveReportProposalAction } from '../../components/CrystalPanel';
import { useCrystalPanel } from '../../contexts/crystalPanel';
import type { ActionProposal } from '../../types';

// ── Helper: build a minimal ActionProposal ────────────────────────────────────
function makeProposal(overrides: Partial<ActionProposal> = {}): ActionProposal {
  return {
    id:                    'ap-1',
    type:                  'create_survey',
    priority:              'medium',
    title:                 'Create follow-up survey',
    description:           'Capture NPS detractor feedback',
    cta_label:             'Apply',
    params:                {},
    requires_confirmation: true,
    ...overrides,
  };
}

// ── Minimal survey ────────────────────────────────────────────────────────────
const SURVEY = {
  id:             'survey-abc',
  title:          'Customer NPS',
  status:         'active' as const,
  response_count: 100,
  nps_score:      42,
  deleted_at:     null,
  updated_at:     '2026-01-01T00:00:00Z',
  sparkline:      [],
};

// ── SSE stream factory ────────────────────────────────────────────────────────

function makeSseStream(events: object[], trailingDone = true): ReadableStream {
  const lines = [
    ...events.map(e => `data: ${JSON.stringify(e)}`),
    ...(trailingDone ? ['data: [DONE]'] : []),
  ].join('\n') + '\n';

  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(lines));
      controller.close();
    },
  });
}

function mockFetchWithAnswer(proposals: ActionProposal[] = []) {
  const events: object[] = [
    { type: 'answer', answer: 'Test answer', suggestions: [], citations: [] },
    ...(proposals.length ? [{ type: 'action_proposals', proposals }] : []),
  ];
  const stream = makeSseStream(events);
  return vi.fn().mockResolvedValue({ ok: true, body: stream });
}

// ── Window.location mock ──────────────────────────────────────────────────────
const mockHrefSetter = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();

  // Reset API mocks
  mockApi.startRun.mockResolvedValue({ run_id: 'run-123' });
  mockApi.getInsightRunStatus.mockResolvedValue({ run_id: 'run-456', status: 'completed', stream_events: [] });
  mockApi.copilotRefine.mockResolvedValue({});
  mockApi.createWorkflow.mockResolvedValue({ id: 'wf-1' });
  mockApi.createGraphWorkflow.mockResolvedValue({ workflow: { id: 'wf-graph-1' } });
  mockApi.triggerInsightGeneration.mockResolvedValue({});
  mockApi.dismissAction.mockResolvedValue({});

  // Reset context mock to default (survey-abc scope)
  vi.mocked(useCrystalPanel).mockReturnValue({
    isOpen:          true,
    initialQuery:    '',
    crystalCtx:      {},
    scope:           'survey-abc',
    agenticInsights: [],
    topics:          [],
    closeCrystal:    mockCloseCrystal,
    setScope:        mockSetScope,
    setCrystalCtx:   mockSetCrystalCtx,
    openCrystal:     vi.fn(),
    toggleCrystal:   vi.fn(),
    setCrystalData:  vi.fn(),
  });

  // Mock window.location.href setter
  Object.defineProperty(window, 'location', {
    value: { ...window.location, href: '' },
    writable: true,
  });
  vi.spyOn(window.location, 'href', 'set').mockImplementation(mockHrefSetter);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ── render + submit helpers ───────────────────────────────────────────────────

function renderPanel(scope = 'survey-abc') {
  return render(
    <MemoryRouter>
      <CrystalPanel
        scope={scope as 'all' | string}
        surveys={[SURVEY]}
        insights={null}
        agenticInsights={[]}
        topics={[]}
      />
    </MemoryRouter>,
  );
}

/** Submit a query and wait for proposals to appear in the DOM. */
async function triggerProposals(proposals: ActionProposal[]) {
  global.fetch = mockFetchWithAnswer(proposals);
  renderPanel();

  const user = userEvent.setup();
  const textarea = screen.getByPlaceholderText(/ask anything/i);
  await user.type(textarea, 'test query');
  await user.keyboard('{Enter}');

  if (proposals.length > 0) {
    await waitFor(
      () => expect(screen.getByText(proposals[0].title)).toBeInTheDocument(),
      { timeout: 4000 },
    );
  } else {
    await waitFor(
      () => expect(screen.getByText('Test answer')).toBeInTheDocument(),
      { timeout: 4000 },
    );
  }
}

// ═════════════════════════════════════════════════════════════════════════════
describe('CrystalPanel — action proposals rendering', () => {
// ═════════════════════════════════════════════════════════════════════════════

  it('renders action proposals received via SSE', async () => {
    const proposals = [
      makeProposal({ id: 'ap-1', title: 'Create NPS follow-up', type: 'create_survey' }),
      makeProposal({ id: 'ap-2', title: 'Distribute to mobile users', type: 'distribute' }),
    ];

    await triggerProposals(proposals);

    expect(screen.getByText('Create NPS follow-up')).toBeInTheDocument();
    expect(screen.getByText('Distribute to mobile users')).toBeInTheDocument();
    const applyButtons = screen.getAllByRole('button', { name: /apply/i });
    expect(applyButtons.length).toBeGreaterThanOrEqual(2);
  });

  it('hides action proposals when dismissed', async () => {
    const proposal = makeProposal({ id: 'ap-dismiss', title: 'Send to segment' });

    await triggerProposals([proposal]);

    const user = userEvent.setup();
    const dismissButton = screen.getByRole('button', { name: /dismiss/i });
    await user.click(dismissButton);

    await waitFor(() => {
      expect(screen.queryByText('Send to segment')).not.toBeInTheDocument();
    });

    // Dismissal is tracked via the outcome-telemetry funnel (recordProposalOutcome
    // with status: 'dismissed'), not a dedicated dismissAction API call — matches
    // CrystalPanel.tsx's actual dismissAction callback (see component source).
    await waitFor(() => {
      expect(mockApi.recordProposalOutcome).toHaveBeenCalledWith(
        'survey-abc',
        expect.objectContaining({ proposalKey: 'ap-dismiss', status: 'dismissed' }),
      );
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('CrystalPanel — action execution: navigation', () => {
// ═════════════════════════════════════════════════════════════════════════════

  it('create_survey action calls api.startRun and navigates to /surveys?run=...', async () => {
    const proposal = makeProposal({
      id:     'ap-cs',
      type:   'create_survey',
      title:  'Create follow-up survey',
      params: { intent: 'Follow up with detractors' },
    });

    await triggerProposals([proposal]);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /apply/i }));

    await waitFor(() => {
      expect(mockApi.startRun).toHaveBeenCalledWith({
        intent:       'Follow up with detractors',
        surveyTypeId: undefined,
      });
    });

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith(
        '/app/surveys/new/build',
        expect.objectContaining({ state: expect.objectContaining({ runId: 'run-123' }) }),
      );
    });
  });

  it('create_followup_survey uses intent from params', async () => {
    const proposal = makeProposal({
      id:     'ap-cfs',
      type:   'create_followup_survey',
      title:  'Follow-up survey for NPS detractors',
      params: { intent: 'Follow up with NPS detractors', survey_type: 'nps' },
    });

    await triggerProposals([proposal]);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /apply/i }));

    await waitFor(() => {
      expect(mockApi.startRun).toHaveBeenCalledWith({
        intent:       'Follow up with NPS detractors',
        surveyTypeId: 'nps',
      });
    });

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith(
        '/app/surveys/new/build',
        expect.objectContaining({ state: expect.objectContaining({ runId: 'run-123' }) }),
      );
    });
  });

  it('distribute action navigates to build page with distribute tab', async () => {
    const proposal = makeProposal({
      id:     'ap-dist',
      type:   'distribute',
      params: {},
    });

    await triggerProposals([proposal]);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /apply/i }));

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith(
        '/app/surveys/survey-abc/build',
        expect.objectContaining({ state: expect.objectContaining({ openTab: 'distribute' }) }),
      );
    });

    expect(mockApi.startRun).not.toHaveBeenCalled();
  });

  it('distribute_to_segment also navigates to distribute tab', async () => {
    const proposal = makeProposal({
      id:     'ap-dts',
      type:   'distribute_to_segment',
      params: {},
    });

    await triggerProposals([proposal]);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /apply/i }));

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith(
        '/app/surveys/survey-abc/build',
        expect.objectContaining({ state: expect.objectContaining({ openTab: 'distribute' }) }),
      );
    });
  });

  it('view_template action navigates to /templates', async () => {
    const proposal = makeProposal({
      id:     'ap-vt',
      type:   'view_template',
      params: {},
    });

    await triggerProposals([proposal]);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /apply/i }));

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/app/templates');
    });
  });

  it('edit_survey action calls getInsightRunStatus, copilotRefine, then navigates to builder', async () => {
    const proposal = makeProposal({
      id:     'ap-es',
      type:   'edit_survey',
      params: { message: 'Add a demographic question' },
    });

    await triggerProposals([proposal]);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /apply/i }));

    await waitFor(() => {
      expect(mockApi.getInsightRunStatus).toHaveBeenCalledWith('survey-abc');
    });

    await waitFor(() => {
      expect(mockApi.copilotRefine).toHaveBeenCalledWith('run-456', {
        message:   'Add a demographic question',
        questions: [],
      });
    });

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith(
        '/app/surveys/survey-abc/build',
        expect.objectContaining({ state: expect.objectContaining({ runId: 'run-456' }) }),
      );
    });
  });

  it('edit_survey_questions also triggers copilotRefine flow', async () => {
    const proposal = makeProposal({
      id:     'ap-esq',
      type:   'edit_survey_questions',
      params: { questions_to_add: ['How likely to recommend?', 'Why?'] },
    });

    await triggerProposals([proposal]);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /apply/i }));

    await waitFor(() => {
      expect(mockApi.copilotRefine).toHaveBeenCalledWith(
        'run-456',
        expect.objectContaining({ questions: [] }),
      );
    });

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith(
        '/app/surveys/survey-abc/build',
        expect.objectContaining({ state: expect.objectContaining({ runId: 'run-456' }) }),
      );
    });
  });

  it('create_alert records the proposal outcome funnel (accepted → succeeded)', async () => {
    const proposal = makeProposal({
      id:    'ap-track',
      type:  'create_alert',
      title: 'Alert on NPS below 30',
      params: { alert_type: 'S-03', threshold_config: { below: 30 } },
    });

    await triggerProposals([proposal]);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /apply/i }));

    await waitFor(() => {
      expect(mockApi.recordProposalOutcome).toHaveBeenCalledWith(
        'survey-abc',
        expect.objectContaining({ proposalKey: 'ap-track', status: 'accepted' }),
      );
    });
    await waitFor(() => {
      expect(mockApi.recordProposalOutcome).toHaveBeenCalledWith(
        'survey-abc',
        expect.objectContaining({ proposalKey: 'ap-track', status: 'succeeded' }),
      );
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('CrystalPanel — action execution: in-app actions', () => {
// ═════════════════════════════════════════════════════════════════════════════

  it('create_workflow calls api.createGraphWorkflow with the modern graph shape', async () => {
    // Modern shape emitted by CrystalOS's reconciled `execute_propose_workflow`
    // (Wave 3): params.nodes/params.edges/params.trigger_type (snake_case on
    // the wire), not the old flat trigger/action_type/action_config shape.
    const nodes = [{ id: 'n1', type: 'trigger', data: {} }];
    const edges: unknown[] = [];
    const proposal = makeProposal({
      id:    'ap-wf',
      type:  'create_workflow',
      title: 'Alert on NPS drop',
      description: 'When NPS drops below 6, notify the team',
      params: {
        name:          'NPS Drop Alert',
        description:   'When NPS drops below 6, notify the team',
        trigger_type:  'response_submitted',
        nodes,
        edges,
      },
    });

    await triggerProposals([proposal]);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /apply/i }));

    await waitFor(() => {
      expect(mockApi.createGraphWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({
          name:        'NPS Drop Alert',
          description: 'When NPS drops below 6, notify the team',
          triggerType: 'response_submitted',
          nodes,
          edges,
          status:      'draft',
        }),
      );
      expect(mockApi.createWorkflow).not.toHaveBeenCalled();
    });
  });

  it('create_workflow adds a confirmation message after success (graph shape)', async () => {
    const proposal = makeProposal({
      id:    'ap-wf2',
      type:  'create_workflow',
      title: 'Auto-alert on churn',
      params: { trigger_type: 'crystal.churn_risk', nodes: [{ id: 'n1' }], edges: [] },
    });

    await triggerProposals([proposal]);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /apply/i }));

    await waitFor(() => {
      expect(screen.getByText(/Workflow created/i)).toBeInTheDocument();
    });
  });

  it('create_workflow falls back to the legacy flat shape when a stale proposal lacks nodes/edges', async () => {
    // Regression guard: a stale/cached proposal from before the Wave 3
    // reconciliation may still carry the old flat shape. It must not crash —
    // it should fall back to api.createWorkflow() rather than the graph path.
    const proposal = makeProposal({
      id:    'ap-wf-legacy',
      type:  'create_workflow',
      title: 'Alert on NPS drop (legacy)',
      params: {
        name:          'NPS Drop Alert',
        trigger:       'nps_below_6',
        action_type:   'notify',
        action_config: {},
      },
    });

    await triggerProposals([proposal]);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /apply/i }));

    await waitFor(() => {
      expect(mockApi.createWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({
          name:        'NPS Drop Alert',
          trigger:     'nps_below_6',
          action_type: 'notify',
          survey_id:   'survey-abc',
          enabled:     true,
        }),
      );
      expect(mockApi.createGraphWorkflow).not.toHaveBeenCalled();
    });
  });

  it('create_alert calls api.createAlertRule with mapped params', async () => {
    const proposal = makeProposal({
      id:    'ap-alert',
      type:  'create_alert',
      title: 'Alert on NPS below 30',
      params: {
        alert_type:       'S-03',
        name:             'NPS Threshold Alert',
        severity:         'critical',
        threshold_config: { below: 30 },
      },
    });

    await triggerProposals([proposal]);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /apply/i }));

    await waitFor(() => {
      expect(mockApi.createAlertRule).toHaveBeenCalledWith(
        expect.objectContaining({
          alertType:       'S-03',
          name:            'NPS Threshold Alert',
          severity:        'critical',
          thresholdConfig: { below: 30 },
        }),
      );
    });
  });

  it('schedule_rerun calls triggerInsightGeneration with manual trigger', async () => {
    const proposal = makeProposal({
      id:     'ap-sr',
      type:   'schedule_rerun',
      params: {},
    });

    await triggerProposals([proposal]);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /apply/i }));

    await waitFor(() => {
      expect(mockApi.triggerInsightGeneration).toHaveBeenCalledWith('survey-abc', { trigger: 'manual' });
    });
  });

  it('schedule_rerun adds a confirmation message after success', async () => {
    const proposal = makeProposal({
      id:     'ap-sr2',
      type:   'schedule_rerun',
      params: {},
    });

    await triggerProposals([proposal]);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /apply/i }));

    await waitFor(() => {
      expect(screen.getByText(/Insight regeneration triggered/i)).toBeInTheDocument();
    });
  });

  it('unknown action type falls back to submitQuery with "Help me with: <title>"', async () => {
    const proposal = makeProposal({
      id:     'ap-fallback',
      // 'export_insights' has no explicit case — hits the default branch
      type:   'export_insights' as ActionProposal['type'],
      title:  'Export my report',
      params: {},
    });

    let fetchCallCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      fetchCallCount++;
      const isFirst = fetchCallCount === 1;
      const events: object[] = isFirst
        ? [
            { type: 'answer', answer: 'Here are your options', suggestions: [], citations: [] },
            { type: 'action_proposals', proposals: [proposal] },
          ]
        : [
            { type: 'answer', answer: 'Here is help with export', suggestions: [], citations: [] },
          ];
      const stream = makeSseStream(events);
      return Promise.resolve({ ok: true, body: stream });
    });

    renderPanel();

    const user = userEvent.setup();
    const textarea = screen.getByPlaceholderText(/ask anything/i);
    await user.type(textarea, 'help');
    await user.keyboard('{Enter}');

    await waitFor(
      () => expect(screen.getByText('Export my report')).toBeInTheDocument(),
      { timeout: 4000 },
    );

    await user.click(screen.getByRole('button', { name: /apply/i }));

    // A second fetch should fire for the follow-up query
    await waitFor(() => {
      expect(fetchCallCount).toBeGreaterThan(1);
    }, { timeout: 4000 });

    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const secondBody = JSON.parse(calls[1][1].body as string);
    expect(secondBody.message).toBe('Help me with: Export my report');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('CrystalPanel — scope propagation', () => {
// ═════════════════════════════════════════════════════════════════════════════

  it('sends survey_id in request body when scoped to a specific survey', async () => {
    global.fetch = mockFetchWithAnswer();
    renderPanel('survey-abc');

    const user = userEvent.setup();
    const textarea = screen.getByPlaceholderText(/ask anything/i);
    await user.type(textarea, 'what is happening?');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled();
    });

    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.survey_id).toBe('survey-abc');
  });

  it('sends scope=org and survey_id="" when isAll=true (scope="all")', async () => {
    // Override the context mock to simulate org scope
    vi.mocked(useCrystalPanel).mockReturnValue({
      isOpen:          true,
      initialQuery:    '',
      crystalCtx:      {},
      scope:           'all',
      agenticInsights: [],
      topics:          [],
      closeCrystal:    mockCloseCrystal,
      setScope:        mockSetScope,
      setCrystalCtx:   mockSetCrystalCtx,
      openCrystal:     vi.fn(),
      toggleCrystal:   vi.fn(),
      setCrystalData:  vi.fn(),
    });

    global.fetch = mockFetchWithAnswer();
    renderPanel('all');

    const user = userEvent.setup();
    const textarea = screen.getByPlaceholderText(/ask anything/i);
    await user.type(textarea, 'portfolio question');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled();
    });

    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.scope).toBe('org');
    // survey_id must be '' — never 'all'
    expect(body.survey_id).toBe('');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('resolveReportProposalAction — Phase 6 insight proposal dispatch', () => {
// ═════════════════════════════════════════════════════════════════════════════

  it('view_report with an explicit url → navigate to that url', () => {
    const p = makeProposal({ type: 'view_report', params: { url: '/app/surveys/s1/intelligence/reports/r9' } });
    expect(resolveReportProposalAction(p, 's1')).toEqual({
      kind: 'navigate',
      url: '/app/surveys/s1/intelligence/reports/r9',
    });
  });

  it('view_report with report_id (no url) → navigate to the built INSIGHT_REPORT route', () => {
    const p = makeProposal({ type: 'view_report', params: { report_id: 'r9' } });
    const intent = resolveReportProposalAction(p, 's1');
    expect(intent.kind).toBe('navigate');
    expect(intent).toMatchObject({ kind: 'navigate' });
    if (intent.kind === 'navigate') {
      expect(intent.url).toContain('s1');
      expect(intent.url).toContain('r9');
    }
  });

  it('view_report with neither url nor report_id → noop with a reason', () => {
    const p = makeProposal({ type: 'view_report', params: {} });
    const intent = resolveReportProposalAction(p, 's1');
    expect(intent.kind).toBe('noop');
  });

  it('trigger_manual_insight_run → open_dialog with the parsed mode (quick)', () => {
    const p = makeProposal({ type: 'trigger_manual_insight_run', params: { mode: 'manual_quick' } });
    expect(resolveReportProposalAction(p, 's1')).toEqual({ kind: 'open_dialog', mode: 'quick' });
  });

  it('trigger_manual_insight_run defaults to expert when no mode is given', () => {
    const p = makeProposal({ type: 'trigger_manual_insight_run', params: {} });
    expect(resolveReportProposalAction(p, 's1')).toEqual({ kind: 'open_dialog', mode: 'expert' });
  });

  it('generate_intelligence_report → open_dialog in expert mode', () => {
    const p = makeProposal({ type: 'generate_intelligence_report', params: { estimated_credits: 5 } });
    expect(resolveReportProposalAction(p, 's1')).toEqual({ kind: 'open_dialog', mode: 'expert' });
  });

  it('manual-run proposals require a survey in scope → noop when surveyId is undefined', () => {
    const p = makeProposal({ type: 'generate_intelligence_report', params: {} });
    expect(resolveReportProposalAction(p, undefined)).toMatchObject({ kind: 'noop' });
  });
});
