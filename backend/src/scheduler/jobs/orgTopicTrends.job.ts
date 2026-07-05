import { query } from '../../lib/db';
import logger from '../../lib/logger';

/**
 * orgTopicTrends — calls compute_org_topic_trends() weekly (Monday).
 *
 * The scheduler registry (backend/src/scheduler/registry.ts) is a pure fixed-interval
 * scheduler (`intervalSec`) with no day-of-week primitive, so this job is registered on a
 * daily tick (see ORG_JOBS_REGISTRATION_TODO.md) and self-gates to Monday (UTC) inside the
 * handler — every non-Monday tick is a cheap no-op. compute_org_topic_trends() itself is
 * idempotent within a given ISO week (it deletes+reinserts that week's rows), so a missed or
 * doubled Monday tick is harmless.
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
