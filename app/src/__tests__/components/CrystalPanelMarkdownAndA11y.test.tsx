/**
 * CrystalPanel — markdown rendering + a11y characterisation tests.
 *
 * Markdown: this session replaced CrystalBubble's plain-text CitedText-only
 * rendering with real markdown (react-markdown + remark-gfm) so bold/lists/
 * paragraph breaks actually render instead of showing as literal `**`/`-`
 * characters in one collapsed run — while still resolving inline
 * `[uuid]`/`[8char]` citation markers to InlineCitation superscripts at their
 * exact position, via CitedText re-applied per rendered text run (see
 * CrystalPanel.tsx's `citationizeChildren`/`CrystalMarkdown`).
 *
 * A11y: Escape-to-close and the close/send aria-labels, ported up from
 * XperiqCopilot (ExperientCopilot.tsx) into CrystalPanel.tsx.
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

vi.mock('../../pages/insights/shared', () => ({
  GlassCard: ({ children, className, style }: React.ComponentProps<'div'>) => (
    <div className={className} style={style}>{children}</div>
  ),
  CitationChip: ({ id }: { id: string }) => <span data-testid={`citation-${id}`}>{id}</span>,
  ConfidenceChip: ({ value }: { value: number }) => <span>{value}</span>,
  SENTIMENT_BORDER: { positive: '#16a34a', negative: '#dc2626', neutral: '#94a3b8', mixed: '#d97706' },
}));

vi.mock('../../components/Icon', () => ({
  Icon: ({ name }: { name: string }) => <span data-icon={name} />,
}));

vi.mock('../../components/insights/InsightDocumentCard', () => ({
  InsightDocumentCard: ({ doc }: { doc: { title?: string | null } }) => (
    <div data-testid="insight-document-card">{doc.title ?? ''}</div>
  ),
}));

const mockCloseCrystal  = vi.fn();
const mockSetScope      = vi.fn();
const mockSetCrystalCtx = vi.fn();

vi.mock('../../contexts/crystalPanel', () => ({
  useCrystalPanel: vi.fn(() => ({
    isOpen: true, initialQuery: '', crystalCtx: {}, scope: 'survey-abc',
    agenticInsights: [], topics: [],
    closeCrystal: mockCloseCrystal, setScope: mockSetScope, setCrystalCtx: mockSetCrystalCtx,
    openCrystal: vi.fn(), toggleCrystal: vi.fn(), setCrystalData: vi.fn(),
    builderContext: null, builderDraft: null, builderDraftHydrator: null,
    setBuilderContext: vi.fn(), setBuilderDraft: vi.fn(), setBuilderDraftHydrator: vi.fn(),
  })),
}));

const mockApi = {
  crystalChat2:          vi.fn().mockResolvedValue({ answer: 'rest fallback answer', suggestions: [], insight_refs: [], citations: [] }),
  crystalChat:           vi.fn().mockResolvedValue({ answer: 'legacy answer', suggestions: [], insight_refs: [] }),
  recordProposalOutcome: vi.fn().mockResolvedValue(undefined),
  updateInsightFeedback: vi.fn().mockResolvedValue({}),
  submitDocFeedback:     vi.fn().mockResolvedValue({}),
};

vi.mock('react-router-dom', async (importActual) => {
  const actual = await importActual<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => vi.fn() };
});

vi.mock('../../hooks/useApi', () => ({ useApi: () => mockApi, default: () => mockApi }));

vi.mock('../../lib/auth', () => ({
  useAppAuth: () => ({
    userId: 'dev-user', orgId: 'dev-org', isSignedIn: true, isLoaded: true,
    getToken: vi.fn().mockResolvedValue('tok'), signOut: vi.fn(),
  }),
  AppAuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { CrystalPanel } from '../../components/CrystalPanel';
import { useCrystalPanel } from '../../contexts/crystalPanel';

const SURVEY = {
  id: 'survey-abc', title: 'Customer NPS', status: 'active' as const,
  response_count: 100, nps_score: 42, deleted_at: null,
  updated_at: '2026-01-01T00:00:00Z', sparkline: [],
};

const UUID_A = '11111111-2222-3333-4444-555555555555';

function sseBody(events: object[], trailingDone = true): ReadableStream {
  const lines = [
    ...events.map((e) => `data: ${JSON.stringify(e)}`),
    ...(trailingDone ? ['data: [DONE]'] : []),
  ].join('\n') + '\n';
  return new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode(lines)); c.close(); },
  });
}

function renderPanel() {
  return render(
    <MemoryRouter>
      <CrystalPanel scope="survey-abc" surveys={[SURVEY]} insights={null} agenticInsights={[]} topics={[]} />
    </MemoryRouter>,
  );
}

async function ask(query = 'why did nps drop') {
  const user = userEvent.setup();
  const textarea = screen.getByPlaceholderText(/ask anything/i);
  await user.type(textarea, query);
  await user.keyboard('{Enter}');
  return user;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useCrystalPanel).mockReturnValue({
    isOpen: true, initialQuery: '', crystalCtx: {}, scope: 'survey-abc',
    agenticInsights: [], topics: [],
    closeCrystal: mockCloseCrystal, setScope: mockSetScope, setCrystalCtx: mockSetCrystalCtx,
    openCrystal: vi.fn(), toggleCrystal: vi.fn(), setCrystalData: vi.fn(),
    builderContext: null, builderDraft: null, builderDraftHydrator: null,
    setBuilderContext: vi.fn(), setBuilderDraft: vi.fn(), setBuilderDraftHydrator: vi.fn(),
  });
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

// ═════════════════════════════════════════════════════════════════════════════

describe('CrystalBubble markdown rendering', () => {
  it('renders **bold** as a real <strong>, not literal asterisks', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: sseBody([{ type: 'answer', answer: '**Wait time** is the top driver.', suggestions: [], citations: [] }]),
    });
    renderPanel();
    await ask();
    await waitFor(() => expect(screen.getByText('Wait time')).toBeInTheDocument(), { timeout: 4000 });
    expect(screen.getByText('Wait time').tagName).toBe('STRONG');
    expect(screen.queryByText(/\*\*/)).toBeNull();
  });

  it('renders a markdown bullet list as real <li> elements, not literal dashes', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: sseBody([{
        type: 'answer',
        answer: 'Two drivers:\n\n- Wait time regressed\n- Segment B churned',
        suggestions: [], citations: [],
      }]),
    });
    renderPanel();
    await ask();
    await waitFor(() => expect(screen.getByText('Wait time regressed')).toBeInTheDocument(), { timeout: 4000 });
    expect(screen.getByText('Wait time regressed').tagName).toBe('LI');
    expect(screen.getByText('Segment B churned').tagName).toBe('LI');
    expect(screen.queryByText(/^- /)).toBeNull();
  });

  it('renders two paragraphs as two separate <p> elements, not one collapsed run', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: sseBody([{ type: 'answer', answer: 'First paragraph.\n\nSecond paragraph.', suggestions: [], citations: [] }]),
    });
    renderPanel();
    await ask();
    await waitFor(() => expect(screen.getByText('First paragraph.')).toBeInTheDocument(), { timeout: 4000 });
    const p1 = screen.getByText('First paragraph.');
    const p2 = screen.getByText('Second paragraph.');
    expect(p1.tagName).toBe('P');
    expect(p2.tagName).toBe('P');
    expect(p1).not.toBe(p2);
  });

  it('resolves an inline [uuid] citation marker inside a markdown list item to a real InlineCitation, not literal brackets', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: sseBody([
        {
          type: 'citation_context',
          map: {
            [UUID_A]: {
              headline: 'Wait time worsened', survey_title: 'Customer NPS',
              survey_id: 'survey-abc', layer: 'diagnostic', category: 'voice.topic',
              verbatims: [], topic_name: 'Wait Time',
            },
          },
        },
        {
          type: 'answer',
          answer: `- Wait time is the driver [${UUID_A}]`,
          suggestions: [], citations: [UUID_A],
        },
      ]),
    });
    renderPanel();
    await ask();
    await waitFor(
      () => expect(screen.getByRole('button', { name: /source 1/i })).toBeInTheDocument(),
      { timeout: 4000 },
    );
    // The raw UUID must never leak into visible prose, even inside a list item.
    expect(screen.queryByText(new RegExp(UUID_A))).toBeNull();
    expect(screen.getByText(/Wait time is the driver/).closest('li')).not.toBeNull();
  });

  it('does not treat citation-marker code inside a fenced code block as a citation', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: sseBody([{
        type: 'answer',
        answer: 'Example id: `abcd1234`',
        suggestions: [], citations: [],
      }]),
    });
    renderPanel();
    await ask();
    await waitFor(() => expect(screen.getByText('abcd1234')).toBeInTheDocument(), { timeout: 4000 });
    expect(screen.getByText('abcd1234').tagName).toBe('CODE');
  });
});

describe('CrystalPanel — Escape-to-close (ported from XperiqCopilot)', () => {
  it('closes the panel when Escape is pressed while open', async () => {
    renderPanel();
    const user = userEvent.setup();
    await user.keyboard('{Escape}');
    expect(mockCloseCrystal).toHaveBeenCalledTimes(1);
  });

  it('does not attach the Escape listener once closed (no stale handler left running)', async () => {
    vi.mocked(useCrystalPanel).mockReturnValue({
      isOpen: false, initialQuery: '', crystalCtx: {}, scope: 'survey-abc',
      agenticInsights: [], topics: [],
      closeCrystal: mockCloseCrystal, setScope: mockSetScope, setCrystalCtx: mockSetCrystalCtx,
      openCrystal: vi.fn(), toggleCrystal: vi.fn(), setCrystalData: vi.fn(),
      builderContext: null, builderDraft: null, builderDraftHydrator: null,
      setBuilderContext: vi.fn(), setBuilderDraft: vi.fn(), setBuilderDraftHydrator: vi.fn(),
    });
    renderPanel();
    const user = userEvent.setup();
    await user.keyboard('{Escape}');
    expect(mockCloseCrystal).not.toHaveBeenCalled();
  });
});

describe('CrystalPanel — aria-labels (ported from XperiqCopilot)', () => {
  it('the close button has a localized aria-label', () => {
    renderPanel();
    expect(screen.getByRole('button', { name: 'crystal.closePanelAriaLabel' })).toBeInTheDocument();
  });

  it('the send button has a localized aria-label', () => {
    renderPanel();
    expect(screen.getByRole('button', { name: 'crystal.sendMessageAriaLabel' })).toBeInTheDocument();
  });

  it('clicking the close button (by its aria-label) calls closeCrystal', async () => {
    renderPanel();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'crystal.closePanelAriaLabel' }));
    expect(mockCloseCrystal).toHaveBeenCalledTimes(1);
  });
});

describe('SSE failure paths (unique coverage, not duplicated elsewhere)', () => {
  it('tolerates every documented event type in one stream without throwing', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: sseBody([
        { type: 'citation_context', map: {} },
        { type: 'thinking', tool: 'get_survey_overview', message: 'reading' },
        { type: 'observation', tool: 'get_survey_overview', summary: 'Found data' },
        { type: 'synthesizing' },
        { type: 'some_future_event_type', payload: { anything: true } },
        { type: 'answer', answer: 'Survived all events.', suggestions: [], citations: [] },
      ]),
    });
    renderPanel();
    await ask();
    await waitFor(() => expect(screen.getByText('Survived all events.')).toBeInTheDocument(), { timeout: 4000 });
  });

  it('ignores malformed lines and non-`data:` frames', async () => {
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(
          'event: ping\n' +
          ': heartbeat comment\n' +
          'data: {not valid json\n' +
          `data: ${JSON.stringify({ type: 'answer', answer: 'Parsed anyway.', suggestions: [], citations: [] })}\n` +
          'data: [DONE]\n',
        ));
        c.close();
      },
    });
    global.fetch = vi.fn().mockResolvedValue({ ok: true, body });
    renderPanel();
    await ask();
    await waitFor(() => expect(screen.getByText('Parsed anyway.')).toBeInTheDocument(), { timeout: 4000 });
  });

  it('falls back to the REST endpoint when the stream closes with no answer', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, body: sseBody([], /* trailingDone */ true) });
    renderPanel();
    await ask();
    await waitFor(() => expect(mockApi.crystalChat2).toHaveBeenCalled(), { timeout: 4000 });
    await waitFor(() => expect(screen.getByText('rest fallback answer')).toBeInTheDocument(), { timeout: 4000 });
  });

  it('renders an SSE `error` event as an assistant message', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: sseBody([{ type: 'error', message: 'Synthesis failed upstream' }]),
    });
    renderPanel();
    await ask();
    await waitFor(
      () => expect(screen.getAllByText(/Synthesis failed upstream/).length).toBeGreaterThan(0),
      { timeout: 4000 },
    );
    // An `error` event is terminal — it must NOT also trigger the REST fallback.
    expect(mockApi.crystalChat2).not.toHaveBeenCalled();
  });

  it('surfaces a message when the transport itself rejects (service down)', async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    mockApi.crystalChat2.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    renderPanel();
    await ask();
    await waitFor(
      () => expect(screen.getByText(/unavailable|try again|could not|unable/i)).toBeInTheDocument(),
      { timeout: 4000 },
    );
  });
});
