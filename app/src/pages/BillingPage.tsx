import { useState, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import { useSetPageTitle } from '../contexts/pageTitle';
import { useApi } from '../hooks/useApi';
import { useCredits } from '../hooks/useCredits';
import { useTranslation } from '../lib/i18n';
import { PageHeader } from '../components/PageHeader';
import { Icon } from '../components/Icon';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { invalidate } from '../lib/dataBus';
import type { CreditUsageRow, CreditLedgerEntry, CreditPack } from '../lib/api';

const PLAN_ORDER = ['free', 'starter', 'growth', 'enterprise'] as const;
// Fallback prices if the backend /config doesn't supply plan_prices (it does by default).
const PLAN_PRICE_FALLBACK: Record<string, number> = { free: 0, starter: 49, growth: 299, enterprise: 1499, platform: 0 };
const PLAN_LABEL: Record<string, string> = {
  free: 'Free', starter: 'Starter', growth: 'Growth', enterprise: 'Enterprise', platform: 'Platform',
};

function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-2xl border border-outline-variant/40 bg-surface p-5 ${className}`}>{children}</div>
  );
}

export function BillingPage() {
  const { t } = useTranslation();
  useSetPageTitle(t('billing.title'), t('billing.subtitle'));
  const api = useApi();
  const { balance, config, loading, reload } = useCredits();

  const [usage,  setUsage]  = useState<CreditUsageRow[]>([]);
  const [ledger, setLedger] = useState<CreditLedgerEntry[]>([]);
  const [packs,  setPacks]  = useState<CreditPack[]>([]);
  const [stripeEnabled, setStripeEnabled] = useState(false);
  const [savingCap, setSavingCap] = useState(false);
  const [busyPlan,  setBusyPlan]  = useState<string | null>(null);
  const [buyMsg,    setBuyMsg]    = useState<string | null>(null);

  // Local spend-cap form state (seeded from balance).
  const [overageEnabled, setOverageEnabled] = useState(false);
  const [overageCeiling, setOverageCeiling] = useState<string>('');

  useEffect(() => {
    if (balance) {
      setOverageEnabled(balance.overage_enabled);
      setOverageCeiling(balance.overage_ceiling != null ? String(balance.overage_ceiling) : '');
    }
  }, [balance]);

  const loadDetails = useCallback(async () => {
    try {
      const [u, l, p] = await Promise.all([
        api.getCreditUsage().catch(() => ({ summary: [] as CreditUsageRow[], balance: undefined, days: 30 })),
        api.getCreditLedger(25, 0).catch(() => ({ entries: [] as CreditLedgerEntry[], total: 0 })),
        api.getCreditPacks().catch(() => ({ packs: [] as CreditPack[], stripe_enabled: false })),
      ]);
      setUsage(u.summary ?? []);
      setLedger(l.entries ?? []);
      setPacks(p.packs ?? []);
      setStripeEnabled(p.stripe_enabled ?? false);
    } catch { /* non-fatal */ }
  }, [api]);

  useEffect(() => { void loadDetails(); }, [loadDetails]);

  const refreshAll = useCallback(() => { invalidate('credits'); void reload(); void loadDetails(); }, [reload, loadDetails]);

  const saveCap = async () => {
    setSavingCap(true);
    try {
      const ceiling = overageEnabled && overageCeiling.trim() !== '' ? Math.max(0, Number(overageCeiling)) : null;
      await api.setSpendCap({ overage_enabled: overageEnabled, overage_ceiling: ceiling });
      refreshAll();
    } finally {
      setSavingCap(false);
    }
  };

  const changePlan = async (tier: string) => {
    setBusyPlan(tier);
    try { await api.setPlan(tier); refreshAll(); }
    finally { setBusyPlan(null); }
  };

  const buyPack = async (packId: string) => {
    setBuyMsg(null);
    try {
      const { url } = await api.startCheckout(packId);
      if (url) window.location.assign(url);
    } catch {
      setBuyMsg(t('billing.buyingNotConfigured'));
    }
  };

  const planTier = balance?.plan_tier ?? 'free';
  const allowancePct = balance && balance.monthly_allowance > 0
    ? (balance.allowance_remaining / balance.monthly_allowance) * 100
    : (balance && balance.available > 0 ? 100 : 0);
  const resetDate = balance
    ? new Date(new Date(balance.period_start).getTime() + balance.period_days * 86400000).toLocaleDateString()
    : '';

  return (
    <div className="max-w-7xl mx-auto w-full">
      <PageHeader
        crumbs={[{ label: t('nav.settings'), path: '/app/settings' }, { label: t('billing.title') }]}
        title={t('billing.title')}
        subtitle={t('billing.subtitle')}
      />

      {/* Marketing hero — pushes upgrades */}
      <motion.div
        initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        className="rounded-2xl p-6 md:p-8 mb-6 text-white relative overflow-hidden"
        style={{ background: 'linear-gradient(120deg, var(--color-primary), var(--color-tertiary))' }}
      >
        <div className="relative z-10 max-w-2xl">
          <div className="text-xs font-bold tracking-widest uppercase opacity-80 mb-2">Experient AI</div>
          <h2 className="text-2xl md:text-3xl font-black leading-tight mb-2">{t('billing.marketingHeadline')}</h2>
          <p className="text-sm md:text-base opacity-90">{t('billing.marketingSub')}</p>
        </div>
        <div className="absolute -right-8 -bottom-8 opacity-20">
          <Icon name="diamond" size={160} />
        </div>
      </motion.div>

      {loading && !balance ? (
        <div className="skeleton h-40 rounded-2xl" />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          {/* Balance */}
          <Card className="lg:col-span-2">
            <div className="flex items-start justify-between mb-4">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-on-surface-variant">{t('billing.balance')}</div>
                <div className="text-4xl font-black text-on-surface mt-1">{balance?.available ?? 0}<span className="text-base font-semibold text-on-surface-variant ml-1.5">{t('credits.creditsUnit')}</span></div>
              </div>
              <span className="px-3 py-1 rounded-full text-xs font-bold" style={{ background: 'color-mix(in srgb, var(--color-primary) 12%, transparent)', color: 'var(--color-primary)' }}>
                {PLAN_LABEL[planTier] ?? planTier}
              </span>
            </div>
            {balance && balance.monthly_allowance > 0 && (
              <>
                <div className="flex justify-between text-sm mb-1.5">
                  <span className="text-on-surface-variant">{t('billing.allowanceRemaining')}</span>
                  <span className="font-semibold">{balance.allowance_remaining} / {balance.monthly_allowance}</span>
                </div>
                <Progress value={allowancePct} className="h-2" />
                <p className="text-[11px] text-on-surface-variant mt-1.5">{t('billing.resetsOn', { date: resetDate })}</p>
              </>
            )}
            {balance && balance.pack_balance > 0 && (
              <div className="flex justify-between text-sm mt-3 pt-3 border-t border-outline-variant/30">
                <span className="text-on-surface-variant">{t('billing.packBalance')}</span>
                <span className="font-semibold">{balance.pack_balance} {t('credits.creditsUnit')}</span>
              </div>
            )}
          </Card>

          {/* Spend cap */}
          <Card>
            <div className="text-xs font-semibold uppercase tracking-wide text-on-surface-variant mb-1">{t('billing.spendCapTitle')}</div>
            <p className="text-xs text-on-surface-variant mb-3 leading-relaxed">{t('billing.spendCapDesc')}</p>
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-medium">{overageEnabled ? t('billing.overageOn') : t('billing.overageOff')}</span>
              <Switch checked={overageEnabled} onCheckedChange={setOverageEnabled} />
            </div>
            {overageEnabled && (
              <div className="mb-3">
                <label className="text-xs text-on-surface-variant">{t('billing.overageCeiling')}</label>
                <Input type="number" min={0} value={overageCeiling} onChange={(e) => setOverageCeiling(e.target.value)} className="mt-1" />
              </div>
            )}
            <Button onClick={saveCap} disabled={savingCap} className="w-full" variant="outline">
              {savingCap ? t('billing.saved') : t('billing.save')}
            </Button>
          </Card>
        </div>
      )}

      {/* Plans */}
      <div className="mt-8">
        <h3 className="text-lg font-bold text-on-surface">{t('billing.plansTitle')}</h3>
        <p className="text-sm text-on-surface-variant mb-4">{t('billing.plansDesc')}</p>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {PLAN_ORDER.map((tier) => {
            const isCurrent = tier === planTier;
            const allowance = config?.plan_allowances?.[tier] ?? 0;
            const curIdx = PLAN_ORDER.indexOf(planTier as typeof PLAN_ORDER[number]);
            const tierIdx = PLAN_ORDER.indexOf(tier);
            const ctaLabel = isCurrent
              ? t('billing.current')
              : (curIdx >= 0 && tierIdx < curIdx ? t('billing.downgrade') : t('billing.upgrade'));
            return (
              <Card key={tier} className={isCurrent ? 'ring-2' : ''}>
                <div className="font-bold text-on-surface">{PLAN_LABEL[tier]}</div>
                <div className="text-3xl font-black mt-1">${config?.plan_prices?.[tier] ?? PLAN_PRICE_FALLBACK[tier]}<span className="text-sm font-semibold text-on-surface-variant">{t('billing.perMonth')}</span></div>
                <div className="text-xs text-on-surface-variant mt-1 mb-4">{t('billing.creditsPerMo', { n: allowance })}</div>
                <Button
                  variant={isCurrent ? 'outline' : 'gradient'}
                  className="w-full"
                  disabled={isCurrent || busyPlan === tier}
                  onClick={() => changePlan(tier)}
                >
                  {ctaLabel}
                </Button>
              </Card>
            );
          })}
        </div>
      </div>

      {/* Credit packs */}
      {packs.length > 0 && (
        <div className="mt-8">
          <h3 className="text-lg font-bold text-on-surface">{t('billing.packsTitle')}</h3>
          <p className="text-sm text-on-surface-variant mb-4">{t('billing.packsDesc')}</p>
          {buyMsg && <p className="text-sm text-amber-600 mb-3">{buyMsg}</p>}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {packs.map((pack) => (
              <Card key={pack.id}>
                <div className="font-bold text-on-surface">{pack.label}</div>
                <div className="text-2xl font-black mt-1">{pack.credits.toLocaleString()} <span className="text-sm font-semibold text-on-surface-variant">{t('credits.creditsUnit')}</span></div>
                <div className="text-sm text-on-surface-variant mb-4">${pack.price_usd}</div>
                <Button className="w-full" onClick={() => buyPack(pack.id)}>{t('billing.buy')}</Button>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Usage this period */}
      <div className="mt-8 grid grid-cols-1 lg:grid-cols-2 gap-5">
        <Card>
          <h3 className="text-base font-bold text-on-surface mb-3">{t('billing.usageTitle')}</h3>
          {usage.length === 0 ? (
            <p className="text-sm text-on-surface-variant">{t('billing.usageEmpty')}</p>
          ) : (
            <div className="space-y-2">
              {usage.map((row) => (
                <div key={row.action_type} className="flex items-center justify-between text-sm">
                  <span className="text-on-surface-variant">{t(`billing.actionType.${row.action_type}`) || row.action_type}</span>
                  <span className="font-semibold">{row.total_credits} {t('credits.creditsUnit')} <span className="text-on-surface-variant font-normal">({row.event_count})</span></span>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* Ledger */}
        <Card>
          <h3 className="text-base font-bold text-on-surface mb-3">{t('billing.ledgerTitle')}</h3>
          {ledger.length === 0 ? (
            <p className="text-sm text-on-surface-variant">{t('billing.ledgerEmpty')}</p>
          ) : (
            <div className="space-y-1.5 max-h-80 overflow-y-auto">
              {ledger.map((e) => (
                <div key={e.id} className="flex items-center justify-between text-sm py-1 border-b border-outline-variant/20 last:border-0">
                  <div className="min-w-0">
                    <div className="truncate text-on-surface">{t(`billing.actionType.${e.action_type}`) || e.action_type}</div>
                    <div className="text-[11px] text-on-surface-variant">{new Date(e.created_at).toLocaleString()}</div>
                  </div>
                  <span className={`font-bold tabular-nums ${e.credits < 0 ? 'text-on-surface' : 'text-emerald-600'}`}>
                    {e.credits > 0 ? '+' : ''}{e.credits}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

export default BillingPage;
