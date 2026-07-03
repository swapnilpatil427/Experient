import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import inject from 'light-my-request';
import express from 'express';

const __dirname = dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);

const AUTH_PATH      = _require.resolve(resolve(__dirname, '../middleware/auth'));
const ROLE_PATH      = _require.resolve(resolve(__dirname, '../middleware/requireRole'));
const DB_PATH        = _require.resolve(resolve(__dirname, '../lib/db'));
const HTTP_ERR_PATH  = _require.resolve(resolve(__dirname, '../lib/httpError'));
const LOGGER_PATH    = _require.resolve(resolve(__dirname, '../lib/logger'));
const SELECTION_PATH = _require.resolve(resolve(__dirname, '../lib/tagReportSelection'));
const ROUTER_PATH    = _require.resolve(resolve(__dirname, '../routes/tags'));

let dbQuery;

function fakeMod(id, exports) {
  return { id, filename: id, loaded: true, exports, children: [] };
}

function buildApp() {
  _require.cache[AUTH_PATH] = fakeMod(AUTH_PATH, {
    requireAuth: (req, res, next) => { req.orgId = 'test-org'; req.userId = 'test-user'; next(); },
  });
  _require.cache[ROLE_PATH] = fakeMod(ROLE_PATH, {
    requireRole: () => (req, res, next) => next(),
  });
  _require.cache[DB_PATH] = fakeMod(DB_PATH, { query: dbQuery, default: { query: dbQuery } });
  _require.cache[HTTP_ERR_PATH] = fakeMod(HTTP_ERR_PATH, {
    serverError: (res, err) => res.status(500).json({ error: err.message }),
  });
  _require.cache[LOGGER_PATH] = fakeMod(LOGGER_PATH, {
    info:  () => {},
    error: () => {},
    warn:  () => {},
    default: { info: () => {}, error: () => {}, warn: () => {} },
  });
  // lib/tagReportSelection.ts is a REAL module (not faked above) that reads
  // `query` from lib/db at its own require-time. Since it isn't the router
  // itself, it would otherwise stay cached across tests with a stale db
  // reference from whichever test first loaded it — invalidate it here too.
  delete _require.cache[SELECTION_PATH];
  delete _require.cache[ROUTER_PATH];
  const router = _require(ROUTER_PATH);
  const app = express();
  app.use(express.json());
  app.use('/api/tags', router.default || router);
  return app;
}

async function api(app, method, url, body = null) {
  const opts = { method, url };
  if (body !== null) {
    opts.payload = JSON.stringify(body);
    opts.headers = { 'content-type': 'application/json' };
  }
  const res = await inject(app, opts);
  return { status: res.statusCode, body: res.json() };
}

beforeEach(() => {
  dbQuery = vi.fn(async () => ({ rows: [], rowCount: 0 }));
});

// ── GET /api/tags ─────────────────────────────────────────────────────────────

describe('GET /api/tags', () => {
  it('returns { tags: [...] } with survey_count from DB', async () => {
    const fakeRows = [
      { id: 't1', name: 'Employee Experience', slug: 'employee-experience', color: '#4F46E5', description: null, program_config: null, created_at: '2024-01-01', survey_count: 3 },
      { id: 't2', name: 'NPS',                 slug: 'nps',                 color: '#10B981', description: null, program_config: null, created_at: '2024-01-02', survey_count: 1 },
    ];
    dbQuery = vi.fn(async () => ({ rows: fakeRows }));
    const { status, body } = await api(buildApp(), 'GET', '/api/tags');
    expect(status).toBe(200);
    expect(body.tags).toHaveLength(2);
    expect(body.tags[0]).toMatchObject({ id: 't1', name: 'Employee Experience', survey_count: 3 });
    expect(body.tags[1]).toMatchObject({ id: 't2', name: 'NPS', survey_count: 1 });
  });

  it('returns empty array when no tags exist', async () => {
    dbQuery = vi.fn(async () => ({ rows: [] }));
    const { status, body } = await api(buildApp(), 'GET', '/api/tags');
    expect(status).toBe(200);
    expect(body.tags).toEqual([]);
  });

  it('returns 500 on DB error', async () => {
    dbQuery = vi.fn(async () => { throw new Error('connection refused'); });
    const { status, body } = await api(buildApp(), 'GET', '/api/tags');
    expect(status).toBe(500);
    expect(body.error).toBe('connection refused');
  });
});

// ── POST /api/tags ────────────────────────────────────────────────────────────

describe('POST /api/tags', () => {
  it('creates a tag with name + color and returns 201 with tag object', async () => {
    dbQuery = vi.fn(async (text) => {
      // count query
      if (text.includes('COUNT(*)')) return { rows: [{ cnt: 5 }] };
      // slug uniqueness check — no existing slug
      if (text.includes('SELECT 1 FROM survey_tags WHERE slug')) return { rows: [] };
      // INSERT
      if (text.startsWith('INSERT INTO survey_tags')) {
        return { rows: [{ id: 'new-tag-id', name: 'Employee Experience', slug: 'employee-experience', color: '#4F46E5', description: null, program_config: null, created_at: '2024-01-01' }] };
      }
      return { rows: [] };
    });

    const { status, body } = await api(buildApp(), 'POST', '/api/tags', { name: 'Employee Experience', color: '#4F46E5' });
    expect(status).toBe(201);
    expect(body.tag).toMatchObject({
      id: 'new-tag-id',
      name: 'Employee Experience',
      slug: 'employee-experience',
      color: '#4F46E5',
      survey_count: 0,
    });
  });

  it('slugifies the tag name correctly: "Employee Experience" → "employee-experience"', async () => {
    const insertedSlugs = [];
    dbQuery = vi.fn(async (text, params) => {
      if (text.includes('COUNT(*)')) return { rows: [{ cnt: 0 }] };
      if (text.includes('SELECT 1 FROM survey_tags WHERE slug')) return { rows: [] };
      if (text.startsWith('INSERT INTO survey_tags')) {
        insertedSlugs.push(params[2]);
        return { rows: [{ id: 'x', name: params[1], slug: params[2], color: null, description: null, program_config: null, created_at: 't' }] };
      }
      return { rows: [] };
    });

    await api(buildApp(), 'POST', '/api/tags', { name: 'Employee Experience' });
    expect(insertedSlugs[0]).toBe('employee-experience');
  });

  it('trims whitespace from name before storing: "  hello  " → "hello"', async () => {
    const insertedNames = [];
    dbQuery = vi.fn(async (text, params) => {
      if (text.includes('COUNT(*)')) return { rows: [{ cnt: 0 }] };
      if (text.includes('SELECT 1 FROM survey_tags WHERE slug')) return { rows: [] };
      if (text.startsWith('INSERT INTO survey_tags')) {
        insertedNames.push(params[1]);
        return { rows: [{ id: 'x', name: params[1], slug: 'hello', color: null, description: null, program_config: null, created_at: 't' }] };
      }
      return { rows: [] };
    });

    await api(buildApp(), 'POST', '/api/tags', { name: '  hello  ' });
    expect(insertedNames[0]).toBe('hello');
  });

  it('returns 400 when name is missing', async () => {
    const { status, body } = await api(buildApp(), 'POST', '/api/tags', { color: '#fff' });
    expect(status).toBe(400);
    expect(body.error).toBe('name is required');
  });

  it('returns 400 when name is an empty string', async () => {
    const { status, body } = await api(buildApp(), 'POST', '/api/tags', { name: '' });
    expect(status).toBe(400);
    expect(body.error).toBe('name is required');
  });

  it('returns 400 when name is all whitespace', async () => {
    const { status, body } = await api(buildApp(), 'POST', '/api/tags', { name: '   ' });
    expect(status).toBe(400);
    expect(body.error).toBe('name is required');
  });

  it('returns 409 when DB throws unique constraint violation (code 23505)', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('COUNT(*)')) return { rows: [{ cnt: 0 }] };
      if (text.includes('SELECT 1 FROM survey_tags WHERE slug')) return { rows: [] };
      if (text.startsWith('INSERT INTO survey_tags')) {
        const e = new Error('duplicate key value violates unique constraint');
        e.code = '23505';
        throw e;
      }
      return { rows: [] };
    });

    const { status, body } = await api(buildApp(), 'POST', '/api/tags', { name: 'Duplicate Tag' });
    expect(status).toBe(409);
    expect(body.error).toBe('A tag with that name already exists');
  });

  it('returns 400 when org tag limit is reached (cnt >= 50)', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('COUNT(*)')) return { rows: [{ cnt: 50 }] };
      return { rows: [] };
    });

    const { status, body } = await api(buildApp(), 'POST', '/api/tags', { name: 'New Tag' });
    expect(status).toBe(400);
    expect(body.error).toBe('Tag limit reached');
  });

  it('returns 400 when cnt is exactly 50 (boundary)', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('COUNT(*)')) return { rows: [{ cnt: 50 }] };
      return { rows: [] };
    });

    const { status } = await api(buildApp(), 'POST', '/api/tags', { name: 'Boundary Tag' });
    expect(status).toBe(400);
  });

  it('returns 500 on unexpected DB error', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('COUNT(*)')) return { rows: [{ cnt: 3 }] };
      if (text.includes('SELECT 1 FROM survey_tags WHERE slug')) return { rows: [] };
      if (text.startsWith('INSERT INTO survey_tags')) {
        throw new Error('disk full');
      }
      return { rows: [] };
    });

    const { status, body } = await api(buildApp(), 'POST', '/api/tags', { name: 'Tag' });
    expect(status).toBe(500);
    expect(body.error).toBe('disk full');
  });
});

// ── PATCH /api/tags/:id ───────────────────────────────────────────────────────

describe('PATCH /api/tags/:id', () => {
  it('updates name + color and returns 200 with updated tag', async () => {
    dbQuery = vi.fn(async (text) => {
      // verify ownership
      if (text.includes('SELECT id, name FROM survey_tags')) {
        return { rows: [{ id: 'tag-1', name: 'Old Name' }] };
      }
      // slug uniqueness check
      if (text.includes('SELECT 1 FROM survey_tags WHERE slug')) return { rows: [] };
      // UPDATE
      if (text.startsWith('UPDATE survey_tags')) {
        return { rows: [{ id: 'tag-1', name: 'New Name', slug: 'new-name', color: '#FF0000', description: null, program_config: null, created_at: 't' }] };
      }
      return { rows: [] };
    });

    const { status, body } = await api(buildApp(), 'PATCH', '/api/tags/tag-1', { name: 'New Name', color: '#FF0000' });
    expect(status).toBe(200);
    expect(body.tag).toMatchObject({ id: 'tag-1', name: 'New Name', color: '#FF0000' });
  });

  it('returns 404 when tag is not found on SELECT (ownership check)', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('SELECT id, name FROM survey_tags')) return { rows: [] };
      return { rows: [] };
    });

    const { status, body } = await api(buildApp(), 'PATCH', '/api/tags/nonexistent', { name: 'X' });
    expect(status).toBe(404);
    expect(body.error).toBe('Tag not found');
  });

  it('returns 404 when UPDATE affects 0 rows', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('SELECT id, name FROM survey_tags')) return { rows: [{ id: 'tag-1', name: 'Name' }] };
      if (text.includes('SELECT 1 FROM survey_tags WHERE slug')) return { rows: [] };
      if (text.startsWith('UPDATE survey_tags')) return { rows: [] };
      return { rows: [] };
    });

    const { status, body } = await api(buildApp(), 'PATCH', '/api/tags/tag-1', { name: 'Something' });
    expect(status).toBe(404);
    expect(body.error).toBe('Tag not found');
  });

  it('returns 400 when name is an empty string', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('SELECT id, name FROM survey_tags')) return { rows: [{ id: 'tag-1', name: 'Existing' }] };
      return { rows: [] };
    });

    const { status, body } = await api(buildApp(), 'PATCH', '/api/tags/tag-1', { name: '' });
    expect(status).toBe(400);
    expect(body.error).toBe('name cannot be empty');
  });

  it('returns 400 when name is all whitespace', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('SELECT id, name FROM survey_tags')) return { rows: [{ id: 'tag-1', name: 'Existing' }] };
      return { rows: [] };
    });

    const { status, body } = await api(buildApp(), 'PATCH', '/api/tags/tag-1', { name: '   ' });
    expect(status).toBe(400);
    expect(body.error).toBe('name cannot be empty');
  });

  it('returns 409 on duplicate name (DB 23505)', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('SELECT id, name FROM survey_tags')) return { rows: [{ id: 'tag-1', name: 'Old' }] };
      if (text.includes('SELECT 1 FROM survey_tags WHERE slug')) return { rows: [] };
      if (text.startsWith('UPDATE survey_tags')) {
        const e = new Error('duplicate key');
        e.code = '23505';
        throw e;
      }
      return { rows: [] };
    });

    const { status, body } = await api(buildApp(), 'PATCH', '/api/tags/tag-1', { name: 'Taken Name' });
    expect(status).toBe(409);
    expect(body.error).toBe('A tag with that name already exists');
  });

  it('returns 500 on unexpected DB error', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('SELECT id, name FROM survey_tags')) return { rows: [{ id: 'tag-1', name: 'Existing' }] };
      if (text.includes('SELECT 1 FROM survey_tags WHERE slug')) return { rows: [] };
      if (text.startsWith('UPDATE survey_tags')) throw new Error('timeout');
      return { rows: [] };
    });

    const { status, body } = await api(buildApp(), 'PATCH', '/api/tags/tag-1', { name: 'Updated' });
    expect(status).toBe(500);
    expect(body.error).toBe('timeout');
  });
});

// ── DELETE /api/tags/:id ──────────────────────────────────────────────────────

describe('DELETE /api/tags/:id', () => {
  it('deletes existing tag and returns 200 { success: true }', async () => {
    dbQuery = vi.fn(async () => ({ rows: [], rowCount: 1 }));
    const { status, body } = await api(buildApp(), 'DELETE', '/api/tags/tag-1');
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  it('returns 404 when rowCount is 0 (tag does not exist)', async () => {
    dbQuery = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const { status, body } = await api(buildApp(), 'DELETE', '/api/tags/ghost-id');
    expect(status).toBe(404);
    expect(body.error).toBe('Tag not found');
  });

  it('returns 500 on DB error', async () => {
    dbQuery = vi.fn(async () => { throw new Error('foreign key violation'); });
    const { status, body } = await api(buildApp(), 'DELETE', '/api/tags/tag-1');
    expect(status).toBe(500);
    expect(body.error).toBe('foreign key violation');
  });
});

// ── GET /api/tags/:id/surveys ─────────────────────────────────────────────────

describe('GET /api/tags/:id/surveys', () => {
  it('returns surveys list for a valid tag', async () => {
    const fakeSurveys = [
      { id: 's1', title: 'Q4 NPS', status: 'active', survey_type_id: 'nps', created_at: 't', response_count: 42 },
      { id: 's2', title: 'CSAT Jan', status: 'closed', survey_type_id: 'csat', created_at: 't', response_count: 15 },
    ];
    dbQuery = vi.fn(async (text) => {
      // tag ownership check
      if (text.includes('SELECT id FROM survey_tags')) return { rows: [{ id: 'tag-1' }] };
      // surveys query
      if (text.includes('FROM survey_tag_mappings m')) return { rows: fakeSurveys };
      return { rows: [] };
    });

    const { status, body } = await api(buildApp(), 'GET', '/api/tags/tag-1/surveys');
    expect(status).toBe(200);
    expect(body.surveys).toHaveLength(2);
    expect(body.surveys[0]).toMatchObject({ id: 's1', title: 'Q4 NPS', response_count: 42 });
  });

  it('returns 404 when tag does not exist', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('SELECT id FROM survey_tags')) return { rows: [] };
      return { rows: [] };
    });

    const { status, body } = await api(buildApp(), 'GET', '/api/tags/nonexistent/surveys');
    expect(status).toBe(404);
    expect(body.error).toBe('Tag not found');
  });

  it('returns 500 on DB error', async () => {
    dbQuery = vi.fn(async () => { throw new Error('query failed'); });
    const { status, body } = await api(buildApp(), 'GET', '/api/tags/tag-1/surveys');
    expect(status).toBe(500);
    expect(body.error).toBe('query failed');
  });

  it('returns empty surveys array for a tag with no surveys', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('SELECT id FROM survey_tags')) return { rows: [{ id: 'tag-1' }] };
      if (text.includes('FROM survey_tag_mappings m')) return { rows: [] };
      return { rows: [] };
    });

    const { status, body } = await api(buildApp(), 'GET', '/api/tags/tag-1/surveys');
    expect(status).toBe(200);
    expect(body.surveys).toEqual([]);
  });
});

// ── GET /api/tags/:id/latest-report ──────────────────────────────────────────

describe('GET /api/tags/:id/latest-report', () => {
  it('returns { tag, run, insights } for an existing completed run', async () => {
    const fakeTag = { id: 'tag-1', name: 'Employee Experience', slug: 'employee-experience', color: '#4F46E5' };
    const fakeRun = { id: 'run-1', status: 'completed', tag_ids: ['tag-1'], survey_ids: ['s1', 's2'], created_at: 't', completed_at: 't2' };
    const fakeInsights = [
      { id: 'i1', run_id: 'run-1', priority: 10, headline: 'NPS improved' },
      { id: 'i2', run_id: 'run-1', priority: 5,  headline: 'Response rate stable' },
    ];

    dbQuery = vi.fn(async (text) => {
      if (text.includes('SELECT id, name, slug, color FROM survey_tags')) return { rows: [fakeTag] };
      if (text.includes('FROM group_insight_runs'))                         return { rows: [fakeRun] };
      if (text.includes('FROM group_insights'))                             return { rows: fakeInsights };
      return { rows: [] };
    });

    const { status, body } = await api(buildApp(), 'GET', '/api/tags/tag-1/latest-report');
    expect(status).toBe(200);
    expect(body.tag).toMatchObject({ id: 'tag-1', name: 'Employee Experience' });
    expect(body.run).toMatchObject({ id: 'run-1', status: 'completed' });
    expect(body.insights).toHaveLength(2);
    expect(body.insights[0]).toMatchObject({ headline: 'NPS improved' });
  });

  it('returns 404 when tag does not exist', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('SELECT id, name, slug, color FROM survey_tags')) return { rows: [] };
      return { rows: [] };
    });

    const { status, body } = await api(buildApp(), 'GET', '/api/tags/nonexistent/latest-report');
    expect(status).toBe(404);
    expect(body.error).toBe('Tag not found');
  });

  it('returns 404 when no completed run exists for the tag', async () => {
    const fakeTag = { id: 'tag-1', name: 'NPS', slug: 'nps', color: null };
    dbQuery = vi.fn(async (text) => {
      if (text.includes('SELECT id, name, slug, color FROM survey_tags')) return { rows: [fakeTag] };
      if (text.includes('FROM group_insight_runs'))                        return { rows: [] };
      return { rows: [] };
    });

    const { status, body } = await api(buildApp(), 'GET', '/api/tags/tag-1/latest-report');
    expect(status).toBe(404);
    expect(body.error).toBe('No completed report found for this tag');
  });

  it('returns 500 on DB error', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('SELECT id, name, slug, color FROM survey_tags')) {
        throw new Error('db unreachable');
      }
      return { rows: [] };
    });

    const { status, body } = await api(buildApp(), 'GET', '/api/tags/tag-1/latest-report');
    expect(status).toBe(500);
    expect(body.error).toBe('db unreachable');
  });

  it('returns empty insights array when group_insights query fails (swallowed catch)', async () => {
    const fakeTag = { id: 'tag-1', name: 'NPS', slug: 'nps', color: null };
    const fakeRun = { id: 'run-1', status: 'completed', tag_ids: ['tag-1'], survey_ids: [], created_at: 't', completed_at: 't2' };
    dbQuery = vi.fn(async (text) => {
      if (text.includes('SELECT id, name, slug, color FROM survey_tags')) return { rows: [fakeTag] };
      if (text.includes('FROM group_insight_runs'))                        return { rows: [fakeRun] };
      if (text.includes('FROM group_insights'))                            throw new Error('insights table missing');
      return { rows: [] };
    });

    const { status, body } = await api(buildApp(), 'GET', '/api/tags/tag-1/latest-report');
    // The route swallows the insights error via .catch(() => ({ rows: [] }))
    expect(status).toBe(200);
    expect(body.insights).toEqual([]);
  });
});

// ── Slug generation (nameToSlug logic) ───────────────────────────────────────
//
// nameToSlug is not exported directly, so we exercise it indirectly through
// POST /api/tags and inspect the slug param passed to the INSERT query.

describe('slug generation via POST /api/tags', () => {
  async function getGeneratedSlug(name) {
    let capturedSlug;
    dbQuery = vi.fn(async (text, params) => {
      if (text.includes('COUNT(*)'))                             return { rows: [{ cnt: 0 }] };
      if (text.includes('SELECT 1 FROM survey_tags WHERE slug')) return { rows: [] };
      if (text.startsWith('INSERT INTO survey_tags')) {
        capturedSlug = params[2];
        return { rows: [{ id: 'x', name: params[1], slug: params[2], color: null, description: null, program_config: null, created_at: 't' }] };
      }
      return { rows: [] };
    });
    await api(buildApp(), 'POST', '/api/tags', { name });
    return capturedSlug;
  }

  it('"Employee Experience" → "employee-experience"', async () => {
    expect(await getGeneratedSlug('Employee Experience')).toBe('employee-experience');
  });

  it('"NPS & CSAT" → "nps-csat" (special chars stripped)', async () => {
    expect(await getGeneratedSlug('NPS & CSAT')).toBe('nps-csat');
  });

  it('"  spaces  " → "spaces" (leading/trailing whitespace trimmed)', async () => {
    // POST trims name first, then slugifies
    expect(await getGeneratedSlug('  spaces  ')).toBe('spaces');
  });

  it('"---" → "tag" (falls back to default when slug collapses to empty)', async () => {
    expect(await getGeneratedSlug('---')).toBe('tag');
  });

  it('appends -2 when base slug already exists', async () => {
    let callCount = 0;
    let capturedSlug;
    dbQuery = vi.fn(async (text, params) => {
      if (text.includes('COUNT(*)'))                             return { rows: [{ cnt: 0 }] };
      if (text.includes('SELECT 1 FROM survey_tags WHERE slug')) {
        callCount++;
        // First call: base slug exists; second call: -2 is free
        return callCount === 1 ? { rows: [{ '1': 1 }] } : { rows: [] };
      }
      if (text.startsWith('INSERT INTO survey_tags')) {
        capturedSlug = params[2];
        return { rows: [{ id: 'x', name: params[1], slug: params[2], color: null, description: null, program_config: null, created_at: 't' }] };
      }
      return { rows: [] };
    });

    await api(buildApp(), 'POST', '/api/tags', { name: 'Duplicate' });
    expect(capturedSlug).toBe('duplicate-2');
  });

  it('appends -3 when base slug and -2 already exist', async () => {
    let callCount = 0;
    let capturedSlug;
    dbQuery = vi.fn(async (text, params) => {
      if (text.includes('COUNT(*)'))                             return { rows: [{ cnt: 0 }] };
      if (text.includes('SELECT 1 FROM survey_tags WHERE slug')) {
        callCount++;
        // First call: base exists; second call: -2 exists; third: free
        return callCount < 3 ? { rows: [{ '1': 1 }] } : { rows: [] };
      }
      if (text.startsWith('INSERT INTO survey_tags')) {
        capturedSlug = params[2];
        return { rows: [{ id: 'x', name: params[1], slug: params[2], color: null, description: null, program_config: null, created_at: 't' }] };
      }
      return { rows: [] };
    });

    await api(buildApp(), 'POST', '/api/tags', { name: 'Triple Duplicate' });
    expect(capturedSlug).toBe('triple-duplicate-3');
  });
});

// ── Tag Report — report-config + history (TRACKER.md §1 Tasks 9/10) ─────────
//
// getOrgScopedTag/resolveEffectiveMaxSurveys (lib/tagReportSelection.ts) are
// thin wrappers over `query` from lib/db — the DB_PATH mock injected by
// buildApp() above already intercepts their require of './db' (same resolved
// absolute path), so no separate module mock is needed here.

describe('GET /api/tags/:id/report-config', () => {
  it('returns the raw override and the resolved effective cap', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('SELECT id, name, slug, color FROM survey_tags')) return { rows: [{ id: 'tag-1', name: 'NPS', slug: 'nps', color: null }] };
      if (text.includes('SELECT max_surveys_override FROM survey_tags')) return { rows: [{ max_surveys_override: 8 }] };
      if (text.includes('effective_max_surveys')) return { rows: [{ effective_max_surveys: 8 }] };
      return { rows: [] };
    });
    const { status, body } = await api(buildApp(), 'GET', '/api/tags/tag-1/report-config');
    expect(status).toBe(200);
    expect(body).toEqual({ tag_id: 'tag-1', max_surveys_override: 8, effective_max_surveys: 8 });
  });

  it('resolves to the platform default when no override is set anywhere', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('SELECT id, name, slug, color FROM survey_tags')) return { rows: [{ id: 'tag-1', name: 'NPS', slug: 'nps', color: null }] };
      if (text.includes('SELECT max_surveys_override FROM survey_tags')) return { rows: [{ max_surveys_override: null }] };
      if (text.includes('effective_max_surveys')) return { rows: [{ effective_max_surveys: 5 }] };
      return { rows: [] };
    });
    const { status, body } = await api(buildApp(), 'GET', '/api/tags/tag-1/report-config');
    expect(status).toBe(200);
    expect(body).toEqual({ tag_id: 'tag-1', max_surveys_override: null, effective_max_surveys: 5 });
  });

  it('returns 404 when the tag does not exist', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('SELECT id, name, slug, color FROM survey_tags')) return { rows: [] };
      return { rows: [] };
    });
    const { status, body } = await api(buildApp(), 'GET', '/api/tags/missing/report-config');
    expect(status).toBe(404);
    expect(body.error).toBe('Tag not found');
  });
});

describe('PATCH /api/tags/:id/report-config', () => {
  it('sets max_surveys_override and returns the resolved effective cap', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.startsWith('UPDATE survey_tags SET max_surveys_override')) return { rows: [{ id: 'tag-1', max_surveys_override: 12 }] };
      if (text.includes('effective_max_surveys')) return { rows: [{ effective_max_surveys: 12 }] };
      return { rows: [] };
    });
    const { status, body } = await api(buildApp(), 'PATCH', '/api/tags/tag-1/report-config', { max_surveys_override: 12 });
    expect(status).toBe(200);
    expect(body).toEqual({ tag_id: 'tag-1', max_surveys_override: 12, effective_max_surveys: 12 });
  });

  it('clears the override with null', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.startsWith('UPDATE survey_tags SET max_surveys_override')) return { rows: [{ id: 'tag-1', max_surveys_override: null }] };
      if (text.includes('effective_max_surveys')) return { rows: [{ effective_max_surveys: 5 }] };
      return { rows: [] };
    });
    const { status, body } = await api(buildApp(), 'PATCH', '/api/tags/tag-1/report-config', { max_surveys_override: null });
    expect(status).toBe(200);
    expect(body.max_surveys_override).toBeNull();
  });

  it('returns 400 for an out-of-range override (> 20)', async () => {
    const { status, body } = await api(buildApp(), 'PATCH', '/api/tags/tag-1/report-config', { max_surveys_override: 21 });
    expect(status).toBe(400);
    expect(body.error).toMatch(/between 1 and 20/);
  });

  it('returns 400 for a non-integer override', async () => {
    const { status, body } = await api(buildApp(), 'PATCH', '/api/tags/tag-1/report-config', { max_surveys_override: 2.5 });
    expect(status).toBe(400);
  });

  it('returns 404 when the tag does not exist (UPDATE affects 0 rows)', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.startsWith('UPDATE survey_tags SET max_surveys_override')) return { rows: [] };
      return { rows: [] };
    });
    const { status, body } = await api(buildApp(), 'PATCH', '/api/tags/missing/report-config', { max_surveys_override: 10 });
    expect(status).toBe(404);
    expect(body.error).toBe('Tag not found');
  });
});

describe('GET /api/tags/:id/tag-report-history', () => {
  it('returns the run history across all three modes, newest first', async () => {
    const fakeRuns = [
      { id: 'run-3', run_mode: 'custom_range', trigger: 'manual', status: 'completed', created_at: 't3' },
      { id: 'run-2', run_mode: 'automated', trigger: 'scheduled', status: 'completed', created_at: 't2' },
      { id: 'run-1', run_mode: 'manual', trigger: 'manual', status: 'completed', created_at: 't1' },
    ];
    dbQuery = vi.fn(async (text) => {
      if (text.includes('SELECT id FROM survey_tags')) return { rows: [{ id: 'tag-1' }] };
      if (text.includes('FROM group_insight_runs')) return { rows: fakeRuns };
      return { rows: [] };
    });
    const { status, body } = await api(buildApp(), 'GET', '/api/tags/tag-1/tag-report-history');
    expect(status).toBe(200);
    expect(body.runs).toHaveLength(3);
    expect(body.runs[0]).toMatchObject({ id: 'run-3' });
  });

  it('returns 404 when the tag does not exist', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('SELECT id FROM survey_tags')) return { rows: [] };
      return { rows: [] };
    });
    const { status, body } = await api(buildApp(), 'GET', '/api/tags/missing/tag-report-history');
    expect(status).toBe(404);
    expect(body.error).toBe('Tag not found');
  });

  it('paginates via next_cursor when a full page is returned', async () => {
    const fullPage = Array.from({ length: 20 }, (_, i) => ({ id: `run-${i}`, created_at: `t${i}` }));
    dbQuery = vi.fn(async (text) => {
      if (text.includes('SELECT id FROM survey_tags')) return { rows: [{ id: 'tag-1' }] };
      if (text.includes('FROM group_insight_runs')) return { rows: fullPage };
      return { rows: [] };
    });
    const { status, body } = await api(buildApp(), 'GET', '/api/tags/tag-1/tag-report-history');
    expect(status).toBe(200);
    expect(body.next_cursor).toBe('run-19');
  });

  it('returns next_cursor: null when fewer than a full page is returned', async () => {
    dbQuery = vi.fn(async (text) => {
      if (text.includes('SELECT id FROM survey_tags')) return { rows: [{ id: 'tag-1' }] };
      if (text.includes('FROM group_insight_runs')) return { rows: [{ id: 'run-1', created_at: 't1' }] };
      return { rows: [] };
    });
    const { status, body } = await api(buildApp(), 'GET', '/api/tags/tag-1/tag-report-history');
    expect(status).toBe(200);
    expect(body.next_cursor).toBeNull();
  });
});
