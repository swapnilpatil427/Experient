import express from 'express';
import type { Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { validate } from '../lib/validate';
import { submitResponseSchema } from '../schemas/responses';
import { responseSubmitLimiter } from '../middleware/rateLimiter';
import { query, pool } from '../lib/db';
import { serverError } from '../lib/httpError';
import { maybeAutoAnalyze } from '../triggers/autoAnalyze';
import { responsesSubmitted } from '../lib/metrics';
import { publishResponseEvent } from '../lib/redisStream';
import { publishNotificationEvent } from '../lib/notificationEvents';
import { triggerInsightGeneration } from '../lib/agentsClient';
import logger from '../lib/logger';

const router = express.Router();

// Response-count milestones that emit a notification to the survey owner.
const RESPONSE_MILESTONES = [25, 50, 100, 500, 1000];

async function maybeEmitResponseMilestone(surveyId: string, orgId: string): Promise<void> {
  try {
    const { rows: [{ count }] } = await query(
      'SELECT COUNT(*)::int AS count FROM responses WHERE survey_id = $1', [surveyId]
    );
    if (!RESPONSE_MILESTONES.includes(count as number)) return;
    const { rows: [s] } = await query(
      'SELECT title, created_by FROM surveys WHERE id = $1 AND org_id = $2', [surveyId, orgId]
    );
    if (!s) return;
    const sRow = s as { title: string; created_by: string | null };
    await publishNotificationEvent({
      type: 'survey.milestone', orgId,
      priority: (count as number) >= 500 ? 'success' : 'info',
      targetUserIds: sRow.created_by ? [sRow.created_by] : [],
      entityType: 'survey', entityId: surveyId,
      title: `"${sRow.title}" reached ${count} responses`,
      actionUrl: `/app/surveys/${surveyId}/responses`,
      payload: { milestone: count },
      dedupWindowMs: 24 * 60 * 60 * 1000,
    });
  } catch { /* never affect response submission */ }
}

// Pagination defaults — adjust here if org-level settings are added later.
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE     = 200;

// Ensure a composite index exists for efficient paginated queries.
// Runs once on startup; safe to call repeatedly (IF NOT EXISTS).
async function ensureIndexes(): Promise<void> {
  await query(`
    CREATE INDEX IF NOT EXISTS responses_survey_submitted
      ON responses (survey_id, submitted_at DESC)
  `).catch(() => {});
}
ensureIndexes().catch(err => logger.error({ err: (err as Error).message }, 'responses:ensureIndexes failed'));

// ── Device / metadata helpers (no external packages) ─────────────────────────

function _getIp(req: Request): string | null {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return (Array.isArray(forwarded) ? forwarded[0] : forwarded).split(',')[0].trim();
  return req.ip || null;
}

function _parseDevice(ua: string | undefined): { device_type: string | null; browser: string | null; os: string | null } {
  if (!ua) return { device_type: null, browser: null, os: null };
  const s = ua.toLowerCase();

  let device_type = 'desktop';
  if (/\b(tablet|ipad)\b/.test(s))                         device_type = 'tablet';
  else if (/\b(mobile|android|iphone|ipod|blackberry|windows phone)\b/.test(s)) device_type = 'mobile';
  else if (/\bbot|crawl|spider|slurp|facebookexternalhit\b/.test(s)) device_type = 'bot';

  let browser = 'Other';
  if (/edg\//.test(s))          browser = 'Edge';
  else if (/opr\/|opera/.test(s)) browser = 'Opera';
  else if (/chrome\//.test(s))  browser = 'Chrome';
  else if (/firefox\//.test(s)) browser = 'Firefox';
  else if (/safari\//.test(s))  browser = 'Safari';

  let os = 'Other';
  if (/windows nt/.test(s))    os = 'Windows';
  else if (/mac os x/.test(s)) os = 'macOS';
  else if (/android/.test(s))  os = 'Android';
  else if (/iphone|ipad|ipod/.test(s)) os = 'iOS';
  else if (/linux/.test(s))    os = 'Linux';

  return { device_type, browser, os };
}

router.post('/:surveyId/responses', responseSubmitLimiter, validate(submitResponseSchema), async (req: Request, res: Response): Promise<void> => {
  const { surveyId } = req.params;
  const { answers, publishToken, started_at } = req.body as { answers: Record<string, unknown>[]; publishToken: string; started_at?: string };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the survey row for the duration of the transaction so concurrent submissions
    // can't both pass the max_responses check and both insert.
    const { rows: [survey] } = await client.query(
      `SELECT id, org_id, max_responses, auto_close_at, allow_multiple_responses
       FROM surveys
       WHERE id = $1 AND publish_token = $2 AND status = 'active'
       FOR UPDATE`,
      [surveyId, publishToken]
    );
    if (!survey) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Survey not found or not active' });
      return;
    }

    const surveyRow = survey as Record<string, unknown>;

    // Check auto_close_at
    if (surveyRow.auto_close_at && new Date(surveyRow.auto_close_at as string) < new Date()) {
      await client.query(`UPDATE surveys SET status='closed', closed_at=NOW() WHERE id=$1`, [surveyRow.id]);
      await client.query('COMMIT');
      res.status(410).json({ error: 'This survey has closed.' });
      return;
    }

    // Check max_responses — count inside the same transaction so the lock is honoured
    if (surveyRow.max_responses) {
      const { rows: [{ count }] } = await client.query(
        'SELECT COUNT(*)::int AS count FROM responses WHERE survey_id = $1',
        [surveyId]
      );
      if ((count as number) >= (surveyRow.max_responses as number)) {
        await client.query(`UPDATE surveys SET status='closed', closed_at=NOW() WHERE id=$1`, [surveyRow.id]);
        await client.query('COMMIT');
        res.status(410).json({ error: 'This survey has reached its response limit.' });
        return;
      }
    }

    const npsAnswer = answers.find((a) => a.type === 'nps');
    const npsScore  = npsAnswer ? parseInt(String(npsAnswer.value), 10) : null;

    const ip        = _getIp(req);
    const userAgent = req.headers['user-agent'] || null;
    const country   = (req.headers['cf-ipcountry'] || req.headers['x-country-code'] || null) as string | null;
    const city      = (req.headers['cf-ipcity']    || null) as string | null;
    const referrer  = ((req.headers['referer'] || req.headers['referrer'] || null)) as string | null;
    const { device_type, browser, os } = _parseDevice(userAgent ?? undefined);
    const completionTimeS = started_at
      ? Math.max(0, Math.round((Date.now() - new Date(started_at).getTime()) / 1000))
      : null;

    const { rows: [response] } = await client.query(
      `INSERT INTO responses
         (survey_id, org_id, answers, nps_score,
          ip_address, user_agent, country, city, device_type, browser, os, referrer, completion_time_s)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING id`,
      [
        surveyRow.id, surveyRow.org_id, JSON.stringify(answers), npsScore,
        ip, userAgent, country, city, device_type, browser, os, referrer, completionTimeS,
      ]
    );

    await client.query('COMMIT');
    responsesSubmitted.inc();

    const respRow = response as { id: string };
    if (process.env.REDIS_URL) {
      publishResponseEvent({ surveyId: surveyRow.id as string, orgId: surveyRow.org_id as string, responseId: respRow.id })
        .catch(() => {});
      maybeEmitResponseMilestone(surveyRow.id as string, surveyRow.org_id as string); // fire-and-forget
    } else {
      maybeAutoAnalyze(surveyRow.id as string, surveyRow.org_id as string).catch(() => {});
    }

    res.status(201).json({ success: true, id: respRow.id });
  } catch (err: unknown) {
    await client.query('ROLLBACK').catch(() => {});
    serverError(res, err instanceof Error ? err : new Error(String(err)), { route: 'POST /surveys/:surveyId/responses' });
  } finally {
    client.release();
  }
});

// ── POST /:surveyId/responses/bulk ─────────────────────────────────────────────
// Authenticated endpoint for importing multiple responses at once.
// Inserts all rows in a single DB transaction, then triggers insight generation once.
// Body: { responses: [{ answers, nps_score?, started_at? }] }
// Returns: { inserted, skipped, run_id }

router.post('/:surveyId/responses/bulk', requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const { surveyId } = req.params;
    const incoming = (req.body as { responses?: unknown[] }).responses;

    if (!Array.isArray(incoming) || incoming.length === 0) {
      res.status(400).json({ error: '`responses` must be a non-empty array' });
      return;
    }
    if (incoming.length > 5000) {
      res.status(400).json({ error: 'Maximum 5000 responses per bulk import' });
      return;
    }

    const { rows: [survey] } = await query(
      `SELECT id, org_id FROM surveys WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`,
      [surveyId, req.orgId],
    );
    if (!survey) { res.status(404).json({ error: 'Survey not found' }); return; }

    const surveyRow = survey as { id: string; org_id: string };
    const client = await pool.connect();
    let inserted = 0;
    let skipped  = 0;
    try {
      await client.query('BEGIN');
      for (const item of incoming) {
        const it = item as { answers?: unknown[]; nps_score?: unknown; started_at?: string };
        const { answers, nps_score, started_at } = it;
        if (!Array.isArray(answers)) { skipped++; continue; }

        const npsAnswer = (answers as Record<string, unknown>[]).find(a => a.type === 'nps');
        const npsScore  = nps_score != null ? parseInt(String(nps_score), 10) : (npsAnswer ? parseInt(String(npsAnswer.value), 10) : null);
        const completionTimeS = started_at
          ? Math.max(0, Math.round((Date.now() - new Date(started_at).getTime()) / 1000))
          : null;

        await client.query(
          `INSERT INTO responses (survey_id, org_id, answers, nps_score, completion_time_s)
           VALUES ($1, $2, $3, $4, $5)`,
          [surveyRow.id, surveyRow.org_id, JSON.stringify(answers), npsScore, completionTimeS],
        );
        inserted++;
      }
      await client.query('COMMIT');
    } catch (err: unknown) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    responsesSubmitted.inc(inserted);

    // Trigger insight generation once for the whole batch.
    let runId: string | null = null;
    try {
      await query(
        `UPDATE agent_runs SET status='cancelled', completed_at=NOW()
         WHERE survey_id=$1 AND org_id=$2 AND run_type='insight_generation'
           AND status='running'`,
        [surveyId, surveyRow.org_id],
      );
      const threadId = `insight:${surveyRow.org_id}:${surveyId}:bulk:${Date.now()}`;
      const { rows } = await query(
        `INSERT INTO agent_runs
           (org_id, user_id, thread_id, run_type, status, intent, survey_id)
         VALUES ($1,$2,$3,'insight_generation','running','insight:bulk_import',$4)
         RETURNING id`,
        [surveyRow.org_id, req.userId, threadId, surveyId],
      );
      runId = (rows[0] as { id: string }).id;
      triggerInsightGeneration({ surveyId, orgId: surveyRow.org_id, runId, trigger: 'bulk_import' })
        .catch(() => {
          query("UPDATE agent_runs SET status='failed', completed_at=NOW() WHERE id=$1", [runId]).catch(() => {});
        });
    } catch {
      // Insight trigger is best-effort — bulk insert already succeeded
    }

    res.status(201).json({ inserted, skipped, run_id: runId });
  } catch (err: unknown) {
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

// ── Get responses — authenticated, paginated with search/filter ──────────────
// Query params: ?limit=50&offset=0&search=text&sentiment=positive&nps_min=0&nps_max=10&date_from=...&date_to=...
router.get('/:surveyId/responses', requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const q = req.query as Record<string, string | undefined>;
    const limit   = Math.min(Math.max(1, parseInt(q.limit  ?? String(DEFAULT_PAGE_SIZE), 10)), MAX_PAGE_SIZE);
    const offset  = Math.max(0, parseInt(q.offset ?? '0', 10));
    const search    = (q.search    ?? '').trim();
    const sentiment = (q.sentiment ?? '').trim();
    const emotion   = (q.emotion   ?? '').trim();
    const npsMin    = q.nps_min !== undefined ? parseInt(q.nps_min, 10) : null;
    const npsMax    = q.nps_max !== undefined ? parseInt(q.nps_max, 10) : null;
    const dateFrom  = (q.date_from ?? '').trim();
    const dateTo    = (q.date_to   ?? '').trim();

    // Build parameterized WHERE — shared by count and data queries
    const filterParams: unknown[] = [req.params.surveyId, req.orgId];
    let where = 'WHERE survey_id = $1 AND org_id = $2';

    if (search) {
      filterParams.push(`%${search}%`);
      where += ` AND answers::text ILIKE $${filterParams.length}`;
    }
    if (sentiment) {
      filterParams.push(sentiment);
      where += ` AND ai_sentiment = $${filterParams.length}`;
    }
    if (emotion) {
      filterParams.push(emotion);
      where += ` AND ai_emotion = $${filterParams.length}`;
    }
    if (npsMin !== null && !isNaN(npsMin)) {
      filterParams.push(npsMin);
      where += ` AND nps_score >= $${filterParams.length}`;
    }
    if (npsMax !== null && !isNaN(npsMax)) {
      filterParams.push(npsMax);
      where += ` AND nps_score <= $${filterParams.length}`;
    }
    if (dateFrom) {
      filterParams.push(dateFrom);
      where += ` AND submitted_at >= $${filterParams.length}`;
    }
    if (dateTo) {
      filterParams.push(dateTo);
      where += ` AND submitted_at <= $${filterParams.length}`;
    }

    const limitIdx  = filterParams.length + 1;
    const offsetIdx = filterParams.length + 2;

    const [countRes, rowsRes] = await Promise.all([
      query(
        `SELECT COUNT(*)::int AS total FROM responses ${where}`,
        filterParams
      ),
      query(
        `SELECT * FROM responses ${where} ORDER BY submitted_at DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
        [...filterParams, limit, offset]
      ),
    ]);

    const total = (countRes.rows[0] as { total: number }).total;
    res.json({
      responses: rowsRes.rows,
      total,
      limit,
      offset,
      hasMore: offset + rowsRes.rows.length < total,
    });
  } catch (err: unknown) {
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

// ── GET /:surveyId/responses/:responseId ────────────────────────────────────────
// Response Detail — R-T5's audit-trail terminus (docs/tag-report/DESIGN.md), the
// page a Tag Report / single-survey insight citation ultimately drills into.
// Added 2026-07-02: this endpoint did not exist yet — the frontend page (Task 16)
// and its `api.getSurveyResponse()` caller were built against this exact contract
// in parallel, so this closes that gap rather than introducing new scope.
//
// Re-checks org/survey access on every request the same way the list route above
// does (`survey_id = $1 AND org_id = $2`, via requireAuth's req.orgId) — do NOT
// treat "user can see a Tag Report that cites this response" as sufficient
// authorization; this route enforces the survey's own normal access rule
// independently. Also guards `deleted_at IS NULL` (soft-deleted responses must
// 404, not surface). A missing/soft-deleted/wrong-org response all return an
// identical 404 — the response body must not distinguish "doesn't exist" from
// "exists but you can't see it" or "was deleted", to avoid leaking existence.
//
// Fixed 2026-07-02 (security review, Riley — HIGH, confirmed): the initial
// version only checked the RESPONSE's own deleted_at, not its parent SURVEY's.
// Soft-deleting a survey does not cascade to its responses, so without this
// join a Tag Report's frozen citation manifest (group_insights.citations_json,
// which durably stores (survey_id, response_id) pairs) was a standing path to
// read a deleted survey's verbatim response content indefinitely. Joins to
// surveys and requires deleted_at IS NULL on BOTH tables.
router.get('/:surveyId/responses/:responseId', requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const { rows } = await query(
      `SELECT r.* FROM responses r
       JOIN surveys s ON s.id = r.survey_id
       WHERE r.id = $1 AND r.survey_id = $2 AND r.org_id = $3
         AND r.deleted_at IS NULL AND s.deleted_at IS NULL`,
      [req.params.responseId, req.params.surveyId, req.orgId]
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'Response not found' });
      return;
    }
    res.json({ response: rows[0] });
  } catch (err: unknown) {
    serverError(res, err instanceof Error ? err : new Error(String(err)));
  }
});

export default router;
