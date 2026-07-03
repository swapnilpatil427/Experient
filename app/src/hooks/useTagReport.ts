import { useState, useEffect, useCallback, useRef } from 'react';
import { useApi } from './useApi';
import { invalidate, useInvalidation } from '../lib/dataBus';
import type {
  TagReportRun, TagReportMetricTrack, TagReportRunSource,
  TagReportRunMode, TagReportsIndexItem, TagReportTrailEntry,
} from '../types/tagReport';

const POLL_INTERVAL_MS = 3000;
// Heuristic for Task 17 (in-flight-run disclosure, DESIGN.md Appendix A.5):
// if the run this trigger resolved to was already created more than this many
// ms before the trigger call returned, it predates this click — it must have
// already been in flight (someone else's manual click, or a schedule).
const IN_FLIGHT_AGE_THRESHOLD_MS = 3000;

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
  generate: (opts: { mode: 'manual' | 'custom_range'; windowStart?: string; windowEnd?: string }) => Promise<string | null>;
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

  const generate = useCallback(async (opts: { mode: 'manual' | 'custom_range'; windowStart?: string; windowEnd?: string }): Promise<string | null> => {
    if (!tagId) return null;
    const clickedAt = Date.now();
    try {
      const { run_id } = await api.generateTagReport({
        tag_id: tagId,
        run_mode: opts.mode,
        window_start: opts.windowStart,
        window_end: opts.windowEnd,
      });
      const data = await api.getTagReportRun(run_id);
      applyRunResponse(data);
      setError(null);

      // Task 17 — never silently substitute a polled result for what the user
      // thinks is their own fresh click.
      const ageMs = clickedAt - new Date(data.run.created_at).getTime();
      if (data.run.trigger === 'scheduled' || ageMs > IN_FLIGHT_AGE_THRESHOLD_MS) {
        setInFlightNotice({ startedAt: data.run.created_at, trigger: data.run.trigger });
      } else {
        setInFlightNotice(null);
      }

      invalidate('tagReports');
      return run_id;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, [tagId, api, applyRunResponse]);

  const dismissInFlightNotice = useCallback(() => setInFlightNotice(null), []);

  return {
    run, metricTracks, sources, poolSize, examinedCount, includedCount, backfillOccurred,
    loading, error, inFlightNotice, dismissInFlightNotice, reload: load, generate,
  };
}

/** Powers the Tag Report Trail page — full provenance + run-history lineage. */
export function useTagReportTrail(runId: string | undefined) {
  const api = useApi();
  const [tagId, setTagId] = useState<string | null>(null);
  const [tagName, setTagName] = useState<string | null>(null);
  const [runs, setRuns] = useState<TagReportTrailEntry[]>([]);
  const [sources, setSources] = useState<TagReportRunSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!runId) return;
    setLoading(true);
    try {
      const data = await api.getTagReportTrail(runId);
      setTagId(data.tag_id);
      setTagName(data.tag_name);
      setRuns(data.runs);
      setSources(data.sources);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [runId, api]);

  useEffect(() => { load(); }, [load]);

  return { tagId, tagName, runs, sources, loading, error, reload: load };
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
