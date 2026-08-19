/**
 * Tests for POST /api/insights/:surveyId/crystal — the stateful Crystal chat
 * handler in routes/insights.ts (thread persistence + non-streaming CrystalOS
 * call via _agentsFetch).
 *
 * Uses the fakeMod/cache-injection pattern (see insightRuns.test.js /
 * experience.test.js) so no real DB, Redis, or agents (CrystalOS) service
 * connection is needed. The outbound `node-fetch` call to CrystalOS is mocked
 * so we can control the response shape and assert on what the route forwards.
 *
 * Focus: applied_filters passthrough (Phase 5, mirrors experience.ts's viz
 * passthrough allowlist fix at insights.ts:1477-1484) — this handler pulls a
 * fixed set of fields off the CrystalOS JSON response, so a newly-added key
 * (applied_filters) must be explicitly added or it's silently dropped.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import inject from 'light-my-request';
import express from 'express';

const __dirname = dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);

const AUTH_PATH   = _require.resolve(resolve(__dirname, '../middleware/auth'));
const DB_PATH     = _require.resolve(resolve(__dirname, '../lib/db'));
const LEDGER_PATH = _require.resolve(resolve(__dirname, '../lib/creditLedger'));
const REDIS_PATH  = _require.resolve(resolve(__dirname, '../lib/redis'));
const LOGGER_PATH = _require.resolve(resolve(__dirname, '../lib/logger'));
const FETCH_PATH  = _require.resolve('node-fetch');
const ROUTER_PATH = _require.resolve(resolve(__dirname, '../routes/insights'));

let dbQuery;
let fetchMock;
let checkCreditsMock;
let debitCreditsMock;

function fakeMod(id, exports) {
  return { id, filename: id, loaded: true, exports, children: [] };
}

const SURVEY_ROW = { id: 's1', title: 'Q3 NPS Survey', questions: [], org_id: 'o1', status: 'active', created_by: 'u1', response_count: 50 };

function buildApp() {
  _require.cache[AUTH_PATH] = fakeMod(AUTH_PATH, {
    DEV_MODE: false,
    requireAuth: (req, _res, next) => { req.orgId = 'o1'; req.userId = 'u1'; next(); },
  });
  _require.cache[DB_PATH] = fakeMod(DB_PATH, {
    query: (...args) => dbQuery(...args),
    default: { query: (...args) => dbQuery(...args) },
  });
  _require.cache[LEDGER_PATH] = fakeMod(LEDGER_PATH, {
    checkCredits: (...args) => checkCreditsMock(...args),
    debitCredits: (...args) => debitCreditsMock(...args),
  });
  // No Redis in this test env — matches the handler's own graceful-degradation
  // path (getRedisClient() === null skips rate limiting entirely).
  _require.cache[REDIS_PATH] = fakeMod(REDIS_PATH, { getRedisClient: () => null, getRedisBlockingClient: () => null });
  _require.cache[LOGGER_PATH] = fakeMod(LOGGER_PATH, {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  });
  // node-fetch's real CJS export shape is `module.exports = fetch` (a callable
  // function, no __esModule flag) — mirror that exactly, same as experience.test.js.
  _require.cache[FETCH_PATH] = fakeMod(FETCH_PATH, (...args) => fetchMock(...args));

  delete _require.cache[ROUTER_PATH];
  const router = _require(ROUTER_PATH);
  const app = express();
  app.use(express.json());
  app.use('/api/insights', router.default || router);
  return app;
}

beforeEach(() => {
  dbQuery = vi.fn(async (text) => {
    if (text.includes('FROM surveys')) return { rows: [SURVEY_ROW] };
    if (text.includes('FROM insights')) return { rows: [] };
    if (text.includes('FROM survey_topics')) return { rows: [] };
    if (text.includes('FROM crystal_threads')) return { rows: [] };
    return { rows: [] };
  });
  checkCreditsMock = vi.fn(async () => ({ ok: true, available: 1000, required: 5 }));
  debitCreditsMock = vi.fn(async () => ({}));
  fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ answer: 'NPS is 42 this quarter.', suggestions: [], insight_refs: [], citations: [] }),
  }));
});

describe('POST /api/insights/:surveyId/crystal — applied_filters passthrough', () => {
  it('forwards a present applied_filters list from the CrystalOS response untouched', async () => {
    const appliedFilters = [
      { kind: 'survey', label: 'Survey', value: 'Q3 NPS Survey', raw: { survey_id: 's1' }, sources: ['get_survey_overview'] },
    ];
    fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        answer: 'NPS is 42 this quarter.', suggestions: [], insight_refs: [], citations: [],
        applied_filters: appliedFilters,
      }),
    }));

    const res = await inject(buildApp(), {
      method: 'POST',
      url: '/api/insights/s1/crystal',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'how is NPS split by segment?' }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().applied_filters).toEqual(appliedFilters);
  });

  it('returns applied_filters: null (not omitted) when absent from the CrystalOS response', async () => {
    const res = await inject(buildApp(), {
      method: 'POST',
      url: '/api/insights/s1/crystal',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'what is driving detractors?' }),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect('applied_filters' in body).toBe(true);
    expect(body.applied_filters).toBeNull();
  });

  it('still forwards viz (existing field) alongside applied_filters', async () => {
    const vizSpec = { viz_version: 1, kind: 'nps_bar_chart', title: 'NPS is 42', data: [{ segment: 'A', score: 1 }] };
    fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        answer: 'NPS is 42 this quarter.', suggestions: [], insight_refs: [], citations: [],
        viz: vizSpec, applied_filters: [],
      }),
    }));

    const res = await inject(buildApp(), {
      method: 'POST',
      url: '/api/insights/s1/crystal',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'how is NPS split by segment?' }),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.viz).toEqual(vizSpec);
    expect(body.applied_filters).toEqual([]);
  });
});

describe('POST /api/insights/:surveyId/crystal — turn_id passthrough', () => {
  it('forwards a present turn_id from the CrystalOS response untouched', async () => {
    fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        answer: 'NPS is 42 this quarter.', suggestions: [], insight_refs: [], citations: [],
        turn_id: 'turn-abc-123',
      }),
    }));

    const res = await inject(buildApp(), {
      method: 'POST',
      url: '/api/insights/s1/crystal',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'how is NPS split by segment?' }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().turn_id).toBe('turn-abc-123');
  });

  it('returns turn_id: null (not omitted) when absent from the CrystalOS response', async () => {
    const res = await inject(buildApp(), {
      method: 'POST',
      url: '/api/insights/s1/crystal',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'what is driving detractors?' }),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect('turn_id' in body).toBe(true);
    expect(body.turn_id).toBeNull();
  });
});
