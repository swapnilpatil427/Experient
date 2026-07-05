import { useState, useEffect, useCallback, useRef } from 'react';
import { useApi } from './useApi';
import { useAppAuth } from '../lib/auth';
import type { Notification } from '../lib/api';

const POLL_INTERVAL_MS = 30_000;
const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';

// Map a live SSE payload (camelCase from the backend) into the Notification shape.
//
// Additive: `org_summary_ready` (Manual Summary Generator completion) and
// `brief_trust_score_ready` (the hallucination/trust score arriving after the
// rest of a Crystal Brief has already rendered) ride this SAME flat
// `'notification'` event type — per Decision 21, these do NOT get a new SSE
// stream or a per-type switch, they're just two more `type` values consumers
// can match on via `n.payload`/`n.entityType`. No existing type's handling
// changes below.
function mapLive(n: Record<string, unknown>): Notification {
  return {
    id: n.id as string,
    type: n.type as string,
    title: n.title as string,
    body: (n.body as string) ?? '',
    payload: (n.payload as Record<string, unknown>) ?? {},
    run_id: (n.runId as string) ?? undefined,
    read: !!n.read,
    created_at: (n.createdAt as string) ?? new Date().toISOString(),
    priority: n.priority as Notification['priority'],
    actionUrl: (n.actionUrl as string) ?? null,
    entityType: (n.entityType as string) ?? null,
  };
}

// Notification `type` values a consumer can switch on for org-dashboard UI
// (e.g. GenerationStatusChip listens for 'org_summary_ready' to know when to
// swap itself out for the toast + Brief Archive entry; CrystalBriefCard
// listens for 'brief_trust_score_ready' keyed by payload.periodKey to patch
// its confidence indicator in place once the score lands).
export const ORG_DASHBOARD_NOTIFICATION_TYPES = {
  SUMMARY_READY:      'org_summary_ready',
  TRUST_SCORE_READY:  'brief_trust_score_ready',
} as const;

export function useNotifications() {
  const api = useApi();
  const { getToken } = useAppAuth();
  const [unreadCount,   setUnreadCount]   = useState(0);
  const [criticalCount, setCriticalCount] = useState(0);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading,       setLoading]       = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchUnreadCount = useCallback(async () => {
    try {
      const { unread, critical } = await api.getNotificationCount();
      setUnreadCount(unread);
      setCriticalCount(critical);
    } catch {
      // silently ignore — bell badge is non-critical
    }
  }, [api]);

  // Load full notification list (called when sheet opens)
  const loadNotifications = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.getNotifications();
      setNotifications(list);
      setUnreadCount(0);
    } catch {
      // keep stale list
    } finally {
      setLoading(false);
    }
  }, [api]);

  const markRead = useCallback(async (id: string) => {
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, read: true } : n))
    );
    try { await api.markNotificationRead(id); } catch { /* ignore */ }
  }, [api]);

  const markAllRead = useCallback(async () => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    setUnreadCount(0);
    setCriticalCount(0);
    try { await api.markAllNotificationsRead(); } catch { /* ignore */ }
  }, [api]);

  const dismiss = useCallback(async (id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
    try { await api.dismissNotification(id); } catch { /* ignore */ }
  }, [api]);

  // Poll unread count in background (fallback + initial load).
  useEffect(() => {
    fetchUnreadCount();
    pollRef.current = setInterval(fetchUnreadCount, POLL_INTERVAL_MS);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetchUnreadCount]);

  // Real-time delivery via Server-Sent Events. Falls back to polling when the
  // browser/runtime lacks EventSource (e.g. jsdom in tests).
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    let es: EventSource | null = null;
    let closed = false;
    (async () => {
      let token: string | null = null;
      try { token = await getToken(); } catch { /* dev/no-clerk → null */ }
      if (closed) return;
      const url = `${API_BASE}/api/notifications/stream${token ? `?token=${encodeURIComponent(token)}` : ''}`;
      es = new EventSource(url);
      es.addEventListener('notification', (evt) => {
        try {
          const n = mapLive(JSON.parse((evt as MessageEvent).data));
          setNotifications((prev) => (prev.some((p) => p.id === n.id) ? prev : [n, ...prev]));
          setUnreadCount((c) => c + 1);
          if (n.priority === 'critical') setCriticalCount((c) => c + 1);
        } catch { /* ignore malformed event */ }
      });
    })();
    return () => { closed = true; if (es) es.close(); };
  }, [getToken]);

  return { unreadCount, criticalCount, notifications, loading, loadNotifications, markRead, markAllRead, dismiss };
}
