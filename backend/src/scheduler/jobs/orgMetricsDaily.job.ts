import { query } from '../../lib/db';
import logger from '../../lib/logger';

/**
 * orgMetricsDaily — refreshes org_metrics_daily + tag_metrics every 15 minutes.
 *
 * CORRECTED (docs/org-dashboard/PRODUCTION_READINESS_AUDIT.md "Backend / scale /
 * operational" — this comment previously claimed "both materialized views only read the
 * current day's partition of `responses`, so a 15-min cadence is cheap." That is factually
 * wrong: neither `org_metrics_daily` nor `tag_metrics` has any date bound in its SQL
 * definition at all (supabase/migrations/20260705000001_org_metrics_daily.sql /
 * 20260705000005_tag_metrics.sql — full `GROUP BY` over the entire history of `responses`
 * every single refresh). Refresh cost scales with the org's full historical response
 * volume, not a bounded daily slice — a known, documented scale limitation, not a
 * transient bug. See PRODUCTION_READINESS_AUDIT.md's "Deferred" section for why a proper
 * windowed/incremental redesign was NOT attempted in that pass (it needs live-database
 * verification of what each downstream KPI actually requires) and the recommended
 * follow-up (a dedicated data-engineering pass before this feature reaches meaningfully
 * large customers).
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
