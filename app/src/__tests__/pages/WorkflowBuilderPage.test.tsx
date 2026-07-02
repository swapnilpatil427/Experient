import { render, screen, waitFor, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest';

// ── mocks (must be at top, before component imports) ──────────────────────────
vi.mock('../../hooks/useApi', () => ({ useApi: vi.fn(), default: vi.fn() }));
vi.mock('../../contexts/pageTitle', () => ({ useSetPageTitle: vi.fn() }));
vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
    p: ({ children, ...props }: React.HTMLAttributes<HTMLParagraphElement>) => <p {...props}>{children}</p>,
    path: (props: React.SVGProps<SVGPathElement>) => <path {...props} />,
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: vi.fn() };
});
vi.mock('../../lib/dataBus', () => ({ invalidate: vi.fn() }));

// ── imports after mocks ────────────────────────────────────────────────────────
import { useApi } from '../../hooks/useApi';
import { useNavigate } from 'react-router-dom';
import { WorkflowBuilderPage } from '../../pages/WorkflowBuilderPage';
import { ROUTES } from '../../constants/routes';
import { invalidate } from '../../lib/dataBus';
import { WorkflowConflictError } from '../../lib/api';

// ── fixtures ───────────────────────────────────────────────────────────────────
const mockNavigate = vi.fn();

const REGISTRY = {
  triggers: [
    { type: 'score.nps_drop', label: 'NPS dropped', category: 'Score' },
    { type: 'time.schedule', label: 'On a schedule (cron)', category: 'Time' },
    { type: 'survey.response_received', label: 'Response received', category: 'Survey' },
    { type: 'external.webhook', label: 'Inbound webhook', category: 'External' },
  ],
  actions: [
    { action: 'notify.in_app', label: 'In-app notification', category: 'Notify', live: true },
    { action: 'notify.slack', label: 'Slack message', category: 'Notify', live: true },
    { action: 'notify.email', label: 'Email', category: 'Notify', live: true },
    { action: 'crystal.summarize', label: 'Crystal summary', category: 'Crystal', live: 'stub' },
    { action: 'jira.create_issue', label: 'Create Jira issue', category: 'Integration', live: 'env' },
    // Wave 11 (Priya's registry entry, Rohan WAVE11_UX_SPECS.md §2.4) — a
    // second Flow-category pausing action alongside flow.approval/flow.stop.
    { action: 'flow.delay', label: 'Wait before continuing', category: 'Flow', live: true },
  ],
  conditionOperators: ['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'between', 'contains', 'not_contains', 'in', 'not_in'],
  // Wave 11 (Rohan WAVE11_UX_SPECS.md §1.7) — WorkflowBuilderPage now
  // destructures this off the same registry response WorkflowCanvasPage
  // already reads.
  conditionFields: [
    { field: 'nps', label: 'NPS score', kind: 'number' },
    { field: 'sentiment', label: 'Crystal sentiment', kind: 'string' },
  ],
};

function makeApi(overrides = {}) {
  return {
    getWorkflowRegistry: vi.fn().mockResolvedValue(REGISTRY),
    createGraphWorkflow: vi.fn().mockResolvedValue({ id: 'wf_new' }),
    getWorkflow: vi.fn(),
    updateWorkflow: vi.fn().mockResolvedValue({ success: true }),
    listSurveys: vi.fn().mockResolvedValue({
      surveys: [{ id: 'srv-csat', title: 'CSAT Q3', status: 'active', response_count: 120 }],
    }),
    listTags: vi.fn().mockResolvedValue({
      tags: [{ id: 'tag-onb', name: 'Onboarding', slug: 'onboarding', color: '#000', survey_count: 4, created_at: '' }],
    }),
    // NotifyTargetPicker (Wave 9) — mounted inside notify.email/notify.in_app's
    // action config panel.
    listUsers: vi.fn().mockResolvedValue({ users: [], total: 0, limit: 10, offset: 0, hasMore: false }),
    getUser: vi.fn().mockResolvedValue({ user: { userId: 'u1', displayName: 'CX Team', email: 'cx-team@company.com' } }),
    getNotificationTargets: vi.fn().mockResolvedValue({
      roles: [{ id: 'role-1', name: 'Support', memberCount: 5 }],
      departments: [{ id: 'dept-1', name: 'Customer Success', memberCount: 8 }],
      groups: [{ id: 'group-1', name: 'On-call', memberCount: 3 }],
    }),
    // Integration credential health (Kenji finding 1 / Maya 6c / Rohan I-1) —
    // fetched once the registry loads so connector-backed action tiles
    // (jira.create_issue etc.) can show real per-org connection status.
    listWorkflowCredentials: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

// Radix Select (ConditionStepPanelContent/DelayActionConfigPanel) needs these
// polyfilled in jsdom.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  Element.prototype.releasePointerCapture = vi.fn();
});

beforeEach(() => {
  vi.mocked(useNavigate).mockReturnValue(mockNavigate);
  vi.mocked(useApi).mockReturnValue(makeApi() as unknown as ReturnType<typeof useApi>);
});

afterEach(() => { cleanup(); vi.clearAllMocks(); });

function renderPage(routerState?: Record<string, unknown>) {
  render(
    <MemoryRouter initialEntries={[{ pathname: ROUTES.WORKFLOW_BUILD, state: routerState }]}>
      <WorkflowBuilderPage />
    </MemoryRouter>,
  );
}

describe('WorkflowBuilderPage — sentence shell', () => {
  it('renders the sentence builder shell with an empty sentence', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId('sentence-builder')).toBeInTheDocument());
    expect(screen.getByTestId('workflow-sentence')).toBeInTheDocument();
  });

  it('shows empty pills for trigger, scope, and action with the correct dashed/empty state', async () => {
    renderPage();
    await waitFor(() => screen.getByTestId('pill-trigger'));
    expect(screen.getByTestId('pill-trigger')).toHaveAttribute('data-pill-state', 'empty');
    expect(screen.getByTestId('pill-scope')).toHaveAttribute('data-pill-state', 'filled'); // org default, always resolved
    expect(screen.getByTestId('pill-add-action')).toHaveAttribute('data-pill-state', 'empty');
  });

  it('shows the helper text below the sentence', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText(/Fill in each blank/i)).toBeInTheDocument());
  });

  it('Save is disabled with an inline reason until the sentence is complete', async () => {
    renderPage();
    await waitFor(() => screen.getByRole('button', { name: /save/i }));
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
    expect(screen.getByTestId('save-disabled-reason')).toBeInTheDocument();
  });

  // S-2 (DEEP_AUDIT_UX_FINDINGS.md §8, Wave 11) — this reason text used to be
  // `hidden md:block`, so a mobile user (viewport < md) saw a disabled Save
  // button with zero explanation why. It must render without any `hidden`
  // class now, at every breakpoint.
  it('S-2: the save-disabled reason has no responsive `hidden` class (visible on mobile too)', async () => {
    renderPage();
    await waitFor(() => screen.getByTestId('save-disabled-reason'));
    const reason = screen.getByTestId('save-disabled-reason');
    expect(reason.className).not.toMatch(/(?:^|\s)hidden(?:\s|$)/);
  });
});

describe('WorkflowBuilderPage — trigger step-panel (complaint 1: full-focus window)', () => {
  it('clicking the trigger pill opens a full-focus step-panel with a tile grid, not a sidebar', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId('pill-trigger'));
    await waitFor(() => expect(screen.getByTestId('step-panel-trigger')).toBeInTheDocument());
    expect(screen.getByTestId('trigger-step-panel-content')).toBeInTheDocument();
    expect(screen.getByTestId('trigger-tile-score.nps_drop')).toBeInTheDocument();
  });

  it('selecting a trigger tile updates the sentence pill and closes back to filled state', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId('pill-trigger'));
    await user.click(await screen.findByTestId('trigger-tile-score.nps_drop'));
    await user.click(screen.getByRole('button', { name: /done/i }));
    await waitFor(() => expect(screen.queryByTestId('step-panel-trigger')).not.toBeInTheDocument());
    expect(screen.getByTestId('pill-trigger')).toHaveAttribute('data-pill-state', 'filled');
    expect(within(screen.getByTestId('pill-trigger')).getByText('NPS dropped')).toBeInTheDocument();
  });

  it('selecting the schedule trigger reveals the ScheduleTriggerConfigPanel beneath the tile grid', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId('pill-trigger'));
    await user.click(await screen.findByTestId('trigger-tile-time.schedule'));
    await waitFor(() => expect(screen.getByTestId('schedule-trigger-config-panel')).toBeInTheDocument());
    // Tile grid stays visible/pinned alongside the schedule config.
    expect(screen.getByTestId('trigger-tile-time.schedule')).toBeInTheDocument();
  });
});

describe('WorkflowBuilderPage — scope step-panel (complaint 2: real survey/tag picker)', () => {
  it('scope defaults to Org-wide and is shown as a resolved sentence pill without any action', async () => {
    renderPage();
    await waitFor(() => expect(within(screen.getByTestId('pill-scope')).getByText(/org-wide/i)).toBeInTheDocument());
  });

  it('clicking the scope pill opens the 3 option cards (Org-wide / Survey / Tag)', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId('pill-scope'));
    await waitFor(() => expect(screen.getByTestId('step-panel-scope')).toBeInTheDocument());
    expect(screen.getByTestId('scope-option-org')).toBeInTheDocument();
    expect(screen.getByTestId('scope-option-survey')).toBeInTheDocument();
    expect(screen.getByTestId('scope-option-tag')).toBeInTheDocument();
  });

  it('choosing "A specific survey" reveals a real searchable survey picker backed by api.listSurveys', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId('pill-scope'));
    await user.click(within(await screen.findByTestId('scope-option-survey')).getByRole('button'));
    await waitFor(() => expect(screen.getByTestId('scope-survey-search')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('scope-survey-row-srv-csat')).toBeInTheDocument());
    expect(within(screen.getByTestId('scope-survey-row-srv-csat')).getByText('CSAT Q3')).toBeInTheDocument();
  });

  it('selecting a survey resolves the sentence pill to "Survey: <name>"', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId('pill-scope'));
    await user.click(within(await screen.findByTestId('scope-option-survey')).getByRole('button'));
    await user.click(await screen.findByTestId('scope-survey-row-srv-csat'));
    await user.click(screen.getByRole('button', { name: /done/i }));
    await waitFor(() => expect(within(screen.getByTestId('pill-scope')).getByText(/CSAT Q3/)).toBeInTheDocument());
  });

  it('choosing "A tag / group" reveals a real searchable tag picker backed by api.listTags, showing survey_count', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId('pill-scope'));
    await user.click(within(await screen.findByTestId('scope-option-tag')).getByRole('button'));
    await waitFor(() => expect(screen.getByTestId('scope-tag-row-tag-onb')).toBeInTheDocument());
    expect(within(screen.getByTestId('scope-tag-row-tag-onb')).getByText(/4 surveys/)).toBeInTheDocument();
  });

  it('selecting a tag resolves the sentence pill to "Tag: <name>"', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId('pill-scope'));
    await user.click(within(await screen.findByTestId('scope-option-tag')).getByRole('button'));
    await user.click(await screen.findByTestId('scope-tag-row-tag-onb'));
    await user.click(screen.getByRole('button', { name: /done/i }));
    await waitFor(() => expect(within(screen.getByTestId('pill-scope')).getByText(/Onboarding/)).toBeInTheDocument());
  });
});

describe('WorkflowBuilderPage — trigger/scope validation (backend rejection mirror)', () => {
  it('allows Survey/Tag scope option cards when time.schedule is the selected trigger (Wave 7: scope drives scheduled-digest data-fetch)', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId('pill-trigger'));
    await user.click(await screen.findByTestId('trigger-tile-time.schedule'));
    await user.click(screen.getByRole('button', { name: /done/i }));

    await user.click(screen.getByTestId('pill-scope'));
    const surveyCard = screen.getByTestId('scope-option-survey');
    const tagCard = screen.getByTestId('scope-option-tag');
    expect(within(surveyCard).getByRole('button')).not.toBeDisabled();
    expect(within(tagCard).getByRole('button')).not.toBeDisabled();
    expect(within(surveyCard).queryByText(/Not available/)).not.toBeInTheDocument();
  });

  it('persists survey scope on a time.schedule trigger end to end (the Executive Weekly Digest pattern)', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId('pill-trigger'));
    await user.click(await screen.findByTestId('trigger-tile-time.schedule'));
    await user.click(screen.getByRole('button', { name: /done/i }));

    await user.click(await screen.findByTestId('pill-scope'));
    await user.click(within(await screen.findByTestId('scope-option-survey')).getByRole('button'));
    await user.click(await screen.findByTestId('scope-survey-row-srv-csat'));
    await user.click(screen.getByRole('button', { name: /done/i }));
    await waitFor(() => expect(within(screen.getByTestId('pill-scope')).getByText(/CSAT Q3/)).toBeInTheDocument());
  });

  it('disables Survey/Tag scope option cards when external.webhook is the selected trigger', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId('pill-trigger'));
    await user.click(await screen.findByTestId('trigger-tile-external.webhook'));
    await user.click(screen.getByRole('button', { name: /done/i }));

    await user.click(screen.getByTestId('pill-scope'));
    expect(within(screen.getByTestId('scope-option-survey')).getByRole('button')).toBeDisabled();
  });

  it('auto-resets scope to Org-wide if the user picks survey scope first, then switches to a webhook trigger', async () => {
    const user = userEvent.setup();
    renderPage();
    // Pick survey scope first.
    await user.click(await screen.findByTestId('pill-scope'));
    await user.click(within(await screen.findByTestId('scope-option-survey')).getByRole('button'));
    await user.click(await screen.findByTestId('scope-survey-row-srv-csat'));
    await user.click(screen.getByRole('button', { name: /done/i }));
    await waitFor(() => expect(within(screen.getByTestId('pill-scope')).getByText(/CSAT Q3/)).toBeInTheDocument());

    // Now switch to a webhook trigger — external.webhook still has no survey
    // dimension (no comparable content-generation use case for scope, unlike
    // time.schedule post-Wave 7), so scope must silently reset to org.
    await user.click(screen.getByTestId('pill-trigger'));
    await user.click(await screen.findByTestId('trigger-tile-external.webhook'));
    await user.click(screen.getByRole('button', { name: /done/i }));

    await waitFor(() => expect(within(screen.getByTestId('pill-scope')).getByText(/org-wide/i)).toBeInTheDocument());
    expect(screen.getByTestId('scope-auto-reset-notice')).toBeInTheDocument();
  });

  it('does NOT reset scope to Org-wide when switching to a time.schedule trigger (Wave 7 fix)', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId('pill-scope'));
    await user.click(within(await screen.findByTestId('scope-option-survey')).getByRole('button'));
    await user.click(await screen.findByTestId('scope-survey-row-srv-csat'));
    await user.click(screen.getByRole('button', { name: /done/i }));
    await waitFor(() => expect(within(screen.getByTestId('pill-scope')).getByText(/CSAT Q3/)).toBeInTheDocument());

    await user.click(screen.getByTestId('pill-trigger'));
    await user.click(await screen.findByTestId('trigger-tile-time.schedule'));
    await user.click(screen.getByRole('button', { name: /done/i }));

    await waitFor(() => expect(within(screen.getByTestId('pill-scope')).getByText(/CSAT Q3/)).toBeInTheDocument());
    expect(screen.queryByTestId('scope-auto-reset-notice')).not.toBeInTheDocument();
  });
});

describe('WorkflowBuilderPage — action step-panel + content customization (complaint 3)', () => {
  it('clicking "+ add an action" opens a tile grid grouped by category with readiness dots', async () => {
    const user = userEvent.setup();
    // This test asserts the registry's own static readiness tiers (live/stub/
    // env) — give the org a connected Jira credential so the real per-org
    // credential-health override (Kenji finding 1 / Maya 6c / Rohan I-1)
    // doesn't mask jira.create_issue's base 'env' tier under test.
    vi.mocked(useApi).mockReturnValue(makeApi({
      listWorkflowCredentials: vi.fn().mockResolvedValue([{ connector: 'jira', status: 'org' }]),
    }) as unknown as ReturnType<typeof useApi>);
    renderPage();
    await user.click(await screen.findByTestId('pill-add-action'));
    await waitFor(() => expect(screen.getByTestId('action-step-panel-content')).toBeInTheDocument());
    expect(screen.getByTestId('action-tile-notify.slack')).toBeInTheDocument();
    expect(screen.getByTestId('action-readiness-crystal.summarize')).toHaveAttribute('data-readiness', 'stub');
    expect(screen.getByTestId('action-readiness-jira.create_issue')).toHaveAttribute('data-readiness', 'env');
    expect(screen.getByTestId('action-readiness-notify.slack')).toHaveAttribute('data-readiness', 'true');
  });

  it('selecting notify.slack opens the two-column ContentCustomizationPanel with Crystal AI Summary genuinely uncheckable', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId('pill-add-action'));
    await user.click(await screen.findByTestId('action-tile-notify.slack'));
    await waitFor(() => expect(screen.getByTestId('content-customization-panel')).toBeInTheDocument());

    const crystalCheckbox = screen.getByTestId('section-checkbox-crystalSummary');
    expect(crystalCheckbox).not.toBeDisabled();
    expect(crystalCheckbox).toHaveAttribute('data-state', 'checked'); // Standard Digest default

    // Unchecking it must remove the corresponding block from the live preview —
    // this is the literal fix for "what if I don't want crystal summary".
    expect(screen.getByTestId('preview-block-crystalSummary')).toBeInTheDocument();
    await user.click(crystalCheckbox);
    await waitFor(() => expect(screen.queryByTestId('preview-block-crystalSummary')).not.toBeInTheDocument());
    expect(crystalCheckbox).toHaveAttribute('data-state', 'unchecked');
  });

  it('unchecking a single box after choosing a preset flips the preset dropdown display to Custom', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId('pill-add-action'));
    await user.click(await screen.findByTestId('action-tile-notify.email'));
    await waitFor(() => screen.getByTestId('section-checkbox-crystalSummary'));

    await user.click(screen.getByTestId('section-checkbox-topVerbatims'));
    expect(screen.getByTestId('section-preset-select')).toHaveTextContent('Custom');
  });

  it('non-content actions (e.g. data.tag_responses) get a simple single-column form, not the content panel', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId('pill-add-action'));
    // data.tag_responses isn't in this test's REGISTRY fixture's actions list by
    // default — add it via a fresh render with an extended registry.
    cleanup();
    vi.mocked(useApi).mockReturnValue(makeApi({
      getWorkflowRegistry: vi.fn().mockResolvedValue({
        ...REGISTRY,
        actions: [...REGISTRY.actions, { action: 'data.tag_responses', label: 'Tag responses', category: 'Data', live: true }],
      }),
    }) as unknown as ReturnType<typeof useApi>);
    renderPage();
    await user.click(await screen.findByTestId('pill-add-action'));
    await user.click(await screen.findByTestId('action-tile-data.tag_responses'));
    await waitFor(() => expect(screen.getByTestId('simple-action-config-form')).toBeInTheDocument());
    expect(screen.queryByTestId('content-customization-panel')).not.toBeInTheDocument();
  });

  // Finding: Maya DEEP_AUDIT_PM_FINDINGS.md 2a (single-source, grep-confirmed
  // against both `SimpleActionConfigForm.tsx`'s FIELDS_BY_ACTION map and
  // `ContentCustomizationPanel.tsx`'s CONTENT_PRODUCING_ACTIONS set — neither
  // has a `notify.webhook` entry) — `notify.webhook` is a LIVE, fully-wired
  // backend action (workflowEngine.ts's LIVE_ACTIONS set includes it, and its
  // `executeAction` case reads `config.url`/`config.payload`/`config.headers`/
  // `config.method`/`config.secret` directly), but the builder gives it zero
  // configuration UI — every webhook action built through the sentence builder
  // saves with an empty config and silently no-ops forever (engine's own skip
  // path: `status: 'skipped', reason: 'no_url'`).
  //
  // This test asserts the fix-shaped expectation — selecting notify.webhook
  // should render a real config form with a URL field the customer can fill
  // in — so it is RED against current code, which renders "No additional
  // configuration needed" instead. That failure is the executable proof.
  it('selecting notify.webhook (a live backend action) renders a URL config field — RED, proves 2a', async () => {
    const user = userEvent.setup();
    cleanup();
    vi.mocked(useApi).mockReturnValue(makeApi({
      getWorkflowRegistry: vi.fn().mockResolvedValue({
        ...REGISTRY,
        actions: [...REGISTRY.actions, { action: 'notify.webhook', label: 'Webhook', category: 'Notify', live: true }],
      }),
    }) as unknown as ReturnType<typeof useApi>);
    renderPage();
    await user.click(await screen.findByTestId('pill-add-action'));
    await user.click(await screen.findByTestId('action-tile-notify.webhook'));

    // A correct fix wires notify.webhook into FIELDS_BY_ACTION (or
    // CONTENT_PRODUCING_ACTIONS) with at minimum a URL input the customer can
    // fill in — matching how executeAction actually consumes config.url. Today
    // it falls through to SimpleActionConfigForm's zero-fields branch, so no
    // such field exists and this assertion fails.
    await waitFor(() => expect(screen.getByTestId('simple-action-config-form')).toBeInTheDocument());
    expect(screen.getByLabelText(/url/i)).toBeInTheDocument();
  });

  it('adding a second action clause renders it in the growing action-clause list with its own independent default section state', async () => {
    const user = userEvent.setup();
    renderPage();

    // First action: Slack, uncheck Crystal Summary.
    await user.click(await screen.findByTestId('pill-add-action'));
    await user.click(await screen.findByTestId('action-tile-notify.slack'));
    await user.click(await screen.findByTestId('section-checkbox-crystalSummary'));
    await user.click(screen.getByRole('button', { name: /done/i }));

    await waitFor(() => expect(screen.getByTestId('action-clause-list')).toBeInTheDocument());

    // Second action: Email — its own checklist must start from the default
    // (Crystal AI Summary checked), not inherit Slack's edited state.
    await user.click(screen.getByTestId('pill-add-another-action'));
    await user.click(await screen.findByTestId('action-tile-notify.email'));
    await waitFor(() => expect(screen.getByTestId('section-checkbox-crystalSummary')).toHaveAttribute('data-state', 'checked'));
  });

  it('removing an action clause removes it from the sentence', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId('pill-add-action'));
    await user.click(await screen.findByTestId('action-tile-notify.in_app'));
    await user.click(screen.getByRole('button', { name: /done/i }));
    await waitFor(() => screen.getByTestId('action-clause-list'));

    const clause = screen.getAllByText('In-app notification')[0];
    const clauseWrapper = clause.closest('[data-testid^="action-clause-"]') as HTMLElement;
    await user.click(within(clauseWrapper).getByLabelText(/remove action/i));
    await waitFor(() => expect(screen.getByTestId('pill-add-action')).toBeInTheDocument());
  });
});

// Kenji finding 1 / Maya DEEP_AUDIT_PM_FINDINGS.md 6c / Rohan
// DEEP_AUDIT_UX_FINDINGS.md I-1 — the builder used to show every org the same
// static 'env' readiness dot for jira.create_issue regardless of whether that
// org had actually connected Jira. Fixed: WorkflowBuilderPage now fetches
// GET /api/workflow-credentials once the registry loads and threads a real
// per-org credentialStatus map down to ActionTile via ActionStepPanelContent.
describe('WorkflowBuilderPage — integration credential health (Kenji finding 1 / Maya 6c / Rohan I-1)', () => {
  it('shows a disconnected readiness dot and a link to Integrations Settings for a connector-backed action with no org credentials', async () => {
    const user = userEvent.setup();
    vi.mocked(useApi).mockReturnValue(makeApi({
      listWorkflowCredentials: vi.fn().mockResolvedValue([{ connector: 'jira', status: 'none' }]),
    }) as unknown as ReturnType<typeof useApi>);
    renderPage();
    await user.click(await screen.findByTestId('pill-add-action'));
    await waitFor(() => expect(screen.getByTestId('action-readiness-jira.create_issue')).toHaveAttribute('data-readiness', 'disconnected'));
    await user.click(screen.getByTestId('action-tile-jira.create_issue'));
    await waitFor(() => expect(screen.getByTestId('action-disconnected-banner')).toBeInTheDocument());
    expect(screen.getByRole('link', { name: /integrations settings/i })).toBeInTheDocument();
  });

  it('shows the normal env readiness dot (no disconnected banner) when the org has a connected Jira credential', async () => {
    const user = userEvent.setup();
    vi.mocked(useApi).mockReturnValue(makeApi({
      listWorkflowCredentials: vi.fn().mockResolvedValue([{ connector: 'jira', status: 'org' }]),
    }) as unknown as ReturnType<typeof useApi>);
    renderPage();
    await user.click(await screen.findByTestId('pill-add-action'));
    await waitFor(() => expect(screen.getByTestId('action-readiness-jira.create_issue')).toHaveAttribute('data-readiness', 'env'));
    await user.click(screen.getByTestId('action-tile-jira.create_issue'));
    expect(screen.queryByTestId('action-disconnected-banner')).not.toBeInTheDocument();
  });
});

describe('WorkflowBuilderPage — full "Weekly NPS Digest" journey (concept doc §6, adapted)', () => {
  // NOTE: this test uses score.nps_drop rather than the concept doc §6's
  // illustrative time.schedule + survey-scope pairing ("When 'Every Monday at
  // 9:00 AM' on Survey: CSAT Q3"). At the time this test was written,
  // time.schedule genuinely could not be survey/tag-scoped (an earlier version
  // of schemas/workflows.ts's SCOPE_UNSUPPORTED_TRIGGER_TYPES rejected it). As
  // of Wave 7, time.schedule DOES legally support survey/tag scope (scope now
  // drives what a scheduled digest fetches to summarize — see
  // fetchScheduledSurveyMetrics) — that exact combination is covered by the
  // dedicated "persists survey scope on a time.schedule trigger" test above.
  // This test is left on score.nps_drop since it's an equally valid, already-
  // covered scope-selection path and rewriting it adds no new coverage.
  it('builds the exact payload: NPS-drop trigger, survey scope, two actions with divergent section state', async () => {
    const user = userEvent.setup();
    const createGraphWorkflow = vi.fn().mockResolvedValue({ id: 'wf_new' });
    const listUsers = vi.fn().mockResolvedValue({
      users: [{ userId: 'u-cx', displayName: 'CX Team', email: 'cx-team@company.com' }],
      total: 1, limit: 10, offset: 0, hasMore: false,
    });
    vi.mocked(useApi).mockReturnValue(makeApi({ createGraphWorkflow, listUsers }) as unknown as ReturnType<typeof useApi>);
    renderPage();

    // Name.
    const nameInput = screen.getByPlaceholderText('Untitled automation');
    await user.type(nameInput, 'Weekly NPS Digest');

    // Trigger: NPS dropped (survey-scopable, unlike time.schedule/external.webhook).
    await user.click(screen.getByTestId('pill-trigger'));
    await user.click(await screen.findByTestId('trigger-tile-score.nps_drop'));
    await user.click(screen.getByRole('button', { name: /done/i }));
    await waitFor(() => expect(screen.queryByTestId('step-panel-trigger')).not.toBeInTheDocument());

    // Scope: survey, CSAT Q3.
    await user.click(screen.getByTestId('pill-scope'));
    await waitFor(() => screen.getByTestId('step-panel-scope'));
    await user.click(within(await screen.findByTestId('scope-option-survey')).getByRole('button'));
    await user.click(await screen.findByTestId('scope-survey-row-srv-csat'));
    await user.click(screen.getByRole('button', { name: /done/i }));
    await waitFor(() => expect(screen.queryByTestId('step-panel-scope')).not.toBeInTheDocument());

    // First action: Slack, uncheck Crystal Summary, set channel.
    await user.click(screen.getByTestId('pill-add-action'));
    await waitFor(() => screen.getByTestId('step-panel-action'));
    await user.click(await screen.findByTestId('action-tile-notify.slack'));
    await user.click(await screen.findByTestId('section-checkbox-crystalSummary'));
    await user.click(screen.getByText(/advanced fields/i));
    const channelInput = await screen.findByLabelText(/channel/i);
    await user.type(channelInput, '#cx-team');
    await user.click(screen.getByRole('button', { name: /done/i }));
    await waitFor(() => expect(screen.queryByTestId('step-panel-action')).not.toBeInTheDocument());

    // Second action: Email, uncheck Crystal Summary, add Top Verbatims, target a specific person.
    await user.click(screen.getByTestId('pill-add-another-action'));
    await waitFor(() => screen.getByTestId('step-panel-action'));
    await user.click(await screen.findByTestId('action-tile-notify.email'));
    await user.click(await screen.findByTestId('section-checkbox-crystalSummary'));
    await user.click(await screen.findByTestId('section-checkbox-topVerbatims'));
    await user.click(screen.getByText(/advanced fields/i));
    const peopleSearch = await screen.findByTestId('notify-target-people-search');
    await user.type(peopleSearch, 'CX');
    await user.click(await screen.findByTestId('notify-target-person-u-cx'));
    await user.click(screen.getByRole('button', { name: /done/i }));
    await waitFor(() => expect(screen.queryByTestId('step-panel-action')).not.toBeInTheDocument());

    // Save.
    await user.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(createGraphWorkflow).toHaveBeenCalledOnce());

    const payload = createGraphWorkflow.mock.calls[0][0];
    expect(payload.name).toBe('Weekly NPS Digest');
    expect(payload.triggerType).toBe('score.nps_drop');
    expect(payload.scopeType).toBe('survey');
    expect(payload.scopeSurveyId).toBe('srv-csat');

    const actionNodes = payload.nodes.filter((n: { type: string }) => n.type === 'action');
    expect(actionNodes).toHaveLength(2);

    const slackNode = actionNodes.find((n: { action: string }) => n.action === 'notify.slack');
    expect(slackNode.config.sections.crystalSummary).toBe(false);
    expect(slackNode.config.sections.keyMetrics).toBe(true);
    expect(slackNode.config.channel).toBe('#cx-team');

    const emailNode = actionNodes.find((n: { action: string }) => n.action === 'notify.email');
    expect(emailNode.config.sections.crystalSummary).toBe(false);
    expect(emailNode.config.sections.topVerbatims).toBe(true);
    expect(emailNode.config.targetType).toBe('users');
    expect(emailNode.config.userIds).toEqual(['u-cx']);

    expect(invalidate).toHaveBeenCalledWith('workflows');
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith(ROUTES.WORKFLOWS));
  });
});

describe('WorkflowBuilderPage — validation', () => {
  it('shows an error when saving with empty name', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId('pill-trigger'));
    await user.click(await screen.findByTestId('trigger-tile-score.nps_drop'));
    await user.click(screen.getByRole('button', { name: /done/i }));
    await user.click(screen.getByTestId('pill-add-action'));
    await user.click(await screen.findByTestId('action-tile-notify.in_app'));
    await user.click(screen.getByRole('button', { name: /done/i }));

    // Save is disabled (no name) — clicking a disabled button is a no-op, so
    // assert the disabled state + reason directly rather than expecting a
    // post-click error banner.
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
    expect(screen.getByTestId('save-disabled-reason')).toHaveTextContent(/name/i);
  });
});

// DEEP_AUDIT_FIX_SPECS.md Issue 3 / Rohan DEEP_AUDIT_UX_FINDINGS.md C-1 — the
// create-mode branch of switchToCanvas() used to send only
// `{ name, triggerType }`, silently dropping every already-configured action
// (and scope/cooldown). Fixed: the full serialize() output (nodes/edges) is
// now carried over, matching the exact seed shape templates/the NL builder
// already use — plus a confirm-before-switch warning when scope/cooldown are
// non-default, since the canvas has nowhere to receive them.
describe('WorkflowBuilderPage — Advanced: Branching Canvas hand-off (DEEP_AUDIT_FIX_SPECS.md Issue 3)', () => {
  it('carries the full serialize() output (nodes/edges) into the canvas seed, not just name/triggerType', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId('pill-trigger'));
    await user.click(await screen.findByTestId('trigger-tile-score.nps_drop'));
    await user.click(screen.getByRole('button', { name: /done/i }));
    await user.click(await screen.findByTestId('pill-add-action'));
    await user.click(await screen.findByTestId('action-tile-notify.slack'));
    await user.click(screen.getByRole('button', { name: /done/i }));

    const nameInput = screen.getByPlaceholderText('Untitled automation');
    await user.type(nameInput, 'My Automation');

    await user.click(screen.getByText(/Advanced: Branching Canvas/));
    expect(mockNavigate).toHaveBeenCalledWith(
      ROUTES.WORKFLOW_CANVAS,
      expect.objectContaining({
        state: expect.objectContaining({
          seed: expect.objectContaining({
            name: 'My Automation',
            triggerType: 'score.nps_drop',
            nodes: expect.arrayContaining([
              expect.objectContaining({ type: 'trigger', trigger: 'score.nps_drop' }),
              expect.objectContaining({ type: 'action', action: 'notify.slack' }),
            ]),
            edges: expect.any(Array),
          }),
        }),
      }),
    );
  });

  it('switches straight through with no warning when scope and cooldown are both left at their defaults', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId('pill-trigger'));
    await user.click(await screen.findByTestId('trigger-tile-score.nps_drop'));
    await user.click(screen.getByRole('button', { name: /done/i }));
    await user.click(screen.getByText(/Advanced: Branching Canvas/));
    expect(mockNavigate).toHaveBeenCalledWith(ROUTES.WORKFLOW_CANVAS, expect.anything());
    expect(screen.queryByText('Switch to the canvas builder?')).not.toBeInTheDocument();
  });

  it('shows a confirm dialog instead of navigating immediately when scope is non-default', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId('pill-trigger'));
    await user.click(await screen.findByTestId('trigger-tile-score.nps_drop'));
    await user.click(screen.getByRole('button', { name: /done/i }));

    // Set a non-default (survey) scope.
    await user.click(await screen.findByTestId('pill-scope'));
    await user.click(within(await screen.findByTestId('scope-option-survey')).getByRole('button'));
    await user.click(await screen.findByTestId('scope-survey-row-srv-csat'));
    await user.click(screen.getByRole('button', { name: /done/i }));

    await user.click(screen.getByText(/Advanced: Branching Canvas/));
    expect(mockNavigate).not.toHaveBeenCalledWith(ROUTES.WORKFLOW_CANVAS, expect.anything());
    expect(screen.getByText('Switch to the canvas builder?')).toBeInTheDocument();

    // Confirming navigates with the full seed.
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(mockNavigate).toHaveBeenCalledWith(ROUTES.WORKFLOW_CANVAS, expect.objectContaining({
      state: expect.objectContaining({ seed: expect.objectContaining({ name: '' }) }),
    }));
  });

  it('cancelling the confirm dialog does not navigate', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId('pill-trigger'));
    await user.click(await screen.findByTestId('trigger-tile-score.nps_drop'));
    await user.click(screen.getByRole('button', { name: /done/i }));

    await user.click(await screen.findByTestId('pill-scope'));
    await user.click(within(await screen.findByTestId('scope-option-survey')).getByRole('button'));
    await user.click(await screen.findByTestId('scope-survey-row-srv-csat'));
    await user.click(screen.getByRole('button', { name: /done/i }));

    await user.click(screen.getByText(/Advanced: Branching Canvas/));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(mockNavigate).not.toHaveBeenCalledWith(ROUTES.WORKFLOW_CANVAS, expect.anything());
    expect(screen.queryByText('Switch to the canvas builder?')).not.toBeInTheDocument();
  });

  it('always navigates immediately in edit mode, regardless of scope/cooldown (existing behavior, unchanged)', async () => {
    const getWorkflow = vi.fn().mockResolvedValue({
      workflow: {
        id: 'wf_1', name: 'Edit Me', description: '', trigger_type: 'score.nps_drop',
        scope_type: 'survey', scope_survey_id: 'srv-csat',
        nodes: [{ id: 'trigger', type: 'trigger', trigger: 'score.nps_drop' }, { id: 'action_0', type: 'action', action: 'notify.in_app', config: {} }],
        edges: [{ from: 'trigger', to: 'action_0' }],
        status: 'draft', cooldown_minutes: 120,
      },
    });
    vi.mocked(useApi).mockReturnValue(makeApi({ getWorkflow }) as unknown as ReturnType<typeof useApi>);
    const user = userEvent.setup();
    renderPage({ workflowId: 'wf_1' });
    await waitFor(() => expect(screen.getByDisplayValue('Edit Me')).toBeInTheDocument());
    await user.click(screen.getByText(/Advanced: Branching Canvas/));
    expect(mockNavigate).toHaveBeenCalledWith(ROUTES.WORKFLOW_CANVAS, { state: { workflowId: 'wf_1' } });
    expect(screen.queryByText('Switch to the canvas builder?')).not.toBeInTheDocument();
  });
});

describe('WorkflowBuilderPage — workflow settings (cooldown) affordance', () => {
  it('opens the WorkflowSettingsPanel in a Sheet via the settings icon button', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: /workflow settings/i }));
    await waitFor(() => expect(screen.getByTestId('workflow-settings-panel')).toBeInTheDocument());
  });
});

describe('WorkflowBuilderPage — edit mode rehydration', () => {
  it('reloading an existing survey-scoped workflow rehydrates the scope pill and action clauses', async () => {
    // NPS-drop trigger (not time.schedule/external.webhook) — survey scope is
    // a valid combination per the backend's own rejection rule, unlike a
    // schedule trigger which can only ever be org-scoped.
    const getWorkflow = vi.fn().mockResolvedValue({
      workflow: {
        id: 'wf_1',
        name: 'NPS Drop Digest',
        description: '',
        trigger_type: 'score.nps_drop',
        scope_type: 'survey',
        scope_survey_id: 'srv-csat',
        nodes: [
          { id: 'trigger', type: 'trigger', trigger: 'score.nps_drop' },
          { id: 'action_0', type: 'action', action: 'notify.in_app', config: {} },
        ],
        edges: [{ from: 'trigger', to: 'action_0' }],
        status: 'draft',
        cooldown_minutes: 60,
      },
    });
    vi.mocked(useApi).mockReturnValue(makeApi({ getWorkflow }) as unknown as ReturnType<typeof useApi>);

    renderPage({ workflowId: 'wf_1' });

    await waitFor(() => expect(within(screen.getByTestId('pill-trigger')).getByText(/NPS dropped/i)).toBeInTheDocument());
    await waitFor(() => expect(within(screen.getByTestId('pill-scope')).getByText(/CSAT Q3/)).toBeInTheDocument());
    expect(screen.getByTestId('action-clause-list')).toBeInTheDocument();
  });

  it('reloading a workflow with a legacy notify.email config (config.userId only, no targetType) loads the picker into "Specific people" mode showing that user', async () => {
    const getWorkflow = vi.fn().mockResolvedValue({
      workflow: {
        id: 'wf_legacy',
        name: 'Legacy Email Alert',
        description: '',
        trigger_type: 'score.nps_drop',
        scope_type: 'org',
        nodes: [
          { id: 'trigger', type: 'trigger', trigger: 'score.nps_drop' },
          { id: 'action_0', type: 'action', action: 'notify.email', config: { sections: { crystalSummary: true, keyMetrics: true, topVerbatims: false, trendChart: true, recommendedActions: false, rawResponseCount: false }, preset: 'standard', userId: 'legacy-user-1' } },
        ],
        edges: [{ from: 'trigger', to: 'action_0' }],
        status: 'draft',
        cooldown_minutes: 60,
      },
    });
    const getUser = vi.fn().mockResolvedValue({ user: { userId: 'legacy-user-1', displayName: 'Legacy User', email: 'legacy@company.com' } });
    vi.mocked(useApi).mockReturnValue(makeApi({ getWorkflow, getUser }) as unknown as ReturnType<typeof useApi>);

    const user = userEvent.setup();
    renderPage({ workflowId: 'wf_legacy' });

    await waitFor(() => expect(screen.getByTestId('action-clause-list')).toBeInTheDocument());
    // Re-open the email action clause to inspect the picker's hydrated state.
    await user.click(within(screen.getByTestId('action-clause-list')).getByText('Email'));
    await waitFor(() => expect(screen.getByTestId('step-panel-action')).toBeInTheDocument());
    await user.click(screen.getByText(/advanced fields/i));
    expect(await screen.findByText('Legacy User')).toBeInTheDocument();
  });

  it('reloading a workflow with a legacy notify.in_app config (config.userIds only, no targetType) loads the picker with those users pre-selected', async () => {
    const getWorkflow = vi.fn().mockResolvedValue({
      workflow: {
        id: 'wf_legacy2',
        name: 'Legacy In-App Alert',
        description: '',
        trigger_type: 'score.nps_drop',
        scope_type: 'org',
        nodes: [
          { id: 'trigger', type: 'trigger', trigger: 'score.nps_drop' },
          { id: 'action_0', type: 'action', action: 'notify.in_app', config: { userIds: ['legacy-a', 'legacy-b'] } },
        ],
        edges: [{ from: 'trigger', to: 'action_0' }],
        status: 'draft',
        cooldown_minutes: 60,
      },
    });
    const getUser = vi.fn()
      .mockImplementation((userId: string) => Promise.resolve({
        user: userId === 'legacy-a'
          ? { userId: 'legacy-a', displayName: 'Legacy A', email: 'a@company.com' }
          : { userId: 'legacy-b', displayName: 'Legacy B', email: 'b@company.com' },
      }));
    vi.mocked(useApi).mockReturnValue(makeApi({ getWorkflow, getUser }) as unknown as ReturnType<typeof useApi>);

    const user = userEvent.setup();
    renderPage({ workflowId: 'wf_legacy2' });
    await waitFor(() => expect(screen.getByTestId('action-clause-list')).toBeInTheDocument());

    // Re-open the action clause to inspect the picker's hydrated state.
    await user.click(within(screen.getByTestId('action-clause-list')).getByText('In-app notification'));
    await waitFor(() => expect(screen.getByTestId('step-panel-action')).toBeInTheDocument());
    expect(await screen.findByText('Legacy A')).toBeInTheDocument();
    expect(await screen.findByText('Legacy B')).toBeInTheDocument();
  });

  it('REGRESSION: saving an edit to an already-active workflow preserves status=active, never silently forces draft', async () => {
    // Deep-audit finding (2026-07-01): both builders unconditionally sent
    // status: 'draft' on every save, including edits — meaning a routine
    // "tweak the Slack wording" edit on a live workflow silently disabled it,
    // with zero warning. This is the load-bearing regression guard for that fix.
    const getWorkflow = vi.fn().mockResolvedValue({
      workflow: {
        id: 'wf_active',
        name: 'NPS Drop Alert',
        description: '',
        trigger_type: 'score.nps_drop',
        scope_type: 'org',
        nodes: [
          { id: 'trigger', type: 'trigger', trigger: 'score.nps_drop' },
          { id: 'action_0', type: 'action', action: 'notify.in_app', config: {} },
        ],
        edges: [{ from: 'trigger', to: 'action_0' }],
        status: 'active',
        cooldown_minutes: 60,
      },
    });
    const updateWorkflow = vi.fn().mockResolvedValue({ success: true });
    vi.mocked(useApi).mockReturnValue(makeApi({ getWorkflow, updateWorkflow }) as unknown as ReturnType<typeof useApi>);

    const user = userEvent.setup();
    renderPage({ workflowId: 'wf_active' });
    await waitFor(() => expect(within(screen.getByTestId('pill-trigger')).getByText(/NPS dropped/i)).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(updateWorkflow).toHaveBeenCalled());
    expect(updateWorkflow).toHaveBeenCalledWith(
      'wf_active',
      expect.objectContaining({ status: 'active' }),
    );
    expect(updateWorkflow).not.toHaveBeenCalledWith('wf_active', expect.objectContaining({ status: 'draft' }));
  });

  it('a brand-new workflow (create mode) still defaults to status=draft', async () => {
    const createGraphWorkflow = vi.fn().mockResolvedValue({ id: 'wf_new' });
    vi.mocked(useApi).mockReturnValue(makeApi({ createGraphWorkflow }) as unknown as ReturnType<typeof useApi>);

    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByPlaceholderText('Untitled automation'), 'New Automation');
    await user.click(await screen.findByTestId('pill-trigger'));
    await user.click(await screen.findByTestId('trigger-tile-score.nps_drop'));
    await user.click(screen.getByRole('button', { name: /done/i }));
    await user.click(screen.getByTestId('pill-add-action'));
    await user.click(await screen.findByTestId('action-tile-notify.in_app'));
    await user.click(screen.getByRole('button', { name: /done/i }));

    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(createGraphWorkflow).toHaveBeenCalled());
    expect(createGraphWorkflow).toHaveBeenCalledWith(expect.objectContaining({ status: 'draft' }));
  });
});

describe('WorkflowBuilderPage — template seed (Wave 9, "Start from Template")', () => {
  it('a full template seed (nodes/edges) pre-fills trigger AND action clauses, not just the trigger pill', async () => {
    const seed = {
      name: 'NPS Drop Alert',
      description: 'Fires when NPS falls below threshold',
      triggerType: 'score.nps_drop',
      nodes: [
        { id: 'trigger', type: 'trigger', trigger: 'score.nps_drop' },
        { id: 'action_0', type: 'action', action: 'notify.email', config: { sections: { crystalSummary: true, keyMetrics: true, topVerbatims: false, trendChart: true, recommendedActions: false, rawResponseCount: false }, preset: 'standard' } },
      ],
      edges: [{ from: 'trigger', to: 'action_0' }],
    };
    renderPage({ seed });

    await waitFor(() => expect(within(screen.getByTestId('pill-trigger')).getByText(/NPS dropped/i)).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('action-clause-list')).toBeInTheDocument());
    // Name/description also seeded (not just trigger type).
    expect(screen.getByPlaceholderText('Untitled automation')).toHaveValue('NPS Drop Alert');
  });

  it('does NOT call createGraphWorkflow just from mounting with a template seed (no mutation on navigation alone)', async () => {
    const createGraphWorkflow = vi.fn();
    vi.mocked(useApi).mockReturnValue(makeApi({ createGraphWorkflow }) as unknown as ReturnType<typeof useApi>);
    const seed = {
      name: 'NPS Drop Alert',
      triggerType: 'score.nps_drop',
      nodes: [
        { id: 'trigger', type: 'trigger', trigger: 'score.nps_drop' },
        { id: 'action_0', type: 'action', action: 'notify.email', config: {} },
      ],
      edges: [{ from: 'trigger', to: 'action_0' }],
    };
    renderPage({ seed });
    await waitFor(() => expect(screen.getByTestId('action-clause-list')).toBeInTheDocument());
    expect(createGraphWorkflow).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Wave 11, Task 1 — condition step (Rohan WAVE11_UX_SPECS.md §1).
// ═══════════════════════════════════════════════════════════════════════════

describe('WorkflowBuilderPage — condition step: zero-condition backward compatibility (CRITICAL)', () => {
  // This is the single most important test in this wave's frontend surface
  // (per WAVE11_UX_SPECS.md §1.2) — it's the thing that keeps every workflow
  // saved before the condition-step feature existed working identically
  // after. Builds a workflow with trigger + scope + action and NEVER touches
  // the condition step, then asserts the saved payload's `nodes` array has
  // exactly the pre-Wave-11 shape: {trigger, action} node types only, zero
  // `condition`-typed nodes, and the condition node's absence doesn't shift
  // the edge chain either.
  it('REGRESSION: a workflow with no condition pill touched produces a nodes array with NO condition node — byte-identical to pre-Wave-11 serialize()', async () => {
    const createGraphWorkflow = vi.fn().mockResolvedValue({ id: 'wf_new' });
    vi.mocked(useApi).mockReturnValue(makeApi({ createGraphWorkflow }) as unknown as ReturnType<typeof useApi>);

    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByPlaceholderText('Untitled automation'), 'No Condition Workflow');
    await user.click(await screen.findByTestId('pill-trigger'));
    await user.click(await screen.findByTestId('trigger-tile-score.nps_drop'));
    await user.click(screen.getByRole('button', { name: /done/i }));
    await user.click(screen.getByTestId('pill-add-action'));
    await user.click(await screen.findByTestId('action-tile-notify.in_app'));
    await user.click(screen.getByRole('button', { name: /done/i }));

    // Never opens the condition step-panel at all.
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(createGraphWorkflow).toHaveBeenCalled());
    const payload = createGraphWorkflow.mock.calls[0][0] as { nodes: Array<{ type: string }>; edges: Array<{ from: string; to: string }> };

    // Exactly {trigger, action} node types — no condition node anywhere.
    expect(payload.nodes.map((n) => n.type)).toEqual(['trigger', 'action']);
    expect(payload.nodes.some((n) => n.type === 'condition')).toBe(false);
    // Edge chain is a simple 2-node chain, unaffected by the condition
    // feature's existence.
    expect(payload.edges).toEqual([{ from: 'trigger', to: 'action_0' }]);
  });

  it('the condition pill starts in the empty/optional state and does not block Save', async () => {
    renderPage();
    await waitFor(() => screen.getByTestId('pill-condition'));
    expect(screen.getByTestId('pill-condition')).toHaveAttribute('data-pill-state', 'empty');
    expect(within(screen.getByTestId('pill-condition')).getByText(/\(optional\)/i)).toBeInTheDocument();
  });

  it('loading an existing workflow with no condition node in its saved nodes array hydrates conditionClauses to empty', async () => {
    const getWorkflow = vi.fn().mockResolvedValue({
      workflow: {
        id: 'wf_no_cond',
        name: 'No Condition',
        description: '',
        trigger_type: 'score.nps_drop',
        scope_type: 'org',
        nodes: [
          { id: 'trigger', type: 'trigger', trigger: 'score.nps_drop' },
          { id: 'action_0', type: 'action', action: 'notify.in_app', config: {} },
        ],
        edges: [{ from: 'trigger', to: 'action_0' }],
        status: 'draft',
        cooldown_minutes: 60,
      },
    });
    vi.mocked(useApi).mockReturnValue(makeApi({ getWorkflow }) as unknown as ReturnType<typeof useApi>);
    renderPage({ workflowId: 'wf_no_cond' });
    await waitFor(() => expect(screen.getByTestId('action-clause-list')).toBeInTheDocument());
    expect(screen.getByTestId('pill-condition')).toHaveAttribute('data-pill-state', 'empty');
  });
});

describe('WorkflowBuilderPage — condition step: adding a condition', () => {
  it('clicking the condition pill opens the condition step-panel', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId('pill-condition'));
    await waitFor(() => expect(screen.getByTestId('step-panel-condition')).toBeInTheDocument());
    expect(screen.getByTestId('condition-step-panel-content')).toBeInTheDocument();
  });

  it('adding one condition updates the resting pill to the compact symbolic label and saves a single condition node', async () => {
    const createGraphWorkflow = vi.fn().mockResolvedValue({ id: 'wf_new' });
    vi.mocked(useApi).mockReturnValue(makeApi({ createGraphWorkflow }) as unknown as ReturnType<typeof useApi>);

    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByPlaceholderText('Untitled automation'), 'With Condition');
    await user.click(await screen.findByTestId('pill-trigger'));
    await user.click(await screen.findByTestId('trigger-tile-score.nps_drop'));
    await user.click(screen.getByRole('button', { name: /done/i }));

    await user.click(screen.getByTestId('pill-condition'));
    await user.click(screen.getByTestId('condition-add-another'));
    const rows = screen.getAllByTestId(/condition-row-/);
    const rowId = rows[0].getAttribute('data-testid')!.replace('condition-row-', '');
    await user.type(screen.getByTestId(`condition-value-${rowId}`), '30');
    await user.click(screen.getByRole('button', { name: /done/i }));

    // Resting pill now shows the compact "NPS score = 30" symbolic label
    // (default field/op are the registry's first entries: nps / eq).
    expect(screen.getByTestId('pill-condition')).toHaveAttribute('data-pill-state', 'condition');
    expect(within(screen.getByTestId('pill-condition')).getByText(/NPS score = 30/)).toBeInTheDocument();

    await user.click(screen.getByTestId('pill-add-action'));
    await user.click(await screen.findByTestId('action-tile-notify.in_app'));
    await user.click(screen.getByRole('button', { name: /done/i }));
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(createGraphWorkflow).toHaveBeenCalled());
    const payload = createGraphWorkflow.mock.calls[0][0] as { nodes: Array<{ type: string; conditions?: { operator: string; rules: Array<{ field: string; op: string; value: unknown }> } }> };
    const conditionNode = payload.nodes.find((n) => n.type === 'condition');
    expect(conditionNode).toBeDefined();
    expect(conditionNode!.conditions).toEqual({ operator: 'AND', rules: [{ field: 'nps', op: 'eq', value: 30 }] });
    // Inserted right after the trigger, before the action node.
    expect(payload.nodes.map((n) => n.type)).toEqual(['trigger', 'condition', 'action']);
  });

  it('2+ conditions collapse the resting pill to a count summary, and serialize into ONE condition node with multiple rules', async () => {
    const createGraphWorkflow = vi.fn().mockResolvedValue({ id: 'wf_new' });
    vi.mocked(useApi).mockReturnValue(makeApi({ createGraphWorkflow }) as unknown as ReturnType<typeof useApi>);

    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByPlaceholderText('Untitled automation'), 'Two Conditions');
    await user.click(await screen.findByTestId('pill-trigger'));
    await user.click(await screen.findByTestId('trigger-tile-score.nps_drop'));
    await user.click(screen.getByRole('button', { name: /done/i }));

    await user.click(screen.getByTestId('pill-condition'));
    await user.click(screen.getByTestId('condition-add-another'));
    await user.click(screen.getByTestId('condition-add-another'));
    expect(screen.getAllByTestId(/condition-row-/)).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: /done/i }));

    expect(within(screen.getByTestId('pill-condition')).getByText('2 conditions')).toBeInTheDocument();

    await user.click(screen.getByTestId('pill-add-action'));
    await user.click(await screen.findByTestId('action-tile-notify.in_app'));
    await user.click(screen.getByRole('button', { name: /done/i }));
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(createGraphWorkflow).toHaveBeenCalled());
    const payload = createGraphWorkflow.mock.calls[0][0] as { nodes: Array<{ type: string; conditions?: { rules: unknown[] } }> };
    const conditionNodes = payload.nodes.filter((n) => n.type === 'condition');
    // Never multiple condition nodes — one node with rules: [...].
    expect(conditionNodes).toHaveLength(1);
    expect(conditionNodes[0].conditions!.rules).toHaveLength(2);
  });
});

describe('WorkflowBuilderPage — condition step: edit-mode rehydration', () => {
  it('reloading a workflow with a saved condition node rehydrates the pill and step-panel', async () => {
    const getWorkflow = vi.fn().mockResolvedValue({
      workflow: {
        id: 'wf_with_cond',
        name: 'NPS Drop Digest',
        description: '',
        trigger_type: 'score.nps_drop',
        scope_type: 'org',
        nodes: [
          { id: 'trigger', type: 'trigger', trigger: 'score.nps_drop' },
          { id: 'condition', type: 'condition', conditions: { operator: 'AND', rules: [{ field: 'nps', op: 'lt', value: 30 }] } },
          { id: 'action_0', type: 'action', action: 'notify.in_app', config: {} },
        ],
        edges: [{ from: 'trigger', to: 'condition' }, { from: 'condition', to: 'action_0' }],
        status: 'draft',
        cooldown_minutes: 60,
      },
    });
    vi.mocked(useApi).mockReturnValue(makeApi({ getWorkflow }) as unknown as ReturnType<typeof useApi>);

    renderPage({ workflowId: 'wf_with_cond' });
    await waitFor(() => expect(screen.getByTestId('pill-condition')).toHaveAttribute('data-pill-state', 'condition'));
    expect(within(screen.getByTestId('pill-condition')).getByText(/NPS score < 30/)).toBeInTheDocument();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Wave 11, Task 2 — flow.delay config UI (Rohan WAVE11_UX_SPECS.md §2).
// ═══════════════════════════════════════════════════════════════════════════

describe('WorkflowBuilderPage — flow.delay: config UI + serialize round-trip', () => {
  it('selecting flow.delay in the action tile grid renders the DelayActionConfigPanel', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByTestId('pill-add-action'));
    await user.click(await screen.findByTestId('action-tile-flow.delay'));
    await waitFor(() => expect(screen.getByTestId('delay-action-config-panel')).toBeInTheDocument());
    // Default value is 1 hour, not 1 minute.
    expect(within(screen.getByTestId('delay-preview')).getByText('Then wait 1 hour before continuing.')).toBeInTheDocument();
  });

  it('saves delay_minutes converted from the friendly amount/unit, plus delayUiState for round-trip', async () => {
    const createGraphWorkflow = vi.fn().mockResolvedValue({ id: 'wf_new' });
    vi.mocked(useApi).mockReturnValue(makeApi({ createGraphWorkflow }) as unknown as ReturnType<typeof useApi>);

    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByPlaceholderText('Untitled automation'), 'Delay Workflow');
    await user.click(await screen.findByTestId('pill-trigger'));
    await user.click(await screen.findByTestId('trigger-tile-score.nps_drop'));
    await user.click(screen.getByRole('button', { name: /done/i }));

    await user.click(screen.getByTestId('pill-add-action'));
    await user.click(await screen.findByTestId('action-tile-flow.delay'));
    await waitFor(() => screen.getByTestId('delay-action-config-panel'));
    await user.click(screen.getByRole('button', { name: /done/i }));
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(createGraphWorkflow).toHaveBeenCalled());
    const payload = createGraphWorkflow.mock.calls[0][0] as { nodes: Array<{ type: string; action?: string; config?: { delay_minutes?: number; delayUiState?: unknown } }> };
    const delayNode = payload.nodes.find((n) => n.action === 'flow.delay');
    expect(delayNode?.config?.delay_minutes).toBe(60);
    expect(delayNode?.config?.delayUiState).toEqual({ amount: 1, unit: 'hours' });
  });

  it('re-editing a saved flow.delay action restores the exact friendly amount/unit, not a back-calculated fraction', async () => {
    const getWorkflow = vi.fn().mockResolvedValue({
      workflow: {
        id: 'wf_delay',
        name: 'Escalation with delay',
        description: '',
        trigger_type: 'score.nps_drop',
        scope_type: 'org',
        nodes: [
          { id: 'trigger', type: 'trigger', trigger: 'score.nps_drop' },
          { id: 'action_0', type: 'action', action: 'flow.delay', config: { delay_minutes: 125, delayUiState: { amount: 125, unit: 'minutes' } } },
        ],
        edges: [{ from: 'trigger', to: 'action_0' }],
        status: 'draft',
        cooldown_minutes: 60,
      },
    });
    vi.mocked(useApi).mockReturnValue(makeApi({ getWorkflow }) as unknown as ReturnType<typeof useApi>);

    const user = userEvent.setup();
    renderPage({ workflowId: 'wf_delay' });
    await waitFor(() => expect(screen.getByTestId('action-clause-list')).toBeInTheDocument());
    await user.click(within(screen.getByTestId('action-clause-list')).getByText(/wait/i));
    await waitFor(() => screen.getByTestId('delay-action-config-panel'));
    expect(within(screen.getByTestId('delay-preview')).getByText('Then wait 125 minutes before continuing.')).toBeInTheDocument();
  });

  it('a flow.delay node with delay_minutes but no delayUiState (e.g. created via API) falls back to minutesToUiState', async () => {
    const getWorkflow = vi.fn().mockResolvedValue({
      workflow: {
        id: 'wf_delay_no_ui',
        name: 'API-created delay',
        description: '',
        trigger_type: 'score.nps_drop',
        scope_type: 'org',
        nodes: [
          { id: 'trigger', type: 'trigger', trigger: 'score.nps_drop' },
          { id: 'action_0', type: 'action', action: 'flow.delay', config: { delay_minutes: 120 } },
        ],
        edges: [{ from: 'trigger', to: 'action_0' }],
        status: 'draft',
        cooldown_minutes: 60,
      },
    });
    vi.mocked(useApi).mockReturnValue(makeApi({ getWorkflow }) as unknown as ReturnType<typeof useApi>);

    const user = userEvent.setup();
    renderPage({ workflowId: 'wf_delay_no_ui' });
    await waitFor(() => expect(screen.getByTestId('action-clause-list')).toBeInTheDocument());
    await user.click(within(screen.getByTestId('action-clause-list')).getByText(/wait/i));
    await waitFor(() => screen.getByTestId('delay-action-config-panel'));
    // 120 minutes -> friendliest unit is hours: "2 hours", not "120 minutes".
    expect(within(screen.getByTestId('delay-preview')).getByText('Then wait 2 hours before continuing.')).toBeInTheDocument();
  });
});

describe('WorkflowBuilderPage — flow.delay: pill treatment + execution-order hint', () => {
  it('a flow.delay action clause renders with the Flow-category amber/pause-icon pill', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByTestId('pill-add-action'));
    await user.click(await screen.findByTestId('action-tile-flow.delay'));
    await user.click(screen.getByRole('button', { name: /done/i }));

    const clause = within(screen.getByTestId('action-clause-list')).getByText(/wait/i).closest('[data-testid^="action-clause-"]');
    expect(clause).toHaveAttribute('data-category', 'Flow');
  });

  it('shows the flow-order hint caption once a Flow action exists, and hides it when there are none', async () => {
    const user = userEvent.setup();
    renderPage();
    expect(screen.queryByTestId('flow-order-hint')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('pill-add-action'));
    await user.click(await screen.findByTestId('action-tile-flow.delay'));
    await user.click(screen.getByRole('button', { name: /done/i }));

    await waitFor(() => expect(screen.getByTestId('flow-order-hint')).toBeInTheDocument());
  });

  it('a non-Flow action alone shows no execution-order hint', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByTestId('pill-add-action'));
    await user.click(await screen.findByTestId('action-tile-notify.in_app'));
    await user.click(screen.getByRole('button', { name: /done/i }));
    expect(screen.queryByTestId('flow-order-hint')).not.toBeInTheDocument();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Wave 11, Item 1 — concurrent-edit conflict UI (Nina's version/409 contract).
// ═══════════════════════════════════════════════════════════════════════════

const EDIT_MODE_WORKFLOW = {
  id: 'wf_conflict',
  name: 'Escalation Flow',
  description: '',
  trigger_type: 'score.nps_drop',
  scope_type: 'org',
  nodes: [
    { id: 'trigger', type: 'trigger', trigger: 'score.nps_drop' },
    { id: 'action_0', type: 'action', action: 'notify.in_app', config: {} },
  ],
  edges: [{ from: 'trigger', to: 'action_0' }],
  status: 'draft',
  cooldown_minutes: 60,
  version: 3,
};

describe('WorkflowBuilderPage — concurrent-edit protection: version plumbing', () => {
  it('create mode never sends a version field on save', async () => {
    const createGraphWorkflow = vi.fn().mockResolvedValue({ id: 'wf_new' });
    vi.mocked(useApi).mockReturnValue(makeApi({ createGraphWorkflow }) as unknown as ReturnType<typeof useApi>);

    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByPlaceholderText('Untitled automation'), 'Brand New');
    await user.click(await screen.findByTestId('pill-trigger'));
    await user.click(await screen.findByTestId('trigger-tile-score.nps_drop'));
    await user.click(screen.getByRole('button', { name: /done/i }));
    await user.click(screen.getByTestId('pill-add-action'));
    await user.click(await screen.findByTestId('action-tile-notify.in_app'));
    await user.click(screen.getByRole('button', { name: /done/i }));
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(createGraphWorkflow).toHaveBeenCalled());
    expect(createGraphWorkflow.mock.calls[0][0]).not.toHaveProperty('version');
  });

  it('edit mode sends the loaded workflow\'s version on save', async () => {
    const getWorkflow = vi.fn().mockResolvedValue({ workflow: EDIT_MODE_WORKFLOW });
    const updateWorkflow = vi.fn().mockResolvedValue({ success: true, version: 4 });
    vi.mocked(useApi).mockReturnValue(makeApi({ getWorkflow, updateWorkflow }) as unknown as ReturnType<typeof useApi>);

    const user = userEvent.setup();
    renderPage({ workflowId: 'wf_conflict' });
    await waitFor(() => expect(within(screen.getByTestId('pill-trigger')).getByText(/NPS dropped/i)).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(updateWorkflow).toHaveBeenCalled());
    expect(updateWorkflow).toHaveBeenCalledWith('wf_conflict', expect.objectContaining({ version: 3 }));
  });
});

describe('WorkflowBuilderPage — concurrent-edit protection: 409 conflict dialog', () => {
  it('shows the conflict dialog on a 409 WorkflowConflictError instead of a generic error banner', async () => {
    const getWorkflow = vi.fn().mockResolvedValue({ workflow: EDIT_MODE_WORKFLOW });
    const updateWorkflow = vi.fn().mockRejectedValue(
      new WorkflowConflictError('This workflow was changed by someone else.', 409, { ...EDIT_MODE_WORKFLOW, version: 5 }),
    );
    vi.mocked(useApi).mockReturnValue(makeApi({ getWorkflow, updateWorkflow }) as unknown as ReturnType<typeof useApi>);

    const user = userEvent.setup();
    renderPage({ workflowId: 'wf_conflict' });
    await waitFor(() => expect(within(screen.getByTestId('pill-trigger')).getByText(/NPS dropped/i)).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(screen.getByText('This workflow was changed by someone else')).toBeInTheDocument());
    expect(screen.getByTestId('conflict-reload')).toBeInTheDocument();
    expect(screen.getByTestId('conflict-overwrite')).toBeInTheDocument();
    // Not treated as a generic save error.
    expect(screen.queryByText(/could not save workflow/i)).not.toBeInTheDocument();
  });

  it('a non-409 error still shows the generic error banner, not the conflict dialog', async () => {
    const getWorkflow = vi.fn().mockResolvedValue({ workflow: EDIT_MODE_WORKFLOW });
    const updateWorkflow = vi.fn().mockRejectedValue(new Error('Network error'));
    vi.mocked(useApi).mockReturnValue(makeApi({ getWorkflow, updateWorkflow }) as unknown as ReturnType<typeof useApi>);

    const user = userEvent.setup();
    renderPage({ workflowId: 'wf_conflict' });
    await waitFor(() => expect(within(screen.getByTestId('pill-trigger')).getByText(/NPS dropped/i)).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(screen.getByText('Network error')).toBeInTheDocument());
    expect(screen.queryByTestId('conflict-reload')).not.toBeInTheDocument();
  });

  it('"Reload latest" re-fetches the workflow and discards local edits', async () => {
    const getWorkflow = vi.fn()
      .mockResolvedValueOnce({ workflow: EDIT_MODE_WORKFLOW })
      .mockResolvedValueOnce({ workflow: { ...EDIT_MODE_WORKFLOW, name: 'Escalation Flow (edited by someone else)', version: 5 } });
    const updateWorkflow = vi.fn().mockRejectedValue(
      new WorkflowConflictError('conflict', 409, { ...EDIT_MODE_WORKFLOW, version: 5 }),
    );
    vi.mocked(useApi).mockReturnValue(makeApi({ getWorkflow, updateWorkflow }) as unknown as ReturnType<typeof useApi>);

    const user = userEvent.setup();
    renderPage({ workflowId: 'wf_conflict' });
    await waitFor(() => expect(within(screen.getByTestId('pill-trigger')).getByText(/NPS dropped/i)).toBeInTheDocument());
    await user.type(screen.getByPlaceholderText('Untitled automation'), ' (my local edit)');
    await user.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(screen.getByTestId('conflict-reload')).toBeInTheDocument());

    await user.click(screen.getByTestId('conflict-reload'));

    await waitFor(() => expect(getWorkflow).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByPlaceholderText('Untitled automation')).toHaveValue('Escalation Flow (edited by someone else)'));
    expect(screen.queryByTestId('conflict-reload')).not.toBeInTheDocument();
  });

  it('"Overwrite anyway" re-submits the same PUT with version omitted (force-save)', async () => {
    const getWorkflow = vi.fn().mockResolvedValue({ workflow: EDIT_MODE_WORKFLOW });
    const updateWorkflow = vi.fn()
      .mockRejectedValueOnce(new WorkflowConflictError('conflict', 409, { ...EDIT_MODE_WORKFLOW, version: 5 }))
      .mockResolvedValueOnce({ success: true, version: 6 });
    vi.mocked(useApi).mockReturnValue(makeApi({ getWorkflow, updateWorkflow }) as unknown as ReturnType<typeof useApi>);

    const user = userEvent.setup();
    renderPage({ workflowId: 'wf_conflict' });
    await waitFor(() => expect(within(screen.getByTestId('pill-trigger')).getByText(/NPS dropped/i)).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(screen.getByTestId('conflict-overwrite')).toBeInTheDocument());

    await user.click(screen.getByTestId('conflict-overwrite'));

    await waitFor(() => expect(updateWorkflow).toHaveBeenCalledTimes(2));
    // The second call (the overwrite) must NOT include `version` at all.
    const overwriteCallArgs = updateWorkflow.mock.calls[1][1];
    expect(overwriteCallArgs).not.toHaveProperty('version');
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith(ROUTES.WORKFLOWS));
  });
});
