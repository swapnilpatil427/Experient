// useOrgAlerts — AnomalyAlerts data + acknowledge mutation.
// `alert_events` reuse per Decision 23 — no new anomaly-storage table; this
// hook is a thin wrapper over the existing-shape endpoints.

import { useCallback, useState } from 'react';
import { useApi } from './useApi';
import { useFetch } from './useExperience';
import type { OrgAlert } from '../types/orgDashboard';

export function useOrgAlerts(limit = 20) {
  const api = useApi();
  const fetcher = useCallback(() => api.getOrgDashboardAlerts(limit), [api, limit]);
  const result = useFetch(fetcher);
  const [acknowledging, setAcknowledging] = useState<Record<string, boolean>>({});

  // Optimistic local removal so "Resolve" feels instant; refetch reconciles
  // against the server on the next natural refresh (page focus / live event).
  const [localAlerts, setLocalAlerts] = useState<OrgAlert[] | null>(null);
  const alerts = localAlerts ?? result.data?.alerts ?? [];

  const acknowledge = useCallback(async (alertId: string) => {
    setAcknowledging((s) => ({ ...s, [alertId]: true }));
    setLocalAlerts((prev) => (prev ?? result.data?.alerts ?? []).filter((a) => a.id !== alertId));
    try {
      await api.acknowledgeOrgAlert(alertId);
    } catch {
      // revert on failure
      setLocalAlerts(null);
      result.refetch();
    } finally {
      setAcknowledging((s) => ({ ...s, [alertId]: false }));
    }
  }, [api, result]);

  /** Prepend a new alert delivered via the SSE live channel (§7 slide-in animation). */
  const prependLive = useCallback((alert: OrgAlert) => {
    setLocalAlerts((prev) => {
      const base = prev ?? result.data?.alerts ?? [];
      if (base.some((a) => a.id === alert.id)) return base;
      return [alert, ...base];
    });
  }, [result.data]);

  return {
    ...result,
    alerts,
    totalUnresolved: result.data?.totalUnresolved ?? alerts.length,
    acknowledging,
    acknowledge,
    prependLive,
  };
}
