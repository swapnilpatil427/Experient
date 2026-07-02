import React from 'react';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── mocks (must be at top, before component imports) ──────────────────────────
vi.mock('../../hooks/useApi', () => ({ useApi: vi.fn(), default: vi.fn() }));
vi.mock('../../lib/i18n', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
vi.mock('../../contexts/pageTitle', () => ({ useSetPageTitle: vi.fn() }));
vi.mock('../../hooks/useBreakpoint', () => ({ useBreakpoint: vi.fn(() => 'desktop') }));
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
vi.mock('../../lib/dataBus', () => ({ invalidate: vi.fn() }));

// ── ReactFlow mock ─────────────────────────────────────────────────────────────
// useNodesState uses real React state so that setNodes triggers re-renders and
// the component's `nodes` variable is always up to date when save() runs.
// We record every setNodes call in mockSetNodes so tests can inspect it.
const mockSetNodes = vi.fn();
const mockSetEdges = vi.fn();

vi.mock('reactflow', () => {
  // Capture React in the factory; vi.mock hoisting means we can't use the
  // outer import, so we require it inside the factory.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const R = require('react') as typeof import('react');

  function useNodesStateImpl(initial: unknown[]) {
    const [nodes, setNodesReal] = R.useState<unknown[]>(initial ?? []);
    const setNodes = R.useCallback((updater: unknown) => {
      setNodesReal((prev) => {
        const next = typeof updater === 'function'
          ? (updater as (p: unknown[]) => unknown[])(prev)
          : (updater as unknown[]);
        mockSetNodes(next);
        return next;
      });
    }, []);
    return [nodes, setNodes, vi.fn()];
  }

  function useEdgesStateImpl(initial: unknown[]) {
    const [edges, setEdgesReal] = R.useState<unknown[]>(initial ?? []);
    const setEdges = R.useCallback((updater: unknown) => {
      setEdgesReal((prev) => {
        const next = typeof updater === 'function'
          ? (updater as (p: unknown[]) => unknown[])(prev)
          : (updater as unknown[]);
        mockSetEdges(next);
        return next;
      });
    }, []);
    return [edges, setEdges, vi.fn()];
  }

  return {
    default:       ({ children }: { children?: React.ReactNode }) => <div data-testid="react-flow">{children}</div>,
    ReactFlow:     ({ children }: { children?: React.ReactNode }) => <div data-testid="react-flow">{children}</div>,
    Background:    () => null,
    Controls:      () => null,
    MiniMap:       () => null,
    Handle:        () => null,
    Position:      { Left: 'left', Right: 'right', Bottom: 'bottom', Top: 'top' },
    MarkerType:    { ArrowClosed: 'arrowclosed' },
    addEdge:       vi.fn((edge: unknown, edges: unknown[]) => [...edges, edge]),
    useNodesState: useNodesStateImpl,
    useEdgesState: useEdgesStateImpl,
  };
});

// Also stub the CSS import so jsdom doesn't choke on it
vi.mock('reactflow/dist/style.css', () => ({}));

// ── imports after mocks ────────────────────────────────────────────────────────
import { useApi } from '../../hooks/useApi';
import { useNavigate } from 'react-router-dom';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { WorkflowCanvasPage } from '../../pages/WorkflowCanvasPage';
import { ROUTES } from '../../constants/routes';
import { invalidate } from '../../lib/dataBus';
import { WorkflowConflictError } from '../../lib/api';

// ── fixtures ───────────────────────────────────────────────────────────────────
const mockNavigate = vi.fn();

const REGISTRY = {
  triggers: [
    { type: 'survey.response_filtered', label: 'New Response (filtered)', category: 'Survey' },
    { type: 'survey.nps_drop',          label: 'NPS Drop',                category: 'Metrics' },
  ],
  actions: [
    { action: 'notify.in_app', label: 'In-App Notification', category: 'Notify', live: true },
    { action: 'notify.slack',  label: 'Slack Message',       category: 'Notify', live: false },
  ],
  conditionOperators: ['eq', 'lte', 'gte'],
  conditionFields: [
    { field: 'nps', label: 'NPS Score', kind: 'number' },
    { field: 'sentiment', label: 'Sentiment', kind: 'string' },
  ],
};

const EXISTING_WORKFLOW = {
  id: 'wf_canvas_1',
  name: 'Branching Escalation',
  description: 'Escalates by sentiment',
  trigger_type: 'survey.nps_drop',
  nodes: [
    { id: 'trigger', type: 'trigger', trigger: 'survey.nps_drop' },
    { id: 'cond', type: 'condition', conditions: { operator: 'AND', rules: [{ field: 'nps', op: 'lte', value: 6 }] } },
    // Real, non-empty config on both action nodes (DEEP_AUDIT_FIX_SPECS.md
    // Issue 1) — this fixture represents a properly-configured, already-saved
    // workflow used by most edit-mode tests below. A dedicated test further
    // down uses an explicitly-unconfigured fixture to prove save-blocking.
    { id: 'action_true', type: 'action', action: 'notify.slack', config: { channel: '#cx-alerts' } },
    { id: 'action_false', type: 'action', action: 'notify.in_app', config: { targetType: 'users', userIds: ['u1'] } },
  ],
  edges: [
    { from: 'trigger', to: 'cond' },
    { from: 'cond', to: 'action_true', branch: 'true' },
    { from: 'cond', to: 'action_false', branch: 'false' },
  ],
  status: 'draft',
  version: 3,
};

function makeApi(overrides = {}) {
  return {
    getWorkflowRegistry: vi.fn().mockResolvedValue(REGISTRY),
    createGraphWorkflow: vi.fn().mockResolvedValue({ id: 'canvas_wf_1' }),
    getWorkflow:         vi.fn().mockResolvedValue({ workflow: EXISTING_WORKFLOW }),
    updateWorkflow:      vi.fn().mockResolvedValue({ success: true }),
    ...overrides,
  };
}

// ── setup / teardown ───────────────────────────────────────────────────────────
beforeEach(() => {
  vi.mocked(useNavigate).mockReturnValue(mockNavigate);
  vi.mocked(useApi).mockReturnValue(makeApi() as unknown as ReturnType<typeof useApi>);
  vi.mocked(useBreakpoint).mockReturnValue('desktop');
});

afterEach(() => { cleanup(); vi.clearAllMocks(); });

// ── helpers ────────────────────────────────────────────────────────────────────
function renderPage(routerState?: Record<string, unknown>) {
  render(
    <MemoryRouter initialEntries={[{ pathname: ROUTES.WORKFLOW_CANVAS, state: routerState }]}>
      <WorkflowCanvasPage />
    </MemoryRouter>,
  );
}

// ── tests ──────────────────────────────────────────────────────────────────────
describe('WorkflowCanvasPage — canvas mount', () => {
  it('renders the mocked ReactFlow component', () => {
    renderPage();
    expect(screen.getByTestId('react-flow')).toBeInTheDocument();
  });

  it('renders the page title heading', () => {
    renderPage();
    expect(screen.getByText('workflows.canvas.title')).toBeInTheDocument();
  });
});

describe('WorkflowCanvasPage — initial state', () => {
  it('seeds one TriggerNode into the canvas state after registry loads', async () => {
    renderPage();
    await waitFor(() => expect(mockSetNodes).toHaveBeenCalled());
    // Last call passes the seeded trigger node array
    const lastCallArg = mockSetNodes.mock.calls[mockSetNodes.mock.calls.length - 1][0] as Array<{ data: { kind: string } }>;
    expect(Array.isArray(lastCallArg)).toBe(true);
    const triggerNodes = lastCallArg.filter((n) => n.data?.kind === 'trigger');
    expect(triggerNodes).toHaveLength(1);
  });

  it('name input starts empty', () => {
    renderPage();
    expect(screen.getByPlaceholderText('workflows.builder.namePlaceholder')).toHaveValue('');
  });
});

describe('WorkflowCanvasPage — toolbar buttons', () => {
  it('renders the "+ Condition" toolbar button', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /workflows\.canvas\.addCondition/i })).toBeInTheDocument(),
    );
  });

  it('renders the "+ Action" toolbar button', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /workflows\.canvas\.addAction/i })).toBeInTheDocument(),
    );
  });

  it('clicking "+ Condition" calls setNodes to add a ConditionNode', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => screen.getByRole('button', { name: /workflows\.canvas\.addCondition/i }));
    mockSetNodes.mockClear();
    await user.click(screen.getByRole('button', { name: /workflows\.canvas\.addCondition/i }));
    await waitFor(() => expect(mockSetNodes).toHaveBeenCalled());
    const lastArg = mockSetNodes.mock.calls[mockSetNodes.mock.calls.length - 1][0] as Array<{ data: { kind: string } }>;
    expect(lastArg.filter((n) => n.data?.kind === 'condition').length).toBeGreaterThanOrEqual(1);
  });

  it('clicking "+ Action" calls setNodes to add an ActionNode', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => screen.getByRole('button', { name: /workflows\.canvas\.addAction/i }));
    mockSetNodes.mockClear();
    await user.click(screen.getByRole('button', { name: /workflows\.canvas\.addAction/i }));
    await waitFor(() => expect(mockSetNodes).toHaveBeenCalled());
    const lastArg = mockSetNodes.mock.calls[mockSetNodes.mock.calls.length - 1][0] as Array<{ data: { kind: string } }>;
    expect(lastArg.filter((n) => n.data?.kind === 'action').length).toBeGreaterThanOrEqual(1);
  });
});

describe('WorkflowCanvasPage — workflow name input', () => {
  it('accepts text input in the name field', async () => {
    const user = userEvent.setup();
    renderPage();
    const nameInput = screen.getByPlaceholderText('workflows.builder.namePlaceholder');
    await user.type(nameInput, 'Canvas Flow');
    expect(nameInput).toHaveValue('Canvas Flow');
  });
});

describe('WorkflowCanvasPage — save validation', () => {
  it('shows an error when saving with empty name', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /workflows\.builder\.save/i }));
    await waitFor(() =>
      expect(screen.getByText('workflows.builder.incomplete')).toBeInTheDocument(),
    );
  });

  it('shows an error when saving with name but no action nodes', async () => {
    // Override registry to return no triggers so no trigger node is seeded and no action
    vi.mocked(useApi).mockReturnValue(
      makeApi({
        getWorkflowRegistry: vi.fn().mockResolvedValue({ ...REGISTRY, triggers: [] }),
      }) as unknown as ReturnType<typeof useApi>,
    );
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByPlaceholderText('workflows.builder.namePlaceholder'), 'Orphan Flow');
    await user.click(screen.getByRole('button', { name: /workflows\.builder\.save/i }));
    await waitFor(() =>
      expect(screen.getByText('workflows.builder.incomplete')).toBeInTheDocument(),
    );
  });
});

describe('WorkflowCanvasPage — save success', () => {
  it('calls createGraphWorkflow and navigates to ROUTES.WORKFLOWS when trigger + action exist', async () => {
    const createGraphWorkflow = vi.fn().mockResolvedValue({ id: 'canvas_wf_1' });
    // DEEP_AUDIT_FIX_SPECS.md Issue 1 — save is now blocked while any action
    // node is unconfigured. This test asserts the save/POST plumbing itself,
    // not the config-completeness feature (covered separately below), so the
    // default action the toolbar's "+ Action" button adds is overridden to
    // flow.stop — the one action type with zero declared fields, always
    // configured — so it doesn't need a config panel interaction to save.
    vi.mocked(useApi).mockReturnValue(
      makeApi({
        createGraphWorkflow,
        getWorkflowRegistry: vi.fn().mockResolvedValue({
          ...REGISTRY,
          actions: [{ action: 'flow.stop', label: 'Stop workflow', category: 'Flow', live: true }, ...REGISTRY.actions],
        }),
      }) as unknown as ReturnType<typeof useApi>,
    );

    const user = userEvent.setup();
    renderPage();

    // Wait for registry to load and trigger node to be seeded into state
    await waitFor(() => expect(mockSetNodes).toHaveBeenCalled());

    // Add an action node via the toolbar button — this updates real React state
    await user.click(screen.getByRole('button', { name: /workflows\.canvas\.addAction/i }));

    // Verify setNodes was called with an action node (state is now trigger + action)
    await waitFor(() => {
      const lastArg = mockSetNodes.mock.calls[mockSetNodes.mock.calls.length - 1][0] as Array<{ data: { kind: string } }>;
      expect(lastArg.some((n) => n.data?.kind === 'action')).toBe(true);
    });

    // Type the workflow name
    await user.type(screen.getByPlaceholderText('workflows.builder.namePlaceholder'), 'Canvas Automation');

    // Click Save
    await user.click(screen.getByRole('button', { name: /workflows\.builder\.save/i }));

    await waitFor(() => expect(createGraphWorkflow).toHaveBeenCalledOnce());
    expect(createGraphWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        name:        'Canvas Automation',
        triggerType: 'survey.response_filtered',
        status:      'draft',
        nodes:       expect.arrayContaining([
          expect.objectContaining({ type: 'trigger' }),
          expect.objectContaining({ type: 'action' }),
        ]),
        edges: expect.any(Array),
      }),
    );
    expect(invalidate).toHaveBeenCalledWith('workflows');
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith(ROUTES.WORKFLOWS));
  });
});

describe('WorkflowCanvasPage — edit mode data loading', () => {
  it('shows a loading spinner (not an empty ReactFlow) while the workflow fetch is in flight', async () => {
    let resolveFetch: (v: unknown) => void = () => {};
    const getWorkflow = vi.fn(() => new Promise((resolve) => { resolveFetch = resolve; }));
    vi.mocked(useApi).mockReturnValue(makeApi({ getWorkflow }) as unknown as ReturnType<typeof useApi>);

    renderPage({ workflowId: 'wf_canvas_1' });

    await waitFor(() => expect(screen.getByText('workflows.canvas.loadingWorkflow')).toBeInTheDocument());
    // ReactFlow must not be mounted yet — mounting with empty nodes then
    // popping content in causes a fitView glitch (spec §1.3).
    expect(screen.queryByTestId('react-flow')).not.toBeInTheDocument();

    resolveFetch({ workflow: EXISTING_WORKFLOW });
    await waitFor(() => expect(screen.getByTestId('react-flow')).toBeInTheDocument());
  });

  it('deserializes fetched nodes/edges into the canvas via setNodes/setEdges', async () => {
    renderPage({ workflowId: 'wf_canvas_1' });

    await waitFor(() => expect(screen.getByTestId('react-flow')).toBeInTheDocument());
    await waitFor(() => {
      const lastArg = mockSetNodes.mock.calls[mockSetNodes.mock.calls.length - 1][0] as Array<{ data: { kind: string } }>;
      expect(lastArg.filter((n) => n.data?.kind === 'trigger')).toHaveLength(1);
      expect(lastArg.filter((n) => n.data?.kind === 'condition')).toHaveLength(1);
      expect(lastArg.filter((n) => n.data?.kind === 'action')).toHaveLength(2);
    });
    expect(screen.getByPlaceholderText('workflows.builder.namePlaceholder')).toHaveValue('Branching Escalation');
  });

  it('shows the 404 not-found copy when the workflow fetch 404s', async () => {
    const getWorkflow = vi.fn().mockRejectedValue({ response: { status: 404 } });
    vi.mocked(useApi).mockReturnValue(makeApi({ getWorkflow }) as unknown as ReturnType<typeof useApi>);

    renderPage({ workflowId: 'missing' });

    await waitFor(() => expect(screen.getByText('workflows.builder.notFoundHeading')).toBeInTheDocument());
    expect(screen.getByText('workflows.builder.notFoundBody')).toBeInTheDocument();
  });

  it('shows the generic load-error copy on a non-404 failure', async () => {
    const getWorkflow = vi.fn().mockRejectedValue({ response: { status: 500 } });
    vi.mocked(useApi).mockReturnValue(makeApi({ getWorkflow }) as unknown as ReturnType<typeof useApi>);

    renderPage({ workflowId: 'wf_canvas_1' });

    await waitFor(() => expect(screen.getByText('workflows.builder.notFoundHeading')).toBeInTheDocument());
    expect(screen.getByText('workflows.builder.loadErrorBody')).toBeInTheDocument();
  });
});

describe('WorkflowCanvasPage — edit mode save (PUT vs POST)', () => {
  it('calls api.updateWorkflow (PUT) instead of createGraphWorkflow (POST) when workflowId is present', async () => {
    const updateWorkflow = vi.fn().mockResolvedValue({ success: true });
    const createGraphWorkflow = vi.fn();
    vi.mocked(useApi).mockReturnValue(makeApi({ updateWorkflow, createGraphWorkflow }) as unknown as ReturnType<typeof useApi>);
    const user = userEvent.setup();

    renderPage({ workflowId: 'wf_canvas_1' });

    await waitFor(() => expect(screen.getByPlaceholderText('workflows.builder.namePlaceholder')).toHaveValue('Branching Escalation'));
    await user.click(screen.getByRole('button', { name: 'workflows.builder.saveChanges' }));

    await waitFor(() => expect(updateWorkflow).toHaveBeenCalledOnce());
    expect(updateWorkflow).toHaveBeenCalledWith('wf_canvas_1', expect.objectContaining({ name: 'Branching Escalation' }));
    expect(createGraphWorkflow).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith('workflows');
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith(ROUTES.WORKFLOWS));
  });

  it('shows "Save changes" (not "Save workflow") in edit mode', async () => {
    renderPage({ workflowId: 'wf_canvas_1' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'workflows.builder.saveChanges' })).toBeInTheDocument());
  });

  it('REGRESSION: saving an edit to an already-active workflow preserves status=active, never silently forces draft', async () => {
    // Deep-audit finding (2026-07-01): the canvas builder unconditionally sent
    // status: 'draft' on every save, including edits — the fixture used by the
    // sibling PUT-vs-POST test above is itself 'draft', so it could not have
    // caught this. This test uses an 'active' fixture specifically to prove
    // the fix.
    const activeWorkflow = { ...EXISTING_WORKFLOW, status: 'active' };
    const getWorkflow = vi.fn().mockResolvedValue({ workflow: activeWorkflow });
    const updateWorkflow = vi.fn().mockResolvedValue({ success: true });
    vi.mocked(useApi).mockReturnValue(makeApi({ getWorkflow, updateWorkflow }) as unknown as ReturnType<typeof useApi>);
    const user = userEvent.setup();

    renderPage({ workflowId: 'wf_canvas_1' });
    await waitFor(() => expect(screen.getByPlaceholderText('workflows.builder.namePlaceholder')).toHaveValue('Branching Escalation'));
    await user.click(screen.getByRole('button', { name: 'workflows.builder.saveChanges' }));

    await waitFor(() => expect(updateWorkflow).toHaveBeenCalled());
    expect(updateWorkflow).toHaveBeenCalledWith('wf_canvas_1', expect.objectContaining({ status: 'active' }));
    expect(updateWorkflow).not.toHaveBeenCalledWith('wf_canvas_1', expect.objectContaining({ status: 'draft' }));
  });
});

// Wave 11, Item 1 — concurrent-edit conflict UI (Nina's version/409 contract).
// Same contract as WorkflowBuilderPage.tsx's equivalent block.
describe('WorkflowCanvasPage — concurrent-edit protection', () => {
  it('create mode never sends a version field on save', async () => {
    const createGraphWorkflow = vi.fn().mockResolvedValue({ id: 'canvas_wf_1' });
    // flow.stop has zero declared config fields (always "configured") so this
    // test can save without a config-panel detour — same fixture trick as the
    // "save success" describe block above.
    vi.mocked(useApi).mockReturnValue(
      makeApi({
        createGraphWorkflow,
        getWorkflowRegistry: vi.fn().mockResolvedValue({
          ...REGISTRY,
          actions: [{ action: 'flow.stop', label: 'Stop workflow', category: 'Flow', live: true }, ...REGISTRY.actions],
        }),
      }) as unknown as ReturnType<typeof useApi>,
    );
    const user = userEvent.setup();

    renderPage();
    await waitFor(() => expect(mockSetNodes).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: /workflows\.canvas\.addAction/i }));
    await user.type(screen.getByPlaceholderText('workflows.builder.namePlaceholder'), 'Brand New Canvas Flow');
    await user.click(screen.getByRole('button', { name: /workflows\.builder\.save/i }));

    await waitFor(() => expect(createGraphWorkflow).toHaveBeenCalled());
    expect(createGraphWorkflow.mock.calls[0][0]).not.toHaveProperty('version');
  });

  it('edit mode sends the loaded workflow\'s version on save', async () => {
    const updateWorkflow = vi.fn().mockResolvedValue({ success: true, version: 4 });
    vi.mocked(useApi).mockReturnValue(makeApi({ updateWorkflow }) as unknown as ReturnType<typeof useApi>);
    const user = userEvent.setup();

    renderPage({ workflowId: 'wf_canvas_1' });
    await waitFor(() => expect(screen.getByPlaceholderText('workflows.builder.namePlaceholder')).toHaveValue('Branching Escalation'));
    await user.click(screen.getByRole('button', { name: 'workflows.builder.saveChanges' }));

    await waitFor(() => expect(updateWorkflow).toHaveBeenCalled());
    expect(updateWorkflow).toHaveBeenCalledWith('wf_canvas_1', expect.objectContaining({ version: 3 }));
  });

  it('shows the conflict dialog on a 409 WorkflowConflictError instead of a generic error banner', async () => {
    const updateWorkflow = vi.fn().mockRejectedValue(
      new WorkflowConflictError('This workflow was changed by someone else.', 409, { ...EXISTING_WORKFLOW, version: 5 }),
    );
    vi.mocked(useApi).mockReturnValue(makeApi({ updateWorkflow }) as unknown as ReturnType<typeof useApi>);
    const user = userEvent.setup();

    renderPage({ workflowId: 'wf_canvas_1' });
    await waitFor(() => expect(screen.getByPlaceholderText('workflows.builder.namePlaceholder')).toHaveValue('Branching Escalation'));
    await user.click(screen.getByRole('button', { name: 'workflows.builder.saveChanges' }));

    await waitFor(() => expect(screen.getByTestId('conflict-reload')).toBeInTheDocument());
    expect(screen.getByTestId('conflict-overwrite')).toBeInTheDocument();
  });

  it('"Overwrite anyway" re-submits the same PUT with version omitted (force-save)', async () => {
    const updateWorkflow = vi.fn()
      .mockRejectedValueOnce(new WorkflowConflictError('conflict', 409, { ...EXISTING_WORKFLOW, version: 5 }))
      .mockResolvedValueOnce({ success: true, version: 6 });
    vi.mocked(useApi).mockReturnValue(makeApi({ updateWorkflow }) as unknown as ReturnType<typeof useApi>);
    const user = userEvent.setup();

    renderPage({ workflowId: 'wf_canvas_1' });
    await waitFor(() => expect(screen.getByPlaceholderText('workflows.builder.namePlaceholder')).toHaveValue('Branching Escalation'));
    await user.click(screen.getByRole('button', { name: 'workflows.builder.saveChanges' }));
    await waitFor(() => expect(screen.getByTestId('conflict-overwrite')).toBeInTheDocument());

    await user.click(screen.getByTestId('conflict-overwrite'));

    await waitFor(() => expect(updateWorkflow).toHaveBeenCalledTimes(2));
    const overwriteCallArgs = updateWorkflow.mock.calls[1][1];
    expect(overwriteCallArgs).not.toHaveProperty('version');
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith(ROUTES.WORKFLOWS));
  });

  it('"Reload latest" re-fetches the workflow and discards local edits', async () => {
    const getWorkflow = vi.fn()
      .mockResolvedValueOnce({ workflow: EXISTING_WORKFLOW })
      .mockResolvedValueOnce({ workflow: { ...EXISTING_WORKFLOW, name: 'Escalation (edited by someone else)', version: 5 } });
    const updateWorkflow = vi.fn().mockRejectedValue(
      new WorkflowConflictError('conflict', 409, { ...EXISTING_WORKFLOW, version: 5 }),
    );
    vi.mocked(useApi).mockReturnValue(makeApi({ getWorkflow, updateWorkflow }) as unknown as ReturnType<typeof useApi>);
    const user = userEvent.setup();

    renderPage({ workflowId: 'wf_canvas_1' });
    await waitFor(() => expect(screen.getByPlaceholderText('workflows.builder.namePlaceholder')).toHaveValue('Branching Escalation'));
    await user.click(screen.getByRole('button', { name: 'workflows.builder.saveChanges' }));
    await waitFor(() => expect(screen.getByTestId('conflict-reload')).toBeInTheDocument());

    await user.click(screen.getByTestId('conflict-reload'));

    await waitFor(() => expect(getWorkflow).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByPlaceholderText('workflows.builder.namePlaceholder')).toHaveValue('Escalation (edited by someone else)'));
    expect(screen.queryByTestId('conflict-reload')).not.toBeInTheDocument();
  });
});

// DEEP_AUDIT_FIX_SPECS.md Issue 1 — save is now blocked while any action node
// is unconfigured, since a canvas-built workflow with empty action config
// silently does nothing on every execution (the single worst functional gap
// the deep audit found). This is a real, user-visible guard, not just a
// visual indicator — it must actually prevent the API call.
describe('WorkflowCanvasPage — save blocked while unconfigured (DEEP_AUDIT_FIX_SPECS.md Issue 1)', () => {
  it('does not call updateWorkflow and shows a blocked-save message when an action node has empty config', async () => {
    const unconfiguredWorkflow = {
      ...EXISTING_WORKFLOW,
      nodes: EXISTING_WORKFLOW.nodes.map((n) => (n.type === 'action' ? { ...n, config: {} } : n)),
    };
    const getWorkflow = vi.fn().mockResolvedValue({ workflow: unconfiguredWorkflow });
    const updateWorkflow = vi.fn().mockResolvedValue({ success: true });
    vi.mocked(useApi).mockReturnValue(makeApi({ getWorkflow, updateWorkflow }) as unknown as ReturnType<typeof useApi>);
    const user = userEvent.setup();

    renderPage({ workflowId: 'wf_canvas_1' });
    await waitFor(() => expect(screen.getByPlaceholderText('workflows.builder.namePlaceholder')).toHaveValue('Branching Escalation'));
    await user.click(screen.getByRole('button', { name: 'workflows.builder.saveChanges' }));

    await waitFor(() => expect(screen.getByText('workflows.canvas.saveBlockedUnconfigured')).toBeInTheDocument());
    expect(updateWorkflow).not.toHaveBeenCalled();
  });
});

describe('WorkflowCanvasPage — seed consumption from linear builder cross-link', () => {
  it('seeds a trigger + condition node from a partial seed (name/triggerType/rules)', async () => {
    renderPage({ seed: { name: 'Cross-linked flow', triggerType: 'survey.nps_drop', rules: [{ field: 'nps', op: 'lte', value: '6' }] } });

    await waitFor(() => expect(mockSetNodes).toHaveBeenCalled());
    const lastArg = mockSetNodes.mock.calls[mockSetNodes.mock.calls.length - 1][0] as Array<{ data: { kind: string } }>;
    expect(lastArg.filter((n) => n.data?.kind === 'trigger')).toHaveLength(1);
    expect(lastArg.filter((n) => n.data?.kind === 'condition')).toHaveLength(1);
    expect(screen.getByPlaceholderText('workflows.builder.namePlaceholder')).toHaveValue('Cross-linked flow');
  });

  it('treats a full seed (nodes/edges present, e.g. from the NL builder) like an edit-mode fetch result', async () => {
    renderPage({
      seed: {
        name: 'NL-proposed flow', description: 'From Crystal', triggerType: 'survey.nps_drop',
        nodes: EXISTING_WORKFLOW.nodes, edges: EXISTING_WORKFLOW.edges,
      },
    });

    await waitFor(() => {
      const lastArg = mockSetNodes.mock.calls[mockSetNodes.mock.calls.length - 1][0] as Array<{ data: { kind: string } }>;
      expect(lastArg.filter((n) => n.data?.kind === 'action')).toHaveLength(2);
    });
    expect(screen.getByPlaceholderText('workflows.builder.namePlaceholder')).toHaveValue('NL-proposed flow');
  });
});

// C-3 (DEEP_AUDIT_UX_FINDINGS.md §7/§8, Wave 11) — the canvas builder's
// drag/zoom/connect interactions are pointer-and-precision shaped and a full
// touch-gesture ReactFlow rework is explicitly out of scope this wave. The
// pragmatic fix: fluid (not fixed-width) header inputs + an advisory banner
// below desktop, driven by the existing `useBreakpoint()` hook.
describe('WorkflowCanvasPage — C-3 mobile/tablet advisory', () => {
  it('shows no advisory banner at desktop breakpoint', async () => {
    vi.mocked(useBreakpoint).mockReturnValue('desktop');
    renderPage();
    await waitFor(() => expect(screen.getByTestId('page-header-actions')).toBeInTheDocument());
    expect(screen.queryByTestId('canvas-mobile-advisory')).not.toBeInTheDocument();
  });

  it('shows the advisory banner at mobile breakpoint', async () => {
    vi.mocked(useBreakpoint).mockReturnValue('mobile');
    renderPage();
    await waitFor(() => expect(screen.getByTestId('canvas-mobile-advisory')).toBeInTheDocument());
  });

  it('shows the advisory banner at tablet breakpoint too', async () => {
    vi.mocked(useBreakpoint).mockReturnValue('tablet');
    renderPage();
    await waitFor(() => expect(screen.getByTestId('canvas-mobile-advisory')).toBeInTheDocument());
  });

  it('header name/description inputs are fluid, not fixed-width', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByPlaceholderText('workflows.builder.namePlaceholder')).toBeInTheDocument());
    const nameInput = screen.getByPlaceholderText('workflows.builder.namePlaceholder');
    const descInput = screen.getByPlaceholderText('workflows.builder.descriptionPlaceholder');
    // Fixed-width classes (w-56/w-64 with no responsive variant) must be gone;
    // both inputs should be full-width on narrow viewports (w-full) and only
    // constrained from sm: up.
    expect(nameInput.className).not.toMatch(/(?:^|\s)w-56(?:\s|$)/);
    expect(descInput.className).not.toMatch(/(?:^|\s)w-64(?:\s|$)/);
    expect(nameInput.className).toMatch(/w-full/);
    expect(descInput.className).toMatch(/w-full/);
  });
});
