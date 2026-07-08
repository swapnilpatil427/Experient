/**
 * Notification Analytics Page — /app/settings/notification-analytics
 *
 * Shows delivery performance across all channels: summary KPI cards, channel
 * breakdown table, top workflows, suppression counts, and frequency cap rules
 * with inline editing.
 *
 * Falls back to mock data when the analytics API is unavailable (demo badge shown).
 */
import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useSetPageTitle } from '../contexts/pageTitle';
import { useApi } from '../hooks/useApi';
import { useTranslation } from '../lib/i18n';
import { ROUTES } from '../constants/routes';
import { PageHeader } from '../components/PageHeader';
import { Icon } from '../components/Icon';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

// ── Animation variants ────────────────────────────────────────────────────────
const stagger = {
  hidden:  {},
  visible: { transition: { staggerChildren: 0.06 } },
};
const rise = {
  hidden:  { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.55, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] } },
};

// ── Mock data (shown when API is unreachable) ─────────────────────────────────
const MOCK_SUMMARY = {
  sent: 4820, deliveredRate: 97.2, openRate: 34.5, clickRate: 8.1, bounced: 23, suppressed: 41,
};

const MOCK_CHANNELS: ChannelRow[] = [
  { channel: 'email',  sent: 2840, deliveredRate: 98.1, openRate: 36.2, clickRate: 9.4 },
  { channel: 'sms',    sent:  620, deliveredRate: 99.2, openRate: 52.8, clickRate: 12.1 },
  { channel: 'push',   sent:  810, deliveredRate: 94.3, openRate: 18.7, clickRate: 4.2 },
  { channel: 'slack',  sent:  330, deliveredRate: 99.7, openRate: 61.3, clickRate: 22.5 },
  { channel: 'in_app', sent:  220, deliveredRate: 100,  openRate: 78.4, clickRate: 31.8 },
];

const MOCK_WORKFLOWS: WorkflowRow[] = [
  { workflowId: 'survey-invite',    sent: 1820, deliveredRate: 97.8 },
  { workflowId: 'close-the-loop',   sent:  940, deliveredRate: 98.5 },
  { workflowId: 'insight-ready',    sent:  610, deliveredRate: 96.2 },
  { workflowId: 'sla-breach',       sent:  430, deliveredRate: 99.1 },
  { workflowId: 'response-alert',   sent:  310, deliveredRate: 97.4 },
];

const MOCK_SUPPRESSIONS: SuppressionStats = {
  total: 41,
  byReason: { unsubscribe: 18, bounce: 14, spam_complaint: 5, gdpr_request: 4 },
};

const MOCK_CAPS: CapRule[] = [
  { channel: 'email', maxCount: 3, windowHours: 168 },
  { channel: 'sms',   maxCount: 2, windowHours:  72 },
  { channel: 'all',   maxCount: 5, windowHours: 168 },
];

// ── Types ─────────────────────────────────────────────────────────────────────
type Period = '7d' | '30d' | '90d';

interface Summary {
  sent: number;
  deliveredRate: number;
  openRate: number;
  clickRate: number;
  bounced: number;
  suppressed: number;
}

interface ChannelRow {
  channel: string;
  sent: number;
  deliveredRate: number;
  openRate: number;
  clickRate: number;
}

interface WorkflowRow {
  workflowId: string;
  sent: number;
  deliveredRate: number;
}

interface SuppressionStats {
  total: number;
  byReason: Record<string, number>;
}

interface CapRule {
  channel: string;
  maxCount: number;
  windowHours: number;
}

// ── Sub-components ────────────────────────────────────────────────────────────

interface KpiCardProps {
  label: string;
  value: string;
  icon: string;
  color: string;
  bg: string;
}

function KpiCard({ label, value, icon, color, bg }: KpiCardProps) {
  return (
    <motion.div variants={rise}>
      <Card className="p-5 flex items-start gap-4">
        <div
          className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
          style={{ background: bg }}
        >
          <Icon name={icon} size={20} style={{ color }} />
        </div>
        <div className="min-w-0">
          <div className="text-2xl font-black" style={{ color }}>{value}</div>
          <div className="text-xs text-[var(--color-on-surface-muted)] mt-0.5 leading-tight">{label}</div>
        </div>
      </Card>
    </motion.div>
  );
}

function pct(v: number): string {
  return `${v.toFixed(1)}%`;
}

function CapEditModal({
  rule,
  onSave,
  onClose,
  t,
}: {
  rule: CapRule;
  onSave: (channel: string, maxCount: number, windowHours: number) => Promise<void>;
  onClose: () => void;
  t: (key: string) => string;
}) {
  const [maxCount,    setMaxCount]    = useState(String(rule.maxCount));
  const [windowHours, setWindowHours] = useState(String(rule.windowHours));
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    const mc = parseInt(maxCount, 10);
    const wh = parseInt(windowHours, 10);
    if (!mc || mc < 1 || !wh || wh < 1) return;
    setSaving(true);
    try {
      await onSave(rule.channel, mc, wh);
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('notificationAnalytics.capEdit')} — {rule.channel}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 pt-2">
          <div>
            <Label className="text-xs mb-1 block">{t('notificationAnalytics.capMax')}</Label>
            <Input
              type="number"
              min={1}
              value={maxCount}
              onChange={(e) => setMaxCount(e.target.value)}
            />
          </div>
          <div>
            <Label className="text-xs mb-1 block">{t('notificationAnalytics.capWindow')}</Label>
            <Input
              type="number"
              min={1}
              value={windowHours}
              onChange={(e) => setWindowHours(e.target.value)}
            />
          </div>
          <div className="flex gap-2 justify-end">
            <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
            <Button size="sm" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : t('notificationAnalytics.capSave')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export function NotificationAnalyticsPage() {
  const { t } = useTranslation();
  useSetPageTitle(t('notificationAnalytics.title'), t('notificationAnalytics.subtitle'));

  const api = useApi();

  const [period,      setPeriod]      = useState<Period>('7d');
  const [isDemo,      setIsDemo]      = useState(false);
  const [summary,     setSummary]     = useState<Summary | null>(null);
  const [channels,    setChannels]    = useState<ChannelRow[]>([]);
  const [workflows,   setWorkflows]   = useState<WorkflowRow[]>([]);
  const [suppStats,   setSuppStats]   = useState<SuppressionStats | null>(null);
  const [caps,        setCaps]        = useState<CapRule[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [editingCap,  setEditingCap]  = useState<CapRule | null>(null);

  const load = useCallback(async (p: Period) => {
    setLoading(true);
    try {
      const [summaryRes, channelsRes, workflowsRes, suppRes, capsRes] = await Promise.allSettled([
        (api as unknown as { get: (url: string) => Promise<{ data: unknown }> }).get(`/api/outreach/analytics/summary?period=${p}`),
        (api as unknown as { get: (url: string) => Promise<{ data: unknown }> }).get(`/api/outreach/analytics/channels?period=${p}`),
        (api as unknown as { get: (url: string) => Promise<{ data: unknown }> }).get(`/api/outreach/analytics/workflows?period=${p}`),
        (api as unknown as { get: (url: string) => Promise<{ data: unknown }> }).get(`/api/outreach/suppression/stats`),
        (api as unknown as { get: (url: string) => Promise<{ data: unknown }> }).get(`/api/outreach/frequency-caps`),
      ]);

      let demo = false;

      if (summaryRes.status === 'fulfilled') {
        setSummary(summaryRes.value.data as Summary);
      } else {
        setSummary(MOCK_SUMMARY);
        demo = true;
      }

      if (channelsRes.status === 'fulfilled') {
        setChannels(channelsRes.value.data as ChannelRow[]);
      } else {
        setChannels(MOCK_CHANNELS);
        demo = true;
      }

      if (workflowsRes.status === 'fulfilled') {
        setWorkflows(workflowsRes.value.data as WorkflowRow[]);
      } else {
        setWorkflows(MOCK_WORKFLOWS);
        demo = true;
      }

      if (suppRes.status === 'fulfilled') {
        setSuppStats(suppRes.value.data as SuppressionStats);
      } else {
        setSuppStats(MOCK_SUPPRESSIONS);
        demo = true;
      }

      if (capsRes.status === 'fulfilled') {
        setCaps(capsRes.value.data as CapRule[]);
      } else {
        setCaps(MOCK_CAPS);
        demo = true;
      }

      setIsDemo(demo);
    } catch {
      // All failed — full demo mode
      setSummary(MOCK_SUMMARY);
      setChannels(MOCK_CHANNELS);
      setWorkflows(MOCK_WORKFLOWS);
      setSuppStats(MOCK_SUPPRESSIONS);
      setCaps(MOCK_CAPS);
      setIsDemo(true);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { void load(period); }, [period, load]);

  async function handleSaveCap(channel: string, maxCount: number, windowHours: number) {
    try {
      await (api as unknown as { post: (url: string, body: unknown) => Promise<unknown> })
        .post('/api/outreach/frequency-caps', { channel, maxCount, windowHours });
      // Optimistic update
      setCaps((prev) => prev.map((c) => c.channel === channel ? { ...c, maxCount, windowHours } : c));
    } catch {
      // Silently ignore in demo mode
    }
  }

  const PERIOD_LABELS: Record<Period, string> = {
    '7d':  t('notificationAnalytics.periods.7d'),
    '30d': t('notificationAnalytics.periods.30d'),
    '90d': t('notificationAnalytics.periods.90d'),
  };

  const REASON_ICONS: Record<string, string> = {
    unsubscribe:     'unsubscribe',
    bounce:          'error',
    spam_complaint:  'report',
    gdpr_request:    'privacy_tip',
    admin:           'admin_panel_settings',
    invalid:         'warning',
  };

  return (
    <div className="max-w-7xl mx-auto w-full">
      <PageHeader
        crumbs={[
          { label: t('nav.settings'), path: ROUTES.SETTINGS },
          { label: t('notificationAnalytics.title') },
        ]}
        title={t('notificationAnalytics.title')}
        subtitle={t('notificationAnalytics.subtitle')}
        actions={
          isDemo ? (
            <Badge variant="outline" className="text-amber-600 border-amber-300 bg-amber-50">
              {t('notificationAnalytics.demoData')}
            </Badge>
          ) : undefined
        }
      />

      {/* Period selector */}
      <div className="flex gap-1 mb-6 bg-[var(--color-surface-raised)] rounded-lg p-1 w-fit">
        {(Object.keys(PERIOD_LABELS) as Period[]).map((p) => (
          <button
            key={p}
            onClick={() => setPeriod(p)}
            className="px-4 py-1.5 rounded-md text-sm font-medium transition-all"
            style={{
              background: period === p ? 'var(--color-surface)' : 'transparent',
              color:      period === p ? 'var(--color-primary)' : 'var(--color-on-surface-muted)',
              boxShadow:  period === p ? '0 1px 4px rgba(0,0,0,0.08)' : 'none',
            }}
          >
            {PERIOD_LABELS[p]}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="space-y-6">
          {/* Skeleton cards */}
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="skeleton h-24 rounded-xl" />
            ))}
          </div>
          <div className="skeleton h-48 rounded-xl" />
          <div className="skeleton h-40 rounded-xl" />
        </div>
      ) : (
        <motion.div variants={stagger} initial="hidden" animate="visible" className="space-y-8">

          {/* ── Summary KPI cards ── */}
          {summary && (
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
              <KpiCard
                label={t('notificationAnalytics.cards.sent')}
                value={summary.sent.toLocaleString()}
                icon="send"
                color="var(--color-primary)"
                bg="color-mix(in srgb, var(--color-primary) 8%, transparent)"
              />
              <KpiCard
                label={t('notificationAnalytics.cards.delivered')}
                value={pct(summary.deliveredRate)}
                icon="mark_email_read"
                color="#059669"
                bg="rgba(5,150,105,0.08)"
              />
              <KpiCard
                label={t('notificationAnalytics.cards.opened')}
                value={pct(summary.openRate)}
                icon="drafts"
                color="var(--color-tertiary)"
                bg="color-mix(in srgb, var(--color-tertiary) 8%, transparent)"
              />
              <KpiCard
                label={t('notificationAnalytics.cards.clicked')}
                value={pct(summary.clickRate)}
                icon="ads_click"
                color="#d97706"
                bg="rgba(217,119,6,0.08)"
              />
              <KpiCard
                label={t('notificationAnalytics.cards.bounced')}
                value={summary.bounced.toLocaleString()}
                icon="unsubscribe"
                color="#dc2626"
                bg="rgba(220,38,38,0.08)"
              />
              <KpiCard
                label={t('notificationAnalytics.cards.suppressed')}
                value={summary.suppressed.toLocaleString()}
                icon="block"
                color="#6b7280"
                bg="rgba(107,114,128,0.08)"
              />
            </div>
          )}

          {/* ── Channel breakdown ── */}
          <motion.div variants={rise}>
            <Card className="overflow-hidden">
              <div className="px-6 py-4 border-b border-[var(--color-outline-subtle)] flex items-center gap-2">
                <Icon name="bar_chart" size={18} style={{ color: 'var(--color-primary)' }} />
                <h2 className="font-semibold text-sm">{t('notificationAnalytics.channelBreakdown')}</h2>
              </div>
              {channels.length === 0 ? (
                <div className="px-6 py-10 text-center text-sm text-[var(--color-on-surface-muted)]">
                  {t('notificationAnalytics.noData')}
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-[var(--color-outline-subtle)]">
                        <th className="text-left px-6 py-3 font-medium text-[var(--color-on-surface-muted)]">Channel</th>
                        <th className="text-right px-4 py-3 font-medium text-[var(--color-on-surface-muted)]">Sent</th>
                        <th className="text-right px-4 py-3 font-medium text-[var(--color-on-surface-muted)]">Delivered%</th>
                        <th className="text-right px-4 py-3 font-medium text-[var(--color-on-surface-muted)]">Open%</th>
                        <th className="text-right px-6 py-3 font-medium text-[var(--color-on-surface-muted)]">Click%</th>
                      </tr>
                    </thead>
                    <tbody>
                      {channels.map((row, i) => (
                        <tr
                          key={row.channel}
                          className="border-b border-[var(--color-outline-subtle)] last:border-0 hover:bg-[var(--color-surface-raised)] transition-colors"
                          style={{ animationDelay: `${i * 40}ms` }}
                        >
                          <td className="px-6 py-3">
                            <span className="capitalize font-medium">{row.channel.replace('_', '-')}</span>
                          </td>
                          <td className="px-4 py-3 text-right tabular-nums">{row.sent.toLocaleString()}</td>
                          <td className="px-4 py-3 text-right tabular-nums text-emerald-600">{pct(row.deliveredRate)}</td>
                          <td className="px-4 py-3 text-right tabular-nums text-purple-600">{pct(row.openRate)}</td>
                          <td className="px-6 py-3 text-right tabular-nums text-amber-600">{pct(row.clickRate)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </motion.div>

          {/* ── Top workflows ── */}
          <motion.div variants={rise}>
            <Card className="overflow-hidden">
              <div className="px-6 py-4 border-b border-[var(--color-outline-subtle)] flex items-center gap-2">
                <Icon name="account_tree" size={18} style={{ color: 'var(--color-primary)' }} />
                <h2 className="font-semibold text-sm">{t('notificationAnalytics.topWorkflows')}</h2>
              </div>
              {workflows.length === 0 ? (
                <div className="px-6 py-10 text-center text-sm text-[var(--color-on-surface-muted)]">
                  {t('notificationAnalytics.noData')}
                </div>
              ) : (
                <div className="px-6 py-4 space-y-3">
                  {workflows.map((row) => {
                    const barWidth = workflows[0].sent > 0
                      ? Math.round((row.sent / workflows[0].sent) * 100)
                      : 0;
                    return (
                      <div key={row.workflowId} className="flex items-center gap-4">
                        <div className="w-36 text-xs font-medium text-[var(--color-on-surface)] truncate flex-shrink-0">
                          {row.workflowId}
                        </div>
                        <div className="flex-1 h-2 bg-[var(--color-surface-raised)] rounded-full overflow-hidden">
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${barWidth}%`,
                              background: 'var(--color-primary)',
                              opacity: 0.7,
                            }}
                          />
                        </div>
                        <div className="text-xs tabular-nums text-[var(--color-on-surface-muted)] w-14 text-right">
                          {row.sent.toLocaleString()}
                        </div>
                        <div className="text-xs tabular-nums text-emerald-600 w-14 text-right">
                          {pct(row.deliveredRate)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>
          </motion.div>

          {/* ── Bottom row: suppressions + frequency caps ── */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

            {/* Suppressions panel */}
            <motion.div variants={rise}>
              <Card className="overflow-hidden h-full">
                <div className="px-6 py-4 border-b border-[var(--color-outline-subtle)] flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Icon name="block" size={18} style={{ color: '#dc2626' }} />
                    <h2 className="font-semibold text-sm">{t('notificationAnalytics.suppressions')}</h2>
                    {suppStats && (
                      <Badge variant="secondary" className="text-xs">{suppStats.total}</Badge>
                    )}
                  </div>
                  <Link to={ROUTES.SETTINGS_CONNECTIONS}>
                    <Button variant="ghost" size="sm" className="text-xs">
                      {t('notificationAnalytics.manageSuppression')}
                      <Icon name="arrow_forward" size={14} className="ml-1" />
                    </Button>
                  </Link>
                </div>
                {suppStats && Object.keys(suppStats.byReason).length > 0 ? (
                  <div className="px-6 py-4 space-y-3">
                    {Object.entries(suppStats.byReason).map(([reason, count]) => (
                      <div key={reason} className="flex items-center justify-between">
                        <div className="flex items-center gap-2 text-sm">
                          <Icon
                            name={REASON_ICONS[reason] ?? 'info'}
                            size={16}
                            style={{ color: 'var(--color-on-surface-muted)' }}
                          />
                          <span className="capitalize">{reason.replace(/_/g, ' ')}</span>
                        </div>
                        <Badge variant="outline" className="tabular-nums">{count}</Badge>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="px-6 py-10 text-center text-sm text-[var(--color-on-surface-muted)]">
                    {t('notificationAnalytics.noData')}
                  </div>
                )}
              </Card>
            </motion.div>

            {/* Frequency caps panel */}
            <motion.div variants={rise}>
              <Card className="overflow-hidden h-full">
                <div className="px-6 py-4 border-b border-[var(--color-outline-subtle)] flex items-center gap-2">
                  <Icon name="speed" size={18} style={{ color: 'var(--color-primary)' }} />
                  <h2 className="font-semibold text-sm">{t('notificationAnalytics.frequencyCaps')}</h2>
                </div>
                {caps.length === 0 ? (
                  <div className="px-6 py-10 text-center text-sm text-[var(--color-on-surface-muted)]">
                    {t('notificationAnalytics.noData')}
                  </div>
                ) : (
                  <div className="px-6 py-4 space-y-3">
                    {caps.map((cap) => (
                      <div
                        key={cap.channel}
                        className="flex items-center justify-between rounded-lg px-3 py-2.5 bg-[var(--color-surface-raised)]"
                      >
                        <div className="min-w-0">
                          <div className="font-medium text-sm capitalize">{cap.channel}</div>
                          <div className="text-xs text-[var(--color-on-surface-muted)] mt-0.5">
                            max {cap.maxCount} / {cap.windowHours}h window
                          </div>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-xs ml-2 flex-shrink-0"
                          onClick={() => setEditingCap(cap)}
                        >
                          <Icon name="edit" size={14} className="mr-1" />
                          {t('notificationAnalytics.capEdit')}
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            </motion.div>
          </div>
        </motion.div>
      )}

      {/* Cap edit modal */}
      {editingCap && (
        <CapEditModal
          rule={editingCap}
          onSave={handleSaveCap}
          onClose={() => setEditingCap(null)}
          t={t}
        />
      )}
    </div>
  );
}
