// Spatial Canvas — the cinematic 3D variant.
//
// Redesign: HeroCanvas (Three.js) is the actual star, full-bleed.
// Content is stripped to: one focal stat, one hero action, four supporting cards.
// No "constellation" framing; no extra chrome over the 3D. The 3D scene IS the
// page — content floats on top with minimal glass.

import { Suspense, lazy } from 'react';
import { motion } from 'framer-motion';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Icon } from '../../components/Icon';
import type { Insight, Survey } from '../../types';
import type { SurveyScope } from '../../components/SurveyScopePicker';
import { CitationChip } from './shared';

// Lazy: ~150KB of Three.js code only ships when this tab is open.
const HeroCanvas = lazy(() =>
  import('../../components/three/HeroCanvas').then((m) => ({ default: m.HeroCanvas }))
);

const fade = {
  hidden: { opacity: 0, y: 12 },
  visible: (i = 0) => ({
    opacity: 1,
    y: 0,
    transition: { duration: 0.8, delay: i * 0.1, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] },
  }),
};

// ── Glass surface (light text over dark canvas) ──────────────────────────
function Glass({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`relative rounded-2xl ${className}`}
      style={{
        background: 'rgba(20, 22, 50, 0.45)',
        backdropFilter: 'blur(20px) saturate(160%)',
        WebkitBackdropFilter: 'blur(20px) saturate(160%)',
        border: '1px solid rgba(255,255,255,0.10)',
      }}
    >
      {children}
    </div>
  );
}

interface ViewProps {
  insights: Insight | null;
  scope: SurveyScope;
  surveys: Survey[];
}

export function SpatialView({ insights, scope, surveys }: ViewProps) {
  const isAll = scope === 'all';
  const nps = insights?.nps_score ?? 47;
  const activeSurveys = surveys.filter((s) => s.status === 'active' && !s.deleted_at);
  const totalResponses = surveys.reduce((sum, s) => sum + (s.response_count ?? 0), 0);

  const displayNps = isAll ? 51 : nps;
  const displayCi = isAll ? 3 : 5;
  const displayN = isAll ? totalResponses : 312;

  const prefersReducedMotion =
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  return (
    <div className="relative -mx-6 md:-mx-8 -mt-4 overflow-hidden rounded-3xl min-h-[700px]">
      {/* ── 3D background ──────────────────────────────────────────── */}
      <div
        className="absolute inset-0 z-0"
        style={{
          background:
            'radial-gradient(circle at 20% 20%, color-mix(in srgb, var(--color-primary) 40%, transparent), transparent 55%),' +
            'radial-gradient(circle at 80% 30%, color-mix(in srgb, var(--color-tertiary) 30%, transparent), transparent 55%),' +
            'radial-gradient(circle at 60% 90%, color-mix(in srgb, var(--color-secondary) 30%, transparent), transparent 60%),' +
            'linear-gradient(180deg, #07091F 0%, #0F0822 50%, #050B1A 100%)',
        }}
      >
        {!prefersReducedMotion && (
          <Suspense fallback={null}>
            <div className="absolute inset-0">
              <HeroCanvas />
            </div>
          </Suspense>
        )}
        {/* Soft top vignette so the page header sits cleanly */}
        <div
          className="absolute inset-x-0 top-0 h-32 pointer-events-none"
          style={{ background: 'linear-gradient(to bottom, rgba(7,9,31,0.5), transparent)' }}
        />
      </div>

      {/* ── Content layer ─────────────────────────────────────────── */}
      <div className="relative z-10 px-8 md:px-16 py-20 md:py-28 text-white">
        {/* Focal hero — single big number, single big action */}
        <motion.div
          custom={0}
          variants={fade}
          initial="hidden"
          animate="visible"
          className="max-w-3xl mx-auto text-center mb-16"
        >
          <Badge
            variant="secondary"
            className="bg-white/10 text-white/80 backdrop-blur border-white/10 mb-6 font-semibold tracking-wide"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 mr-2 animate-pulse" />
            {isAll ? `${activeSurveys.length} surveys live` : 'Live'} · {totalResponses.toLocaleString() || displayN} responses
          </Badge>

          <div className="text-[11px] font-bold uppercase tracking-[0.25em] text-cyan-200/80 mb-3">
            {isAll ? 'Portfolio NPS' : 'Net Promoter Score'}
          </div>

          <div
            className="font-headline font-black leading-none mb-3"
            style={{
              fontSize: 'clamp(96px, 14vw, 192px)',
              backgroundImage: 'linear-gradient(135deg, #ffffff 0%, #c4ccff 40%, var(--color-tertiary-container) 100%)',
              backgroundClip: 'text',
              WebkitBackgroundClip: 'text',
              color: 'transparent',
              letterSpacing: '-0.05em',
            }}
          >
            {displayNps}
          </div>

          <div className="text-white/70 text-sm font-medium">
            ±{displayCi} · 90% CI · n={displayN.toLocaleString()}
          </div>
        </motion.div>

        {/* Hero action card */}
        <motion.div
          custom={1}
          variants={fade}
          initial="hidden"
          animate="visible"
          className="max-w-2xl mx-auto mb-16"
        >
          <Card
            className="border-0 overflow-hidden relative shadow-2xl"
            style={{ background: 'linear-gradient(135deg, var(--color-primary) 0%, #6b3bb8 50%, var(--color-tertiary) 100%)' }}
          >
            <div className="absolute inset-0 holographic opacity-60 pointer-events-none" />
            <CardContent className="p-8 md:p-10 relative z-10 text-white">
              <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.2em] text-white/80 mb-4">
                <Icon name="auto_awesome" size={14} />
                Top action · {isAll ? 'portfolio' : 'this survey'}
              </div>
              <h3 className="font-headline text-2xl md:text-3xl font-black leading-tight mb-3">
                Fix the email verification loop
              </h3>
              <p className="text-white/85 text-sm md:text-base leading-relaxed mb-6 max-w-xl">
                Projected to raise NPS by <strong>+3.2 ±1.8</strong>. Cited by 18 respondents
                <CitationChip id="r1188" dark /><CitationChip id="r1234" dark /><CitationChip id="r1492" dark />.
              </p>
              <div className="flex items-center gap-2 flex-wrap">
                <Button className="bg-white text-primary hover:bg-white/90 font-bold shadow-lg">
                  <Icon name="flag" size={16} />
                  Create ticket
                </Button>
                <Button
                  variant="ghost"
                  className="text-white hover:bg-white/15 backdrop-blur"
                >
                  <Icon name="format_quote" size={16} />
                  18 quotes
                </Button>
                <div className="flex-1" />
                <span className="text-[11px] font-mono text-white/60">
                  Confidence 89 · uplift estimate
                </span>
              </div>
            </CardContent>
          </Card>
        </motion.div>

        {/* Supporting cards: 2×2 minimal grid */}
        <motion.div
          custom={2}
          variants={fade}
          initial="hidden"
          animate="visible"
          className="max-w-4xl mx-auto"
        >
          <div className="text-center mb-6">
            <div className="text-[10px] font-bold uppercase tracking-[0.25em] text-white/40">
              Supporting findings
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <SupportCard
              icon="local_fire_department"
              iconColor="var(--color-tertiary-container)"
              category="Driver"
              confidence={89}
              headline={
                isAll
                  ? '"Pricing transparency" recurs in 4 of 7 surveys'
                  : '"Support response time" is the #1 driver'
              }
              detail="Moved from 4th to 1st in 30 days · 8 quotes"
            />
            <SupportCard
              icon="warning"
              iconColor="#fbbf24"
              category="Anomaly"
              confidence={92}
              headline="NPS dropped 12 points on May 10"
              detail="Outside 95% PI · likely login-error correlation · 14 quotes"
            />
            <SupportCard
              icon="forum"
              iconColor="var(--color-secondary-container)"
              category="Voice"
              confidence={76}
              headline="Onboarding friction · 102 mentions"
              detail='"I spent 15 minutes verifying my email"'
            />
            <SupportCard
              icon="insights"
              iconColor="#a5f3fc"
              category="Forecast"
              confidence={81}
              headline={isAll ? 'Portfolio NPS to 54 by month-end' : 'NPS at 500 responses: 51 ±4 by Friday'}
              detail="Prophet · 1,000-bootstrap CI"
            />
          </div>
        </motion.div>

        {/* Ask anything — subtle bottom dock */}
        <motion.div
          custom={3}
          variants={fade}
          initial="hidden"
          animate="visible"
          className="max-w-2xl mx-auto mt-16"
        >
          <Glass className="px-5 py-4 flex items-center gap-3">
            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
              style={{ background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))' }}
            >
              <Icon name="auto_awesome" size={20} style={{ color: 'white' }} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[10px] font-bold uppercase tracking-widest text-cyan-200/80">
                Ask Crystal
              </div>
              <div className="text-sm text-white/70 truncate">
                {isAll ? 'Which survey has the highest churn risk?' : 'Why did NPS dip on May 10?'}
              </div>
            </div>
            <kbd className="px-2 py-1 rounded bg-white/10 text-white/80 text-[10px] font-mono">
              ⌘K
            </kbd>
          </Glass>
        </motion.div>
      </div>
    </div>
  );
}

// ── Supporting card (over the canvas) ────────────────────────────────────
function SupportCard({
  icon, iconColor, category, confidence, headline, detail,
}: {
  icon: string;
  iconColor: string;
  category: string;
  confidence: number;
  headline: string;
  detail: string;
}) {
  return (
    <Glass className="p-5 hover:bg-white/[0.07] transition-colors cursor-pointer group">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Icon name={icon} size={16} style={{ color: iconColor }} />
          <span
            className="text-[10px] font-bold uppercase tracking-widest"
            style={{ color: iconColor }}
          >
            {category}
          </span>
        </div>
        <span className="text-[10px] font-mono text-white/50">conf {confidence}</span>
      </div>
      <h4 className="font-headline font-bold text-base leading-snug mb-1.5 text-white">
        {headline}
      </h4>
      <p className="text-xs text-white/60 leading-relaxed">{detail}</p>
      <div className="mt-3 flex items-center text-[11px] font-semibold text-white/70 group-hover:text-white transition-colors">
        Explore
        <Icon name="arrow_forward" size={14} className="ml-1" />
      </div>
    </Glass>
  );
}
