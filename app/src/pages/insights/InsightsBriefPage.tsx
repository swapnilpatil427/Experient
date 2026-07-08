// Recent Briefs — full narrative history with citation expansion, audience toggle, delivery settings.
// Route: /app/insights/brief
// Breadcrumb: Intelligence › Recent briefs

import { useState } from 'react';
import { motion } from 'framer-motion';
import { useSetPageTitle } from '../../contexts/pageTitle';
import { PageHeader } from '../../components/PageHeader';
import { Icon } from '../../components/Icon';
import { Button } from '@/components/ui/button';
import { ROUTES } from '../../constants/routes';
import { GlassCard, CitationChip, ConfidenceChip, LiveDot } from './shared';

const rise3d = {
  hidden: { rotateX: -10, y: 32, opacity: 0 },
  visible: {
    rotateX: 0,
    y: 0,
    opacity: 1,
    transition: { duration: 0.42, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] },
  },
};

const stagger = { hidden: {}, visible: { transition: { staggerChildren: 0.08 } } };

type Audience = 'exec' | 'technical';

const BRIEF_HISTORY = [
  { id: 'b4', date: 'May 14, 2026 · 09:02', nps: 47, driver: 'Support response time', confidence: 91 },
  { id: 'b3', date: 'May 13, 2026 · 09:01', nps: 44, driver: 'Onboarding friction', confidence: 87 },
  { id: 'b2', date: 'May 12, 2026 · 08:59', nps: 43, driver: 'Email verification loop', confidence: 85 },
  { id: 'b1', date: 'May 11, 2026 · 09:03', nps: 35, driver: 'Login outage (May 10)', confidence: 92 },
  { id: 'b0', date: 'May 10, 2026 · 08:58', nps: 47, driver: 'Support response time', confidence: 88 },
];

export function InsightsBriefPage() {
  useSetPageTitle('Recent Briefs', 'Intelligence');
  const [audience, setAudience] = useState<Audience>('exec');
  const [expandedBrief, setExpandedBrief] = useState<string | null>(null);

  return (
    <div className="max-w-7xl mx-auto w-full">
      <PageHeader
        crumbs={[
          { label: 'Intelligence', icon: 'psychology', path: ROUTES.INSIGHTS },
          { label: 'Recent briefs' },
        ]}
        title="Recent Briefs"
        subtitle="AI-generated narrative summaries of your survey intelligence"
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" className="text-xs gap-1.5">
              <Icon name="schedule" size={14} /> Scheduled delivery
            </Button>
            <Button variant="outline" size="sm" className="text-xs gap-1.5">
              <Icon name="picture_as_pdf" size={14} /> Export PDF
            </Button>
            <Button size="sm" className="text-xs gap-1.5">
              <Icon name="ios_share" size={14} /> Send to Slack
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
        {/* Audience toggle */}
        <motion.div variants={rise3d} className="flex items-center gap-2">
          <span className="text-[10px] font-black uppercase tracking-widest text-on-surface-variant mr-1">
            Narrative mode
          </span>
          {(['exec', 'technical'] as Audience[]).map((a) => (
            <button
              key={a}
              onClick={() => setAudience(a)}
              className={`px-3 py-1.5 rounded-full text-xs font-bold transition-colors ${
                audience === a
                  ? 'bg-primary text-white'
                  : 'bg-muted text-on-surface-variant hover:bg-primary/10 hover:text-primary'
              }`}
            >
              {a === 'exec' ? 'Executive' : 'Technical'}
            </button>
          ))}
          <span className="ml-2 text-[10px] text-on-surface-variant">
            {audience === 'exec'
              ? 'Plain-language summary for stakeholders'
              : 'Full citations, confidence intervals and method notes'}
          </span>
        </motion.div>

        {/* Current brief — full */}
        <motion.div variants={rise3d}>
          <div className="flex items-center gap-2 mb-4">
            <div
              className="w-2 h-2 rounded-full"
              style={{ background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))' }}
            />
            <span className="text-[10px] font-black uppercase tracking-[0.2em] text-primary">
              Current brief
            </span>
            <span className="text-[10px] text-on-surface-variant">May 14, 2026 · 09:02 · generated 12s ago</span>
            <span className="ml-auto flex items-center gap-1 text-[10px] text-emerald-600 font-bold">
              <LiveDot color="#059669" size={5} /> Live
            </span>
          </div>

          <GlassCard className="p-8">
            {/* Headline */}
            <h2 className="text-2xl md:text-3xl font-black font-headline leading-tight mb-6">
              NPS held steady at{' '}
              <span
                className="text-transparent bg-clip-text"
                style={{ backgroundImage: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))' }}
              >
                47
              </span>{' '}
              with a recovered 12-point dip; support response time is the #1 driver.
            </h2>

            {audience === 'exec' ? (
              <ExecNarrative />
            ) : (
              <TechnicalNarrative />
            )}

            {/* Delta vs previous brief */}
            <div className="grid grid-cols-3 gap-4 mt-6 pt-6 border-t border-outline-variant/20">
              <DeltaTile label="NPS" value="47" delta="+3" positive />
              <DeltaTile label="Top driver rank shift" value="#1 → #1" delta="stable" />
              <DeltaTile label="New themes vs. last brief" value="0 new" delta="stable" />
            </div>

            {/* Footer actions */}
            <div className="flex items-center gap-3 mt-6 pt-6 border-t border-outline-variant/20 flex-wrap">
              <div className="text-xs text-on-surface-variant">
                <span className="font-bold">Confidence 89</span> · 9 cited responses · n=312
              </div>
              <div className="flex-1" />
              <Button variant="outline" size="sm" className="text-xs gap-1.5">
                <Icon name="ios_share" size={14} /> Slack
              </Button>
              <Button variant="outline" size="sm" className="text-xs gap-1.5">
                <Icon name="picture_as_pdf" size={14} /> Export
              </Button>
            </div>
          </GlassCard>
        </motion.div>

        {/* Brief history */}
        <motion.div variants={rise3d} className="space-y-3">
          <div className="flex items-center gap-3 mb-2">
            <div className="h-px flex-1 bg-border/40" />
            <span className="text-[10px] font-black uppercase tracking-[0.25em] text-on-surface-variant flex items-center gap-2">
              <Icon name="history" size={13} /> Brief history
            </span>
            <div className="h-px flex-1 bg-border/40" />
          </div>

          {BRIEF_HISTORY.map((brief) => (
            <GlassCard key={brief.id} className="p-5">
              <button
                className="w-full flex items-center gap-4 text-left"
                onClick={() =>
                  setExpandedBrief(expandedBrief === brief.id ? null : brief.id)
                }
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3 mb-1">
                    <span className="text-[10px] font-black uppercase tracking-widest text-on-surface-variant">
                      {brief.date}
                    </span>
                    <ConfidenceChip value={brief.confidence} />
                  </div>
                  <p className="text-sm font-bold truncate">
                    NPS {brief.nps} · Top driver: {brief.driver}
                  </p>
                </div>
                <div className="flex items-center gap-3 flex-shrink-0">
                  <span
                    className="text-2xl font-black font-headline"
                    style={{
                      color:
                        brief.nps >= 45 ? '#059669' : brief.nps >= 35 ? '#d97706' : '#b91c1c',
                    }}
                  >
                    {brief.nps}
                  </span>
                  <Icon
                    name={expandedBrief === brief.id ? 'expand_less' : 'expand_more'}
                    size={20}
                    className="text-on-surface-variant"
                  />
                </div>
              </button>

              {expandedBrief === brief.id && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
                  className="mt-4 pt-4 border-t border-outline-variant/20"
                >
                  <p className="text-sm leading-relaxed text-on-surface-variant">
                    Archived brief for {brief.date}. NPS stood at{' '}
                    <strong>{brief.nps}</strong>, with{' '}
                    <strong>{brief.driver}</strong> as the primary detractor driver
                    <CitationChip id="r983" />
                    <CitationChip id="r1234" />. Full citation data available in
                    the technical export.
                  </p>
                  <div className="flex items-center gap-2 mt-3">
                    <Button variant="outline" size="sm" className="text-xs gap-1.5">
                      <Icon name="picture_as_pdf" size={13} /> Export this brief
                    </Button>
                    <Button variant="outline" size="sm" className="text-xs gap-1.5">
                      <Icon name="compare" size={13} /> Compare to current
                    </Button>
                  </div>
                </motion.div>
              )}
            </GlassCard>
          ))}
        </motion.div>

        {/* Scheduled delivery */}
        <motion.div variants={rise3d}>
          <GlassCard className="p-6">
            <div className="flex items-center gap-3 mb-4">
              <Icon name="schedule" size={18} className="text-primary" />
              <span className="font-bold text-sm">Scheduled delivery</span>
              <span className="ml-auto px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 text-[10px] font-bold">
                Active
              </span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
              <div>
                <div className="text-[10px] font-black uppercase tracking-widest text-on-surface-variant mb-1">
                  Frequency
                </div>
                <div className="font-bold">Daily · 9:00 AM</div>
              </div>
              <div>
                <div className="text-[10px] font-black uppercase tracking-widest text-on-surface-variant mb-1">
                  Channels
                </div>
                <div className="font-bold">#cx-insights · Email digest</div>
              </div>
              <div>
                <div className="text-[10px] font-black uppercase tracking-widest text-on-surface-variant mb-1">
                  Format
                </div>
                <div className="font-bold">Executive · PDF attachment</div>
              </div>
            </div>
            <Button variant="outline" size="sm" className="text-xs mt-4 gap-1.5">
              <Icon name="edit" size={13} /> Edit schedule
            </Button>
          </GlassCard>
        </motion.div>
      </motion.div>
    </div>
  );
}

function ExecNarrative() {
  return (
    <div className="space-y-4 text-base leading-relaxed">
      <p>
        NPS held steady at <strong>47</strong>, recovering from a 12-point dip on May 10 that was
        tied to a login outage. The recovery happened within 48 hours, indicating strong
        underlying sentiment.
      </p>
      <p>
        The single highest-priority action this week is{' '}
        <strong>fixing the email verification loop</strong> — cited by 18 customers and projected
        to raise NPS by <strong>+3.2 points</strong>.
      </p>
      <p className="text-on-surface-variant">
        No new themes emerged since the last brief. Portfolio metrics are stable.
      </p>
    </div>
  );
}

function TechnicalNarrative() {
  return (
    <div className="space-y-4 text-sm leading-relaxed">
      <p>
        NPS = <strong>47 ±5</strong> <CitationChip id="r1102" />
        <CitationChip id="r1188" /> (n=312). A changepoint was detected on 2026-05-10 at
        14:12 UTC <CitationChip id="r2104" />
        <CitationChip id="r2107" /> using Bayesian online changepoint detection (BOCPD,
        run-length posterior). The point estimate dropped to <strong>35</strong> — outside
        the 95% prediction interval [42–52].
      </p>
      <p>
        Correlation coefficient between "login error" mentions and detractor NPS on May 10:
        <strong> r=0.81</strong> (p&lt;0.001). Sentiment dropped from{' '}
        <strong>+0.12 to −0.41</strong> (effect size large by Cohen's d).
      </p>
      <p>
        Primary driver: <strong>support response time</strong> (partial R² = 0.31)
        <CitationChip id="r983" />
        <CitationChip id="r1234" />. Prescriptive recommendation: fix email verification
        loop — projected NPS lift <strong>+3.2 ±1.8</strong>
        <CitationChip id="r1188" />
        <CitationChip id="r1492" />.{' '}
        <span className="text-on-surface-variant">
          Method: causal forest (Wager &amp; Athey 2018) with bootstrap CI (n=1000).
          Verifier: claude-haiku-4.5 → supported.
        </span>
      </p>
    </div>
  );
}

function DeltaTile({
  label,
  value,
  delta,
  positive,
}: {
  label: string;
  value: string;
  delta: string;
  positive?: boolean;
}) {
  return (
    <div className="rounded-xl bg-muted/50 px-4 py-3">
      <div className="text-[10px] font-black uppercase tracking-widest text-on-surface-variant mb-1">
        {label}
      </div>
      <div className="font-black text-lg font-headline">{value}</div>
      <div
        className={`text-[11px] font-bold mt-0.5 ${
          delta === 'stable'
            ? 'text-on-surface-variant'
            : positive
              ? 'text-emerald-600'
              : 'text-red-600'
        }`}
      >
        {delta === 'stable' ? '—' : delta} vs. last brief
      </div>
    </div>
  );
}
