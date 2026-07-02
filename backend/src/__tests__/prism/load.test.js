// Prism LOAD — survey_id resolution into the responses upsert.
//
// Verifies the import → responses seam: every response upsert receives a non-null
// survey_id ($3), with the per-row survey_id winning and the batch surveyId as
// fallback; a response row with neither is a hard error (NOT NULL on the table).
//
// Tests are .js loading .ts source via the tsx CJS hook (src/test/setup.cjs).
// load.ts uses pool.connect() (a transactional client) only — faked, no live DB.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const _require = createRequire(import.meta.url);
const DB_PATH = _require.resolve(resolve(__dirname, '../../lib/db'));
const LOAD_PATH = _require.resolve(resolve(__dirname, '../../lib/prism/load'));

function fakeMod(id, exports) { return { id, filename: id, loaded: true, exports, children: [] }; }

let clientQuery, releaseSpy;
function loadLoad() {
  const client = { query: clientQuery, release: releaseSpy };
  const pool = { connect: vi.fn(async () => client) };
  _require.cache[DB_PATH] = fakeMod(DB_PATH, { query: vi.fn(), pool, default: { query: vi.fn(), pool } });
  delete _require.cache[LOAD_PATH];
  return _require(LOAD_PATH);
}

function stagedRow(overrides = {}) {
  return {
    kind: 'response',
    org_id: 'o1',
    survey_id: null,
    source_platform: 'file',
    source_record_id: 'R_1',
    natural_key: 'file:R_1',
    answers: { q1: { value: 9 } },
    respondent: null,
    submitted_at: '2026-01-01T00:00:00Z',
    source_observed_at: null,
    metadata: { prism: { source_platform: 'file', source_record_id: 'R_1' } },
    payload_hash: 'h',
    ...overrides,
  };
}

beforeEach(() => {
  releaseSpy = vi.fn();
});

describe('load — responses upsert always carries a non-null survey_id ($2)', () => {
  it('uses the batch surveyId when the row carries none', async () => {
    let surveyParam;
    clientQuery = vi.fn(async (text, params) => {
      if (text === 'BEGIN' || text === 'COMMIT') return { rows: [], rowCount: 0 };
      surveyParam = params[1]; // $2 survey_id
      return { rows: [{ inserted: true }], rowCount: 1 };
    });
    const { load } = loadLoad();
    const res = await load([stagedRow()], 'batch-survey');
    expect(surveyParam).toBe('batch-survey');
    expect(res.loaded).toBe(1);
    // The upsert targets responses with the prism natural-key ON CONFLICT.
    const upsert = clientQuery.mock.calls.map((c) => c[0]).find((t) => /INSERT INTO responses/.test(t));
    expect(upsert).toMatch(/ON CONFLICT/);
  });

  it('per-row survey_id wins over the batch surveyId', async () => {
    let surveyParam;
    clientQuery = vi.fn(async (text, params) => {
      if (text === 'BEGIN' || text === 'COMMIT') return { rows: [], rowCount: 0 };
      surveyParam = params[1];
      return { rows: [{ inserted: true }], rowCount: 1 };
    });
    const { load } = loadLoad();
    await load([stagedRow({ survey_id: 'row-survey' })], 'batch-survey');
    expect(surveyParam).toBe('row-survey');
  });

  it('throws (rolls back) when a response row has no survey_id at all', async () => {
    clientQuery = vi.fn(async (text) => {
      if (text === 'BEGIN' || text === 'ROLLBACK' || text === 'COMMIT') return { rows: [], rowCount: 0 };
      return { rows: [{ inserted: true }], rowCount: 1 };
    });
    const { load } = loadLoad();
    await expect(load([stagedRow()], null)).rejects.toThrow(/no survey_id/);
    expect(clientQuery.mock.calls.map((c) => c[0])).toContain('ROLLBACK');
  });

  it('signal rows may resolve a null survey_id (no error)', async () => {
    let surveyParam = 'unset';
    clientQuery = vi.fn(async (text, params) => {
      if (text === 'BEGIN' || text === 'COMMIT') return { rows: [], rowCount: 0 };
      surveyParam = params[1];
      return { rows: [{ inserted: true }], rowCount: 1 };
    });
    const { load } = loadLoad();
    const res = await load([stagedRow({ kind: 'signal', survey_id: null })], null);
    expect(surveyParam).toBeNull();
    expect(res.loaded).toBe(1);
    // Signals target the signals table, not responses.
    const upsert = clientQuery.mock.calls.map((c) => c[0]).find((t) => /INSERT INTO signals/.test(t));
    expect(upsert).toBeTruthy();
  });

  it('upsert SQL uses contiguous $1..$9 placeholders (no skipped $1)', async () => {
    clientQuery = vi.fn(async (text, params) => {
      if (text === 'BEGIN' || text === 'COMMIT') return { rows: [], rowCount: 0 };
      expect(params[0]).toBe('o1'); // $1 org_id — must not be a null padding slot
      expect(params).toHaveLength(9);
      return { rows: [{ inserted: true }], rowCount: 1 };
    });
    const { load } = loadLoad();
    await load([stagedRow({ survey_id: 's1' })], null);
    const upsert = clientQuery.mock.calls.map((c) => c[0]).find((t) => /INSERT INTO responses/.test(t));
    expect(upsert).toMatch(/\$1/);
    expect(upsert).not.toMatch(/\$10/);
  });
});
