// Editorial Brief — the default Insights variant.
// Magazine-style narrative-led layout: brief paragraph at top, metric strip,
// bento grid of insight cards, ⌘K ask bar at bottom.
// TODO: i18n keys once locales/en.js extension is done.

import { motion } from 'framer-motion';
import { Icon } from '../../components/Icon';
import { Button } from '@/components/ui/button';
import type { Insight, Survey } from '../../types';
import type { SurveyScope } from '../../components/SurveyScopePicker';
import {
  GlassCard,
  CitationChip,
  ConfidenceChip,
  CIBar,
  LayerBadge,
  LiveDot,
} from './shared';

const fadeUp = {
  hidden: { opacity: 0, y: 16 },
  visible: (i = 0) => ({
    opacity: 1,
    y: 0,
    transition: { duration: 0.6, delay: i * 0.06, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] },
  }),
};

interface ViewProps {
  insights: Insight | null;
  scope: SurveyScope;
  surveys: Survey[];
}

export function EditorialView({ insights, scope, surveys }: ViewProps) {
  const isAll = scope === 'all';
  const nps = insights?.nps_score ?? 47;
  const activeSurveys = surveys.filter((s) => s.status === 'active' && !s.deleted_at);
  const activeCount = activeSurveys.length;
  const totalResponses = surveys.reduce((sum, s) => sum + (s.response_count ?? 0), 0);
  // For 'all' scope, the most recent active survey is used as a "lead" survey
  // for representative content; cross-survey aggregation backend is a TODO.
  const leadSurvey = activeSurveys[0];

  return (
    <div className="space-y-8">
      {/* ── Today's Brief ─────────────────────────────────────────────────── */}
      <motion.section
        custom={0}
        variants={fadeUp}
        initial="hidden"
        animate="visible"
        className="flex items-start gap-6"
      >
        {/* Compact orb */}
        <div
          className="w-32 h-32 rounded-2xl flex items-center justify-center flex-shrink-0 holographic"
          style={{
            background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))',
            boxShadow: '0 10px 30px -10px rgba(0,0,0,0.10), inset 0 2px 4px rgba(255,255,255,0.8)',
            animation: 'float-bob 6s ease-in-out infinite',
          }}
        >
          <Icon name={isAll ? 'dataset' : 'diamond'} size={44} style={{ color: 'white' }} />
        </div>

        <div className="pt-2 flex-1">
          <div className="text-[10px] font-black uppercase tracking-[0.2em] text-tertiary mb-2">
            {isAll
              ? `Portfolio brief · ${activeCount} active surveys · generated 12s ago`
              : "Today's brief · generated 12s ago"}
          </div>
          <h1 className="text-3xl md:text-4xl lg:text-5xl font-black font-headline tracking-tight leading-tight max-w-3xl">
            {isAll ? (
              <>
                <span className="text-tertiary">"Pricing transparency"</span> appears as a top theme in 4 of your {activeCount} surveys; portfolio-wide NPS holds at 51.
              </>
            ) : (
              <>
                NPS held steady at {nps} with a recovered 12-point dip; <span className="text-tertiary">support response time</span> is now the #1 driver of detractor sentiment.
              </>
            )}
          </h1>
        </div>
      </motion.section>

      {/* ── Brief paragraph with citations ──────────────────────────────── */}
      <motion.div custom={1} variants={fadeUp} initial="hidden" animate="visible">
        <GlassCard className="p-7 max-w-4xl">
          {isAll ? (
            <p className="text-base leading-relaxed font-medium text-on-surface">
              Across your <strong>{activeCount} active surveys</strong> (<strong>{totalResponses.toLocaleString()} total responses</strong>), portfolio NPS sits at <strong>51 ±3</strong>
              <CitationChip id="agg.nps" /><CitationChip id="agg.csat" />
              . The most recurring topic is <strong>"pricing transparency"</strong>, surfacing in <strong>4 surveys</strong>
              {leadSurvey ? <> including <em>{leadSurvey.title}</em></> : null}
              {' '}
              <CitationChip id="r1188" /><CitationChip id="r2104" /><CitationChip id="r3401" />.
              The single highest-impact portfolio action: <strong>fix the email verification loop</strong> in the Onboarding survey — projected to lift portfolio NPS by <strong>+1.4 ±0.7</strong> on its own
              <CitationChip id="r1234" /><CitationChip id="r1492" />.
            </p>
          ) : (
            <p className="text-base leading-relaxed font-medium text-on-surface">
              NPS held steady at <strong>{nps}</strong>
              <CitationChip id="r1102" /><CitationChip id="r1188" />
              {' '}with a brief 12-point dip on May 10
              <CitationChip id="r2104" /><CitationChip id="r2107" />
              {' '}now recovered. The dominant driver of detractor sentiment remains <strong>support response time</strong>, which moved from 4th to 1st position in the last 30 days
              <CitationChip id="r983" /><CitationChip id="r1234" />.
              {' '}The single highest-leverage action this week is <strong>fixing the email verification loop</strong> — cited by 18 respondents, projected to raise NPS by <strong>+3.2 ±1.8</strong>
              <CitationChip id="r1188" /><CitationChip id="r1234" /><CitationChip id="r1492" />.
            </p>
          )}
          <div className="flex items-center gap-3 mt-5 pt-5 border-t border-outline-variant/30">
            <div className="text-xs">
              <span className="font-bold">Confidence 89</span>
              <span className="text-on-surface-variant"> · 9 cited responses · n=312</span>
            </div>
            <div className="flex-1" />
            <Button variant="outline" size="sm" className="text-xs">
              <Icon name="ios_share" size={14} /> Send to Slack
            </Button>
            <Button variant="outline" size="sm" className="text-xs">
              <Icon name="picture_as_pdf" size={14} /> Export brief
            </Button>
          </div>
        </GlassCard>
      </motion.div>

      {/* ── Source surveys strip (cross-survey scope only) ───────────────── */}
      {isAll && activeSurveys.length > 0 && (
        <motion.section custom={1.5} variants={fadeUp} initial="hidden" animate="visible">
          <div className="flex items-center gap-2 mb-2">
            <Icon name="dataset" size={16} className="text-on-surface-variant" />
            <span className="text-[10px] font-black uppercase tracking-widest text-on-surface-variant">
              Contributing surveys
            </span>
            <span className="text-[10px] font-bold text-on-surface-variant/70">
              {activeSurveys.length} active · {totalResponses.toLocaleString()} responses
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {activeSurveys.slice(0, 8).map((s) => (
              <button
                key={s.id}
                className="px-3 py-1.5 rounded-full bg-card border border-border/40 hover:border-primary/40 transition flex items-center gap-2 text-xs"
                title={`Switch to ${s.title}`}
              >
                <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                <span className="font-bold truncate max-w-[180px]">{s.title || 'Untitled survey'}</span>
                <span className="font-mono text-on-surface-variant text-[10px]">
                  {(s.response_count ?? 0).toLocaleString()}
                  {typeof s.nps_score === 'number' && ` · NPS ${Math.round(s.nps_score)}`}
                </span>
              </button>
            ))}
            {activeSurveys.length > 8 && (
              <button className="px-3 py-1.5 rounded-full text-xs font-bold text-primary hover:bg-primary/10">
                + {activeSurveys.length - 8} more
              </button>
            )}
          </div>
        </motion.section>
      )}

      {/* ── Metric tiles ───────────────────────────────────────────────── */}
      <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* NPS */}
        <motion.div custom={2} variants={fadeUp} initial="hidden" animate="visible">
          <GlassCard className="p-6">
            <div className="flex items-center justify-between mb-3">
              <span className="text-[10px] font-black uppercase tracking-widest text-on-surface-variant">
                {isAll ? 'Portfolio NPS' : 'NPS'}
              </span>
              <span className="text-[10px] font-bold text-green-600 flex items-center gap-1">
                <Icon name="trending_up" size={14} /> +2 / 7d
              </span>
            </div>
            <div className="flex items-baseline gap-2 mb-2">
              <span className="text-5xl font-black font-headline">{isAll ? 51 : nps}</span>
              <span className="text-on-surface-variant text-sm font-medium">
                ±{isAll ? 3 : 5} · n={isAll ? totalResponses.toLocaleString() : '312'}
              </span>
            </div>
            <CIBar position={46} width={120} />
            <svg viewBox="0 0 200 40" className="w-full h-10 mt-3">
              <path
                d="M0,30 L20,25 L40,28 L60,18 L80,22 L100,15 L120,20 L140,12 L160,18 L180,22 L200,15"
                stroke="var(--color-primary)" strokeWidth="2" fill="none" strokeLinecap="round"
              />
            </svg>
          </GlassCard>
        </motion.div>

        {/* CSAT */}
        <motion.div custom={3} variants={fadeUp} initial="hidden" animate="visible">
          <GlassCard className="p-6">
            <div className="flex items-center justify-between mb-3">
              <span className="text-[10px] font-black uppercase tracking-widest text-on-surface-variant">CSAT</span>
              <span className="text-[10px] font-bold text-on-surface-variant">stable</span>
            </div>
            <div className="flex items-baseline gap-2 mb-2">
              <span className="text-5xl font-black font-headline">4.2</span>
              <span className="text-on-surface-variant text-sm font-medium">/ 5 · ±0.2</span>
            </div>
            <CIBar position={84} width={120} />
            <div className="flex items-end gap-1.5 h-10 mt-3">
              {[25, 38, 55, 78, 92].map((h, i) => (
                <div
                  key={i}
                  className="flex-1 rounded-t-sm"
                  style={{
                    height: `${h}%`,
                    background:
                      i === 4
                        ? 'linear-gradient(to top, var(--color-secondary), var(--color-primary))'
                        : `color-mix(in srgb, var(--color-secondary) ${(0.3 + i * 0.15) * 100}%, transparent)`,
                  }}
                />
              ))}
            </div>
          </GlassCard>
        </motion.div>

        {/* Top action — holographic gradient */}
        <motion.div custom={4} variants={fadeUp} initial="hidden" animate="visible">
          <div
            className="rounded-2xl p-6 holographic text-white relative overflow-hidden"
            style={{ background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))' }}
          >
            <div className="flex items-center justify-between mb-3 relative z-10">
              <span className="text-[10px] font-black uppercase tracking-widest opacity-90">
                Top action · Prescriptive
              </span>
              <span className="px-2 py-0.5 rounded-full bg-white/20 text-[10px] font-bold">CONF 89</span>
            </div>
            <h3 className="text-xl font-black font-headline leading-tight mb-2 relative z-10">
              Fix "email verification loop"
            </h3>
            <p className="text-sm font-medium opacity-90 mb-3 relative z-10">
              Projected to raise NPS <strong>+3.2 ±1.8</strong>. Cited by 18 respondents.
            </p>
            <div className="flex items-center gap-2 relative z-10">
              <Button size="sm" className="bg-white text-primary hover:bg-white/90 text-xs font-bold">
                <Icon name="flag" size={14} /> Create ticket
              </Button>
              <Button size="sm" variant="ghost" className="bg-white/10 text-white hover:bg-white/20 text-xs font-bold">
                <Icon name="format_quote" size={14} /> 24 quotes
              </Button>
            </div>
          </div>
        </motion.div>
      </section>

      {/* ── Deeper findings (bento) ────────────────────────────────────── */}
      <section className="space-y-4">
        <div className="flex items-end justify-between">
          <h2 className="text-2xl font-black font-headline tracking-tight">Deeper findings</h2>
          <div className="flex items-center gap-1 text-xs">
            <button className="px-2.5 py-1 rounded-full bg-primary/10 text-primary font-bold">All</button>
            <button className="px-2.5 py-1 rounded-full text-on-surface-variant hover:bg-muted">Drivers</button>
            <button className="px-2.5 py-1 rounded-full text-on-surface-variant hover:bg-muted">Voice</button>
            <button className="px-2.5 py-1 rounded-full text-on-surface-variant hover:bg-muted">Anomalies</button>
            <button className="px-2.5 py-1 rounded-full text-on-surface-variant hover:bg-muted">Predictive</button>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          {/* Driver card (wide) */}
          <motion.div custom={0} variants={fadeUp} initial="hidden" whileInView="visible" viewport={{ once: true }} className="lg:col-span-7">
            <GlassCard className="p-6">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3 flex-wrap">
                  <LayerBadge layer="diagnostic" icon="local_fire_department" />
                  {isAll && leadSurvey && (
                    <span className="px-2 py-0.5 rounded-full bg-primary/10 text-primary text-[10px] font-bold flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                      {leadSurvey.title}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 text-[10px] font-bold">
                  <ConfidenceChip value={89} />
                  <span className="text-on-surface-variant">n=189</span>
                </div>
              </div>
              <h3 className="text-xl font-black font-headline leading-tight mb-3">
                {isAll
                  ? 'Cross-survey: "pricing transparency" recurs in 4 of 7 surveys'
                  : '"Support response time" is the #1 driver of NPS'}
              </h3>
              <p className="text-sm leading-relaxed mb-4">
                Its importance jumped from <strong>4th to 1st</strong> position in the last 30 days
                <CitationChip id="r983" /><CitationChip id="r1234" /><CitationChip id="r1492" />.
                Detractors mention support delay in 47% of cases.
              </p>

              {/* driver bars */}
              <div className="space-y-2 mb-4">
                {[
                  { label: 'Support response time', impact: 0.31, w: 78, primary: true },
                  { label: 'Onboarding speed', impact: 0.22, w: 55 },
                  { label: 'Pricing transparency', impact: 0.15, w: 38 },
                  { label: 'Mobile reliability', impact: 0.10, w: 24 },
                ].map((d) => (
                  <div key={d.label} className="flex items-center gap-3">
                    <span className={`text-xs font-bold w-44 truncate ${d.primary ? '' : 'text-on-surface-variant'}`}>
                      {d.label}
                    </span>
                    <div className="flex-1 h-3 rounded-full bg-muted relative">
                      <div
                        className="absolute inset-y-0 left-0 rounded-full"
                        style={{
                          width: `${d.w}%`,
                          background: d.primary
                            ? 'linear-gradient(to right, var(--color-primary), var(--color-tertiary))'
                            : `color-mix(in srgb, var(--color-primary) ${(0.3 + d.w * 0.005) * 100}%, transparent)`,
                        }}
                      />
                      <div
                        className={`absolute right-2 top-1/2 -translate-y-1/2 text-[9px] font-black ${d.primary ? 'text-white' : ''}`}
                      >
                        {d.impact.toFixed(2)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <div className="flex items-center gap-2 pt-4 border-t border-outline-variant/20">
                <Button size="sm" className="text-xs">
                  <Icon name="format_quote" size={14} /> 8 quotes
                </Button>
                <Button size="sm" variant="outline" className="text-xs">
                  <Icon name="help" size={14} /> Why this insight?
                </Button>
                <div className="flex-1" />
                <Button size="icon" variant="ghost" className="w-8 h-8">
                  <Icon name="thumb_up" size={16} />
                </Button>
                <Button size="icon" variant="ghost" className="w-8 h-8">
                  <Icon name="push_pin" size={16} />
                </Button>
              </div>
            </GlassCard>
          </motion.div>

          {/* Anomaly card */}
          <motion.div custom={1} variants={fadeUp} initial="hidden" whileInView="visible" viewport={{ once: true }} className="lg:col-span-5">
            <GlassCard className="p-6" style={{ borderLeft: '4px solid #d97706' }}>
              <div className="flex items-center justify-between mb-4">
                <LayerBadge layer="predictive" icon="warning" />
                <ConfidenceChip value={92} />
              </div>
              <h3 className="text-lg font-black font-headline leading-tight mb-3">
                NPS dropped 12 points on May 10
              </h3>
              <p className="text-sm leading-relaxed mb-4">
                Outside the 95% prediction interval. Likely linked to a spike of "login error" mentions in same 24h window
                <CitationChip id="r2104" /><CitationChip id="r2111" /><CitationChip id="r2114" />.
              </p>

              <div className="rounded-xl p-3 mb-4" style={{ background: 'rgba(245,247,249,0.7)' }}>
                <div className="flex items-end justify-between gap-1 h-16">
                  {[62, 65, 58, 25, 35, 54, 60].map((h, i) => (
                    <div
                      key={i}
                      className="flex-1 rounded-t"
                      style={{
                        height: `${h}%`,
                        background: i === 3 ? '#d97706' : i === 4 ? 'rgba(217,119,6,0.6)' : 'color-mix(in srgb, var(--color-primary) 60%, transparent)',
                      }}
                    />
                  ))}
                </div>
                <div className="flex items-center justify-between mt-1 text-[9px] text-on-surface-variant">
                  <span>May 7</span><span>May 10</span><span>May 13</span>
                </div>
              </div>

              <Button size="sm" variant="outline" className="w-full text-xs">
                <Icon name="timeline" size={14} /> See the 14 responses
              </Button>
            </GlassCard>
          </motion.div>

          {/* Voice topic */}
          <motion.div custom={2} variants={fadeUp} initial="hidden" whileInView="visible" viewport={{ once: true }} className="lg:col-span-5">
            <GlassCard className="p-6">
              <div className="flex items-center justify-between mb-4">
                <LayerBadge layer="diagnostic" icon="forum" />
                <ConfidenceChip value={76} />
              </div>
              <h3 className="text-lg font-black font-headline leading-tight mb-3">
                "Onboarding friction" is the largest topic cluster
              </h3>
              <div className="space-y-2 mb-3 text-xs">
                {[
                  { name: 'Email verification loop', count: 24, neg: 92 },
                  { name: 'Password reset confusion', count: 18, neg: 78 },
                  { name: 'Profile setup steps', count: 12, neg: 52 },
                ].map((t) => (
                  <div key={t.name} className="flex items-center gap-2">
                    <div className="flex-1 flex items-center gap-2">
                      <span className="font-bold">{t.name}</span>
                      <span className="text-on-surface-variant">{t.count}</span>
                    </div>
                    <span
                      className={
                        'px-1.5 py-0.5 rounded text-[9px] font-bold ' +
                        (t.neg >= 75 ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700')
                      }
                    >
                      {t.neg}% NEG
                    </span>
                  </div>
                ))}
              </div>
              <div className="rounded-xl p-3 mb-3" style={{ background: 'rgba(245,247,249,0.7)' }}>
                <p className="text-xs italic">"I spent 15 minutes in the verification loop, then gave up."</p>
                <p className="text-[10px] text-on-surface-variant mt-1">— r1188 · NPS 2 · frustration</p>
              </div>
              <Button size="sm" variant="outline" className="w-full text-xs text-secondary">
                Explore all 102 quotes →
              </Button>
            </GlassCard>
          </motion.div>

          {/* Predictive */}
          <motion.div custom={3} variants={fadeUp} initial="hidden" whileInView="visible" viewport={{ once: true }} className="lg:col-span-7">
            <GlassCard className="p-6">
              <div className="flex items-center justify-between mb-4">
                <LayerBadge layer="predictive" icon="insights" />
                <ConfidenceChip value={81} />
              </div>
              <h3 className="text-lg font-black font-headline leading-tight mb-3">
                Projected NPS at 500 responses: <span className="text-primary">51 ±4</span> by Friday
              </h3>
              <p className="text-sm leading-relaxed mb-4">
                Based on response velocity and current sentiment trend, NPS is forecast to rise into the mid-50s as Promoters disproportionately complete the survey in late waves
                <CitationChip id="r2401" /><CitationChip id="r2415" />.
              </p>
              <svg viewBox="0 0 600 100" className="w-full">
                <defs>
                  <linearGradient id="forecastFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stopColor="var(--color-primary-container)" />
                    <stop offset="1" stopColor="var(--color-primary-container)" stopOpacity="0" />
                  </linearGradient>
                </defs>
                <path d="M0,75 L60,60 L120,65 L180,50 L240,55 L300,45 L360,42" stroke="var(--color-primary)" strokeWidth="2.5" fill="none" />
                <path
                  d="M360,42 L420,38 L480,32 L540,28 L600,26 L600,46 L540,50 L480,54 L420,58 L360,42 Z"
                  fill="url(#forecastFill)" opacity="0.6"
                />
                <path d="M360,42 L420,38 L480,32 L540,28 L600,26" stroke="var(--color-tertiary)" strokeWidth="2.5" strokeDasharray="4 4" fill="none" />
                <line x1="360" y1="0" x2="360" y2="100" stroke="#abadaf" strokeDasharray="2 4" />
                <text x="368" y="14" fontSize="9" fill="#595c5e" fontWeight="700">NOW</text>
              </svg>
              <div className="flex items-center justify-between mt-2 text-[10px] text-on-surface-variant font-bold">
                <span>312 resp</span><span>350</span><span>400</span><span>450</span><span>500 (Fri)</span>
              </div>
            </GlassCard>
          </motion.div>
        </div>

        {/* Ask Crystal bar */}
        <motion.div custom={4} variants={fadeUp} initial="hidden" whileInView="visible" viewport={{ once: true }}>
          <GlassCard className="p-5 holographic">
            <div className="flex items-center gap-3 relative z-10">
              <div
                className="w-10 h-10 rounded-xl flex items-center justify-center"
                style={{ background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))' }}
              >
                <Icon name="auto_awesome" size={22} style={{ color: 'white' }} />
              </div>
              <div className="flex-1">
                <div className="text-[10px] font-black uppercase tracking-widest text-tertiary mb-0.5">⌘K · Ask Crystal</div>
                <div className="font-bold text-on-surface-variant text-sm">
                  Ask anything — <span className="italic">"Why did NPS dip on May 10?"</span> ·{' '}
                  <span className="italic">"What would raise CSAT most?"</span>
                </div>
              </div>
              <kbd className="px-2 py-1 rounded bg-white/80 border border-outline-variant/30 text-xs font-bold">⌘K</kbd>
            </div>
          </GlassCard>
        </motion.div>
      </section>

      <footer className="text-center text-xs text-on-surface-variant pt-4">
        <LiveDot /> <span className="font-bold ml-1">Live</span> · 3 insights in last 60s · Last full scan 2m ago
      </footer>
    </div>
  );
}
