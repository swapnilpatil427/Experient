import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import inject from 'light-my-request';
import express from 'express';

const __dirname = dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);

const AUTH_PATH    = _require.resolve(resolve(__dirname, '../middleware/auth'));
const ROLE_PATH    = _require.resolve(resolve(__dirname, '../middleware/requireRole'));
const DB_PATH      = _require.resolve(resolve(__dirname, '../lib/db'));
const CLAIMS_PATH  = _require.resolve(resolve(__dirname, '../lib/clerkClaims'));
const CLERK_PATH   = _require.resolve('@clerk/backend');
const LEDGER_PATH  = _require.resolve(resolve(__dirname, '../lib/creditLedger'));
const INSIGHTS_ROUTER = _require.resolve(resolve(__dirname, '../routes/insights'));
const ORGS_ROUTER     = _require.resolve(resolve(__dirname, '../routes/orgs'));

let dbQuery;
// Role returned by getOrgClaims for the (mocked) verified token.
let mockRole;

function fakeMod(id, exports) { return { id, filename: id, loaded: true, exports, children: [] }; }

function injectMocks() {
  _require.cache[AUTH_PATH] = fakeMod(AUTH_PATH, {
    // DEV_MODE false so resolveOrgRole / requireRole exercise the real role path.
    DEV_MODE: false,
    requireAuth: (req, _res, next) => { req.orgId = 'o1'; req.userId = 'u1'; req.headers.authorization = 'Bearer faketoken'; next(); },
  });
  // Mock requireRole so PATCH org-defaults role gate is driven by mockRole.
  _require.cache[ROLE_PATH] = fakeMod(ROLE_PATH, {
    requireRole: (min) => (req, res, next) => {
      if (min === 'admin' && mockRole !== 'org:admin') {
        res.status(403).json({ error: 'Insufficient role', required: 'org:admin', current: mockRole });
        return;
      }
      next();
    },
  });
  _require.cache[CLERK_PATH]  = fakeMod(CLERK_PATH, { verifyToken: vi.fn(async () => ({ sub: 'u1' })) });
  _require.cache[CLAIMS_PATH] = fakeMod(CLAIMS_PATH, { getOrgClaims: () => ({ orgId: 'o1', orgRole: mockRole, orgSlug: null }) });
  _require.cache[LEDGER_PATH] = fakeMod(LEDGER_PATH, {
    checkCredits: vi.fn(async () => ({ ok: true })),
    debitCredits: vi.fn(async () => ({})),
  });
  _require.cache[DB_PATH] = fakeMod(DB_PATH, { query: dbQuery, default: { query: dbQuery } });
}

function buildApp() {
  injectMocks();
  delete _require.cache[INSIGHTS_ROUTER];
  delete _require.cache[ORGS_ROUTER];
  const insights = _require(INSIGHTS_ROUTER);
  const orgs = _require(ORGS_ROUTER);
  const app = express();
  app.use(express.json());
  app.use('/api/insights', insights.default || insights);
  app.use('/api/orgs', orgs.default || orgs);
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

// A survey row owned by a different user (so ownership is admin-only unless overridden).
const SURVEY_ROW = { id: 's1', title: 'S1', questions: [], org_id: 'o1', status: 'active', created_by: 'someone-else', response_count: 3 };

beforeEach(() => {
  mockRole = 'org:admin';
  dbQuery = vi.fn(async () => ({ rows: [] }));
});

describe('GET /api/insights/:surveyId/settings', () => {
  it('returns merged effective config (survey > org > platform) with config_hash', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('FROM surveys')) return { rows: [SURVEY_ROW] };
      if (text.includes('FROM survey_insight_settings')) {
        return { rows: [{ stream_response_threshold: 25, config_version: 4 }] };
      }
      if (text.includes('FROM org_insight_defaults')) {
        return { rows: [{ prior_checkpoint_lookback: 8 }] };
      }
      return { rows: [] };
    });
    const { status, body } = await api(buildApp(), 'GET', '/api/insights/s1/settings');
    expect(status).toBe(200);
    // survey override wins
    expect(body.effective.stream_response_threshold).toBe(25);
    // org default applies where survey is null
    expect(body.effective.prior_checkpoint_lookback).toBe(8);
    // platform constant where neither layer set it
    expect(body.effective.refresh_lookback_days).toBe(30);
    // response_tagging_batch_size platform default (independent of stream_response_threshold)
    expect(body.effective.response_tagging_batch_size).toBe(1);
    // topic_discovery_candidate_threshold platform default is env-tiered (AGENTS_ENV
    // unset in tests -> dev tier -> 10), mirroring crystalos/lib/constants.py
    expect(body.effective.topic_discovery_candidate_threshold).toBe(10);
    expect(body.effective.topic_discovery_min_cluster_size).toBe(5);
    expect(body.survey_overrides.stream_response_threshold).toBe(25);
    expect(body.org_defaults.prior_checkpoint_lookback).toBe(8);
    expect(typeof body.config_hash).toBe('string');
    expect(body.config_hash).toHaveLength(64);
    expect(body.editable).toBe(true); // admin
  });

  it('marks editable=false for a non-admin non-owner', async () => {
    mockRole = 'org:viewer';
    dbQuery = vi.fn(async (text) => {
      if (text.includes('FROM surveys')) return { rows: [SURVEY_ROW] };
      return { rows: [] };
    });
    const { status, body } = await api(buildApp(), 'GET', '/api/insights/s1/settings');
    expect(status).toBe(200);
    expect(body.editable).toBe(false);
  });

  it('404s when the survey is not found', async () => {
    dbQuery = vi.fn(async () => ({ rows: [] }));
    const { status } = await api(buildApp(), 'GET', '/api/insights/missing/settings');
    expect(status).toBe(404);
  });
});

describe('PATCH /api/insights/:surveyId/settings', () => {
  it('admin can update settings (UPSERT)', async () => {
    const seen = [];
    dbQuery = vi.fn(async (text, params) => {
      seen.push(text);
      if (text.includes('FROM surveys')) return { rows: [SURVEY_ROW] };
      if (text.startsWith('INSERT INTO survey_insight_settings')) {
        return { rows: [{ stream_response_threshold: 15, prior_checkpoint_lookback: 8, config_version: 2 }] };
      }
      return { rows: [] };
    });
    const { status, body } = await api(buildApp(), 'PATCH', '/api/insights/s1/settings', {
      stream_response_threshold: 15, prior_checkpoint_lookback: 8,
    });
    expect(status).toBe(200);
    expect(body.survey_overrides.stream_response_threshold).toBe(15);
    expect(body.config_version).toBe(2);
    expect(seen.some(t => t.startsWith('INSERT INTO survey_insight_settings'))).toBe(true);
    expect(seen.some(t => t.includes('ON CONFLICT (survey_id)'))).toBe(true);
  });

  it('survey owner (non-admin) can update their own survey', async () => {
    mockRole = 'org:viewer';
    dbQuery = vi.fn(async (text) => {
      if (text.includes('FROM surveys')) return { rows: [{ ...SURVEY_ROW, created_by: 'u1' }] };
      if (text.startsWith('INSERT INTO survey_insight_settings')) {
        return { rows: [{ stream_response_threshold: 12, config_version: 2 }] };
      }
      return { rows: [] };
    });
    const { status } = await api(buildApp(), 'PATCH', '/api/insights/s1/settings', { stream_response_threshold: 12 });
    expect(status).toBe(200);
  });

  it('viewer who is not the owner gets 403', async () => {
    mockRole = 'org:viewer';
    dbQuery = vi.fn(async (text) => {
      if (text.includes('FROM surveys')) return { rows: [SURVEY_ROW] };
      return { rows: [] };
    });
    const { status } = await api(buildApp(), 'PATCH', '/api/insights/s1/settings', { stream_response_threshold: 12 });
    expect(status).toBe(403);
  });

  it('rejects out-of-range values with 400', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('FROM surveys')) return { rows: [SURVEY_ROW] };
      return { rows: [] };
    });
    // stream_response_threshold range is 5–500
    const { status } = await api(buildApp(), 'PATCH', '/api/insights/s1/settings', { stream_response_threshold: 2 });
    expect(status).toBe(400);
  });

  it('rejects credit cost above the platform ceiling with 400', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('FROM surveys')) return { rows: [SURVEY_ROW] };
      return { rows: [] };
    });
    const { status } = await api(buildApp(), 'PATCH', '/api/insights/s1/settings', { credit_cost_manual_expert: 999 });
    expect(status).toBe(400);
  });

  it('rejects unknown setting keys with 400 (strict schema)', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('FROM surveys')) return { rows: [SURVEY_ROW] };
      return { rows: [] };
    });
    const { status } = await api(buildApp(), 'PATCH', '/api/insights/s1/settings', { bogus_key: 1 });
    expect(status).toBe(400);
  });

  // ── response_tagging_batch_size (2026-07-04) ──────────────────────────────
  it('admin can update response_tagging_batch_size', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('FROM surveys')) return { rows: [SURVEY_ROW] };
      if (text.startsWith('INSERT INTO survey_insight_settings')) {
        return { rows: [{ response_tagging_batch_size: 5, config_version: 2 }] };
      }
      return { rows: [] };
    });
    const { status, body } = await api(buildApp(), 'PATCH', '/api/insights/s1/settings', {
      response_tagging_batch_size: 5,
    });
    expect(status).toBe(200);
    expect(body.survey_overrides.response_tagging_batch_size).toBe(5);
  });

  it('rejects response_tagging_batch_size above 10 with 400', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('FROM surveys')) return { rows: [SURVEY_ROW] };
      return { rows: [] };
    });
    const { status } = await api(buildApp(), 'PATCH', '/api/insights/s1/settings', {
      response_tagging_batch_size: 11,
    });
    expect(status).toBe(400);
  });

  it('rejects response_tagging_batch_size below 1 with 400', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('FROM surveys')) return { rows: [SURVEY_ROW] };
      return { rows: [] };
    });
    const { status } = await api(buildApp(), 'PATCH', '/api/insights/s1/settings', {
      response_tagging_batch_size: 0,
    });
    expect(status).toBe(400);
  });

  // ── topic_discovery_candidate_threshold / topic_discovery_min_cluster_size (2026-07-06) ──
  it('admin can update topic_discovery_candidate_threshold', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('FROM surveys')) return { rows: [SURVEY_ROW] };
      if (text.startsWith('INSERT INTO survey_insight_settings')) {
        return { rows: [{ topic_discovery_candidate_threshold: 30, config_version: 2 }] };
      }
      return { rows: [] };
    });
    const { status, body } = await api(buildApp(), 'PATCH', '/api/insights/s1/settings', {
      topic_discovery_candidate_threshold: 30,
    });
    expect(status).toBe(200);
    expect(body.survey_overrides.topic_discovery_candidate_threshold).toBe(30);
  });

  it('rejects topic_discovery_candidate_threshold below 5 with 400', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('FROM surveys')) return { rows: [SURVEY_ROW] };
      return { rows: [] };
    });
    const { status } = await api(buildApp(), 'PATCH', '/api/insights/s1/settings', {
      topic_discovery_candidate_threshold: 4,
    });
    expect(status).toBe(400);
  });

  it('rejects topic_discovery_candidate_threshold above 100 with 400', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('FROM surveys')) return { rows: [SURVEY_ROW] };
      return { rows: [] };
    });
    const { status } = await api(buildApp(), 'PATCH', '/api/insights/s1/settings', {
      topic_discovery_candidate_threshold: 101,
    });
    expect(status).toBe(400);
  });

  it('admin can update topic_discovery_min_cluster_size independently of candidate_threshold', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('FROM surveys')) return { rows: [SURVEY_ROW] };
      if (text.startsWith('INSERT INTO survey_insight_settings')) {
        return { rows: [{ topic_discovery_min_cluster_size: 8, config_version: 2 }] };
      }
      return { rows: [] };
    });
    const { status, body } = await api(buildApp(), 'PATCH', '/api/insights/s1/settings', {
      topic_discovery_min_cluster_size: 8,
    });
    expect(status).toBe(200);
    expect(body.survey_overrides.topic_discovery_min_cluster_size).toBe(8);
  });

  it('rejects topic_discovery_min_cluster_size below 2 with 400', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('FROM surveys')) return { rows: [SURVEY_ROW] };
      return { rows: [] };
    });
    const { status } = await api(buildApp(), 'PATCH', '/api/insights/s1/settings', {
      topic_discovery_min_cluster_size: 1,
    });
    expect(status).toBe(400);
  });

  it('rejects topic_discovery_min_cluster_size above 20 with 400', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('FROM surveys')) return { rows: [SURVEY_ROW] };
      return { rows: [] };
    });
    const { status } = await api(buildApp(), 'PATCH', '/api/insights/s1/settings', {
      topic_discovery_min_cluster_size: 21,
    });
    expect(status).toBe(400);
  });
});

describe('org insight defaults', () => {
  it('GET returns defaults for the caller\'s own org', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('FROM org_insight_defaults')) {
        return { rows: [{ stream_response_threshold: 20, updated_by: 'admin1', updated_at: 't' }] };
      }
      return { rows: [] };
    });
    const { status, body } = await api(buildApp(), 'GET', '/api/orgs/o1/insight-defaults');
    expect(status).toBe(200);
    expect(body.defaults.stream_response_threshold).toBe(20);
    // a key not set returns null
    expect(body.defaults.prior_checkpoint_lookback).toBeNull();
  });

  it('GET 403s for a different org', async () => {
    const { status } = await api(buildApp(), 'GET', '/api/orgs/other-org/insight-defaults');
    expect(status).toBe(403);
  });

  it('PATCH as admin upserts org defaults', async () => {
    const seen = [];
    dbQuery = vi.fn(async (text) => {
      seen.push(text);
      if (text.startsWith('INSERT INTO org_insight_defaults')) {
        return { rows: [{ stream_response_threshold: 30, updated_by: 'u1' }] };
      }
      return { rows: [] };
    });
    const { status, body } = await api(buildApp(), 'PATCH', '/api/orgs/o1/insight-defaults', { stream_response_threshold: 30 });
    expect(status).toBe(200);
    expect(body.defaults.stream_response_threshold).toBe(30);
    expect(seen.some(t => t.includes('ON CONFLICT (org_id)'))).toBe(true);
  });

  it('PATCH as viewer is 403 (admin-only)', async () => {
    mockRole = 'org:viewer';
    const { status } = await api(buildApp(), 'PATCH', '/api/orgs/o1/insight-defaults', { stream_response_threshold: 30 });
    expect(status).toBe(403);
  });

  it('PATCH rejects out-of-range default with 400', async () => {
    const { status } = await api(buildApp(), 'PATCH', '/api/orgs/o1/insight-defaults', { stream_response_threshold: 1 });
    expect(status).toBe(400);
  });

  it('PATCH as admin upserts org-level response_tagging_batch_size', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.startsWith('INSERT INTO org_insight_defaults')) {
        return { rows: [{ response_tagging_batch_size: 8, updated_by: 'u1' }] };
      }
      return { rows: [] };
    });
    const { status, body } = await api(buildApp(), 'PATCH', '/api/orgs/o1/insight-defaults', {
      response_tagging_batch_size: 8,
    });
    expect(status).toBe(200);
    expect(body.defaults.response_tagging_batch_size).toBe(8);
  });

  it('PATCH rejects out-of-range org-level response_tagging_batch_size with 400', async () => {
    const { status } = await api(buildApp(), 'PATCH', '/api/orgs/o1/insight-defaults', {
      response_tagging_batch_size: 20,
    });
    expect(status).toBe(400);
  });

  it('PATCH as admin upserts org-level topic_discovery_candidate_threshold', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.startsWith('INSERT INTO org_insight_defaults')) {
        return { rows: [{ topic_discovery_candidate_threshold: 40, updated_by: 'u1' }] };
      }
      return { rows: [] };
    });
    const { status, body } = await api(buildApp(), 'PATCH', '/api/orgs/o1/insight-defaults', {
      topic_discovery_candidate_threshold: 40,
    });
    expect(status).toBe(200);
    expect(body.defaults.topic_discovery_candidate_threshold).toBe(40);
  });

  it('PATCH rejects out-of-range org-level topic_discovery_candidate_threshold with 400', async () => {
    const { status } = await api(buildApp(), 'PATCH', '/api/orgs/o1/insight-defaults', {
      topic_discovery_candidate_threshold: 200,
    });
    expect(status).toBe(400);
  });

  it('PATCH as admin upserts org-level topic_discovery_min_cluster_size', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.startsWith('INSERT INTO org_insight_defaults')) {
        return { rows: [{ topic_discovery_min_cluster_size: 10, updated_by: 'u1' }] };
      }
      return { rows: [] };
    });
    const { status, body } = await api(buildApp(), 'PATCH', '/api/orgs/o1/insight-defaults', {
      topic_discovery_min_cluster_size: 10,
    });
    expect(status).toBe(200);
    expect(body.defaults.topic_discovery_min_cluster_size).toBe(10);
  });

  it('PATCH rejects out-of-range org-level topic_discovery_min_cluster_size with 400', async () => {
    const { status } = await api(buildApp(), 'PATCH', '/api/orgs/o1/insight-defaults', {
      topic_discovery_min_cluster_size: 1,
    });
    expect(status).toBe(400);
  });

  // ── Tag Report — max_surveys_per_tag_report (TRACKER.md §1 Task 11) ────────
  // This key lives on org_insight_defaults but has no survey_insight_settings
  // equivalent — kept out of the shared settingFields/ORG_DEFAULT_KEYS mirror
  // and added as a standalone schema field (see schemas/insightSettings.ts).

  it('GET includes max_surveys_per_tag_report in defaults (null when unset)', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('FROM org_insight_defaults')) return { rows: [{ stream_response_threshold: 20 }] };
      return { rows: [] };
    });
    const { status, body } = await api(buildApp(), 'GET', '/api/orgs/o1/insight-defaults');
    expect(status).toBe(200);
    expect(body.defaults.max_surveys_per_tag_report).toBeNull();
  });

  it('PATCH as admin can set max_surveys_per_tag_report', async () => {
    const seen = [];
    dbQuery = vi.fn(async (text) => {
      seen.push(text);
      if (text.startsWith('INSERT INTO org_insight_defaults')) {
        return { rows: [{ max_surveys_per_tag_report: 12, updated_by: 'u1' }] };
      }
      return { rows: [] };
    });
    const { status, body } = await api(buildApp(), 'PATCH', '/api/orgs/o1/insight-defaults', { max_surveys_per_tag_report: 12 });
    expect(status).toBe(200);
    expect(body.defaults.max_surveys_per_tag_report).toBe(12);
    expect(seen.some((t) => t.includes('max_surveys_per_tag_report'))).toBe(true);
  });

  it('PATCH accepts null to clear max_surveys_per_tag_report', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.startsWith('INSERT INTO org_insight_defaults')) return { rows: [{ max_surveys_per_tag_report: null }] };
      return { rows: [] };
    });
    const { status, body } = await api(buildApp(), 'PATCH', '/api/orgs/o1/insight-defaults', { max_surveys_per_tag_report: null });
    expect(status).toBe(200);
    expect(body.defaults.max_surveys_per_tag_report).toBeNull();
  });

  it('PATCH rejects max_surveys_per_tag_report out of range (> 20) with 400', async () => {
    const { status } = await api(buildApp(), 'PATCH', '/api/orgs/o1/insight-defaults', { max_surveys_per_tag_report: 21 });
    expect(status).toBe(400);
  });

  it('PATCH rejects max_surveys_per_tag_report below range (< 1) with 400', async () => {
    const { status } = await api(buildApp(), 'PATCH', '/api/orgs/o1/insight-defaults', { max_surveys_per_tag_report: 0 });
    expect(status).toBe(400);
  });

  it('PATCH as viewer setting max_surveys_per_tag_report is 403 (admin-only, same gate)', async () => {
    mockRole = 'org:viewer';
    const { status } = await api(buildApp(), 'PATCH', '/api/orgs/o1/insight-defaults', { max_surveys_per_tag_report: 10 });
    expect(status).toBe(403);
  });
});
