import { renderHook, waitFor, act, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { TagReportRun, TagReportRunResponse } from '../../types/tagReport';

vi.mock('../../hooks/useApi', () => ({
  useApi: vi.fn(),
  default: vi.fn(),
}));

import { useApi } from '../../hooks/useApi';
import { useTagReport, useTagReportTrail, useTagReportsIndex } from '../../hooks/useTagReport';
import { invalidate } from '../../lib/dataBus';

function makeRun(overrides: Partial<TagReportRun> = {}): TagReportRun {
  return {
    id: 'run-1',
    org_id: 'org-1',
    tag_id: 'tag-1',
    tag_ids: ['tag-1'],
    run_mode: 'manual',
    trigger: 'manual',
    status: 'completed',
    window_start: null,
    window_end: null,
    parent_run_id: null,
    stream_events: [],
    created_at: '2026-07-02T00:00:00Z',
    ...overrides,
  };
}

function makeRunResponse(overrides: Partial<TagReportRunResponse> = {}): TagReportRunResponse {
  return {
    run: makeRun(),
    metric_tracks: [],
    sources: [],
    pool_size: 8,
    examined_count: 8,
    included_count: 5,
    backfill_occurred: false,
    ...overrides,
  };
}

const mockGetTagReportHistory = vi.fn();
const mockGetTagReportRun = vi.fn();
const mockGenerateTagReport = vi.fn();
const mockGetTagReportTrail = vi.fn();
const mockListTagReports = vi.fn();

const mockApi = {
  getTagReportHistory: mockGetTagReportHistory,
  getTagReportRun: mockGetTagReportRun,
  generateTagReport: mockGenerateTagReport,
  getTagReportTrail: mockGetTagReportTrail,
  listTagReports: mockListTagReports,
};

beforeEach(() => {
  vi.mocked(useApi).mockReturnValue(mockApi as unknown as ReturnType<typeof useApi>);
  mockGetTagReportHistory.mockReset();
  mockGetTagReportRun.mockReset();
  mockGenerateTagReport.mockReset();
  mockGetTagReportTrail.mockReset();
  mockListTagReports.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useTagReport', () => {
  it('resolves the latest run via getTagReportHistory when no runId is given', async () => {
    mockGetTagReportHistory.mockResolvedValue({ runs: [{ run_id: 'run-9', run_mode: 'manual', trigger: 'manual', created_at: '2026-07-01', metric_tracks_narrated: 1 }], total: 1 });
    mockGetTagReportRun.mockResolvedValue(makeRunResponse({ run: makeRun({ id: 'run-9' }) }));

    const { result } = renderHook(() => useTagReport('tag-1', undefined));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockGetTagReportHistory).toHaveBeenCalledWith('tag-1', { limit: 1 });
    expect(mockGetTagReportRun).toHaveBeenCalledWith('run-9');
    expect(result.current.run?.id).toBe('run-9');
  });

  it('loads a specific run directly when runId is given, skipping history lookup', async () => {
    mockGetTagReportRun.mockResolvedValue(makeRunResponse());

    const { result } = renderHook(() => useTagReport('tag-1', 'run-1'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockGetTagReportHistory).not.toHaveBeenCalled();
    expect(mockGetTagReportRun).toHaveBeenCalledWith('run-1');
    expect(result.current.run?.id).toBe('run-1');
  });

  it('sets run=null when no history exists for the tag', async () => {
    mockGetTagReportHistory.mockResolvedValue({ runs: [], total: 0 });

    const { result } = renderHook(() => useTagReport('tag-1', undefined));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.run).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('sets error when the API call rejects', async () => {
    mockGetTagReportHistory.mockRejectedValue(new Error('network down'));

    const { result } = renderHook(() => useTagReport('tag-1', undefined));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('network down');
  });

  it('exposes pool/examined/included/backfill counts from the run response', async () => {
    mockGetTagReportRun.mockResolvedValue(makeRunResponse({ pool_size: 12, examined_count: 8, included_count: 5, backfill_occurred: true }));

    const { result } = renderHook(() => useTagReport('tag-1', 'run-1'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.poolSize).toBe(12);
    expect(result.current.examinedCount).toBe(8);
    expect(result.current.includedCount).toBe(5);
    expect(result.current.backfillOccurred).toBe(true);
  });

  describe('generate()', () => {
    it('starts a manual run and does not flag an in-flight notice when attached_to_existing is false', async () => {
      mockGenerateTagReport.mockResolvedValue({ run_id: 'run-1', attached_to_existing: false, created_at: new Date().toISOString() });
      mockGetTagReportRun.mockResolvedValueOnce(makeRunResponse())
        .mockResolvedValueOnce(makeRunResponse({ run: makeRun({ trigger: 'manual' }) }));

      const { result } = renderHook(() => useTagReport('tag-1', 'run-1'));
      await waitFor(() => expect(result.current.loading).toBe(false));

      let generateResult: { runId: string | null; error: string | null; inFlightNotice: unknown } =
        { runId: null, error: null, inFlightNotice: undefined };
      await act(async () => { generateResult = await result.current.generate({ mode: 'manual' }); });

      expect(generateResult.runId).toBe('run-1');
      expect(generateResult.error).toBeNull();
      expect(generateResult.inFlightNotice).toBeNull();
      expect(mockGenerateTagReport).toHaveBeenCalledWith({ tag_id: 'tag-1', run_mode: 'manual', window_start: undefined, window_end: undefined });
      expect(result.current.inFlightNotice).toBeNull();
    });

    it('flags an in-flight notice using the AUTHORITATIVE attached_to_existing signal from generateTagReport itself, not a timestamp/trigger heuristic (fixed 2026-07-03 — see generate()\'s JSDoc for why the old heuristic was replaced)', async () => {
      mockGetTagReportHistory.mockResolvedValue({ runs: [], total: 0 });
      const staleCreatedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 min ago
      mockGenerateTagReport.mockResolvedValue({ run_id: 'run-old', attached_to_existing: true, created_at: staleCreatedAt });
      mockGetTagReportRun.mockResolvedValue(makeRunResponse({ run: makeRun({ id: 'run-old', created_at: staleCreatedAt, trigger: 'manual' }) }));

      const { result } = renderHook(() => useTagReport('tag-1', undefined));
      await waitFor(() => expect(result.current.loading).toBe(false));

      let generateResult: { runId: string | null; error: string | null; inFlightNotice: { startedAt: string } | null } =
        { runId: null, error: null, inFlightNotice: null };
      await act(async () => { generateResult = await result.current.generate({ mode: 'manual' }); });

      expect(result.current.inFlightNotice).not.toBeNull();
      expect(result.current.inFlightNotice?.startedAt).toBe(staleCreatedAt);
      // Also returned directly (not just set on hook state) — this is what
      // lets a caller (TagReportNewPage) forward it via router navigation
      // state before this hook instance is discarded on navigation.
      expect(generateResult.inFlightNotice?.startedAt).toBe(staleCreatedAt);
    });

    it('does NOT flag an in-flight notice merely because the run is old or scheduler-triggered — only attached_to_existing matters now', async () => {
      // Regression guard for the old (removed) heuristic: a run that happens
      // to be old, or scheduler-triggered, must NOT trip the notice on its
      // own — only the generate response's own attached_to_existing field can.
      mockGetTagReportHistory.mockResolvedValue({ runs: [], total: 0 });
      const oldTimestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      mockGenerateTagReport.mockResolvedValue({ run_id: 'run-sched', attached_to_existing: false, created_at: oldTimestamp });
      mockGetTagReportRun.mockResolvedValue(makeRunResponse({ run: makeRun({ id: 'run-sched', created_at: oldTimestamp, trigger: 'scheduled' }) }));

      const { result } = renderHook(() => useTagReport('tag-1', undefined));
      await waitFor(() => expect(result.current.loading).toBe(false));

      await act(async () => { await result.current.generate({ mode: 'manual' }); });

      expect(result.current.inFlightNotice).toBeNull();
    });

    it('dismissInFlightNotice clears the notice', async () => {
      mockGetTagReportHistory.mockResolvedValue({ runs: [], total: 0 });
      const staleCreatedAt = new Date(Date.now() - 60000).toISOString();
      mockGenerateTagReport.mockResolvedValue({ run_id: 'run-old', attached_to_existing: true, created_at: staleCreatedAt });
      mockGetTagReportRun.mockResolvedValue(makeRunResponse({ run: makeRun({ id: 'run-old', created_at: staleCreatedAt }) }));

      const { result } = renderHook(() => useTagReport('tag-1', undefined));
      await waitFor(() => expect(result.current.loading).toBe(false));
      await act(async () => { await result.current.generate({ mode: 'manual' }); });
      expect(result.current.inFlightNotice).not.toBeNull();

      act(() => { result.current.dismissInFlightNotice(); });
      expect(result.current.inFlightNotice).toBeNull();
    });

    it('returns null runId/inFlightNotice and sets error when generate fails', async () => {
      mockGetTagReportHistory.mockResolvedValue({ runs: [], total: 0 });
      mockGenerateTagReport.mockRejectedValue(new Error('quota exceeded'));

      const { result } = renderHook(() => useTagReport('tag-1', undefined));
      await waitFor(() => expect(result.current.loading).toBe(false));

      let generateResult: { runId: string | null; error: string | null; inFlightNotice: unknown } =
        { runId: 'unset', error: null, inFlightNotice: undefined };
      await act(async () => { generateResult = await result.current.generate({ mode: 'manual' }); });

      expect(generateResult.runId).toBeNull();
      expect(generateResult.inFlightNotice).toBeNull();
      // The error message is returned directly from generate() (not just set
      // on hook state) so a caller reading it right after the awaited call
      // gets the real, fresh message — no stale-closure read of `error` from
      // an earlier render (fixed 2026-07-03, see generate()'s JSDoc).
      expect(generateResult.error).toBe('quota exceeded');
      expect(result.current.error).toBe('quota exceeded');
    });

    it('passes window_start/window_end through for custom_range mode', async () => {
      mockGetTagReportHistory.mockResolvedValue({ runs: [], total: 0 });
      mockGenerateTagReport.mockResolvedValue({ run_id: 'run-cr', attached_to_existing: false, created_at: new Date().toISOString() });
      mockGetTagReportRun.mockResolvedValue(makeRunResponse({ run: makeRun({ id: 'run-cr', run_mode: 'custom_range' }) }));

      const { result } = renderHook(() => useTagReport('tag-1', undefined));
      await waitFor(() => expect(result.current.loading).toBe(false));

      await act(async () => {
        await result.current.generate({ mode: 'custom_range', windowStart: '2026-01-01T00:00:00Z', windowEnd: '2026-03-31T00:00:00Z' });
      });

      expect(mockGenerateTagReport).toHaveBeenCalledWith({
        tag_id: 'tag-1', run_mode: 'custom_range',
        window_start: '2026-01-01T00:00:00Z', window_end: '2026-03-31T00:00:00Z',
      });
    });
  });

  describe('polling', () => {
    it('polls getTagReportRun on an interval while the run is pending/running', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      mockGetTagReportRun
        .mockResolvedValueOnce(makeRunResponse({ run: makeRun({ status: 'running' }) }))
        .mockResolvedValueOnce(makeRunResponse({ run: makeRun({ status: 'completed' }) }));

      const { result } = renderHook(() => useTagReport('tag-1', 'run-1'));

      await vi.waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.run?.status).toBe('running');

      await act(async () => { await vi.advanceTimersByTimeAsync(3000); });

      expect(mockGetTagReportRun).toHaveBeenCalledTimes(2);
      expect(result.current.run?.status).toBe('completed');
    });

    it('does not poll once the run is completed', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      mockGetTagReportRun.mockResolvedValue(makeRunResponse({ run: makeRun({ status: 'completed' }) }));

      renderHook(() => useTagReport('tag-1', 'run-1'));
      await vi.waitFor(() => expect(mockGetTagReportRun).toHaveBeenCalledTimes(1));

      await act(async () => { await vi.advanceTimersByTimeAsync(10000); });

      expect(mockGetTagReportRun).toHaveBeenCalledTimes(1);
    });
  });

  it('reloads when the tagReports DataBus resource is invalidated', async () => {
    mockGetTagReportRun.mockResolvedValue(makeRunResponse());
    const { result } = renderHook(() => useTagReport('tag-1', 'run-1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockGetTagReportRun).toHaveBeenCalledTimes(1);

    act(() => { invalidate('tagReports'); });
    await waitFor(() => expect(mockGetTagReportRun).toHaveBeenCalledTimes(2));
  });
});

describe('useTagReportTrail', () => {
  it('loads trail data for a run', async () => {
    mockGetTagReportTrail.mockResolvedValue({
      tag_id: 'tag-1', tag_name: 'Onboarding',
      runs: [{ run_id: 'run-1', run_mode: 'manual', trigger: 'manual', created_at: '2026-07-01', metric_tracks_narrated: 1 }],
      sources: [],
    });

    const { result } = renderHook(() => useTagReportTrail('run-1'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.tagName).toBe('Onboarding');
    expect(result.current.runs).toHaveLength(1);
  });

  it('sets error on failure', async () => {
    mockGetTagReportTrail.mockRejectedValue(new Error('not found'));
    const { result } = renderHook(() => useTagReportTrail('run-1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('not found');
  });

  it('does nothing when runId is undefined', async () => {
    const { result } = renderHook(() => useTagReportTrail(undefined));
    await new Promise((r) => setTimeout(r, 0));
    expect(mockGetTagReportTrail).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(true);
  });
});

describe('useTagReportsIndex', () => {
  it('loads the reports list with q/sort params', async () => {
    mockListTagReports.mockResolvedValue({
      reports: [{ tag_id: 't1', tag_name: 'Onboarding', tag_color: '#2a4bd9', survey_count: 3, latest_run: null }],
      total: 1,
    });

    const { result } = renderHook(() => useTagReportsIndex({ q: 'onboard', sort: 'alpha' }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockListTagReports).toHaveBeenCalledWith({ q: 'onboard', sort: 'alpha' });
    expect(result.current.reports).toHaveLength(1);
    expect(result.current.total).toBe(1);
  });

  it('sets error on failure', async () => {
    mockListTagReports.mockRejectedValue(new Error('server error'));
    const { result } = renderHook(() => useTagReportsIndex({}));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('server error');
  });
});
