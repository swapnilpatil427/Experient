/**
 * Integration tests for routes/org-dashboard.ts (Org Intelligence Dashboard / Command
 * Center — docs/org-dashboard/).
 *
 * Uses the fakeMod/cache-injection pattern established in responses.test.js /
 * survey-groups.test.js (no real DB/Redis connection in this sandbox). Unlike
 * responses.test.js, the logic under test here lives mostly in
 * services/org-metrics.service.ts and lib/alertEngine.ts (not directly in the route
 * file), so this suite also clears THEIR require-cache entries before each app build —
 * otherwise a service module required during an earlier test would keep holding a
 * reference to that earlier test's fake `db` module instead of picking up the current
 * test's `dbQuery` mock.
 *
 * Covers:
 *   - GET  /api/org/dashboard         — happy path (fixture org w/ surveys/responses)
 *   - GET  /api/org/dashboard         — 401 when auth is missing
 *   - GET  /api/org/dashboard         — {error:'NO_SURVEYS'} (not 500) for a zero-survey org
 *   - GET  /api/org/dashboard/programs — pagination (page 2 differs from page 1)
 *   - PATCH /api/org/dashboard/alerts/:id/acknowledge — updates alert_events.status
 *   - checkOrgBriefEligibility (services/org-metrics.service.ts) — real "≥3 surveys AND
 *     ≥2 weeks of data" eligibility check backing GET /crystal-brief's `minDataMet` field
 *   - GET  /api/org/dashboard/crystal-brief — response is always `{brief, minDataMet}`;
 *     `brief` stays `null` when none exists, `minDataMet` is always present regardless
 *   - GET  /api/org/dashboard/briefs/:briefId — provenance/trail detail; 404s (never leaks)
 *     for a brief id that exists but belongs to a different org
 *   - Plan-tier gate (Fix 9, PRODUCTION_READINESS_AUDIT.md) — 403 for a sub-Growth org,
 *     pass-through for Growth+; per-org `command_center_disabled` kill switch — 403
 *     regardless of plan tier
 *
 * Test-fixture note: the router-level plan-tier-gate middleware issues its own
 * `org_profiles` reads (`plan_tier` / `command_center_disabled`) ahead of every route
 * handler. Rather than making every existing test's inline `dbQuery` mock aware of two
 * more queries it has nothing to do with (and risking a collision — e.g. the dashboard
 * payload test's own `sql.includes('FROM org_profiles')` branch, which answers a
 * *different* org_profiles query), `buildApp({planTier, commandCenterDisabled})` accepts
 * two explicit options (defaulting to `'growth'` / `false, i.e. gate passes) and answers
 * the gate's exact queries directly, unconditionally, before ever delegating to the
 * test's own `dbQuery`. Tests exercising the gate itself (below) pass explicit
 * `planTier`/`commandCenterDisabled` overrides instead of reaching into `dbQuery` for it.
 */
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
const ROUTER_PATH  = _require.resolve(resolve(__dirname, '../routes/org-dashboard'));
const SERVICE_PATH = _require.resolve(resolve(__dirname, '../services/org-metrics.service'));
const ALERT_PATH   = _require.resolve(resolve(__dirname, '../lib/alertEngine'));
// Router-level plan-tier gate (Fix 9) — same stale-require-cache risk as SERVICE_PATH/
// ALERT_PATH above: planGating.ts captures its own `require('./db')` binding at first
// require time, so it must also be force-refreshed before each app build.
const PLAN_GATING_PATH = _require.resolve(resolve(__dirname, '../lib/planGating'));

let dbQuery;

function fakeMod(id, exports) {
  return { id, filename: id, loaded: true, exports, children: [] };
}

/**
 * @param {{ requireHeader?: boolean }} opts - requireHeader=true installs a requireAuth
 *   fake that actually checks for an Authorization header (401 if absent), mirroring the
 *   real middleware's non-dev-mode contract, so the "401 for missing auth" test exercises
 *   real gate behavior rather than a permanently-bypassed stub.
 */
function buildApp(opts = {}) {
  const { requireHeader = false, planTier = 'growth', commandCenterDisabled = false } = opts;

  _require.cache[AUTH_PATH] = fakeMod(AUTH_PATH, {
    requireAuth: requireHeader
      ? (req, res, next) => {
          if (!req.headers.authorization) { res.status(401).json({ error: 'Missing authorization header' }); return; }
          req.orgId = 'test-org';
          req.userId = 'test-user';
          next();
        }
      : (req, res, next) => {
          req.orgId = 'test-org';
          req.userId = 'test-user';
          next();
        },
    DEV_MODE: false,
  });
  // Answer the router-level plan-tier-gate middleware's own two queries directly
  // (see the file header note above) — unconditionally, before ever delegating to the
  // test's own `dbQuery`, so there's no risk of colliding with an unrelated
  // `org_profiles` query a given test's mock already handles.
  const dbQueryWithGate = async (sql, params) => {
    if (sql.includes('SELECT command_center_disabled FROM org_profiles')) {
      return { rows: [{ command_center_disabled: commandCenterDisabled }] };
    }
    if (sql.includes('SELECT plan_tier FROM org_profiles')) {
      return { rows: [{ plan_tier: planTier }] };
    }
    return dbQuery(sql, params);
  };
  _require.cache[DB_PATH] = fakeMod(DB_PATH, {
    query: dbQueryWithGate,
    pool: {},
    default: { query: dbQueryWithGate },
  });

  // Force a fresh require of the router AND the service modules it delegates to — these
  // hold their own `require('../lib/db')` binding captured at first-require time, so a
  // module cached from an earlier test would otherwise keep querying with that test's
  // stale dbQuery mock instead of the one just installed above.
  delete _require.cache[ROUTER_PATH];
  delete _require.cache[SERVICE_PATH];
  delete _require.cache[ALERT_PATH];
  delete _require.cache[PLAN_GATING_PATH];

  const router = _require(ROUTER_PATH);
  const app = express();
  app.use(express.json());
  app.use('/api/org', router.default || router);
  return app;
}

describe('GET /api/org/dashboard', () => {
  it('returns 401 when the Authorization header is missing', async () => {
    dbQuery = vi.fn(async () => ({ rows: [] }));
    const app = buildApp({ requireHeader: true });

    const res = await inject(app, { method: 'GET', url: '/api/org/dashboard' });

    expect(res.statusCode).toBe(401);
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it("returns {error:'NO_SURVEYS'} (not 500) for an org with zero surveys", async () => {
    dbQuery = vi.fn(async (sql) => {
      if (sql.includes('FROM surveys')) return { rows: [{ count: 0 }] };
      return { rows: [] };
    });
    const app = buildApp();

    const res = await inject(app, { method: 'GET', url: '/api/org/dashboard' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ error: 'NO_SURVEYS' });
  });

  it('returns the full dashboard payload for a fixture org with surveys and responses', async () => {
    dbQuery = vi.fn(async (sql) => {
      if (sql.includes('FROM surveys')) return { rows: [{ count: 3 }] };
      if (sql.includes('FROM org_profiles')) return { rows: [{ org_id: 'test-org', brand_name: 'Acme Corp' }] };
      if (sql.includes('FROM org_health_score')) {
        return { rows: [{
          total_score: 82, nps_score: 0.8, sentiment_score: 0.75,
          response_velocity_score: 0.6, anomaly_free_score: 0.9,
          computed_at: '2026-07-04T00:00:00Z',
        }] };
      }
      if (sql.includes('FROM org_metrics_daily')) {
        return { rows: [{ active_surveys: 5, avg_nps: 42, avg_sentiment: 0.3, created_at: '2026-07-04T01:00:00Z' }] };
      }
      if (sql.includes('FROM org_metrics_weekly')) {
        return { rows: [{ avg_nps: 40, avg_sentiment: 0.28, nps_wow_delta: 2, sentiment_wow_delta: 0.05 }] };
      }
      if (sql.includes('FROM org_crystal_briefs')) {
        return { rows: [{
          id: 'brief-1', brief_text: 'Great week', recommendations: [],
          generated_at: '2026-07-03T00:00:00Z', date_range_start: '2026-06-27', date_range_end: '2026-07-03',
        }] };
      }
      if (sql.includes('submitted_at >= CURRENT_DATE')) return { rows: [{ count: 12 }] };
      if (sql.includes('FROM responses')) return { rows: [{ count: 500 }] };
      return { rows: [] };
    });
    const app = buildApp();

    const res = await inject(app, { method: 'GET', url: '/api/org/dashboard' });
    const body = res.json();

    expect(res.statusCode).toBe(200);
    expect(body.org).toEqual({ id: 'test-org', name: 'Acme Corp' });
    expect(body.healthScore).toEqual({
      total: 82,
      components: { nps: 0.8, sentiment: 0.75, velocity: 0.6, anomalyFree: 0.9 },
      computedAt: '2026-07-04T00:00:00Z',
    });
    expect(body.kpis).toEqual({
      activeSurveys: 5,
      totalResponses: 500,
      responsesToday: 12,
      avgNps: 40,
      npsWowDelta: 2,
      avgSentiment: 0.28,
      sentimentTrend: 'improving', // sentiment_wow_delta 0.05 > the 0.02 epsilon
    });
    expect(body.crystalBrief).toEqual({
      id: 'brief-1',
      briefText: 'Great week',
      recommendations: [],
      generatedAt: '2026-07-03T00:00:00Z',
      dateRangeStart: '2026-06-27',
      dateRangeEnd: '2026-07-03',
      trustVerdict: null,
      trustScore: null,
      parentCheckpointId: null,
    });
    expect(typeof body.dataFreshnessAt).toBe('string');
    expect(Number.isNaN(Date.parse(body.dataFreshnessAt))).toBe(false);
  });
});

describe('GET /api/org/dashboard/programs', () => {
  it('paginates — page 2 returns a different set of programs than page 1', async () => {
    dbQuery = vi.fn(async (sql, params) => {
      if (sql.includes("date_trunc('day'")) return { rows: [] }; // sparkline batch query
      if (sql.includes('FROM responses')) return { rows: [] };    // responses7d batch query
      if (sql.includes('FROM survey_health_summary') && sql.includes('ORDER BY')) {
        const offset = params[params.length - 1];
        if (offset === 0) {
          return { rows: [{
            survey_id: 'survey-1', survey_title: 'Survey One', tag_ids: [], tag_names: [],
            last_nps: 50, sentiment_trend: 'stable', response_velocity_7d: 10,
            health_status: 'healthy', last_activity_at: '2026-07-01T00:00:00Z',
          }] };
        }
        return { rows: [{
          survey_id: 'survey-2', survey_title: 'Survey Two', tag_ids: [], tag_names: [],
          last_nps: 20, sentiment_trend: 'declining', response_velocity_7d: 4,
          health_status: 'critical', last_activity_at: '2026-06-20T00:00:00Z',
        }] };
      }
      if (sql.includes('FROM survey_health_summary') && sql.includes('COUNT(*)')) {
        return { rows: [{ count: 30 }] };
      }
      return { rows: [] };
    });
    const app = buildApp();

    const page1 = await inject(app, { method: 'GET', url: '/api/org/dashboard/programs?page=1&pageSize=25' });
    const page2 = await inject(app, { method: 'GET', url: '/api/org/dashboard/programs?page=2&pageSize=25' });

    expect(page1.statusCode).toBe(200);
    expect(page2.statusCode).toBe(200);
    const body1 = page1.json();
    const body2 = page2.json();

    expect(body1.programs).toHaveLength(1);
    expect(body2.programs).toHaveLength(1);
    expect(body1.programs[0].surveyId).toBe('survey-1');
    expect(body2.programs[0].surveyId).toBe('survey-2');
    expect(body1.programs[0].surveyId).not.toBe(body2.programs[0].surveyId);
    expect(body1.pagination).toEqual({ page: 1, pageSize: 25, total: 30, totalPages: 2 });
    expect(body2.pagination).toEqual({ page: 2, pageSize: 25, total: 30, totalPages: 2 });
  });
});

describe('PATCH /api/org/dashboard/alerts/:alertId/acknowledge', () => {
  it("updates alert_events.status to 'acknowledged', scoped by org_id", async () => {
    dbQuery = vi.fn(async (sql, params) => {
      if (sql.includes('SELECT status FROM alert_events')) {
        expect(params).toEqual(['alert-1', 'test-org']);
        return { rows: [{ status: 'active' }] };
      }
      if (sql.startsWith('UPDATE alert_events')) {
        expect(sql).toMatch(/status = \$3/);
        expect(sql).toMatch(/acknowledged_at = NOW\(\)/);
        expect(sql).toMatch(/acknowledged_by = \$4/);
        expect(sql).toMatch(/WHERE id = \$1 AND org_id = \$2/);
        expect(params).toEqual(['alert-1', 'test-org', 'acknowledged', 'test-user']);
        return { rows: [{
          id: 'alert-1', org_id: 'test-org', status: 'acknowledged',
          acknowledged_at: '2026-07-04T12:00:00Z', acknowledged_by: 'test-user',
        }] };
      }
      if (sql.includes('INSERT INTO alert_history')) return { rows: [] };
      return { rows: [] };
    });
    const app = buildApp();

    const res = await inject(app, {
      method: 'PATCH',
      url: '/api/org/dashboard/alerts/alert-1/acknowledge',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ alertId: 'alert-1', acknowledgedAt: '2026-07-04T12:00:00Z' });
  });

  it('returns 404 when the alert does not belong to this org (or does not exist)', async () => {
    dbQuery = vi.fn(async (sql) => {
      if (sql.includes('SELECT status FROM alert_events')) return { rows: [] };
      return { rows: [] };
    });
    const app = buildApp();

    const res = await inject(app, {
      method: 'PATCH',
      url: '/api/org/dashboard/alerts/missing-alert/acknowledge',
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('checkOrgBriefEligibility (services/org-metrics.service.ts)', () => {
  it('returns eligible: false for a fixture org with fewer than 3 surveys', async () => {
    dbQuery = vi.fn(async (sql) => {
      if (sql.includes('earliest_submitted_at')) {
        return { rows: [{ survey_count: 2, earliest_submitted_at: '2026-06-01T00:00:00Z' }] };
      }
      return { rows: [] };
    });
    buildApp(); // installs the fake db + forces a fresh require of the service module
    const service = _require(SERVICE_PATH);

    const result = await service.checkOrgBriefEligibility('test-org');

    expect(result.eligible).toBe(false);
    expect(result.surveyCount).toBe(2);
  });

  it('returns eligible: true for a fixture org with >=3 surveys and >=14 days of data', async () => {
    const twentyDaysAgo = new Date(Date.now() - 20 * 86_400_000).toISOString();
    dbQuery = vi.fn(async (sql) => {
      if (sql.includes('earliest_submitted_at')) {
        return { rows: [{ survey_count: 4, earliest_submitted_at: twentyDaysAgo }] };
      }
      return { rows: [] };
    });
    buildApp();
    const service = _require(SERVICE_PATH);

    const result = await service.checkOrgBriefEligibility('test-org');

    expect(result.eligible).toBe(true);
    expect(result.surveyCount).toBe(4);
    expect(result.earliestResponseDaysAgo).toBeGreaterThanOrEqual(14);
  });

  it('returns eligible: false when survey count is sufficient but data is under 2 weeks old', async () => {
    const fiveDaysAgo = new Date(Date.now() - 5 * 86_400_000).toISOString();
    dbQuery = vi.fn(async (sql) => {
      if (sql.includes('earliest_submitted_at')) {
        return { rows: [{ survey_count: 5, earliest_submitted_at: fiveDaysAgo }] };
      }
      return { rows: [] };
    });
    buildApp();
    const service = _require(SERVICE_PATH);

    const result = await service.checkOrgBriefEligibility('test-org');

    expect(result.eligible).toBe(false);
  });
});

describe('GET /api/org/dashboard/crystal-brief', () => {
  it('returns {brief, minDataMet} — minDataMet computed from real eligibility, as a sibling of brief', async () => {
    const twentyDaysAgo = new Date(Date.now() - 20 * 86_400_000).toISOString();
    dbQuery = vi.fn(async (sql) => {
      if (sql.includes('FROM org_crystal_briefs WHERE org_id')) {
        return { rows: [{
          id: 'brief-1', brief_text: 'Great week', recommendations: [],
          generated_at: '2026-07-03T00:00:00Z', date_range_start: '2026-06-27', date_range_end: '2026-07-03',
        }] };
      }
      if (sql.includes('earliest_submitted_at')) {
        return { rows: [{ survey_count: 4, earliest_submitted_at: twentyDaysAgo }] };
      }
      return { rows: [] };
    });
    const app = buildApp();

    const res = await inject(app, { method: 'GET', url: '/api/org/dashboard/crystal-brief' });
    const body = res.json();

    expect(res.statusCode).toBe(200);
    expect(body.brief.id).toBe('brief-1');
    expect(body.minDataMet).toBe(true);
  });

  it('brief stays exactly null (not an incomplete object) when no brief has been generated yet, but minDataMet is still present', async () => {
    dbQuery = vi.fn(async (sql) => {
      if (sql.includes('FROM org_crystal_briefs WHERE org_id')) return { rows: [] };
      if (sql.includes('earliest_submitted_at')) return { rows: [{ survey_count: 1, earliest_submitted_at: null }] };
      return { rows: [] };
    });
    const app = buildApp();

    const res = await inject(app, { method: 'GET', url: '/api/org/dashboard/crystal-brief' });
    const body = res.json();

    expect(res.statusCode).toBe(200);
    // `brief` must stay `null` — the exact case where the "why no brief" messaging
    // matters most — while `minDataMet` (here false: 1 survey, no data yet) is always a
    // sibling field, never bundled onto a value that can be null.
    expect(body).toEqual({ brief: null, minDataMet: false });
  });
});

describe('Command Center rollout control (plan-tier gate + per-org kill switch)', () => {
  it('returns 403 with an upgrade-required message for an org below the Growth plan tier', async () => {
    dbQuery = vi.fn(async () => ({ rows: [] }));
    const app = buildApp({ planTier: 'free' });

    const res = await inject(app, { method: 'GET', url: '/api/org/dashboard' });
    const body = res.json();

    expect(res.statusCode).toBe(403);
    expect(body.error).toMatch(/growth/i);
    expect(body.error).toMatch(/upgrade/i);
    // The gate must reject before any dashboard-payload query runs.
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it('passes through (no 403) for an org on the Growth plan tier or higher', async () => {
    dbQuery = vi.fn(async (sql) => {
      if (sql.includes('FROM surveys')) return { rows: [{ count: 0 }] };
      return { rows: [] };
    });
    const app = buildApp({ planTier: 'enterprise' });

    const res = await inject(app, { method: 'GET', url: '/api/org/dashboard' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ error: 'NO_SURVEYS' });
  });

  it('returns a distinct 403 for a Growth+ org with command_center_disabled set, even though its plan tier would otherwise pass', async () => {
    dbQuery = vi.fn(async () => ({ rows: [] }));
    const app = buildApp({ planTier: 'enterprise', commandCenterDisabled: true });

    const res = await inject(app, { method: 'GET', url: '/api/org/dashboard' });
    const body = res.json();

    expect(res.statusCode).toBe(403);
    // Distinct copy from the plan-tier message above so support can tell the two apart.
    expect(body.error).toMatch(/disabled/i);
    expect(body.error).not.toMatch(/upgrade/i);
    // The kill switch must reject before the plan-tier check or any dashboard query runs.
    expect(dbQuery).not.toHaveBeenCalled();
  });
});

describe('GET /api/org/dashboard/briefs/:briefId', () => {
  it('returns 404 when the brief id exists in org_crystal_briefs but belongs to a different org', async () => {
    dbQuery = vi.fn(async (sql, params) => {
      if (sql.includes('FROM org_crystal_briefs WHERE id')) {
        expect(params).toEqual(['brief-other-org', 'test-org']);
        return { rows: [] }; // org-scoped query correctly finds nothing for 'test-org'
      }
      if (sql.includes('FROM org_custom_summaries WHERE id')) return { rows: [] };
      return { rows: [] };
    });
    const app = buildApp();

    const res = await inject(app, { method: 'GET', url: '/api/org/dashboard/briefs/brief-other-org' });

    expect(res.statusCode).toBe(404);
  });

  it('returns full provenance detail for a scheduled brief belonging to this org', async () => {
    dbQuery = vi.fn(async (sql, params) => {
      if (sql.includes('FROM org_crystal_briefs WHERE id')) {
        expect(params).toEqual(['brief-1', 'test-org']);
        return { rows: [{
          id: 'brief-1', date_range_start: '2026-06-27', date_range_end: '2026-07-03',
          brief_text: 'Great week', recommendations: [{ rank: 1, action: 'Investigate', rationale: 'Why', survey_id: null, tag_id: null, action_type: 'investigate', source_insight_ids: [] }],
          generated_at: '2026-07-03T00:00:00Z', model_version: 'gpt-x',
          input_snapshot: { avg_nps: 40 }, trust_json: { verdict: 'pass' },
          hallucination_score: 0.92, parent_checkpoint_id: null,
        }] };
      }
      return { rows: [] };
    });
    const app = buildApp();

    const res = await inject(app, { method: 'GET', url: '/api/org/dashboard/briefs/brief-1' });
    const body = res.json();

    expect(res.statusCode).toBe(200);
    expect(body.source).toBe('scheduled');
    expect(body.hallucinationScore).toBe(92); // scaled 0-100, matches mapCrystalBriefRow's trustScore
    expect(body.recommendations[0]).toMatchObject({ rank: 1, action: 'Investigate', actionType: 'investigate' });
  });

  it('returns provenance detail (source: manual) for an org_custom_summaries row when no scheduled brief matches the id', async () => {
    dbQuery = vi.fn(async (sql) => {
      if (sql.includes('FROM org_crystal_briefs WHERE id')) return { rows: [] };
      if (sql.includes('FROM org_custom_summaries WHERE id')) {
        return { rows: [{
          id: 'summary-1', date_range_start: '2026-06-01', date_range_end: '2026-06-30',
          brief_text: 'Custom range summary', recommendations: [],
          generated_at: '2026-06-30T12:00:00Z', model_version: 'gpt-x',
          input_snapshot: null, compared_against_brief_id: 'brief-0',
        }] };
      }
      return { rows: [] };
    });
    const app = buildApp();

    const res = await inject(app, { method: 'GET', url: '/api/org/dashboard/briefs/summary-1' });
    const body = res.json();

    expect(res.statusCode).toBe(200);
    expect(body.source).toBe('manual');
    expect(body.hallucinationScore).toBeNull();
    expect(body.parentCheckpointId).toBe('brief-0');
  });
});
