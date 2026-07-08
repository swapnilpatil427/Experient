/**
 * Tests for routes/survey-groups.js
 *
 * Route is mounted at /api/group-insights (per index.js convention).
 * POST /generate — start a group insight run
 * GET  /:runId/status — get run status
 * GET  /:runId       — get completed run + insights
 *
 * Uses the fakeMod/cache-injection pattern (see dashboard.test.js) so no real
 * DB or agents service connection is needed.
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
const DB_PATH          = _require.resolve(resolve(__dirname, '../lib/db'));
const AGENTS_PATH      = _require.resolve(resolve(__dirname, '../lib/agentsClient'));
const LOGGER_PATH      = _require.resolve(resolve(__dirname, '../lib/logger'));
const CONCURRENCY_PATH = _require.resolve(resolve(__dirname, '../lib/groupInsightRunConcurrency'));
const ROUTER_PATH      = _require.resolve(resolve(__dirname, '../routes/survey-groups'));

let dbQuery;
let generateGroupInsights;

function fakeMod(id, exports) {
  return { id, filename: id, loaded: true, exports, children: [] };
}

function buildApp() {
  _require.cache[AUTH_PATH] = fakeMod(AUTH_PATH, {
    requireAuth: (req, res, next) => {
      req.orgId  = 'test-org';
      req.userId = 'test-user';
      next();
    },
  });
  // requireRole('analyst') was added to /generate (TRACKER.md §1 Task 12) — pass
  // through in these tests exactly like tags.test.js does for its own mutation
  // routes; role-gate behavior itself is covered by requireRole's own unit tests.
  _require.cache[ROLE_PATH] = fakeMod(ROLE_PATH, {
    requireRole: () => (req, res, next) => next(),
  });
  _require.cache[DB_PATH] = fakeMod(DB_PATH, {
    query: dbQuery,
    default: { query: dbQuery },
  });
  _require.cache[AGENTS_PATH] = fakeMod(AGENTS_PATH, {
    generateGroupInsights,
    default: { generateGroupInsights },
  });
  // Silence logger output during tests
  _require.cache[LOGGER_PATH] = fakeMod(LOGGER_PATH, {
    info:  vi.fn(),
    warn:  vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  });

  // groupInsightRunConcurrency.ts is a REAL module (not faked above) that reads
  // `query` from lib/db at its own require-time. Because it isn't the router
  // itself, it stays cached across tests unless explicitly invalidated here too
  // — otherwise it keeps a stale reference to whichever dbQuery mock happened to
  // be installed the first time it was loaded, instead of the current test's.
  delete _require.cache[CONCURRENCY_PATH];
  delete _require.cache[ROUTER_PATH];
  const router = _require(ROUTER_PATH);
  const app = express();
  app.use(express.json());
  app.use('/api/group-insights', router.default || router);
  return app;
}

// ── POST /api/group-insights/generate ─────────────────────────────────────────

describe('POST /api/group-insights/generate', () => {
  beforeEach(() => {
    generateGroupInsights = vi.fn(async () => {});
  });

  it('returns 202 with a run_id when tag_ids are valid and surveys exist', async () => {
    dbQuery = vi.fn(async (sql) => {
      if (sql.includes('FROM survey_tags')) {
        // All two tag_ids validated
        return { rows: [{ id: 'tag-1' }, { id: 'tag-2' }] };
      }
      if (sql.includes('survey_tag_mappings')) {
        return { rows: [{ survey_id: 'survey-a' }, { survey_id: 'survey-b' }] };
      }
      if (sql.includes('INSERT INTO group_insight_runs')) {
        return { rows: [{ id: 'run-123' }] };
      }
      return { rows: [] };
    });

    const res = await inject(buildApp(), {
      method: 'POST',
      url: '/api/group-insights/generate',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tag_ids: ['tag-1', 'tag-2'] }),
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ run_id: 'run-123' });
    // agents service should have been called fire-and-forget
    // (it's async, may need a brief tick; check it was registered)
    await new Promise((r) => setTimeout(r, 10));
    expect(generateGroupInsights).toHaveBeenCalledWith(
      'run-123',
      ['tag-1', 'tag-2'],
      ['survey-a', 'survey-b'],
      'test-org'
    );
  });

  it('returns 400 when tag_ids is missing', async () => {
    dbQuery = vi.fn(async () => ({ rows: [] }));

    const res = await inject(buildApp(), {
      method: 'POST',
      url: '/api/group-insights/generate',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/tag_ids/);
  });

  it('returns 400 when tag_ids is an empty array', async () => {
    dbQuery = vi.fn(async () => ({ rows: [] }));

    const res = await inject(buildApp(), {
      method: 'POST',
      url: '/api/group-insights/generate',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tag_ids: [] }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/tag_ids/);
  });

  it('returns 400 when tag_ids is not an array', async () => {
    dbQuery = vi.fn(async () => ({ rows: [] }));

    const res = await inject(buildApp(), {
      method: 'POST',
      url: '/api/group-insights/generate',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tag_ids: 'tag-1' }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/tag_ids/);
  });

  it('returns 400 when one or more tag IDs do not belong to the org', async () => {
    dbQuery = vi.fn(async (sql) => {
      if (sql.includes('FROM survey_tags')) {
        // Only 1 tag validated, but 2 were sent
        return { rows: [{ id: 'tag-1' }] };
      }
      return { rows: [] };
    });

    const res = await inject(buildApp(), {
      method: 'POST',
      url: '/api/group-insights/generate',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tag_ids: ['tag-1', 'tag-bogus'] }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/invalid/i);
  });

  it('returns 400 when no surveys exist for the given tags', async () => {
    dbQuery = vi.fn(async (sql) => {
      if (sql.includes('FROM survey_tags')) {
        return { rows: [{ id: 'tag-1' }] };
      }
      if (sql.includes('survey_tag_mappings')) {
        // No surveys found
        return { rows: [] };
      }
      return { rows: [] };
    });

    const res = await inject(buildApp(), {
      method: 'POST',
      url: '/api/group-insights/generate',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tag_ids: ['tag-1'] }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/no surveys/i);
  });

  it('returns 500 on a DB error during tag validation', async () => {
    dbQuery = vi.fn(async () => { throw new Error('db connection refused'); });

    const res = await inject(buildApp(), {
      method: 'POST',
      url: '/api/group-insights/generate',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tag_ids: ['tag-1'] }),
    });

    expect(res.statusCode).toBe(500);
  });

  it('returns 500 on a DB error during INSERT', async () => {
    dbQuery = vi.fn(async (sql) => {
      if (sql.includes('FROM survey_tags')) {
        return { rows: [{ id: 'tag-1' }] };
      }
      if (sql.includes('survey_tag_mappings')) {
        return { rows: [{ survey_id: 'survey-a' }] };
      }
      if (sql.includes('INSERT INTO group_insight_runs')) {
        throw new Error('constraint violation');
      }
      return { rows: [] };
    });

    const res = await inject(buildApp(), {
      method: 'POST',
      url: '/api/group-insights/generate',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tag_ids: ['tag-1'] }),
    });

    expect(res.statusCode).toBe(500);
  });

  it('uses provided survey_ids directly and skips tag-mapping query', async () => {
    const tagValidation    = vi.fn(async () => ({ rows: [{ id: 'tag-1' }] }));
    const mappingQuery     = vi.fn(async () => ({ rows: [] }));
    const surveyValidation = vi.fn(async () => ({ rows: [{ id: 'survey-explicit' }] }));
    const insertQuery      = vi.fn(async () => ({ rows: [{ id: 'run-xyz', created_at: 't' }] }));

    dbQuery = vi.fn(async (sql) => {
      if (sql.includes('FROM survey_tags')) return tagValidation();
      if (sql.includes('survey_tag_mappings')) return mappingQuery();
      // Task 12b — provided survey_ids are now validated for org ownership.
      if (sql.includes('FROM surveys WHERE')) return surveyValidation();
      if (sql.includes('INSERT INTO group_insight_runs')) return insertQuery();
      return { rows: [] };
    });

    const res = await inject(buildApp(), {
      method: 'POST',
      url: '/api/group-insights/generate',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tag_ids: ['tag-1'], survey_ids: ['survey-explicit'] }),
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ run_id: 'run-xyz' });
    // Mapping query should NOT have been called since survey_ids were provided
    expect(mappingQuery).not.toHaveBeenCalled();
    // The provided survey_ids are still validated against the org (Task 12b).
    expect(surveyValidation).toHaveBeenCalled();
    // generateGroupInsights should receive the explicit survey ids
    await new Promise((r) => setTimeout(r, 10));
    expect(generateGroupInsights).toHaveBeenCalledWith(
      'run-xyz', ['tag-1'], ['survey-explicit'], 'test-org'
    );
  });

  // ── TRACKER.md §1 Task 12b regression test ──────────────────────────────────
  // Root cause: this endpoint used to accept client-supplied survey_ids with
  // ZERO validation that they belong to the calling org, flowing straight to the
  // DB insert and to CrystalOS. This test would have caught that gap.
  it('returns 400 when provided survey_ids do not belong to the org (Task 12b)', async () => {
    dbQuery = vi.fn(async (sql) => {
      if (sql.includes('FROM survey_tags')) return { rows: [{ id: 'tag-1' }] };
      // Org-scoped survey lookup finds none of the provided IDs.
      if (sql.includes('FROM surveys WHERE')) return { rows: [] };
      return { rows: [] };
    });

    const res = await inject(buildApp(), {
      method: 'POST',
      url: '/api/group-insights/generate',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tag_ids: ['tag-1'], survey_ids: ['someone-elses-survey'] }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/invalid|do not belong/i);
    expect(generateGroupInsights).not.toHaveBeenCalled();
  });

  it('attaches to an in-flight run on a 23505 conflict instead of erroring (Appendix A.5)', async () => {
    dbQuery = vi.fn(async (sql) => {
      if (sql.includes('FROM survey_tags')) return { rows: [{ id: 'tag-1' }] };
      if (sql.includes('survey_tag_mappings')) return { rows: [{ survey_id: 'survey-a' }] };
      if (sql.startsWith('INSERT INTO group_insight_runs')) {
        const e = new Error('duplicate key value violates unique constraint "uq_gir_tag_inflight"');
        e.code = '23505';
        throw e;
      }
      if (sql.includes("status IN ('pending', 'running')")) {
        return { rows: [{ id: 'already-running-run', created_at: 't0' }] };
      }
      return { rows: [] };
    });

    const res = await inject(buildApp(), {
      method: 'POST',
      url: '/api/group-insights/generate',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tag_ids: ['tag-1'] }),
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ run_id: 'already-running-run', attached_to_existing: true });
    // Attaching to an in-flight run must never trigger a second generation.
    expect(generateGroupInsights).not.toHaveBeenCalled();
  });

  it('enforces the Tag Report daily limit on this route too (security review fix, 2026-07-02)', async () => {
    // Regression test for Riley's MEDIUM-severity finding: this route writes
    // into the same group_insight_runs table for the same (org_id, tag_ids) as
    // Tag Report's manual/custom-range endpoints, and its underlying graph
    // (group_insights.py) makes real fresh LLM calls per run — so leaving it
    // unrate-limited was a genuine cost/quota bypass, not cosmetic.
    dbQuery = vi.fn(async (sql) => {
      if (sql.includes('FROM survey_tags')) return { rows: [{ id: 'tag-1' }] };
      if (sql.includes('survey_tag_mappings')) return { rows: [{ survey_id: 'survey-a' }] };
      if (sql.includes('FROM group_insight_runs') && sql.includes('COUNT(*)')) {
        return { rows: [{ run_count: 10 }] }; // at/above TAG_REPORT_MANUAL_DAILY_LIMIT default (10)
      }
      return { rows: [] };
    });

    const res = await inject(buildApp(), {
      method: 'POST',
      url: '/api/group-insights/generate',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tag_ids: ['tag-1'] }),
    });

    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ code: 'RATE_LIMITED', tag_id: 'tag-1' });
    expect(generateGroupInsights).not.toHaveBeenCalled();
  });
});

// ── GET /api/group-insights/:runId/status ─────────────────────────────────────

describe('GET /api/group-insights/:runId/status', () => {
  beforeEach(() => {
    generateGroupInsights = vi.fn(async () => {});
  });

  it('returns run status for a valid run in completed state', async () => {
    dbQuery = vi.fn(async () => ({
      rows: [{
        id: 'run-123',
        status: 'completed',
        tag_ids: ['tag-1'],
        survey_ids: ['survey-a'],
        stream_events: [{ event: 'step', text: 'done' }],
        error_log: [],
        created_at: '2026-06-01T10:00:00Z',
        completed_at: '2026-06-01T10:05:00Z',
        duration_seconds: 300,
      }],
    }));

    const res = await inject(buildApp(), {
      method: 'GET',
      url: '/api/group-insights/run-123/status',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      run_id: 'run-123',
      status: 'completed',
      tag_ids: ['tag-1'],
      survey_ids: ['survey-a'],
    });
    expect(Array.isArray(body.stream_events)).toBe(true);
    expect(body.stream_events).toHaveLength(1);
    expect(body.error).toBeNull();
    expect(body.completed_at).toBe('2026-06-01T10:05:00Z');
  });

  it('returns 404 when run_id is not found or belongs to a different org', async () => {
    dbQuery = vi.fn(async () => ({ rows: [] }));

    const res = await inject(buildApp(), {
      method: 'GET',
      url: '/api/group-insights/nonexistent-run/status',
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/not found/i);
  });

  it('returns run with status "running" when still in progress', async () => {
    dbQuery = vi.fn(async () => ({
      rows: [{
        id: 'run-456',
        status: 'running',
        tag_ids: ['tag-2'],
        survey_ids: ['survey-b'],
        stream_events: [],
        error_log: [],
        created_at: '2026-06-01T10:00:00Z',
        completed_at: null,
        duration_seconds: null,
      }],
    }));

    const res = await inject(buildApp(), {
      method: 'GET',
      url: '/api/group-insights/run-456/status',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('running');
    expect(body.completed_at).toBeNull();
    expect(body.duration_seconds).toBeNull();
  });

  it('returns run with status "pending" at the start', async () => {
    dbQuery = vi.fn(async () => ({
      rows: [{
        id: 'run-789',
        status: 'pending',
        tag_ids: ['tag-3'],
        survey_ids: ['survey-c'],
        stream_events: [],
        error_log: [],
        created_at: '2026-06-01T11:00:00Z',
        completed_at: null,
        duration_seconds: null,
      }],
    }));

    const res = await inject(buildApp(), {
      method: 'GET',
      url: '/api/group-insights/run-789/status',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('pending');
  });

  it('includes the last error_log entry in the error field', async () => {
    dbQuery = vi.fn(async () => ({
      rows: [{
        id: 'run-fail',
        status: 'failed',
        tag_ids: ['tag-1'],
        survey_ids: ['survey-a'],
        stream_events: [],
        error_log: ['first error', 'final error message'],
        created_at: '2026-06-01T10:00:00Z',
        completed_at: '2026-06-01T10:01:00Z',
        duration_seconds: 60,
      }],
    }));

    const res = await inject(buildApp(), {
      method: 'GET',
      url: '/api/group-insights/run-fail/status',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('failed');
    expect(body.error).toBe('final error message');
    expect(body.error_log).toHaveLength(2);
  });

  it('returns 500 on a DB error', async () => {
    dbQuery = vi.fn(async () => { throw new Error('query timeout'); });

    const res = await inject(buildApp(), {
      method: 'GET',
      url: '/api/group-insights/run-123/status',
    });

    expect(res.statusCode).toBe(500);
  });
});

// ── GET /api/group-insights/:runId ────────────────────────────────────────────

describe('GET /api/group-insights/:runId', () => {
  beforeEach(() => {
    generateGroupInsights = vi.fn(async () => {});
  });

  it('returns completed run with insights for a valid run_id', async () => {
    dbQuery = vi.fn(async (sql) => {
      if (sql.includes('FROM group_insight_runs')) {
        return {
          rows: [{
            id: 'run-123',
            status: 'completed',
            tag_ids: ['tag-1'],
            survey_ids: ['survey-a'],
            stream_events: [],
            error_log: [],
            created_at: '2026-06-01T10:00:00Z',
            completed_at: '2026-06-01T10:05:00Z',
          }],
        };
      }
      if (sql.includes('FROM group_insights')) {
        return {
          rows: [
            { id: 'gi-1', headline: 'NPS dropped', priority: 2, run_id: 'run-123', org_id: 'test-org' },
            { id: 'gi-2', headline: 'Response rate up', priority: 1, run_id: 'run-123', org_id: 'test-org' },
          ],
        };
      }
      return { rows: [] };
    });

    const res = await inject(buildApp(), {
      method: 'GET',
      url: '/api/group-insights/run-123',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.run).toMatchObject({ id: 'run-123', status: 'completed' });
    expect(Array.isArray(body.insights)).toBe(true);
    expect(body.insights).toHaveLength(2);
    expect(body.insights[0]).toMatchObject({ headline: 'NPS dropped' });
  });

  it('returns 404 when run_id does not exist or belongs to a different org', async () => {
    dbQuery = vi.fn(async (sql) => {
      if (sql.includes('FROM group_insight_runs')) return { rows: [] };
      return { rows: [] };
    });

    const res = await inject(buildApp(), {
      method: 'GET',
      url: '/api/group-insights/nonexistent-run',
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/not found/i);
  });

  it('returns run with empty insights array when no insights have been written yet', async () => {
    dbQuery = vi.fn(async (sql) => {
      if (sql.includes('FROM group_insight_runs')) {
        return {
          rows: [{
            id: 'run-early',
            status: 'running',
            tag_ids: ['tag-1'],
            survey_ids: ['survey-a'],
            stream_events: [],
            error_log: [],
            created_at: '2026-06-01T10:00:00Z',
            completed_at: null,
          }],
        };
      }
      if (sql.includes('FROM group_insights')) {
        return { rows: [] };
      }
      return { rows: [] };
    });

    const res = await inject(buildApp(), {
      method: 'GET',
      url: '/api/group-insights/run-early',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.run).toMatchObject({ status: 'running' });
    expect(body.insights).toHaveLength(0);
  });

  it('still returns the run when insights query fails (graceful fallback)', async () => {
    dbQuery = vi.fn(async (sql) => {
      if (sql.includes('FROM group_insight_runs')) {
        return {
          rows: [{
            id: 'run-fallback',
            status: 'completed',
            tag_ids: ['tag-1'],
            survey_ids: ['survey-a'],
            stream_events: [],
            error_log: [],
            created_at: '2026-06-01T10:00:00Z',
            completed_at: '2026-06-01T10:05:00Z',
          }],
        };
      }
      if (sql.includes('FROM group_insights')) {
        throw new Error('insights table not found');
      }
      return { rows: [] };
    });

    const res = await inject(buildApp(), {
      method: 'GET',
      url: '/api/group-insights/run-fallback',
    });

    // Should return 200 with the run and an empty insights array (catch handles error)
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.run).toMatchObject({ id: 'run-fallback' });
    expect(body.insights).toEqual([]);
  });

  it('returns 500 on a DB error during run lookup', async () => {
    dbQuery = vi.fn(async (sql) => {
      if (sql.includes('FROM group_insight_runs')) {
        throw new Error('unexpected db error');
      }
      return { rows: [] };
    });

    const res = await inject(buildApp(), {
      method: 'GET',
      url: '/api/group-insights/run-error',
    });

    expect(res.statusCode).toBe(500);
  });
});
