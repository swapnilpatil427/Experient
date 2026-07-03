/**
 * Tag Report — backend selection helper (TRACKER.md §1 Task 5).
 *
 * Layer boundary (TRACKER.md reconciliation item 7, 2026-07-02 — supersedes any
 * earlier "recency-selection + backfill helper" description of this file's
 * scope): this module owns ONLY the three backend-side pieces of Tag Report
 * survey selection —
 *   1. validating tag ownership/org-scoping,
 *   2. a cheap "does this tag have >=1 candidate survey at all" existence check
 *      (for an early, specific 400 before a run row is even created), and
 *   3. resolving `effective_max_surveys` via the 3-tier COALESCE (tag override
 *      -> org default -> hardcoded platform fallback).
 *
 * It does NOT touch `insight_checkpoints_v2` at all, and it does NOT do
 * recency-ordered candidate fetching or backfill looping — all of that is
 * CrystalOS's `tag_report.py` graph (TRACKER.md §2), which receives the
 * already-resolved `effective_max_surveys` as its `target_n`. This mirrors the
 * existing `group_insights.py` precedent exactly: backend resolves tag ->
 * (existence + cap) and hands off; CrystalOS does all checkpoint-level work.
 *
 * Zero-fresh-AI enforcement (DESIGN.md §2.2) is true by construction here, not
 * convention: this module never imports `agentsClient` or otherwise calls
 * CrystalOS — every exported function is a pure Postgres read.
 */
import { query } from './db';

export interface TagReportTag {
  id: string;
  name: string;
  slug: string;
  color: string | null;
}

/** Platform fallback when neither a tag override nor an org default is set (DESIGN.md Appendix A.1.4). */
export const PLATFORM_MAX_SURVEYS_FALLBACK = 5;

/**
 * Look up a tag scoped to the calling org. Returns null if the tag does not
 * exist, or belongs to a different org — the caller should treat both cases
 * identically (404), never leaking cross-org existence.
 */
export async function getOrgScopedTag(tagId: string, orgId: string): Promise<TagReportTag | null> {
  const { rows } = await query<TagReportTag>(
    'SELECT id, name, slug, color FROM survey_tags WHERE id = $1 AND org_id = $2',
    [tagId, orgId],
  );
  return rows[0] ?? null;
}

/**
 * Resolve `effective_max_surveys` via the 3-tier COALESCE:
 *   survey_tags.max_surveys_override -> org_insight_defaults.max_surveys_per_tag_report
 *   -> hardcoded platform fallback (5).
 *
 * DESIGN.md Appendix A.1.4 / TRACKER.md §1 "Resolution query, fixed post-QA-review":
 * the LEFT JOIN is required, not optional — an org that has never been
 * provisioned an org_insight_defaults row AT ALL (not merely one with NULL
 * columns) must still resolve to the hardcoded default. An INNER JOIN would
 * silently return zero rows for such an org instead of falling through.
 *
 * Returns the platform fallback if the tag itself doesn't resolve (defensive —
 * callers are expected to have already validated the tag via getOrgScopedTag).
 */
export async function resolveEffectiveMaxSurveys(tagId: string, orgId: string): Promise<number> {
  const { rows } = await query<{ effective_max_surveys: number | string }>(
    `SELECT COALESCE(t.max_surveys_override, o.max_surveys_per_tag_report, $3) AS effective_max_surveys
     FROM survey_tags t
     LEFT JOIN org_insight_defaults o ON o.org_id = t.org_id
     WHERE t.id = $1 AND t.org_id = $2`,
    [tagId, orgId, PLATFORM_MAX_SURVEYS_FALLBACK],
  );
  const value = rows[0]?.effective_max_surveys;
  return value != null ? Number(value) : PLATFORM_MAX_SURVEYS_FALLBACK;
}

/**
 * Cheap existence check: does this tag have at least one non-deleted survey
 * mapped to it? This is only a fast pre-flight for an early, specific 400 —
 * CrystalOS's `fetch_next_batch` does the real (org-scoped, recency-ordered)
 * candidate fetch against the full pool.
 */
export async function tagHasAnyCandidateSurvey(tagId: string, orgId: string): Promise<boolean> {
  const { rows } = await query(
    `SELECT 1
     FROM survey_tag_mappings m
     JOIN surveys s ON s.id = m.survey_id
     WHERE m.tag_id = $1 AND m.org_id = $2 AND s.deleted_at IS NULL
     LIMIT 1`,
    [tagId, orgId],
  );
  return rows.length > 0;
}
