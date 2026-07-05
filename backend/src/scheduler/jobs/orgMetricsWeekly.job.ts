import { query } from '../../lib/db';
import logger from '../../lib/logger';

/**
 * orgMetricsWeekly — refreshes org_metrics_weekly daily.
 *
 * The weekly rollup reads from org_metrics_daily (already aggregated), so a daily refresh is
 * inexpensive even though the underlying grain is weekly.
 */
export async function orgMetricsWeekly(): Promise<{ note: string }> {
  await query('REFRESH MATERIALIZED VIEW CONCURRENTLY org_metrics_weekly');
  logger.info({ job: 'org-metrics-weekly' }, 'org-metrics-weekly: refreshed');
  return { note: 'refreshed org_metrics_weekly' };
}
