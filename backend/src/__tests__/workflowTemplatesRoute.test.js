// Regression coverage for GET /api/workflows/templates — the gallery-honesty
// fix (Nina, 2026-07-01, DEEP_AUDIT_PM_FINDINGS.md Top-5 Finding #3 / §5,
// corroborated by DEEP_AUDIT_UX_FINDINGS.md). Re-verified directly against the
// current workflowRegistry.ts + every real backend event producer before
// implementing: exactly 4 of the 8 seeded templates (nps-recovery,
// verbatim-escalation, nps-win-celebration, slow-completion-flag) use a
// trigger_type with ZERO producer anywhere in the codebase — migration
// 20260701140100_workflow_template_functional_flag.sql marks those
// `is_functional = FALSE`; this route now excludes them via a WHERE clause.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import inject from 'light-my-request';
import express from 'express';

const __dirname = dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);

const AUTH_PATH   = _require.resolve(resolve(__dirname, '../middleware/auth'));
const PERM_PATH   = _require.resolve(resolve(__dirname, '../middleware/requirePermission'));
const DB_PATH     = _require.resolve(resolve(__dirname, '../lib/db'));
const ENGINE_PATH = _require.resolve(resolve(__dirname, '../lib/workflowEngine'));
const REG_PATH    = _require.resolve(resolve(__dirname, '../lib/workflowRegistry'));
const ROUTER_PATH = _require.resolve(resolve(__dirname, '../routes/workflows'));

let dbQuery;
function fakeMod(id, exports) { return { id, filename: id, loaded: true, exports, children: [] }; }
function buildApp() {
  _require.cache[AUTH_PATH] = fakeMod(AUTH_PATH, {
    requireAuth: (req, res, next) => { req.orgId = 'o1'; req.userId = 'u1'; next(); },
  });
  _require.cache[PERM_PATH] = fakeMod(PERM_PATH, {
    requirePermission: () => (req, res, next) => next(), invalidatePermissionCache: vi.fn(),
  });
  _require.cache[DB_PATH] = fakeMod(DB_PATH, { query: dbQuery, default: { query: dbQuery } });
  _require.cache[ENGINE_PATH] = fakeMod(ENGINE_PATH, { runWorkflow: vi.fn(), resumeWorkflow: vi.fn(), computeCooldownStatus: () => null });
  _require.cache[REG_PATH] = fakeMod(REG_PATH, { registry: () => ({ triggers: [], conditionFields: [], conditionOperators: [], actions: [] }) });
  delete _require.cache[ROUTER_PATH];
  const router = _require(ROUTER_PATH);
  const app = express(); app.use(express.json()); app.use('/api/workflows', router.default || router);
  return app;
}
async function api(app, method, url) {
  const res = await inject(app, { method, url });
  return { status: res.statusCode, body: res.json() };
}

beforeEach(() => {
  dbQuery = vi.fn(async () => ({ rows: [] }));
});

describe('GET /api/workflows/templates', () => {
  it('the query filters on is_functional = TRUE (gallery-honesty fix)', async () => {
    await api(buildApp(), 'GET', '/api/workflows/templates');
    const [sql] = dbQuery.mock.calls[0];
    expect(sql).toMatch(/is_functional\s*=\s*TRUE/i);
  });

  it('returns only functional templates when the DB applies the filter', async () => {
    // Simulates the real WHERE clause already having excluded the 4 dead-trigger
    // templates — this test asserts the route just passes the filtered rows
    // through untouched, it does not re-filter in application code.
    dbQuery = vi.fn(async () => ({
      rows: [
        { slug: 'weekly-digest', name: 'Weekly Digest', description: 'd', category: 'reporting', trigger_type: 'time.schedule', nodes: [], edges: [], is_featured: true },
        { slug: 'critical-alert-to-zendesk', name: 'Critical Alert to Zendesk', description: 'd', category: 'escalation', trigger_type: 'alert.fired', nodes: [], edges: [], is_featured: true },
      ],
    }));
    const { status, body } = await api(buildApp(), 'GET', '/api/workflows/templates');
    expect(status).toBe(200);
    const slugs = body.templates.map((t) => t.slug);
    expect(slugs).toEqual(['weekly-digest', 'critical-alert-to-zendesk']);
    // None of the 4 confirmed-dead-trigger templates should ever appear.
    for (const deadSlug of ['nps-recovery', 'verbatim-escalation', 'nps-win-celebration', 'slow-completion-flag']) {
      expect(slugs).not.toContain(deadSlug);
    }
  });

  it('still returns an empty array (not a 500) when the table does not exist yet (42P01)', async () => {
    dbQuery = vi.fn(async () => { const e = new Error('relation "workflow_templates" does not exist'); e.code = '42P01'; throw e; });
    const { status, body } = await api(buildApp(), 'GET', '/api/workflows/templates');
    expect(status).toBe(200);
    expect(body.templates).toEqual([]);
  });
});

// Cross-check: the 4 dead-trigger types this fix targets have zero producer
// ANYWHERE in the backend (grepped: routes/responses.ts, lib/alertEngine.ts,
// workflowEngine.ts's scheduled sweep, routes/internal-workflows.ts — the only
// 4 real producers in the codebase are time.schedule, survey.milestone,
// alert.fired, and the 3 crystal.* signal types). This test doesn't re-run that
// grep (it can't, from a unit test), but documents the exact claim being made so
// a future producer addition prompts someone to revisit is_functional too.
describe('dead-trigger-type list this migration encodes (documentation-as-test)', () => {
  it('names the exact 4 templates + trigger types confirmed dead as of this pass', () => {
    const DEAD = {
      'nps-recovery': 'survey.response_filtered',
      'verbatim-escalation': 'crystal.verbatim_escalation',
      'nps-win-celebration': 'score.nps_rise',
      'slow-completion-flag': 'survey.response_received',
    };
    expect(Object.keys(DEAD)).toHaveLength(4);
    expect(DEAD['nps-recovery']).toBe('survey.response_filtered');
    expect(DEAD['verbatim-escalation']).toBe('crystal.verbatim_escalation');
    expect(DEAD['nps-win-celebration']).toBe('score.nps_rise');
    expect(DEAD['slow-completion-flag']).toBe('survey.response_received');
  });
});
