/**
 * Tests for lib/tagReportRunner.ts (TRACKER.md §1 Tasks 6/7/13) — the single
 * shared run-creation flow used by all three Tag Report trigger sources
 * (manual route, custom-range route, automated route, and the scheduler sweep).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);

const DB_PATH        = _require.resolve(resolve(__dirname, '../lib/db'));
const AGENTS_PATH    = _require.resolve(resolve(__dirname, '../lib/agentsClient'));
const LOGGER_PATH    = _require.resolve(resolve(__dirname, '../lib/logger'));
const SELECTION_PATH = _require.resolve(resolve(__dirname, '../lib/tagReportSelection'));
const CONCURRENCY_PATH = _require.resolve(resolve(__dirname, '../lib/groupInsightRunConcurrency'));
const MOD_PATH       = _require.resolve(resolve(__dirname, '../lib/tagReportRunner'));

let dbQuery;
let getOrgScopedTag;
let resolveEffectiveMaxSurveys;
let tagHasAnyCandidateSurvey;
let insertGroupInsightRunWithConcurrencyGuard;
let generateTagReport;

function fakeMod(id, exports) {
  return { id, filename: id, loaded: true, exports, children: [] };
}

function loadModule() {
  _require.cache[DB_PATH] = fakeMod(DB_PATH, { query: dbQuery, default: { query: dbQuery } });
  _require.cache[LOGGER_PATH] = fakeMod(LOGGER_PATH, {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  });
  _require.cache[SELECTION_PATH] = fakeMod(SELECTION_PATH, {
    getOrgScopedTag, resolveEffectiveMaxSurveys, tagHasAnyCandidateSurvey,
  });
  _require.cache[CONCURRENCY_PATH] = fakeMod(CONCURRENCY_PATH, {
    insertGroupInsightRunWithConcurrencyGuard,
  });
  _require.cache[AGENTS_PATH] = fakeMod(AGENTS_PATH, {
    generateTagReport,
    default: { generateTagReport },
  });
  delete _require.cache[MOD_PATH];
  return _require(MOD_PATH);
}

beforeEach(() => {
  dbQuery = vi.fn(async () => ({ rows: [] }));
  getOrgScopedTag = vi.fn(async () => ({ id: 'tag-1', name: 'NPS', slug: 'nps', color: null }));
  resolveEffectiveMaxSurveys = vi.fn(async () => 5);
  tagHasAnyCandidateSurvey = vi.fn(async () => true);
  insertGroupInsightRunWithConcurrencyGuard = vi.fn(async () => ({
    runId: 'run-1', createdAt: '2026-07-02T00:00:00Z', attachedToExisting: false,
  }));
  generateTagReport = vi.fn(async () => ({}));
});

describe('startTagReportRun', () => {
  it('returns 404 when the tag does not exist / is not org-scoped', async () => {
    getOrgScopedTag = vi.fn(async () => null);
    const mod = loadModule();
    const result = await mod.startTagReportRun({
      orgId: 'org-1', userId: 'user-1', tagId: 'missing', runMode: 'manual', trigger: 'manual',
    });
    expect(result).toEqual({ ok: false, status: 404, error: 'Tag not found' });
    expect(insertGroupInsightRunWithConcurrencyGuard).not.toHaveBeenCalled();
  });

  it('returns 400 when the tag has no candidate surveys', async () => {
    tagHasAnyCandidateSurvey = vi.fn(async () => false);
    const mod = loadModule();
    const result = await mod.startTagReportRun({
      orgId: 'org-1', userId: 'user-1', tagId: 'tag-1', runMode: 'manual', trigger: 'manual',
    });
    expect(result).toEqual({ ok: false, status: 400, error: 'This tag has no surveys to report on' });
    expect(insertGroupInsightRunWithConcurrencyGuard).not.toHaveBeenCalled();
  });

  it('creates a run with empty survey_ids (backend never resolves membership) and kicks off CrystalOS', async () => {
    const mod = loadModule();
    const result = await mod.startTagReportRun({
      orgId: 'org-1', userId: 'user-1', tagId: 'tag-1', runMode: 'manual', trigger: 'manual',
    });
    expect(result).toEqual({ ok: true, runId: 'run-1', attachedToExisting: false, createdAt: '2026-07-02T00:00:00Z' });
    expect(insertGroupInsightRunWithConcurrencyGuard).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'org-1', tagIds: ['tag-1'], surveyIds: [], runMode: 'manual', trigger: 'manual',
    }));
    await new Promise((r) => setTimeout(r, 10));
    expect(generateTagReport).toHaveBeenCalledWith('run-1', 'org-1', 'tag-1', 'manual', 5, null, null);
  });

  it('passes windowStart/windowEnd through for custom_range', async () => {
    const mod = loadModule();
    await mod.startTagReportRun({
      orgId: 'org-1', userId: 'user-1', tagId: 'tag-1', runMode: 'custom_range', trigger: 'manual',
      windowStart: '2026-01-01T00:00:00Z', windowEnd: '2026-02-01T00:00:00Z',
    });
    expect(insertGroupInsightRunWithConcurrencyGuard).toHaveBeenCalledWith(expect.objectContaining({
      windowStart: '2026-01-01T00:00:00Z', windowEnd: '2026-02-01T00:00:00Z',
    }));
    await new Promise((r) => setTimeout(r, 10));
    expect(generateTagReport).toHaveBeenCalledWith(
      'run-1', 'org-1', 'tag-1', 'custom_range', 5, '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z',
    );
  });

  it('does NOT call generateTagReport when attaching to an already-in-flight run', async () => {
    insertGroupInsightRunWithConcurrencyGuard = vi.fn(async () => ({
      runId: 'already-running', createdAt: '2026-07-01T00:00:00Z', attachedToExisting: true,
    }));
    const mod = loadModule();
    const result = await mod.startTagReportRun({
      orgId: 'org-1', userId: 'user-1', tagId: 'tag-1', runMode: 'manual', trigger: 'manual',
    });
    expect(result).toEqual({ ok: true, runId: 'already-running', attachedToExisting: true, createdAt: '2026-07-01T00:00:00Z' });
    await new Promise((r) => setTimeout(r, 10));
    expect(generateTagReport).not.toHaveBeenCalled();
  });

  it('marks the run failed if the CrystalOS kick-off rejects (best-effort, fire-and-forget)', async () => {
    generateTagReport = vi.fn(async () => { throw new Error('agents unreachable'); });
    const updateSpy = vi.fn(async () => ({ rows: [] }));
    dbQuery = vi.fn(async (sql, params) => {
      if (sql.includes("SET status = 'failed'")) return updateSpy(sql, params);
      return { rows: [] };
    });
    const mod = loadModule();
    await mod.startTagReportRun({
      orgId: 'org-1', userId: 'user-1', tagId: 'tag-1', runMode: 'manual', trigger: 'manual',
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(updateSpy).toHaveBeenCalledWith(expect.stringContaining("SET status = 'failed'"), ['run-1']);
  });

  it('never resolves survey membership itself — zero-fresh-AI selection path has no other agentsClient call', async () => {
    // Sanity check on the module's own contract: only generateTagReport (via the
    // agentsClient mock) may be invoked; no other CrystalOS call exists in this file.
    const mod = loadModule();
    await mod.startTagReportRun({
      orgId: 'org-1', userId: 'user-1', tagId: 'tag-1', runMode: 'automated', trigger: 'scheduled',
    });
    expect(tagHasAnyCandidateSurvey).toHaveBeenCalledWith('tag-1', 'org-1');
    expect(resolveEffectiveMaxSurveys).toHaveBeenCalledWith('tag-1', 'org-1');
  });
});
