/**
 * Tests for lib/groupInsightRunConcurrency.ts (DESIGN.md Appendix A.5 / TRACKER.md
 * §1 "Interaction found with the existing /generate route").
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);

const DB_PATH  = _require.resolve(resolve(__dirname, '../lib/db'));
const MOD_PATH = _require.resolve(resolve(__dirname, '../lib/groupInsightRunConcurrency'));

let dbQuery;

function fakeMod(id, exports) {
  return { id, filename: id, loaded: true, exports, children: [] };
}

function loadModule() {
  _require.cache[DB_PATH] = fakeMod(DB_PATH, { query: dbQuery, default: { query: dbQuery } });
  delete _require.cache[MOD_PATH];
  return _require(MOD_PATH);
}

beforeEach(() => {
  dbQuery = vi.fn(async () => ({ rows: [] }));
});

describe('insertGroupInsightRunWithConcurrencyGuard', () => {
  it('inserts a new run and returns attachedToExisting: false on success', async () => {
    dbQuery = vi.fn(async (sql, params) => {
      expect(sql).toContain('INSERT INTO group_insight_runs');
      expect(sql).toContain("'pending'");
      expect(params).toEqual(['org-1', 'user-1', ['tag-1'], [], 'manual', 'manual', null, null, null]);
      return { rows: [{ id: 'run-1', created_at: '2026-07-02T00:00:00Z' }] };
    });
    const mod = loadModule();
    const result = await mod.insertGroupInsightRunWithConcurrencyGuard({
      orgId: 'org-1', createdBy: 'user-1', tagIds: ['tag-1'], surveyIds: [],
    });
    expect(result).toEqual({ runId: 'run-1', createdAt: '2026-07-02T00:00:00Z', attachedToExisting: false });
  });

  it('passes through runMode/trigger/window/parentRunId overrides', async () => {
    let capturedParams;
    dbQuery = vi.fn(async (sql, params) => {
      capturedParams = params;
      return { rows: [{ id: 'run-2', created_at: 't' }] };
    });
    const mod = loadModule();
    await mod.insertGroupInsightRunWithConcurrencyGuard({
      orgId: 'org-1', createdBy: null, tagIds: ['tag-1'], surveyIds: [],
      runMode: 'custom_range', trigger: 'manual',
      windowStart: '2026-01-01T00:00:00Z', windowEnd: '2026-02-01T00:00:00Z',
      parentRunId: 'parent-run-1',
    });
    expect(capturedParams).toEqual([
      'org-1', null, ['tag-1'], [], 'custom_range', 'manual',
      '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z', 'parent-run-1',
    ]);
  });

  it('on a 23505 conflict, attaches to the already-in-flight run instead of throwing', async () => {
    dbQuery = vi.fn(async (sql, params) => {
      if (sql.startsWith('INSERT INTO group_insight_runs')) {
        const e = new Error('duplicate key value violates unique constraint "uq_gir_tag_inflight"');
        e.code = '23505';
        throw e;
      }
      if (sql.includes("status IN ('pending', 'running')")) {
        expect(params).toEqual(['org-1', ['tag-1']]);
        return { rows: [{ id: 'in-flight-run', created_at: '2026-07-01T00:00:00Z' }] };
      }
      return { rows: [] };
    });
    const mod = loadModule();
    const result = await mod.insertGroupInsightRunWithConcurrencyGuard({
      orgId: 'org-1', createdBy: 'user-1', tagIds: ['tag-1'], surveyIds: [],
    });
    expect(result).toEqual({ runId: 'in-flight-run', createdAt: '2026-07-01T00:00:00Z', attachedToExisting: true });
  });

  it('rethrows the 23505 if no matching in-flight row is found (edge case: race resolved between insert and lookup)', async () => {
    dbQuery = vi.fn(async (sql) => {
      if (sql.startsWith('INSERT INTO group_insight_runs')) {
        const e = new Error('duplicate key');
        e.code = '23505';
        throw e;
      }
      if (sql.includes("status IN ('pending', 'running')")) return { rows: [] };
      return { rows: [] };
    });
    const mod = loadModule();
    await expect(mod.insertGroupInsightRunWithConcurrencyGuard({
      orgId: 'org-1', createdBy: 'user-1', tagIds: ['tag-1'], surveyIds: [],
    })).rejects.toThrow('duplicate key');
  });

  it('rethrows non-23505 errors without attempting an attach lookup', async () => {
    const lookupSpy = vi.fn();
    dbQuery = vi.fn(async (sql) => {
      if (sql.startsWith('INSERT INTO group_insight_runs')) throw new Error('connection refused');
      lookupSpy();
      return { rows: [] };
    });
    const mod = loadModule();
    await expect(mod.insertGroupInsightRunWithConcurrencyGuard({
      orgId: 'org-1', createdBy: 'user-1', tagIds: ['tag-1'], surveyIds: [],
    })).rejects.toThrow('connection refused');
    expect(lookupSpy).not.toHaveBeenCalled();
  });
});
