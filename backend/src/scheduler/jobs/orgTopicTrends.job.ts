import { query } from '../../lib/db';
import logger from '../../lib/logger';

/**
 * orgTopicTrends — calls compute_org_topic_trends() weekly (Monday).
 *
 * The scheduler registry (backend/src/scheduler/registry.ts) is a pure fixed-interval
 * scheduler (`intervalSec`) with no day-of-week primitive, so this job is registered on an
 * HOURLY tick (see ORG_JOBS_REGISTRATION_TODO.md) and self-gates to Monday (UTC) inside the
 * handler — every non-Monday tick is a cheap no-op. compute_org_topic_trends() itself is
 * idempotent within a given ISO week (it deletes+reinserts that week's rows), so a missed or
 * doubled Monday tick is harmless.
 *
 * Why hourly and not daily: the registry's due-check is a pure relative interval
 * (`now - lastRun >= intervalSec*1000`), NOT anchored to a calendar day. `lastRun` lives
 * only in memory and resets to 0 on every process restart. With a 24h interval, the "is it
 * Monday" check only ever runs once per ~24h, anchored to restart time — on a stable,
 * long-running deployment that can permanently lock onto whatever day-of-week the process
 * happened to last restart on, and this job could then NEVER land on Monday again. Ticking
 * hourly instead gives ~24 independent chances to observe "is it Monday" within any given
 * Monday's 24h window, regardless of when the process last restarted.
 */
const MONDAY_UTC = 1; // Date#getUTCDay(): 0 = Sunday, 1 = Monday

export async function orgTopicTrends(): Promise<{ note: string }> {
  if (new Date().getUTCDay() !== MONDAY_UTC) {
    return { note: 'skipped — not Monday UTC' };
  }
  await query('CALL compute_org_topic_trends()');
  logger.info({ job: 'org-topic-trends' }, 'org-topic-trends: computed weekly topic trends');
  return { note: 'computed org_topic_trends' };
}
