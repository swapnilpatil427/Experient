/**
 * Tests for lib/tagReportSelection.ts (TRACKER.md §1 Task 5).
 *
 * Pure DB-read helpers — no route, no HTTP. Uses the same require.cache
 * injection pattern as the rest of the suite (see backend/CLAUDE.md).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);

const DB_PATH  = _require.resolve(resolve(__dirname, '../lib/db'));
const MOD_PATH = _require.resolve(resolve(__dirname, '../lib/tagReportSelection'));

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

describe('getOrgScopedTag', () => {
  it('returns the tag row when it exists and belongs to the org', async () => {
    dbQuery = vi.fn(async (sql, params) => {
      expect(sql).toContain('FROM survey_tags');
      expect(params).toEqual(['tag-1', 'org-1']);
      return { rows: [{ id: 'tag-1', name: 'NPS', slug: 'nps', color: '#fff' }] };
    });
    const mod = loadModule();
    const tag = await mod.getOrgScopedTag('tag-1', 'org-1');
    expect(tag).toMatchObject({ id: 'tag-1', name: 'NPS' });
  });

  it('returns null when the tag does not exist or belongs to a different org', async () => {
    dbQuery = vi.fn(async () => ({ rows: [] }));
    const mod = loadModule();
    const tag = await mod.getOrgScopedTag('missing', 'org-1');
    expect(tag).toBeNull();
  });
});

describe('resolveEffectiveMaxSurveys', () => {
  it('uses the tag override when set', async () => {
    dbQuery = vi.fn(async () => ({ rows: [{ effective_max_surveys: 15 }] }));
    const mod = loadModule();
    expect(await mod.resolveEffectiveMaxSurveys('tag-1', 'org-1')).toBe(15);
  });

  it('falls through to the platform default (5) when no row resolves at all', async () => {
    dbQuery = vi.fn(async () => ({ rows: [] }));
    const mod = loadModule();
    expect(await mod.resolveEffectiveMaxSurveys('tag-1', 'org-1')).toBe(5);
  });

  it('uses a LEFT JOIN against org_insight_defaults (not INNER) so an unprovisioned org still resolves', async () => {
    let capturedSql;
    dbQuery = vi.fn(async (sql) => {
      capturedSql = sql;
      // Simulate an org with no org_insight_defaults row at all: COALESCE falls
      // through to the hardcoded platform fallback ($3) passed as a param.
      return { rows: [{ effective_max_surveys: 5 }] };
    });
    const mod = loadModule();
    const result = await mod.resolveEffectiveMaxSurveys('tag-1', 'org-1');
    expect(capturedSql).toMatch(/LEFT JOIN org_insight_defaults/);
    expect(result).toBe(5);
  });

  it('coerces a string-typed numeric column value (pg NUMERIC) to a number', async () => {
    dbQuery = vi.fn(async () => ({ rows: [{ effective_max_surveys: '8' }] }));
    const mod = loadModule();
    expect(await mod.resolveEffectiveMaxSurveys('tag-1', 'org-1')).toBe(8);
  });
});

describe('tagHasAnyCandidateSurvey', () => {
  it('returns true when at least one non-deleted survey is mapped to the tag', async () => {
    dbQuery = vi.fn(async (sql) => {
      expect(sql).toContain('survey_tag_mappings');
      expect(sql).toContain('deleted_at IS NULL');
      return { rows: [{ '?column?': 1 }] };
    });
    const mod = loadModule();
    expect(await mod.tagHasAnyCandidateSurvey('tag-1', 'org-1')).toBe(true);
  });

  it('returns false when the tag has no candidate surveys', async () => {
    dbQuery = vi.fn(async () => ({ rows: [] }));
    const mod = loadModule();
    expect(await mod.tagHasAnyCandidateSurvey('tag-1', 'org-1')).toBe(false);
  });
});
