/**
 * Tag Report — Automated mode due-tags sweep (TRACKER.md §1 Task 15).
 *
 * "Thundering-herd avoidance (Automated mode)" (TRACKER.md §1 Rate Limiting /
 * Operational Concerns) calls for deterministic per-(org,tag) jitter applied at
 * TRIGGER time (i.e. when a tag is found due, during this sweep's tick) — not
 * baked into cron registration — enqueued onto the EXISTING Redis-Streams-backed
 * async queue from Automation Hub Wave 1 (`lib/workflowQueue.ts`) rather than
 * building a second queue.
 *
 * Design note on why this dispatches through workflowQueue.ts's stream instead
 * of calling the automated-run creation logic in-process directly: the queue
 * gives this sweep the same crash-recovery (XAUTOCLAIM reclaim) and at-least-
 * once delivery guarantees `workflowQueue.ts` already documents, and — per
 * TRACKER.md reconciliation item 6's deployment nuance — the sweep tick and the
 * queue consumer may not always run in the same process (event-engine can be a
 * standalone service), so publishing onto a shared external stream is the
 * correct decoupling regardless of topology.
 *
 * `handleTagReportDueTrigger` (the consumer-side handler) is dispatched from
 * `workflowQueue.ts::handleTrigger` for this module's trigger type, DISTINCT
 * from `runWorkflowsForEvent` — that function is specifically for evaluating
 * org-authored automation workflows against a trigger type; a Tag Report
 * "automated run is due" signal is an internal system task, not something an
 * org author owns a workflow against, so it must not be routed through that
 * dispatcher.
 *
 * NOTE on cadence/eligibility storage — an explicit, documented engineering
 * decision, not called out by DESIGN.md/TRACKER.md: neither document specifies a
 * schema column for "is Automated mode enabled for this tag, and how often."
 * This module reuses the existing `survey_tags.program_config` JSONB column
 * (already present pre-Tag-Report, see TRACKER.md §1 Grounding) under a
 * `tag_report_automated: { enabled: boolean, cadence_hours: number }` key —
 * additive, requires no new migration, and is exactly the kind of per-tag
 * config that column already exists for. Flagged as an assumption for the team
 * to confirm/replace once the Automated-mode admin UX is designed.
 *
 * This module deliberately does NOT statically `import` `lib/workflowQueue.ts`
 * (which itself statically imports this module's trigger-type constant +
 * handler) to avoid a require cycle; `publishWorkflowTrigger` is required
 * lazily inside `sweepDueTagReports`, mirroring the lazy-require pattern already
 * used in `db.ts`/`workflowQueue.ts` for the same reason. `sweepDueTagReports`
 * also accepts an injectable `publish` function so it is fully unit-testable
 * without touching Redis at all.
 */
import crypto from 'crypto';
import { query } from './db';
import logger from './logger';
import { startTagReportRun } from './tagReportRunner';

export const TAG_REPORT_DUE_TRIGGER_TYPE = 'tag_report.automated_due';

/** Default cadence when a tag enables Automated mode without specifying one. */
export const DEFAULT_TAG_REPORT_CADENCE_HOURS = 24 * 7; // weekly

/** Jitter window applied at trigger time (ms) — due tags fire at a random-but-
 *  deterministic offset within this window so a sweep tick doesn't fire every
 *  due tag at the same instant. */
export const TAG_REPORT_JITTER_WINDOW_MS = Number(process.env.TAG_REPORT_JITTER_WINDOW_MS) || 5 * 60 * 1000;

export interface DueTagReport {
  orgId: string;
  tagId: string;
}

interface DueTagRow {
  org_id: string;
  tag_id: string;
  cadence_hours: number | string | null;
  last_run_at: string | Date | null;
}

/**
 * Find tags with Automated Tag Report enabled whose last automated run is
 * missing or older than their configured cadence, excluding tags that already
 * have a pending/running run (the `uq_gir_tag_inflight` guard would make a
 * duplicate attach harmless anyway, but skipping here avoids needless enqueue
 * noise and jitter-timer churn).
 */
export async function findDueAutomatedTags(now: Date = new Date()): Promise<DueTagReport[]> {
  const { rows } = await query<DueTagRow>(
    `SELECT t.org_id, t.id AS tag_id,
            (t.program_config -> 'tag_report_automated' ->> 'cadence_hours')::int AS cadence_hours,
            lr.created_at AS last_run_at
     FROM survey_tags t
     LEFT JOIN LATERAL (
       SELECT created_at FROM group_insight_runs g
       WHERE g.org_id = t.org_id AND g.tag_ids @> ARRAY[t.id]::uuid[] AND g.run_mode = 'automated'
       ORDER BY g.created_at DESC
       LIMIT 1
     ) lr ON true
     WHERE (t.program_config -> 'tag_report_automated' ->> 'enabled')::boolean IS TRUE
       AND NOT EXISTS (
         SELECT 1 FROM group_insight_runs p
         WHERE p.org_id = t.org_id AND p.tag_ids @> ARRAY[t.id]::uuid[]
           AND p.status IN ('pending', 'running')
       )`,
    [],
  );

  const due: DueTagReport[] = [];
  for (const row of rows) {
    const cadenceHours = row.cadence_hours != null && Number(row.cadence_hours) > 0
      ? Number(row.cadence_hours)
      : DEFAULT_TAG_REPORT_CADENCE_HOURS;
    const cadenceMs = cadenceHours * 60 * 60 * 1000;
    const lastRunMs = row.last_run_at ? new Date(row.last_run_at).getTime() : null;
    const isDue = lastRunMs == null || (now.getTime() - lastRunMs) >= cadenceMs;
    if (isDue) due.push({ orgId: row.org_id, tagId: row.tag_id });
  }
  return due;
}

/** Deterministic per-(org,tag) jitter offset within [0, windowMs). */
export function computeJitterMs(orgId: string, tagId: string, windowMs: number = TAG_REPORT_JITTER_WINDOW_MS): number {
  const hash = crypto.createHash('sha1').update(`${orgId}:${tagId}`).digest();
  const n = hash.readUInt32BE(0);
  return n % Math.max(1, windowMs);
}

/**
 * Handle a due-tag-report trigger consumed off the workflow queue: start an
 * Automated Tag Report run for this (org, tag) via the same core run-creation
 * flow the internal HTTP endpoint uses (`lib/tagReportRunner.ts`), so both entry
 * points (direct internal HTTP call, and this queue-driven sweep) share one
 * concurrency-safe, zero-fresh-AI-enforcing code path.
 */
export async function handleTagReportDueTrigger(orgId: string, tagId: string): Promise<void> {
  const result = await startTagReportRun({ orgId, userId: null, tagId, runMode: 'automated', trigger: 'scheduled' });
  if (!result.ok) {
    logger.warn({ orgId, tagId, status: result.status, error: result.error }, 'tag_report:automated_due:skipped');
  }
}

export type PublishFn = (e: { orgId: string; triggerType: string; event: Record<string, unknown> }) => Promise<string | null>;

/**
 * Sweep tick: find due tags, jitter, and enqueue each onto the existing workflow
 * trigger queue (`lib/workflowQueue.ts`). `publish` is injectable (tests pass a
 * spy; production falls back to a lazy require of `publishWorkflowTrigger` to
 * avoid a static require cycle — see module header).
 */
export async function sweepDueTagReports(
  now: Date = new Date(),
  publish?: PublishFn,
): Promise<{ found: number; enqueued: number }> {
  const due = await findDueAutomatedTags(now);
  const doPublish: PublishFn = publish ?? (
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    (require('./workflowQueue') as { publishWorkflowTrigger: PublishFn }).publishWorkflowTrigger
  );

  let enqueued = 0;
  for (const { orgId, tagId } of due) {
    const jitterMs = computeJitterMs(orgId, tagId);
    setTimeout(() => {
      doPublish({ orgId, triggerType: TAG_REPORT_DUE_TRIGGER_TYPE, event: { entityId: tagId } })
        .catch((err: unknown) => {
          const error = err instanceof Error ? err : new Error(String(err));
          logger.warn({ orgId, tagId, err: error.message }, 'tag_report:sweep:publish_failed');
        });
    }, jitterMs);
    enqueued++;
  }
  return { found: due.length, enqueued };
}
