/**
 * Survey Tags API. Mounted at /api/tags.
 *
 * Provides org-scoped tag CRUD plus survey-tag mapping endpoints.
 * Tags are used to group related surveys for cross-survey AI insights.
 *
 *   GET    /api/survey-tags                          — list all org tags with survey_count
 *   POST   /api/survey-tags                          — create tag { name, color?, description? }
 *   PATCH  /api/survey-tags/:id                      — update tag
 *   DELETE /api/survey-tags/:id                      — delete tag (cascades mappings via FK)
 *   GET    /api/survey-tags/:id/surveys              — surveys with this tag (with response counts)
 *   GET    /api/survey-tags/:id/latest-report        — latest completed group insight run for tag
 *
 *   Tag Report (docs/tag-report/DESIGN.md + TRACKER.md §1 Task 9/10):
 *   GET    /api/survey-tags/:id/report-config        — effective + raw max-surveys config
 *   PATCH  /api/survey-tags/:id/report-config        — set/clear the tag's max_surveys_override
 *   GET    /api/survey-tags/:id/tag-report-history   — paginated run history across all 3 modes
 *
 *   Survey-tag mappings (mounted at /api/surveys in surveys.ts):
 *   POST   /api/surveys/:surveyId/tags                — add tags to survey { tag_ids: string[] }
 *   DELETE /api/surveys/:surveyId/tags/:tagId         — remove tag from survey
 */
import express from 'express';
import type { Request, Response } from 'express';
import { query } from '../lib/db';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/requireRole';
import { serverError } from '../lib/httpError';
import logger from '../lib/logger';
import { getOrgScopedTag, resolveEffectiveMaxSurveys } from '../lib/tagReportSelection';

const router = express.Router();

const ORG_TAG_LIMIT = 50;

// ── Slug generation helpers ───────────────────────────────────────────────────

/**
 * Convert a tag name to a URL-safe slug.
 */
function nameToSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Generate a unique slug within an org, appending -2, -3, etc. if needed.
 */
async function generateUniqueSlug(name: string, orgId: string, excludeId: string | null = null): Promise<string> {
  const base = nameToSlug(name) || 'tag';
  let slug = base;
  let counter = 2;

  while (true) {
    const params: unknown[] = [slug, orgId];
    let sql = 'SELECT 1 FROM survey_tags WHERE slug = $1 AND org_id = $2';
    if (excludeId) {
      sql += ' AND id != $3';
      params.push(excludeId);
    }
    const { rows } = await query(sql, params);
    if (!rows.length) return slug;
    slug = `${base}-${counter++}`;
  }
}

// ── GET /api/tags — list all org tags ────────────────────────────────────────

router.get('/', requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const { rows } = await query(
      `SELECT t.id, t.name, t.slug, t.color, t.description, t.program_config, t.created_at,
              COUNT(m.survey_id)::int AS survey_count
       FROM survey_tags t
       LEFT JOIN survey_tag_mappings m ON m.tag_id = t.id AND m.org_id = t.org_id
       WHERE t.org_id = $1
       GROUP BY t.id
       ORDER BY t.name ASC`,
      [req.orgId]
    );
    res.json({ tags: rows });
  } catch (err: unknown) {
    logger.error({ err: (err as Error).message, orgId: req.orgId }, 'tags:list:error');
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

// ── POST /api/tags — create a tag ─────────────────────────────────────────────

router.post('/', requireAuth, requireRole('analyst'), async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, color, description } = req.body as Record<string, unknown>;

    if (!name || typeof name !== 'string' || !(name as string).trim()) {
      res.status(400).json({ error: 'name is required' });
      return;
    }

    // Enforce org tag limit
    const { rows: [countRow] } = await query(
      'SELECT COUNT(*)::int AS cnt FROM survey_tags WHERE org_id = $1',
      [req.orgId]
    );
    if ((countRow as { cnt: number }).cnt >= ORG_TAG_LIMIT) {
      res.status(400).json({ error: 'Tag limit reached' });
      return;
    }

    const trimmedName = (name as string).trim();
    const slug = await generateUniqueSlug(trimmedName, req.orgId);

    const { rows } = await query(
      `INSERT INTO survey_tags (org_id, name, slug, color, description, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, slug, color, description, program_config, created_at`,
      [req.orgId, trimmedName, slug, color || null, description || null, req.userId]
    );

    logger.info({ orgId: req.orgId, tagId: (rows[0] as { id: string }).id, name: trimmedName }, 'tags:created');
    res.status(201).json({ tag: { ...rows[0], survey_count: 0 } });
  } catch (err: unknown) {
    const e = err as { code?: string; message?: string };
    if (e.code === '23505') {
      res.status(409).json({ error: 'A tag with that name already exists' });
      return;
    }
    logger.error({ err: e.message, orgId: req.orgId }, 'tags:create:error');
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

// ── PATCH /api/survey-tags/:id — update a tag (also accepts PUT) ─────────────

router.patch('/:id', requireAuth, requireRole('analyst'), async (req: Request, res: Response): Promise<void> => {
  return updateTagHandler(req, res);
});
router.put('/:id', requireAuth, requireRole('analyst'), async (req: Request, res: Response): Promise<void> => {
  return updateTagHandler(req, res);
});

async function updateTagHandler(req: Request, res: Response): Promise<void> {
  try {
    const { name, color, description, program_config } = req.body as Record<string, unknown>;
    const tagId = req.params.id;

    // Verify tag belongs to this org
    const { rows: [existing] } = await query(
      'SELECT id, name FROM survey_tags WHERE id = $1 AND org_id = $2',
      [tagId, req.orgId]
    );
    if (!existing) { res.status(404).json({ error: 'Tag not found' }); return; }

    const sets: string[] = ['updated_at = NOW()'];
    const vals: unknown[] = [];
    let i = 1;

    if (name !== undefined) {
      const trimmedName = (name as string).trim();
      if (!trimmedName) { res.status(400).json({ error: 'name cannot be empty' }); return; }
      const slug = await generateUniqueSlug(trimmedName, req.orgId, tagId);
      sets.push(`name = $${i++}`, `slug = $${i++}`);
      vals.push(trimmedName, slug);
    }
    if (color       !== undefined) { sets.push(`color = $${i++}`);          vals.push(color); }
    if (description !== undefined) { sets.push(`description = $${i++}`);    vals.push(description); }
    if (program_config !== undefined) { sets.push(`program_config = $${i++}`); vals.push(JSON.stringify(program_config)); }

    vals.push(tagId, req.orgId);
    const { rows } = await query(
      `UPDATE survey_tags SET ${sets.join(', ')}
       WHERE id = $${i++} AND org_id = $${i}
       RETURNING id, name, slug, color, description, program_config, created_at`,
      vals
    );

    if (!rows.length) { res.status(404).json({ error: 'Tag not found' }); return; }

    logger.info({ orgId: req.orgId, tagId }, 'tags:updated');
    res.json({ tag: rows[0] });
  } catch (err: unknown) {
    const e = err as { code?: string; message?: string };
    if (e.code === '23505') {
      res.status(409).json({ error: 'A tag with that name already exists' });
      return;
    }
    logger.error({ err: e.message, orgId: req.orgId, tagId: req.params.id }, 'tags:update:error');
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
}

// ── DELETE /api/survey-tags/:id — delete a tag ───────────────────────────────

router.delete('/:id', requireAuth, requireRole('analyst'), async (req: Request, res: Response): Promise<void> => {
  try {
    const { rowCount } = await query(
      'DELETE FROM survey_tags WHERE id = $1 AND org_id = $2',
      [req.params.id, req.orgId]
    );
    if (!rowCount) { res.status(404).json({ error: 'Tag not found' }); return; }

    logger.info({ orgId: req.orgId, tagId: req.params.id }, 'tags:deleted');
    res.json({ success: true });
  } catch (err: unknown) {
    logger.error({ err: (err as Error).message, orgId: req.orgId, tagId: req.params.id }, 'tags:delete:error');
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

// ── GET /api/tags/:id/surveys — surveys with this tag ────────────────────────

router.get('/:id/surveys', requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    // Verify tag belongs to this org
    const { rows: [tag] } = await query(
      'SELECT id FROM survey_tags WHERE id = $1 AND org_id = $2',
      [req.params.id, req.orgId]
    );
    if (!tag) { res.status(404).json({ error: 'Tag not found' }); return; }

    const { rows } = await query(
      `SELECT s.id, s.title, s.status, s.survey_type_id, s.created_at,
              COUNT(r.id)::int AS response_count
       FROM survey_tag_mappings m
       JOIN surveys s ON s.id = m.survey_id
       LEFT JOIN responses r ON r.survey_id = s.id
       WHERE m.tag_id = $1 AND m.org_id = $2 AND s.deleted_at IS NULL
       GROUP BY s.id
       ORDER BY s.updated_at DESC`,
      [req.params.id, req.orgId]
    );
    res.json({ surveys: rows });
  } catch (err: unknown) {
    logger.error({ err: (err as Error).message, orgId: req.orgId, tagId: req.params.id }, 'tags:surveys:error');
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

// ── GET /api/survey-tags/:id/latest-report — most recent group run for this tag

router.get('/:id/latest-report', requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const { rows: [tag] } = await query(
      'SELECT id, name, slug, color FROM survey_tags WHERE id = $1 AND org_id = $2',
      [req.params.id, req.orgId]
    );
    if (!tag) { res.status(404).json({ error: 'Tag not found' }); return; }

    // UUID array containment: check if tag_ids array contains this tag id
    const { rows } = await query(
      `SELECT id, status, tag_ids, survey_ids, created_at, completed_at
       FROM group_insight_runs
       WHERE org_id = $1 AND status = 'completed' AND $2::uuid = ANY(tag_ids)
       ORDER BY completed_at DESC
       LIMIT 1`,
      [req.orgId, req.params.id]
    );

    if (!rows.length) { res.status(404).json({ error: 'No completed report found for this tag' }); return; }

    const run = rows[0] as { id: string };
    const { rows: insights } = await query(
      `SELECT * FROM group_insights WHERE run_id = $1 AND org_id = $2
       ORDER BY priority DESC NULLS LAST`,
      [run.id, req.orgId]
    ).catch(() => ({ rows: [] }));

    res.json({ tag, run, insights });
  } catch (err: unknown) {
    logger.error({ err: (err as Error).message, orgId: req.orgId, tagId: req.params.id }, 'tags:latest_report:error');
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

// ── Tag Report — report-config + history (TRACKER.md §1 Tasks 9/10) ──────────

// GET /api/survey-tags/:id/report-config — effective + raw max-surveys config
router.get('/:id/report-config', requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const tag = await getOrgScopedTag(req.params.id, req.orgId);
    if (!tag) { res.status(404).json({ error: 'Tag not found' }); return; }

    const { rows } = await query(
      'SELECT max_surveys_override FROM survey_tags WHERE id = $1 AND org_id = $2',
      [req.params.id, req.orgId],
    );
    const rawOverride = (rows[0] as { max_surveys_override: number | null } | undefined)?.max_surveys_override ?? null;
    const effectiveMaxSurveys = await resolveEffectiveMaxSurveys(req.params.id, req.orgId);

    res.json({
      tag_id: req.params.id,
      max_surveys_override: rawOverride,
      effective_max_surveys: effectiveMaxSurveys,
    });
  } catch (err: unknown) {
    logger.error({ err: (err as Error).message, orgId: req.orgId, tagId: req.params.id }, 'tags:report_config:get:error');
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

// PATCH /api/survey-tags/:id/report-config — set/clear max_surveys_override
router.patch('/:id/report-config', requireAuth, requireRole('analyst'), async (req: Request, res: Response): Promise<void> => {
  try {
    const { max_surveys_override } = req.body as Record<string, unknown>;
    if (
      max_surveys_override !== null
      && (typeof max_surveys_override !== 'number'
        || !Number.isInteger(max_surveys_override)
        || max_surveys_override < 1
        || max_surveys_override > 20)
    ) {
      res.status(400).json({ error: 'max_surveys_override must be an integer between 1 and 20, or null' });
      return;
    }

    const { rows } = await query(
      `UPDATE survey_tags SET max_surveys_override = $1, updated_at = NOW()
       WHERE id = $2 AND org_id = $3
       RETURNING id, max_surveys_override`,
      [max_surveys_override, req.params.id, req.orgId],
    );
    if (!rows.length) { res.status(404).json({ error: 'Tag not found' }); return; }

    const effectiveMaxSurveys = await resolveEffectiveMaxSurveys(req.params.id, req.orgId);
    logger.info({ orgId: req.orgId, tagId: req.params.id, max_surveys_override }, 'tags:report_config:patched');
    res.json({
      tag_id: req.params.id,
      max_surveys_override: (rows[0] as { max_surveys_override: number | null }).max_surveys_override,
      effective_max_surveys: effectiveMaxSurveys,
    });
  } catch (err: unknown) {
    logger.error({ err: (err as Error).message, orgId: req.orgId, tagId: req.params.id }, 'tags:report_config:patch:error');
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

// GET /api/survey-tags/:id/tag-report-history — paginated run history, all 3 modes
router.get('/:id/tag-report-history', requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const { rows: tagRows } = await query(
      'SELECT id FROM survey_tags WHERE id = $1 AND org_id = $2',
      [req.params.id, req.orgId],
    );
    if (!tagRows.length) { res.status(404).json({ error: 'Tag not found' }); return; }

    const limitParam = parseInt(String(req.query.limit ?? '20'), 10);
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 100) : 20;
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : null;

    const params: unknown[] = [req.orgId, req.params.id];
    let cursorClause = '';
    if (cursor) {
      params.push(cursor);
      cursorClause = `AND r.created_at < (SELECT created_at FROM group_insight_runs WHERE id = $${params.length} AND org_id = $1)`;
    }
    params.push(limit);

    // Fixed 2026-07-03 (customer-journey review finding, severe): this row
    // shape previously used `id` and never included `metric_tracks_narrated` —
    // a hard mismatch against the frontend's TagReportTrailEntry contract
    // (`run_id` + `metric_tracks_narrated`), which crashed the Trail page's
    // run-history list on every visit. Aliased to match, and the metric count
    // is a real per-run aggregate off `group_insights` (one row per published
    // metric track), not a placeholder.
    const { rows } = await query(
      `SELECT r.id AS run_id, r.run_mode, r.trigger, r.status, r.window_start, r.window_end,
              r.parent_run_id, r.created_at, r.completed_at,
              COALESCE(gi.metric_tracks_narrated, 0)::int AS metric_tracks_narrated
       FROM group_insight_runs r
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS metric_tracks_narrated FROM group_insights WHERE run_id = r.id
       ) gi ON true
       WHERE r.org_id = $1 AND r.tag_ids @> ARRAY[$2]::uuid[] ${cursorClause}
       ORDER BY r.created_at DESC
       LIMIT $${params.length}`,
      params,
    );

    const nextCursor = rows.length === limit ? (rows[rows.length - 1] as { run_id: string }).run_id : null;
    res.json({ runs: rows, next_cursor: nextCursor });
  } catch (err: unknown) {
    logger.error({ err: (err as Error).message, orgId: req.orgId, tagId: req.params.id }, 'tags:tag_report_history:error');
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

export default router;
