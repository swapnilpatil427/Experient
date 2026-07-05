// useOrgDashboardLive — real-time layer for the KPI live counter + anomaly
// alerts on the Org Dashboard.
//
// Per Decision 22 / IMPLEMENTATION_SPEC.md: this wraps a plain `EventSource`
// against a NEW backend route `GET /api/org/dashboard/stream` (Redis pub/sub,
// org-scoped) — NOT a `WebSocket`. There is no `ws` npm dependency anywhere
// in this repo and none is added here. This is deliberately a separate,
// narrower hook than `useNotifications.ts`'s stream: per Decision 21, the
// three "did something finish while I was away" cases (manual summary
// completion, compare-readiness, trust-score-ready) ride the existing
// app-wide `/api/notifications/stream` instead (see the `useNotifications.ts`
// `mapLive()` extension). This hook is scoped to exactly the two cases
// Decision 21 left in place: live response counters and anomaly alerts —
// both genuinely "the user is watching a number change right now" cases.
//
// `EventSource` auto-reconnects on its own, but per DESIGN.md's Failure
// States table we cap *visible* "still trying" at 5 manual attempts before
// giving up on the stream and falling back to 2-minute `setInterval` polling
// of `GET /api/org/dashboard`.

import { useEffect, useRef, useState, useCallback } from 'react';
import { useAppAuth } from '../lib/auth';
import { useApi } from './useApi';
import type { OrgDashboardLiveEvent, OrgDashboardConnectionStatus, OrgDashboardPayload } from '../types/orgDashboard';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';
const MAX_RECONNECT_ATTEMPTS = 5;
const POLL_FALLBACK_MS = 2 * 60_000;

export function useOrgDashboardLive(onEvent?: (evt: OrgDashboardLiveEvent) => void) {
  const { getToken } = useAppAuth();
  const api = useApi();
  const [isConnected, setIsConnected] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<OrgDashboardConnectionStatus>('connecting');
  const [pollSnapshot, setPollSnapshot] = useState<OrgDashboardPayload | null>(null);

  const attemptsRef = useRef(0);
  const esRef        = useRef<EventSource | null>(null);
  const pollRef       = useRef<ReturnType<typeof setInterval> | null>(null);
  const onEventRef    = useRef(onEvent);
  onEventRef.current  = onEvent;

  const startPolling = useCallback(() => {
    if (pollRef.current) return;
    setConnectionStatus('polling');
    setIsConnected(false);
    const tick = () => { api.getOrgDashboard().then(setPollSnapshot).catch(() => {}); };
    tick();
    pollRef.current = setInterval(tick, POLL_FALLBACK_MS);
  }, [api]);

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  useEffect(() => {
    if (typeof EventSource === 'undefined') {
      startPolling();
      return;
    }

    let closed = false;

    const connect = async () => {
      if (closed) return;
      let token: string | null = null;
      try { token = await getToken(); } catch { /* dev/no-clerk → null */ }
      if (closed) return;

      setConnectionStatus(attemptsRef.current > 0 ? 'reconnecting' : 'connecting');
      const url = `${API_BASE}/api/org/dashboard/stream${token ? `?token=${encodeURIComponent(token)}` : ''}`;
      const es = new EventSource(url);
      esRef.current = es;

      es.onopen = () => {
        attemptsRef.current = 0;
        setIsConnected(true);
        setConnectionStatus('connected');
        stopPolling();
      };

      es.onmessage = (evt) => {
        try {
          const parsed = JSON.parse(evt.data) as OrgDashboardLiveEvent;
          onEventRef.current?.(parsed);
        } catch { /* ignore malformed event */ }
      };

      es.onerror = () => {
        es.close();
        setIsConnected(false);
        attemptsRef.current += 1;
        if (attemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
          setConnectionStatus('disconnected');
          startPolling();
          return;
        }
        setConnectionStatus('reconnecting');
        // EventSource auto-reconnects at the browser level too, but we
        // re-create manually so we control the visible attempt count and can
        // fall back deterministically at MAX_RECONNECT_ATTEMPTS.
        setTimeout(connect, 1500 * attemptsRef.current);
      };
    };

    connect();

    return () => {
      closed = true;
      esRef.current?.close();
      stopPolling();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getToken, startPolling, stopPolling]);

  return { isConnected, connectionStatus, pollSnapshot };
}
