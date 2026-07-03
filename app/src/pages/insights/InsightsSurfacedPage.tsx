// Auto-surfaced Findings — complete feed with severity filter, full reasoning,
// surfacing frequency calendar heatmap, dismiss/pin/ticket actions.
// Route: /app/insights/surfaced
// Breadcrumb: Intelligence › Auto-surfaced findings

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useSetPageTitle } from '../../contexts/pageTitle';
import { PageHeader } from '../../components/PageHeader';
import { Icon } from '../../components/Icon';
import { Button } from '@/components/ui/button';
import { ROUTES } from '../../constants/routes';
import { GlassCard, ConfidenceChip, LayerBadge, type InsightLayer } from './shared';

type Severity = 'all' | 'critical' | 'actionable' | 'informational';

interface SurfacedFinding {
  id: string;
  severity: Exclude<Severity, 'all'>;
  layer: InsightLayer;
  type: string;
  icon: string;
  iconColor: string;
  title: string;
  detail: string;
  reasoning: string;
  confidence: number;
  relativeTime: string;
  dismissed?: boolean;
}

const ALL_FINDINGS: SurfacedFinding[] = [
  {
    id: 's1',
    severity: 'critical',
    layer: 'predictive',
    type: 'ANOMALY',
    icon: 'warning',
    iconColor: '#d97706',
    title: 'NPS dropped 12 points on May 10 — anomaly confirmed',
    detail: 'Outside the 95% prediction interval [42–52]. A spike of 14 responses mentioning "login error" hit in the same 24h window. Average sentiment moved from +0.12 to −0.41 (p<0.01).',
    reasoning: 'Bayesian online changepoint detection (BOCPD) detected a run-length posterior shift at 14:12 UTC May 10. Cross-referenced with incident log: login outage confirmed. Verifier: claude-haiku-4.5 → supported.',
    confidence: 92,
    relativeTime: '6h ago',
  },
  {
    id: 's2',
    severity: 'critical',
    layer: 'descriptive',
    type: 'BIAS WARNING',
    icon: 'balance',
    iconColor: '#b41340',
    title: '73% of responses are from Enterprise tier — NPS may overstate Enterprise',
    detail: 'Enterprise represents 73% of responses but ~40% of ARR. SMB segment is under-represented. Aggregate NPS likely overstates overall experience. Recommend stratified view.',
    reasoning: 'Cohort distribution analysis: Enterprise = 228/312 (73%), SMB = 53/312 (17%), Mid-market = 31/312 (10%). Expected from ARR distribution: ~40%/35%/25%. Chi-square p < 0.001.',
    confidence: 95,
    relativeTime: '6h ago',
  },
  {
    id: 's3',
    severity: 'actionable',
    layer: 'prescriptive',
    type: 'DRIVER',
    icon: 'lightbulb',
    iconColor: 'var(--color-tertiary)',
    title: '"Email verification loop" is now the top driver of detractor sentiment',
    detail: '+3.2 NPS projected if fixed · 18 cited respondents · n=189. Moved from 3rd to 1st in the last 7 days.',
    reasoning: 'Causal forest model (Wager & Athey 2018) with 1000-bootstrap CI. Partial R² increased from 0.11 to 0.31 between May 7 and May 14. Consistent across 3 independent topic clusters.',
    confidence: 89,
    relativeTime: '2h ago',
  },
  {
    id: 's4',
    severity: 'informational',
    layer: 'predictive',
    type: 'TREND',
    icon: 'trending_up',
    iconColor: '#059669',
    title: 'Response velocity 2.3× normal — likely email campaign from yesterday',
    detail: 'Sustained for 36h · 142 new responses · sentiment baseline +0.18 vs +0.05 avg. Cohort is completing faster and has higher NPS than baseline.',
    reasoning: 'Velocity computed as 7d rolling average (4.1 resp/hr baseline). Current: 9.4 resp/hr. Attribution: email campaign sent 2026-05-07 08:00 UTC based on UTM correlation (r=0.89).',
    confidence: 91,
    relativeTime: '4h ago',
  },
  {
    id: 's5',
    severity: 'informational',
    layer: 'predictive',
    type: 'PREDICT',
    icon: 'insights',
    iconColor: 'var(--color-primary)',
    title: 'Projected NPS at 500 responses: 51 ±4 by Friday',
    detail: 'Prophet + 1000-bootstrap CI · Promoters disproportionately complete in late waves. High confidence given current velocity.',
    reasoning: 'Prophet forecasting model trained on last 90 days of NPS data. Velocity input: 9.4 resp/hr. Promoter late-wave effect confirmed in prior 4 survey cycles (consistent pattern).',
    confidence: 81,
    relativeTime: '8h ago',
  },
  {
    id: 's6',
    severity: 'actionable',
    layer: 'diagnostic',
    type: 'VOICE',
    icon: 'forum',
    iconColor: 'var(--color-primary)',
    title: '"Password reset confusion" grew 40% in mentions this week',
    detail: '18 → 25 mentions. 78% negative sentiment. New sub-theme: "reset link expires too fast" appeared in 11 of the 25 mentions.',
    reasoning: 'Week-over-week topic volume comparison. Semantic clustering identified new sub-theme "reset link expires too fast" with cosine similarity 0.87 to parent cluster.',
    confidence: 74,
    relativeTime: '5h ago',
  },
  {
    id: 's7',
    severity: 'informational',
    layer: 'descriptive',
    type: 'META',
    icon: 'psychology',
    iconColor: 'var(--color-primary)',
    title: 'Survey completion rate improved to 68% (+8% vs. last 30d)',
    detail: 'Likely driven by shorter median time-to-complete (4.2 min vs. 5.8 min). Drop-off most common at Q6 (open text). Consider making Q6 optional.',
    reasoning: 'Completion funnel analysis: 312 completions / 459 starts = 68%. Previous 30d: 60%. Time-to-complete reduced after removing 2 branching questions on May 5.',
    confidence: 88,
    relativeTime: '9h ago',
  },
  {
    id: 's8',
    severity: 'actionable',
    layer: 'prescriptive',
    type: 'DRIVER',
    icon: 'support_agent',
    iconColor: '#059669',
    title: 'Support response time SLA breach: avg 6.2h, benchmark 2h',
    detail: '31 respondents cite slow support response. Projected NPS +2.1 if SLA improved to 2h. Third consecutive brief flagging this driver.',
    reasoning: 'Driver regression: support_response_time has partial R² = 0.22 (second after email_verification_loop at 0.31). SLA benchmark from Intercom CX industry report Q1 2026.',
    confidence: 84,
    relativeTime: '2h ago',
  },
];

// 60-day heatmap data (demo): number of findings surfaced per day
const HEATMAP_WEEKS = 9;
const HEATMAP_DATA: number[] = Array.from({ length: HEATMAP_WEEKS * 7 }, (_, i) => {
  if (i === 49) return 8; // May 10 spike
  if (i >= 52 && i <= 56) return Math.floor(Math.random() * 3) + 2;
  return Math.floor(Math.random() * 3);
});

const SEVERITY_CONFIG: Record<Exclude<Severity, 'all'>, { label: string; color: string; bg: string }> = {
  critical: { label: 'Critical', color: 'text-red-700', bg: 'bg-red-100' },
  actionable: { label: 'Actionable', color: 'text-amber-700', bg: 'bg-amber-100' },
  informational: { label: 'Informational', color: 'text-blue-700', bg: 'bg-blue-100' },
};

const rise3d = {
  hidden: { rotateX: -10, y: 32, opacity: 0 },
  visible: {
    rotateX: 0, y: 0, opacity: 1,
    transition: { duration: 0.42, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] },
  },
};
const stagger = { hidden: {}, visible: { transition: { staggerChildren: 0.06 } } };

export function InsightsSurfacedPage() {
  useSetPageTitle('Auto-surfaced Findings', 'Intelligence');
  const [severity, setSeverity] = useState<Severity>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const visible = ALL_FINDINGS.filter(
    (f) => !dismissed.has(f.id) && (severity === 'all' || f.severity === severity),
  );

  const counts = {
    all: ALL_FINDINGS.filter((f) => !dismissed.has(f.id)).length,
    critical: ALL_FINDINGS.filter((f) => !dismissed.has(f.id) && f.severity === 'critical').length,
    actionable: ALL_FINDINGS.filter((f) => !dismissed.has(f.id) && f.severity === 'actionable').length,
    informational: ALL_FINDINGS.filter((f) => !dismissed.has(f.id) && f.severity === 'informational').length,
  };

  return (
    <div className="max-w-7xl mx-auto w-full">
      <PageHeader
        crumbs={[
          { label: 'Intelligence', icon: 'psychology', path: ROUTES.INSIGHTS },
          { label: 'Auto-surfaced findings' },
        ]}
        title="Auto-surfaced Findings"
        subtitle="Everything Crystal surfaced recently — unfiltered and in full"
        actions={
          <Button variant="outline" size="sm" className="text-xs gap-1.5">
            <Icon name="notifications" size={14} /> Notification preferences
          </Button>
        }
      />

      {/* Severity filter bar */}
      <div className="flex items-center gap-2 mt-4 mb-6 flex-wrap">
        {(['all', 'critical', 'actionable', 'informational'] as Severity[]).map((s) => (
          <button
            key={s}
            onClick={() => setSeverity(s)}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold transition-all border ${
              severity === s
                ? s === 'all'
                  ? 'bg-primary text-white border-primary'
                  : s === 'critical'
                    ? 'bg-red-600 text-white border-red-600'
                    : s === 'actionable'
                      ? 'bg-amber-500 text-white border-amber-500'
                      : 'bg-blue-600 text-white border-blue-600'
                : 'bg-background border-border/40 text-on-surface-variant hover:border-primary/30 hover:text-on-surface'
            }`}
          >
            {s === 'critical' && <Icon name="warning" size={13} />}
            {s === 'actionable' && <Icon name="lightbulb" size={13} />}
            {s === 'informational' && <Icon name="info" size={13} />}
            {s === 'all' ? 'All findings' : SEVERITY_CONFIG[s].label}
            <span className={`text-[10px] font-mono rounded-full px-1.5 py-0.5 ${
              severity === s ? 'bg-white/20' : 'bg-muted'
            }`}>
              {counts[s]}
            </span>
          </button>
        ))}
        {dismissed.size > 0 && (
          <button
            onClick={() => setDismissed(new Set())}
            className="ml-auto text-xs text-on-surface-variant hover:text-on-surface flex items-center gap-1"
          >
            <Icon name="refresh" size={13} /> Restore {dismissed.size} dismissed
          </button>
        )}
      </div>

      <motion.div
        variants={stagger}
        initial="hidden"
        animate="visible"
        style={{ transformPerspective: 1200, transformOrigin: 'top center' }}
        className="space-y-8"
      >
        {/* Findings feed */}
        <motion.div variants={rise3d} className="space-y-3">
          <AnimatePresence mode="popLayout">
            {visible.map((f) => (
              <motion.div
                key={f.id}
                layout
                exit={{ opacity: 0, x: 40, height: 0 }}
                transition={{ duration: 0.22 }}
              >
                <GlassCard className="overflow-hidden">
                  <div className="p-5 flex items-start gap-4">
                    <Icon name={f.icon} size={22} style={{ color: f.iconColor, marginTop: 2, flexShrink: 0 }} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <span className={`text-[10px] font-black uppercase tracking-widest ${
                          SEVERITY_CONFIG[f.severity].color
                        } ${SEVERITY_CONFIG[f.severity].bg} px-1.5 py-0.5 rounded`}>
                          {f.type}
                        </span>
                        <LayerBadge layer={f.layer} />
                        <ConfidenceChip value={f.confidence} />
                        <span className="text-[10px] text-on-surface-variant ml-1">{f.relativeTime}</span>
                      </div>
                      <p className="font-bold text-sm">{f.title}</p>
                      <p className="text-xs text-on-surface-variant mt-1">{f.detail}</p>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0 self-start">
                      <button
                        onClick={() => setExpandedId(expandedId === f.id ? null : f.id)}
                        className="w-8 h-8 rounded-lg flex items-center justify-center text-on-surface-variant hover:bg-muted transition-colors"
                      >
                        <Icon name={expandedId === f.id ? 'expand_less' : 'expand_more'} size={18} />
                      </button>
                    </div>
                  </div>

                  <AnimatePresence>
                    {expandedId === f.id && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
                        className="overflow-hidden"
                      >
                        <div className="px-5 pb-5 border-t border-outline-variant/20 pt-4 space-y-4">
                          {/* Crystal's reasoning */}
                          <div className="rounded-xl bg-muted/50 p-4">
                            <div className="text-[10px] font-black uppercase tracking-widest text-on-surface-variant mb-2 flex items-center gap-1.5">
                              <span
                                className="w-4 h-4 rounded flex items-center justify-center text-white text-[9px]"
                                style={{ background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))' }}
                              >
                                ◆
                              </span>
                              Crystal's reasoning
                            </div>
                            <p className="text-xs leading-relaxed text-on-surface-variant">{f.reasoning}</p>
                          </div>

                          {/* Action tray */}
                          <div className="flex items-center gap-2 flex-wrap">
                            <Button size="sm" className="text-xs gap-1.5">
                              <Icon name="flag" size={13} /> Create ticket
                            </Button>
                            <Button size="sm" variant="outline" className="text-xs gap-1.5">
                              <Icon name="push_pin" size={13} /> Pin to Findings
                            </Button>
                            <Button size="sm" variant="outline" className="text-xs gap-1.5">
                              <Icon name="ios_share" size={13} /> Slack
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="text-xs gap-1.5 ml-auto text-on-surface-variant"
                              onClick={() => {
                                setDismissed((prev) => new Set([...prev, f.id]));
                                setExpandedId(null);
                              }}
                            >
                              <Icon name="close" size={13} /> Dismiss
                            </Button>
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </GlassCard>
              </motion.div>
            ))}
          </AnimatePresence>

          {visible.length === 0 && (
            <div className="text-center py-16 text-on-surface-variant text-sm">
              No findings in this category.
              {dismissed.size > 0 && (
                <button onClick={() => setDismissed(new Set())} className="ml-1 text-primary hover:underline">
                  Restore {dismissed.size} dismissed.
                </button>
              )}
            </div>
          )}
        </motion.div>

        {/* Surfacing frequency heatmap */}
        <motion.div variants={rise3d}>
          <div className="flex items-center gap-3 mb-3">
            <div className="h-px flex-1 bg-border/40" />
            <span className="text-[10px] font-black uppercase tracking-[0.25em] text-on-surface-variant flex items-center gap-1.5">
              <Icon name="calendar_month" size={13} /> Surfacing frequency — last 63 days
            </span>
            <div className="h-px flex-1 bg-border/40" />
          </div>
          <GlassCard className="p-6">
            <div className="flex gap-1 overflow-x-auto pb-1">
              {Array.from({ length: HEATMAP_WEEKS }).map((_, w) => (
                <div key={w} className="flex flex-col gap-1 flex-shrink-0">
                  {Array.from({ length: 7 }).map((_, d) => {
                    const val = HEATMAP_DATA[w * 7 + d] ?? 0;
                    return (
                      <div
                        key={d}
                        className="w-7 h-7 rounded-md cursor-pointer hover:ring-2 hover:ring-primary/50 transition-all"
                        style={{
                          background:
                            val === 0
                              ? 'color-mix(in srgb, var(--color-primary) 5%, transparent)'
                              : val <= 2
                                ? 'color-mix(in srgb, var(--color-primary) 20%, transparent)'
                                : val <= 4
                                  ? 'color-mix(in srgb, var(--color-primary) 45%, transparent)'
                                  : val <= 6
                                    ? 'color-mix(in srgb, var(--color-tertiary) 60%, transparent)'
                                    : 'linear-gradient(135deg, #d97706, #b91c1c)',
                        }}
                        title={`${val} finding${val !== 1 ? 's' : ''}`}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
            <div className="flex items-center gap-3 mt-3 text-[10px] text-on-surface-variant">
              <span>Less</span>
              {[0.05, 0.2, 0.45, 0.6].map((o) => (
                <div key={o} className="w-4 h-4 rounded-sm" style={{ background: `color-mix(in srgb, var(--color-primary) ${(o) * 100}%, transparent)` }} />
              ))}
              <div className="w-4 h-4 rounded-sm" style={{ background: 'linear-gradient(135deg, #d97706, #b91c1c)' }} />
              <span>More</span>
              <span className="ml-auto">Peak: May 10 · 8 findings (login outage)</span>
            </div>
          </GlassCard>
        </motion.div>

        {/* Notification preferences */}
        <motion.div variants={rise3d}>
          <GlassCard className="p-6">
            <div className="flex items-center gap-3 mb-5">
              <Icon name="notifications" size={18} className="text-primary" />
              <span className="font-bold text-sm">Notification preferences</span>
            </div>
            <div className="space-y-3">
              {[
                { type: 'Anomaly (NPS outside prediction band)', active: true, icon: 'warning', color: '#d97706' },
                { type: 'Bias warnings', active: true, icon: 'balance', color: '#b41340' },
                { type: 'New top driver', active: true, icon: 'local_fire_department', color: 'var(--color-tertiary)' },
                { type: 'Velocity spikes', active: false, icon: 'trending_up', color: '#059669' },
                { type: 'Predictive forecasts', active: false, icon: 'insights', color: 'var(--color-primary)' },
              ].map((pref) => (
                <div key={pref.type} className="flex items-center gap-3 py-2 border-b border-outline-variant/10 last:border-0">
                  <Icon name={pref.icon} size={16} style={{ color: pref.color, flexShrink: 0 }} />
                  <span className="text-sm flex-1">{pref.type}</span>
                  <div
                    className={`w-10 h-5 rounded-full flex items-center transition-all cursor-pointer ${
                      pref.active ? 'bg-primary justify-end' : 'bg-muted justify-start'
                    }`}
                  >
                    <div className="w-4 h-4 rounded-full bg-white mx-0.5 shadow-sm" />
                  </div>
                </div>
              ))}
            </div>
          </GlassCard>
        </motion.div>
      </motion.div>
    </div>
  );
}
