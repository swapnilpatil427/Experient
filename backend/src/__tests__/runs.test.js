import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import inject from 'light-my-request';
import express from 'express';

const __dirname = dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);

const AUTH_PATH  = _require.resolve(resolve(__dirname, '../middleware/auth'));
const DB_PATH    = _require.resolve(resolve(__dirname, '../lib/db'));
const RUNS_ROUTER = _require.resolve(resolve(__dirname, '../routes/runs'));

let dbQuery;

function fakeMod(id, exports) { return { id, filename: id, loaded: true, exports, children: [] }; }

function injectMocks() {
  _require.cache[AUTH_PATH] = fakeMod(AUTH_PATH, {
    DEV_MODE: true,
    requireAuth: (req, _res, next) => { req.orgId = 'o1'; req.userId = 'u1'; next(); },
  });
  _require.cache[DB_PATH] = fakeMod(DB_PATH, { query: dbQuery, default: { query: dbQuery } });
}

function buildApp() {
  injectMocks();
  delete _require.cache[RUNS_ROUTER];
  const runs = _require(RUNS_ROUTER);
  const app = express();
  app.use(express.json());
  app.use('/api/runs', runs.default || runs);
  return app;
}

async function api(app, method, url) {
  const res = await inject(app, { method, url });
  let parsed = null;
  try { parsed = res.json(); } catch { parsed = res.payload; }
  return { status: res.statusCode, body: parsed };
}

describe('GET /api/runs/:runId', () => {
  it('surfaces stream_events for progress polling (e.g. topic_backfill)', async () => {
    const events = [{ event: 'backfill_progress', data: { total_untagged: 100, processed: 50, remaining: 50 } }];
    dbQuery = vi.fn(async () => ({
      rows: [{
        id: 'run-1', run_type: 'topic_backfill', status: 'running',
        stream_events: events, error_log: [], duration_seconds: 12,
      }],
    }));
    const { status, body } = await api(buildApp(), 'GET', '/api/runs/run-1');
    expect(status).toBe(200);
    expect(body.stream_events).toEqual(events);
  });

  it('returns an empty array (not a crash) when stream_events is absent', async () => {
    dbQuery = vi.fn(async () => ({
      rows: [{ id: 'run-1', run_type: 'survey_creation', status: 'completed', error_log: [], duration_seconds: 1 }],
    }));
    const { status, body } = await api(buildApp(), 'GET', '/api/runs/run-1');
    expect(status).toBe(200);
    expect(body.stream_events).toEqual([]);
  });

  it('404 when run not found', async () => {
    dbQuery = vi.fn(async () => ({ rows: [] }));
    const { status } = await api(buildApp(), 'GET', '/api/runs/missing');
    expect(status).toBe(404);
  });
});

describe('GET /api/runs?run_type=topic_backfill', () => {
  it('accepts topic_backfill as a valid run_type filter', async () => {
    dbQuery = vi.fn(async (text, params) => {
      if (text.includes('COUNT(*)')) return { rows: [{ total: 1 }] };
      // The filter must actually be applied — proves 'topic_backfill' passed VALID_TYPES.
      expect(text).toContain('run_type = $');
      expect(params).toContain('topic_backfill');
      return { rows: [{ id: 'run-1', run_type: 'topic_backfill', status: 'running', created_at: new Date(), completed_at: null, error_log: [], duration_seconds: 5 }] };
    });
    const { status, body } = await api(buildApp(), 'GET', '/api/runs?run_type=topic_backfill');
    expect(status).toBe(200);
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0].run_type).toBe('topic_backfill');
  });
});
