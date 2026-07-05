import { query } from '../../lib/db';
import logger from '../../lib/logger';

/**
 * orgHealthScore — calls compute_all_org_health_scores() daily.
 *
 * Upserts one org_health_score row per org that has data in org_metrics_daily; safe to run
 * more than once per day (each run recomputes from the latest org_metrics_daily row and
 * upserts on the org_id unique constraint).
 */
export async function orgHealthScore(): Promise<{ note: string }> {
  await query('CALL compute_all_org_health_scores()');
  logger.info({ job: 'org-health-score' }, 'org-health-score: recomputed org health scores');
  return { note: 'computed org_health_score' };
}
