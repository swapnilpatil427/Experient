/**
 * Tests for routes/experience.js — Crystal scoping (survey / org / tag).
 *
 * Focus: the new 'tag' scope added alongside the pre-existing 'survey'/'org'
 * scopes on POST /:scope/crystal/stream, plus the shared loadCrystalContext()
 * tag branch that both the streaming route and the /crystal + /org/crystal
 * non-streaming fallback (crystalHandler) go through.
 *
 * Uses the fakeMod/cache-injection pattern (see survey-groups.test.js) so no
 * real DB, Redis, or agents (CrystalOS) service connection is needed. The
 * outbound `node-fetch` call to CrystalOS is also mocked so we can assert on
 * the exact request body shape forwarded for scope='tag'.
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
const LEDGER_PATH  = _require.resolve(resolve(__dirname, '../lib/creditLedger'));
const LOGGER_PATH  = _require.resolve(resolve(__dirname, '../lib/logger'));
const FETCH_PATH   = _require.resolve('node-fetch');
const ROUTER_PATH  = _require.resolve(resolve(__dirname, '../routes/experience'));

let dbQuery;
let fetchMock;
let checkCreditsMock;
let debitCreditsMock;

function fakeMod(id, exports) {
  return { id, filename: id, loaded: true, exports, children: [] };
}

// Minimal fake SSE response body — an async-iterable of Buffer chunks, exactly
// what `for await (const chunk of agentRes.body)` in experience.ts expects.
function fakeSSEBody(events) {
  const lines = events.map((ev) => `data: ${JSON.stringify(ev)}\n\n`);
  lines.push('data: [DONE]\n\n');
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next() {
          if (i < lines.length) return Promise.resolve({ value: Buffer.from(lines[i++]), done: false });
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}

function buildApp() {
  _require.cache[AUTH_PATH] = fakeMod(AUTH_PATH, {
    requireAuth: (req, _res, next) => {
      req.orgId  = 'test-org';
      req.userId = 'test-user';
      next();
    },
  });
  _require.cache[DB_PATH] = fakeMod(DB_PATH, {
    query: (...args) => dbQuery(...args),
    default: { query: (...args) => dbQuery(...args) },
  });
  _require.cache[LEDGER_PATH] = fakeMod(LEDGER_PATH, {
    checkCredits: (...args) => checkCreditsMock(...args),
    debitCredits: (...args) => debitCreditsMock(...args),
  });
  _require.cache[LOGGER_PATH] = fakeMod(LOGGER_PATH, {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  });
  // node-fetch's real CJS export shape is `module.exports = fetch` (a callable
  // function, no __esModule flag) — mirror that exactly so both tsc's and
  // esbuild/tsx's default-import interop resolve `.default` back to this mock.
  _require.cache[FETCH_PATH] = fakeMod(FETCH_PATH, (...args) => fetchMock(...args));

  delete _require.cache[ROUTER_PATH];
  const router = _require(ROUTER_PATH);
  const app = express();
  app.use(express.json());
  app.use('/api/experience', router.default || router);
  return app;
}

beforeEach(() => {
  dbQuery = vi.fn(async () => ({ rows: [] }));
  checkCreditsMock = vi.fn(async () => ({ ok: true }));
  debitCreditsMock = vi.fn(async () => ({}));
  fetchMock = vi.fn(async () => ({ ok: true, body: fakeSSEBody([{ type: 'answer', answer: 'hi', suggestions: [], citations: [] }]) }));
});

// ── POST /api/experience/:scope/crystal/stream ────────────────────────────────

describe('POST /api/experience/:scope/crystal/stream — scope validation', () => {
  it('still rejects scopes outside survey/org/tag (existing behavior unchanged)', async () => {
    const res = await inject(buildApp(), {
      method: 'POST',
      url: '/api/experience/bogus/crystal/stream',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello there' }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_scope');
  });

  it('accepts scope=tag (previously rejected before this feature)', async () => {
    dbQuery = vi.fn(async (sql) => {
      if (sql.includes('FROM survey_tags')) return { rows: [{ id: 'tag-1', name: 'Onboarding' }] };
      if (sql.includes('survey_tag_mappings')) return { rows: [{ survey_id: 'survey-a' }] };
      return { rows: [] };
    });

    const res = await inject(buildApp(), {
      method: 'POST',
      url: '/api/experience/tag/crystal/stream',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'how is this tag doing?', tag_id: 'tag-1' }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
  });
});

describe('POST /api/experience/tag/crystal/stream — tag context + forwarding', () => {
  it('validates the tag belongs to the org, then forwards tag_id/tag_name/tag_survey_ids to CrystalOS', async () => {
    dbQuery = vi.fn(async (sql, params) => {
      if (sql.includes('FROM survey_tags')) {
        expect(params).toEqual(['tag-1', 'test-org']);
        return { rows: [{ id: 'tag-1', name: 'Onboarding' }] };
      }
      if (sql.includes('survey_tag_mappings')) {
        expect(sql).toMatch(/JOIN surveys s ON s\.id = m\.survey_id/);
        expect(sql).toMatch(/s\.deleted_at IS NULL/);
        expect(params).toEqual(['tag-1', 'test-org']);
        return { rows: [{ survey_id: 'survey-a' }, { survey_id: 'survey-b' }] };
      }
      return { rows: [] };
    });

    const res = await inject(buildApp(), {
      method: 'POST',
      url: '/api/experience/tag/crystal/stream',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'how is this tag doing?', tag_id: 'tag-1' }),
    });

    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:8001/insights/crystal/stream');
    const sentBody = JSON.parse(opts.body);
    expect(sentBody.scope).toBe('tag');
    expect(sentBody.tag_id).toBe('tag-1');
    expect(sentBody.tag_name).toBe('Onboarding');
    expect(sentBody.tag_survey_ids).toEqual(['survey-a', 'survey-b']);
    expect(sentBody.org_id).toBe('test-org');
    expect(sentBody.user_id).toBe('test-user');
    expect(sentBody.message).toBe('how is this tag doing?');
  });

  it('falls back to scope=org and drops tag_id entirely when tag_id belongs to another org — fails closed, does not leak tag existence', async () => {
    // Regression test (security review fix, 2026-07-03): the original version of
    // this test asserted scope stayed 'tag' with the raw unvalidated tag_id still
    // forwarded — Riley's review flagged this as relying entirely on redundant
    // downstream CrystalOS tool checks rather than failing closed at this layer.
    // agentBody must now be derived from loadCrystalContext's ORG-VALIDATED
    // ctx.scope/ctx.tag_id, not the raw route scope + raw client body.
    dbQuery = vi.fn(async (sql) => {
      // Cross-org tag: validation query returns zero rows.
      if (sql.includes('FROM survey_tags')) return { rows: [] };
      return { rows: [] };
    });

    const res = await inject(buildApp(), {
      method: 'POST',
      url: '/api/experience/tag/crystal/stream',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'how is this tag doing?', tag_id: 'someone-elses-tag' }),
    });

    expect(res.statusCode).toBe(200);
    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    // scope falls back to 'org' (fail closed) — no unvalidated tag_id is ever
    // labeled scope='tag' downstream — and no tag fields are forwarded at all.
    expect(sentBody.scope).toBe('org');
    expect(sentBody.tag_id).toBeUndefined();
    expect(sentBody.tag_name).toBeUndefined();
    expect(sentBody.tag_survey_ids).toBeUndefined();
    expect(dbQuery.mock.calls.some(([sql]) => sql.includes('survey_tag_mappings'))).toBe(false);
  });

  it('propagates scope=tag + the real tag_id to CrystalOS only when the tag actually validates against the org', async () => {
    dbQuery = vi.fn(async (sql) => {
      if (sql.includes('FROM survey_tags')) return { rows: [{ id: 'tag-1', name: 'Onboarding' }] };
      if (sql.includes('survey_tag_mappings')) return { rows: [{ survey_id: 'survey-a' }] };
      return { rows: [] };
    });

    const res = await inject(buildApp(), {
      method: 'POST',
      url: '/api/experience/tag/crystal/stream',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'how is this tag doing?', tag_id: 'tag-1' }),
    });

    expect(res.statusCode).toBe(200);
    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sentBody.scope).toBe('tag');
    expect(sentBody.tag_id).toBe('tag-1');
    expect(sentBody.tag_name).toBe('Onboarding');
  });

  it('still runs credit metering (checkCredits before, debitCredits after) for tag scope — no bypass', async () => {
    dbQuery = vi.fn(async (sql) => {
      if (sql.includes('FROM survey_tags')) return { rows: [{ id: 'tag-1', name: 'Onboarding' }] };
      if (sql.includes('survey_tag_mappings')) return { rows: [{ survey_id: 'survey-a' }] };
      return { rows: [] };
    });

    await inject(buildApp(), {
      method: 'POST',
      url: '/api/experience/tag/crystal/stream',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'how is this tag doing?', tag_id: 'tag-1' }),
    });

    expect(checkCreditsMock).toHaveBeenCalledTimes(1);
    expect(checkCreditsMock.mock.calls[0][0]).toBe('test-org');
    await new Promise((r) => setTimeout(r, 10));
    expect(debitCreditsMock).toHaveBeenCalledTimes(1);
    expect(debitCreditsMock.mock.calls[0][1]).toMatchObject({ actionType: 'crystal_turn', actionRef: 'tag:tag-1' });
  });

  it('returns 402 without calling the agents service when credits are insufficient (tag scope honors the same gate as survey/org)', async () => {
    checkCreditsMock = vi.fn(async () => ({ ok: false, required: 1, available: 0 }));

    const res = await inject(buildApp(), {
      method: 'POST',
      url: '/api/experience/tag/crystal/stream',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'how is this tag doing?', tag_id: 'tag-1' }),
    });

    expect(res.statusCode).toBe(402);
    expect(res.json().code).toBe('INSUFFICIENT_CREDITS');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not affect survey scope behavior (existing scope unchanged)', async () => {
    dbQuery = vi.fn(async (sql) => {
      if (sql.includes('FROM insights')) return { rows: [] };
      if (sql.includes('FROM survey_topics')) return { rows: [] };
      if (sql.includes('FROM surveys s WHERE id')) return { rows: [{ title: 'My Survey', rc: 10 }] };
      return { rows: [] };
    });

    const res = await inject(buildApp(), {
      method: 'POST',
      url: '/api/experience/survey/crystal/stream',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'how is this survey doing?', survey_id: 'survey-1' }),
    });

    expect(res.statusCode).toBe(200);
    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sentBody.scope).toBe('survey');
    expect(sentBody.tag_id).toBeUndefined();
    expect(dbQuery.mock.calls.some(([sql]) => sql.includes('FROM survey_tags'))).toBe(false);
  });

  it('does not affect org scope behavior (existing scope unchanged)', async () => {
    const res = await inject(buildApp(), {
      method: 'POST',
      url: '/api/experience/org/crystal/stream',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'how is the org doing?' }),
    });

    expect(res.statusCode).toBe(200);
    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sentBody.scope).toBe('org');
    expect(sentBody.tag_id).toBeUndefined();
    expect(dbQuery.mock.calls.some(([sql]) => sql.includes('FROM survey_tags'))).toBe(false);
  });
});

// ── POST /api/experience/crystal (+ /org/crystal alias) — non-streaming fallback ──

describe('POST /api/experience/crystal — tag_id auto-detected (non-streaming fallback)', () => {
  it('resolves tag scope from body.tag_id and forwards tag fields to CrystalOS', async () => {
    dbQuery = vi.fn(async (sql) => {
      if (sql.includes('FROM survey_tags')) return { rows: [{ id: 'tag-1', name: 'Onboarding' }] };
      if (sql.includes('survey_tag_mappings')) return { rows: [{ survey_id: 'survey-a' }] };
      return { rows: [] };
    });

    const res = await inject(buildApp(), {
      method: 'POST',
      url: '/api/experience/crystal',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'how is this tag doing?', tag_id: 'tag-1' }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().answer).toBe('hi');
    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sentBody.scope).toBe('tag');
    expect(sentBody.tag_id).toBe('tag-1');
    expect(sentBody.tag_name).toBe('Onboarding');
    expect(sentBody.tag_survey_ids).toEqual(['survey-a']);
  });

  it('still charges a Crystal turn via the same credit path for tag_id calls (no bypass)', async () => {
    dbQuery = vi.fn(async (sql) => {
      if (sql.includes('FROM survey_tags')) return { rows: [{ id: 'tag-1', name: 'Onboarding' }] };
      if (sql.includes('survey_tag_mappings')) return { rows: [{ survey_id: 'survey-a' }] };
      return { rows: [] };
    });

    await inject(buildApp(), {
      method: 'POST',
      url: '/api/experience/crystal',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'how is this tag doing?', tag_id: 'tag-1' }),
    });

    expect(checkCreditsMock).toHaveBeenCalledTimes(1);
    expect(debitCreditsMock).toHaveBeenCalledTimes(1);
    expect(debitCreditsMock.mock.calls[0][1]).toMatchObject({ actionRef: 'tag:tag-1' });
  });

  it('falls back to org scope when tag_id does not belong to the org (no leak)', async () => {
    dbQuery = vi.fn(async (sql) => {
      if (sql.includes('FROM survey_tags')) return { rows: [] };
      return { rows: [] };
    });

    const res = await inject(buildApp(), {
      method: 'POST',
      url: '/api/experience/crystal',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'how is this tag doing?', tag_id: 'bogus-tag' }),
    });

    expect(res.statusCode).toBe(200);
    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sentBody.scope).toBe('org');
    expect(sentBody.tag_id).toBeUndefined();
    expect(sentBody.tag_name).toBeUndefined();
  });
});
