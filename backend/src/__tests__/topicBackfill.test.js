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
    if (text.includes('untagged_count')) return { rows: [{ untagged_count: 5000 }] };
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

  it('debits credits for the topic_backfill action, scaled to the backlog size', async () => {
    // Regression test (2026-07-13, pricing review): backlog is 5,000 in the
    // default mock (tier 2) — must charge 40, not the old flat 20.
    await api(buildApp(), 'POST', '/api/insights/s1/topics/backfill');
    expect(debitCreditsSpy).toHaveBeenCalledTimes(1);
    expect(debitCreditsSpy.mock.calls[0][1]).toMatchObject({ actionType: 'topic_backfill', credits: 40 });
  });

  it('charges more for a larger backlog and less for a smaller one', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('FROM surveys')) return { rows: [SURVEY_ROW] };
      if (text.includes("run_type = 'topic_backfill' AND status = 'running'")) return { rows: [] };
      if (text.includes('untagged_count')) return { rows: [{ untagged_count: 100_000 }] };
      if (text.startsWith('INSERT INTO agent_runs')) return { rows: [{ id: 'run-1' }] };
      return { rows: [] };
    });
    await api(buildApp(), 'POST', '/api/insights/s1/topics/backfill');
    expect(debitCreditsSpy.mock.calls[0][1]).toMatchObject({ credits: 450 });

    dbQuery = vi.fn(async (text) => {
      if (text.includes('FROM surveys')) return { rows: [SURVEY_ROW] };
      if (text.includes("run_type = 'topic_backfill' AND status = 'running'")) return { rows: [] };
      if (text.includes('untagged_count')) return { rows: [{ untagged_count: 20 }] };
      if (text.startsWith('INSERT INTO agent_runs')) return { rows: [{ id: 'run-2' }] };
      return { rows: [] };
    });
    await api(buildApp(), 'POST', '/api/insights/s1/topics/backfill');
    expect(debitCreditsSpy.mock.calls[0][1]).toMatchObject({ credits: 15 });
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
      if (text.includes('untagged_count')) return { rows: [{ untagged_count: 5000 }] };
      if (text.startsWith('INSERT INTO agent_runs')) throw conflictErr;
      return { rows: [] };
    });

    const { status, body } = await api(buildApp(), 'POST', '/api/insights/s1/topics/backfill');
    expect(status).toBe(429);
    expect(body.run_id).toBe('run-winner');
    expect(triggerBackfillSpy).not.toHaveBeenCalled();
    expect(debitCreditsSpy).not.toHaveBeenCalled();
  });

  it('skips starting a job and charging credits when nothing is untagged, and flags bootstrap_pending when the survey has no topic centroids yet', async () => {
    // Regression test (2026-07-13, independent sales/product review finding):
    // without this, a customer double-checking "did everything already get
    // tagged?" pays the full flat cost for an instant no-op every time.
    //
    // Also a regression test for the false-positive "everything is already
    // tagged" bug: ai_enriched_at IS NULL only tracks sentiment/emotion/effort
    // scoring, not whether topics were ever assigned. A survey that's fully
    // sentiment-tagged but has never had its first topic-bootstrap run (no
    // survey_topic_centroids row) must surface bootstrap_pending:true here —
    // otherwise this pre-check short-circuits BEFORE CrystalOS's own
    // bootstrap_pending disclosure (topic_backfill.py::_has_topics_yet) ever
    // runs, and the frontend wrongly reports full completion.
    dbQuery = vi.fn(async (text) => {
      if (text.includes('FROM surveys')) return { rows: [SURVEY_ROW] };
      if (text.includes("run_type = 'topic_backfill' AND status = 'running'")) return { rows: [] };
      if (text.includes('untagged_count')) return { rows: [{ untagged_count: 0 }] };
      if (text.includes('FROM survey_topic_centroids')) return { rows: [] };
      return { rows: [] };
    });

    const { status, body } = await api(buildApp(), 'POST', '/api/insights/s1/topics/backfill');
    expect(status).toBe(200);
    expect(body.status).toBe('nothing_to_backfill');
    expect(body.bootstrap_pending).toBe(true);
    expect(triggerBackfillSpy).not.toHaveBeenCalled();
    expect(debitCreditsSpy).not.toHaveBeenCalled();
    expect(dbQuery.mock.calls.some(c => c[0].startsWith('INSERT INTO agent_runs'))).toBe(false);
  });

  it('does not flag bootstrap_pending when nothing is untagged AND the survey already has topic centroids', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('FROM surveys')) return { rows: [SURVEY_ROW] };
      if (text.includes("run_type = 'topic_backfill' AND status = 'running'")) return { rows: [] };
      if (text.includes('untagged_count')) return { rows: [{ untagged_count: 0 }] };
      if (text.includes('FROM survey_topic_centroids')) return { rows: [{ 1: 1 }] };
      return { rows: [] };
    });

    const { status, body } = await api(buildApp(), 'POST', '/api/insights/s1/topics/backfill');
    expect(status).toBe(200);
    expect(body.status).toBe('nothing_to_backfill');
    expect(body.bootstrap_pending).toBe(false);
  });

  it('counts quarantined responses (enriched but missing sentiment/emotion/effort) as untagged too', async () => {
    // Regression test (2026-07-14): a response quarantined after repeatedly
    // failing automatic tagging has ai_enriched_at set but ai_sentiment/
    // ai_emotion/ai_effort_score left NULL. The old query (ai_enriched_at IS
    // NULL alone) never counted these, so a survey with quarantined responses
    // but zero never-touched ones would report "nothing to backfill" even
    // though CrystalOS's own broadened count (topic_backfill.py::
    // _count_untagged, called with include_retriable=True) would find real
    // work. The two queries must stay in exact sync.
    let capturedSql = null;
    dbQuery = vi.fn(async (text) => {
      if (text.includes('FROM surveys')) return { rows: [SURVEY_ROW] };
      if (text.includes("run_type = 'topic_backfill' AND status = 'running'")) return { rows: [] };
      if (text.includes('untagged_count')) {
        capturedSql = text;
        return { rows: [{ untagged_count: 1 }] };
      }
      if (text.startsWith('INSERT INTO agent_runs')) return { rows: [{ id: 'run-1' }] };
      return { rows: [] };
    });

    const { status, body } = await api(buildApp(), 'POST', '/api/insights/s1/topics/backfill');
    expect(status).toBe(202);
    expect(body.run_id).toBe('run-1');
    expect(capturedSql).toContain('ai_enriched_at IS NULL');
    expect(capturedSql).toContain('ai_no_scorable_text = FALSE');
    expect(capturedSql).toContain('ai_sentiment IS NULL OR ai_emotion IS NULL OR ai_effort_score IS NULL');
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
