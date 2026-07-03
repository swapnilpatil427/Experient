// Workflow trigger queue (Redis Streams).
//
// Decouples workflow evaluation/execution from the notification-delivery hot path.
// The Event Engine used to call `runWorkflowsForEvent` inline from
// `eventEngine/processor.ts::handleEvent` — a slow/failing workflow (e.g. a hung
// webhook action) could delay notification ACKs for unrelated events. Instead we
// publish a small "trigger event" record to a dedicated stream and let a separate
// consumer group evaluate + run workflows.
//
// Mirrors the existing `notificationEvents.ts` + `eventEngine/processor.ts` shape:
// single stream + one consumer group, XREADGROUP/XACK/XAUTOCLAIM for at-least-once
// delivery with crash recovery. No BullMQ — this codebase has no BullMQ dependency
// anywhere; Redis Streams is the established async-queue primitive here (see
// eventEngine/processor.ts). See docs/automation-hub/ADR_EXECUTION_ARCHITECTURE.md.
//
// ── Idempotency ─────────────────────────────────────────────────────────────
// XAUTOCLAIM can redeliver a message a crashed consumer already executed. We
// derive a stable idempotency key per (workflow, trigger) pair — NOT per stream
// entry id, because a genuinely new publish for the same logical trigger (e.g. a
// retry-sweep republish) should also collapse into the same key rather than
// double-run the workflow. The key is:
//
//   `${orgId}:${workflowId}:${triggerType}:${dedupField}`
//
// where `dedupField` is the first of event.responseId / event.entityId / event.id
// that is present, else the original stream entry id (`streamId`) for events with
// no natural dedup field (e.g. time.schedule — though that path bypasses this
// queue; see runScheduledWorkflows). The key is written with
// `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING` when the execution row is
// created — see workflowEngine.ts::runWorkflow's optional `idempotencyKey` param,
// threaded through from runWorkflowsForEvent's optional `streamId` param — so a
// redelivery that races a completed/in-flight execution is a guaranteed no-op
// rather than a duplicate side effect.
//
// ── Retry / backoff / DLQ ────────────────────────────────────────────────────
// A failed workflow run is not retried inline. We stamp `attempt_count`,
// `next_retry_at = now + backoff(attempt_count)` on the execution row, and a
// due-retry sweep (run from the same interval tick as the stale-consumer reclaim)
// re-publishes any execution whose `next_retry_at` has passed back onto the
// stream. After `MAX_ATTEMPTS` the execution is marked `dead_letter = true` and
// left for manual replay (`POST /api/workflows/executions/:id/retry` already
// exists and works against dead-lettered rows unchanged).
import { getRedisClient, getRedisBlockingClient } from './redis';
import { query } from './db';
import { runWorkflowsForEvent, type TriggerEvent } from './workflowEngine';
import { TAG_REPORT_DUE_TRIGGER_TYPE, handleTagReportDueTrigger } from './tagReportScheduler';

// ── Stream identity ──────────────────────────────────────────────────────────

export const STREAM_KEY = process.env.WORKFLOW_TRIGGER_STREAM || 'workflow:triggers';
export const GROUP = 'workflow-processor';
const MAXLEN = 50000;

// ── Retry / backoff constants (exported for QA — Kenji tests these precisely) ─

/** Base backoff delay before the first retry (ms). */
export const RETRY_BASE_MS = Number(process.env.WORKFLOW_RETRY_BASE_MS) || 30_000;
/** Exponential backoff multiplier applied per attempt. */
export const RETRY_FACTOR = Number(process.env.WORKFLOW_RETRY_FACTOR) || 2;
/** Attempts (including the first) before an execution is dead-lettered. */
export const MAX_ATTEMPTS = Number(process.env.WORKFLOW_MAX_ATTEMPTS) || 5;

/**
 * Exponential backoff delay (ms) before retry attempt N (1-indexed: the retry
 * following the 1st failed attempt is `backoffMs(1)`).
 *   backoffMs(1) = RETRY_BASE_MS
 *   backoffMs(2) = RETRY_BASE_MS * RETRY_FACTOR
 *   backoffMs(n) = RETRY_BASE_MS * RETRY_FACTOR^(n-1)
 */
export function backoffMs(attempt: number): number {
  const n = Math.max(1, attempt);
  return RETRY_BASE_MS * Math.pow(RETRY_FACTOR, n - 1);
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WorkflowTriggerEvent {
  orgId: string;
  triggerType: string;
  event: TriggerEvent;
}

export interface ParsedWorkflowTriggerEvent {
  orgId: string;
  triggerType: string;
  event: TriggerEvent;
}

let _running = false;
let _stop = false;

function log(level: 'info' | 'warn' | 'error', obj: Record<string, unknown>, msg: string): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    (require('./logger') as Record<string, (obj: Record<string, unknown>, msg: string) => void>)[level](obj, msg);
  } catch {
    console.log(`[workflow-queue] ${msg}`, obj);
  }
}

// ── Idempotency key derivation ────────────────────────────────────────────────

/**
 * Stable dedup key for one (workflow, trigger) pair. `streamId` is the fallback
 * for events with no natural dedup field (guarantees uniqueness per publish
 * rather than collapsing unrelated events of the same type).
 */
export function idempotencyKey(orgId: string, workflowId: string, triggerType: string, event: TriggerEvent, streamId?: string): string {
  const dedupField = event.responseId || event.entityId || (event as Record<string, unknown>).id || streamId || '';
  return `${orgId}:${workflowId}:${triggerType}:${String(dedupField)}`;
}

// ── Publish ───────────────────────────────────────────────────────────────────

/**
 * Enqueue a trigger event for async workflow evaluation. Called from
 * eventEngine/processor.ts instead of calling `runWorkflowsForEvent` inline.
 * @returns stream message id, or null if Redis is unavailable (workflow
 *          evaluation is best-effort — never blocks notification delivery).
 */
export async function publishWorkflowTrigger(e: WorkflowTriggerEvent): Promise<string | null> {
  const redis = getRedisClient();
  if (!redis || redis.status !== 'ready') return null;
  if (!e.orgId || !e.triggerType) throw new Error('publishWorkflowTrigger requires orgId + triggerType');

  return redis.xadd(
    STREAM_KEY, 'MAXLEN', '~', String(MAXLEN), '*',
    'org_id', e.orgId,
    'trigger_type', e.triggerType,
    'event', JSON.stringify(e.event || {}),
    'ts', String(Date.now()),
  );
}

// Parse a Redis stream entry's flat [k,v,k,v,...] field array.
export function parseTriggerFields(fields: string[]): ParsedWorkflowTriggerEvent {
  const m: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) m[fields[i]] = fields[i + 1];
  return {
    orgId: m.org_id,
    triggerType: m.trigger_type,
    event: safeJson<TriggerEvent>(m.event, {}),
  };
}

function safeJson<T>(s: string, fallback: T): T {
  try { return s ? JSON.parse(s) as T : fallback; } catch { return fallback; }
}

// ── Consume ───────────────────────────────────────────────────────────────────

async function ensureGroup(redis: NonNullable<ReturnType<typeof getRedisBlockingClient>>): Promise<void> {
  try {
    await redis.xgroup('CREATE', STREAM_KEY, GROUP, '$', 'MKSTREAM');
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    if (!error.message.includes('BUSYGROUP')) throw err; // group already exists
  }
}

async function handleTrigger(evt: ParsedWorkflowTriggerEvent, streamId: string): Promise<void> {
  try {
    // Tag Report's Automated-mode due-tags sweep (lib/tagReportScheduler.ts)
    // reuses this queue for thundering-herd jitter + crash-recovery, but is a
    // system-internal signal, NOT an org-authored automation trigger — dispatch
    // it to its own dedicated handler instead of runWorkflowsForEvent (which is
    // specifically for evaluating org-authored workflows against a trigger type).
    if (evt.triggerType === TAG_REPORT_DUE_TRIGGER_TYPE) {
      const tagId = (evt.event as Record<string, unknown> | undefined)?.entityId as string | undefined;
      if (tagId) await handleTagReportDueTrigger(evt.orgId, tagId);
      return;
    }
    await runWorkflowsForEvent(evt.orgId, evt.triggerType, evt.event, streamId);
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    log('warn', { event: 'workflow_trigger_failed', type: evt.triggerType, streamId, err: error.message }, 'workflow trigger handling failed');
    // runWorkflowsForEvent already isolates per-workflow failures internally and
    // does not throw for individual workflow errors; a throw here means the
    // *lookup* failed (e.g. DB down). Retry/DLQ bookkeeping for individual
    // workflow execution failures happens inside workflowEngine's execution
    // rows (attempt_count/next_retry_at), swept by `sweepDueRetries` below —
    // this catch just prevents a poison-message loop on the stream itself.
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
        await handleTrigger(parseTriggerFields(fields), id);
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        log('error', { event: 'workflow_trigger_event_failed', id, err: error.message }, 'workflow trigger event failed');
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
      try { await handleTrigger(parseTriggerFields(fields), id); }
      catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        log('error', { id, err: error.message }, 'workflow reclaim handler failed');
      }
      finally { await redis.xack(STREAM_KEY, GROUP, id); }
    }
    return entries.length;
  } catch { return 0; }
}

// ── Retry sweep + dead-letter transition ─────────────────────────────────────

export interface SweepResult {
  republished: number;
  deadLettered: number;
}

/**
 * Find `failed` executions whose `next_retry_at` is due, and either re-publish
 * them onto the stream (attempt_count < MAX_ATTEMPTS) or mark them dead_letter
 * (attempt_count >= MAX_ATTEMPTS). Idempotent: republishing is safe because the
 * consumer re-derives the same idempotency key (see `idempotencyKey` above) for
 * the republished trigger, and the unique `idempotency_key` constraint on
 * `workflow_executions` (enforced in `workflowEngine.ts::runWorkflow` via
 * `ON CONFLICT DO NOTHING`) prevents a genuinely duplicate execution row.
 *
 * The two top-level queries (`dead`, `due`) are each wrapped individually so a
 * transient DB error on one doesn't also skip the other — e.g. a blip during
 * the dead-letter UPDATE must not also suppress that tick's republish pass, and
 * vice versa (docs/automation-hub/RUNBOOKS.md §3 "root-cause follow-up": before
 * this fix, an unwrapped throw from either query aborted the whole function,
 * silently skipping an entire tick's worth of both dead-lettering and
 * republishing rather than just degrading gracefully until the next tick).
 */
export async function sweepDueRetries(now: Date = new Date()): Promise<SweepResult> {
  let dead: Array<Record<string, unknown>> = [];
  try {
    const res = await query(
      `UPDATE workflow_executions
          SET dead_letter = TRUE
        WHERE status = 'failed' AND dead_letter = FALSE
          AND attempt_count >= $1 AND next_retry_at IS NOT NULL AND next_retry_at <= $2
        RETURNING id, workflow_id, org_id, trigger_type, trigger_payload`,
      [MAX_ATTEMPTS, now.toISOString()]
    );
    dead = res.rows as Array<Record<string, unknown>>;
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    log('warn', { err: error.message }, 'workflow dead-letter sweep query failed');
  }

  let due: Array<Record<string, unknown>> = [];
  try {
    const res = await query(
      `SELECT id, workflow_id, org_id, trigger_type, trigger_payload, attempt_count
         FROM workflow_executions
        WHERE status = 'failed' AND dead_letter = FALSE
          AND attempt_count < $1 AND next_retry_at IS NOT NULL AND next_retry_at <= $2`,
      [MAX_ATTEMPTS, now.toISOString()]
    );
    due = res.rows as Array<Record<string, unknown>>;
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    log('warn', { err: error.message }, 'workflow due-retry sweep query failed');
  }

  let republished = 0;
  for (const row of due) {
    try {
      const id = await publishWorkflowTrigger({
        orgId: row.org_id as string,
        triggerType: row.trigger_type as string,
        event: (row.trigger_payload as TriggerEvent) || {},
      });
      if (id) {
        // Clear next_retry_at so we don't republish again before the next
        // attempt's own failure re-stamps it; attempt bookkeeping happens in
        // workflowEngine when the retried run itself fails.
        await query('UPDATE workflow_executions SET next_retry_at = NULL WHERE id = $1', [row.id]);
        republished++;
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      log('warn', { execId: row.id, err: error.message }, 'workflow retry republish failed');
    }
  }

  if (dead.length) log('warn', { count: dead.length }, 'workflow executions dead-lettered');
  return { republished, deadLettered: dead.length };
}

// ── Stuck-'executing'-row reaper ─────────────────────────────────────────────

/** Minutes a row may sit in `status = 'executing'` before the reaper force-fails it. */
export const EXECUTING_TIMEOUT_MIN = Number(process.env.WORKFLOW_EXECUTING_TIMEOUT_MIN) || 5;

/**
 * If `finalizeExecution`'s own UPDATE fails (e.g. a Postgres blip at the exact
 * moment of finalization — docs/automation-hub/RUNBOOKS.md §3), an execution row
 * never reaches a terminal status: it's invisible to `sweepDueRetries`, which
 * only looks at `status = 'failed'`, so it's never retried, never dead-lettered,
 * never alertable. This reaper finds rows stuck in `status = 'executing'` older
 * than `EXECUTING_TIMEOUT_MIN` and force-fails them (stamping `attempt_count`/
 * `next_retry_at`/`dead_letter` the same way a normal failure would, so the row
 * enters the ordinary retry/DLQ path on the very next sweep tick rather than
 * needing its own bespoke recovery logic).
 */
export async function reapStuckExecutions(now: Date = new Date()): Promise<number> {
  try {
    const cutoff = new Date(now.getTime() - EXECUTING_TIMEOUT_MIN * 60 * 1000);
    const { rows } = await query(
      `SELECT id, workflow_id, attempt_count FROM workflow_executions
        WHERE status = 'executing' AND triggered_at < $1`,
      [cutoff.toISOString()]
    );
    let reaped = 0;
    for (const row of rows as Array<Record<string, unknown>>) {
      try {
        const attempt = ((row.attempt_count as number | undefined) ?? 0) + 1;
        const willRetry = attempt < MAX_ATTEMPTS;
        const nextRetryAt = willRetry ? new Date(now.getTime() + backoffMs(attempt)) : null;
        await query(
          `UPDATE workflow_executions
              SET status = 'failed', completed_at = NOW(),
                  error_message = COALESCE(error_message, 'reaped: stuck in executing past timeout'),
                  attempt_count = $2, next_retry_at = $3, dead_letter = $4
            WHERE id = $1 AND status = 'executing'`,
          [row.id, attempt, nextRetryAt, attempt >= MAX_ATTEMPTS]
        );
        reaped++;
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        log('warn', { execId: row.id, err: error.message }, 'workflow stuck-execution reap failed');
      }
    }
    if (reaped) log('warn', { count: reaped }, 'workflow executions reaped from stuck executing state');
    return reaped;
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    log('warn', { err: error.message }, 'workflow stuck-execution reap query failed');
    return 0;
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

/**
 * Start the workflow-trigger consumer loop + periodic retry sweep. Same shape
 * as eventEngine/processor.ts::start — runs in-process in the backend
 * (ENABLE_EVENT_ENGINE=true) or in the standalone Event Engine service.
 */
export async function start({ consumer = `wq-${process.pid}` } = {}): Promise<void> {
  const redis = getRedisBlockingClient();
  if (!redis) { log('warn', {}, 'Workflow Queue: no REDIS_URL — processor disabled'); return; }
  if (_running) return;
  _running = true; _stop = false;
  if (redis.status !== 'ready') await new Promise<void>((r) => redis.once('ready', r));
  await ensureGroup(redis);
  log('info', { consumer }, 'Workflow Queue: trigger processor started');

  // Due-retry sweep (every minute) — republishes backed-off failures, dead-letters
  // exhausted ones, and reaps rows stuck in 'executing' past EXECUTING_TIMEOUT_MIN
  // (same tick, so a stuck row and a normal retry are swept on the same cadence).
  const retrySweep = setInterval(() => {
    sweepDueRetries()
      .then(({ republished, deadLettered }) => {
        if (republished || deadLettered) log('info', { republished, deadLettered }, 'workflow retry sweep');
      })
      .catch((err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        log('warn', { err: error.message }, 'workflow retry sweep failed');
      });
    reapStuckExecutions()
      .then((reaped) => { if (reaped) log('info', { reaped }, 'workflow stuck-execution reap'); })
      .catch((err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        log('warn', { err: error.message }, 'workflow stuck-execution reap tick failed');
      });
  }, 60 * 1000);

  let ticks = 0;
  while (!_stop) {
    try {
      await processBatch(redis, consumer);
      if (++ticks % 6 === 0) await reclaimStale(redis, consumer);
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      log('error', { err: error.message }, 'workflow queue loop error');
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  clearInterval(retrySweep);
  _running = false;
}

export function stop(): void { _stop = true; }
