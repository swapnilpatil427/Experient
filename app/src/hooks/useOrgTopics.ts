// useOrgTopics — EmergingTopics data + lazy per-topic breakdown for TopicDrawer.

import { useCallback, useRef, useState } from 'react';
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
  const loadSeqRef = useRef(0);

  const load = useCallback(async (topicLabel: string) => {
    const seq = ++loadSeqRef.current;
    setLoading(true);
    setError(null);
    try {
      const data = await api.getOrgTopicBreakdown(topicLabel);
      if (seq !== loadSeqRef.current) return;
      setBreakdown(data);
    } catch (err) {
      if (seq !== loadSeqRef.current) return;
      setError((err as Error).message || 'Failed to load topic');
    } finally {
      if (seq === loadSeqRef.current) setLoading(false);
    }
  }, [api]);

  const clear = useCallback(() => {
    loadSeqRef.current += 1;
    setBreakdown(null);
    setError(null);
    setLoading(false);
  }, []);

  return { breakdown, loading, error, load, clear };
}
