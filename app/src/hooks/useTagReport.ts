import { useState, useEffect, useCallback, useRef } from 'react';
import { useApi } from './useApi';
import { invalidate, useInvalidation } from '../lib/dataBus';
import type {
  TagReportRun, TagReportMetricTrack, TagReportRunSource,
  TagReportRunMode, TagReportsIndexItem, TagReportTrailEntry,
} from '../types/tagReport';

const POLL_INTERVAL_MS = 3000;

export interface InFlightNotice {
  startedAt: string;
  trigger: TagReportRun['trigger'];
}

interface UseTagReportResult {
  run: TagReportRun | null;
  metricTracks: TagReportMetricTrack[];
  sources: TagReportRunSource[];
  poolSize: number;
  examinedCount: number;
  includedCount: number;
  backfillOccurred: boolean;
  loading: boolean;
  error: string | null;
  inFlightNotice: InFlightNotice | null;
  dismissInFlightNotice: () => void;
  reload: () => Promise<void>;
  // Returns the error message AND the in-flight notice directly alongside
  // runId (not just via hook state) so a caller can act on them immediately
  // after the awaited call resolves, without a stale-closure read of state
  // from a render that predates this call. Two fixes bundled here
  // (2026-07-03, customer-journey review):
  // 1. "generic error masking" — TagReportNewPage was reading a captured
  //    `error` value from an earlier render instead of the fresh one.
  // 2. "InFlightRunBanner unreachable" — the caller that triggers generate()
  //    (TagReportNewPage) immediately navigates to a DIFFERENT page/hook
  //    instance (TagReportPage) on success, discarding this hook's own
  //    `inFlightNotice` state before it could ever be displayed. Returning it
  //    directly lets the caller forward it via router navigation state.
  generate: (opts: { mode: 'manual' | 'custom_range'; windowStart?: string; windowEnd?: string }) => Promise<{ runId: string | null; error: string | null; inFlightNotice: InFlightNotice | null }>;
}

/**
 * Loads a Tag Report run — either a specific `runId`, or (when omitted) the
 * most recently generated run for `tagId`. Polls while the run is
 * pending/running, mirroring `GroupReportPage`'s resolution pattern.
 */
export function useTagReport(tagId: string | undefined, runId: string | undefined): UseTagReportResult {
  const api = useApi();
  const [run, setRun] = useState<TagReportRun | null>(null);
  const [metricTracks, setMetricTracks] = useState<TagReportMetricTrack[]>([]);
  const [sources, setSources] = useState<TagReportRunSource[]>([]);
  const [poolSize, setPoolSize] = useState(0);
  const [examinedCount, setExaminedCount] = useState(0);
  const [includedCount, setIncludedCount] = useState(0);
  const [backfillOccurred, setBackfillOccurred] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [inFlightNotice, setInFlightNotice] = useState<InFlightNotice | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const applyRunResponse = useCallback((data: {
    run: TagReportRun;
    metric_tracks: TagReportMetricTrack[];
    sources: TagReportRunSource[];
    pool_size: number;
    examined_count: number;
    included_count: number;
    backfill_occurred: boolean;
  }) => {
    setRun(data.run);
    setMetricTracks(data.metric_tracks);
    setSources(data.sources);
    setPoolSize(data.pool_size);
    setExaminedCount(data.examined_count);
    setIncludedCount(data.included_count);
    setBackfillOccurred(data.backfill_occurred);
  }, []);

  const load = useCallback(async () => {
    if (!tagId) return;
    setLoading(true);
    try {
      let resolvedRunId = runId;
      if (!resolvedRunId) {
        const history = await api.getTagReportHistory(tagId, { limit: 1 });
        resolvedRunId = history.runs[0]?.run_id;
      }
      if (!resolvedRunId) {
        setRun(null);
        setError(null);
        return;
      }
      const data = await api.getTagReportRun(resolvedRunId);
      applyRunResponse(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [tagId, runId, api, applyRunResponse]);

  useEffect(() => { load(); }, [load]);
  useInvalidation('tagReports', load);

  // Poll while pending/running.
  useEffect(() => {
    if (!run) return;
    if (run.status !== 'pending' && run.status !== 'running') return;
    pollRef.current = setInterval(async () => {
      try {
        const data = await api.getTagReportRun(run.id);
        applyRunResponse(data);
      } catch { /* transient — keep polling */ }
    }, POLL_INTERVAL_MS);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [run?.id, run?.status, api, applyRunResponse]);

  const generate = useCallback(async (opts: { mode: 'manual' | 'custom_range'; windowStart?: string; windowEnd?: string }): Promise<{ runId: string | null; error: string | null; inFlightNotice: InFlightNotice | null }> => {
    if (!tagId) return { runId: null, error: null, inFlightNotice: null };
    try {
      const generateResponse = await api.generateTagReport({
        tag_id: tagId,
        run_mode: opts.mode,
        window_start: opts.windowStart,
        window_end: opts.windowEnd,
      });
      const { run_id, attached_to_existing } = generateResponse;
      const data = await api.getTagReportRun(run_id);
      applyRunResponse(data);
      setError(null);

      // Task 17 — never silently substitute a polled result for what the user
      // thinks is their own fresh click. Fixed 2026-07-03 (customer-journey
      // review finding): previously derived this from a fragile heuristic
      // (result age vs. a fixed threshold, or trigger==='scheduled') computed
      // from a SECOND, separate API call. `attached_to_existing` is the
      // AUTHORITATIVE signal from the generate call itself — a real DB-level
      // concurrency check (23505 conflict), not a guess.
      const notice = attached_to_existing
        ? { startedAt: generateResponse.created_at, trigger: data.run.trigger }
        : null;
      setInFlightNotice(notice);

      invalidate('tagReports');
      return { runId: run_id, error: null, inFlightNotice: notice };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      return { runId: null, error: message, inFlightNotice: null };
    }
  }, [tagId, api, applyRunResponse]);

  const dismissInFlightNotice = useCallback(() => setInFlightNotice(null), []);

  return {
    run, metricTracks, sources, poolSize, examinedCount, includedCount, backfillOccurred,
    loading, error, inFlightNotice, dismissInFlightNotice, reload: load, generate,
  };
}

/**
 * Powers the Tag Report Trail page — the tag's full run history (Run History
 * section) plus one run's provenance (Sources section).
 *
 * Fixed 2026-07-03 (customer-journey review finding, severe): this previously
 * sourced BOTH `runs` and `sources` from `getTagReportTrail(runId)` alone,
 * reading `data.runs`/`data.tag_id`/`data.tag_name` — fields that endpoint has
 * never returned (it returns `{run_id, lineage, sources, truncated}`, scoped
 * to ONE run's provenance, not a tag's history). `runs` was therefore always
 * `undefined`, and `runs.map(...)` in TagReportTrailPage threw on every real
 * visit. `getTagReportHistory` (paginated, all 3 modes) is CrystalOS/backend's
 * actual intended source for Run History — its own code comment in `api.ts`
 * already said so; this hook just wasn't calling it for that purpose.
 */
export function useTagReportTrail(tagId: string | undefined, runId: string | undefined) {
  const api = useApi();
  const [runs, setRuns] = useState<TagReportTrailEntry[]>([]);
  const [sources, setSources] = useState<TagReportRunSource[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!tagId || !runId) return;
    setLoading(true);
    try {
      const [history, trail] = await Promise.all([
        api.getTagReportHistory(tagId, { limit: 20 }),
        api.getTagReportTrail(runId),
      ]);
      setRuns(history.runs);
      setSources(trail.sources);
      setTruncated(trail.truncated);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [tagId, runId, api]);

  useEffect(() => { load(); }, [load]);

  return { runs, sources, truncated, loading, error, reload: load };
}

/** Powers the Reports Index page (`TAG_REPORTS_INDEX`, TRACKER.md Part C). */
export function useTagReportsIndex(params: { q?: string; sort?: 'recent' | 'alpha' | 'survey_count' }) {
  const api = useApi();
  const [reports, setReports] = useState<TagReportsIndexItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.listTagReports(params);
      setReports(data.reports);
      setTotal(data.total);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, params.q, params.sort]);

  useEffect(() => { load(); }, [load]);
  useInvalidation('tagReports', load);

  return { reports, total, loading, error, reload: load };
}

export type { TagReportRunMode };
