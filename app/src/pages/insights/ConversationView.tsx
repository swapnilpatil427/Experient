// Conversation Studio — chat-first variant.
// One 3D crystal centerpiece (CSS layered for now), conversation history,
// auto-surfaced findings feed below.
// TODO: replace CSS crystal with real Three.js icosahedron component for parity with HeroCanvas.
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
} from './shared';

const fadeUp = {
  hidden: { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.5, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] } },
};

interface ViewProps {
  insights: Insight | null;
  scope: SurveyScope;
  surveys: Survey[];
}

export function ConversationView({ insights: _insights, scope, surveys }: ViewProps) {
  const isAll = scope === 'all';
  const activeCount = surveys.filter((s) => s.status === 'active' && !s.deleted_at).length;

  return (
    <div className="max-w-3xl mx-auto pb-32">
      {/* ── Crystal centerpiece ─────────────────────────────────────── */}
      <div className="text-center mb-6">
        <Crystal />
        <div className="text-[10px] font-black uppercase tracking-[0.3em] text-tertiary mt-4 mb-2">
          Crystal · Experient Copilot
        </div>
        <h1 className="text-3xl font-black font-headline tracking-tight">
          {isAll ? 'Ask anything across your surveys' : 'Ask anything about this survey'}
        </h1>
        <p className="text-on-surface-variant mt-2 text-sm">
          {isAll
            ? `Querying ${activeCount} active surveys · every answer cites the surveys and quotes it draws from.`
            : 'Every answer cites real customer quotes. Numbers come from analytics tools, not the LLM.'}
        </p>
      </div>

      {/* ── Input bar ────────────────────────────────────────────────── */}
      <GlassCard className="p-2 mb-8 flex items-center gap-2">
        <Button variant="ghost" size="icon" className="w-10 h-10 rounded-xl">
          <Icon name="mic" size={20} />
        </Button>
        <input
          type="text"
          placeholder='Type a question — "why did NPS dip?" or "which segment is at risk?"'
          className="flex-1 px-3 py-2.5 bg-transparent focus:outline-none text-on-surface placeholder:text-on-surface-variant/70"
        />
        <Button variant="gradient" size="sm" className="text-xs">
          <Icon name="arrow_upward" size={16} /> Ask
        </Button>
      </GlassCard>

      {/* ── Suggested prompts ────────────────────────────────────────── */}
      <div className="flex flex-wrap gap-2 mb-10">
        {isAll ? (
          <>
            <SuggestionChip icon="compare" iconColor="var(--color-primary)" label="Which survey has the highest churn risk?" />
            <SuggestionChip icon="trending_up" iconColor="#059669" label="Show me themes appearing in 3+ surveys" />
            <SuggestionChip icon="balance" iconColor="#b41340" label="Are my surveys over-sampling one segment?" />
            <SuggestionChip icon="lightbulb" iconColor="var(--color-tertiary)" label="Which action moves portfolio NPS the most?" />
          </>
        ) : (
          <>
            <SuggestionChip icon="trending_down" iconColor="var(--color-tertiary)" label="Why did NPS drop on May 10?" />
            <SuggestionChip icon="warning" iconColor="#d97706" label="Which segment is at highest churn risk?" />
            <SuggestionChip icon="lightbulb" iconColor="#059669" label="What action would raise CSAT most?" />
            <SuggestionChip icon="compare" iconColor="var(--color-primary)" label="Compare this to last quarter" />
          </>
        )}
      </div>

      {/* ── Conversation ────────────────────────────────────────────── */}
      <section className="space-y-6">
        <div className="text-[10px] font-black uppercase tracking-widest text-on-surface-variant text-center">
          — CONVERSATION —
        </div>

        {/* User bubble */}
        <motion.div variants={fadeUp} initial="hidden" animate="visible" className="flex justify-end">
          <div
            className="rounded-2xl rounded-br-sm px-5 py-3 max-w-[80%] text-white"
            style={{ background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))' }}
          >
            <div className="text-[10px] font-bold uppercase tracking-widest opacity-80 mb-0.5">You · 2 min ago</div>
            <div className="text-sm font-medium">Why did NPS drop on May 10?</div>
          </div>
        </motion.div>

        {/* AI answer */}
        <motion.div variants={fadeUp} initial="hidden" animate="visible" className="flex gap-3">
          <div
            className="w-9 h-9 rounded-full flex-shrink-0 flex items-center justify-center"
            style={{ background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))' }}
          >
            <Icon name="diamond" size={18} style={{ color: 'white' }} />
          </div>
          <GlassCard className="rounded-2xl rounded-bl-sm px-5 py-4 max-w-[85%]">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-[10px] font-bold uppercase tracking-widest text-tertiary">
                Crystal · Experient Copilot · just now
              </span>
              <ConfidenceChip value={84} />
            </div>

            <p className="text-sm leading-relaxed mb-3">
              NPS dropped <strong>12 points (47 → 35)</strong> on May 10, outside the 95% prediction interval{' '}
              <strong className="font-mono">[42–52]</strong>
              <CitationChip id="r2104" /><CitationChip id="r2107" />.
            </p>
            <p className="text-sm leading-relaxed mb-3">Two signals correlate:</p>
            <ul className="text-sm leading-relaxed space-y-1.5 mb-3 pl-4">
              <li>
                • A spike of <strong>14 responses</strong> mentioning "login error" in the same 24h window
                <CitationChip id="r2104" /><CitationChip id="r2111" /><CitationChip id="r2114" />
              </li>
              <li>
                • Average response sentiment dropped from <strong>+0.12 to −0.41</strong> (effect size large; p&lt;0.01)
              </li>
            </ul>
            <p className="text-sm leading-relaxed mb-4">
              Likely root cause: the <strong>2026-05-10 14:12 UTC login outage</strong>{' '}
              (cross-referenced with your incident log).
            </p>

            {/* Inline chart */}
            <div className="rounded-xl p-3 mb-4 bg-muted">
              <div className="text-[10px] font-bold text-on-surface-variant mb-2 uppercase tracking-widest">
                NPS · May 7 to May 14
              </div>
              <div className="flex items-end justify-between gap-1.5 h-16">
                {[62, 65, 58, 25, 35, 54, 60].map((h, i) => (
                  <div key={i} className="flex-1 relative">
                    <div
                      className="w-full rounded-t"
                      style={{
                        height: `${h}%`,
                        background: i === 3 ? '#d97706' : i === 4 ? 'rgba(217,119,6,0.6)' : 'color-mix(in srgb, var(--color-primary) 60%, transparent)',
                      }}
                    />
                    {i === 3 && (
                      <span className="absolute -top-5 left-1/2 -translate-x-1/2 text-[9px] font-black text-amber-600">
                        35
                      </span>
                    )}
                  </div>
                ))}
              </div>
              <div className="flex items-center justify-between mt-1 text-[9px] text-on-surface-variant font-bold">
                <span>May 7</span><span>10</span><span>14</span>
              </div>
            </div>

            <div className="text-[11px] text-on-surface-variant bg-muted/60 rounded-lg px-3 py-2 mb-4">
              <span className="font-bold">Method:</span> Bayesian online changepoint detection (run-length posterior) +
              topic correlation against simultaneous responses. Verifier model: claude-haiku-4.5 → supported.
            </div>

            <div className="flex flex-wrap items-center gap-2 pt-3 border-t border-outline-variant/30">
              <Button size="sm" className="text-xs">
                <Icon name="format_quote" size={14} /> Show the 14 quotes
              </Button>
              <Button size="sm" variant="outline" className="text-xs">
                <Icon name="push_pin" size={14} /> Pin this answer
              </Button>
              <Button size="sm" variant="outline" className="text-xs">
                <Icon name="flag" size={14} /> Create ticket
              </Button>
              <Button size="sm" variant="outline" className="text-xs">
                <Icon name="ios_share" size={14} /> Slack
              </Button>
              <div className="flex-1" />
              <Button size="icon" variant="ghost" className="w-7 h-7">
                <Icon name="thumb_up" size={14} />
              </Button>
              <Button size="icon" variant="ghost" className="w-7 h-7">
                <Icon name="thumb_down" size={14} />
              </Button>
            </div>
          </GlassCard>
        </motion.div>

        {/* Follow-up suggestions */}
        <div className="flex justify-end items-center gap-2 flex-wrap">
          <span className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">Follow up</span>
          <SuggestionChip label="Did the outage affect Enterprise customers more?" />
          <SuggestionChip label="How long did recovery take?" />
        </div>
      </section>

      {/* ── Auto-surfaced today ──────────────────────────────────────── */}
      <section className="mt-16">
        <div className="flex items-center gap-3 mb-5">
          <div className="h-px flex-1 bg-outline-variant/30" />
          <span className="text-[10px] font-black uppercase tracking-widest text-on-surface-variant">
            Auto-surfaced today
          </span>
          <div className="h-px flex-1 bg-outline-variant/30" />
        </div>

        <div className="space-y-3">
          <AutoFinding
            icon="lightbulb"
            iconColor="var(--color-tertiary)"
            tag="DRIVER · 2h AGO"
            tagColor="text-tertiary"
            confidence={89}
            title='"Email verification loop" is now the top driver of detractor sentiment'
            sub="+3.2 NPS projected if fixed · 18 cited quotes · n=189"
          />
          <AutoFinding
            icon="trending_up"
            iconColor="#059669"
            tag="TREND · 4h AGO"
            tagColor="text-green-700"
            confidence={91}
            title="Response velocity 2.3× normal — likely the email campaign you launched yesterday"
            sub="Sustained for 36h · 142 new responses · sentiment baseline +0.18 vs +0.05 avg"
          />
          <AutoFinding
            icon="balance"
            iconColor="#b41340"
            tag="META · BIAS WARNING · 6h AGO"
            tagColor="text-red-700"
            title="73% of responses are from Enterprise tier — aggregate NPS may overstate SMB"
            sub="Recommend stratified view or post-stratification weighting · see bias panel"
            borderLeft="#b41340"
          />
          <AutoFinding
            icon="insights"
            iconColor="var(--color-primary)"
            tag="PREDICT · 8h AGO"
            tagColor="text-primary"
            confidence={81}
            title="Projected NPS at 500 responses: 51 ±4 by Friday"
            sub="Prophet + 1000-bootstrap CI · Promoters disproportionately complete in late waves"
          />
        </div>
      </section>

      {/* ── Floating credit status ───────────────────────────────────── */}
      <GlassCard className="fixed bottom-6 right-6 z-30 px-4 py-3 text-xs">
        <div className="flex items-center gap-3">
          <Icon name="bolt" size={18} style={{ color: '#059669' }} />
          <div>
            <div className="font-bold">142 / 10,000 credits today</div>
            <div className="text-on-surface-variant">~$0.029 spent · ~$0.0002/insight</div>
          </div>
        </div>
      </GlassCard>
    </div>
  );
}

// ── Crystal centerpiece ─────────────────────────────────────────────────
function Crystal() {
  // Three layered conic gradients clipped to hexagons — stand-in for an icosahedron.
  // Real Three.js version is a follow-up.
  return (
    <div
      className="relative mx-auto"
      style={{
        width: 220,
        height: 220,
        filter: 'drop-shadow(0 20px 50px color-mix(in srgb, var(--color-primary) 25%, transparent))',
      }}
    >
      <div
        className="absolute inset-0"
        style={{
          background:
            'conic-gradient(from 0deg at 50% 50%, var(--color-primary-container) 0%, var(--color-tertiary-container) 25%, var(--color-secondary-container) 50%, var(--color-tertiary-container) 75%, var(--color-primary-container) 100%)',
          clipPath: 'polygon(50% 0%, 100% 30%, 100% 70%, 50% 100%, 0% 70%, 0% 30%)',
          animation: 'spin-crystal 24s linear infinite',
          filter: 'blur(0.5px)',
        }}
      />
      <div
        className="absolute"
        style={{
          inset: '22%',
          background:
            'conic-gradient(from 180deg at 50% 50%, #ffffff 0%, var(--color-primary-container) 33%, var(--color-tertiary-container) 66%, #ffffff 100%)',
          clipPath: 'polygon(50% 0%, 100% 30%, 100% 70%, 50% 100%, 0% 70%, 0% 30%)',
          animation: 'spin-crystal 12s linear infinite reverse',
          opacity: 0.7,
        }}
      />
      <div
        className="absolute"
        style={{
          inset: '40%',
          background: 'radial-gradient(circle, #ffffff, var(--color-secondary-container))',
          borderRadius: '50%',
          filter: 'blur(6px)',
          animation: 'pulse-glow 2.5s ease-in-out infinite',
        }}
      />
      {/* Local keyframes for crystal spin (added via style tag — page-scoped) */}
      <style>{`
        @keyframes spin-crystal { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}

// ── Small helpers ──────────────────────────────────────────────────────
function SuggestionChip({ icon, iconColor, label }: { icon?: string; iconColor?: string; label: string }) {
  return (
    <button
      className={
        'px-3 py-1.5 rounded-full text-xs font-bold flex items-center gap-1.5 ' +
        (icon ? 'bg-muted hover:bg-muted/80' : 'bg-tertiary/10 text-tertiary hover:bg-tertiary/20')
      }
    >
      {icon && <Icon name={icon} size={14} style={{ color: iconColor }} />}
      {label}
    </button>
  );
}

function AutoFinding({
  icon, iconColor, tag, tagColor, confidence, title, sub, borderLeft,
}: {
  icon: string;
  iconColor: string;
  tag: string;
  tagColor: string;
  confidence?: number;
  title: string;
  sub: string;
  borderLeft?: string;
}) {
  return (
    <GlassCard
      className="p-5 flex items-start gap-4 hover:scale-[1.01] transition cursor-pointer"
      style={borderLeft ? { borderLeft: `4px solid ${borderLeft}` } : undefined}
    >
      <Icon name={icon} size={22} style={{ color: iconColor, marginTop: 4 }} />
      <div className="flex-1">
        <div className="flex items-center gap-2 mb-1 flex-wrap">
          <span className={`text-[10px] font-black uppercase tracking-widest ${tagColor}`}>{tag}</span>
          {confidence !== undefined && <ConfidenceChip value={confidence} />}
        </div>
        <div className="font-bold text-sm mb-1">{title}</div>
        <p className="text-xs text-on-surface-variant">{sub}</p>
      </div>
      <Icon name="arrow_forward" size={18} className="text-on-surface-variant self-center" />
    </GlassCard>
  );
}
