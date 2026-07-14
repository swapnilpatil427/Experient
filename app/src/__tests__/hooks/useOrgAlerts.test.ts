import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { normalizeLiveAnomaly, useOrgAlerts } from '../../hooks/useOrgAlerts';

afterEach(cleanup);

let acknowledgeResolve: () => void;
const acknowledgePromise = new Promise<void>((resolve) => { acknowledgeResolve = resolve; });

vi.mock('../../hooks/useApi', () => ({
  useApi: () => ({
    getOrgDashboardAlerts: vi.fn().mockResolvedValue({
      alerts: [
        { id: 'a1', surveyId: 's1', surveyTitle: 'Survey 1', description: 'd1', severity: 'warning', detectedAt: '2026-07-01T00:00:00Z', resolvedAt: null, isAcknowledged: false },
        { id: 'a2', surveyId: 's2', surveyTitle: 'Survey 2', description: 'd2', severity: 'critical', detectedAt: '2026-07-02T00:00:00Z', resolvedAt: null, isAcknowledged: false },
      ],
      totalUnresolved: 2,
    }),
    acknowledgeOrgAlert: vi.fn().mockImplementation(() => acknowledgePromise),
  }),
}));

vi.mock('../../hooks/useExperience', () => ({
  useFetch: (fetcher: () => Promise<unknown>) => {
    const data = {
      alerts: [
        { id: 'a1', surveyId: 's1', surveyTitle: 'Survey 1', description: 'd1', severity: 'warning', detectedAt: '2026-07-01T00:00:00Z', resolvedAt: null, isAcknowledged: false },
        { id: 'a2', surveyId: 's2', surveyTitle: 'Survey 2', description: 'd2', severity: 'critical', detectedAt: '2026-07-02T00:00:00Z', resolvedAt: null, isAcknowledged: false },
      ],
      totalUnresolved: 2,
    };
    return {
      data,
      loading: false,
      error: null,
      refetch: vi.fn().mockImplementation(async () => {
        await fetcher();
      }),
    };
  },
}));

describe('normalizeLiveAnomaly', () => {
  it('maps SSE payload alertId/title into OrgAlert id/surveyTitle', () => {
    const alert = normalizeLiveAnomaly({
      alertId: 'live-1',
      surveyId: 's1',
      severity: 'critical',
      title: 'NPS drop',
      description: 'Dropped 12 points',
      detectedAt: '2026-07-03T12:00:00Z',
    });
    expect(alert.id).toBe('live-1');
    expect(alert.surveyTitle).toBe('NPS drop');
    expect(alert.isAcknowledged).toBe(false);
  });
});

describe('useOrgAlerts', () => {
  it('decrements totalUnresolved optimistically when acknowledging', async () => {
    const { result } = renderHook(() => useOrgAlerts());
    expect(result.current.totalUnresolved).toBe(2);

    let pending: Promise<void> | undefined;
    act(() => {
      pending = result.current.acknowledge('a1');
    });

    expect(result.current.alerts.map((a) => a.id)).toEqual(['a2']);
    expect(result.current.totalUnresolved).toBe(1);

    await act(async () => {
      acknowledgeResolve!();
      await pending;
    });
  });
});
