import React from 'react';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── mocks (must be at top, before component imports) ──────────────────────────
vi.mock('../../hooks/useApi', () => ({ useApi: vi.fn(), default: vi.fn() }));
vi.mock('../../lib/i18n', () => ({
  useTranslation: () => ({
    t: (k: string) => {
      if (k === 'workflows.nlBuilder.examples') {
        return [
          'When a response mentions "cancel" or "refund", create a Zendesk ticket',
          "Every Monday at 9am, email the team a summary of last week's responses",
          'When NPS drops below 30, send a Slack message to #customer-success',
        ];
      }
      return k;
    },
  }),
}));
vi.mock('../../contexts/pageTitle', () => ({ useSetPageTitle: vi.fn() }));
vi.mock('../../components/PageHeader', () => ({
  PageHeader: ({ title }: { title: string }) => <div><h1>{title}</h1></div>,
}));
vi.mock('../../components/Icon', () => ({ Icon: ({ name }: { name: string }) => <span data-icon={name} /> }));
vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  },
}));
vi.mock('../../lib/dataBus', () => ({ invalidate: vi.fn() }));
vi.mock('../../components/three/NLThinkingCrystal', () => ({
  NLThinkingCrystal: () => <div data-testid="three-canvas-mock" />,
}));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: vi.fn() };
});

// ── imports after mocks ────────────────────────────────────────────────────────
import { useApi } from '../../hooks/useApi';
import { useNavigate } from 'react-router-dom';
import { WorkflowNLBuilderPage } from '../../pages/WorkflowNLBuilderPage';
import { ROUTES } from '../../constants/routes';
import { invalidate } from '../../lib/dataBus';
import { ParseWorkflowNLError } from '../../lib/api';

// ── fixtures ───────────────────────────────────────────────────────────────────
const mockNavigate = vi.fn();

const REGISTRY = {
  triggers: [
    { type: 'score.nps_drop', label: 'NPS Drop', category: 'Metrics' },
  ],
  actions: [
    { action: 'notify.slack', label: 'Slack Message', category: 'Notify' },
    { action: 'jira.create_issue', label: 'Create Jira Issue', category: 'Jira' },
  ],
  conditionOperators: ['eq', 'lte', 'gte'],
};

const HIGH_CONFIDENCE_RESULT = {
  name: 'NPS drop escalation',
  description: 'Notify support and create a ticket when NPS drops',
  triggerType: 'score.nps_drop',
  nodes: [
    { id: 'trigger', type: 'trigger', trigger: 'score.nps_drop' },
    { id: 'cond', type: 'condition', conditions: { operator: 'AND', rules: [{ field: 'nps', op: 'lt', value: 30 }] } },
    { id: 'action_0', type: 'action', action: 'notify.slack', config: {} },
    { id: 'action_1', type: 'action', action: 'jira.create_issue', config: {} },
  ],
  edges: [
    { from: 'trigger', to: 'cond' },
    { from: 'cond', to: 'action_0' },
    { from: 'cond', to: 'action_1' },
  ],
  confidence: 0.92,
  warnings: [] as string[],
};

const LOW_CONFIDENCE_RESULT = { ...HIGH_CONFIDENCE_RESULT, confidence: 0.4, warnings: ['Assumed Slack as the channel'] };

function makeApi(overrides = {}) {
  return {
    getWorkflowRegistry: vi.fn().mockResolvedValue(REGISTRY),
    createGraphWorkflow: vi.fn().mockResolvedValue({ workflow: { id: 'wf_nl_1' } }),
    parseWorkflowNL:     vi.fn().mockResolvedValue(HIGH_CONFIDENCE_RESULT),
    // Wave 12 Phase 2 — ScopeSummaryRow's name-resolution lookups. Default to
    // "nothing found" so tests that don't care about scope never hang on an
    // unresolved promise; scope-specific tests override these.
    getSurvey: vi.fn().mockRejectedValue(new Error('not found')),
    listTags:  vi.fn().mockResolvedValue({ tags: [] }),
    ...overrides,
  };
}

// ── setup / teardown ───────────────────────────────────────────────────────────
beforeEach(() => {
  vi.mocked(useNavigate).mockReturnValue(mockNavigate);
  vi.mocked(useApi).mockReturnValue(makeApi() as unknown as ReturnType<typeof useApi>);
  // jsdom does not implement matchMedia — default to "no reduced motion" unless a test overrides it.
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false, media: query, onchange: null,
      addListener: vi.fn(), removeListener: vi.fn(),
      addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });

// ── helpers ────────────────────────────────────────────────────────────────────
function renderPage() {
  render(<MemoryRouter><WorkflowNLBuilderPage /></MemoryRouter>);
}

async function generateWorkflow(user: ReturnType<typeof userEvent.setup>) {
  const textarea = screen.getByPlaceholderText('workflows.nlBuilder.placeholder');
  await user.type(textarea, 'When NPS drops below 30, notify support and create a ticket');
  await user.click(screen.getByRole('button', { name: /workflows\.nlBuilder\.generateButton/i }));
}

// ── tests ──────────────────────────────────────────────────────────────────────
describe('WorkflowNLBuilderPage — input UI', () => {
  it('renders the textarea, example chips, and a disabled Generate button when empty', () => {
    renderPage();
    expect(screen.getByPlaceholderText('workflows.nlBuilder.placeholder')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /workflows\.nlBuilder\.generateButton/i })).toBeDisabled();
    expect(screen.getAllByTitle(/./)).not.toHaveLength(0); // example chips carry a title attr
  });

  it('clicking an example chip fills the textarea without auto-submitting', async () => {
    const parseWorkflowNL = vi.fn().mockResolvedValue(HIGH_CONFIDENCE_RESULT);
    vi.mocked(useApi).mockReturnValue(makeApi({ parseWorkflowNL }) as unknown as ReturnType<typeof useApi>);
    const user = userEvent.setup();
    renderPage();

    const chip = screen.getByTitle('When NPS drops below 30, send a Slack message to #customer-success');
    await user.click(chip);

    expect(screen.getByPlaceholderText('workflows.nlBuilder.placeholder')).toHaveValue(
      'When NPS drops below 30, send a Slack message to #customer-success',
    );
    expect(parseWorkflowNL).not.toHaveBeenCalled();
  });

  it('enables the Generate button once text is entered', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByPlaceholderText('workflows.nlBuilder.placeholder'), 'test');
    expect(screen.getByRole('button', { name: /workflows\.nlBuilder\.generateButton/i })).toBeEnabled();
  });
});

describe('WorkflowNLBuilderPage — happy path', () => {
  it('calls api.parseWorkflowNL and renders the confirm card with human-readable rows on high confidence', async () => {
    const parseWorkflowNL = vi.fn().mockResolvedValue(HIGH_CONFIDENCE_RESULT);
    vi.mocked(useApi).mockReturnValue(makeApi({ parseWorkflowNL }) as unknown as ReturnType<typeof useApi>);
    const user = userEvent.setup();
    renderPage();

    await generateWorkflow(user);

    expect(parseWorkflowNL).toHaveBeenCalledWith(
      'When NPS drops below 30, notify support and create a ticket',
      expect.any(AbortSignal),
    );

    await waitFor(() => expect(screen.getByTestId('nl-confirm-card')).toBeInTheDocument());
    expect(screen.getByText('NPS Drop')).toBeInTheDocument(); // trigger label, not raw type string
    expect(screen.getByText(/Slack Message/)).toBeInTheDocument(); // action label, not raw action string
    expect(screen.getByText(/Create Jira Issue/)).toBeInTheDocument();
    expect(screen.getByDisplayValue('NPS drop escalation')).toBeInTheDocument(); // editable name field
  });

  it('Create Workflow calls createGraphWorkflow with status draft, invalidates, and navigates to the list', async () => {
    const createGraphWorkflow = vi.fn().mockResolvedValue({ workflow: { id: 'wf_nl_1' } });
    vi.mocked(useApi).mockReturnValue(makeApi({ createGraphWorkflow }) as unknown as ReturnType<typeof useApi>);
    const user = userEvent.setup();
    renderPage();

    await generateWorkflow(user);
    await waitFor(() => screen.getByTestId('nl-confirm-card'));
    await user.click(screen.getByRole('button', { name: /workflows\.nlBuilder\.createWorkflow/i }));

    await waitFor(() => expect(createGraphWorkflow).toHaveBeenCalledOnce());
    expect(createGraphWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      name: 'NPS drop escalation', triggerType: 'score.nps_drop', status: 'draft',
    }));
    expect(invalidate).toHaveBeenCalledWith('workflows');
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith(ROUTES.WORKFLOWS));
  });

  it('Discard clears the result and preserves the original textarea text', async () => {
    const user = userEvent.setup();
    renderPage();
    await generateWorkflow(user);
    await waitFor(() => screen.getByTestId('nl-confirm-card'));

    await user.click(screen.getByRole('button', { name: /workflows\.nlBuilder\.discard/i }));

    expect(screen.queryByTestId('nl-confirm-card')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('workflows.nlBuilder.placeholder')).toHaveValue(
      'When NPS drops below 30, notify support and create a ticket',
    );
  });

  it('Edit in canvas navigates to the canvas builder with a full seed', async () => {
    const user = userEvent.setup();
    renderPage();
    await generateWorkflow(user);
    await waitFor(() => screen.getByTestId('nl-confirm-card'));

    await user.click(screen.getByRole('button', { name: /workflows\.nlBuilder\.editInCanvas/i }));

    expect(mockNavigate).toHaveBeenCalledWith(ROUTES.WORKFLOW_CANVAS, {
      state: { seed: expect.objectContaining({ name: 'NPS drop escalation', triggerType: 'score.nps_drop', nodes: HIGH_CONFIDENCE_RESULT.nodes, edges: HIGH_CONFIDENCE_RESULT.edges }) },
    });
  });
});

describe('WorkflowNLBuilderPage — confidence badge tiers', () => {
  it('renders the high tier (>= 0.85) with the confidenceHigh label', async () => {
    const user = userEvent.setup();
    renderPage();
    await generateWorkflow(user);
    await waitFor(() => screen.getByTestId('nl-confirm-card'));
    const badge = screen.getByTestId('confidence-badge');
    expect(badge).toHaveAttribute('data-tier', 'high');
    expect(badge).toHaveTextContent('workflows.nlBuilder.confidenceHigh');
  });

  it('renders the medium tier (0.6-0.84) with the confidenceMedium label', async () => {
    const parseWorkflowNL = vi.fn().mockResolvedValue({ ...HIGH_CONFIDENCE_RESULT, confidence: 0.7 });
    vi.mocked(useApi).mockReturnValue(makeApi({ parseWorkflowNL }) as unknown as ReturnType<typeof useApi>);
    const user = userEvent.setup();
    renderPage();
    await generateWorkflow(user);
    await waitFor(() => screen.getByTestId('nl-confirm-card'));
    const badge = screen.getByTestId('confidence-badge');
    expect(badge).toHaveAttribute('data-tier', 'medium');
    expect(badge).toHaveTextContent('workflows.nlBuilder.confidenceMedium');
  });

  it('confidence < 0.6 never reaches the confirm-card — routed to the low-confidence state instead', async () => {
    const parseWorkflowNL = vi.fn().mockResolvedValue(LOW_CONFIDENCE_RESULT);
    vi.mocked(useApi).mockReturnValue(makeApi({ parseWorkflowNL }) as unknown as ReturnType<typeof useApi>);
    const user = userEvent.setup();
    renderPage();
    await generateWorkflow(user);

    await waitFor(() => expect(screen.getByTestId('nl-low-confidence-state')).toBeInTheDocument());
    expect(screen.queryByTestId('nl-confirm-card')).not.toBeInTheDocument();
  });
});

describe('WorkflowNLBuilderPage — low-confidence guardrail', () => {
  it('withholds the Create Workflow button in the low-confidence state', async () => {
    const parseWorkflowNL = vi.fn().mockResolvedValue(LOW_CONFIDENCE_RESULT);
    vi.mocked(useApi).mockReturnValue(makeApi({ parseWorkflowNL }) as unknown as ReturnType<typeof useApi>);
    const user = userEvent.setup();
    renderPage();
    await generateWorkflow(user);

    await waitFor(() => screen.getByTestId('nl-low-confidence-state'));
    expect(screen.queryByRole('button', { name: /workflows\.nlBuilder\.createWorkflow/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /workflows\.nlBuilder\.editInCanvas/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /workflows\.nlBuilder\.tryRewording/i })).toBeInTheDocument();
  });

  it('"Try rewording instead" clears the result and preserves the textarea text', async () => {
    const parseWorkflowNL = vi.fn().mockResolvedValue(LOW_CONFIDENCE_RESULT);
    vi.mocked(useApi).mockReturnValue(makeApi({ parseWorkflowNL }) as unknown as ReturnType<typeof useApi>);
    const user = userEvent.setup();
    renderPage();
    await generateWorkflow(user);
    await waitFor(() => screen.getByTestId('nl-low-confidence-state'));

    await user.click(screen.getByRole('button', { name: /workflows\.nlBuilder\.tryRewording/i }));
    expect(screen.queryByTestId('nl-low-confidence-state')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('workflows.nlBuilder.placeholder')).toHaveValue(
      'When NPS drops below 30, notify support and create a ticket',
    );
  });
});

describe('WorkflowNLBuilderPage — unparseable (422)', () => {
  it('shows the unparseable state with the API message and example chips', async () => {
    const parseWorkflowNL = vi.fn().mockRejectedValue(
      new ParseWorkflowNLError('UNPARSEABLE', "Crystal couldn't figure that one out", 422, ['try this instead']),
    );
    vi.mocked(useApi).mockReturnValue(makeApi({ parseWorkflowNL }) as unknown as ReturnType<typeof useApi>);
    const user = userEvent.setup();
    renderPage();
    await generateWorkflow(user);

    await waitFor(() => expect(screen.getByTestId('nl-unparseable-state')).toBeInTheDocument());
    expect(screen.getByText("Crystal couldn't figure that one out")).toBeInTheDocument();
  });
});

describe('WorkflowNLBuilderPage — timeout / abort', () => {
  it('shows the timeout state when the client-side 20s abort fires', async () => {
    const parseWorkflowNL = vi.fn().mockRejectedValue(new ParseWorkflowNLError('ABORTED', 'Request aborted'));
    vi.mocked(useApi).mockReturnValue(makeApi({ parseWorkflowNL }) as unknown as ReturnType<typeof useApi>);
    const user = userEvent.setup();
    renderPage();
    await generateWorkflow(user);

    await waitFor(() => expect(screen.getByTestId('nl-timeout-state')).toBeInTheDocument());
  });

  it('shows the timeout state on a 504 from the server', async () => {
    const parseWorkflowNL = vi.fn().mockRejectedValue(new ParseWorkflowNLError('TIMEOUT', 'Crystal did not respond in time', 504));
    vi.mocked(useApi).mockReturnValue(makeApi({ parseWorkflowNL }) as unknown as ReturnType<typeof useApi>);
    const user = userEvent.setup();
    renderPage();
    await generateWorkflow(user);

    await waitFor(() => expect(screen.getByTestId('nl-timeout-state')).toBeInTheDocument());
  });

  it('"Build manually" from the timeout state navigates to the canvas with no seed', async () => {
    const parseWorkflowNL = vi.fn().mockRejectedValue(new ParseWorkflowNLError('TIMEOUT', 'Crystal did not respond in time', 504));
    vi.mocked(useApi).mockReturnValue(makeApi({ parseWorkflowNL }) as unknown as ReturnType<typeof useApi>);
    const user = userEvent.setup();
    renderPage();
    await generateWorkflow(user);
    await waitFor(() => screen.getByTestId('nl-timeout-state'));

    await user.click(screen.getByRole('button', { name: /workflows\.nlBuilder\.buildManually/i }));
    expect(mockNavigate).toHaveBeenCalledWith(ROUTES.WORKFLOW_CANVAS);
  });

  it('aborts the in-flight request on unmount (navigate-away mid-request)', async () => {
    let capturedSignal: AbortSignal | undefined;
    const parseWorkflowNL = vi.fn((_desc: string, signal?: AbortSignal) => {
      capturedSignal = signal;
      return new Promise(() => {}); // never resolves — simulates navigate-away before response
    });
    vi.mocked(useApi).mockReturnValue(makeApi({ parseWorkflowNL }) as unknown as ReturnType<typeof useApi>);
    const user = userEvent.setup();
    const { unmount } = render(<MemoryRouter><WorkflowNLBuilderPage /></MemoryRouter>);

    await generateWorkflow(user);
    await waitFor(() => expect(parseWorkflowNL).toHaveBeenCalled());
    expect(capturedSignal?.aborted).toBe(false);

    unmount();
    expect(capturedSignal?.aborted).toBe(true);
  });
});

describe('WorkflowNLBuilderPage — double-submit guard', () => {
  it('disables the Generate button synchronously so a second click cannot fire a second request', async () => {
    let resolveFn: (v: unknown) => void = () => {};
    const parseWorkflowNL = vi.fn(() => new Promise((resolve) => { resolveFn = resolve; }));
    vi.mocked(useApi).mockReturnValue(makeApi({ parseWorkflowNL }) as unknown as ReturnType<typeof useApi>);
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByPlaceholderText('workflows.nlBuilder.placeholder'), 'test description');
    const button = screen.getByRole('button', { name: /workflows\.nlBuilder\.generateButton/i });
    await user.click(button);

    expect(parseWorkflowNL).toHaveBeenCalledTimes(1);
    // Same button now shows the thinking label and is disabled.
    const thinkingButton = screen.getByRole('button', { name: /workflows\.nlBuilder\.thinkingLabel/i });
    expect(thinkingButton).toBeDisabled();

    // A second click while thinking must not fire a second request.
    await user.click(thinkingButton);
    expect(parseWorkflowNL).toHaveBeenCalledTimes(1);

    resolveFn(HIGH_CONFIDENCE_RESULT);
    await waitFor(() => screen.getByTestId('nl-confirm-card'));
  });
});

describe('WorkflowNLBuilderPage — Cmd+Enter shortcut', () => {
  it('submits on Cmd+Enter in the textarea', async () => {
    const parseWorkflowNL = vi.fn().mockResolvedValue(HIGH_CONFIDENCE_RESULT);
    vi.mocked(useApi).mockReturnValue(makeApi({ parseWorkflowNL }) as unknown as ReturnType<typeof useApi>);
    const user = userEvent.setup();
    renderPage();

    const textarea = screen.getByPlaceholderText('workflows.nlBuilder.placeholder');
    await user.type(textarea, 'test description');
    await user.type(textarea, '{Meta>}{Enter}{/Meta}');

    await waitFor(() => expect(parseWorkflowNL).toHaveBeenCalledOnce());
  });

  it('Cmd+Enter with empty text is a no-op (no request, no error)', async () => {
    const parseWorkflowNL = vi.fn().mockResolvedValue(HIGH_CONFIDENCE_RESULT);
    vi.mocked(useApi).mockReturnValue(makeApi({ parseWorkflowNL }) as unknown as ReturnType<typeof useApi>);
    const user = userEvent.setup();
    renderPage();

    const textarea = screen.getByPlaceholderText('workflows.nlBuilder.placeholder');
    textarea.focus();
    await user.keyboard('{Meta>}{Enter}{/Meta}');

    expect(parseWorkflowNL).not.toHaveBeenCalled();
  });
});

describe('WorkflowNLBuilderPage — registry drift', () => {
  it('renders a fallback label and adds a client-side warning for an unrecognized action type', async () => {
    const driftResult = {
      ...HIGH_CONFIDENCE_RESULT,
      nodes: [
        ...HIGH_CONFIDENCE_RESULT.nodes.slice(0, 2),
        { id: 'action_0', type: 'action', action: 'unknown.future_action', config: {} },
      ],
      edges: [{ from: 'trigger', to: 'cond' }, { from: 'cond', to: 'action_0' }],
    };
    const parseWorkflowNL = vi.fn().mockResolvedValue(driftResult);
    vi.mocked(useApi).mockReturnValue(makeApi({ parseWorkflowNL }) as unknown as ReturnType<typeof useApi>);
    const user = userEvent.setup();
    renderPage();
    await generateWorkflow(user);

    await waitFor(() => screen.getByTestId('nl-confirm-card'));
    expect(screen.getByText(/unknown\.future_action/)).toBeInTheDocument();
    expect(screen.getByText('workflows.nlBuilder.registryDriftWarning')).toBeInTheDocument();
  });
});

// ── Wave 12 Phase 2 (TRACKER.md) — ScopeSummaryRow + scope plumbing ─────────────
describe('WorkflowNLBuilderPage — scope summary row', () => {
  it('renders "Org-wide" when scope fields are entirely absent from the parse result (hard backward-compat invariant)', async () => {
    // HIGH_CONFIDENCE_RESULT carries no scopeType/scopeSurveyId/scopeTagId at all.
    const getSurvey = vi.fn();
    const listTags = vi.fn();
    vi.mocked(useApi).mockReturnValue(makeApi({ getSurvey, listTags }) as unknown as ReturnType<typeof useApi>);
    const user = userEvent.setup();
    renderPage();
    await generateWorkflow(user);

    await waitFor(() => screen.getByTestId('nl-confirm-card'));
    const row = screen.getByTestId('scope-summary-row');
    expect(row).toHaveTextContent('workflows.nlBuilder.scopeOrgWide');
    // Absence must never trigger a lookup — org-wide is the terminal state, not a
    // "loading" state that happens to resolve to org.
    expect(getSurvey).not.toHaveBeenCalled();
    expect(listTags).not.toHaveBeenCalled();
  });

  it('renders "Org-wide" when scopeType is explicitly "org"', async () => {
    const parseWorkflowNL = vi.fn().mockResolvedValue({ ...HIGH_CONFIDENCE_RESULT, scopeType: 'org' });
    vi.mocked(useApi).mockReturnValue(makeApi({ parseWorkflowNL }) as unknown as ReturnType<typeof useApi>);
    const user = userEvent.setup();
    renderPage();
    await generateWorkflow(user);

    await waitFor(() => screen.getByTestId('nl-confirm-card'));
    expect(screen.getByTestId('scope-summary-row')).toHaveTextContent('workflows.nlBuilder.scopeOrgWide');
  });

  it('resolves and renders the survey NAME (not the raw id) for survey scope', async () => {
    const parseWorkflowNL = vi.fn().mockResolvedValue({
      ...HIGH_CONFIDENCE_RESULT, scopeType: 'survey', scopeSurveyId: 'srv_123',
    });
    const getSurvey = vi.fn().mockResolvedValue({ survey: { id: 'srv_123', title: 'Onboarding Survey' } });
    vi.mocked(useApi).mockReturnValue(makeApi({ parseWorkflowNL, getSurvey }) as unknown as ReturnType<typeof useApi>);
    const user = userEvent.setup();
    renderPage();
    await generateWorkflow(user);

    await waitFor(() => screen.getByTestId('nl-confirm-card'));
    await waitFor(() => expect(screen.getByTestId('scope-summary-row')).toHaveTextContent('Onboarding Survey'));
    expect(getSurvey).toHaveBeenCalledWith('srv_123');
    expect(screen.queryByText('srv_123')).not.toBeInTheDocument();
  });

  it('resolves and renders the tag NAME (not the raw id) for tag scope', async () => {
    const parseWorkflowNL = vi.fn().mockResolvedValue({
      ...HIGH_CONFIDENCE_RESULT, scopeType: 'tag', scopeTagId: 'tag_456',
    });
    const listTags = vi.fn().mockResolvedValue({ tags: [{ id: 'tag_456', name: 'VIP Customers', slug: 'vip', color: '#000' }] });
    vi.mocked(useApi).mockReturnValue(makeApi({ parseWorkflowNL, listTags }) as unknown as ReturnType<typeof useApi>);
    const user = userEvent.setup();
    renderPage();
    await generateWorkflow(user);

    await waitFor(() => screen.getByTestId('nl-confirm-card'));
    await waitFor(() => expect(screen.getByTestId('scope-summary-row')).toHaveTextContent('VIP Customers'));
    expect(screen.queryByText('tag_456')).not.toBeInTheDocument();
  });

  it('falls back to a generic label (never a raw UUID or a crash) when the scoped survey no longer resolves', async () => {
    const parseWorkflowNL = vi.fn().mockResolvedValue({
      ...HIGH_CONFIDENCE_RESULT, scopeType: 'survey', scopeSurveyId: 'srv_deleted',
    });
    const getSurvey = vi.fn().mockRejectedValue({ response: { status: 404 } });
    vi.mocked(useApi).mockReturnValue(makeApi({ parseWorkflowNL, getSurvey }) as unknown as ReturnType<typeof useApi>);
    const user = userEvent.setup();
    renderPage();
    await generateWorkflow(user);

    await waitFor(() => screen.getByTestId('nl-confirm-card'));
    await waitFor(() => expect(screen.getByTestId('scope-summary-row')).toHaveTextContent('workflows.nlBuilder.scopeSurveyFallback'));
    expect(screen.queryByText('srv_deleted')).not.toBeInTheDocument();
  });

  it('falls back to a generic label when the scoped tag no longer resolves', async () => {
    const parseWorkflowNL = vi.fn().mockResolvedValue({
      ...HIGH_CONFIDENCE_RESULT, scopeType: 'tag', scopeTagId: 'tag_deleted',
    });
    const listTags = vi.fn().mockResolvedValue({ tags: [] }); // tag no longer exists in the org's list
    vi.mocked(useApi).mockReturnValue(makeApi({ parseWorkflowNL, listTags }) as unknown as ReturnType<typeof useApi>);
    const user = userEvent.setup();
    renderPage();
    await generateWorkflow(user);

    await waitFor(() => screen.getByTestId('nl-confirm-card'));
    await waitFor(() => expect(screen.getByTestId('scope-summary-row')).toHaveTextContent('workflows.nlBuilder.scopeTagFallback'));
  });

  it('shows a loading placeholder while the survey name is resolving, then swaps to the name', async () => {
    let resolveSurvey: (v: unknown) => void = () => {};
    const getSurvey = vi.fn(() => new Promise((resolve) => { resolveSurvey = resolve; }));
    const parseWorkflowNL = vi.fn().mockResolvedValue({
      ...HIGH_CONFIDENCE_RESULT, scopeType: 'survey', scopeSurveyId: 'srv_123',
    });
    vi.mocked(useApi).mockReturnValue(makeApi({ parseWorkflowNL, getSurvey }) as unknown as ReturnType<typeof useApi>);
    const user = userEvent.setup();
    renderPage();
    await generateWorkflow(user);

    await waitFor(() => screen.getByTestId('nl-confirm-card'));
    // Still resolving — the fallback/name text must not be present yet, only the skeleton.
    expect(screen.queryByText('Onboarding Survey')).not.toBeInTheDocument();

    resolveSurvey({ survey: { id: 'srv_123', title: 'Onboarding Survey' } });
    await waitFor(() => expect(screen.getByTestId('scope-summary-row')).toHaveTextContent('Onboarding Survey'));
  });

  it('renders the scope row in the low-confidence state too', async () => {
    const parseWorkflowNL = vi.fn().mockResolvedValue({
      ...LOW_CONFIDENCE_RESULT, scopeType: 'survey', scopeSurveyId: 'srv_123',
    });
    const getSurvey = vi.fn().mockResolvedValue({ survey: { id: 'srv_123', title: 'Onboarding Survey' } });
    vi.mocked(useApi).mockReturnValue(makeApi({ parseWorkflowNL, getSurvey }) as unknown as ReturnType<typeof useApi>);
    const user = userEvent.setup();
    renderPage();
    await generateWorkflow(user);

    await waitFor(() => screen.getByTestId('nl-low-confidence-state'));
    await waitFor(() => expect(screen.getByTestId('scope-summary-row')).toHaveTextContent('Onboarding Survey'));
  });
});

describe('WorkflowNLBuilderPage — scope plumbing into createWorkflow / editInCanvas', () => {
  it('createWorkflow omits scopeType/scopeSurveyId/scopeTagId entirely when the parse result has no scope fields (byte-identical to pre-Wave-12)', async () => {
    const createGraphWorkflow = vi.fn().mockResolvedValue({ workflow: { id: 'wf_nl_1' } });
    vi.mocked(useApi).mockReturnValue(makeApi({ createGraphWorkflow }) as unknown as ReturnType<typeof useApi>);
    const user = userEvent.setup();
    renderPage();
    await generateWorkflow(user);
    await waitFor(() => screen.getByTestId('nl-confirm-card'));
    await user.click(screen.getByRole('button', { name: /workflows\.nlBuilder\.createWorkflow/i }));

    await waitFor(() => expect(createGraphWorkflow).toHaveBeenCalledOnce());
    const payload = createGraphWorkflow.mock.calls[0][0];
    expect(payload).not.toHaveProperty('scopeType');
    expect(payload).not.toHaveProperty('scopeSurveyId');
    expect(payload).not.toHaveProperty('scopeTagId');
  });

  it('createWorkflow omits scope keys when scopeType is explicitly "org"', async () => {
    const createGraphWorkflow = vi.fn().mockResolvedValue({ workflow: { id: 'wf_nl_1' } });
    const parseWorkflowNL = vi.fn().mockResolvedValue({ ...HIGH_CONFIDENCE_RESULT, scopeType: 'org' });
    vi.mocked(useApi).mockReturnValue(makeApi({ createGraphWorkflow, parseWorkflowNL }) as unknown as ReturnType<typeof useApi>);
    const user = userEvent.setup();
    renderPage();
    await generateWorkflow(user);
    await waitFor(() => screen.getByTestId('nl-confirm-card'));
    await user.click(screen.getByRole('button', { name: /workflows\.nlBuilder\.createWorkflow/i }));

    await waitFor(() => expect(createGraphWorkflow).toHaveBeenCalledOnce());
    const payload = createGraphWorkflow.mock.calls[0][0];
    expect(payload).not.toHaveProperty('scopeType');
    expect(payload).not.toHaveProperty('scopeSurveyId');
    expect(payload).not.toHaveProperty('scopeTagId');
  });

  it('createWorkflow includes scopeType + scopeSurveyId when the parse result resolved to a survey', async () => {
    const createGraphWorkflow = vi.fn().mockResolvedValue({ workflow: { id: 'wf_nl_1' } });
    const parseWorkflowNL = vi.fn().mockResolvedValue({
      ...HIGH_CONFIDENCE_RESULT, scopeType: 'survey', scopeSurveyId: 'srv_123',
    });
    const getSurvey = vi.fn().mockResolvedValue({ survey: { id: 'srv_123', title: 'Onboarding Survey' } });
    vi.mocked(useApi).mockReturnValue(makeApi({ createGraphWorkflow, parseWorkflowNL, getSurvey }) as unknown as ReturnType<typeof useApi>);
    const user = userEvent.setup();
    renderPage();
    await generateWorkflow(user);
    await waitFor(() => screen.getByTestId('nl-confirm-card'));
    await user.click(screen.getByRole('button', { name: /workflows\.nlBuilder\.createWorkflow/i }));

    await waitFor(() => expect(createGraphWorkflow).toHaveBeenCalledOnce());
    expect(createGraphWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      scopeType: 'survey', scopeSurveyId: 'srv_123',
    }));
    const payload = createGraphWorkflow.mock.calls[0][0];
    expect(payload).not.toHaveProperty('scopeTagId');
  });

  it('createWorkflow includes scopeType + scopeTagId when the parse result resolved to a tag', async () => {
    const createGraphWorkflow = vi.fn().mockResolvedValue({ workflow: { id: 'wf_nl_1' } });
    const parseWorkflowNL = vi.fn().mockResolvedValue({
      ...HIGH_CONFIDENCE_RESULT, scopeType: 'tag', scopeTagId: 'tag_456',
    });
    vi.mocked(useApi).mockReturnValue(makeApi({ createGraphWorkflow, parseWorkflowNL }) as unknown as ReturnType<typeof useApi>);
    const user = userEvent.setup();
    renderPage();
    await generateWorkflow(user);
    await waitFor(() => screen.getByTestId('nl-confirm-card'));
    await user.click(screen.getByRole('button', { name: /workflows\.nlBuilder\.createWorkflow/i }));

    await waitFor(() => expect(createGraphWorkflow).toHaveBeenCalledOnce());
    expect(createGraphWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      scopeType: 'tag', scopeTagId: 'tag_456',
    }));
    const payload = createGraphWorkflow.mock.calls[0][0];
    expect(payload).not.toHaveProperty('scopeSurveyId');
  });

  it('editInCanvas seed omits scope keys entirely when the parse result has no scope fields', async () => {
    const user = userEvent.setup();
    renderPage();
    await generateWorkflow(user);
    await waitFor(() => screen.getByTestId('nl-confirm-card'));
    await user.click(screen.getByRole('button', { name: /workflows\.nlBuilder\.editInCanvas/i }));

    expect(mockNavigate).toHaveBeenCalledWith(ROUTES.WORKFLOW_CANVAS, {
      state: { seed: expect.objectContaining({ name: 'NPS drop escalation', triggerType: 'score.nps_drop' }) },
    });
    const [, navArgs] = mockNavigate.mock.calls[0];
    expect(navArgs.state.seed).not.toHaveProperty('scopeType');
    expect(navArgs.state.seed).not.toHaveProperty('scopeSurveyId');
    expect(navArgs.state.seed).not.toHaveProperty('scopeTagId');
  });

  it('editInCanvas seed carries scopeType + scopeSurveyId through for a survey-scoped result', async () => {
    const parseWorkflowNL = vi.fn().mockResolvedValue({
      ...HIGH_CONFIDENCE_RESULT, scopeType: 'survey', scopeSurveyId: 'srv_123',
    });
    const getSurvey = vi.fn().mockResolvedValue({ survey: { id: 'srv_123', title: 'Onboarding Survey' } });
    vi.mocked(useApi).mockReturnValue(makeApi({ parseWorkflowNL, getSurvey }) as unknown as ReturnType<typeof useApi>);
    const user = userEvent.setup();
    renderPage();
    await generateWorkflow(user);
    await waitFor(() => screen.getByTestId('nl-confirm-card'));
    await user.click(screen.getByRole('button', { name: /workflows\.nlBuilder\.editInCanvas/i }));

    expect(mockNavigate).toHaveBeenCalledWith(ROUTES.WORKFLOW_CANVAS, {
      state: { seed: expect.objectContaining({ scopeType: 'survey', scopeSurveyId: 'srv_123' }) },
    });
  });

  it('editInCanvas seed carries scopeType + scopeTagId through for a tag-scoped low-confidence result', async () => {
    const parseWorkflowNL = vi.fn().mockResolvedValue({
      ...LOW_CONFIDENCE_RESULT, scopeType: 'tag', scopeTagId: 'tag_456',
    });
    vi.mocked(useApi).mockReturnValue(makeApi({ parseWorkflowNL }) as unknown as ReturnType<typeof useApi>);
    const user = userEvent.setup();
    renderPage();
    await generateWorkflow(user);
    await waitFor(() => screen.getByTestId('nl-low-confidence-state'));
    await user.click(screen.getByRole('button', { name: /workflows\.nlBuilder\.editInCanvas/i }));

    expect(mockNavigate).toHaveBeenCalledWith(ROUTES.WORKFLOW_CANVAS, {
      state: { seed: expect.objectContaining({ scopeType: 'tag', scopeTagId: 'tag_456' }) },
    });
  });
});

describe('WorkflowNLBuilderPage — 3D thinking accent lifecycle (BUILDER_SPEC_WAVE2.md §3a)', () => {
  it('mounts the 3D accent the instant thinking begins', async () => {
    let resolveFn: (v: unknown) => void = () => {};
    const parseWorkflowNL = vi.fn(() => new Promise((resolve) => { resolveFn = resolve; }));
    vi.mocked(useApi).mockReturnValue(makeApi({ parseWorkflowNL }) as unknown as ReturnType<typeof useApi>);
    const user = userEvent.setup();
    renderPage();

    expect(screen.queryByTestId('three-canvas-mock')).not.toBeInTheDocument();
    await generateWorkflow(user);
    await waitFor(() => expect(screen.getByTestId('three-canvas-mock')).toBeInTheDocument());

    resolveFn(HIGH_CONFIDENCE_RESULT);
    await waitFor(() => screen.getByTestId('nl-confirm-card'));
  });

  it('hard-unmounts the 3D accent on success, before/independent of the confirm-card animation', async () => {
    let resolveFn: (v: unknown) => void = () => {};
    const parseWorkflowNL = vi.fn(() => new Promise((resolve) => { resolveFn = resolve; }));
    vi.mocked(useApi).mockReturnValue(makeApi({ parseWorkflowNL }) as unknown as ReturnType<typeof useApi>);
    const user = userEvent.setup();
    renderPage();
    await generateWorkflow(user);
    await waitFor(() => screen.getByTestId('three-canvas-mock'));

    resolveFn(HIGH_CONFIDENCE_RESULT);
    await waitFor(() => screen.getByTestId('nl-confirm-card'));
    expect(screen.queryByTestId('three-canvas-mock')).not.toBeInTheDocument();
  });

  it('unmounts the 3D accent on the low-confidence path', async () => {
    let resolveFn: (v: unknown) => void = () => {};
    const parseWorkflowNL = vi.fn(() => new Promise((resolve) => { resolveFn = resolve; }));
    vi.mocked(useApi).mockReturnValue(makeApi({ parseWorkflowNL }) as unknown as ReturnType<typeof useApi>);
    const user = userEvent.setup();
    renderPage();
    await generateWorkflow(user);
    await waitFor(() => screen.getByTestId('three-canvas-mock'));

    resolveFn(LOW_CONFIDENCE_RESULT);
    await waitFor(() => screen.getByTestId('nl-low-confidence-state'));
    expect(screen.queryByTestId('three-canvas-mock')).not.toBeInTheDocument();
  });

  it('unmounts the 3D accent on the unparseable (error) path', async () => {
    let rejectFn: (e: unknown) => void = () => {};
    const parseWorkflowNL = vi.fn(() => new Promise((_resolve, reject) => { rejectFn = reject; }));
    vi.mocked(useApi).mockReturnValue(makeApi({ parseWorkflowNL }) as unknown as ReturnType<typeof useApi>);
    const user = userEvent.setup();
    renderPage();
    await generateWorkflow(user);
    await waitFor(() => screen.getByTestId('three-canvas-mock'));

    rejectFn(new ParseWorkflowNLError('UNPARSEABLE', 'nope', 422, []));
    await waitFor(() => screen.getByTestId('nl-unparseable-state'));
    expect(screen.queryByTestId('three-canvas-mock')).not.toBeInTheDocument();
  });

  it('unmounts the 3D accent on abort/timeout', async () => {
    let rejectFn: (e: unknown) => void = () => {};
    const parseWorkflowNL = vi.fn(() => new Promise((_resolve, reject) => { rejectFn = reject; }));
    vi.mocked(useApi).mockReturnValue(makeApi({ parseWorkflowNL }) as unknown as ReturnType<typeof useApi>);
    const user = userEvent.setup();
    renderPage();
    await generateWorkflow(user);
    await waitFor(() => screen.getByTestId('three-canvas-mock'));

    rejectFn(new ParseWorkflowNLError('ABORTED', 'aborted'));
    await waitFor(() => screen.getByTestId('nl-timeout-state'));
    expect(screen.queryByTestId('three-canvas-mock')).not.toBeInTheDocument();
  });

  it('falls back to the CSS crystal (no WebGL Canvas) when prefers-reduced-motion is set', async () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query.includes('reduce'), media: query, onchange: null,
        addListener: vi.fn(), removeListener: vi.fn(),
        addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
      })),
    });
    let resolveFn: (v: unknown) => void = () => {};
    const parseWorkflowNL = vi.fn(() => new Promise((resolve) => { resolveFn = resolve; }));
    vi.mocked(useApi).mockReturnValue(makeApi({ parseWorkflowNL }) as unknown as ReturnType<typeof useApi>);
    const user = userEvent.setup();
    renderPage();

    await generateWorkflow(user);
    await waitFor(() => expect(screen.getByTestId('nl-thinking-crystal-css')).toBeInTheDocument());
    expect(screen.queryByTestId('three-canvas-mock')).not.toBeInTheDocument();

    resolveFn(HIGH_CONFIDENCE_RESULT);
    await waitFor(() => screen.getByTestId('nl-confirm-card'));
  });
});
