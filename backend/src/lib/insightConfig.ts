/**
 * Insight Pipeline v2 — configuration helpers.
 *
 * Source of truth for:
 *  - the platform default constants for every insight setting (03_DATA_MODEL.md §2,
 *    05_CONFIGURATION.md §3), used as the final fallback in the 3-level COALESCE merge
 *    (survey_insight_settings → org_insight_defaults → platform constant), and
 *  - `computeConfigHash(settings)` — a deterministic sha256 over the canonical JSON
 *    (sorted keys) of an effective settings object, stored on each checkpoint/run for
 *    audit ("this checkpoint was generated with lookback=5; current setting is 8").
 *
 * Credit-cost defaults mirror creditPlans.CREDIT_COSTS where applicable and the
 * per-run cost table in 05_CONFIGURATION.md §7. Each is env-overridable so pricing
 * can change without a code deploy.
 */
import crypto from 'crypto';

const envInt = (key: string, fallback: number): number => {
  const raw = process.env[key];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
};

/**
 * Platform default constants for every insight setting. NULL at both the survey and
 * org layer falls through to these values. Keys here ARE the canonical setting keys
 * accepted by the PATCH endpoints (see schemas/insightSettings.ts).
 */
export const INSIGHT_SETTING_DEFAULTS = {
  // Automated incremental
  automated_insights_enabled:           true,
  automated_report_generation_enabled:  true,
  stream_response_threshold:            100,
  report_regen_threshold:               25,
  prior_checkpoint_lookback:            5,
  prior_checkpoint_max_age_days:        90,
  full_checkpoint_response_threshold:   200,
  meaningful_delta_nps_points:          2.0,
  meaningful_delta_topic_pct:           10.0,

  // Refresh (user-initiated from Intelligence page)
  refresh_lookback_days:                30,
  refresh_min_response_count:           25,
  refresh_daily_limit:                  5,

  // Manual
  manual_expert_checkpoint_lookback:    3,
  manual_expert_max_corpus:             2000,
  manual_expert_full_corpus_cap:        500,
  manual_expert_snapshot_count:         5,
  manual_quick_sample_cap:              150,
  manual_quick_snapshot_count:          2,
  manual_quick_default_window_days:     14,
  manual_daily_run_limit:               10,

  // Custom Analysis (separate surface)
  custom_analysis_enabled:              true,
  custom_analysis_daily_limit:          3,
  custom_analysis_max_corpus:           5000,
  custom_analysis_min_n_for_nps:        30,

  // Credits (per-run cost; platform defaults from 05_CONFIGURATION.md §7)
  credit_cost_automated_checkpoint:     envInt('CREDIT_COST_AUTOMATED_CHECKPOINT', 5),
  credit_cost_automated_report:         envInt('CREDIT_COST_AUTOMATED_REPORT', 15),
  credit_cost_refresh:                  envInt('CREDIT_COST_REFRESH', 8),
  credit_cost_manual_quick:             envInt('CREDIT_COST_MANUAL_QUICK', 15),
  credit_cost_manual_expert:            envInt('CREDIT_COST_MANUAL_EXPERT', 40),

  // Retention
  automated_checkpoint_retention_days:  365,
  manual_report_retention_days:         730,
  collapse_similar_checkpoints:         true,
} as const;

export type InsightSettingKey = keyof typeof INSIGHT_SETTING_DEFAULTS;

/** Ordered list of every setting key (drives the COALESCE merge in the routes). */
export const INSIGHT_SETTING_KEYS = Object.keys(INSIGHT_SETTING_DEFAULTS) as InsightSettingKey[];

/**
 * Deterministic config hash over an effective settings object. Keys are sorted so the
 * hash is stable regardless of property insertion order. Values are JSON-serialised;
 * NUMERIC columns coerced to number before hashing keeps survey/org/platform layers
 * comparable.
 */
export function computeConfigHash(settings: Record<string, unknown>): string {
  const sortedKeys = Object.keys(settings).sort();
  const canonical: Record<string, unknown> = {};
  for (const k of sortedKeys) canonical[k] = settings[k];
  const json = JSON.stringify(canonical);
  return crypto.createHash('sha256').update(json).digest('hex');
}
