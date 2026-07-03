import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../../lib/i18n', () => ({
  useTranslation: () => ({
    t: (k: string, vars?: Record<string, unknown>) => (vars ? `${k}:${JSON.stringify(vars)}` : k),
  }),
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate, useParams: () => ({ tagId: 'tag-1' }) };
});

vi.mock('../../../hooks/useApi', () => ({
  useApi: () => ({ getTagSurveys: vi.fn().mockResolvedValue({ tag: { id: 'tag-1', name: 'Onboarding' }, surveys: [] }) }),
}));
vi.mock('../../../contexts/pageTitle', () => ({ useSetPageTitle: vi.fn() }));
vi.mock('../../../pages/insights/shared', () => ({
  GlassCard: ({ children, className }: React.ComponentProps<'div'>) => <div className={className}>{children}</div>,
}));

const mockGenerate = vi.fn();
vi.mock('../../../hooks/useTagReport', () => ({
  useTagReport: () => ({ generate: mockGenerate }),
}));

import { TagReportNewPage } from '../../../pages/experience/TagReportNewPage';

afterEach(cleanup);
beforeEach(() => {
  mockNavigate.mockReset();
  mockGenerate.mockReset();
});

function renderPage() {
  return render(<MemoryRouter><TagReportNewPage /></MemoryRouter>);
}

describe('TagReportNewPage', () => {
  it('renders both mode options', () => {
    renderPage();
    expect(screen.getByText('tagReport.new.manualTitle')).toBeInTheDocument();
    expect(screen.getByText('tagReport.new.customRangeTitle')).toBeInTheDocument();
  });

  it('triggers a manual run and navigates to the resulting report on success', async () => {
    const user = userEvent.setup();
    mockGenerate.mockResolvedValue({ runId: 'run-42', error: null, inFlightNotice: null });
    renderPage();

    await user.click(screen.getByText('tagReport.new.manualCta'));

    expect(mockGenerate).toHaveBeenCalledWith({ mode: 'manual' });
    expect(mockNavigate).toHaveBeenCalledWith('/app/experience/tags/tag-1/report/run-42', { state: { inFlightNotice: null } });
  });

  it('forwards a non-null inFlightNotice through navigation state (regression test, 2026-07-03 — fixes "InFlightRunBanner unreachable": this page\'s own hook instance is discarded on navigation, so TagReportPage can only learn about an in-flight run via router state)', async () => {
    const user = userEvent.setup();
    const notice = { startedAt: '2026-07-03T00:00:00Z', trigger: 'manual' as const };
    mockGenerate.mockResolvedValue({ runId: 'run-old', error: null, inFlightNotice: notice });
    renderPage();

    await user.click(screen.getByText('tagReport.new.manualCta'));

    expect(mockNavigate).toHaveBeenCalledWith('/app/experience/tags/tag-1/report/run-old', { state: { inFlightNotice: notice } });
  });

  it('shows the SPECIFIC backend error message when the manual generate call fails (regression test, 2026-07-03 — previously always showed a fixed generic string regardless of the real reason)', async () => {
    const user = userEvent.setup();
    mockGenerate.mockResolvedValue({ runId: null, error: 'This tag has no surveys to report on', inFlightNotice: null });
    renderPage();

    await user.click(screen.getByText('tagReport.new.manualCta'));

    expect(screen.getByText('This tag has no surveys to report on')).toBeInTheDocument();
    expect(screen.queryByText('tagReport.new.errorGeneric')).not.toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('shows the rate-limit message distinctly from the no-surveys message', async () => {
    const user = userEvent.setup();
    mockGenerate.mockResolvedValue({ runId: null, error: 'Daily tag report limit reached for this tag', inFlightNotice: null });
    renderPage();

    await user.click(screen.getByText('tagReport.new.manualCta'));

    expect(screen.getByText('Daily tag report limit reached for this tag')).toBeInTheDocument();
  });

  it('falls back to the generic error string only when generate() returns no specific message', async () => {
    const user = userEvent.setup();
    mockGenerate.mockResolvedValue({ runId: null, error: null, inFlightNotice: null });
    renderPage();

    await user.click(screen.getByText('tagReport.new.manualCta'));

    expect(screen.getByText('tagReport.new.errorGeneric')).toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('requires both start and end dates before submitting a custom range', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByText('tagReport.new.customRangeCta'));

    expect(screen.getByText('tagReport.new.errorWindowRequired')).toBeInTheDocument();
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('rejects an end date before the start date', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText('tagReport.new.windowStartLabel'), '2026-06-01');
    await user.type(screen.getByLabelText('tagReport.new.windowEndLabel'), '2026-01-01');
    await user.click(screen.getByText('tagReport.new.customRangeCta'));

    expect(screen.getByText('tagReport.new.errorWindowOrder')).toBeInTheDocument();
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('submits a valid custom range window as ISO timestamps', async () => {
    const user = userEvent.setup();
    mockGenerate.mockResolvedValue({ runId: 'run-cr', error: null, inFlightNotice: null });
    renderPage();

    await user.type(screen.getByLabelText('tagReport.new.windowStartLabel'), '2026-01-01');
    await user.type(screen.getByLabelText('tagReport.new.windowEndLabel'), '2026-03-31');
    await user.click(screen.getByText('tagReport.new.customRangeCta'));

    expect(mockGenerate).toHaveBeenCalledWith(expect.objectContaining({ mode: 'custom_range' }));
    expect(mockNavigate).toHaveBeenCalledWith('/app/experience/tags/tag-1/report/run-cr', { state: { inFlightNotice: null } });
  });
});
