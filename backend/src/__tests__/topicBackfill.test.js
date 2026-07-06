import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import inject from 'light-my-request';
import express from 'express';

const __dirname = dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);

const AUTH_PATH    = _require.resolve(resolve(__dirname, '../middleware/auth'));
const DB_PATH      = _require.resolve(resolve(__dirname, '../lib/db'));
const LEDGER_PATH  = _require.resolve(resolve(__dirname, '../lib/creditLedger'));
const AGENTS_PATH  = _require.resolve(resolve(__dirname, '../lib/agentsClient'));
const INSIGHTS_ROUTER = _require.resolve(resolve(__dirname, '../routes/insights'));

let dbQuery;
let checkCreditsImpl;
let triggerBackfillImpl;
let triggerBackfillSpy;
let debitCreditsSpy;

function fakeMod(id, exports) { return { id, filename: id, loaded: true, exports, children: [] }; }

function injectMocks() {
  _require.cache[AUTH_PATH] = fakeMod(AUTH_PATH, {
    DEV_MODE: true,
    requireAuth: (req, _res, next) => { req.orgId = 'o1'; req.userId = 'u1'; next(); },
  });
  debitCreditsSpy = vi.fn(async () => ({}));
  _require.cache[LEDGER_PATH] = fakeMod(LEDGER_PATH, {
    checkCredits: vi.fn(async (...a) => checkCreditsImpl(...a)),
    debitCredits: debitCreditsSpy,
  });
  triggerBackfillSpy = vi.fn(async (...a) => triggerBackfillImpl(...a));
  _require.cache[AGENTS_PATH] = fakeMod(AGENTS_PATH, {
    triggerTopicBackfill: triggerBackfillSpy,
    getCheckpointBlob: vi.fn(async () => ({})),
    getCheckpointReadUrl: vi.fn(async () => 'https://blob'),
  });
  _require.cache[DB_PATH] = fakeMod(DB_PATH, { query: dbQuery, default: { query: dbQuery } });
}

function buildApp() {
  injectMocks();
  delete _require.cache[INSIGHTS_ROUTER];
  const insights = _require(INSIGHTS_ROUTER);
  const app = express();
  app.use(express.json());
  app.use('/api/insights', insights.default || insights);
  return app;
}

async function api(app, method, url, body = null) {
  const opts = { method, url };
  if (body !== null) { opts.payload = JSON.stringify(body); opts.headers = { 'content-type': 'application/json' }; }
  const res = await inject(app, opts);
  let parsed = null;
  try { parsed = res.json(); } catch { parsed = res.payload; }
  return { status: res.statusCode, body: parsed };
}

const SURVEY_ROW = { id: 's1', title: 'S1', questions: [], org_id: 'o1', status: 'active', created_by: 'u1', response_count: 5000 };

beforeEach(() => {
  checkCreditsImpl = async () => ({ ok: true, available: 1000, required: 20 });
  triggerBackfillImpl = async () => ({ ok: true });
  dbQuery = vi.fn(async (text) => {
    if (text.includes('FROM surveys')) return { rows: [SURVEY_ROW] };
    if (text.includes("run_type = 'topic_backfill' AND status = 'running'")) return { rows: [] };
    if (text.startsWith('INSERT INTO agent_runs')) return { rows: [{ id: 'run-1' }] };
    return { rows: [] };
  });
});

describe('POST /api/insights/:surveyId/topics/backfill', () => {
  it('202 happy path returns run_id + status started and calls CrystalOS', async () => {
    const { status, body } = await api(buildApp(), 'POST', '/api/insights/s1/topics/backfill');
    expect(status).toBe(202);
    expect(body.run_id).toBe('run-1');
    expect(body.status).toBe('started');
    expect(triggerBackfillSpy).toHaveBeenCalledTimes(1);
    expect(triggerBackfillSpy.mock.calls[0][0]).toMatchObject({ surveyId: 's1', orgId: 'o1', runId: 'run-1' });
  });

  it('inserts an agent_runs row with run_type=topic_backfill', async () => {
    await api(buildApp(), 'POST', '/api/insights/s1/topics/backfill');
    const insertCall = dbQuery.mock.calls.find(c => c[0].startsWith('INSERT INTO agent_runs'));
    expect(insertCall).toBeTruthy();
    expect(insertCall[0]).toContain("'topic_backfill'");
  });

  it('debits credits for the topic_backfill action', async () => {
    await api(buildApp(), 'POST', '/api/insights/s1/topics/backfill');
    expect(debitCreditsSpy).toHaveBeenCalledTimes(1);
    expect(debitCreditsSpy.mock.calls[0][1]).toMatchObject({ actionType: 'topic_backfill' });
  });

  it('402 when credits insufficient', async () => {
    checkCreditsImpl = async () => ({ ok: false, available: 1, required: 20 });
    const { status, body } = await api(buildApp(), 'POST', '/api/insights/s1/topics/backfill');
    expect(status).toBe(402);
    expect(body.code).toBe('INSUFFICIENT_CREDITS');
    expect(triggerBackfillSpy).not.toHaveBeenCalled();
  });

  it('429 when a backfill is already running for this survey', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('FROM surveys')) return { rows: [SURVEY_ROW] };
      if (text.includes("run_type = 'topic_backfill' AND status = 'running'")) return { rows: [{ id: 'run-existing' }] };
      return { rows: [] };
    });
    const { status, body } = await api(buildApp(), 'POST', '/api/insights/s1/topics/backfill');
    expect(status).toBe(429);
    expect(body.run_id).toBe('run-existing');
    expect(triggerBackfillSpy).not.toHaveBeenCalled();
  });

  it('429 on a concurrent-insert race (both requests pass the pre-check, DB unique index catches the second)', async () => {
    // Regression test (2026-07-13, independent review finding): the pre-check
    // SELECT + INSERT is a check-then-act race — two near-simultaneous
    // requests can both see zero running rows. The migration adds
    // uq_agent_runs_topic_backfill_inflight so the SECOND insert fails with a
    // real Postgres 23505; the route must catch that and attach to the
    // winner's run_id instead of 500ing or starting a second (double-billed)
    // job.
    const conflictErr = Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
    // First call to the running-check query: pre-check guard (sees nothing
    // running yet — the race). Second call: post-conflict lookup (now sees
    // the winner's row, inserted between the two).
    let preCheckCalls = 0;
    dbQuery = vi.fn(async (text) => {
      if (text.includes('FROM surveys')) return { rows: [SURVEY_ROW] };
      if (text.includes("run_type = 'topic_backfill' AND status = 'running'")) {
        preCheckCalls += 1;
        return preCheckCalls === 1 ? { rows: [] } : { rows: [{ id: 'run-winner' }] };
      }
      if (text.startsWith('INSERT INTO agent_runs')) throw conflictErr;
      return { rows: [] };
    });

    const { status, body } = await api(buildApp(), 'POST', '/api/insights/s1/topics/backfill');
    expect(status).toBe(429);
    expect(body.run_id).toBe('run-winner');
    expect(triggerBackfillSpy).not.toHaveBeenCalled();
    expect(debitCreditsSpy).not.toHaveBeenCalled();
  });

  it('404 when survey not found', async () => {
    dbQuery = vi.fn(async () => ({ rows: [] }));
    const { status } = await api(buildApp(), 'POST', '/api/insights/missing/topics/backfill');
    expect(status).toBe(404);
  });

  it('still returns 202 even if the CrystalOS call itself later fails (fire-and-forget)', async () => {
    triggerBackfillImpl = async () => { throw new Error('agents down'); };
    const { status, body } = await api(buildApp(), 'POST', '/api/insights/s1/topics/backfill');
    expect(status).toBe(202);
    expect(body.status).toBe('started');
  });
});
