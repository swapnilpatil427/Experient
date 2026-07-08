// Live Metrics — full NPS time series, CSAT distribution, response velocity,
// driver-impact map, and ranked prescriptive action backlog.
// Route: /app/insights/metrics
// Breadcrumb: Intelligence › Live metrics

import { useState } from 'react';
import { motion } from 'framer-motion';
import { useSetPageTitle } from '../../contexts/pageTitle';
import { useSurveys } from '../../hooks/useSurveys';
import { useInsights } from '../../hooks/useInsights';
import { PageHeader } from '../../components/PageHeader';
import { Icon } from '../../components/Icon';
import { Button } from '@/components/ui/button';
import { SurveyScopePicker, type SurveyScope } from '../../components/SurveyScopePicker';
import { ROUTES } from '../../constants/routes';
import { GlassCard, CIBar, LayerBadge, ConfidenceChip, LiveDot } from './shared';

const rise3d = {
  hidden: { rotateX: -10, y: 32, opacity: 0 },
  visible: {
    rotateX: 0,
    y: 0,
    opacity: 1,
    transition: { duration: 0.42, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] },
  },
};
const stagger = { hidden: {}, visible: { transition: { staggerChildren: 0.07 } } };

const SCOPE_KEY = 'insights_scope';

// 90-day NPS dataset (demo)
const NPS_90D = [
  44,47,45,46,48,49,47,50,51,49,48,50,52,51,49,50,47,46,48,49,
  50,48,47,46,50,51,52,50,49,48,47,45,44,46,47,48,47,49,50,49,
  48,47,46,47,48,50,49,48,47,46,48,50,51,49,48,47,46,45,46,47,
  48,50,49,48,47,48,49,50,51,49,47,46,47,48,49,50,51,49,35,47,
  47,47,48,49,50,51,52,50,47,47,
];

const ACTIONS = [
  { label: 'Fix email verification loop', lift: '+3.2', conf: 89, n: 18, effort: 'Low' },
  { label: 'Reduce first support response time', lift: '+2.1', conf: 84, n: 31, effort: 'Medium' },
  { label: 'Streamline onboarding (step 3)', lift: '+1.8', conf: 78, n: 24, effort: 'Medium' },
  { label: 'Fix mobile keyboard overlap', lift: '+0.9', conf: 71, n: 12, effort: 'Low' },
  { label: 'Add pricing comparison page', lift: '+0.7', conf: 65, n: 9, effort: 'High' },
];

export function InsightsMetricsPage() {
  useSetPageTitle('Live Metrics', 'Intelligence');
  const { surveys } = useSurveys();

  const [scope, setScope] = useState<SurveyScope>(() => {
    if (typeof window === 'undefined') return 'all';
    return (window.localStorage.getItem(SCOPE_KEY) as SurveyScope) ?? 'all';
  });

  const focusSurveyId = scope === 'all' ? surveys.find((s) => s.status === 'active')?.id : scope;
  const { insights } = useInsights(focusSurveyId);
  const isAll = scope === 'all';
  const nps = insights?.nps_score ?? (isAll ? 51 : 47);
  const activeCount = surveys.filter((s) => s.status === 'active' && !s.deleted_at).length;
  const totalResponses = surveys.reduce((sum, s) => sum + (s.response_count ?? 0), 0);

  const handleScopeChange = (next: SurveyScope) => {
    setScope(next);
    try { window.localStorage.setItem(SCOPE_KEY, next); } catch { /* ignore */ }
  };

  return (
    <div className="max-w-7xl mx-auto w-full">
      <PageHeader
        crumbs={[
          { label: 'Intelligence', icon: 'psychology', path: ROUTES.INSIGHTS },
          { label: 'Live metrics' },
        ]}
        title="Live Metrics"
        subtitle={
          isAll
            ? `Portfolio · ${activeCount} active surveys · ${totalResponses.toLocaleString()} total responses`
            : `${surveys.find((s) => s.id === scope)?.title ?? 'Survey'} · ${(surveys.find((s) => s.id === scope)?.response_count ?? 0).toLocaleString()} responses`
        }
        actions={
          <div className="flex items-center gap-2">
            <SurveyScopePicker surveys={surveys} scope={scope} onChange={handleScopeChange} />
            <Button variant="outline" size="sm" className="text-xs gap-1.5">
              <Icon name="notifications" size={14} /> Configure alerts
            </Button>
          </div>
        }
      />

      <motion.div
        variants={stagger}
        initial="hidden"
        animate="visible"
        style={{ transformPerspective: 1200, transformOrigin: 'top center' }}
        className="space-y-8 mt-2"
      >
        {/* Hero metric row */}
        <motion.div variants={rise3d} className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <HeroTile
            label={isAll ? 'Portfolio NPS' : 'NPS'}
            value={String(nps)}
            sub={`±${isAll ? 3 : 5} · n=${isAll ? totalResponses.toLocaleString() : '312'}`}
            delta="+2"
            positive
            color="var(--color-primary)"
          />
          <HeroTile label="CSAT" value="4.2" sub="/ 5 · ±0.2" delta="stable" color="var(--color-secondary)" />
          <HeroTile
            label="Response velocity"
            value="2.3×"
            sub="vs. baseline (7d avg)"
            delta="+0.4×"
            positive
            color="var(--color-tertiary)"
          />
          <HeroTile
            label="Responses today"
            value="47"
            sub={`/ ${isAll ? totalResponses.toLocaleString() : '312'} total`}
            delta="+12"
            positive
            color="#059669"
          />
        </motion.div>

        {/* NPS 90-day time series */}
        <motion.div variants={rise3d}>
          <SectionDivider icon="show_chart" label="NPS — 90-day trend" />
          <GlassCard className="p-6 mt-3">
            <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
              <div className="flex items-center gap-3">
                <span className="text-4xl font-black font-headline">{nps}</span>
                <div>
                  <div className="flex items-center gap-1 text-xs font-bold text-emerald-600">
                    <Icon name="trending_up" size={14} /> +2 vs. last 7d
                  </div>
                  <CIBar position={46} width={80} />
                </div>
              </div>
              <div className="flex items-center gap-1 text-[10px]">
                <span className="w-3 h-0.5 bg-primary inline-block rounded" /> NPS
                <span className="w-3 h-0.5 bg-primary/30 inline-block rounded ml-2 border-dashed" /> Prediction band
                <span className="w-2 h-2 rounded bg-amber-500 inline-block ml-2" /> Anomaly
              </div>
            </div>
            <NPS90DChart data={NPS_90D} />
            <div className="flex items-center justify-between text-[9px] text-on-surface-variant font-bold mt-1">
              <span>Feb 14</span><span>Mar 14</span><span>Apr 14</span><span>May 14</span>
            </div>
          </GlassCard>
        </motion.div>

        {/* CSAT + Velocity side by side */}
        <motion.div variants={rise3d} className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* CSAT Distribution */}
          <div>
            <SectionDivider icon="star" label="CSAT distribution" />
            <GlassCard className="p-6 mt-3">
              <div className="space-y-3">
                {[
                  { stars: 5, pct: 42, count: 131 },
                  { stars: 4, pct: 28, count: 87 },
                  { stars: 3, pct: 14, count: 44 },
                  { stars: 2, pct: 10, count: 31 },
                  { stars: 1, pct: 6, count: 19 },
                ].map((row) => (
                  <div key={row.stars} className="flex items-center gap-3">
                    <span className="text-xs font-bold w-4 text-right">{row.stars}</span>
                    <Icon name="star" size={12} className="text-amber-400 flex-shrink-0" />
                    <div className="flex-1 h-4 rounded-full bg-muted relative overflow-hidden">
                      <motion.div
                        initial={{ width: 0 }}
                        animate={{ width: `${row.pct}%` }}
                        transition={{ duration: 0.7, delay: row.stars * 0.05, ease: [0.22, 1, 0.36, 1] }}
                        className="absolute inset-y-0 left-0 rounded-full"
                        style={{
                          background:
                            row.stars >= 4
                              ? 'linear-gradient(to right, #059669, var(--color-primary))'
                              : row.stars === 3
                                ? '#d97706'
                                : '#b91c1c',
                        }}
                      />
                    </div>
                    <span className="text-xs text-on-surface-variant w-8 text-right font-mono">{row.pct}%</span>
                    <span className="text-[10px] text-on-surface-variant w-6">{row.count}</span>
                  </div>
                ))}
              </div>
              <div className="mt-4 pt-4 border-t border-outline-variant/20 flex items-center gap-2">
                <span className="text-3xl font-black font-headline">4.2</span>
                <span className="text-sm text-on-surface-variant">/ 5 avg · n=312</span>
                <span className="ml-auto text-xs font-bold text-emerald-600">+0.1 vs. last 30d</span>
              </div>
            </GlassCard>
          </div>

          {/* Response velocity */}
          <div>
            <SectionDivider icon="speed" label="Response velocity" />
            <GlassCard className="p-6 mt-3">
              <div className="mb-4">
                <span className="text-3xl font-black font-headline">2.3×</span>
                <span className="text-sm text-on-surface-variant ml-2">above baseline · last 7 days</span>
              </div>
              <div className="flex items-end gap-1 h-24">
                {[4,6,5,8,12,18,22,29,35,31,28,25,22,19,18,22,26,30,34,32,28,22,18,14,
                  12,16,20,24,28,26,22,18,14,10,8,6,5,7,9,11,13,12,11,10,9,11,13].map((h, i) => (
                  <div
                    key={i}
                    className="flex-1 rounded-t-sm min-w-0"
                    style={{
                      height: `${(h / 35) * 100}%`,
                      background:
                        i >= 37
                          ? 'linear-gradient(to top, var(--color-primary), var(--color-tertiary))'
                          : `color-mix(in srgb, var(--color-primary) ${(0.25 + (h / 35) * 0.4) * 100}%, transparent)`,
                    }}
                  />
                ))}
              </div>
              <div className="flex items-center justify-between text-[9px] text-on-surface-variant font-bold mt-1">
                <span>Apr 28</span><span>May 7</span><span>May 14 (today)</span>
              </div>
              <div className="mt-3 text-xs text-on-surface-variant">
                Spike attributed to email campaign sent May 7 · sustained for 36h
              </div>
            </GlassCard>
          </div>
        </motion.div>

        {/* Driver impact scatter */}
        <motion.div variants={rise3d}>
          <SectionDivider icon="scatter_plot" label="Driver impact map" />
          <GlassCard className="p-6 mt-3">
            <div className="flex items-center gap-2 mb-4 text-xs text-on-surface-variant">
              <span>x-axis: importance (partial R²) · y-axis: current satisfaction · bubble size: mention volume</span>
            </div>
            <div className="relative h-64 bg-muted/30 rounded-xl overflow-hidden">
              {/* Quadrant labels */}
              <div className="absolute top-2 left-2 text-[9px] font-bold text-on-surface-variant/60 uppercase tracking-wider">Low impact · Low sat</div>
              <div className="absolute top-2 right-2 text-[9px] font-bold text-primary/60 uppercase tracking-wider text-right">High impact · Low sat ← fix these</div>
              <div className="absolute bottom-2 left-2 text-[9px] font-bold text-on-surface-variant/60 uppercase tracking-wider">Low impact · High sat</div>
              <div className="absolute bottom-2 right-2 text-[9px] font-bold text-emerald-600/60 uppercase tracking-wider text-right">High impact · High sat ✓</div>
              {/* Dividers */}
              <div className="absolute inset-x-0 top-1/2 h-px bg-border/40" />
              <div className="absolute inset-y-0 left-1/2 w-px bg-border/40" />
              {/* Driver bubbles */}
              {[
                { label: 'Support time', x: 78, y: 28, size: 44, color: '#b91c1c', primary: true },
                { label: 'Email loop', x: 65, y: 35, size: 36, color: '#d97706' },
                { label: 'Onboarding', x: 55, y: 40, size: 28, color: '#d97706' },
                { label: 'Mobile', x: 38, y: 55, size: 20, color: 'var(--color-primary)' },
                { label: 'Pricing', x: 62, y: 62, size: 22, color: '#059669' },
                { label: 'Speed', x: 25, y: 70, size: 16, color: '#059669' },
              ].map((d) => (
                <div
                  key={d.label}
                  className="absolute flex items-center justify-center rounded-full cursor-pointer hover:opacity-90 transition-opacity"
                  style={{
                    left: `${d.x}%`,
                    bottom: `${d.y}%`,
                    width: d.size,
                    height: d.size,
                    transform: 'translate(-50%, 50%)',
                    background: `${d.color}22`,
                    border: `2px solid ${d.color}`,
                  }}
                  title={d.label}
                >
                  <span className="text-[8px] font-bold text-center leading-tight px-0.5" style={{ color: d.color }}>
                    {d.label.split(' ')[0]}
                  </span>
                </div>
              ))}
            </div>
          </GlassCard>
        </motion.div>

        {/* Prescriptive action backlog */}
        <motion.div variants={rise3d}>
          <SectionDivider icon="checklist" label="Prescriptive action backlog" />
          <div className="space-y-3 mt-3">
            {ACTIONS.map((a, i) => (
              <GlassCard key={a.label} className="p-5 flex items-center gap-4">
                <span className="text-xl font-black font-headline text-on-surface-variant/40 w-6 flex-shrink-0 text-center">
                  {i + 1}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <LayerBadge layer="prescriptive" />
                    <ConfidenceChip value={a.conf} />
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                      a.effort === 'Low' ? 'bg-emerald-100 text-emerald-700'
                      : a.effort === 'Medium' ? 'bg-amber-100 text-amber-700'
                      : 'bg-red-100 text-red-700'
                    }`}>
                      {a.effort} effort
                    </span>
                  </div>
                  <p className="font-bold text-sm">{a.label}</p>
                  <p className="text-xs text-on-surface-variant mt-0.5">{a.n} cited respondents</p>
                </div>
                <div className="text-right flex-shrink-0">
                  <div className="text-lg font-black font-headline text-primary">{a.lift}</div>
                  <div className="text-[10px] text-on-surface-variant">NPS projected</div>
                </div>
                <Button size="sm" className="flex-shrink-0 text-xs gap-1.5">
                  <Icon name="flag" size={13} /> Ticket
                </Button>
              </GlassCard>
            ))}
          </div>
        </motion.div>
      </motion.div>
    </div>
  );
}

function HeroTile({ label, value, sub, delta, positive, color }: {
  label: string; value: string; sub: string; delta: string; positive?: boolean; color: string;
}) {
  return (
    <GlassCard className="p-5">
      <div className="text-[10px] font-black uppercase tracking-widest text-on-surface-variant mb-2">{label}</div>
      <div className="text-3xl font-black font-headline mb-1" style={{ color }}>{value}</div>
      <div className="text-[10px] text-on-surface-variant mb-2">{sub}</div>
      <div className={`text-[11px] font-bold flex items-center gap-1 ${
        delta === 'stable' ? 'text-on-surface-variant'
        : positive ? 'text-emerald-600' : 'text-red-600'
      }`}>
        {delta !== 'stable' && <Icon name={positive ? 'trending_up' : 'trending_down'} size={12} />}
        {delta === 'stable' ? '— stable' : `${delta} / 7d`}
      </div>
    </GlassCard>
  );
}

function NPS90DChart({ data }: { data: number[] }) {
  const min = 25, max = 60, h = 80;
  const toY = (v: number) => h - ((v - min) / (max - min)) * h;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * 600},${toY(v)}`).join(' ');
  const anomalyIdx = 78;
  return (
    <svg viewBox="0 0 600 80" className="w-full" style={{ height: 120 }}>
      <defs>
        <linearGradient id="npsFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--color-primary)" stopOpacity="0.15" />
          <stop offset="1" stopColor="var(--color-primary)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {/* Prediction band */}
      <path
        d={`M0,${toY(44)} L600,${toY(44)} L600,${toY(52)} L0,${toY(52)} Z`}
        fill="color-mix(in srgb, var(--color-primary) 7%, transparent)"
      />
      {/* Area fill */}
      <polyline points={`0,${h} ${pts} 600,${h}`} fill="url(#npsFill)" />
      {/* Line */}
      <polyline points={pts} fill="none" stroke="var(--color-primary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      {/* Anomaly dot */}
      <circle cx={(anomalyIdx / (data.length - 1)) * 600} cy={toY(data[anomalyIdx])} r={5} fill="#d97706" />
      <circle cx={(anomalyIdx / (data.length - 1)) * 600} cy={toY(data[anomalyIdx])} r={9} fill="none" stroke="#d97706" strokeWidth="1.5" strokeDasharray="3 2" />
    </svg>
  );
}

function SectionDivider({ icon, label }: { icon: string; label: string }) {
  return (
    <div className="flex items-center gap-3">
      <div className="h-px flex-1 bg-border/40" />
      <span className="text-[10px] font-black uppercase tracking-[0.25em] text-on-surface-variant flex items-center gap-1.5">
        <Icon name={icon} size={13} />
        {label}
      </span>
      <div className="flex items-center gap-1.5 text-[10px] text-emerald-600 font-bold">
        <LiveDot color="#059669" size={5} /> Live
      </div>
      <div className="h-px flex-1 bg-border/40" />
    </div>
  );
}
