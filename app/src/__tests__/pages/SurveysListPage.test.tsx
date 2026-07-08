import { render, screen, waitFor, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Mocks (must precede page import) ──────────────────────────────────────────

vi.mock('../../hooks/useApi', () => ({ useApi: vi.fn(), default: vi.fn() }));
vi.mock('../../hooks/useSurveys', () => ({ useSurveys: vi.fn() }));
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: vi.fn() };
});
vi.mock('../../lib/i18n', () => ({
  useTranslation: () => ({
    t: (k: string, vars?: Record<string, unknown>) => {
      // Mirrors the real i18n's {var} interpolation (see lib/i18n.ts) so tests
      // can assert on rendered text for keys with variables (e.g. TagBadge's
      // "View Tag Report for {name}").
      const templates: Record<string, string> = {
        'tagReport.tagBadge.viewReport': 'View Tag Report for {name}',
      };
      const template = templates[k] ?? k;
      if (!vars) return template;
      return template.replace(/\{(\w+)\}/g, (_, key) => (vars[key] !== undefined ? String(vars[key]) : `{${key}}`));
    },
  }),
}));
vi.mock('../../contexts/pageTitle', () => ({
  useSetPageTitle: vi.fn(),
}));
vi.mock('../../lib/permissions', () => ({
  usePermissions: () => ({ isAdmin: true, isAnalyst: true, isViewer: true, can: () => true }),
}));

import { useApi } from '../../hooks/useApi';
import { useSurveys } from '../../hooks/useSurveys';
import { useNavigate } from 'react-router-dom';
import { SurveysListPage } from '../../pages/SurveysListPage';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const mockTag = { id: 't1', name: 'Employee Experience', color: '#6366f1', slug: 'employee-experience' };
const mockTag2 = { id: 't2', name: 'Onboarding', color: '#059669', slug: 'onboarding' };

const mockSurvey = {
  id: 's1',
  title: 'Q1 NPS Survey',
  status: 'active' as const,
  survey_type_id: 'nps',
  response_count: 42,
  updated_at: new Date().toISOString(),
  created_at: new Date().toISOString(),
  questions: [],
  tags: [mockTag],
  sparkline: [],
};

function buildMockApi(overrides: Record<string, unknown> = {}) {
  return {
    listSurveys: vi.fn().mockResolvedValue({
      surveys: [],
      total: 0,
      limit: 25,
      offset: 0,
      hasMore: false,
    }),
    listTags: vi.fn().mockResolvedValue({
      tags: [mockTag, mockTag2],
    }),
    addTagsToSurvey: vi.fn().mockResolvedValue({}),
    removeTagFromSurvey: vi.fn().mockResolvedValue({}),
    generateGroupInsights: vi.fn().mockResolvedValue({ run_id: 'run1' }),
    updateSurvey: vi.fn().mockResolvedValue({}),
    deleteSurvey: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

const mockNavigate = vi.fn();

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.mocked(useNavigate).mockReturnValue(mockNavigate);
  vi.mocked(useSurveys).mockReturnValue({
    surveys: [],
    loading: false,
    error: null,
    reload: vi.fn(),
    createSurvey: vi.fn(),
    updateSurvey: vi.fn(),
    deleteSurvey: vi.fn(),
    publishSurvey: vi.fn(),
  } as ReturnType<typeof useSurveys>);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderPage(apiOverrides: Record<string, unknown> = {}) {
  const mockApi = buildMockApi(apiOverrides);
  vi.mocked(useApi).mockReturnValue(mockApi as unknown as ReturnType<typeof useApi>);
  const utils = render(
    <MemoryRouter initialEntries={['/app/surveys']}>
      <SurveysListPage />
    </MemoryRouter>,
  );
  return { ...utils, mockApi };
}

/**
 * Create a userEvent instance that skips pointer-events checks.
 * Radix UI sets pointer-events:none on body while menus animate closed, which
 * blocks normal userEvent interactions. pointerEventsCheck: 0 sidesteps this.
 */
function setup() {
  return userEvent.setup({ pointerEventsCheck: 0 });
}

/**
 * Open the Tags MultiSelectDropdown and wait for the option list to appear.
 * NOTE: The MultiSelectDropdown uses e.preventDefault() on item clicks, so the
 * dropdown stays open after a selection. To interact with the main page after
 * selecting a tag, press Escape first to close the dropdown.
 */
async function openTagsDropdown(user: ReturnType<typeof setup>) {
  const tagsButton = await screen.findByRole('button', { name: /groups\.tags/i });
  await user.click(tagsButton);
  await waitFor(() => expect(screen.getByText('Employee Experience')).toBeInTheDocument());
  return tagsButton;
}

/**
 * Select a tag and then close the dropdown (Escape) so the main document is
 * no longer aria-hidden and filter chips are accessible.
 */
async function selectTagAndClose(user: ReturnType<typeof setup>) {
  await openTagsDropdown(user);
  await user.click(screen.getByText('Employee Experience'));
  // Confirm the count badge appeared (tag is in filter state)
  await waitFor(() => expect(screen.getByText('1')).toBeInTheDocument());
  // Close the dropdown — the TagFilter MultiSelectDropdown uses e.preventDefault()
  // so items do not auto-close; press Escape to dismiss it.
  await user.keyboard('{Escape}');
  // Wait until Radix removes aria-hidden from the main document
  await waitFor(() => {
    // The generate report button or the remove button should now be findable
    expect(document.body).not.toHaveAttribute('style', expect.stringContaining('pointer-events: none'));
  }, { timeout: 2000 }).catch(() => { /* may not have pointer-events restriction — continue */ });
}

/** Same as selectTagAndClose, but selects BOTH fixture tags — exercises the
 * multi-tag toolbar path (legacy Group Insights), preserved unchanged
 * alongside the 2026-07-03 single-tag-routes-to-Tag-Report fix. */
async function selectTwoTagsAndClose(user: ReturnType<typeof setup>) {
  await openTagsDropdown(user);
  await user.click(screen.getByText('Employee Experience'));
  await user.click(screen.getByText('Onboarding'));
  await waitFor(() => expect(screen.getByText('2')).toBeInTheDocument());
  await user.keyboard('{Escape}');
  await waitFor(() => {
    expect(document.body).not.toHaveAttribute('style', expect.stringContaining('pointer-events: none'));
  }, { timeout: 2000 }).catch(() => { /* may not have pointer-events restriction — continue */ });
}

// ── Tag filter dropdown ───────────────────────────────────────────────────────

describe('Tag filter dropdown (MultiSelectDropdown)', () => {
  it('renders the Tags filter button with label', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /groups\.tags/i })).toBeInTheDocument(),
    );
  });

  it('opening the Tags dropdown shows available tags as dot+name rows', async () => {
    const user = setup();
    renderPage();
    await openTagsDropdown(user);
    // Dropdown item renders tag name text (with a colored dot span sibling — NOT a full TagBadge pill)
    expect(screen.getByText('Employee Experience')).toBeInTheDocument();
  });

  it('clicking a tag option adds to tagFilter and button shows count badge "1"', async () => {
    const user = setup();
    renderPage();
    await openTagsDropdown(user);

    await user.click(screen.getByText('Employee Experience'));

    // The count badge is inside the MultiSelectDropdown trigger which is in the portal
    // visible area; count badge renders even while dropdown is open.
    await waitFor(() => {
      // Count badge span is visible inside/near the trigger area
      expect(screen.getByText('1')).toBeInTheDocument();
    });
  });

  it('active filter chip below toolbar uses TagBadge design (has colored dot)', async () => {
    const user = setup();
    renderPage();
    await selectTagAndClose(user);

    // The active filter chip uses TagBadge which renders a remove button with aria-label
    // "Remove <name>" — this is only rendered in the filter chip row, not in dropdown rows.
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /Remove Employee Experience/i }),
      ).toBeInTheDocument();
    });
  });

  it('clicking the chip remove button clears that tag from filter', async () => {
    const user = setup();
    renderPage();
    await selectTagAndClose(user);

    const removeButton = await screen.findByRole('button', { name: /Remove Employee Experience/i });
    await user.click(removeButton);

    await waitFor(() => {
      expect(screen.queryByText('1')).not.toBeInTheDocument();
    });
  });

  it('DropdownMenuContent for Tags has class w-64', async () => {
    const user = setup();
    renderPage();
    await openTagsDropdown(user);

    const tagText = screen.getByText('Employee Experience');

    // Walk ancestors looking for an element with class w-64 (passed as dropdownWidth prop)
    let el: HTMLElement | null = tagText.parentElement;
    let found = false;
    while (el) {
      if (el.classList.contains('w-64')) { found = true; break; }
      el = el.parentElement;
    }
    expect(found).toBe(true);
  });

  it('"Clear selection" appears after selecting a tag, and clicking it clears all tags', async () => {
    const user = setup();
    renderPage();
    await openTagsDropdown(user);
    await user.click(screen.getByText('Employee Experience'));

    // The dropdown stays open (e.preventDefault() on item click).
    // "Clear selection" appears in the still-open dropdown after a tag is selected.
    await waitFor(() =>
      expect(screen.getByText(/Clear selection/i)).toBeInTheDocument(),
    );

    await user.click(screen.getByText(/Clear selection/i));

    await waitFor(() => {
      expect(screen.queryByText('1')).not.toBeInTheDocument();
    });
  });
});

// ── Navigation state includes tags ────────────────────────────────────────────

describe('Navigation state includes tags (edit button)', () => {
  it('clicking the Edit (pencil) button navigates with state including the survey tags', async () => {
    const user = setup();
    vi.mocked(useApi).mockReturnValue(
      buildMockApi({
        listSurveys: vi.fn().mockResolvedValue({
          surveys: [mockSurvey],
          total: 1,
          limit: 20,
          offset: 0,
          hasMore: false,
        }),
      }) as unknown as ReturnType<typeof useApi>,
    );

    render(
      <MemoryRouter initialEntries={['/app/surveys']}>
        <SurveysListPage />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('Q1 NPS Survey')).toBeInTheDocument());

    // The edit button is inside the survey row — it is an icon-only ghost Button
    // (variant="ghost" size="icon") containing only an Icon component with name="edit".
    // The Icon component renders as a <span class="material-symbols-outlined">edit</span>
    // so the button's textContent is "edit".
    const surveyTitle = screen.getByText('Q1 NPS Survey');
    const surveyRow = surveyTitle.closest('[class*="rounded-2xl"]') as HTMLElement;
    expect(surveyRow).toBeTruthy();

    // Find the button whose text content is exactly "edit" (the Material Symbol glyph name)
    const allRowButtons = within(surveyRow).getAllByRole('button');
    const editButton = allRowButtons.find(
      (btn) => btn.textContent?.trim() === 'edit',
    );
    expect(editButton).toBeTruthy();
    await user.click(editButton!);

    expect(mockNavigate).toHaveBeenCalledWith(
      expect.stringContaining('/build'),
      expect.objectContaining({
        state: expect.objectContaining({
          tags: [mockTag],
        }),
      }),
    );
  });
});

// ── Tag Report entry point (per-row TagBadge onNavigate, TRACKER.md Part D) ───

describe('Survey List entry point to Tag Report', () => {
  it('clicking a per-row tag chip navigates to TAG_REPORT_LATEST for that tag, and only that', async () => {
    const user = setup();
    vi.mocked(useApi).mockReturnValue(
      buildMockApi({
        listSurveys: vi.fn().mockResolvedValue({
          surveys: [mockSurvey],
          total: 1,
          limit: 20,
          offset: 0,
          hasMore: false,
        }),
      }) as unknown as ReturnType<typeof useApi>,
    );

    render(
      <MemoryRouter initialEntries={['/app/surveys']}>
        <SurveysListPage />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('Q1 NPS Survey')).toBeInTheDocument());

    const tagChip = screen.getByRole('button', { name: /View Tag Report for Employee Experience/i });
    await user.click(tagChip);

    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('/app/experience/tags/t1/report');
  });
});

// ── Generate group report button ──────────────────────────────────────────────
//
// Fixed 2026-07-03 (customer-journey review finding): this toolbar button
// previously always ran the legacy, paid Group Insights flow regardless of
// tag-selection count. Single-tag selection (the common case — and the only
// case Tag Report actually supports, since it's always scoped to one tag) now
// routes to the free Tag Report flow instead; multi-tag selection keeps the
// legacy flow unchanged (Tag Report cannot replicate a blended multi-tag
// query), just relabeled so it's never confused with the free one.

describe('Generate report toolbar button — single tag selected (routes to Tag Report)', () => {
  it('shows the Tag Report CTA (not the legacy Group Insights label) when exactly one tag is filtered', async () => {
    const user = setup();
    renderPage();
    await selectTagAndClose(user);

    await waitFor(() => {
      expect(screen.getByText('tagReport.new.title')).toBeInTheDocument();
    });
    expect(screen.queryByText('groups.generateGroupInsightsCta')).not.toBeInTheDocument();
  });

  it('clicking it navigates straight to TAG_REPORT_NEW for the selected tag — does NOT call the legacy generateGroupInsights API', async () => {
    const user = setup();
    const { mockApi } = renderPage();
    await selectTagAndClose(user);

    await waitFor(() => expect(screen.getByText('tagReport.new.title')).toBeInTheDocument());

    const generateBtn = screen.getByText('tagReport.new.title').closest('button') as HTMLElement;
    expect(generateBtn).toBeTruthy();
    await user.click(generateBtn);

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/app/experience/tags/t1/report/new');
    });
    expect(mockApi.generateGroupInsights).not.toHaveBeenCalled();
  });
});

describe('Generate report toolbar button — multiple tags selected (legacy Group Insights, preserved)', () => {
  it('shows the relabeled Group Insights CTA (not the Tag Report label) when more than one tag is filtered', async () => {
    const user = setup();
    renderPage();
    await selectTwoTagsAndClose(user);

    await waitFor(() => {
      expect(screen.getByText('groups.generateGroupInsightsCta')).toBeInTheDocument();
    });
    expect(screen.queryByText('tagReport.new.title')).not.toBeInTheDocument();
  });

  it('clicking it still calls api.generateGroupInsights with all selected tag_ids', async () => {
    const user = setup();
    const { mockApi } = renderPage();
    await selectTwoTagsAndClose(user);

    await waitFor(() => expect(screen.getByText('groups.generateGroupInsightsCta')).toBeInTheDocument());

    const generateBtn = screen.getByText('groups.generateGroupInsightsCta').closest('button') as HTMLElement;
    expect(generateBtn).toBeTruthy();
    await user.click(generateBtn);

    await waitFor(() => {
      expect(mockApi.generateGroupInsights).toHaveBeenCalledWith({ tag_ids: ['t1', 't2'] });
    });
  });

  it('after generation, navigate is still called to the legacy GROUP_REPORT route', async () => {
    const user = setup();
    renderPage();
    await selectTwoTagsAndClose(user);

    await waitFor(() => expect(screen.getByText('groups.generateGroupInsightsCta')).toBeInTheDocument());

    const generateBtn = screen.getByText('groups.generateGroupInsightsCta').closest('button') as HTMLElement;
    await user.click(generateBtn);

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith(
        expect.stringMatching(/\/app\/groups\/t1\/report\/run1/),
      );
    });
  });
});
