/**
 * Zod request schemas for Insight Pipeline v2 settings.
 *
 *  - updateInsightSettingsSchema — PATCH /api/insights/:surveyId/settings body
 *  - updateOrgInsightDefaultsSchema — PATCH /api/orgs/:orgId/insight-defaults body
 *
 * Both are partial (any subset of known keys). Unknown keys are stripped (Zod default).
 * Ranges mirror docs/insights/new_design/03_DATA_MODEL.md §2/§13 and 05_CONFIGURATION.md
 * §3/§7/§10. Credit-cost overrides are positive ints in [1, 500] (platform ceiling) and
 * accept null to mean "fall back to org default / platform constant".
 */
import { z } from 'zod';

// Integer in an inclusive range.
const intRange = (min: number, max: number) =>
  z.number().int().min(min).max(max);

// NUMERIC setting with one decimal of precision, inclusive range.
const numRange = (min: number, max: number) =>
  z.number().min(min).max(max);

// Credit-cost override: positive int 1–500, or null to clear (use lower layer).
const creditCost = z.union([intRange(1, 500), z.null()]);

/**
 * Full per-setting field map. Survey settings accept the entire set; org defaults
 * accept the subset that exists on org_insight_defaults (03 §13).
 */
const settingFields = {
  // Automated incremental
  automated_insights_enabled:           z.boolean(),
  automated_report_generation_enabled:  z.boolean(),
  stream_response_threshold:            intRange(5, 500),
  report_regen_threshold:               intRange(10, 200),
  prior_checkpoint_lookback:            intRange(1, 20),
  prior_checkpoint_max_age_days:        intRange(7, 365),
  full_checkpoint_response_threshold:   intRange(50, 2000),
  meaningful_delta_nps_points:          numRange(0.5, 10),
  meaningful_delta_topic_pct:           numRange(5, 25),

  // Refresh
  refresh_lookback_days:                intRange(7, 365),
  refresh_min_response_count:           intRange(5, 100),
  refresh_daily_limit:                  intRange(1, 20),

  // Manual
  manual_expert_checkpoint_lookback:    intRange(1, 10),
  manual_expert_max_corpus:             intRange(500, 5000),
  manual_expert_full_corpus_cap:        intRange(100, 2000),
  manual_expert_snapshot_count:         intRange(2, 10),
  manual_quick_sample_cap:              intRange(50, 500),
  manual_quick_snapshot_count:          intRange(2, 10),
  manual_quick_default_window_days:     intRange(7, 90),
  manual_daily_run_limit:               intRange(1, 50),

  // Custom Analysis
  custom_analysis_enabled:              z.boolean(),
  custom_analysis_daily_limit:          intRange(1, 20),
  custom_analysis_max_corpus:           intRange(500, 20000),
  custom_analysis_min_n_for_nps:        intRange(10, 100),

  // Credits
  credit_cost_automated_checkpoint:     creditCost,
  credit_cost_automated_report:         creditCost,
  credit_cost_refresh:                  creditCost,
  credit_cost_manual_quick:             creditCost,
  credit_cost_manual_expert:            creditCost,

  // Retention
  automated_checkpoint_retention_days:  intRange(1, 3650),
  manual_report_retention_days:         intRange(1, 3650),
  collapse_similar_checkpoints:         z.boolean(),
} as const;

/**
 * Survey-level settings patch. `.partial()` makes every field optional;
 * `.strict()` rejects unknown keys with a 400 (prevents silent typos).
 */
export const updateInsightSettingsSchema = z
  .object(settingFields)
  .partial()
  .strict()
  .superRefine((val, ctx) => {
    // 05_CONFIGURATION.md §10: manual_expert_max_corpus >= manual_expert_full_corpus_cap.
    // Only enforced when both are present in the same patch (each layer validated alone).
    if (
      val.manual_expert_max_corpus != null &&
      val.manual_expert_full_corpus_cap != null &&
      val.manual_expert_max_corpus < val.manual_expert_full_corpus_cap
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['manual_expert_max_corpus'],
        message: 'manual_expert_max_corpus must be >= manual_expert_full_corpus_cap',
      });
    }
  });

/**
 * Subset of keys persisted on org_insight_defaults (03 §13). Org defaults are all
 * nullable — a null clears the org-level override so surveys fall through to the
 * platform constant.
 */
const ORG_DEFAULT_KEYS = [
  'automated_insights_enabled',
  'automated_report_generation_enabled',
  'stream_response_threshold',
  'prior_checkpoint_lookback',
  'refresh_lookback_days',
  'refresh_min_response_count',
  'refresh_daily_limit',
  'manual_daily_run_limit',
  'manual_expert_checkpoint_lookback',
  'manual_expert_full_corpus_cap',
  'manual_expert_max_corpus',
  'custom_analysis_enabled',
  'custom_analysis_daily_limit',
  'credit_cost_automated_checkpoint',
  'credit_cost_automated_report',
  'credit_cost_refresh',
  'credit_cost_manual_quick',
  'credit_cost_manual_expert',
] as const;

const orgDefaultFields = Object.fromEntries(
  ORG_DEFAULT_KEYS.map((k) => {
    const base = settingFields[k as keyof typeof settingFields];
    // Booleans / ints become nullable so an org admin can clear an override.
    return [k, base.nullable()];
  }),
) as { [K in (typeof ORG_DEFAULT_KEYS)[number]]: z.ZodNullable<(typeof settingFields)[K]> };

// Tag Report (TRACKER.md §1 Task 11) — max_surveys_per_tag_report lives on
// org_insight_defaults (DESIGN.md Appendix A.1.4) but is kept OUT of
// ORG_DEFAULT_KEYS/settingFields above deliberately: that shared array mirrors
// keys that ALSO exist on survey_insight_settings (settingFields is reused for
// both schemas, and INSIGHT_SETTING_KEYS drives SETTINGS_COLUMNS against the
// survey_insight_settings table in routes/insights.ts). max_surveys_per_tag_report
// has no survey-level equivalent — it is a tag-report-only, org-level cap — so
// forcing it into that shared list would leak a nonexistent column into the
// survey-settings SELECT/UPSERT. It is added as a standalone, independently
// validated field instead.
const maxSurveysPerTagReport = intRange(1, 20).nullable();

export const updateOrgInsightDefaultsSchema = z
  .object(orgDefaultFields)
  .extend({ max_surveys_per_tag_report: maxSurveysPerTagReport })
  .partial()
  .strict();

export type UpdateInsightSettingsInput = z.infer<typeof updateInsightSettingsSchema>;
export type UpdateOrgInsightDefaultsInput = z.infer<typeof updateOrgInsightDefaultsSchema>;

/**
 * Setting keys persisted on org_insight_defaults (used by the org-defaults
 * route for both GET response shaping and PATCH's dynamic UPSERT). Includes
 * `max_surveys_per_tag_report` (Tag Report, org_insight_defaults-only — see note
 * above) alongside the keys mirrored from survey-level settings.
 */
export const ORG_INSIGHT_DEFAULT_KEYS = [...ORG_DEFAULT_KEYS, 'max_surveys_per_tag_report'] as const;
