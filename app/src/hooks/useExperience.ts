import { useCallback, useEffect, useState } from 'react';
import { useApi } from './useApi';

// Exported so other org-scoped data hooks (useOrgDashboard.ts, useOrgPrograms.ts,
// useOrgAlerts.ts, useOrgTopics.ts, useTagMetrics.ts) can reuse the exact same
// fetch/loading/error/refetch contract instead of re-implementing it.
export function useFetch<T>(fetcher: (() => Promise<T>) | null) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    if (!fetcher) return;
    setLoading(true);
    setError(null);
    try {
      const result = await fetcher();
      setData(result);
    } catch (err: unknown) {
      setError((err as Error).message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [fetcher]);

  useEffect(() => { run(); }, [run]);

  return { data, loading, error, refetch: run };
}

export function useOrgOverview() {
  const api = useApi();
  const fetcher = useCallback(() => api.getExperienceOverview(), [api]);
  return useFetch(fetcher);
}

export function useSurveyReport(surveyId: string, checkpointId?: string) {
  const api = useApi();
  const fetcher = useCallback(() => {
    if (!checkpointId) return api.listInsights(surveyId);
    return api.listInsights(surveyId);
  }, [api, surveyId, checkpointId]);
  return useFetch(fetcher);
}

export function useTopicAnalysis(surveyId: string) {
  const api = useApi();
  const fetcher = useCallback(
    () => api.listTopics(surveyId),
    [api, surveyId],
  );
  return useFetch(fetcher);
}

export function useTopicDeepDive(surveyId: string, topicId: string) {
  const api = useApi();
  const fetcher = useCallback(
    () => api.getTopicDetail(surveyId, topicId),
    [api, surveyId, topicId],
  );
  return useFetch(fetcher);
}

export function useSurveyTrends(surveyId: string, days: number = 90) {
  const api = useApi();
  const fetcher = useCallback(
    () => api.getSurveyMetricHistory(surveyId, days),
    [api, surveyId, days],
  );
  return useFetch(fetcher);
}

export function useSurveyIntelligence(surveyId: string) {
  const api = useApi();
  const fetcher = useCallback(
    () => api.listInsights(surveyId),
    [api, surveyId],
  );
  return useFetch(fetcher);
}
