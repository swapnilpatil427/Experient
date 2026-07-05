import { query } from '../../lib/db';
import logger from '../../lib/logger';

/**
 * orgMetricsDaily — refreshes org_metrics_daily + tag_metrics every 15 minutes.
 *
 * Both materialized views only read the current day's partition of `responses`, so a 15-min
 * cadence is cheap (per docs/org-dashboard/ARCHITECTURE.md's "Materialized View Refresh
 * Strategy" — same reasoning, ported onto the real schema/scheduler in
 * docs/org-dashboard/IMPLEMENTATION_SPEC.md since pg_cron is not installed in this stack).
 *
 * REFRESH MATERIALIZED VIEW CONCURRENTLY requires the target's UNIQUE index (present per
 * supabase/migrations/20260705000001_org_metrics_daily.sql /
 * 20260705000005_tag_metrics.sql) and cannot run inside an explicit transaction — `query()`
 * sends each REFRESH as its own standalone statement, which is compatible with CONCURRENTLY.
 */
export async function orgMetricsDaily(): Promise<{ note: string }> {
  await query('REFRESH MATERIALIZED VIEW CONCURRENTLY org_metrics_daily');
  await query('REFRESH MATERIALIZED VIEW CONCURRENTLY tag_metrics');
  logger.info({ job: 'org-metrics-daily' }, 'org-metrics-daily: refreshed org_metrics_daily + tag_metrics');
  return { note: 'refreshed org_metrics_daily + tag_metrics' };
}
