import { query } from '../../lib/db';
import logger from '../../lib/logger';

/**
 * surveyHealthSummary — refreshes survey_health_summary hourly.
 *
 * Hourly (not 15-min) because its anomaly join reads from alert_events, which is updated
 * infrequently relative to response volume.
 *
 * CORRECTED (docs/org-dashboard/PRODUCTION_READINESS_AUDIT.md "Backend / scale /
 * operational" — this comment previously claimed the full recalculation is "bounded by
 * survey count, not response count." That is factually wrong: the underlying view's CTE
 * filters by a 14-day response window (`WHERE r.submitted_at >= NOW() - INTERVAL '14
 * days'`) across ALL of `responses`, with no per-org or per-survey scoping in that
 * predicate — so refresh cost is bound by org-wide 14-day response VOLUME, not survey
 * count. A known, documented scale limitation, not a transient bug — see
 * PRODUCTION_READINESS_AUDIT.md's "Deferred" section for why a proper windowed/incremental
 * redesign was NOT attempted in that pass (needs live-database verification of what each
 * downstream KPI actually requires) and the recommended follow-up.
 */
export async function surveyHealthSummary(): Promise<{ note: string }> {
  await query('REFRESH MATERIALIZED VIEW CONCURRENTLY survey_health_summary');
  logger.info({ job: 'survey-health-summary' }, 'survey-health-summary: refreshed');
  return { note: 'refreshed survey_health_summary' };
}
