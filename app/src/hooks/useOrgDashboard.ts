// Thin data hooks for the Org Dashboard ("Command Center") feature — wrap
// `useApi()` following the exact `useFetch<T>` pattern already established in
// `useExperience.ts` (loading/error/data/refetch).
//
// Split by concern to match IMPLEMENTATION_SPEC.md's hook list:
//   useOrgDashboard      — GET /api/org/dashboard (the single Hub/page-load payload)
//   useOrgHealthScore    — GET /api/org/health-score (full breakdown, Command Center only)
//   useOrgCrystalBrief   — GET/POST crystal-brief (+ regenerate)
//   useOrgBriefArchive   — GET /api/org/dashboard/briefs (paginated history)
//   useCheckpointCompare — GET .../briefs/:id/compare/:otherId (lazy, fetched on click)
//   useOrgSummaries      — manual summary generator: preview/create/list

import { useCallback, useState } from 'react';
import { useApi } from './useApi';
import { useFetch } from './useExperience';
import type {
  CheckpointComparisonResult, CreateSummaryRequest, OrgBriefDetail, OrgSummary,
  SummaryPreviewRequest, TrendRange,
} from '../types/orgDashboard';

export function useOrgDashboard() {
  const api = useApi();
  const fetcher = useCallback(() => api.getOrgDashboard(), [api]);
  return useFetch(fetcher);
}

export function useOrgTrends(range: TrendRange = '30d') {
  const api = useApi();
  const fetcher = useCallback(() => api.getOrgDashboardTrends(range), [api, range]);
  return useFetch(fetcher);
}

export function useOrgHealthScore() {
  const api = useApi();
  const fetcher = useCallback(() => api.getOrgHealthScoreDetail(), [api]);
  return useFetch(fetcher);
}

export function useOrgCrystalBrief() {
  const api = useApi();
  const fetcher = useCallback(() => api.getOrgCrystalBrief(), [api]);
  const result = useFetch(fetcher);

  const [regenerating, setRegenerating] = useState(false);
  const regenerate = useCallback(async () => {
    setRegenerating(true);
    try {
      return await api.regenerateOrgCrystalBrief();
    } finally {
      setRegenerating(false);
    }
  }, [api]);

  return { ...result, regenerating, regenerate };
}

export function useOrgBriefArchive(pageSize = 10) {
  const api = useApi();
  const [page, setPage] = useState(1);
  const fetcher = useCallback(() => api.getOrgDashboardBriefs(page, pageSize), [api, page, pageSize]);
  const result = useFetch(fetcher);
  return { ...result, page, setPage };
}

export function useCheckpointCompare() {
  const api = useApi();
  const [result, setResult] = useState<CheckpointComparisonResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const compare = useCallback(async (id: string, otherId: string) => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.compareOrgBriefs(id, otherId);
      setResult(data);
      return data;
    } catch (err) {
      setError((err as Error).message || 'Failed to load comparison');
      return null;
    } finally {
      setLoading(false);
    }
  }, [api]);

  const reset = useCallback(() => { setResult(null); setError(null); }, []);

  return { result, loading, error, compare, reset };
}

// Lazy — only fetches once `briefId` is non-null, mirroring how
// `CheckpointDiffPanel` already lazy-fetches compare data only on click, not
// on every archive render. Powers `BriefProvenancePanel` ("How was this
// generated?"), nested inside a `BriefArchive` entry.
export function useOrgBriefDetail(briefId: string | null) {
  const api = useApi();
  const fetcher = useCallback((): Promise<OrgBriefDetail> => api.getOrgBriefDetail(briefId as string), [api, briefId]);
  return useFetch(briefId ? fetcher : null);
}

export function useOrgSummaries() {
  const api = useApi();
  const fetcher = useCallback(() => api.listOrgSummaries(), [api]);
  const list = useFetch(fetcher);

  const preview = useCallback(
    (req: SummaryPreviewRequest) => api.previewOrgSummary(req),
    [api],
  );
  const create = useCallback(
    (req: CreateSummaryRequest) => api.createOrgSummary(req),
    [api],
  );
  const getOne = useCallback(
    (id: string): Promise<{ summary: OrgSummary }> => api.getOrgSummary(id),
    [api],
  );

  return { ...list, preview, create, getOne };
}
