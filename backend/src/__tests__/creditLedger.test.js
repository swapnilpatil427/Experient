/**
 * Unit tests for lib/creditLedger.ts — the credit system's core arithmetic.
 *
 * Verifies the consumption order (allowance → pack → overage), insufficient-credit
 * behaviour with the spend cap on/off, overage ceilings, grants, plan changes, and
 * the affordability check. The DB is an in-memory fake that interprets the lib's SQL.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);

const DB_PATH     = _require.resolve(resolve(__dirname, '../lib/db'));
const LEDGER_PATH = _require.resolve(resolve(__dirname, '../lib/creditLedger'));

function fakeMod(id, exports) {
  return { id, filename: id, loaded: true, exports, children: [] };
}

function baseAccount(overrides = {}) {
  return {
    org_id: 'o1',
    plan_tier: 'growth',
    monthly_allowance: 12000,
    allowance_remaining: 0,
    period_start: new Date().toISOString(), // recent → not elapsed
    pack_balance: 0,
    overage_enabled: false,
    overage_ceiling: null,
    overage_used: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

// Build a fake { query, pool } backed by a single mutable account.
function makeDb(account) {
  const ledger = [];
  const orgProfileUpdates = [];  // tracks UPDATE org_profiles SET plan_tier calls (setPlan sync)
  const handle = (sql, params) => {
    const s = String(sql);
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(s)) return { rows: [] };
    // INSERT INTO org_profiles ... ON CONFLICT DO UPDATE SET plan_tier — checked before the
    // generic credit_accounts 'plan_tier = $2' branch below, since both statements contain
    // that substring.
    if (s.includes('INSERT INTO org_profiles') && s.includes('plan_tier')) {
      orgProfileUpdates.push({ orgId: params[0], planTier: params[1] });
      return { rows: [] };
    }
    if (s.includes('FROM org_profiles')) return { rows: [] };
    if (s.includes('SELECT') && s.includes('FROM credit_accounts')) return { rows: [{ ...account }] };
    if (s.includes('INSERT INTO credit_accounts')) return { rows: [{ ...account }] };
    if (s.includes('NOW() - period_start')) return { rows: [] };                  // reset-if-elapsed → not elapsed
    if (s.includes('UPDATE credit_accounts') && s.includes('plan_tier = $2')) {     // setPlan
      account.plan_tier = params[1];
      account.monthly_allowance = Number(params[2]);
      account.allowance_remaining = Number(params[2]);
      account.overage_used = 0;
      return { rows: [{ ...account }] };
    }
    if (s.includes('overage_enabled = $2')) {                                      // setOverage
      account.overage_enabled = params[1];
      account.overage_ceiling = params[2];
      return { rows: [{ ...account }] };
    }
    if (s.includes('pack_balance = pack_balance +')) {                             // grant
      account.pack_balance += Number(params[1]);
      return { rows: [{ ...account }] };
    }
    if (s.includes('allowance_remaining = $2')) {                                  // debit update
      account.allowance_remaining = Number(params[1]);
      account.pack_balance = Number(params[2]);
      account.overage_used = Number(params[3]);
      return { rows: [] };
    }
    if (s.includes('INSERT INTO credit_ledger')) { ledger.push(params); return { rows: [] }; }
    if (s.includes('FROM credit_ledger')) return { rows: [] };
    return { rows: [] };
  };
  const query  = vi.fn(async (sql, params) => handle(sql, params));
  const client = { query: vi.fn(async (sql, params) => handle(sql, params)), release: vi.fn() };
  const pool   = { connect: vi.fn(async () => client) };
  return { query, pool, ledger, client, orgProfileUpdates };
}

function loadLedger(account) {
  const db = makeDb(account);
  _require.cache[DB_PATH] = fakeMod(DB_PATH, { query: db.query, pool: db.pool, default: { query: db.query, pool: db.pool } });
  delete _require.cache[LEDGER_PATH];
  const mod = _require(LEDGER_PATH);
  return { mod, db };
}

describe('creditLedger — debit consumption order', () => {
  it('debits from the monthly allowance first', async () => {
    const account = baseAccount({ allowance_remaining: 100, pack_balance: 0 });
    const { mod } = loadLedger(account);
    const balance = await mod.debitCredits('o1', { actionType: 'crystal_turn', credits: 50 });
    expect(balance.allowance_remaining).toBe(50);
    expect(balance.pack_balance).toBe(0);
    expect(balance.available).toBe(50);
  });

  it('spills over from allowance into pack balance', async () => {
    const account = baseAccount({ allowance_remaining: 30, pack_balance: 100 });
    const { mod } = loadLedger(account);
    const balance = await mod.debitCredits('o1', { actionType: 'insight_run', credits: 50 });
    expect(balance.allowance_remaining).toBe(0);
    expect(balance.pack_balance).toBe(80);   // 100 - (50 - 30)
    expect(balance.available).toBe(80);
  });
});

describe('creditLedger — spend cap / overage', () => {
  it('throws InsufficientCreditsError when out of credits and overage is off', async () => {
    const account = baseAccount({ allowance_remaining: 10, pack_balance: 0, overage_enabled: false });
    const { mod } = loadLedger(account);
    await expect(mod.debitCredits('o1', { actionType: 'insight_run', credits: 50 }))
      .rejects.toMatchObject({ code: 'INSUFFICIENT_CREDITS', required: 50, available: 10 });
  });

  it('allows overage within the ceiling', async () => {
    const account = baseAccount({ allowance_remaining: 10, pack_balance: 0, overage_enabled: true, overage_ceiling: 100, overage_used: 0 });
    const { mod } = loadLedger(account);
    const balance = await mod.debitCredits('o1', { actionType: 'insight_run', credits: 50 });
    expect(balance.allowance_remaining).toBe(0);
    expect(balance.overage_used).toBe(40);   // 50 - 10 covered by allowance
    expect(balance.available).toBe(0);
  });

  it('rejects overage beyond the ceiling', async () => {
    const account = baseAccount({ allowance_remaining: 0, pack_balance: 0, overage_enabled: true, overage_ceiling: 30 });
    const { mod } = loadLedger(account);
    await expect(mod.debitCredits('o1', { actionType: 'xo_fusion', credits: 50 }))
      .rejects.toMatchObject({ code: 'INSUFFICIENT_CREDITS' });
  });
});

describe('creditLedger — checkCredits (affordability gate)', () => {
  it('passes when balance covers the cost', async () => {
    const account = baseAccount({ allowance_remaining: 200, pack_balance: 0 });
    const { mod } = loadLedger(account);
    const r = await mod.checkCredits('o1', 50);
    expect(r.ok).toBe(true);
    expect(r.via).toBe('balance');
  });

  it('denies when out of credits and overage is off', async () => {
    const account = baseAccount({ allowance_remaining: 10, pack_balance: 0, overage_enabled: false });
    const { mod } = loadLedger(account);
    const r = await mod.checkCredits('o1', 50);
    expect(r.ok).toBe(false);
    expect(r.via).toBe('denied');
  });

  it('passes via overage when enabled and under ceiling', async () => {
    const account = baseAccount({ allowance_remaining: 0, pack_balance: 0, overage_enabled: true, overage_ceiling: 100 });
    const { mod } = loadLedger(account);
    const r = await mod.checkCredits('o1', 50);
    expect(r.ok).toBe(true);
    expect(r.via).toBe('overage');
  });

  it('treats a zero/negative cost as always affordable', async () => {
    const account = baseAccount({ allowance_remaining: 0 });
    const { mod } = loadLedger(account);
    const r = await mod.checkCredits('o1', 0);
    expect(r.ok).toBe(true);
  });
});

describe('creditLedger — grants & plan changes', () => {
  it('adds granted credits to the rolling pack balance', async () => {
    const account = baseAccount({ allowance_remaining: 0, pack_balance: 100 });
    const { mod } = loadLedger(account);
    const balance = await mod.grantCredits('o1', 5000, { note: 'top-up' });
    expect(balance.pack_balance).toBe(5100);
  });

  it('setPlan resets the allowance to the new plan amount', async () => {
    const account = baseAccount({ plan_tier: 'starter', monthly_allowance: 1500, allowance_remaining: 200 });
    const { mod } = loadLedger(account);
    const balance = await mod.setPlan('o1', 'growth');
    expect(balance.plan_tier).toBe('growth');
    expect(balance.allowance_remaining).toBe(12000);
  });

  it('setPlan also syncs org_profiles.plan_tier, not just credit_accounts', async () => {
    // Regression test: org_profiles.plan_tier (not credit_accounts.plan_tier) is what
    // planGating.ts/seats.ts/roles.ts gate Command Center, workflow triggers, seat limits,
    // and enterprise-only features on. Before this fix, setPlan() only updated
    // credit_accounts — an org could "upgrade" (correct credit allowance) and still get
    // 403'd out of plan-gated features because org_profiles never moved off its default.
    const account = baseAccount({ plan_tier: 'starter', monthly_allowance: 1500, allowance_remaining: 200 });
    const { mod, db } = loadLedger(account);
    await mod.setPlan('o1', 'growth');
    expect(db.orgProfileUpdates).toEqual([{ orgId: 'o1', planTier: 'growth' }]);
  });

  it('setOverage toggles the spend cap', async () => {
    const account = baseAccount();
    const { mod } = loadLedger(account);
    const balance = await mod.setOverage('o1', true, 5000);
    expect(balance.overage_enabled).toBe(true);
    expect(balance.overage_ceiling).toBe(5000);
  });
});
