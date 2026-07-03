/**
 * Tests for the Tag Report endpoints added to routes/survey-groups.ts
 * (docs/tag-report/DESIGN.md + TRACKER.md §1 Tasks 6/7/8/13/18).
 *
 * POST endpoints (manual/custom-range/automated) are tested against a mocked
 * lib/tagReportRunner.ts::startTagReportRun (its own behavior is covered by
 * tagReportRunner.test.js) plus the route's own request validation / daily
 * rate-limit logic. GET endpoints exercise the route's own SQL directly against
 * a mocked db, mirroring survey-groups.test.js's conventions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import inject from 'light-my-request';
import express from 'express';

const __dirname = dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);

const AUTH_PATH        = _require.resolve(resolve(__dirname, '../middleware/auth'));
const ROLE_PATH        = _require.resolve(resolve(__dirname, '../middleware/requireRole'));
const INTERNAL_KEY_PATH = _require.resolve(resolve(__dirname, '../middleware/internalKey'));
const DB_PATH          = _require.resolve(resolve(__dirname, '../lib/db'));
const AGENTS_PATH      = _require.resolve(resolve(__dirname, '../lib/agentsClient'));
const LOGGER_PATH      = _require.resolve(resolve(__dirname, '../lib/logger'));
const RUNNER_PATH      = _require.resolve(resolve(__dirname, '../lib/tagReportRunner'));
const ROUTER_PATH      = _require.resolve(resolve(__dirname, '../routes/survey-groups'));

let dbQuery;
let generateGroupInsights;
let startTagReportRun;
let internalKeyOk;

function fakeMod(id, exports) {
  return { id, filename: id, loaded: true, exports, children: [] };
}

function buildApp() {
  _require.cache[AUTH_PATH] = fakeMod(AUTH_PATH, {
    requireAuth: (req, res, next) => { req.orgId = 'test-org'; req.userId = 'test-user'; next(); },
  });
  _require.cache[ROLE_PATH] = fakeMod(ROLE_PATH, {
    requireRole: () => (req, res, next) => next(),
  });
  _require.cache[INTERNAL_KEY_PATH] = fakeMod(INTERNAL_KEY_PATH, {
    requireInternalKey: (req, res, next) => {
      if (!internalKeyOk) { res.status(401).json({ error: 'invalid_internal_key' }); return; }
      next();
    },
  });
  _require.cache[DB_PATH] = fakeMod(DB_PATH, { query: dbQuery, default: { query: dbQuery } });
  _require.cache[AGENTS_PATH] = fakeMod(AGENTS_PATH, {
    generateGroupInsights, generateTagReport: vi.fn(async () => ({})),
    default: { generateGroupInsights },
  });
  _require.cache[LOGGER_PATH] = fakeMod(LOGGER_PATH, {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  });
  _require.cache[RUNNER_PATH] = fakeMod(RUNNER_PATH, { startTagReportRun });

  delete _require.cache[ROUTER_PATH];
  const router = _require(ROUTER_PATH);
  const app = express();
  app.use(express.json());
  app.use('/api/group-insights', router.default || router);
  return app;
}

async function api(app, method, url, body = null, headers = {}) {
  const opts = { method, url, headers };
  if (body !== null) {
    opts.payload = JSON.stringify(body);
    opts.headers = { 'content-type': 'application/json', ...headers };
  }
  const res = await inject(app, opts);
  return { status: res.statusCode, body: res.json() };
}

beforeEach(() => {
  dbQuery = vi.fn(async () => ({ rows: [{ run_count: 0 }] }));
  generateGroupInsights = vi.fn(async () => ({}));
  startTagReportRun = vi.fn(async () => ({ ok: true, runId: 'run-1', attachedToExisting: false, createdAt: '2026-07-02T00:00:00Z' }));
  internalKeyOk = true;
});

// ── POST /tag-report/manual ────────────────────────────────────────────────────

describe('POST /api/group-insights/tag-report/manual', () => {
  it('returns 202 with run_id on success', async () => {
    const { status, body } = await api(buildApp(), 'POST', '/api/group-insights/tag-report/manual', { tag_id: 'tag-1' });
    expect(status).toBe(202);
    expect(body).toMatchObject({ run_id: 'run-1', attached_to_existing: false });
    expect(startTagReportRun).toHaveBeenCalledWith({
      orgId: 'test-org', userId: 'test-user', tagId: 'tag-1', runMode: 'manual', trigger: 'manual',
    });
  });

  it('returns 400 when tag_id is missing', async () => {
    const { status, body } = await api(buildApp(), 'POST', '/api/group-insights/tag-report/manual', {});
    expect(status).toBe(400);
    expect(body.error).toMatch(/tag_id/);
    expect(startTagReportRun).not.toHaveBeenCalled();
  });

  it('propagates a 404 from startTagReportRun (tag not found)', async () => {
    startTagReportRun = vi.fn(async () => ({ ok: false, status: 404, error: 'Tag not found' }));
    const { status, body } = await api(buildApp(), 'POST', '/api/group-insights/tag-report/manual', { tag_id: 'missing' });
    expect(status).toBe(404);
    expect(body.error).toBe('Tag not found');
  });

  it('propagates a 400 from startTagReportRun (no candidate surveys)', async () => {
    startTagReportRun = vi.fn(async () => ({ ok: false, status: 400, error: 'This tag has no surveys to report on' }));
    const { status, body } = await api(buildApp(), 'POST', '/api/group-insights/tag-report/manual', { tag_id: 'tag-1' });
    expect(status).toBe(400);
    expect(body.error).toMatch(/no surveys/);
  });

  it('returns 429 RATE_LIMITED when the daily cap is reached', async () => {
    dbQuery = vi.fn(async () => ({ rows: [{ run_count: 10 }] }));
    const { status, body } = await api(buildApp(), 'POST', '/api/group-insights/tag-report/manual', { tag_id: 'tag-1' });
    expect(status).toBe(429);
    expect(body.code).toBe('RATE_LIMITED');
    expect(startTagReportRun).not.toHaveBeenCalled();
  });

  it('returns 500 when startTagReportRun throws unexpectedly', async () => {
    startTagReportRun = vi.fn(async () => { throw new Error('db down'); });
    const { status } = await api(buildApp(), 'POST', '/api/group-insights/tag-report/manual', { tag_id: 'tag-1' });
    expect(status).toBe(500);
  });
});

// ── POST /tag-report/custom-range ──────────────────────────────────────────────

describe('POST /api/group-insights/tag-report/custom-range', () => {
  const validBody = { tag_id: 'tag-1', window_start: '2026-01-01T00:00:00Z', window_end: '2026-02-01T00:00:00Z' };

  it('returns 202 with run_id on success', async () => {
    const { status, body } = await api(buildApp(), 'POST', '/api/group-insights/tag-report/custom-range', validBody);
    expect(status).toBe(202);
    expect(body).toMatchObject({ run_id: 'run-1' });
    expect(startTagReportRun).toHaveBeenCalledWith({
      orgId: 'test-org', userId: 'test-user', tagId: 'tag-1', runMode: 'custom_range', trigger: 'manual',
      windowStart: '2026-01-01T00:00:00Z', windowEnd: '2026-02-01T00:00:00Z',
    });
  });

  it('returns 400 when tag_id is missing', async () => {
    const { status, body } = await api(buildApp(), 'POST', '/api/group-insights/tag-report/custom-range', {
      window_start: '2026-01-01T00:00:00Z', window_end: '2026-02-01T00:00:00Z',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/tag_id/);
  });

  it('returns 400 when window_start/window_end are missing or not valid dates', async () => {
    const { status, body } = await api(buildApp(), 'POST', '/api/group-insights/tag-report/custom-range', {
      tag_id: 'tag-1', window_start: 'not-a-date', window_end: '2026-02-01T00:00:00Z',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/ISO timestamp/);
  });

  it('returns 400 when window_end is not after window_start', async () => {
    const { status, body } = await api(buildApp(), 'POST', '/api/group-insights/tag-report/custom-range', {
      tag_id: 'tag-1', window_start: '2026-02-01T00:00:00Z', window_end: '2026-01-01T00:00:00Z',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/window_end must be after/);
  });

  it('returns 429 RATE_LIMITED when the daily cap is reached', async () => {
    dbQuery = vi.fn(async () => ({ rows: [{ run_count: 10 }] }));
    const { status, body } = await api(buildApp(), 'POST', '/api/group-insights/tag-report/custom-range', validBody);
    expect(status).toBe(429);
    expect(body.code).toBe('RATE_LIMITED');
  });
});

// ── POST /tag-report/automated (internal-only) ────────────────────────────────

describe('POST /api/group-insights/tag-report/automated', () => {
  it('returns 401 without a valid X-Internal-Key', async () => {
    internalKeyOk = false;
    const { status } = await api(buildApp(), 'POST', '/api/group-insights/tag-report/automated', { org_id: 'org-1', tag_id: 'tag-1' });
    expect(status).toBe(401);
    expect(startTagReportRun).not.toHaveBeenCalled();
  });

  it('returns 202 with run_id when internally authenticated, using org_id from the body (no Clerk session)', async () => {
    const { status, body } = await api(buildApp(), 'POST', '/api/group-insights/tag-report/automated', { org_id: 'org-9', tag_id: 'tag-9' });
    expect(status).toBe(202);
    expect(body).toMatchObject({ run_id: 'run-1' });
    expect(startTagReportRun).toHaveBeenCalledWith({
      orgId: 'org-9', userId: null, tagId: 'tag-9', runMode: 'automated', trigger: 'scheduled',
    });
  });

  it('returns 400 when org_id is missing', async () => {
    const { status, body } = await api(buildApp(), 'POST', '/api/group-insights/tag-report/automated', { tag_id: 'tag-1' });
    expect(status).toBe(400);
    expect(body.error).toMatch(/org_id/);
  });

  it('is not gated by the daily manual/custom-range rate limit (no DB call to check it)', async () => {
    // No dailyLimit-shaped query should be issued for the automated path.
    const seenSql = [];
    dbQuery = vi.fn(async (sql) => { seenSql.push(sql); return { rows: [] }; });
    await api(buildApp(), 'POST', '/api/group-insights/tag-report/automated', { org_id: 'org-1', tag_id: 'tag-1' });
    expect(seenSql.some((s) => s.includes("run_mode IN ('manual', 'custom_range')"))).toBe(false);
  });
});

// ── GET /tag-report/:runId ──────────────────────────────────────────────────────

describe('GET /api/group-insights/tag-report/:runId', () => {
  it('returns run + sources + insights partitioned by metric_key', async () => {
    dbQuery = vi.fn(async (sql) => {
      if (sql.includes('FROM group_insight_runs')) {
        return { rows: [{ id: 'run-1', tag_ids: ['tag-1'], run_mode: 'manual', status: 'completed' }] };
      }
      if (sql.includes('FROM group_insight_run_sources')) {
        return { rows: [{ id: 'src-1', survey_id: 's1', survey_title: 'Survey 1', checkpoint_id: 'ckpt-1' }] };
      }
      if (sql.includes('FROM group_insights')) {
        return {
          rows: [
            { id: 'gi-1', metric_key: 'nps', headline: 'NPS up', priority: 2 },
            { id: 'gi-2', metric_key: 'csat', headline: 'CSAT stable', priority: 1 },
            { id: 'gi-3', metric_key: null, headline: 'Legacy unpartitioned', priority: 1 },
          ],
        };
      }
      return { rows: [] };
    });
    const { status, body } = await api(buildApp(), 'GET', '/api/group-insights/tag-report/run-1');
    expect(status).toBe(200);
    expect(body.run).toMatchObject({ id: 'run-1' });
    expect(body.sources).toHaveLength(1);
    expect(body.insights).toHaveLength(3);
    expect(body.insights_by_metric.nps).toHaveLength(1);
    expect(body.insights_by_metric.csat).toHaveLength(1);
    expect(body.insights_by_metric.unpartitioned).toHaveLength(1);
  });

  it('returns 404 when the run does not exist / is not org-scoped', async () => {
    dbQuery = vi.fn(async (sql) => (sql.includes('FROM group_insight_runs') ? { rows: [] } : { rows: [] }));
    const { status, body } = await api(buildApp(), 'GET', '/api/group-insights/tag-report/missing-run');
    expect(status).toBe(404);
    expect(body.error).toBe('Run not found');
  });

  it('gracefully falls back to empty sources/insights on a query error', async () => {
    dbQuery = vi.fn(async (sql) => {
      if (sql.includes('FROM group_insight_runs')) return { rows: [{ id: 'run-1' }] };
      if (sql.includes('FROM group_insight_run_sources')) throw new Error('table missing');
      if (sql.includes('FROM group_insights')) throw new Error('table missing');
      return { rows: [] };
    });
    const { status, body } = await api(buildApp(), 'GET', '/api/group-insights/tag-report/run-1');
    expect(status).toBe(200);
    expect(body.sources).toEqual([]);
    expect(body.insights).toEqual([]);
    expect(body.insights_by_metric).toEqual({});
  });

  // ── metric_tracks / disclosure enrichment (2026-07-02 integration reconciliation) ──
  // The frontend was built against a pre-shaped metric_tracks[] + disclosure fields
  // (lib/tagReportView.ts), not the raw insights/sources rows alone — these assert
  // that derivation, not just that the raw fields pass through unchanged.

  it('derives tag_id from tag_ids[0] on the run object', async () => {
    dbQuery = vi.fn(async (sql) => {
      if (sql.includes('FROM group_insight_runs')) {
        return { rows: [{ id: 'run-1', tag_ids: ['tag-1'], run_mode: 'manual', status: 'completed', stream_events: [] }] };
      }
      return { rows: [] };
    });
    const { body } = await api(buildApp(), 'GET', '/api/group-insights/tag-report/run-1');
    expect(body.run.tag_id).toBe('tag-1');
  });

  it('builds metric_tracks with flattened metric_json fields, citations filtered to real ones, and single-survey flagging', async () => {
    dbQuery = vi.fn(async (sql) => {
      if (sql.includes('FROM group_insight_runs')) {
        return {
          rows: [{
            id: 'run-1', tag_ids: ['tag-1'], run_mode: 'manual', status: 'completed',
            stream_events: [],
          }],
        };
      }
      if (sql.includes('FROM group_insight_run_sources')) {
        return { rows: [{ survey_id: 's1', survey_title: 'Onboarding NPS', checkpoint_id: 'ckpt-1' }] };
      }
      if (sql.includes('FROM group_insights')) {
        return {
          rows: [{
            metric_key: 'nps', headline: 'NPS up 4 points', narrative: 'Strong quarter.',
            trust_score: '82.5', survey_ids: ['s1'],
            metric_json: { merged_delta: 4.2, direction: 'up', agreement_count: 1, confidence_tier: 'insufficient', single_survey_id: 's1' },
            citations_json: [
              { survey_id: 's1', response_id: 'r1', source_insight_id: 'ins-1', quote: 'Great!', sentiment: 'positive', relevance: 0.9 },
              { survey_id: 's1', checkpoint_id: 'ckpt-1', bracket_position: 'single' }, // fallback shape, no response_id
            ],
          }],
        };
      }
      return { rows: [] };
    });
    const { body } = await api(buildApp(), 'GET', '/api/group-insights/tag-report/run-1');
    expect(body.metric_tracks).toHaveLength(1);
    const track = body.metric_tracks[0];
    expect(track.metric_key).toBe('nps');
    expect(track.trust_score).toBe(82.5); // string -> number coercion (Postgres NUMERIC)
    expect(track.merged_delta).toBe(4.2);
    expect(track.direction).toBe('up');
    expect(track.agreement_count).toBe(1);
    expect(track.confidence_tier).toBe('insufficient');
    expect(track.eligible_survey_count).toBe(1);
    expect(track.single_survey_sourced).toBe(true);
    expect(track.single_survey_name).toBe('Onboarding NPS');
    // Only the real-citation-shaped entry survives — the fallback placeholder
    // (no response_id) is filtered out rather than exposed as a broken citation.
    expect(track.citations).toHaveLength(1);
    expect(track.citations[0].response_id).toBe('r1');
  });

  it('names the single agreeing survey via metric_json.single_survey_id even when >1 total eligible surveys (QA fix, 2026-07-03)', async () => {
    // Regression test: previously single_survey_name only resolved when
    // eligibleSurveyIds.length === 1 (the trivial R-T2a case) — this covers
    // the general R-T2 case (3 total eligible surveys, only 1 actually agrees).
    dbQuery = vi.fn(async (sql) => {
      if (sql.includes('FROM group_insight_runs')) {
        return { rows: [{ id: 'run-1', tag_ids: ['tag-1'], run_mode: 'manual', status: 'completed', stream_events: [] }] };
      }
      if (sql.includes('FROM group_insight_run_sources')) {
        return {
          rows: [
            { survey_id: 's1', survey_title: 'Onboarding NPS', checkpoint_id: 'ckpt-1' },
            { survey_id: 's2', survey_title: 'Renewal NPS', checkpoint_id: 'ckpt-2' },
            { survey_id: 's3', survey_title: 'Support NPS', checkpoint_id: 'ckpt-3' },
          ],
        };
      }
      if (sql.includes('FROM group_insights')) {
        return {
          rows: [{
            metric_key: 'nps', headline: 'H', narrative: 'N', trust_score: 70,
            survey_ids: ['s1', 's2', 's3'],
            metric_json: { merged_delta: 5.0, direction: 'up', agreement_count: 1, confidence_tier: 'insufficient', single_survey_id: 's1' },
            citations_json: [],
          }],
        };
      }
      return { rows: [] };
    });
    const { body } = await api(buildApp(), 'GET', '/api/group-insights/tag-report/run-1');
    const track = body.metric_tracks[0];
    expect(track.eligible_survey_count).toBe(3);
    expect(track.single_survey_sourced).toBe(true);
    expect(track.single_survey_name).toBe('Onboarding NPS');
  });

  it('does not name a survey when single_survey_id is absent (no clear single-agreeing-survey story)', async () => {
    dbQuery = vi.fn(async (sql) => {
      if (sql.includes('FROM group_insight_runs')) {
        return { rows: [{ id: 'run-1', tag_ids: ['tag-1'], run_mode: 'manual', status: 'completed', stream_events: [] }] };
      }
      if (sql.includes('FROM group_insight_run_sources')) {
        return { rows: [{ survey_id: 's1', survey_title: 'S1' }, { survey_id: 's2', survey_title: 'S2' }] };
      }
      if (sql.includes('FROM group_insights')) {
        return {
          rows: [{
            metric_key: 'nps', headline: 'H', narrative: 'N', trust_score: 70,
            survey_ids: ['s1', 's2'],
            metric_json: { merged_delta: null, direction: 'flat', agreement_count: 0, confidence_tier: 'insufficient', single_survey_id: null },
            citations_json: [],
          }],
        };
      }
      return { rows: [] };
    });
    const { body } = await api(buildApp(), 'GET', '/api/group-insights/tag-report/run-1');
    const track = body.metric_tracks[0];
    expect(track.single_survey_sourced).toBe(true); // insufficient confidence_tier
    expect(track.single_survey_name).toBeUndefined();
  });

  it('attaches comparability_warning events whose affected_survey_ids overlap the metric\'s eligible surveys', async () => {
    dbQuery = vi.fn(async (sql) => {
      if (sql.includes('FROM group_insight_runs')) {
        return {
          rows: [{
            id: 'run-1', tag_ids: ['tag-1'], run_mode: 'custom_range', status: 'completed',
            stream_events: [
              { event: 'comparability_warning', scope: 'survey', warning_type: 'temporal_offset', distortion_score: 0.6, confidence_tier: 'low', affected_survey_ids: ['s1'] },
              { event: 'comparability_warning', scope: 'survey', warning_type: 'staleness', distortion_score: 12, confidence_tier: 'severe', affected_survey_ids: ['s-unrelated'] },
            ],
          }],
        };
      }
      if (sql.includes('FROM group_insight_run_sources')) {
        return { rows: [{ survey_id: 's1', survey_title: 'S1', checkpoint_id: 'ckpt-1', response_count_at_generation: 120 }] };
      }
      if (sql.includes('FROM group_insights')) {
        return { rows: [{ metric_key: 'nps', headline: 'H', narrative: 'N', trust_score: 70, survey_ids: ['s1'], metric_json: {}, citations_json: [] }] };
      }
      return { rows: [] };
    });
    const { body } = await api(buildApp(), 'GET', '/api/group-insights/tag-report/run-1');
    expect(body.metric_tracks[0].warnings).toHaveLength(1);
    expect(body.metric_tracks[0].warnings[0].warning_type).toBe('temporal_offset');
  });

  it('computes disclosure fields (pool_size, examined_count, included_count, backfill_occurred) from stream_events + sources', async () => {
    dbQuery = vi.fn(async (sql) => {
      if (sql.includes('FROM group_insight_runs')) {
        return {
          rows: [{
            id: 'run-1', tag_ids: ['tag-1'], run_mode: 'manual', status: 'completed',
            stream_events: [
              { event: 'batch_fetched', pool_size: 12 },
              { event: 'batch_fetched', pool_size: 12 }, // 2nd batch fetched -> backfill occurred
            ],
          }],
        };
      }
      if (sql.includes('FROM group_insight_run_sources')) {
        return {
          rows: [
            { survey_id: 's1', checkpoint_id: 'ckpt-1' },
            { survey_id: 's2', checkpoint_id: 'ckpt-2' },
            { survey_id: 's3', checkpoint_id: null }, // excluded — hard exclusion, no checkpoint
          ],
        };
      }
      return { rows: [] };
    });
    const { body } = await api(buildApp(), 'GET', '/api/group-insights/tag-report/run-1');
    expect(body.pool_size).toBe(12);
    expect(body.examined_count).toBe(3);
    expect(body.included_count).toBe(2);
    expect(body.backfill_occurred).toBe(true);
  });

  it('sets backfill_occurred false when only one batch was ever fetched', async () => {
    dbQuery = vi.fn(async (sql) => {
      if (sql.includes('FROM group_insight_runs')) {
        return { rows: [{ id: 'run-1', tag_ids: ['tag-1'], run_mode: 'manual', status: 'completed', stream_events: [{ event: 'batch_fetched', pool_size: 5 }] }] };
      }
      if (sql.includes('FROM group_insight_run_sources')) {
        return { rows: [{ survey_id: 's1', checkpoint_id: 'ckpt-1' }] };
      }
      return { rows: [] };
    });
    const { body } = await api(buildApp(), 'GET', '/api/group-insights/tag-report/run-1');
    expect(body.backfill_occurred).toBe(false);
  });
});

// ── GET /tag-report/:runId/trail ───────────────────────────────────────────────

describe('GET /api/group-insights/tag-report/:runId/trail', () => {
  it('returns 404 when the run does not exist', async () => {
    dbQuery = vi.fn(async () => ({ rows: [] }));
    const { status, body } = await api(buildApp(), 'GET', '/api/group-insights/tag-report/missing-run/trail');
    expect(status).toBe(404);
    expect(body.error).toBe('Run not found');
  });

  it('walks parent_run_id backwards and returns the full lineage', async () => {
    dbQuery = vi.fn(async (sql, params) => {
      if (sql === 'SELECT id FROM group_insight_runs WHERE id = $1 AND org_id = $2') {
        return { rows: [{ id: params[0] }] };
      }
      if (sql.includes('FROM group_insight_runs') && sql.includes('parent_run_id')) {
        const id = params[0];
        if (id === 'run-3') return { rows: [{ id: 'run-3', parent_run_id: 'run-2' }] };
        if (id === 'run-2') return { rows: [{ id: 'run-2', parent_run_id: 'run-1' }] };
        if (id === 'run-1') return { rows: [{ id: 'run-1', parent_run_id: null }] };
        return { rows: [] };
      }
      if (sql.includes('FROM group_insight_run_sources')) return { rows: [] };
      return { rows: [] };
    });
    const { status, body } = await api(buildApp(), 'GET', '/api/group-insights/tag-report/run-3/trail');
    expect(status).toBe(200);
    expect(body.lineage.map((r) => r.id)).toEqual(['run-3', 'run-2', 'run-1']);
    expect(body.truncated).toBe(false);
  });

  it('caps the lineage walk at 10 hops and reports truncated: true', async () => {
    dbQuery = vi.fn(async (sql, params) => {
      if (sql === 'SELECT id FROM group_insight_runs WHERE id = $1 AND org_id = $2') {
        return { rows: [{ id: params[0] }] };
      }
      if (sql.includes('FROM group_insight_runs') && sql.includes('parent_run_id')) {
        const n = parseInt(params[0].replace('run-', ''), 10);
        return { rows: [{ id: params[0], parent_run_id: `run-${n - 1}` }] };
      }
      if (sql.includes('FROM group_insight_run_sources')) return { rows: [] };
      return { rows: [] };
    });
    const { status, body } = await api(buildApp(), 'GET', '/api/group-insights/tag-report/run-99/trail');
    expect(status).toBe(200);
    expect(body.lineage).toHaveLength(10);
    expect(body.truncated).toBe(true);
  });
});

// ── GET /tag-reports (index list) ──────────────────────────────────────────────

describe('GET /api/group-insights/tag-reports', () => {
  it('returns tags with >=1 run, each with a derived has_active_warning', async () => {
    dbQuery = vi.fn(async () => ({
      rows: [
        {
          tag_id: 'tag-1', tag_name: 'NPS', tag_color: '#fff', survey_count: 3,
          latest_run_id: 'run-1', latest_run_mode: 'manual', latest_run_created_at: '2026-07-01T00:00:00Z',
          latest_run_included_count: 3, latest_run_warning_count: 0,
        },
        {
          tag_id: 'tag-2', tag_name: 'Onboarding', tag_color: '#000', survey_count: 1,
          latest_run_id: 'run-2', latest_run_mode: 'automated', latest_run_created_at: '2026-07-02T00:00:00Z',
          latest_run_included_count: 1, latest_run_warning_count: 0,
        },
        {
          tag_id: 'tag-3', tag_name: 'Renewal', tag_color: '#111', survey_count: 5,
          latest_run_id: 'run-3', latest_run_mode: 'custom_range', latest_run_created_at: '2026-07-02T01:00:00Z',
          latest_run_included_count: 4, latest_run_warning_count: 2,
        },
      ],
    }));
    const { status, body } = await api(buildApp(), 'GET', '/api/group-insights/tag-reports');
    expect(status).toBe(200);
    // Response key is `reports`/`total` (2026-07-02 integration reconciliation —
    // matches the frontend's TagReportsIndexResponse contract), not `tags`.
    expect(body.total).toBe(3);
    expect(body.reports).toHaveLength(3);
    // tag-1: 3 included, 0 warnings -> no active warning
    expect(body.reports[0].latest_run.has_active_warning).toBe(false);
    // tag-2: single-survey case (R-T2a) -> active warning even with 0 explicit warnings
    expect(body.reports[1].latest_run.has_active_warning).toBe(true);
    // tag-3: multiple surveys but 2 rows have exclusion/ineligibility -> active warning
    expect(body.reports[2].latest_run.has_active_warning).toBe(true);
  });

  it('returns an empty list when no tag has any run yet', async () => {
    dbQuery = vi.fn(async () => ({ rows: [] }));
    const { status, body } = await api(buildApp(), 'GET', '/api/group-insights/tag-reports');
    expect(status).toBe(200);
    expect(body.reports).toEqual([]);
    expect(body.total).toBe(0);
  });

  it('passes the q search param through as an ILIKE filter', async () => {
    let capturedParams;
    dbQuery = vi.fn(async (sql, params) => { capturedParams = params; return { rows: [] }; });
    await api(buildApp(), 'GET', '/api/group-insights/tag-reports?q=onboard');
    expect(capturedParams).toContain('%onboard%');
  });

  it('falls back to sort=recent for an unrecognized sort value', async () => {
    let capturedSql;
    dbQuery = vi.fn(async (sql) => { capturedSql = sql; return { rows: [] }; });
    await api(buildApp(), 'GET', '/api/group-insights/tag-reports?sort=bogus');
    expect(capturedSql).toMatch(/latest_run_created_at DESC/);
  });

  it('reports automated_enabled=true only for tags with program_config.tag_report_automated.enabled=true (regression test, 2026-07-03 — previously never selected, always undefined/falsy)', async () => {
    dbQuery = vi.fn(async (sql) => {
      expect(sql).toMatch(/tag_report_automated.*enabled/s);
      return {
        rows: [
          { tag_id: 'tag-1', tag_name: 'Automated Tag', tag_color: '#000', survey_count: 2, automated_enabled: true },
          { tag_id: 'tag-2', tag_name: 'Manual-only Tag', tag_color: '#111', survey_count: 3, automated_enabled: false },
        ],
      };
    });
    const { body } = await api(buildApp(), 'GET', '/api/group-insights/tag-reports');
    expect(body.reports[0].automated_enabled).toBe(true);
    expect(body.reports[1].automated_enabled).toBe(false);
  });

  it('defaults automated_enabled to false when the DB row omits the field entirely (no program_config set)', async () => {
    dbQuery = vi.fn(async () => ({
      rows: [{ tag_id: 'tag-1', tag_name: 'No Config', tag_color: '#000', survey_count: 1 }],
    }));
    const { body } = await api(buildApp(), 'GET', '/api/group-insights/tag-reports');
    expect(body.reports[0].automated_enabled).toBe(false);
  });
});
