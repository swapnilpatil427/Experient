// Event Engine — notification stream processor.
//
// Consumes `notifications:events` (consumer group), resolves recipients, and
// persists each via createNotification (which applies dedup + preference gating
// and publishes to the per-user live channel for SSE fanout). At-least-once:
// messages are XACK'd only after handling; stale pending messages are reclaimed
// via XAUTOCLAIM so a crashed consumer's work is retried.
//
// Runs either standalone (src/eventEngine/index.js — the deployable event-engine
// service) or in-process in the backend when ENABLE_EVENT_ENGINE=true (dev).
import { query as dbQuery } from '../lib/db';
import { getRedisBlockingClient } from '../lib/redis';
import { touchHeartbeat } from '../lib/metrics';
import { createNotification, serialize } from '../lib/notifications';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { dispatchExternalChannels } = require('../lib/channels') as {
  dispatchExternalChannels: (orgId: string, userId: string, notification: unknown) => Promise<void>;
};
import { parseEventFields, STREAM_KEY, GROUP, type ParsedNotificationEvent } from '../lib/notificationEvents';

let _running = false;
let _stop = false;

function log(level: string, obj: Record<string, unknown>, msg: string): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    (require('../lib/logger') as Record<string, (obj: Record<string, unknown>, msg: string) => void>)[level](obj, msg);
  } catch {
    console.log(`[event-engine] ${msg}`, obj);
  }
}

type NotificationEvent = ParsedNotificationEvent;

// Resolve which users should receive an event. Explicit targetUserIds win;
// otherwise fall back to org admins (users:manage) for org-wide events.
async function resolveRecipients(event: NotificationEvent): Promise<string[]> {
  if (event.targetUserIds && event.targetUserIds.length) return event.targetUserIds;
  try {
    const { rows } = await dbQuery(
      `SELECT up.user_id
         FROM user_profiles up
         JOIN org_roles r ON r.id = up.role_id
        WHERE up.org_id = $1 AND up.is_active = TRUE AND up.deprovisioned_at IS NULL
          AND (r.default_permissions->>'users:manage') = 'ALL'`,
      [event.orgId]
    );
    return rows.map((r) => (r as { user_id: string }).user_id);
  } catch {
    return [];
  }
}

async function handleEvent(event: NotificationEvent): Promise<void> {
  const recipients = await resolveRecipients(event);
  const title = event.title || defaultTitle(event);
  for (const userId of recipients) {
    const row = await createNotification({
      orgId: event.orgId, userId, type: event.type, priority: event.priority,
      title, body: event.body, actionUrl: event.actionUrl,
      entityType: event.entityType, entityId: event.entityId,
      payload: event.payload, dedupWindowMs: event.dedupWindowMs,
    });
    // Persisted (not suppressed) → fan out to the user's external channels.
    if (row) await dispatchExternalChannels(event.orgId, userId, serialize(row));
  }

  // The same event can drive workflows subscribed to this trigger type
  // (e.g. alert.fired → "NPS Recovery"). Enqueued onto the dedicated
  // workflow:triggers stream (lib/workflowQueue.ts) instead of running inline —
  // a slow/failing workflow action (e.g. a hung webhook) must not delay
  // notification ACKs for unrelated events. Best-effort; never blocks delivery.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    await (require('../lib/workflowQueue') as { publishWorkflowTrigger: (e: { orgId: string; triggerType: string; event: NotificationEvent }) => Promise<string | null> })
      .publishWorkflowTrigger({ orgId: event.orgId, triggerType: event.type, event });
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    log('warn', { event: 'workflow_trigger_publish_failed', type: event.type, err: error.message }, 'workflow trigger publish failed');
  }
}

function defaultTitle(event: NotificationEvent): string {
  return event.type.replace(/[._]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

async function ensureGroup(redis: NonNullable<ReturnType<typeof getRedisBlockingClient>>): Promise<void> {
  try {
    await redis!.xgroup('CREATE', STREAM_KEY, GROUP, '$', 'MKSTREAM');
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    if (!error.message.includes('BUSYGROUP')) throw err; // group already exists
  }
}

// Process one batch. Exported for unit testing without the infinite loop.
export async function processBatch(
  redis: NonNullable<ReturnType<typeof getRedisBlockingClient>>,
  consumer: string,
  { block = 5000, count = 20 } = {}
): Promise<number> {
  const res = await redis.xreadgroup(
    'GROUP', GROUP, consumer, 'COUNT', count, 'BLOCK', block, 'STREAMS', STREAM_KEY, '>'
  );
  if (!res) return 0;
  let handled = 0;
  for (const [, entries] of res as [string, [string, string[]][]][]) {
    for (const [id, fields] of entries) {
      try {
        await handleEvent(parseEventFields(fields));
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        log('error', { event: 'notif_event_failed', id, err: error.message }, 'event handler failed');
      } finally {
        await redis.xack(STREAM_KEY, GROUP, id); // ack to avoid poison-message loops
        handled++;
      }
    }
  }
  return handled;
}

// Reclaim messages pending > idleMs from dead consumers (crash recovery).
export async function reclaimStale(
  redis: NonNullable<ReturnType<typeof getRedisBlockingClient>>,
  consumer: string,
  idleMs = 30000
): Promise<number> {
  try {
    const res = await redis.xautoclaim(STREAM_KEY, GROUP, consumer, idleMs, '0', 'COUNT', 50);
    const entries: [string, string[]][] = (res as [string, [string, string[]][]] | null)?.[1] || [];
    for (const [id, fields] of entries) {
      try { await handleEvent(parseEventFields(fields)); }
      catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        log('error', { id, err: error.message }, 'reclaim handler failed');
      }
      finally { await redis.xack(STREAM_KEY, GROUP, id); }
    }
    return entries.length;
  } catch { return 0; }
}

export async function start({ consumer = `c-${process.pid}` } = {}): Promise<void> {
  const redis = getRedisBlockingClient();
  if (!redis) { log('warn', {}, 'Event Engine: no REDIS_URL — processor disabled'); return; }
  if (_running) return;
  _running = true; _stop = false;
  // Wait for connection readiness before group creation.
  if (redis.status !== 'ready') await new Promise<void>((r) => redis.once('ready', r));
  await ensureGroup(redis);
  log('info', { consumer }, 'Event Engine: notification processor started');

  // Workflow trigger consumer — separate stream + consumer group (own blocking
  // XREADGROUP loop), started/stopped alongside the notification processor so
  // both the backend (ENABLE_EVENT_ENGINE=true) and the standalone Event Engine
  // service run it identically. Never awaited inline: it has its own infinite
  // loop and must run concurrently with the notification loop below.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const workflowQueue = require('../lib/workflowQueue') as { start: (opts?: { consumer?: string }) => Promise<void>; stop: () => void };
  const workflowQueueStarted = workflowQueue.start({ consumer: `wq-${consumer}` }).catch((err: unknown) => {
    const error = err instanceof Error ? err : new Error(String(err));
    log('error', { err: error.message }, 'workflow queue processor failed to start');
  });

  // Scheduled alert evaluation (every 15 min) — deterministic rule sweep.
  const alertSweep = setInterval(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    (require('../lib/alertEngine') as { runScheduledEvaluation: () => Promise<number> }).runScheduledEvaluation()
      .then((n) => { if (n) log('info', { fired: n }, 'scheduled alert sweep'); })
      .catch((err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        log('warn', { err: error.message }, 'alert sweep failed');
      });
  }, 15 * 60 * 1000);

  // Cron tick (every minute) — runs due time.schedule workflows.
  const cronTick = setInterval(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    (require('../lib/workflowEngine') as { runScheduledWorkflows: () => Promise<unknown[]> }).runScheduledWorkflows()
      .then((ran) => { if (ran.length) log('info', { ran: ran.length }, 'scheduled workflows ran'); })
      .catch((err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        log('warn', { err: error.message }, 'cron tick failed');
      });
  }, 60 * 1000);

  // Tag Report Automated-mode due-tags sweep (TRACKER.md §1 Task 15) — same
  // cadence class as alertSweep (a deterministic rule sweep, not per-minute
  // precision-critical); jitter is applied per-tag at trigger time inside
  // sweepDueTagReports itself, not by this interval's cadence.
  const tagReportSweep = setInterval(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    (require('../lib/tagReportScheduler') as { sweepDueTagReports: () => Promise<{ found: number; enqueued: number }> }).sweepDueTagReports()
      .then(({ found, enqueued }) => { if (found) log('info', { found, enqueued }, 'tag report automated sweep'); })
      .catch((err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        log('warn', { err: error.message }, 'tag report automated sweep failed');
      });
  }, 15 * 60 * 1000);

  let ticks = 0;
  while (!_stop) {
    try {
      touchHeartbeat('event_engine');   // liveness signal for SchedulerHeartbeatStale alert
      await processBatch(redis, consumer);
      if (++ticks % 6 === 0) await reclaimStale(redis, consumer);
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      log('error', { err: error.message }, 'processor loop error');
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  clearInterval(alertSweep);
  clearInterval(cronTick);
  clearInterval(tagReportSweep);
  workflowQueue.stop();
  await workflowQueueStarted;
  _running = false;
}

export function stop(): void { _stop = true; }
