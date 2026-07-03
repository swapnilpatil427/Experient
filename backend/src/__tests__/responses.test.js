/**
 * Tests for routes/responses.ts's single-response GET endpoint.
 *
 * Route is mounted at /api/surveys (per index.ts convention: app.use('/api/surveys', responsesRouter)).
 * GET /:surveyId/responses/:responseId — Response Detail (R-T5 audit-trail terminus,
 * docs/tag-report/DESIGN.md, TRACKER.md Task 16). Added 2026-07-02 to close the gap
 * between the frontend's ResponseDetailPage (built against this exact contract) and
 * a real backend implementation.
 *
 * Uses the fakeMod/cache-injection pattern (see survey-groups.test.js) so no real
 * DB connection is needed.
 */
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import inject from 'light-my-request';
import express from 'express';

const __dirname = dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);

const AUTH_PATH   = _require.resolve(resolve(__dirname, '../middleware/auth'));
const DB_PATH     = _require.resolve(resolve(__dirname, '../lib/db'));
const ROUTER_PATH = _require.resolve(resolve(__dirname, '../routes/responses'));

let dbQuery;

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
  _require.cache[DB_PATH] = fakeMod(DB_PATH, {
    query: dbQuery,
    pool: {},
    default: { query: dbQuery },
  });
  delete _require.cache[ROUTER_PATH];
  const router = _require(ROUTER_PATH);
  const app = express();
  app.use(express.json());
  app.use('/api/surveys', router.default || router);
  return app;
}

describe('GET /api/surveys/:surveyId/responses/:responseId', () => {
  it('returns the response scoped to survey_id + org_id, excluding soft-deleted rows', async () => {
    dbQuery = vi.fn(async (sql, params) => {
      expect(sql).toMatch(/deleted_at IS NULL/);
      expect(params).toEqual(['resp-1', 'survey-1', 'test-org']);
      return { rows: [{ id: 'resp-1', survey_id: 'survey-1', org_id: 'test-org', answers: [] }] };
    });

    const res = await inject(buildApp(), {
      method: 'GET',
      url: '/api/surveys/survey-1/responses/resp-1',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ response: { id: 'resp-1', survey_id: 'survey-1', org_id: 'test-org', answers: [] } });
  });

  it('joins surveys and requires deleted_at IS NULL on BOTH the response and its parent survey (security review fix, 2026-07-02)', async () => {
    // Regression test for Riley's HIGH-severity finding: soft-deleting a survey
    // does not cascade to its responses, so the query must independently guard
    // the parent survey's own deleted_at — not just the response row's.
    dbQuery = vi.fn(async (sql) => {
      expect(sql).toMatch(/JOIN surveys s ON s\.id = r\.survey_id/);
      expect(sql).toMatch(/r\.deleted_at IS NULL AND s\.deleted_at IS NULL/);
      return { rows: [{ id: 'resp-1' }] };
    });

    const res = await inject(buildApp(), {
      method: 'GET',
      url: '/api/surveys/survey-1/responses/resp-1',
    });

    expect(res.statusCode).toBe(200);
  });

  it('returns 404 when the response belongs to a soft-deleted survey, even though the response row itself is not deleted', async () => {
    // The JOIN's `s.deleted_at IS NULL` filters this out at the query layer —
    // simulated here the same way the "different org" test above simulates its
    // WHERE-clause exclusion, since there's no live DB in this test environment.
    dbQuery = vi.fn(async () => ({ rows: [] }));

    const res = await inject(buildApp(), {
      method: 'GET',
      url: '/api/surveys/deleted-survey/responses/resp-1',
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Response not found' });
  });

  it('returns 404 (not a raw error) when the response does not exist', async () => {
    dbQuery = vi.fn(async () => ({ rows: [] }));

    const res = await inject(buildApp(), {
      method: 'GET',
      url: '/api/surveys/survey-1/responses/missing-id',
    });

    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for a response belonging to a different org — never leaks cross-org data', async () => {
    // Simulates the WHERE clause correctly excluding a same-id-different-org row:
    // the mock returns no rows because a real query would filter it out via org_id.
    dbQuery = vi.fn(async (sql, params) => {
      expect(params[2]).toBe('test-org');
      return { rows: [] };
    });

    const res = await inject(buildApp(), {
      method: 'GET',
      url: '/api/surveys/other-survey/responses/resp-in-other-org',
    });

    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for a soft-deleted response — identical status to "not found", does not distinguish', async () => {
    // The route's WHERE includes deleted_at IS NULL, so a soft-deleted row is
    // filtered out at the query layer and looks identical to "never existed".
    dbQuery = vi.fn(async () => ({ rows: [] }));

    const res = await inject(buildApp(), {
      method: 'GET',
      url: '/api/surveys/survey-1/responses/soft-deleted-id',
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Response not found' });
  });

  it('propagates a real DB error as a 500, not a silent 404', async () => {
    dbQuery = vi.fn(async () => { throw new Error('connection refused'); });

    const res = await inject(buildApp(), {
      method: 'GET',
      url: '/api/surveys/survey-1/responses/resp-1',
    });

    expect(res.statusCode).toBe(500);
  });
});
