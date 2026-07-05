/**
 * Real-time layer for the Org Intelligence Dashboard (Command Center).
 *
 * Per docs/org-dashboard/DECISIONS.md Decision 22: SSE + Redis pub/sub, NOT a new
 * WebSocket stack — mirrors backend/src/routes/notifications.ts's proven pattern for
 * connection lifecycle (auth-via-query-param, heartbeat, duplicate-subscriber pattern).
 * No `ws` dependency, no WebSocketServer.
 *
 * Channel: `org:{orgId}:events` — derived from the authenticated session's org_id,
 * never accepted as a query/path parameter (docs/org-dashboard/ARCHITECTURE.md
 * "API Design": "the org_id is extracted from the authenticated session").
 *
 * Event framing DIFFERS from notifications.ts on purpose: the frontend's
 * `useOrgDashboardLive.ts` (already built against this contract) wraps a plain
 * `EventSource` and only wires up `es.onmessage` — the browser's *default* SSE event
 * type — parsing `evt.data` directly as `OrgDashboardLiveEvent = {type, payload}`. It
 * does NOT call `addEventListener('response_received', ...)` per type the way
 * notifications.ts's own named-`event:` framing would require. So every message here is
 * sent as a plain `data: {"type":...,"payload":...}` line with no `event:` field — never
 * `event: <type>`, which `onmessage` would silently never see.
 *
 * Scope (Decision 21 + Decision 22, and confirmed by app/src/types/orgDashboard.ts's
 * `OrgDashboardLiveEvent` union, which only has 2 members): this channel forwards
 * `response_received` and `anomaly_detected` only — the two "user is watching a number
 * change right now" cases. `crystal_brief_ready` / trust-score-ready notifications
 * deliberately ride the existing app-wide `/api/notifications/stream` instead (Decision
 * 21) — extending that stream's `useNotifications.ts` consumer is a separate, parallel
 * workstream per IMPLEMENTATION_SPEC.md's file ownership, not this channel's job. The
 * `OrgEvent`/`publishOrgEvent` types below stay generic (any `type: string`) so a future,
 * explicitly-decided event can reuse this same transport without a contract change —
 * but nothing in this codebase should publish anything other than the two above today.
 *
 * Integration note: call `registerOrgDashboardStream(app)` once from index.ts — see the
 * comment block atop routes/org-dashboard.ts for the exact line to add.
 */
import type { Express, Request, Response, NextFunction } from 'express';
import { verifyToken } from '@clerk/backend';
import { getRedisClient, getRedisBlockingClient } from '../lib/redis';
import { getOrgClaims } from '../lib/clerkClaims';
import { resolveClerkSecretKey } from '../lib/clerkKeys';
import { DEV_MODE } from '../middleware/auth';
import logger from '../lib/logger';

function orgEventsChannel(orgId: string): string {
  return `org:${orgId}:events`;
}

export interface OrgEvent {
  type: 'response_received' | 'anomaly_detected' | string;
  payload: unknown;
}

/**
 * Publish a typed event onto an org's SSE channel. Fire-and-forget by design — callers
 * (routes/responses.ts's response insert, lib/alertEngine.ts's fireAlert) must never let
 * a publish failure affect their primary write path, so this never throws.
 */
export async function publishOrgEvent(orgId: string, event: OrgEvent): Promise<void> {
  const redis = getRedisClient();
  if (!redis || redis.status !== 'ready') return;
  try {
    await redis.publish(orgEventsChannel(orgId), JSON.stringify(event));
  } catch (err: unknown) {
    logger.warn({ err: (err as Error).message, orgId, type: event.type }, 'org-realtime:publish_failed');
  }
}

// ── response_received debounce (3s per org) ──────────────────────────────────────
// ARCHITECTURE.md's "Debouncing Strategy": bursts during campaigns should flush at
// most once per 3s per org, carrying a batched count rather than firing once per row.
//
// NOTE — single-instance caveat: this Map is process-local in-memory state. With more
// than one backend replica behind a load balancer, each replica keeps its own debounce
// timer/accumulator for the same org, so two replicas each holding a subset of that
// org's connected SSE clients will independently flush on their own 3s clocks rather
// than coordinating a single org-wide flush. That's acceptable for the KPI counter's
// "roughly live" contract (Real-time update latency target is <2s P95, not exactness)
// but is NOT a cross-instance exactly-once guarantee. A multi-instance-correct version
// would move the accumulator into Redis itself (e.g. INCR a per-org counter with a 3s
// expiry and have one elected publisher flush it) rather than in-process state.
interface ResponseAccumulator {
  timer: ReturnType<typeof setTimeout>;
  count: number;
  latestPayload: Record<string, unknown>;
}
const RESPONSE_DEBOUNCE_MS = 3_000;
const responseDebounce = new Map<string, ResponseAccumulator>();

/**
 * Debounced publish for high-frequency `response_received` events. Accumulates a
 * per-org count and republishes the most recent payload (merged with `batchedCount`)
 * at most once every 3 seconds.
 */
export function publishResponseReceivedDebounced(orgId: string, payload: Record<string, unknown>): void {
  const existing = responseDebounce.get(orgId);
  if (existing) {
    existing.count += 1;
    existing.latestPayload = payload;
    return;
  }
  const entry: ResponseAccumulator = {
    count: 1,
    latestPayload: payload,
    timer: setTimeout(() => {
      const acc = responseDebounce.get(orgId);
      responseDebounce.delete(orgId);
      if (!acc) return;
      publishOrgEvent(orgId, {
        type: 'response_received',
        payload: { ...acc.latestPayload, batchedCount: acc.count },
      }).catch(() => { /* publishOrgEvent already logs; never throw into the caller */ });
    }, RESPONSE_DEBOUNCE_MS),
  };
  entry.timer.unref?.(); // never keep the process alive solely for a pending flush
  responseDebounce.set(orgId, entry);
}

// Auth for the SSE stream — EventSource can't set headers, so the token may arrive as a
// ?token= query param. Mirrors routes/notifications.ts's streamAuth exactly, including
// the DEV_MODE bypass to dev-org.
async function streamAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (DEV_MODE) { req.userId = 'dev-user'; req.orgId = 'dev-org'; next(); return; }
  const token = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7)
    : req.query.token as string | undefined;
  if (!token) { res.status(401).end(); return; }
  try {
    const secretKey = resolveClerkSecretKey();
    if (!secretKey) { res.status(401).end(); return; }
    const payload = await verifyToken(token, { secretKey });
    const { orgId } = getOrgClaims(payload);
    req.userId = payload.sub;
    req.orgId = orgId || payload.sub;
    next();
  } catch {
    res.status(401).end();
  }
}

/**
 * Mount `GET /api/org/dashboard/stream` directly on the Express app (not a Router —
 * matches the function signature this feature's spec calls for). Subscribes to
 * `org:{orgId}:events`, where orgId always comes from the authenticated session.
 */
export function registerOrgDashboardStream(app: Express): void {
  app.get('/api/org/dashboard/stream', streamAuth, async (req: Request, res: Response): Promise<void> => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    // No `event:` field — the frontend's EventSource only listens on the default
    // `onmessage` handler (see file header). A named `event: ready` line here would be
    // silently invisible to it, so this initial handshake line is unnamed too.
    res.write(`data: {"type":"ready","payload":{"ok":true}}\n\n`);

    const blocking = getRedisBlockingClient();
    let sub: ReturnType<NonNullable<typeof blocking>['duplicate']> | null = null;
    if (blocking) {
      sub = blocking.duplicate();
      const channel = orgEventsChannel(req.orgId);
      sub.on('message', (_ch: string, message: string) => {
        // Forward the already-shaped `{type, payload}` JSON verbatim as a plain (unnamed)
        // SSE message — this is exactly the `OrgDashboardLiveEvent` shape
        // `useOrgDashboardLive.ts`'s `es.onmessage` parses directly off `evt.data`.
        res.write(`data: ${message}\n\n`);
      });
      sub.subscribe(channel).catch(() => {});
    }

    // Heartbeat keeps proxies from closing the idle connection (matches notifications.ts).
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);

    req.on('close', () => {
      clearInterval(heartbeat);
      if (sub) { try { sub.disconnect(); } catch { /* ignore */ } }
      res.end();
    });
  });
}
