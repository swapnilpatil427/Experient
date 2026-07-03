// Mission Cockpit — the daily monitoring variant.
//
// Redesign: focused 2-column layout (priority feed + slim right rail), all
// shadcn primitives, breathing room over density. The first version was too
// terminal-busy; this version reads like Linear, not Bloomberg.

import { Icon } from '../../components/Icon';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip';
import type { Insight, Survey } from '../../types';
import type { SurveyScope } from '../../components/SurveyScopePicker';

// ── Types & constants ───────────────────────────────────────────────────
type Layer = 'descriptive' | 'diagnostic' | 'predictive' | 'prescriptive' | 'meta';

interface FeedItem {
  layer: Layer;
  category: string;
  age: string;
  confidence?: number;
  headline: string;
  detail: string;
  cta?: string;
  isAction?: boolean;
}

const LAYER_COLOR: Record<Layer, string> = {
  descriptive: '#2a4bd9',
  diagnostic: '#8329c8',
  predictive: '#d97706',
  prescriptive: '#10b981',
  meta: '#b41340',
};

const FEED: FeedItem[] = [
  {
    layer: 'predictive',
    category: 'Anomaly',
    age: '12s',
    confidence: 92,
    headline: 'NPS dropped 12 points on May 10',
    detail: 'Outside the 95% prediction interval. Correlates with a "login error" topic spike in the same 24h window.',
  },
  {
    layer: 'diagnostic',
    category: 'Driver',
    age: '2m',
    confidence: 89,
    headline: '"Support response time" is the #1 driver of NPS',
    detail: 'Importance 0.31, moved 4th → 1st over 30 days. 8 cited responses.',
  },
  {
    layer: 'diagnostic',
    category: 'Voice',
    age: '5m',
    confidence: 76,
    headline: '"Email verification loop" — 24 mentions, 62% frustration',
    detail: 'Top friction phrase across detractors. Sample: "I spent 15 minutes in the verification loop."',
  },
  {
    layer: 'prescriptive',
    category: 'Action',
    age: '8m',
    confidence: 89,
    headline: 'Fix email verification loop → projected NPS +3.2',
    detail: '18 cited respondents. Uplift estimate with bootstrap CI [+1.4, +5.0].',
    cta: 'Create ticket',
    isAction: true,
  },
  {
    layer: 'predictive',
    category: 'Forecast',
    age: '15m',
    confidence: 81,
    headline: 'NPS at 500 responses projected at 51 ±4 by Friday',
    detail: 'Prophet model with 1,000-bootstrap CI. Response velocity trending +12% week-over-week.',
  },
  {
    layer: 'diagnostic',
    category: 'Segment',
    age: '22m',
    confidence: 87,
    headline: 'Enterprise NPS 62 · SMB 31',
    detail: '31-point gap. SMB driver shifted from "support" to "feature parity" this month.',
  },
  {
    layer: 'meta',
    category: 'Sample',
    age: '31m',
    headline: '73% of responses from Enterprise tier',
    detail: 'Aggregate NPS may overstate SMB experience. Stratified view recommended.',
  },
];

// ── Helpers ─────────────────────────────────────────────────────────────
function nFmt(n: number): string {
  if (n < 1000) return n.toString();
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

// ── Main ────────────────────────────────────────────────────────────────
interface ViewProps {
  insights: Insight | null;
  scope: SurveyScope;
  surveys: Survey[];
}

export function CockpitView({ insights, scope, surveys }: ViewProps) {
  const isAll = scope === 'all';
  const nps = insights?.nps_score ?? 47;
  const activeSurveys = surveys.filter((s) => s.status === 'active' && !s.deleted_at);
  const totalResponses = surveys.reduce((sum, s) => sum + (s.response_count ?? 0), 0);

  const displayNps = isAll ? 51 : nps;
  const displayN = isAll ? totalResponses : 312;
  const displayCi = isAll ? 3 : 5;

  // Fake survey tags for "all surveys" mode — real version reads insight.survey_id
  const surveyTags = isAll
    ? activeSurveys.map((s) => s.title || 'Untitled').slice(0, FEED.length)
    : [];

  return (
    <TooltipProvider delayDuration={200}>
      <div className="space-y-4">
        {/* ── KPI strip (4 metric cards) ──────────────────────────────── */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KpiCard
            label={isAll ? 'Portfolio NPS' : 'NPS'}
            value={displayNps}
            unit={`±${displayCi}`}
            sample={`n=${nFmt(displayN)}`}
            trend={2}
            spark={[10, 14, 12, 18, 16, 22, 20]}
            sparkColor="var(--color-primary)"
            tooltip="Adjusted-Wald CI at 90% confidence"
          />
          <KpiCard
            label={isAll ? 'Portfolio CSAT' : 'CSAT'}
            value="4.2"
            unit="/ 5"
            sample={`n=${nFmt(displayN)}`}
            spark={[14, 12, 18, 16, 20, 18, 22]}
            sparkColor="var(--color-secondary)"
          />
          <KpiCard
            label="CES"
            value="2.4"
            unit="/ 7"
            sample={`n=${nFmt(displayN)}`}
            spark={[18, 16, 14, 12, 14, 12, 10]}
            sparkColor="#10b981"
            tooltip="Lower is better — most respondents report low effort"
          />
          <KpiCard
            label={isAll ? 'Surveys live' : 'Responses'}
            value={isAll ? activeSurveys.length : 312}
            unit={isAll ? 'active' : '/ 500'}
            sample={isAll ? `${nFmt(totalResponses)} responses` : '4 days left'}
            progress={isAll ? undefined : 62}
          />
        </div>

        {/* ── Body: priority feed + side rail ─────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4">
          {/* Priority Feed */}
          <Card className="border-border/50 shadow-card overflow-hidden">
            <header className="flex items-center gap-2 px-5 py-3 border-b border-border/40 bg-card sticky top-0 z-10">
              <Icon name="bolt" size={18} className="text-primary" />
              <h3 className="font-headline font-bold text-sm">Priority feed</h3>
              <Badge variant="secondary" className="text-[10px] ml-1">{FEED.length}</Badge>
              <div className="flex-1" />
              <div className="flex items-center gap-1">
                <FilterPill active>All</FilterPill>
                <FilterPill>Drivers</FilterPill>
                <FilterPill>Anomalies</FilterPill>
                <FilterPill>Actions</FilterPill>
              </div>
            </header>
            <CardContent className="p-0 divide-y divide-border/30">
              {FEED.map((item, i) => (
                <FeedRow key={i} item={item} surveyTag={surveyTags[i]} />
              ))}
              <div className="px-5 py-3 flex items-center gap-2 text-muted-foreground text-xs">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                <span className="font-medium">+ 6 more · streaming</span>
              </div>
            </CardContent>
          </Card>

          {/* Side rail */}
          <aside className="space-y-4 lg:sticky lg:top-4 lg:self-start">
            {/* Top action hero */}
            <Card
              className="border-0 shadow-primary overflow-hidden text-white relative"
              style={{ background: 'linear-gradient(135deg, var(--color-primary), var(--color-tertiary))' }}
            >
              <div className="absolute inset-0 holographic opacity-50 pointer-events-none" />
              <CardContent className="p-5 relative z-10">
                <div className="text-[10px] font-bold uppercase tracking-widest opacity-80 mb-2">
                  Top action
                </div>
                <div className="font-headline text-lg font-extrabold leading-tight mb-1.5">
                  Fix email verification loop
                </div>
                <div className="text-xs opacity-85 mb-4">
                  Projected NPS <strong>+3.2 ±1.8</strong> · 18 cited respondents
                </div>
                <Button size="sm" className="bg-white text-primary hover:bg-white/90 font-bold">
                  <Icon name="flag" size={14} />
                  Create ticket
                </Button>
              </CardContent>
            </Card>

            {/* Trust panel */}
            <Card className="border-border/50 shadow-card">
              <CardContent className="p-5 space-y-3">
                <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                  Trust at a glance
                </div>
                <TrustRow label="Citation validity" value="99.7%" good />
                <TrustRow label="Verifier pass rate" value="98.4%" good />
                <TrustRow label="Avg n / insight" value="147" />
                <TrustRow label="Reproducible" value="✓" good />
              </CardContent>
            </Card>

            {/* Credit usage */}
            <Card className="border-border/50 shadow-card">
              <CardContent className="p-5">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                    Credits today
                  </span>
                  <span className="text-[10px] text-muted-foreground font-mono">
                    ~$0.03 spent
                  </span>
                </div>
                <div className="flex items-baseline gap-1.5 mb-2">
                  <span className="font-headline text-2xl font-extrabold">142</span>
                  <span className="text-xs text-muted-foreground">/ 10,000</span>
                </div>
                <div className="h-1 rounded-full bg-muted overflow-hidden">
                  <div className="h-full bg-emerald-500" style={{ width: '1.4%' }} />
                </div>
              </CardContent>
            </Card>
          </aside>
        </div>
      </div>
    </TooltipProvider>
  );
}

// ── KPI tile ─────────────────────────────────────────────────────────────
function KpiCard({
  label, value, unit, sample, trend, spark, sparkColor, progress, tooltip,
}: {
  label: string;
  value: number | string;
  unit?: string;
  sample?: string;
  trend?: number;
  spark?: number[];
  sparkColor?: string;
  progress?: number;
  tooltip?: string;
}) {
  const card = (
    <Card className="border-border/50 shadow-card">
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
            {label}
          </span>
          {trend !== undefined && (
            <span className="text-[10px] font-bold text-emerald-600 flex items-center gap-0.5">
              <Icon name="trending_up" size={12} />
              +{trend}
            </span>
          )}
        </div>
        <div className="flex items-baseline gap-1.5">
          <span className="font-headline text-2xl font-extrabold">{value}</span>
          {unit && <span className="text-xs text-muted-foreground font-medium">{unit}</span>}
        </div>
        {sample && <div className="text-[10px] text-muted-foreground/80 font-mono mt-0.5">{sample}</div>}
        {spark && (
          <div className="mt-2 h-6 flex items-end gap-0.5" style={{ color: sparkColor }}>
            {spark.map((h, i) => (
              <span key={i} className="flex-1 rounded-sm bg-current opacity-60" style={{ height: `${h * 2}px` }} />
            ))}
          </div>
        )}
        {progress !== undefined && (
          <div className="mt-2 h-1 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full"
              style={{ width: `${progress}%`, background: 'linear-gradient(to right, var(--color-primary), var(--color-tertiary))' }}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
  if (!tooltip) return card;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{card}</TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

// ── Filter pill ──────────────────────────────────────────────────────────
function FilterPill({ children, active }: { children: React.ReactNode; active?: boolean }) {
  return (
    <button
      className={
        'px-2.5 py-1 rounded-md text-[11px] font-semibold transition-colors ' +
        (active
          ? 'bg-primary/10 text-primary'
          : 'text-muted-foreground hover:bg-muted')
      }
    >
      {children}
    </button>
  );
}

// ── Feed row ─────────────────────────────────────────────────────────────
function FeedRow({ item, surveyTag }: { item: FeedItem; surveyTag?: string }) {
  const layerColor = LAYER_COLOR[item.layer];
  return (
    <div className="group px-5 py-3.5 hover:bg-muted/30 transition-colors cursor-pointer">
      <div className="flex items-start gap-3">
        {/* Layer dot */}
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className="w-2 h-2 rounded-full flex-shrink-0 mt-1.5"
              style={{ background: layerColor }}
            />
          </TooltipTrigger>
          <TooltipContent>{item.layer.charAt(0).toUpperCase() + item.layer.slice(1)}</TooltipContent>
        </Tooltip>

        <div className="flex-1 min-w-0">
          {/* Meta line */}
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: layerColor }}>
              {item.category}
            </span>
            <span className="text-[10px] text-muted-foreground font-mono">{item.age} ago</span>
            {item.confidence !== undefined && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="text-[10px] font-mono text-muted-foreground">conf {item.confidence}</span>
                </TooltipTrigger>
                <TooltipContent>Statistical + grounding + consistency · click for breakdown</TooltipContent>
              </Tooltip>
            )}
            {surveyTag && (
              <Badge
                variant="secondary"
                className="text-[9px] font-semibold py-0 px-1.5 normal-case tracking-normal max-w-[160px]"
                title={surveyTag}
              >
                <span className="truncate">{surveyTag}</span>
              </Badge>
            )}
          </div>

          {/* Headline */}
          <div className="font-semibold text-sm leading-snug mb-1 text-foreground">
            {item.headline}
          </div>

          {/* Detail */}
          <p className="text-xs text-muted-foreground leading-relaxed">{item.detail}</p>

          {/* CTA */}
          {item.cta && (
            <Button size="sm" variant="outline" className="mt-2 h-7 text-[11px]">
              <Icon name="flag" size={12} />
              {item.cta}
            </Button>
          )}
        </div>

        <Icon
          name="chevron_right"
          size={18}
          className="text-muted-foreground/40 group-hover:text-muted-foreground transition-colors self-center"
        />
      </div>
    </div>
  );
}

// ── Trust row ────────────────────────────────────────────────────────────
function TrustRow({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className={'font-mono font-bold ' + (good ? 'text-emerald-600' : 'text-foreground')}>
        {value}
      </span>
    </div>
  );
}
