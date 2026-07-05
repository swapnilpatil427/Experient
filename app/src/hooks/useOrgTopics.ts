// useOrgTopics — EmergingTopics data + lazy per-topic breakdown for TopicDrawer.

import { useCallback, useState } from 'react';
import { useApi } from './useApi';
import { useFetch } from './useExperience';
import type { OrgTopicBreakdown } from '../types/orgDashboard';

export function useOrgTopics() {
  const api = useApi();
  const fetcher = useCallback(() => api.getOrgDashboardTopics(), [api]);
  return useFetch(fetcher);
}

export function useTopicBreakdown() {
  const api = useApi();
  const [breakdown, setBreakdown] = useState<OrgTopicBreakdown | null>(null);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState<string | null>(null);

  const load = useCallback(async (topicLabel: string) => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getOrgTopicBreakdown(topicLabel);
      setBreakdown(data);
    } catch (err) {
      setError((err as Error).message || 'Failed to load topic');
    } finally {
      setLoading(false);
    }
  }, [api]);

  const clear = useCallback(() => { setBreakdown(null); setError(null); }, []);

  return { breakdown, loading, error, load, clear };
}
