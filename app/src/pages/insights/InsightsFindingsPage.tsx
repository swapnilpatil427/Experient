// Deeper Findings — full findings grid with persistent filter tabs, pinned section,
// expandable inline detail, and comparison mode strip.
// Route: /app/insights/findings
// Breadcrumb: Intelligence › Deeper findings

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useSetPageTitle } from '../../contexts/pageTitle';
import { PageHeader } from '../../components/PageHeader';
import { Icon } from '../../components/Icon';
import { Button } from '@/components/ui/button';
import { ROUTES } from '../../constants/routes';
import { GlassCard, CitationChip, ConfidenceChip, LayerBadge, CIBar, type InsightLayer } from './shared';

type FilterTab = 'all' | 'drivers' | 'voice' | 'anomalies' | 'predictive';

interface Finding {
  id: string;
  layer: InsightLayer;
  icon: string;
  iconColor: string;
  title: string;
  body: string;
  confidence: number;
  citations: string[];
  n: number;
  pinned?: boolean;
  borderColor?: string;
  tab: FilterTab[];
}

const FINDINGS: Finding[] = [
  {
    id: 'f1',
    layer: 'diagnostic',
    icon: 'local_fire_department',
    iconColor: 'var(--color-tertiary)',
    title: '"Support response time" is the #1 driver of NPS',
    body: 'Its importance jumped from 4th to 1st position in the last 30 days. Detractors mention support delay in 47% of cases. Partial R² = 0.31.',
    confidence: 89,
    citations: ['r983', 'r1234', 'r1492'],
    n: 189,
    pinned: true,
    tab: ['all', 'drivers'],
  },
  {
    id: 'f2',
    layer: 'predictive',
    icon: 'warning',
    iconColor: '#d97706',
    title: 'NPS dropped 12 points on May 10 — anomaly confirmed',
    body: 'Outside the 95% prediction interval [42–52]. Linked to a "login error" spike in the same 24h window.',
    confidence: 92,
    citations: ['r2104', 'r2111', 'r2114'],
    n: 14,
    borderColor: '#d97706',
    tab: ['all', 'anomalies'],
  },
  {
    id: 'f3',
    layer: 'diagnostic',
    icon: 'forum',
    iconColor: 'var(--color-primary)',
    title: '"Onboarding friction" — 102 mentions, 3 sub-themes',
    body: 'Email verification loop (24 mentions, 92% negative), password reset confusion (18, 78% neg), profile setup steps (12, 52% neg).',
    confidence: 76,
    citations: ['r1188', 'r1244'],
    n: 102,
    tab: ['all', 'voice'],
  },
  {
    id: 'f4',
    layer: 'predictive',
    icon: 'insights',
    iconColor: 'var(--color-primary)',
    title: 'Projected NPS at 500 responses: 51 ±4 by Friday',
    body: 'Based on velocity and sentiment trend. Promoters disproportionately complete in late waves — Prophet model + 1000-bootstrap CI.',
    confidence: 81,
    citations: ['r2401', 'r2415'],
    n: 312,
    tab: ['all', 'predictive'],
  },
  {
    id: 'f5',
    layer: 'prescriptive',
    icon: 'bolt',
    iconColor: '#059669',
    title: 'Fixing email verification loop: highest ROI action',
    body: 'Projected NPS +3.2 ±1.8 if fixed. 18 cited respondents. In the top-right quadrant of the impact–feasibility matrix.',
    confidence: 89,
    citations: ['r1188', 'r1234', 'r1492'],
    n: 18,
    tab: ['all', 'drivers'],
  },
  {
    id: 'f6',
    layer: 'descriptive',
    icon: 'balance',
    iconColor: '#b41340',
    title: '73% of responses are from Enterprise tier — potential bias',
    body: 'This over-represents Enterprise NPS and under-represents SMB experience. Recommend post-stratification weighting.',
    confidence: 95,
    citations: ['r3011', 'r3022'],
    n: 228,
    borderColor: '#b41340',
    tab: ['all', 'anomalies'],
  },
  {
    id: 'f7',
    layer: 'diagnostic',
    icon: 'trending_up',
    iconColor: '#059669',
    title: 'Pricing transparency: recurring theme across 4 surveys',
    body: 'Appears in 4 of 7 active surveys. Highest volume in the Customer Onboarding and Post-Purchase surveys. Mostly neutral sentiment (not negative).',
    confidence: 83,
    citations: ['r1800', 'r1834'],
    n: 67,
    tab: ['all', 'drivers', 'voice'],
  },
  {
    id: 'f8',
    layer: 'predictive',
    icon: 'timelapse',
    iconColor: 'var(--color-tertiary)',
    title: 'Response velocity 2.3× baseline — likely email campaign effect',
    body: 'Velocity spike started 2026-05-07, sustained 36h, now normalizing. Cohort shows +0.18 average sentiment vs. +0.05 baseline.',
    confidence: 91,
    citations: ['r2600', 'r2611'],
    n: 142,
    tab: ['all', 'predictive'],
  },
];

const TABS: { id: FilterTab; label: string; icon: string }[] = [
  { id: 'all', label: 'All', icon: 'dashboard' },
  { id: 'drivers', label: 'Drivers', icon: 'local_fire_department' },
  { id: 'voice', label: 'Voice', icon: 'forum' },
  { id: 'anomalies', label: 'Anomalies', icon: 'warning' },
  { id: 'predictive', label: 'Predictive', icon: 'insights' },
];

const rise3d = {
  hidden: { rotateX: -10, y: 32, opacity: 0 },
  visible: {
    rotateX: 0, y: 0, opacity: 1,
    transition: { duration: 0.42, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] },
  },
};
const stagger = { hidden: {}, visible: { transition: { staggerChildren: 0.06 } } };

export function InsightsFindingsPage() {
  useSetPageTitle('Deeper Findings', 'Intelligence');
  const [activeTab, setActiveTab] = useState<FilterTab>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(
    new Set(FINDINGS.filter((f) => f.pinned).map((f) => f.id)),
  );

  const tabCounts = TABS.reduce<Record<FilterTab, number>>((acc, t) => {
    acc[t.id] = FINDINGS.filter((f) => f.tab.includes(t.id)).length;
    return acc;
  }, {} as Record<FilterTab, number>);

  const visible = FINDINGS.filter((f) => f.tab.includes(activeTab));
  const pinned = visible.filter((f) => pinnedIds.has(f.id));
  const rest = visible.filter((f) => !pinnedIds.has(f.id));

  const togglePin = (id: string) => {
    setPinnedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  return (
    <div className="max-w-7xl mx-auto w-full">
      <PageHeader
        crumbs={[
          { label: 'Intelligence', icon: 'psychology', path: ROUTES.INSIGHTS },
          { label: 'Deeper findings' },
        ]}
        title="Deeper Findings"
        subtitle="All AI-surfaced drivers, anomalies, voice-of-customer and predictive signals"
        actions={
          <Button variant="outline" size="sm" className="text-xs gap-1.5">
            <Icon name="compare" size={14} /> Compare periods
          </Button>
        }
      />

      {/* Persistent filter tab bar */}
      <div className="flex items-center gap-1 mt-4 mb-6 p-1 rounded-xl bg-muted/50 border border-border/30 w-fit flex-wrap">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold transition-all ${
              activeTab === tab.id
                ? 'bg-primary text-white shadow-sm'
                : 'text-on-surface-variant hover:bg-background hover:text-on-surface'
            }`}
          >
            <Icon name={tab.icon} size={13} />
            {tab.label}
            <span className={`text-[10px] font-mono rounded-full px-1.5 py-0.5 ${
              activeTab === tab.id ? 'bg-white/20' : 'bg-muted text-on-surface-variant'
            }`}>
              {tabCounts[tab.id]}
            </span>
          </button>
        ))}
      </div>

      <motion.div
        variants={stagger}
        initial="hidden"
        animate="visible"
        style={{ transformPerspective: 1200, transformOrigin: 'top center' }}
        className="space-y-8"
      >
        {/* Pinned section */}
        {pinned.length > 0 && (
          <motion.div variants={rise3d} className="space-y-3">
            <div className="flex items-center gap-3">
              <div className="h-px flex-1 bg-border/40" />
              <span className="text-[10px] font-black uppercase tracking-[0.25em] text-on-surface-variant flex items-center gap-1.5">
                <Icon name="push_pin" size={12} /> Pinned findings
              </span>
              <div className="h-px flex-1 bg-border/40" />
            </div>
            {pinned.map((f) => (
              <FindingCard
                key={f.id}
                finding={f}
                expanded={expandedId === f.id}
                pinned
                onExpand={() => setExpandedId(expandedId === f.id ? null : f.id)}
                onTogglePin={() => togglePin(f.id)}
              />
            ))}
          </motion.div>
        )}

        {/* All findings */}
        <motion.div variants={rise3d} className="space-y-4">
          {pinned.length > 0 && (
            <div className="flex items-center gap-3">
              <div className="h-px flex-1 bg-border/40" />
              <span className="text-[10px] font-black uppercase tracking-[0.25em] text-on-surface-variant">
                All findings · {rest.length}
              </span>
              <div className="h-px flex-1 bg-border/40" />
            </div>
          )}
          {rest.map((f) => (
            <FindingCard
              key={f.id}
              finding={f}
              expanded={expandedId === f.id}
              pinned={false}
              onExpand={() => setExpandedId(expandedId === f.id ? null : f.id)}
              onTogglePin={() => togglePin(f.id)}
            />
          ))}
          {visible.length === 0 && (
            <div className="text-center py-16 text-on-surface-variant text-sm">
              No findings in this category yet.
            </div>
          )}
        </motion.div>
      </motion.div>
    </div>
  );
}

function FindingCard({
  finding: f, expanded, pinned, onExpand, onTogglePin,
}: {
  finding: Finding;
  expanded: boolean;
  pinned: boolean;
  onExpand: () => void;
  onTogglePin: () => void;
}) {
  return (
    <GlassCard
      className="overflow-hidden"
      style={f.borderColor ? { borderLeft: `4px solid ${f.borderColor}` } : undefined}
    >
      <button className="w-full p-5 text-left flex items-start gap-4" onClick={onExpand}>
        <Icon name={f.icon} size={22} style={{ color: f.iconColor, marginTop: 2, flexShrink: 0 }} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1.5 flex-wrap">
            <LayerBadge layer={f.layer} />
            <ConfidenceChip value={f.confidence} />
            <span className="text-[10px] text-on-surface-variant ml-1">n={f.n}</span>
          </div>
          <p className="font-bold text-sm leading-snug">{f.title}</p>
          <p className="text-xs text-on-surface-variant mt-1 line-clamp-2">{f.body}</p>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={(e) => { e.stopPropagation(); onTogglePin(); }}
            className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${
              pinned ? 'text-primary bg-primary/10' : 'text-on-surface-variant hover:bg-muted'
            }`}
          >
            <Icon name="push_pin" size={15} />
          </button>
          <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-on-surface-variant`}>
            <Icon name={expanded ? 'expand_less' : 'expand_more'} size={18} />
          </div>
        </div>
      </button>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <div className="px-5 pb-5 pt-0 border-t border-outline-variant/20 mt-0">
              <div className="pt-4 space-y-4">
                {/* Full text */}
                <p className="text-sm leading-relaxed">{f.body}</p>

                {/* Citations */}
                <div className="flex flex-wrap items-center gap-1">
                  <span className="text-[10px] font-bold text-on-surface-variant mr-1">Sources</span>
                  {f.citations.map((c) => <CitationChip key={c} id={c} />)}
                </div>

                {/* CI Bar */}
                <div className="flex items-center gap-3">
                  <span className="text-[10px] font-black uppercase tracking-widest text-on-surface-variant">
                    Confidence interval
                  </span>
                  <CIBar position={f.confidence - 10} width={200} />
                  <span className="text-[10px] font-mono text-on-surface-variant">CONF {f.confidence}</span>
                </div>

                {/* AI Reasoning chain */}
                <div className="rounded-xl bg-muted/50 p-4">
                  <div className="text-[10px] font-black uppercase tracking-widest text-on-surface-variant mb-2 flex items-center gap-1.5">
                    <Icon name="diamond" size={11} /> Crystal's reasoning
                  </div>
                  <p className="text-xs leading-relaxed text-on-surface-variant">
                    Input: {f.n} responses matching the theme cluster. Method: {
                      f.layer === 'diagnostic' ? 'topic correlation + partial R² regression (causal forest, Wager & Athey 2018)'
                      : f.layer === 'predictive' ? 'Bayesian changepoint detection (BOCPD) + Prophet forecasting'
                      : f.layer === 'prescriptive' ? 'uplift modeling + bootstrap CI (n=1000)'
                      : 'frequency analysis + sentiment scoring'
                    }. Verifier: claude-haiku-4.5 → supported.
                  </p>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2 flex-wrap">
                  <Button size="sm" className="text-xs gap-1.5">
                    <Icon name="format_quote" size={13} /> Show quotes
                  </Button>
                  <Button size="sm" variant="outline" className="text-xs gap-1.5">
                    <Icon name="flag" size={13} /> Create ticket
                  </Button>
                  <Button size="sm" variant="outline" className="text-xs gap-1.5">
                    <Icon name="ios_share" size={13} /> Slack
                  </Button>
                  <Button size="sm" variant="outline" className="text-xs gap-1.5">
                    <Icon name="help" size={13} /> Why this?
                  </Button>
                  <div className="flex-1" />
                  <Button size="icon" variant="ghost" className="w-7 h-7">
                    <Icon name="thumb_up" size={13} />
                  </Button>
                  <Button size="icon" variant="ghost" className="w-7 h-7">
                    <Icon name="thumb_down" size={13} />
                  </Button>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </GlassCard>
  );
}
