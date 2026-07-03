/**
 * Tests for lib/tagReportScheduler.ts (TRACKER.md §1 Task 15 — Automated mode
 * due-tags sweep + jitter + enqueue onto the existing workflow-trigger queue).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);

const DB_PATH     = _require.resolve(resolve(__dirname, '../lib/db'));
const LOGGER_PATH = _require.resolve(resolve(__dirname, '../lib/logger'));
const RUNNER_PATH = _require.resolve(resolve(__dirname, '../lib/tagReportRunner'));
const MOD_PATH    = _require.resolve(resolve(__dirname, '../lib/tagReportScheduler'));

let dbQuery;
let startTagReportRun;
let loggerWarn;

function fakeMod(id, exports) {
  return { id, filename: id, loaded: true, exports, children: [] };
}

function loadModule() {
  _require.cache[DB_PATH] = fakeMod(DB_PATH, { query: dbQuery, default: { query: dbQuery } });
  loggerWarn = vi.fn();
  _require.cache[LOGGER_PATH] = fakeMod(LOGGER_PATH, {
    info: vi.fn(), warn: loggerWarn, error: vi.fn(), debug: vi.fn(),
    default: { info: vi.fn(), warn: loggerWarn, error: vi.fn(), debug: vi.fn() },
  });
  _require.cache[RUNNER_PATH] = fakeMod(RUNNER_PATH, { startTagReportRun });
  delete _require.cache[MOD_PATH];
  return _require(MOD_PATH);
}

const NOW = new Date('2026-07-02T12:00:00Z');

beforeEach(() => {
  dbQuery = vi.fn(async () => ({ rows: [] }));
  startTagReportRun = vi.fn(async () => ({ ok: true, runId: 'run-x', attachedToExisting: false, createdAt: 't' }));
  delete process.env.TAG_REPORT_JITTER_WINDOW_MS;
});

afterEach(() => {
  delete process.env.TAG_REPORT_JITTER_WINDOW_MS;
});

describe('findDueAutomatedTags', () => {
  it('treats a tag with no prior automated run as due', async () => {
    dbQuery = vi.fn(async () => ({
      rows: [{ org_id: 'org-1', tag_id: 'tag-1', cadence_hours: 24, last_run_at: null }],
    }));
    const mod = loadModule();
    const due = await mod.findDueAutomatedTags(NOW);
    expect(due).toEqual([{ orgId: 'org-1', tagId: 'tag-1' }]);
  });

  it('excludes a tag whose last automated run is within its cadence', async () => {
    dbQuery = vi.fn(async () => ({
      rows: [{ org_id: 'org-1', tag_id: 'tag-1', cadence_hours: 24, last_run_at: '2026-07-02T06:00:00Z' }],
    }));
    const mod = loadModule();
    const due = await mod.findDueAutomatedTags(NOW);
    expect(due).toEqual([]);
  });

  it('includes a tag whose last automated run is older than its cadence', async () => {
    dbQuery = vi.fn(async () => ({
      rows: [{ org_id: 'org-1', tag_id: 'tag-1', cadence_hours: 24, last_run_at: '2026-06-29T00:00:00Z' }],
    }));
    const mod = loadModule();
    const due = await mod.findDueAutomatedTags(NOW);
    expect(due).toEqual([{ orgId: 'org-1', tagId: 'tag-1' }]);
  });

  it('defaults to a weekly cadence when cadence_hours is null/0', async () => {
    dbQuery = vi.fn(async () => ({
      rows: [
        // 3 days ago — not due under the default weekly cadence.
        { org_id: 'org-1', tag_id: 'tag-recent', cadence_hours: null, last_run_at: '2026-06-29T12:00:00Z' },
        // 10 days ago — due under the default weekly cadence.
        { org_id: 'org-1', tag_id: 'tag-stale', cadence_hours: 0, last_run_at: '2026-06-22T12:00:00Z' },
      ],
    }));
    const mod = loadModule();
    const due = await mod.findDueAutomatedTags(NOW);
    expect(due).toEqual([{ orgId: 'org-1', tagId: 'tag-stale' }]);
  });

  it('queries only tags with tag_report_automated.enabled and excludes tags with a run already in flight', async () => {
    let capturedSql;
    dbQuery = vi.fn(async (sql) => { capturedSql = sql; return { rows: [] }; });
    const mod = loadModule();
    await mod.findDueAutomatedTags(NOW);
    expect(capturedSql).toMatch(/tag_report_automated/);
    expect(capturedSql).toMatch(/status IN \('pending', 'running'\)/);
  });
});

describe('computeJitterMs', () => {
  it('is deterministic for the same (org, tag) pair', () => {
    const mod = loadModule();
    const a = mod.computeJitterMs('org-1', 'tag-1', 300000);
    const b = mod.computeJitterMs('org-1', 'tag-1', 300000);
    expect(a).toBe(b);
  });

  it('stays within [0, windowMs)', () => {
    const mod = loadModule();
    for (const tagId of ['tag-a', 'tag-b', 'tag-c', 'tag-d']) {
      const jitter = mod.computeJitterMs('org-1', tagId, 300000);
      expect(jitter).toBeGreaterThanOrEqual(0);
      expect(jitter).toBeLessThan(300000);
    }
  });

  it('generally differs across distinct (org, tag) pairs', () => {
    const mod = loadModule();
    const jitters = new Set(
      ['tag-a', 'tag-b', 'tag-c', 'tag-d', 'tag-e'].map((t) => mod.computeJitterMs('org-1', t, 300000)),
    );
    expect(jitters.size).toBeGreaterThan(1);
  });
});

describe('handleTagReportDueTrigger', () => {
  it('starts an automated run for the given org/tag', async () => {
    const mod = loadModule();
    await mod.handleTagReportDueTrigger('org-1', 'tag-1');
    expect(startTagReportRun).toHaveBeenCalledWith({
      orgId: 'org-1', userId: null, tagId: 'tag-1', runMode: 'automated', trigger: 'scheduled',
    });
  });

  it('logs a warning (does not throw) when the run cannot start', async () => {
    startTagReportRun = vi.fn(async () => ({ ok: false, status: 400, error: 'This tag has no surveys to report on' }));
    const mod = loadModule();
    await expect(mod.handleTagReportDueTrigger('org-1', 'tag-1')).resolves.toBeUndefined();
    expect(loggerWarn).toHaveBeenCalled();
  });
});

describe('sweepDueTagReports', () => {
  it('enqueues one publish call per due tag, with a bounded jitter delay', async () => {
    process.env.TAG_REPORT_JITTER_WINDOW_MS = '5'; // keep the test fast
    dbQuery = vi.fn(async () => ({
      rows: [
        { org_id: 'org-1', tag_id: 'tag-1', cadence_hours: 24, last_run_at: null },
        { org_id: 'org-2', tag_id: 'tag-2', cadence_hours: 24, last_run_at: null },
      ],
    }));
    const mod = loadModule();
    const publish = vi.fn(async () => 'stream-id-1');

    const result = await mod.sweepDueTagReports(NOW, publish);
    expect(result).toEqual({ found: 2, enqueued: 2 });

    // Jitter delay is bounded by TAG_REPORT_JITTER_WINDOW_MS — wait comfortably
    // past it for the setTimeout-scheduled publish calls to fire.
    await new Promise((r) => setTimeout(r, 30));
    expect(publish).toHaveBeenCalledWith({ orgId: 'org-1', triggerType: 'tag_report.automated_due', event: { entityId: 'tag-1' } });
    expect(publish).toHaveBeenCalledWith({ orgId: 'org-2', triggerType: 'tag_report.automated_due', event: { entityId: 'tag-2' } });
  });

  it('does nothing when no tags are due', async () => {
    dbQuery = vi.fn(async () => ({ rows: [] }));
    const mod = loadModule();
    const publish = vi.fn(async () => 'x');
    const result = await mod.sweepDueTagReports(NOW, publish);
    expect(result).toEqual({ found: 0, enqueued: 0 });
    expect(publish).not.toHaveBeenCalled();
  });

  it('logs a warning (does not throw) if a publish call rejects', async () => {
    process.env.TAG_REPORT_JITTER_WINDOW_MS = '5';
    dbQuery = vi.fn(async () => ({
      rows: [{ org_id: 'org-1', tag_id: 'tag-1', cadence_hours: 24, last_run_at: null }],
    }));
    const mod = loadModule();
    const publish = vi.fn(async () => { throw new Error('redis down'); });
    await mod.sweepDueTagReports(NOW, publish);
    await new Promise((r) => setTimeout(r, 30));
    expect(loggerWarn).toHaveBeenCalled();
  });
});
