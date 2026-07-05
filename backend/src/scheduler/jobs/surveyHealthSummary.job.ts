import { query } from '../../lib/db';
import logger from '../../lib/logger';

/**
 * surveyHealthSummary — refreshes survey_health_summary hourly.
 *
 * Hourly (not 15-min) because its anomaly join reads from alert_events, which is updated
 * infrequently relative to response volume, and the full recalculation is bounded by survey
 * count, not response count (docs/org-dashboard/ARCHITECTURE.md's refresh-strategy reasoning).
 */
export async function surveyHealthSummary(): Promise<{ note: string }> {
  await query('REFRESH MATERIALIZED VIEW CONCURRENTLY survey_health_summary');
  logger.info({ job: 'survey-health-summary' }, 'survey-health-summary: refreshed');
  return { note: 'refreshed survey_health_summary' };
}
