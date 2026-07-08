// Unit coverage for lib/planGating.ts — the single source of truth both
// routes/workflows.ts (save time) and workflowEngine.ts (execution time) use to
// decide whether an org's plan allows a given workflow trigger type (Nina,
// 2026-07-01, DEEP_AUDIT_PM_FINDINGS.md §6d). Route/engine-level integration
// coverage lives in workflowTierGating.test.js and workflowEngine.test.js.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);

const DB_PATH  = _require.resolve(resolve(__dirname, '../lib/db'));
const MOD_PATH = _require.resolve(resolve(__dirname, '../lib/planGating'));

let dbQuery;
function fakeMod(id, exports) { return { id, filename: id, loaded: true, exports, children: [] }; }
function load() {
  _require.cache[DB_PATH] = fakeMod(DB_PATH, { query: dbQuery, default: { query: dbQuery } });
  delete _require.cache[MOD_PATH];
  return _require(MOD_PATH);
}

beforeEach(() => {
  dbQuery = vi.fn(async () => ({ rows: [] }));
});

describe('minPlanTierFor', () => {
  it('returns "growth" for each Crystal Signal trigger', () => {
    const { minPlanTierFor } = load();
    expect(minPlanTierFor('crystal.anomaly_detected')).toBe('growth');
    expect(minPlanTierFor('crystal.sentiment_spike')).toBe('growth');
    expect(minPlanTierFor('crystal.new_theme_detected')).toBe('growth');
  });
  it('returns undefined for ungated triggers', () => {
    const { minPlanTierFor } = load();
    expect(minPlanTierFor('time.schedule')).toBeUndefined();
    expect(minPlanTierFor('alert.fired')).toBeUndefined();
  });
  it('returns undefined for null/undefined/unknown trigger types', () => {
    const { minPlanTierFor } = load();
    expect(minPlanTierFor(null)).toBeUndefined();
    expect(minPlanTierFor(undefined)).toBeUndefined();
    expect(minPlanTierFor('not.a.real.trigger')).toBeUndefined();
  });
});

describe('resolveOrgPlanTier', () => {
  it('returns the org plan_tier from org_profiles', async () => {
    dbQuery = vi.fn(async () => ({ rows: [{ plan_tier: 'growth' }] }));
    const { resolveOrgPlanTier } = load();
    expect(await resolveOrgPlanTier('o1')).toBe('growth');
  });
  it('defaults to the DEFAULT_PLAN when org_profiles has no row', async () => {
    dbQuery = vi.fn(async () => ({ rows: [] }));
    const { resolveOrgPlanTier } = load();
    expect(await resolveOrgPlanTier('o1')).toBe('free');
  });
  it('defaults to the DEFAULT_PLAN when plan_tier is an invalid value', async () => {
    dbQuery = vi.fn(async () => ({ rows: [{ plan_tier: 'not-a-tier' }] }));
    const { resolveOrgPlanTier } = load();
    expect(await resolveOrgPlanTier('o1')).toBe('free');
  });
  it('fails to the safe default when org_profiles does not exist (some envs)', async () => {
    dbQuery = vi.fn(async () => { throw new Error('relation "org_profiles" does not exist'); });
    const { resolveOrgPlanTier } = load();
    expect(await resolveOrgPlanTier('o1')).toBe('free');
  });
});

describe('meetsPlanTier', () => {
  it('a higher-ranked org tier meets a lower requirement', () => {
    const { meetsPlanTier } = load();
    expect(meetsPlanTier('enterprise', 'growth')).toBe(true);
    expect(meetsPlanTier('growth', 'growth')).toBe(true);
  });
  it('a lower-ranked org tier does not meet a higher requirement', () => {
    const { meetsPlanTier } = load();
    expect(meetsPlanTier('free', 'growth')).toBe(false);
    expect(meetsPlanTier('starter', 'growth')).toBe(false);
  });
});

describe('checkTriggerTierGate', () => {
  it('always allows an ungated trigger, regardless of plan (no DB call needed)', async () => {
    const { checkTriggerTierGate } = load();
    const result = await checkTriggerTierGate('o1', 'time.schedule');
    expect(result).toEqual({ allowed: true });
    expect(dbQuery).not.toHaveBeenCalled();
  });
  it('allows a gated trigger when the org is on a qualifying plan', async () => {
    dbQuery = vi.fn(async () => ({ rows: [{ plan_tier: 'enterprise' }] }));
    const { checkTriggerTierGate } = load();
    const result = await checkTriggerTierGate('o1', 'crystal.anomaly_detected');
    expect(result.allowed).toBe(true);
    expect(result.requiredTier).toBe('growth');
    expect(result.orgTier).toBe('enterprise');
  });
  it('rejects a gated trigger when the org is on a sub-Growth plan (free)', async () => {
    dbQuery = vi.fn(async () => ({ rows: [{ plan_tier: 'free' }] }));
    const { checkTriggerTierGate } = load();
    const result = await checkTriggerTierGate('o1', 'crystal.sentiment_spike');
    expect(result.allowed).toBe(false);
    expect(result.requiredTier).toBe('growth');
    expect(result.orgTier).toBe('free');
  });
  it('rejects a gated trigger when the org is on starter (below growth)', async () => {
    dbQuery = vi.fn(async () => ({ rows: [{ plan_tier: 'starter' }] }));
    const { checkTriggerTierGate } = load();
    const result = await checkTriggerTierGate('o1', 'crystal.new_theme_detected');
    expect(result.allowed).toBe(false);
  });
});

describe('upgradeRequiredMessage', () => {
  it('produces an upgrade-prompt-shaped message naming the trigger and required tier', () => {
    const { upgradeRequiredMessage } = load();
    const msg = upgradeRequiredMessage('crystal.anomaly_detected', 'growth');
    expect(msg).toContain('crystal.anomaly_detected');
    expect(msg).toMatch(/Growth/);
    expect(msg.toLowerCase()).toContain('upgrade');
  });
});
