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

function fakeMod(id, exports) { return { id, filename: id, loaded: true, exports, children: [] }; }

function injectMocks() {
  _require.cache[AUTH_PATH] = fakeMod(AUTH_PATH, {
    DEV_MODE: true,
    requireAuth: (req, _res, next) => { req.orgId = 'o1'; req.userId = 'u1'; next(); },
  });
  _require.cache[LEDGER_PATH] = fakeMod(LEDGER_PATH, {
    checkCredits: vi.fn(async () => ({ ok: true })),
    debitCredits: vi.fn(async () => ({})),
  });
  _require.cache[AGENTS_PATH] = fakeMod(AGENTS_PATH, {
    triggerManualInsightRun: vi.fn(async () => ({})),
    getCheckpointBlob: vi.fn(async () => ({ schema_version: 2, executive_summary: 'hi' })),
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

async function api(app, method, url) {
  const res = await inject(app, { method, url });
  let parsed = null;
  try { parsed = res.json(); } catch { parsed = res.payload; }
  return { status: res.statusCode, body: parsed };
}

const SURVEY_ROW = { id: 's1', title: 'S1', questions: [], org_id: 'o1', status: 'active', created_by: 'u1', response_count: 50 };

const V2_ROW = {
  id: 'cp-12', checkpoint_number: 12, lane: 'automated', run_mode: 'automated_incremental',
  trigger: 'stream', nps_at_checkpoint: '42.0', csat_at_checkpoint: null, ces_at_checkpoint: null,
  delta_from_prior: { nps_delta: -3.2 }, meaningful_delta: true, created_at: '2026-06-25T00:00:00Z',
  created_by: 'system:stream', report_label: null, window_start: null, window_end: null,
  lineage_json: { config_hash: 'abc' }, report_blob_ref: 'blob://cp-12',
};

beforeEach(() => {
  dbQuery = vi.fn(async () => ({ rows: [] }));
});

describe('GET /api/insights/:surveyId/trail', () => {
  it('returns v2 checkpoints with number/nps/created_at coerced + reports + next_cursor', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('FROM surveys')) return { rows: [SURVEY_ROW] };
      if (text.includes('FROM insight_checkpoints_v2')) return { rows: [V2_ROW] };
      if (text.includes('FROM insight_reports')) {
        return { rows: [{ id: 'r1', run_mode: 'manual_expert', label: 'Q2', trust_score_avg: '80.5' }] };
      }
      return { rows: [] };
    });
    const { status, body } = await api(buildApp(), 'GET', '/api/insights/s1/trail?limit=5');
    expect(status).toBe(200);
    expect(body.checkpoints).toHaveLength(1);
    const cp = body.checkpoints[0];
    expect(cp.number).toBe(12);
    expect(cp.nps).toBe(42.0);
    expect(typeof cp.nps).toBe('number');
    expect(cp.created_at).toBe('2026-06-25T00:00:00Z');
    expect(cp.meaningful).toBe(true);
    expect(body.reports).toHaveLength(1);
    expect(body.reports[0].trust_score_avg).toBe(80.5);
    // only 1 row < limit 5 → no next cursor
    expect(body.next_cursor).toBeNull();
  });

  it('lane=manual filters and includes manual reports', async () => {
    const seen = [];
    dbQuery = vi.fn(async (text, params) => {
      seen.push({ text, params });
      if (text.includes('FROM surveys')) return { rows: [SURVEY_ROW] };
      if (text.includes('FROM insight_checkpoints_v2')) return { rows: [{ ...V2_ROW, lane: 'manual', run_mode: 'manual_expert' }] };
      if (text.includes('FROM insight_reports')) return { rows: [{ id: 'r1', run_mode: 'manual_quick' }] };
      return { rows: [] };
    });
    const { status, body } = await api(buildApp(), 'GET', '/api/insights/s1/trail?lane=manual');
    expect(status).toBe(200);
    expect(body.reports).toHaveLength(1);
    // v2 query carried the lane filter
    const v2call = seen.find(s => s.text.includes('FROM insight_checkpoints_v2'));
    expect(v2call.params).toContain('manual');
  });

  it('falls back to legacy survey_insight_checkpoints when v2 is empty', async () => {
    const seen = [];
    dbQuery = vi.fn(async (text) => {
      seen.push(text);
      if (text.includes('FROM surveys')) return { rows: [SURVEY_ROW] };
      if (text.includes('FROM insight_checkpoints_v2')) return { rows: [] };
      if (text.includes('FROM survey_insight_checkpoints')) {
        return { rows: [{ id: 'leg-3', checkpoint_number: 3, trigger: 'responses', nps_at_checkpoint: '40.0', created_at: 't', created_by: 'system:stream', meaningful_delta: false }] };
      }
      return { rows: [] };
    });
    const { status, body } = await api(buildApp(), 'GET', '/api/insights/s1/trail');
    expect(status).toBe(200);
    expect(seen.some(t => t.includes('FROM survey_insight_checkpoints'))).toBe(true);
    expect(body.checkpoints).toHaveLength(1);
    expect(body.checkpoints[0].number).toBe(3);
    expect(body.checkpoints[0].nps).toBe(40.0);
    expect(body.checkpoints[0].lane).toBe('automated');
  });
});

describe('GET /api/insights/:surveyId/trail/:checkpointId', () => {
  it('returns node + lineage + delta + blob document', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('FROM surveys')) return { rows: [SURVEY_ROW] };
      if (text.includes('FROM insight_checkpoints_v2')) return { rows: [V2_ROW] };
      return { rows: [] };
    });
    const { status, body } = await api(buildApp(), 'GET', '/api/insights/s1/trail/cp-12');
    expect(status).toBe(200);
    expect(body.checkpoint.number).toBe(12);
    expect(body.lineage_json.config_hash).toBe('abc');
    expect(body.delta_from_prior.nps_delta).toBe(-3.2);
    // dev mode → inline blob document
    expect(body.document.executive_summary).toBe('hi');
    expect(body.source).toBe('v2');
  });

  it('404 when checkpoint not found in either table', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('FROM surveys')) return { rows: [SURVEY_ROW] };
      return { rows: [] };
    });
    const { status } = await api(buildApp(), 'GET', '/api/insights/s1/trail/nope');
    expect(status).toBe(404);
  });
});

describe('GET /api/insights/:surveyId/trail/:id/compare/:otherId', () => {
  it('returns both nodes + metric_deltas + topic_diff', async () => {
    const A = { ...V2_ROW, id: 'cp-11', checkpoint_number: 11, nps_at_checkpoint: '45.0',
      delta_from_prior: { topic_changes: { emerged: ['Login'], persisted: ['Billing'] } } };
    const B = { ...V2_ROW, id: 'cp-12', checkpoint_number: 12, nps_at_checkpoint: '42.0',
      delta_from_prior: { topic_changes: { emerged: ['AI features'], persisted: ['Billing'] } } };
    dbQuery = vi.fn(async (text, params) => {
      if (text.includes('FROM surveys')) return { rows: [SURVEY_ROW] };
      if (text.includes('FROM insight_checkpoints_v2')) {
        return { rows: [params[0] === 'cp-11' ? A : B] };
      }
      return { rows: [] };
    });
    const { status, body } = await api(buildApp(), 'GET', '/api/insights/s1/trail/cp-11/compare/cp-12');
    expect(status).toBe(200);
    expect(body.a.number).toBe(11);
    expect(body.b.number).toBe(12);
    // nps delta: 42 - 45 = -3.0
    expect(body.metric_deltas.nps).toBe(-3);
    // B has AI features not in A → added; A has Login not in B → removed
    expect(body.topic_diff.added).toContain('AI features');
    expect(body.topic_diff.removed).toContain('Login');
  });
});

describe('GET /api/insights/:surveyId/reports/:reportId', () => {
  it('returns the report row + document (dev inline blob)', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('FROM surveys')) return { rows: [SURVEY_ROW] };
      if (text.includes('FROM insight_reports')) {
        return { rows: [{ id: 'r1', survey_id: 's1', org_id: 'o1', run_mode: 'manual_expert', status: 'ready', blob_ref: 'blob://r1', trust_score_avg: '78.0' }] };
      }
      return { rows: [] };
    });
    const { status, body } = await api(buildApp(), 'GET', '/api/insights/s1/reports/r1');
    expect(status).toBe(200);
    expect(body.report.id).toBe('r1');
    expect(body.report.trust_score_avg).toBe(78.0);
    expect(body.document.executive_summary).toBe('hi');
  });

  it('404 when report not found', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('FROM surveys')) return { rows: [SURVEY_ROW] };
      return { rows: [] };
    });
    const { status } = await api(buildApp(), 'GET', '/api/insights/s1/reports/missing');
    expect(status).toBe(404);
  });
});

describe('GET /api/insights/:surveyId/checkpoints/:checkpointId/report', () => {
  // Fixed 2026-07-04: this endpoint used to query ONLY survey_insight_checkpoints
  // (legacy) by id, so a v2-sourced checkpointId (as returned by GET /checkpoints,
  // which is v2-first) would 404 here even though the checkpoint exists. Now shares
  // loadCheckpointRow (v2-then-legacy) with GET /trail/:checkpointId.
  it('finds a v2 checkpoint and returns its inline blob in dev', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('FROM insight_checkpoints_v2')) return { rows: [V2_ROW] };
      return { rows: [] };
    });
    const { status, body } = await api(buildApp(), 'GET', '/api/insights/s1/checkpoints/cp-12/report');
    expect(status).toBe(200);
    expect(body.executive_summary).toBe('hi');
  });

  it('falls back to a legacy checkpoint when v2 has no match', async () => {
    const seen = [];
    dbQuery = vi.fn(async (text) => {
      seen.push(text);
      if (text.includes('FROM insight_checkpoints_v2')) return { rows: [] };
      if (text.includes('FROM survey_insight_checkpoints')) {
        return { rows: [{ id: 'leg-3', report_url: 'blob://leg-3' }] };
      }
      return { rows: [] };
    });
    const { status, body } = await api(buildApp(), 'GET', '/api/insights/s1/checkpoints/leg-3/report');
    expect(status).toBe(200);
    expect(body.executive_summary).toBe('hi');
    expect(seen.some(t => t.includes('FROM survey_insight_checkpoints'))).toBe(true);
  });

  it('404s when the checkpoint exists in neither table', async () => {
    dbQuery = vi.fn(async () => ({ rows: [] }));
    const { status, body } = await api(buildApp(), 'GET', '/api/insights/s1/checkpoints/nope/report');
    expect(status).toBe(404);
    expect(body.error).toBe('checkpoint_not_found');
  });

  it('404s with report_not_ready when the row has no blob ref yet', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('FROM insight_checkpoints_v2')) return { rows: [{ ...V2_ROW, report_blob_ref: null }] };
      return { rows: [] };
    });
    const { status, body } = await api(buildApp(), 'GET', '/api/insights/s1/checkpoints/cp-12/report');
    expect(status).toBe(404);
    expect(body.error).toBe('report_not_ready');
  });
});
