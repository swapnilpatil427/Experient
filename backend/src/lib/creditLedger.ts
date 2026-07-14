/**
 * Credit ledger — the financial backbone. Source of truth is Postgres (credit_accounts +
 * credit_ledger). All debits are atomic via SELECT ... FOR UPDATE so concurrent AI calls can
 * never double-spend or drive the balance negative past the configured ceiling.
 *
 * Consumption order on debit: allowance_remaining → pack_balance → overage (if opted in & under ceiling).
 * Spend cap "on by default" == overage_enabled false → AI pauses cleanly at allowance exhaustion.
 *
 * Only the expensive analytical AI + pass-through comms are metered (see creditPlans.ts).
 */
import { query, pool } from './db';
import { getRedisClient } from './redis';
import { creditConsumed, creditGranted, creditDecisions } from './metrics';
import {
  PLAN_MONTHLY_ALLOWANCE, FREE_LIFETIME_GRANT, PLAN_PERIOD_DAYS, DEFAULT_PLAN,
  type PlanTier, type MeteredAction,
} from './creditPlans';

export class InsufficientCreditsError extends Error {
  readonly code = 'INSUFFICIENT_CREDITS';
  readonly required: number;
  readonly available: number;
  constructor(required: number, available: number) {
    super(`Insufficient credits: need ${required}, have ${available}`);
    this.name = 'InsufficientCreditsError';
    this.required = required;
    this.available = available;
  }
}

export interface CreditAccount {
  org_id: string;
  plan_tier: PlanTier;
  monthly_allowance: number;
  allowance_remaining: number;
  period_start: string;
  pack_balance: number;
  overage_enabled: boolean;
  overage_ceiling: number | null;
  overage_used: number;
  created_at: string;
  updated_at: string;
}

export interface CreditBalance {
  plan_tier: PlanTier;
  monthly_allowance: number;
  allowance_remaining: number;
  pack_balance: number;
  available: number;            // allowance_remaining + pack_balance
  overage_enabled: boolean;
  overage_ceiling: number | null;
  overage_used: number;
  overage_remaining: number | null;  // null = unlimited (when enabled & no ceiling)
  period_start: string;
  period_days: number;
}

type LedgerSource = 'allowance' | 'pack' | 'overage' | 'grant' | 'system';

interface DebitOpts {
  actionType: MeteredAction | string;
  credits: number;
  userId?: string | null;
  actionRef?: string | null;
  unitCostUsd?: number | null;
  note?: string | null;
}

const PERIOD_INTERVAL = `${PLAN_PERIOD_DAYS} days`;

/** Resolve the org's intended plan from org_profiles (falls back to 'free'). */
async function resolvePlanTier(orgId: string): Promise<PlanTier> {
  try {
    const { rows } = await query<{ plan_tier: string | null }>(
      `SELECT plan_tier FROM org_profiles WHERE org_id = $1`,
      [orgId]
    );
    const t = rows[0]?.plan_tier;
    if (t && t in PLAN_MONTHLY_ALLOWANCE) return t as PlanTier;
  } catch { /* org_profiles may not exist in some envs — default below */ }
  return DEFAULT_PLAN;
}

/** Lazily create the account on first touch, seeding plan + allowance (and free lifetime grant). */
export async function getOrCreateAccount(orgId: string): Promise<CreditAccount> {
  const existing = await query<CreditAccount>(`SELECT * FROM credit_accounts WHERE org_id = $1`, [orgId]);
  if (existing.rows[0]) return existing.rows[0];

  const plan = await resolvePlanTier(orgId);
  const monthly = PLAN_MONTHLY_ALLOWANCE[plan];
  const lifetimePack = plan === 'free' ? FREE_LIFETIME_GRANT : 0;

  // ON CONFLICT DO NOTHING: RETURNING yields a row ONLY for the request that actually
  // inserts. A concurrent first-touch loses the race, gets 0 rows, and must NOT re-write
  // the lifetime grant (that would double-count it in the ledger).
  const inserted = await query<CreditAccount>(
    `INSERT INTO credit_accounts
       (org_id, plan_tier, monthly_allowance, allowance_remaining, pack_balance, period_start)
     VALUES ($1, $2, $3, $3, $4, NOW())
     ON CONFLICT (org_id) DO NOTHING
     RETURNING *`,
    [orgId, plan, monthly, lifetimePack]
  );

  if (!inserted.rows[0]) {
    // Lost the create race — return the row the winner created.
    const race = await query<CreditAccount>(`SELECT * FROM credit_accounts WHERE org_id = $1`, [orgId]);
    return race.rows[0];
  }

  const acct = inserted.rows[0];
  if (lifetimePack > 0) {
    await writeLedger({
      orgId, userId: null, actionType: 'grant', credits: lifetimePack, source: 'grant',
      actionRef: null, balanceAfter: acct.allowance_remaining + acct.pack_balance,
      note: 'Free tier lifetime grant',
    });
  }
  return acct;
}

/** Atomic conditional reset used by read paths. Returns the reset row, or null if not elapsed. */
async function resetIfElapsed(orgId: string): Promise<CreditAccount | null> {
  const { rows } = await query<CreditAccount>(
    `UPDATE credit_accounts
        SET allowance_remaining = monthly_allowance, overage_used = 0, period_start = NOW()
      WHERE org_id = $1
        AND NOW() - period_start >= $2::interval
      RETURNING *`,
    [orgId, PERIOD_INTERVAL]
  );
  const row = rows[0] ?? null;
  if (row) {
    await writeLedger({
      orgId, userId: null, actionType: 'allowance_reset', credits: row.monthly_allowance,
      source: 'allowance', actionRef: null, balanceAfter: row.allowance_remaining + row.pack_balance,
      note: 'Monthly allowance reset',
    });
    await cacheDel(orgId);
  }
  return row;
}

interface LedgerRow {
  orgId: string;
  userId: string | null;
  actionType: string;
  credits: number;
  source: LedgerSource;
  actionRef: string | null;
  balanceAfter: number;
  unitCostUsd?: number | null;
  note?: string | null;
}

async function writeLedger(r: LedgerRow): Promise<void> {
  await query(
    `INSERT INTO credit_ledger
       (org_id, user_id, action_type, credits, source, action_ref, balance_after, unit_cost_usd, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [r.orgId, r.userId, r.actionType, r.credits, r.source, r.actionRef,
     r.balanceAfter, r.unitCostUsd ?? null, r.note ?? null]
  );
}

function toBalance(a: CreditAccount): CreditBalance {
  const overageRemaining = a.overage_enabled
    ? (a.overage_ceiling == null ? null : Math.max(0, a.overage_ceiling - a.overage_used))
    : 0;
  return {
    plan_tier: a.plan_tier,
    monthly_allowance: a.monthly_allowance,
    allowance_remaining: a.allowance_remaining,
    pack_balance: a.pack_balance,
    available: a.allowance_remaining + a.pack_balance,
    overage_enabled: a.overage_enabled,
    overage_ceiling: a.overage_ceiling,
    overage_used: a.overage_used,
    overage_remaining: overageRemaining,
    period_start: a.period_start,
    period_days: PLAN_PERIOD_DAYS,
  };
}

// ── Balance cache (Redis) ────────────────────────────────────────────────────
// Takes the read-only hot path (checkCredits + the UI chip) off Postgres at scale. Fail-open:
// no Redis → straight to Postgres. Debits never read the cache (they use SELECT ... FOR UPDATE),
// so a slightly-stale cached pre-check can never cause an incorrect charge — the debit re-checks
// authoritatively. Every mutation invalidates the key, and the short TTL bounds staleness.
const CACHE_TTL_SEC = (() => { const n = Number(process.env.CREDIT_BALANCE_CACHE_TTL); return Number.isFinite(n) && n >= 0 ? n : 10; })();
const cacheKey = (orgId: string): string => `credits:${orgId}`;

async function cacheGet(orgId: string): Promise<CreditBalance | null> {
  if (CACHE_TTL_SEC === 0) return null;
  const r = getRedisClient();
  if (!r || r.status !== 'ready') return null;
  try { const v = await r.get(cacheKey(orgId)); return v ? (JSON.parse(v) as CreditBalance) : null; }
  catch { return null; }
}
async function cacheSet(orgId: string, b: CreditBalance): Promise<void> {
  if (CACHE_TTL_SEC === 0) return;
  const r = getRedisClient();
  if (!r || r.status !== 'ready') return;
  try { await r.set(cacheKey(orgId), JSON.stringify(b), 'EX', CACHE_TTL_SEC); } catch { /* fail open */ }
}
async function cacheDel(orgId: string): Promise<void> {
  const r = getRedisClient();
  if (!r || r.status !== 'ready') return;
  try { await r.del(cacheKey(orgId)); } catch { /* noop */ }
}

export async function getBalance(orgId: string, opts: { fresh?: boolean } = {}): Promise<CreditBalance> {
  if (!opts.fresh) {
    const cached = await cacheGet(orgId);
    if (cached) return cached;
  }
  await getOrCreateAccount(orgId);
  const reset = await resetIfElapsed(orgId);
  const acct = reset ?? (await query<CreditAccount>(`SELECT * FROM credit_accounts WHERE org_id = $1`, [orgId])).rows[0];
  const balance = toBalance(acct);
  await cacheSet(orgId, balance);
  return balance;
}

export interface CheckResult { ok: boolean; available: number; required: number; via: 'balance' | 'overage' | 'denied'; }

/**
 * Non-mutating affordability check (used as the pre-flight gate before an AI call).
 * `action` is optional and used only to label the credit_decisions metric.
 */
export async function checkCredits(orgId: string, cost: number, action = 'unknown'): Promise<CheckResult> {
  if (cost <= 0) return { ok: true, available: Infinity, required: cost, via: 'balance' };
  const b = await getBalance(orgId);
  const allow = (via: 'balance' | 'overage'): CheckResult => {
    creditDecisions.inc({ action, result: 'allowed' });
    return { ok: true, available: b.available, required: cost, via };
  };
  if (b.available >= cost) return allow('balance');
  const needed = cost - b.available;
  if (b.overage_enabled && (b.overage_remaining == null || b.overage_remaining >= needed)) {
    return allow('overage');
  }
  creditDecisions.inc({ action, result: 'denied' });
  return { ok: false, available: b.available, required: cost, via: 'denied' };
}

/**
 * Atomically debit `credits`. Throws InsufficientCreditsError if the org can't afford it
 * (and overage is off or over its ceiling). Returns the resulting balance.
 */
export async function debitCredits(orgId: string, opts: DebitOpts): Promise<CreditBalance> {
  const cost = Math.max(0, Math.trunc(opts.credits));
  await getOrCreateAccount(orgId);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<CreditAccount>(
      `SELECT * FROM credit_accounts WHERE org_id = $1 FOR UPDATE`, [orgId]
    );
    const a = rows[0];

    // Lazy period reset inside the lock.
    const elapsedMs = Date.now() - new Date(a.period_start).getTime();
    const periodElapsed = elapsedMs >= PLAN_PERIOD_DAYS * 24 * 3600 * 1000;
    let allowance = periodElapsed ? a.monthly_allowance : a.allowance_remaining;
    let overageUsed = periodElapsed ? 0 : a.overage_used;
    let pack = a.pack_balance;
    const periodStartSql = periodElapsed ? 'NOW()' : '$5';

    const available = allowance + pack;
    let fromAllowance = 0, fromPack = 0, fromOverage = 0;
    if (cost > 0) {
      fromAllowance = Math.min(allowance, cost);
      let left = cost - fromAllowance;
      fromPack = Math.min(pack, left);
      left -= fromPack;
      if (left > 0) {
        const ceilingOk = a.overage_enabled &&
          (a.overage_ceiling == null || overageUsed + left <= a.overage_ceiling);
        if (!ceilingOk) {
          await client.query('ROLLBACK');
          throw new InsufficientCreditsError(cost, available);
        }
        fromOverage = left;
      }
    }

    allowance -= fromAllowance;
    pack -= fromPack;
    overageUsed += fromOverage;
    const balanceAfter = allowance + pack;

    const params = periodElapsed
      ? [orgId, allowance, pack, overageUsed]
      : [orgId, allowance, pack, overageUsed, a.period_start];
    await client.query(
      `UPDATE credit_accounts
          SET allowance_remaining = $2, pack_balance = $3, overage_used = $4, period_start = ${periodStartSql}
        WHERE org_id = $1`,
      params
    );

    if (periodElapsed) {
      await client.query(
        `INSERT INTO credit_ledger (org_id, action_type, credits, source, balance_after, note)
         VALUES ($1, 'allowance_reset', $2, 'allowance', $3, 'Monthly allowance reset')`,
        [orgId, a.monthly_allowance, a.monthly_allowance + a.pack_balance]
      );
    }

    let consumedSource: LedgerSource | null = null;
    if (cost > 0) {
      consumedSource = fromAllowance > 0 ? 'allowance' : fromPack > 0 ? 'pack' : 'overage';
      const split = [
        fromAllowance ? `allowance:${fromAllowance}` : null,
        fromPack ? `pack:${fromPack}` : null,
        fromOverage ? `overage:${fromOverage}` : null,
      ].filter(Boolean).join(' ');
      await client.query(
        `INSERT INTO credit_ledger
           (org_id, user_id, action_type, credits, source, action_ref, balance_after, unit_cost_usd, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [orgId, opts.userId ?? null, opts.actionType, -cost, consumedSource, opts.actionRef ?? null,
         balanceAfter, opts.unitCostUsd ?? null, opts.note ?? split]
      );
    }

    await client.query('COMMIT');

    // Record consumption only after the transaction commits (avoid over-counting on rollback).
    if (cost > 0 && consumedSource) {
      creditConsumed.inc({ action: String(opts.actionType), source: consumedSource }, cost);
    }
    await cacheDel(orgId);

    return toBalance({
      ...a, allowance_remaining: allowance, pack_balance: pack, overage_used: overageUsed,
      period_start: periodElapsed ? new Date().toISOString() : a.period_start,
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  } finally {
    client.release();
  }
}

/** Add purchased / granted credits to the rolling pack balance. */
export async function grantCredits(
  orgId: string,
  credits: number,
  opts: { source?: 'grant' | 'pack'; note?: string; userId?: string | null; unitCostUsd?: number | null; actionRef?: string | null } = {}
): Promise<CreditBalance> {
  const amount = Math.max(0, Math.trunc(credits));
  await getOrCreateAccount(orgId);
  const { rows } = await query<CreditAccount>(
    `UPDATE credit_accounts SET pack_balance = pack_balance + $2 WHERE org_id = $1 RETURNING *`,
    [orgId, amount]
  );
  const a = rows[0];
  await writeLedger({
    orgId, userId: opts.userId ?? null, actionType: 'grant', credits: amount,
    source: opts.source ?? 'grant', actionRef: opts.actionRef ?? null,
    balanceAfter: a.allowance_remaining + a.pack_balance,
    unitCostUsd: opts.unitCostUsd ?? null, note: opts.note ?? 'Credit grant',
  });
  if (amount > 0) creditGranted.inc({ source: opts.source ?? 'grant' }, amount);
  await cacheDel(orgId);
  return toBalance(a);
}

/**
 * True if a grant with this external reference was already recorded — used to make Stripe
 * webhook fulfilment idempotent (Stripe may deliver the same event more than once).
 */
export async function grantExists(orgId: string, actionRef: string): Promise<boolean> {
  if (!actionRef) return false;
  const { rows } = await query(
    `SELECT 1 FROM credit_ledger WHERE org_id = $1 AND action_ref = $2 AND action_type = 'grant' LIMIT 1`,
    [orgId, actionRef]
  );
  return rows.length > 0;
}

/**
 * Change the org's plan; resets the allowance to the new plan's monthly amount immediately.
 *
 * Also writes org_profiles.plan_tier, in the same transaction as the credit_accounts update.
 * org_profiles.plan_tier — not credit_accounts.plan_tier — is what planGating.ts/seats.ts/
 * roles.ts actually gate Command Center, workflow triggers, seat limits, and enterprise-only
 * features on. Before this, org_profiles.plan_tier was only ever seeded once, by
 * getOrCreateAccount() on an org's first credit touch, and never updated again — so any org
 * that changed plans after that (i.e. every plan change through this endpoint) would silently
 * drift the two columns apart: credits/allowance would reflect the new plan while every
 * plan-tier-gated feature kept checking the stale org_profiles value. See
 * 20260716000000_org_profiles_plan_tier_widen.sql, which widens org_profiles.plan_tier's
 * CHECK constraint to accept the full PlanTier set so this write can never fail here.
 */
export async function setPlan(orgId: string, plan: PlanTier, userId?: string | null): Promise<CreditBalance> {
  await getOrCreateAccount(orgId);
  const monthly = PLAN_MONTHLY_ALLOWANCE[plan];

  const client = await pool.connect();
  let a: CreditAccount;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<CreditAccount>(
      `UPDATE credit_accounts
          SET plan_tier = $2, monthly_allowance = $3, allowance_remaining = $3,
              overage_used = 0, period_start = NOW()
        WHERE org_id = $1
        RETURNING *`,
      [orgId, plan, monthly]
    );
    a = rows[0];
    // Upsert, not a plain UPDATE: via the HTTP route, requireAuth's ensureProvisioned()
    // always creates the org_profiles row first, so an UPDATE would be enough there — but
    // setPlan() is also called directly by scripts/set-org-plan.ts (dev/staging setup,
    // bypasses the API/auth layer entirely), where no such guarantee holds. A plain UPDATE
    // against a nonexistent row silently affects 0 rows with no error, so the org_profiles
    // side would never actually take effect while this call still reports success.
    await client.query(
      `INSERT INTO org_profiles (org_id, plan_tier) VALUES ($1, $2)
         ON CONFLICT (org_id) DO UPDATE SET plan_tier = EXCLUDED.plan_tier`,
      [orgId, plan]
    );
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  } finally {
    client.release();
  }

  await writeLedger({
    orgId, userId: userId ?? null, actionType: 'plan_change', credits: monthly,
    source: 'allowance', actionRef: null, balanceAfter: a.allowance_remaining + a.pack_balance,
    note: `Plan changed to ${plan}`,
  });
  await cacheDel(orgId);
  return toBalance(a);
}

/** Set the spend cap: overage off (default) pauses AI at allowance; on allows overage to a ceiling. */
export async function setOverage(
  orgId: string, enabled: boolean, ceiling: number | null
): Promise<CreditBalance> {
  await getOrCreateAccount(orgId);
  const cleanCeiling = ceiling == null ? null : Math.max(0, Math.trunc(ceiling));
  const { rows } = await query<CreditAccount>(
    `UPDATE credit_accounts SET overage_enabled = $2, overage_ceiling = $3 WHERE org_id = $1 RETURNING *`,
    [orgId, enabled, cleanCeiling]
  );
  await cacheDel(orgId);
  return toBalance(rows[0]);
}

export interface LedgerEntry {
  id: string;
  action_type: string;
  credits: number;
  source: string;
  action_ref: string | null;
  balance_after: number;
  unit_cost_usd: number | null;
  note: string | null;
  user_id: string | null;
  created_at: string;
}

export async function listLedger(orgId: string, limit = 50, offset = 0): Promise<{ entries: LedgerEntry[]; total: number }> {
  const safeLimit = Math.min(200, Math.max(1, limit));
  const safeOffset = Math.max(0, offset);
  const [{ rows }, { rows: countRows }] = await Promise.all([
    query<LedgerEntry>(
      `SELECT id, action_type, credits, source, action_ref, balance_after, unit_cost_usd, note, user_id, created_at
         FROM credit_ledger WHERE org_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [orgId, safeLimit, safeOffset]
    ),
    query<{ total: string }>(`SELECT COUNT(*)::text AS total FROM credit_ledger WHERE org_id = $1`, [orgId]),
  ]);
  return { entries: rows, total: Number(countRows[0]?.total ?? 0) };
}

export interface UsageSummaryRow { action_type: string; total_credits: number; event_count: number; total_cost_usd: number; }

/** Aggregate spend by action over the trailing N days (default = current period). */
export async function getUsageSummary(orgId: string, days = PLAN_PERIOD_DAYS): Promise<UsageSummaryRow[]> {
  const { rows } = await query<{ action_type: string; total_credits: string; event_count: string; total_cost_usd: string | null }>(
    `SELECT action_type,
            SUM(-credits)::text          AS total_credits,
            COUNT(*)::text               AS event_count,
            COALESCE(SUM(unit_cost_usd), 0)::text AS total_cost_usd
       FROM credit_ledger
      WHERE org_id = $1 AND credits < 0 AND created_at >= NOW() - ($2 || ' days')::interval
      GROUP BY action_type
      ORDER BY SUM(-credits) DESC`,
    [orgId, String(days)]
  );
  return rows.map((r) => ({
    action_type: r.action_type,
    total_credits: Number(r.total_credits),
    event_count: Number(r.event_count),
    total_cost_usd: Number(r.total_cost_usd ?? 0),
  }));
}
