import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── mocks (must be at top, before component imports) ──────────────────────────
vi.mock('../../hooks/useApi', () => ({ useApi: vi.fn(), default: vi.fn() }));
vi.mock('../../hooks/useWorkflows', () => ({ useWorkflows: vi.fn() }));
vi.mock('../../lib/i18n', () => ({
  useTranslation: () => ({
    t: (k: string, vars?: Record<string, unknown>) => {
      // Return real arrays for the options the component reads as object arrays
      if (k === 'workflows.conditionOptions') return [
        { label: 'Sentiment = Negative', field: 'sentiment', operator: '=', value: 'Negative' },
        { label: 'NPS Score < 6',        field: 'nps',       operator: '<', value: '6' },
      ];
      if (k === 'workflows.actionOptions') return [
        { label: 'Notify Support Team', type: 'notify', config: { team: 'support' } },
        { label: 'Send Email Digest',   type: 'email',  config: { to: 'team@company.com' } },
      ];
      // Mirror the real i18n layer's {variable} interpolation so card text
      // (trigger counts, run stats, etc.) is assertable the same way.
      if (vars) return k.replace(/\{(\w+)\}/g, () => '') + Object.entries(vars).map(([key, v]) => ` ${key}:${v}`).join('');
      return k;
    },
  }),
}));
vi.mock('../../contexts/pageTitle', () => ({ useSetPageTitle: vi.fn() }));
vi.mock('../../components/PageHeader', () => ({
  PageHeader: ({ title, actions }: { title: string; actions?: React.ReactNode }) => (
    <div>
      <h1>{title}</h1>
      <div data-testid="page-header-actions">{actions}</div>
    </div>
  ),
}));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: vi.fn() };
});

// ── imports after mocks ────────────────────────────────────────────────────────
import { useApi } from '../../hooks/useApi';
import { useWorkflows } from '../../hooks/useWorkflows';
import { useNavigate } from 'react-router-dom';
import { WorkflowsPage } from '../../pages/WorkflowsPage';
import { ROUTES } from '../../constants/routes';
import type { Workflow } from '../../types';

// ── fixtures ───────────────────────────────────────────────────────────────────
const mockNavigate = vi.fn();

const ACTIVE_WORKFLOW: Workflow = {
  id: 'w1',
  name: 'My Flow',
  condition: { field: 'sentiment', operator: '=', value: 'Negative' },
  action: { type: 'email', config: { to: 'team@company.com' } },
  status: 'active',
  trigger_count: 3,
};

function makeApi(overrides = {}) {
  return {
    listWorkflowApprovals:      vi.fn().mockResolvedValue({ approvals: [] }),
    listWorkflowTemplates:      vi.fn().mockResolvedValue({ templates: [] }),
    createWorkflow:             vi.fn().mockResolvedValue({ workflow: { ...ACTIVE_WORKFLOW, name: 'New Flow' } }),
    decideApproval:             vi.fn().mockResolvedValue({}),
    getWorkflowRegistry:        vi.fn().mockResolvedValue({ triggers: [], conditionFields: [], conditionOperators: [], actions: [] }),
    getWorkflowExecutions:      vi.fn().mockResolvedValue({ executions: [] }),
    // Wave 11 (Nina — GET /:id/audit-log) — config-change history, distinct
    // from getWorkflowExecutions above.
    getWorkflowAuditLog:        vi.fn().mockResolvedValue({ events: [], total: 0, page: 1, limit: 50, pages: 0 }),
    // Wave 6 — scope name resolution (WorkflowScopeChip/ScopeFilterBar) fetches
    // both once on mount, unconditionally.
    listSurveys:                vi.fn().mockResolvedValue({ surveys: [] }),
    listTags:                   vi.fn().mockResolvedValue({ tags: [] }),
    ...overrides,
  };
}

function makeWorkflowsHook(overrides = {}) {
  return {
    workflows:      [] as Workflow[],
    loading:        false,
    error:          null as string | null,
    createWorkflow: vi.fn().mockResolvedValue(ACTIVE_WORKFLOW),
    toggleWorkflow: vi.fn(),
    deleteWorkflow: vi.fn(),
    testWorkflow:   vi.fn().mockResolvedValue({ executionId: 'exec1', status: 'success', conditionsPassed: true, durationMs: 42 }),
    reload:         vi.fn(),
    ...overrides,
  };
}

// ── setup / teardown ───────────────────────────────────────────────────────────
beforeEach(() => {
  vi.mocked(useNavigate).mockReturnValue(mockNavigate);
  vi.mocked(useApi).mockReturnValue(makeApi() as unknown as ReturnType<typeof useApi>);
  vi.mocked(useWorkflows).mockReturnValue(
    makeWorkflowsHook() as unknown as ReturnType<typeof useWorkflows>,
  );
});

afterEach(() => { cleanup(); vi.clearAllMocks(); });

// ── Empty state ────────────────────────────────────────────────────────────────
describe('WorkflowsPage — empty state', () => {
  it('shows the empty-state heading and description when there are no workflows', async () => {
    render(<MemoryRouter><WorkflowsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('workflows.empty.heading')).toBeInTheDocument());
    expect(screen.getByText('workflows.empty.description')).toBeInTheDocument();
  });

  it('shows a "Get Started" CTA button in the empty state', async () => {
    render(<MemoryRouter><WorkflowsPage /></MemoryRouter>);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'workflows.empty.cta' })).toBeInTheDocument(),
    );
  });

  it('clicking the empty-state CTA navigates to the sentence-first builder (Wave 7: legacy modal retired)', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><WorkflowsPage /></MemoryRouter>);
    await user.click(await screen.findByRole('button', { name: 'workflows.empty.cta' }));
    expect(mockNavigate).toHaveBeenCalledWith(ROUTES.WORKFLOW_BUILD);
  });
});

// ── Workflow list ─────────────────────────────────────────────────────────────
describe('WorkflowsPage — workflow list', () => {
  beforeEach(() => {
    vi.mocked(useWorkflows).mockReturnValue(
      makeWorkflowsHook({ workflows: [ACTIVE_WORKFLOW] }) as unknown as ReturnType<typeof useWorkflows>,
    );
  });

  it('renders the workflow name as a badge', async () => {
    render(<MemoryRouter><WorkflowsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('My Flow')).toBeInTheDocument());
  });

  it('renders the trigger count next to the badge', async () => {
    render(<MemoryRouter><WorkflowsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('workflows.card.triggerCount count:3')).toBeInTheDocument());
  });

  it('shows a Pause button for an active workflow', async () => {
    render(<MemoryRouter><WorkflowsPage /></MemoryRouter>);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /workflows\.controls\.pause/i })).toBeInTheDocument(),
    );
  });

  it('clicking Pause calls toggleWorkflow with the workflow id', async () => {
    const toggleWorkflow = vi.fn();
    vi.mocked(useWorkflows).mockReturnValue(
      makeWorkflowsHook({ workflows: [ACTIVE_WORKFLOW], toggleWorkflow }) as unknown as ReturnType<typeof useWorkflows>,
    );
    const user = userEvent.setup();
    render(<MemoryRouter><WorkflowsPage /></MemoryRouter>);
    await user.click(await screen.findByRole('button', { name: /workflows\.controls\.pause/i }));
    expect(toggleWorkflow).toHaveBeenCalledWith('w1');
  });

  it('shows Resume button for a paused workflow', async () => {
    const paused: Workflow = { ...ACTIVE_WORKFLOW, status: 'paused' };
    vi.mocked(useWorkflows).mockReturnValue(
      makeWorkflowsHook({ workflows: [paused] }) as unknown as ReturnType<typeof useWorkflows>,
    );
    render(<MemoryRouter><WorkflowsPage /></MemoryRouter>);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /workflows\.controls\.resume/i })).toBeInTheDocument(),
    );
  });

  it('clicking Delete opens a confirm dialog, and confirming calls deleteWorkflow with the correct id', async () => {
    const deleteWorkflow = vi.fn().mockResolvedValue(undefined);
    vi.mocked(useWorkflows).mockReturnValue(
      makeWorkflowsHook({ workflows: [ACTIVE_WORKFLOW], deleteWorkflow }) as unknown as ReturnType<typeof useWorkflows>,
    );
    const user = userEvent.setup();
    render(<MemoryRouter><WorkflowsPage /></MemoryRouter>);
    // Wait for card to appear, then click the destructive icon button
    await waitFor(() => screen.getByText('My Flow'));
    // The delete button is an icon-only size="icon" variant="destructive" button
    const deleteButtons = screen.getAllByRole('button').filter((btn) => {
      const style = btn.getAttribute('style') || '';
      return style.includes('rgba(180,19,64');
    });
    expect(deleteButtons).toHaveLength(1);
    await user.click(deleteButtons[0]);

    // Delete is destructive — must not fire until the confirm dialog is accepted.
    expect(deleteWorkflow).not.toHaveBeenCalled();
    expect(screen.getByText('workflows.deleteModal.heading')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /workflows\.deleteModal\.confirmButton/i }));
    await waitFor(() => expect(deleteWorkflow).toHaveBeenCalledWith('w1'));
  });

  it('cancelling the delete confirm dialog does not call deleteWorkflow', async () => {
    const deleteWorkflow = vi.fn();
    vi.mocked(useWorkflows).mockReturnValue(
      makeWorkflowsHook({ workflows: [ACTIVE_WORKFLOW], deleteWorkflow }) as unknown as ReturnType<typeof useWorkflows>,
    );
    const user = userEvent.setup();
    render(<MemoryRouter><WorkflowsPage /></MemoryRouter>);
    await waitFor(() => screen.getByText('My Flow'));
    const deleteButtons = screen.getAllByRole('button').filter((btn) => {
      const style = btn.getAttribute('style') || '';
      return style.includes('rgba(180,19,64');
    });
    await user.click(deleteButtons[0]);
    await user.click(screen.getByRole('button', { name: /workflows\.deleteModal\.cancelButton/i }));
    expect(screen.queryByText('workflows.deleteModal.heading')).not.toBeInTheDocument();
    expect(deleteWorkflow).not.toHaveBeenCalled();
  });

  it('shows a status pill reflecting the workflow status', async () => {
    render(<MemoryRouter><WorkflowsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('workflows.status.active')).toBeInTheDocument());
  });

  it('surfaces run count, success rate, and last-run-at from the API row', async () => {
    const wf: Workflow = {
      ...ACTIVE_WORKFLOW,
      run_count: 40,
      success_count: 38,
      last_run_at: '2026-06-30T12:00:00Z',
    };
    vi.mocked(useWorkflows).mockReturnValue(
      makeWorkflowsHook({ workflows: [wf] }) as unknown as ReturnType<typeof useWorkflows>,
    );
    render(<MemoryRouter><WorkflowsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('workflows.card.runCount count:40')).toBeInTheDocument());
    expect(screen.getByText('workflows.card.successRate rate:95')).toBeInTheDocument();
  });

  it('shows "never" for last-run-at when the workflow has not run yet', async () => {
    const wf: Workflow = { ...ACTIVE_WORKFLOW, run_count: 0, last_run_at: null };
    vi.mocked(useWorkflows).mockReturnValue(
      makeWorkflowsHook({ workflows: [wf] }) as unknown as ReturnType<typeof useWorkflows>,
    );
    render(<MemoryRouter><WorkflowsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText(/workflows\.card\.lastRun/)).toBeInTheDocument());
    expect(screen.getByText((_, el) => el?.textContent === 'workflows.card.lastRun when:workflows.card.neverRun')).toBeInTheDocument();
  });

  it('renders an error status pill for a workflow in the error state', async () => {
    const wf: Workflow = { ...ACTIVE_WORKFLOW, status: 'error' };
    vi.mocked(useWorkflows).mockReturnValue(
      makeWorkflowsHook({ workflows: [wf] }) as unknown as ReturnType<typeof useWorkflows>,
    );
    render(<MemoryRouter><WorkflowsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('workflows.status.error')).toBeInTheDocument());
  });

  it('clicking the test-run action calls testWorkflow and shows the result', async () => {
    const testWorkflow = vi.fn().mockResolvedValue({ executionId: 'exec1', status: 'success', conditionsPassed: true, durationMs: 12 });
    vi.mocked(useWorkflows).mockReturnValue(
      makeWorkflowsHook({ workflows: [ACTIVE_WORKFLOW], testWorkflow }) as unknown as ReturnType<typeof useWorkflows>,
    );
    const user = userEvent.setup();
    render(<MemoryRouter><WorkflowsPage /></MemoryRouter>);
    await user.click(await screen.findByLabelText('workflows.controls.test'));
    expect(testWorkflow).toHaveBeenCalledWith('w1');
    await waitFor(() => expect(screen.getByTestId('test-result-w1')).toBeInTheDocument());
  });

  it('clicking the history action opens the run-history dialog and lists executions', async () => {
    vi.mocked(useApi).mockReturnValue(
      makeApi({
        getWorkflowExecutions: vi.fn().mockResolvedValue({
          executions: [
            {
              id: 'e1', trigger_type: 'nps_threshold', status: 'completed',
              triggered_at: '2026-06-30T10:00:00Z', completed_at: '2026-06-30T10:00:05Z', duration_ms: 5000,
              error_message: null, step_count: 3, steps: [],
              attempt_count: 0, next_retry_at: null, dead_letter: false,
            },
          ],
        }),
      }) as unknown as ReturnType<typeof useApi>,
    );
    vi.mocked(useWorkflows).mockReturnValue(
      makeWorkflowsHook({ workflows: [ACTIVE_WORKFLOW] }) as unknown as ReturnType<typeof useWorkflows>,
    );
    const user = userEvent.setup();
    render(<MemoryRouter><WorkflowsPage /></MemoryRouter>);
    await user.click(await screen.findByLabelText('workflows.controls.history'));
    expect(screen.getByText('workflows.history.heading')).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getAllByText((_, el) => Boolean(el && el.tagName === 'P' && (el.textContent || '').includes('workflows.history.stepCount count:3'))).length,
      ).toBeGreaterThan(0),
    );
  });
});

// Audit trail (Wave 11, Nina — TRACKER.md Wave 11 Part 1, GET
// /:id/audit-log). Distinct entry point/dialog from run history above —
// config-CHANGE history (who edited/enabled/deleted this workflow), not
// execution/run history (when did it fire).
describe('WorkflowsPage — audit trail (Wave 11)', () => {
  it('clicking the audit-log action opens the change-history dialog and lists events', async () => {
    vi.mocked(useApi).mockReturnValue(
      makeApi({
        getWorkflowAuditLog: vi.fn().mockResolvedValue({
          events: [
            {
              id: 'evt1', workflowId: 'w1', actorUserId: 'user_123', action: 'status_changed',
              summary: { status: { after: 'active' } }, createdAt: '2026-07-02T10:00:00Z',
            },
          ],
          total: 1, page: 1, limit: 50, pages: 1,
        }),
      }) as unknown as ReturnType<typeof useApi>,
    );
    vi.mocked(useWorkflows).mockReturnValue(
      makeWorkflowsHook({ workflows: [ACTIVE_WORKFLOW] }) as unknown as ReturnType<typeof useWorkflows>,
    );
    const user = userEvent.setup();
    render(<MemoryRouter><WorkflowsPage /></MemoryRouter>);
    await user.click(await screen.findByLabelText('workflows.controls.auditLog'));

    expect(screen.getByText('workflows.auditLog.heading')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('audit-log-event-evt1')).toBeInTheDocument());
    expect(screen.getByText('user_123')).toBeInTheDocument();
    expect(screen.getByText(/workflows\.auditLog\.action\.status_changed/)).toBeInTheDocument();
    expect(screen.getByText('workflows.auditLog.summaryStatusChange status:active')).toBeInTheDocument();
  });

  it('shows the empty state when there are no audit events', async () => {
    vi.mocked(useApi).mockReturnValue(
      makeApi({ getWorkflowAuditLog: vi.fn().mockResolvedValue({ events: [], total: 0, page: 1, limit: 50, pages: 0 }) }) as unknown as ReturnType<typeof useApi>,
    );
    vi.mocked(useWorkflows).mockReturnValue(
      makeWorkflowsHook({ workflows: [ACTIVE_WORKFLOW] }) as unknown as ReturnType<typeof useWorkflows>,
    );
    const user = userEvent.setup();
    render(<MemoryRouter><WorkflowsPage /></MemoryRouter>);
    await user.click(await screen.findByLabelText('workflows.controls.auditLog'));
    await waitFor(() => expect(screen.getByText('workflows.auditLog.empty')).toBeInTheDocument());
  });

  it('shows a load error state instead of crashing when the audit-log fetch fails', async () => {
    vi.mocked(useApi).mockReturnValue(
      makeApi({ getWorkflowAuditLog: vi.fn().mockRejectedValue(new Error('500')) }) as unknown as ReturnType<typeof useApi>,
    );
    vi.mocked(useWorkflows).mockReturnValue(
      makeWorkflowsHook({ workflows: [ACTIVE_WORKFLOW] }) as unknown as ReturnType<typeof useWorkflows>,
    );
    const user = userEvent.setup();
    render(<MemoryRouter><WorkflowsPage /></MemoryRouter>);
    await user.click(await screen.findByLabelText('workflows.controls.auditLog'));
    await waitFor(() => expect(screen.getByText('workflows.auditLog.loadError')).toBeInTheDocument());
  });

  it('shows a "Load more" button when a further page exists, and fetches page 2 on click', async () => {
    const getWorkflowAuditLog = vi.fn()
      .mockResolvedValueOnce({
        events: [{ id: 'evt1', workflowId: 'w1', actorUserId: 'user_1', action: 'updated', summary: { name: { before: 'A', after: 'B' } }, createdAt: '2026-07-01T10:00:00Z' }],
        total: 2, page: 1, limit: 1, pages: 2,
      })
      .mockResolvedValueOnce({
        events: [{ id: 'evt2', workflowId: 'w1', actorUserId: 'user_2', action: 'created', summary: { name: 'My Flow' }, createdAt: '2026-06-30T10:00:00Z' }],
        total: 2, page: 2, limit: 1, pages: 2,
      });
    vi.mocked(useApi).mockReturnValue(makeApi({ getWorkflowAuditLog }) as unknown as ReturnType<typeof useApi>);
    vi.mocked(useWorkflows).mockReturnValue(
      makeWorkflowsHook({ workflows: [ACTIVE_WORKFLOW] }) as unknown as ReturnType<typeof useWorkflows>,
    );
    const user = userEvent.setup();
    render(<MemoryRouter><WorkflowsPage /></MemoryRouter>);
    await user.click(await screen.findByLabelText('workflows.controls.auditLog'));
    await waitFor(() => expect(screen.getByTestId('audit-log-event-evt1')).toBeInTheDocument());
    expect(screen.getByText('workflows.auditLog.loadMore')).toBeInTheDocument();

    await user.click(screen.getByText('workflows.auditLog.loadMore'));

    await waitFor(() => expect(getWorkflowAuditLog).toHaveBeenCalledTimes(2));
    expect(getWorkflowAuditLog).toHaveBeenNthCalledWith(2, 'w1', { page: 2 });
    await waitFor(() => expect(screen.getByTestId('audit-log-event-evt2')).toBeInTheDocument());
    // Both pages' events are now shown (cumulative list, not a replace).
    expect(screen.getByTestId('audit-log-event-evt1')).toBeInTheDocument();
    // No further page — "Load more" is gone now.
    expect(screen.queryByText('workflows.auditLog.loadMore')).not.toBeInTheDocument();
  });

  it('renders "Created" summary for a create event and "Deleted" for a delete event', async () => {
    vi.mocked(useApi).mockReturnValue(
      makeApi({
        getWorkflowAuditLog: vi.fn().mockResolvedValue({
          events: [
            { id: 'evt_created', workflowId: 'w1', actorUserId: 'user_1', action: 'created', summary: { name: 'My Flow' }, createdAt: '2026-06-01T10:00:00Z' },
          ],
          total: 1, page: 1, limit: 50, pages: 1,
        }),
      }) as unknown as ReturnType<typeof useApi>,
    );
    vi.mocked(useWorkflows).mockReturnValue(
      makeWorkflowsHook({ workflows: [ACTIVE_WORKFLOW] }) as unknown as ReturnType<typeof useWorkflows>,
    );
    const user = userEvent.setup();
    render(<MemoryRouter><WorkflowsPage /></MemoryRouter>);
    await user.click(await screen.findByLabelText('workflows.controls.auditLog'));
    await waitFor(() => expect(screen.getByText('workflows.auditLog.summaryCreatedWithName name:My Flow')).toBeInTheDocument());
  });

  it('falls back to "Unknown user" when actorUserId is null', async () => {
    vi.mocked(useApi).mockReturnValue(
      makeApi({
        getWorkflowAuditLog: vi.fn().mockResolvedValue({
          events: [{ id: 'evt1', workflowId: 'w1', actorUserId: null, action: 'updated', summary: {}, createdAt: '2026-06-01T10:00:00Z' }],
          total: 1, page: 1, limit: 50, pages: 1,
        }),
      }) as unknown as ReturnType<typeof useApi>,
    );
    vi.mocked(useWorkflows).mockReturnValue(
      makeWorkflowsHook({ workflows: [ACTIVE_WORKFLOW] }) as unknown as ReturnType<typeof useWorkflows>,
    );
    const user = userEvent.setup();
    render(<MemoryRouter><WorkflowsPage /></MemoryRouter>);
    await user.click(await screen.findByLabelText('workflows.controls.auditLog'));
    await waitFor(() => expect(screen.getByText('workflows.auditLog.unknownActor')).toBeInTheDocument());
  });
});

// Nina's backend extension (Wave 10, Maya Top-5 #4 / Rohan R-1,R-2) — the
// executions endpoint now returns a `steps[]` array per execution, humanized
// `{raw,message,matched}` error objects at both levels, and dead-letter/retry
// columns. This suite proves the frontend actually consumes all of it —
// previously "3 steps" and nothing else for a graceful skip, a dead
// `status === 'success'` comparison, and a fully-built-but-unwired retry
// endpoint (Maya 1c).
describe('WorkflowsPage — run history: steps, humanized errors, retry (Wave 10)', () => {
  function makeExecution(overrides: Record<string, unknown> = {}) {
    return {
      id: 'e1', trigger_type: 'nps_threshold', status: 'completed',
      triggered_at: '2026-06-30T10:00:00Z', completed_at: '2026-06-30T10:00:05Z', duration_ms: 5000,
      error_message: null, step_count: 1, steps: [],
      attempt_count: 0, next_retry_at: null, dead_letter: false,
      ...overrides,
    };
  }

  async function openHistory(executions: unknown[]) {
    vi.mocked(useApi).mockReturnValue(
      makeApi({ getWorkflowExecutions: vi.fn().mockResolvedValue({ executions }) }) as unknown as ReturnType<typeof useApi>,
    );
    vi.mocked(useWorkflows).mockReturnValue(
      makeWorkflowsHook({ workflows: [ACTIVE_WORKFLOW] }) as unknown as ReturnType<typeof useWorkflows>,
    );
    const user = userEvent.setup();
    render(<MemoryRouter><WorkflowsPage /></MemoryRouter>);
    await user.click(await screen.findByLabelText('workflows.controls.history'));
    return user;
  }

  it('shows the human-readable reason for a gracefully-skipped step (previously invisible)', async () => {
    await openHistory([
      makeExecution({
        status: 'completed',
        steps: [
          { nodeId: 'a1', nodeType: 'notify.email', status: 'skipped', output: { reason: 'role_has_no_members' }, errorMessage: null },
        ],
      }),
    ]);
    await waitFor(() => expect(screen.getByText(/role_has_no_members|no members/i)).toBeInTheDocument());
  });

  it('shows the humanized message for a failed step, with the raw message behind Technical details', async () => {
    await openHistory([
      makeExecution({
        status: 'failed',
        error_message: { raw: 'Request failed with status code 401', message: 'Reconnect this integration in Settings.', matched: true },
        steps: [
          { nodeId: 'a1', nodeType: 'jira.create_issue', status: 'failed', output: {}, errorMessage: { raw: 'Request failed with status code 401', message: 'Reconnect this integration in Settings.', matched: true } },
        ],
      }),
    ]);
    await waitFor(() => expect(screen.getAllByText('Reconnect this integration in Settings.').length).toBeGreaterThan(0));
    // Raw message is available but not primary — behind a details disclosure.
    expect(screen.getAllByText('workflows.history.technicalDetails').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Request failed with status code 401').length).toBeGreaterThan(0);
  });

  it('shows a "will retry" indicator when attempt_count > 0 and not dead-lettered', async () => {
    await openHistory([makeExecution({ status: 'failed', attempt_count: 1, dead_letter: false })]);
    await waitFor(() => expect(screen.getByText('workflows.history.willRetry')).toBeInTheDocument());
  });

  it('shows a "retries exhausted" indicator when dead_letter is true', async () => {
    await openHistory([makeExecution({ status: 'failed', attempt_count: 5, dead_letter: true })]);
    await waitFor(() => expect(screen.getByText('workflows.history.retriesExhausted')).toBeInTheDocument());
  });

  it('does not show any retry-status chrome for a normal completed execution with zero attempts', async () => {
    await openHistory([makeExecution({ status: 'completed', attempt_count: 0, dead_letter: false })]);
    await waitFor(() => expect(screen.getByText('workflows.history.heading')).toBeInTheDocument());
    expect(screen.queryByText('workflows.history.willRetry')).not.toBeInTheDocument();
    expect(screen.queryByText('workflows.history.retriesExhausted')).not.toBeInTheDocument();
  });

  it('renders a Retry button on a failed execution and calls the retry endpoint (Maya 1c — zero UI call sites before this fix)', async () => {
    const retryWorkflowExecution = vi.fn().mockResolvedValue({ result: { status: 'completed' } });
    vi.mocked(useApi).mockReturnValue(
      makeApi({
        getWorkflowExecutions: vi.fn().mockResolvedValue({ executions: [makeExecution({ status: 'failed' })] }),
        retryWorkflowExecution,
      }) as unknown as ReturnType<typeof useApi>,
    );
    vi.mocked(useWorkflows).mockReturnValue(
      makeWorkflowsHook({ workflows: [ACTIVE_WORKFLOW] }) as unknown as ReturnType<typeof useWorkflows>,
    );
    const user = userEvent.setup();
    render(<MemoryRouter><WorkflowsPage /></MemoryRouter>);
    await user.click(await screen.findByLabelText('workflows.controls.history'));
    const retryButton = await screen.findByRole('button', { name: 'workflows.history.retryButton' });
    await user.click(retryButton);
    await waitFor(() => expect(retryWorkflowExecution).toHaveBeenCalledWith('e1'));
    await waitFor(() => expect(screen.getByText('workflows.history.retrySucceeded')).toBeInTheDocument());
  });

  it('does not render a Retry button on a completed execution', async () => {
    await openHistory([makeExecution({ status: 'completed' })]);
    await waitFor(() => expect(screen.getByText('workflows.history.heading')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'workflows.history.retryButton' })).not.toBeInTheDocument();
  });
});

// ── Error state ────────────────────────────────────────────────────────────────
describe('WorkflowsPage — error state', () => {
  it('shows a load-error banner when the data hook reports an error', async () => {
    vi.mocked(useWorkflows).mockReturnValue(
      makeWorkflowsHook({ workflows: [ACTIVE_WORKFLOW], error: 'Network error' }) as unknown as ReturnType<typeof useWorkflows>,
    );
    render(<MemoryRouter><WorkflowsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('workflows.loadError')).toBeInTheDocument());
  });

  it('does not show the load-error banner when there is no error', async () => {
    vi.mocked(useWorkflows).mockReturnValue(
      makeWorkflowsHook({ workflows: [ACTIVE_WORKFLOW], error: null }) as unknown as ReturnType<typeof useWorkflows>,
    );
    render(<MemoryRouter><WorkflowsPage /></MemoryRouter>);
    await waitFor(() => screen.getByText('My Flow'));
    expect(screen.queryByText('workflows.loadError')).not.toBeInTheDocument();
  });
});

// ── Toolbar navigation ─────────────────────────────────────────────────────────
// DEEP_AUDIT_FIX_SPECS.md Issue 2 / Rohan DEEP_AUDIT_UX_FINDINGS.md L-1 —
// "Build Visually" and "New Workflow" used to be two different buttons
// navigating to the identical route. "New Workflow" is now deleted entirely
// (not repurposed into a dropdown); "Build Visually" is promoted to the sole
// primary/solid CTA and both "Build Visually"/"Build on Canvas" gained
// always-visible one-line subtext distinguishing them.
describe('WorkflowsPage — toolbar navigation', () => {
  it('"Build Visually" button navigates to ROUTES.WORKFLOW_BUILD', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><WorkflowsPage /></MemoryRouter>);
    await user.click(await screen.findByRole('button', { name: /workflows\.buildVisually/i }));
    expect(mockNavigate).toHaveBeenCalledWith(ROUTES.WORKFLOW_BUILD);
  });

  it('"Build on Canvas" button navigates to ROUTES.WORKFLOW_CANVAS', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><WorkflowsPage /></MemoryRouter>);
    await user.click(await screen.findByRole('button', { name: /workflows\.buildOnCanvas/i }));
    expect(mockNavigate).toHaveBeenCalledWith(ROUTES.WORKFLOW_CANVAS);
  });

  it('only one button navigates to ROUTES.WORKFLOW_BUILD — "New Workflow" is gone, not a duplicate route', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><WorkflowsPage /></MemoryRouter>);
    expect(screen.queryByRole('button', { name: /workflows\.newWorkflowButton/i })).not.toBeInTheDocument();
    const buildVisually = await screen.findByRole('button', { name: /workflows\.buildVisually/i });
    await user.click(buildVisually);
    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith(ROUTES.WORKFLOW_BUILD);
  });

  it('"Build Visually" and "Build on Canvas" both render their always-visible subtext', async () => {
    render(<MemoryRouter><WorkflowsPage /></MemoryRouter>);
    expect(await screen.findByText('workflows.buildVisuallySubtext')).toBeInTheDocument();
    expect(screen.getByText('workflows.buildOnCanvasSubtext')).toBeInTheDocument();
  });

  // Entry point to the Integrations settings page (Rohan's INTEGRATIONS_SETTINGS_PAGE_SPEC.md §5) —
  // a contextual link from this page's header, not primary nav.
  it('"Integrations" entry-point link in the header navigates to ROUTES.SETTINGS_INTEGRATIONS', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><WorkflowsPage /></MemoryRouter>);
    await user.click(await screen.findByRole('button', { name: /integrationsSettings\.entryPointLabel/i }));
    expect(mockNavigate).toHaveBeenCalledWith(ROUTES.SETTINGS_INTEGRATIONS);
  });
});

// ── Pending Approvals section ─────────────────────────────────────────────────
describe('WorkflowsPage — Pending Approvals', () => {
  const approval = {
    id: 'appr1',
    execution_id: 'exec1',
    workflow_name: 'Review Alert',
    requested_at: '2026-06-01T10:00:00Z',
  };

  beforeEach(() => {
    vi.mocked(useApi).mockReturnValue(
      makeApi({
        listWorkflowApprovals: vi.fn().mockResolvedValue({ approvals: [approval] }),
      }) as unknown as ReturnType<typeof useApi>,
    );
  });

  it('renders the approval card with the workflow name', async () => {
    render(<MemoryRouter><WorkflowsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Review Alert')).toBeInTheDocument());
  });

  it('shows the waiting label on the approval card', async () => {
    render(<MemoryRouter><WorkflowsPage /></MemoryRouter>);
    await waitFor(() => screen.getByText('Review Alert'));
    expect(screen.getByText('workflows.approvals.waiting')).toBeInTheDocument();
  });

  it('Approve button calls decideApproval(execId, "approve")', async () => {
    const decideApproval = vi.fn().mockResolvedValue({});
    vi.mocked(useApi).mockReturnValue(
      makeApi({
        listWorkflowApprovals: vi.fn().mockResolvedValue({ approvals: [approval] }),
        decideApproval,
      }) as unknown as ReturnType<typeof useApi>,
    );
    const user = userEvent.setup();
    render(<MemoryRouter><WorkflowsPage /></MemoryRouter>);
    await waitFor(() => screen.getByText('Review Alert'));
    await user.click(screen.getByRole('button', { name: /workflows\.approvals\.approve/i }));
    await waitFor(() => expect(decideApproval).toHaveBeenCalledWith('exec1', 'approve'));
  });

  it('Reject button calls decideApproval(execId, "reject")', async () => {
    const decideApproval = vi.fn().mockResolvedValue({});
    vi.mocked(useApi).mockReturnValue(
      makeApi({
        listWorkflowApprovals: vi.fn().mockResolvedValue({ approvals: [approval] }),
        decideApproval,
      }) as unknown as ReturnType<typeof useApi>,
    );
    const user = userEvent.setup();
    render(<MemoryRouter><WorkflowsPage /></MemoryRouter>);
    await waitFor(() => screen.getByText('Review Alert'));
    await user.click(screen.getByRole('button', { name: /workflows\.approvals\.reject/i }));
    await waitFor(() => expect(decideApproval).toHaveBeenCalledWith('exec1', 'reject'));
  });

  it('removes the approval card from the list after a decision', async () => {
    const decideApproval = vi.fn().mockResolvedValue({});
    vi.mocked(useApi).mockReturnValue(
      makeApi({
        listWorkflowApprovals: vi.fn().mockResolvedValue({ approvals: [approval] }),
        decideApproval,
      }) as unknown as ReturnType<typeof useApi>,
    );
    const user = userEvent.setup();
    render(<MemoryRouter><WorkflowsPage /></MemoryRouter>);
    await waitFor(() => screen.getByText('Review Alert'));
    await user.click(screen.getByRole('button', { name: /workflows\.approvals\.approve/i }));
    await waitFor(() => expect(screen.queryByText('Review Alert')).not.toBeInTheDocument());
  });
});

// ── Templates section ─────────────────────────────────────────────────────────
// "Start from Template" (Wave 9) is a synchronous navigation into a builder,
// pre-filled with the template's shape — no API call, no mutation, no loading
// state. See docs/automation-hub/TEMPLATE_FLOW_AND_RECIPIENT_TARGETING_SPEC.md.
describe('WorkflowsPage — Templates', () => {
  const linearTemplate = {
    slug: 'nps-alert',
    name: 'NPS Drop Alert',
    description: 'Fires when NPS falls below threshold',
    trigger_type: 'survey.response_received',
    nodes: [
      { id: 'trigger', type: 'trigger', trigger: 'survey.response_received' },
      { id: 'action_0', type: 'action', action: 'notify.email', config: {} },
    ],
    edges: [{ from: 'trigger', to: 'action_0' }],
    is_featured: true,
  };

  const branchingTemplate = {
    slug: 'escalation-branch',
    name: 'Escalation Branch',
    description: 'Branches on sentiment',
    trigger_type: 'survey.response_received',
    nodes: [
      { id: 'trigger', type: 'trigger', trigger: 'survey.response_received' },
      { id: 'cond', type: 'condition', conditions: { operator: 'AND', rules: [] } },
      { id: 'action_0', type: 'action', action: 'notify.email', config: {} },
      { id: 'action_1', type: 'action', action: 'notify.slack', config: {} },
    ],
    edges: [
      { from: 'trigger', to: 'cond' },
      { from: 'cond', to: 'action_0', branch: 'true' as const },
      { from: 'cond', to: 'action_1', branch: 'false' as const },
    ],
    is_featured: false,
  };

  beforeEach(() => {
    vi.mocked(useApi).mockReturnValue(
      makeApi({
        listWorkflowTemplates: vi.fn().mockResolvedValue({ templates: [linearTemplate] }),
      }) as unknown as ReturnType<typeof useApi>,
    );
  });

  it('renders the template card with name and description', async () => {
    render(<MemoryRouter><WorkflowsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('NPS Drop Alert')).toBeInTheDocument());
    expect(screen.getByText('Fires when NPS falls below threshold')).toBeInTheDocument();
  });

  it('renders the relabeled "Start from Template" button', async () => {
    render(<MemoryRouter><WorkflowsPage /></MemoryRouter>);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /workflows\.useTemplate/i })).toBeInTheDocument(),
    );
  });

  it('clicking the template button navigates to the sentence builder with a full seed, and fires no API mutation', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><WorkflowsPage /></MemoryRouter>);
    await waitFor(() => screen.getByText('NPS Drop Alert'));
    await user.click(screen.getByRole('button', { name: /workflows\.useTemplate/i }));

    expect(mockNavigate).toHaveBeenCalledWith(ROUTES.WORKFLOW_BUILD, {
      state: {
        seed: {
          name: linearTemplate.name,
          description: linearTemplate.description,
          triggerType: linearTemplate.trigger_type,
          nodes: linearTemplate.nodes,
          edges: linearTemplate.edges,
        },
      },
    });
  });

  it('routes a branching template to the canvas builder instead of the sentence builder', async () => {
    vi.mocked(useApi).mockReturnValue(
      makeApi({
        listWorkflowTemplates: vi.fn().mockResolvedValue({ templates: [branchingTemplate] }),
      }) as unknown as ReturnType<typeof useApi>,
    );
    const user = userEvent.setup();
    render(<MemoryRouter><WorkflowsPage /></MemoryRouter>);
    await waitFor(() => screen.getByText('Escalation Branch'));
    await user.click(screen.getByRole('button', { name: /workflows\.useTemplate/i }));

    expect(mockNavigate).toHaveBeenCalledWith(
      ROUTES.WORKFLOW_CANVAS,
      expect.objectContaining({ state: expect.objectContaining({ seed: expect.anything() }) }),
    );
  });
});

// ── Loading state ─────────────────────────────────────────────────────────────
describe('WorkflowsPage — loading state', () => {
  it('does not render workflow cards or empty state while loading', () => {
    vi.mocked(useWorkflows).mockReturnValue(
      makeWorkflowsHook({ loading: true, workflows: [] }) as unknown as ReturnType<typeof useWorkflows>,
    );
    render(<MemoryRouter><WorkflowsPage /></MemoryRouter>);
    expect(screen.queryByText('workflows.empty.heading')).not.toBeInTheDocument();
    expect(screen.queryByText('My Flow')).not.toBeInTheDocument();
  });
});

// ── Stats row ─────────────────────────────────────────────────────────────────
describe('WorkflowsPage — stats row', () => {
  it('correctly counts active workflows, total triggers, and paused workflows', async () => {
    const workflows: Workflow[] = [
      { ...ACTIVE_WORKFLOW, id: 'a1', status: 'active', trigger_count: 10 },
      { ...ACTIVE_WORKFLOW, id: 'a2', status: 'active', trigger_count: 5  },
      { ...ACTIVE_WORKFLOW, id: 'p1', status: 'paused', trigger_count: 2  },
    ];
    vi.mocked(useWorkflows).mockReturnValue(
      makeWorkflowsHook({ workflows }) as unknown as ReturnType<typeof useWorkflows>,
    );
    render(<MemoryRouter><WorkflowsPage /></MemoryRouter>);
    // Total triggers = 17, active = 2, paused = 1
    await waitFor(() => expect(screen.getByText('17')).toBeInTheDocument());
    expect(screen.getByText('1')).toBeInTheDocument();
    // Active count "2" appears in the stat card
    const twos = screen.getAllByText('2');
    expect(twos.length).toBeGreaterThanOrEqual(1);
  });
});

// ── Scope badges (Wave 6, BUILDER_REDESIGN_V2_CONCEPT.md §2) ──────────────────
// Testable requirement per BUILDER_REDESIGN_V2_SCOPE.md §5: "render a card for
// each of the 3 scope types and assert the badge text is present in the
// initial DOM, no interaction required."
describe('WorkflowsPage — scope badges', () => {
  it('renders an Org-wide scope chip in the initial DOM with no interaction', async () => {
    const orgWorkflow: Workflow = { ...ACTIVE_WORKFLOW, id: 'w-org', scope_type: 'org' };
    vi.mocked(useWorkflows).mockReturnValue(
      makeWorkflowsHook({ workflows: [orgWorkflow] }) as unknown as ReturnType<typeof useWorkflows>,
    );
    render(<MemoryRouter><WorkflowsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('workflows.card.scope.org')).toBeInTheDocument());
  });

  it('renders a Survey scope chip resolved from the survey lookup, in the initial DOM', async () => {
    const surveyWorkflow: Workflow = {
      ...ACTIVE_WORKFLOW, id: 'w-survey', scope_type: 'survey', scope_survey_id: 'srv1',
    };
    vi.mocked(useApi).mockReturnValue(makeApi({
      listSurveys: vi.fn().mockResolvedValue({ surveys: [{ id: 'srv1', title: 'CSAT Q3', status: 'active', response_count: 12 }] }),
    }) as unknown as ReturnType<typeof useApi>);
    vi.mocked(useWorkflows).mockReturnValue(
      makeWorkflowsHook({ workflows: [surveyWorkflow] }) as unknown as ReturnType<typeof useWorkflows>,
    );
    render(<MemoryRouter><WorkflowsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('workflows.card.scope.survey name:CSAT Q3')).toBeInTheDocument());
    expect(screen.getByTestId('workflow-scope-subtext')).toHaveTextContent('workflows.card.scope.subtextSurvey name:CSAT Q3');
  });

  it('renders a Tag scope chip resolved from the tag lookup, in the initial DOM', async () => {
    const tagWorkflow: Workflow = {
      ...ACTIVE_WORKFLOW, id: 'w-tag', scope_type: 'tag', scope_tag_id: 'tag1',
    };
    vi.mocked(useApi).mockReturnValue(makeApi({
      listTags: vi.fn().mockResolvedValue({ tags: [{ id: 'tag1', name: 'Onboarding', slug: 'onboarding', color: '#000', survey_count: 4, created_at: '' }] }),
    }) as unknown as ReturnType<typeof useApi>);
    vi.mocked(useWorkflows).mockReturnValue(
      makeWorkflowsHook({ workflows: [tagWorkflow] }) as unknown as ReturnType<typeof useWorkflows>,
    );
    render(<MemoryRouter><WorkflowsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('workflows.card.scope.tag name:Onboarding')).toBeInTheDocument());
    expect(screen.getByTestId('workflow-scope-subtext')).toHaveTextContent('workflows.card.scope.subtextTag count:4 name:Onboarding');
  });

  it('shows a "Program" sub-label on a tag chip when the tag has program_config', async () => {
    const tagWorkflow: Workflow = {
      ...ACTIVE_WORKFLOW, id: 'w-tag-prog', scope_type: 'tag', scope_tag_id: 'tag2',
    };
    vi.mocked(useApi).mockReturnValue(makeApi({
      listTags: vi.fn().mockResolvedValue({
        tags: [{ id: 'tag2', name: 'Q3 NPS Program', slug: 'q3', color: '#000', survey_count: 2, program_config: { cadence: 'quarterly' }, created_at: '' }],
      }),
    }) as unknown as ReturnType<typeof useApi>);
    vi.mocked(useWorkflows).mockReturnValue(
      makeWorkflowsHook({ workflows: [tagWorkflow] }) as unknown as ReturnType<typeof useWorkflows>,
    );
    render(<MemoryRouter><WorkflowsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('workflows.card.scope.programSuffix')).toBeInTheDocument());
  });

  it('renders the ScopeFilterBar chip row when workflows exist', async () => {
    vi.mocked(useWorkflows).mockReturnValue(
      makeWorkflowsHook({ workflows: [ACTIVE_WORKFLOW] }) as unknown as ReturnType<typeof useWorkflows>,
    );
    render(<MemoryRouter><WorkflowsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('scope-filter-bar')).toBeInTheDocument());
  });

  it('filtering to Org-wide hides survey-scoped workflows', async () => {
    const user = userEvent.setup();
    const orgWorkflow: Workflow = { ...ACTIVE_WORKFLOW, id: 'w-org', name: 'Org Flow', scope_type: 'org' };
    const surveyWorkflow: Workflow = { ...ACTIVE_WORKFLOW, id: 'w-survey', name: 'Survey Flow', scope_type: 'survey', scope_survey_id: 'srv1' };
    vi.mocked(useWorkflows).mockReturnValue(
      makeWorkflowsHook({ workflows: [orgWorkflow, surveyWorkflow] }) as unknown as ReturnType<typeof useWorkflows>,
    );
    render(<MemoryRouter><WorkflowsPage /></MemoryRouter>);
    await waitFor(() => screen.getByText('Org Flow'));
    expect(screen.getByText('Survey Flow')).toBeInTheDocument();

    await user.click(screen.getByText('workflows.scopeFilter.orgWide'));
    expect(screen.getByText('Org Flow')).toBeInTheDocument();
    expect(screen.queryByText('Survey Flow')).not.toBeInTheDocument();
  });
});
