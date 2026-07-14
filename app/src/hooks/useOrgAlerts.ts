// useOrgAlerts — AnomalyAlerts data + acknowledge mutation.
// `alert_events` reuse per Decision 23 — no new anomaly-storage table; this
// hook is a thin wrapper over the existing-shape endpoints.

import { useCallback, useState } from 'react';
import { useApi } from './useApi';
import { useFetch } from './useExperience';
import type { OrgAlert, OrgLiveAnomalyDetectedPayload } from '../types/orgDashboard';

/** SSE `anomaly_detected` payloads use `alertId` + `title`; REST rows use `id` + `surveyTitle`. */
export function normalizeLiveAnomaly(payload: OrgLiveAnomalyDetectedPayload): OrgAlert {
  if (payload.id) {
    return {
      id: payload.id,
      surveyId: payload.surveyId ?? null,
      surveyTitle: payload.surveyTitle ?? null,
      description: payload.description,
      severity: payload.severity,
      detectedAt: payload.detectedAt,
      resolvedAt: payload.resolvedAt ?? null,
      isAcknowledged: payload.isAcknowledged ?? false,
    };
  }
  return {
    id: payload.alertId,
    surveyId: payload.surveyId ?? null,
    surveyTitle: payload.title ?? null,
    description: payload.description,
    severity: payload.severity,
    detectedAt: payload.detectedAt,
    resolvedAt: null,
    isAcknowledged: false,
  };
}

export function useOrgAlerts(limit = 20) {
  const api = useApi();
  const fetcher = useCallback(() => api.getOrgDashboardAlerts(limit), [api, limit]);
  const result = useFetch(fetcher);
  const [acknowledging, setAcknowledging] = useState<Record<string, boolean>>({});

  // Optimistic local removal so "Resolve" feels instant; cleared after a
  // successful acknowledge so refetches aren't overridden indefinitely.
  const [localAlerts, setLocalAlerts] = useState<OrgAlert[] | null>(null);
  const [localUnresolvedDelta, setLocalUnresolvedDelta] = useState(0);
  const alerts = localAlerts ?? result.data?.alerts ?? [];
  const serverUnresolved = result.data?.totalUnresolved ?? alerts.length;
  const totalUnresolved = Math.max(0, serverUnresolved + localUnresolvedDelta);

  const acknowledge = useCallback(async (alertId: string) => {
    setAcknowledging((s) => ({ ...s, [alertId]: true }));
    setLocalAlerts((prev) => (prev ?? result.data?.alerts ?? []).filter((a) => a.id !== alertId));
    setLocalUnresolvedDelta((d) => d - 1);
    try {
      await api.acknowledgeOrgAlert(alertId);
      setLocalAlerts(null);
      setLocalUnresolvedDelta(0);
      result.refetch();
    } catch {
      // revert on failure
      setLocalAlerts(null);
      setLocalUnresolvedDelta(0);
      result.refetch();
    } finally {
      setAcknowledging((s) => ({ ...s, [alertId]: false }));
    }
  }, [api, result]);

  /** Prepend a new alert delivered via the SSE live channel (§7 slide-in animation). */
  const prependLive = useCallback((payload: OrgLiveAnomalyDetectedPayload) => {
    const alert = normalizeLiveAnomaly(payload);
    setLocalAlerts((prev) => {
      const base = prev ?? result.data?.alerts ?? [];
      if (base.some((a) => a.id === alert.id)) return base;
      return [alert, ...base];
    });
    setLocalUnresolvedDelta((d) => d + 1);
  }, [result.data]);

  return {
    ...result,
    alerts,
    totalUnresolved,
    acknowledging,
    acknowledge,
    prependLive,
  };
}
