# Org Intelligence Dashboard — Delivery Roadmap

> **Document owner:** Priya Rajan (Product Lead)  
> **Last updated:** 2026-06-29  
> **Status:** Active — this is the engineering contract for Command Center delivery

Each phase is a self-contained unit of work. The acceptance criteria (AC) at the end of each phase are the definition of done. No phase ships unless all AC items pass review, integration tests pass in CI, and Jordan has run the manual regression check.

---

## Phase 1 — Foundation (Weeks 1–2)

**Goal:** The data model exists in production. The backend serves real aggregated data. A basic frontend page renders KPIs and the programs table with static (non-real-time) data. Engineers on subsequent phases can begin their work as soon as this phase ships.

---

### File: supabase/migrations/YYYYMMDDHHMMSS_org_dashboard_foundation.sql

**What it contains:** The full schema for the Phase 1 data surfaces — `org_metrics_daily`, `survey_health_summary`, and `org_health_score`. The weekly and topic tables are deferred to Phase 2.

**Full SQL:**

```sql
-- ==============================================================
-- Phase 1: Org Dashboard Foundation
-- Creates: org_metrics_daily, survey_health_summary, org_health_score
-- ==============================================================

-- Health status and sentiment trend enums
CREATE TYPE IF NOT EXISTS sentiment_trend_enum AS ENUM ('improving', 'stable', 'declining');
CREATE TYPE IF NOT EXISTS health_status_enum AS ENUM ('healthy', 'attention', 'critical');

-- org_metrics_daily: materialized view for daily org-level response aggregation
CREATE MATERIALIZED VIEW org_metrics_daily AS
SELECT
  sr.org_id,
  DATE_TRUNC('day', sr.submitted_at)::DATE          AS date,
  COUNT(*)                                           AS total_responses,
  ROUND(AVG(sr.nps_score)::NUMERIC, 2)               AS avg_nps,
  ROUND(AVG(sr.sentiment_score)::NUMERIC, 4)         AS avg_sentiment,
  COUNT(DISTINCT sr.survey_id)                       AS active_surveys,
  ROUND(
    COUNT(*) FILTER (
      WHERE sr.submitted_at >= NOW() - INTERVAL '24 hours'
    )::NUMERIC / NULLIF(
      COUNT(*) FILTER (
        WHERE sr.submitted_at >= NOW() - INTERVAL '7 days'
      ) / 7.0, 0
    ), 2
  )                                                  AS response_velocity,
  NOW()                                              AS created_at
FROM survey_responses sr
JOIN surveys s ON s.id = sr.survey_id AND s.deleted_at IS NULL
GROUP BY sr.org_id, DATE_TRUNC('day', sr.submitted_at)::DATE
WITH DATA;

CREATE UNIQUE INDEX ON org_metrics_daily (org_id, date);
CREATE INDEX ON org_metrics_daily (org_id, date DESC);

-- survey_health_summary: materialized view for per-survey health
CREATE MATERIALIZED VIEW survey_health_summary AS
WITH recent AS (
  SELECT
    survey_id,
    ROUND(AVG(nps_score)::NUMERIC, 2)                                     AS last_nps,
    COUNT(*) FILTER (WHERE submitted_at >= NOW() - INTERVAL '7 days')     AS response_velocity_7d,
    ROUND(AVG(sentiment_score) FILTER (
      WHERE submitted_at >= NOW() - INTERVAL '7 days')::NUMERIC, 4)       AS recent_sentiment,
    ROUND(AVG(sentiment_score) FILTER (
      WHERE submitted_at BETWEEN NOW() - INTERVAL '14 days'
                             AND NOW() - INTERVAL '7 days')::NUMERIC, 4)  AS prev_sentiment
  FROM survey_responses
  WHERE submitted_at >= NOW() - INTERVAL '14 days'
  GROUP BY survey_id
),
anomaly_counts AS (
  SELECT survey_id, COUNT(*) AS anomaly_count
  FROM survey_anomalies
  WHERE resolved_at IS NULL
  GROUP BY survey_id
)
SELECT
  s.id                                                             AS survey_id,
  s.org_id,
  s.tag_group_id,
  s.title                                                          AS survey_title,
  COALESCE(r.last_nps, 0)                                          AS last_nps,
  COALESCE(r.response_velocity_7d, 0)                              AS response_velocity_7d,
  CASE
    WHEN r.recent_sentiment IS NULL OR r.prev_sentiment IS NULL THEN 'stable'::sentiment_trend_enum
    WHEN r.recent_sentiment > r.prev_sentiment + 0.05              THEN 'improving'::sentiment_trend_enum
    WHEN r.recent_sentiment < r.prev_sentiment - 0.05              THEN 'declining'::sentiment_trend_enum
    ELSE 'stable'::sentiment_trend_enum
  END                                                              AS sentiment_trend,
  COALESCE(ac.anomaly_count, 0)                                    AS anomaly_count,
  CASE
    WHEN COALESCE(ac.anomaly_count, 0) > 2
         OR COALESCE(r.last_nps, 0) < -20                         THEN 'critical'::health_status_enum
    WHEN COALESCE(ac.anomaly_count, 0) > 0
         OR COALESCE(r.last_nps, 0) < 20                          THEN 'attention'::health_status_enum
    ELSE 'healthy'::health_status_enum
  END                                                              AS health_status,
  MAX(sr2.submitted_at)                                            AS last_activity_at,
  NOW()                                                            AS created_at
FROM surveys s
LEFT JOIN recent r ON r.survey_id = s.id
LEFT JOIN anomaly_counts ac ON ac.survey_id = s.id
LEFT JOIN survey_responses sr2 ON sr2.survey_id = s.id
WHERE s.deleted_at IS NULL
GROUP BY s.id, s.org_id, s.tag_group_id, s.title, r.last_nps, r.response_velocity_7d,
         r.recent_sentiment, r.prev_sentiment, ac.anomaly_count
WITH DATA;

CREATE UNIQUE INDEX ON survey_health_summary (survey_id);
CREATE INDEX ON survey_health_summary (org_id, health_status);
CREATE INDEX ON survey_health_summary (org_id, last_activity_at DESC);

-- org_health_score: one row per org, upserted by the computation job
CREATE TABLE org_health_score (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  nps_score               NUMERIC(5,4) NOT NULL,
  sentiment_score         NUMERIC(5,4) NOT NULL,
  response_velocity_score NUMERIC(5,4) NOT NULL,
  anomaly_free_score      NUMERIC(5,4) NOT NULL,
  total_score             INTEGER NOT NULL CHECK (total_score BETWEEN 0 AND 100),
  computed_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_through           TIMESTAMPTZ NOT NULL,
  CONSTRAINT org_health_score_org_unique UNIQUE (org_id)
);

CREATE INDEX ON org_health_score (org_id);

-- pg_cron: schedule materialized view refreshes
SELECT cron.schedule('refresh-org-metrics-daily',    '*/15 * * * *', $$REFRESH MATERIALIZED VIEW CONCURRENTLY org_metrics_daily$$);
SELECT cron.schedule('refresh-survey-health-summary','0 * * * *',    $$REFRESH MATERIALIZED VIEW CONCURRENTLY survey_health_summary$$);
SELECT cron.schedule('compute-org-health-scores',    '0 3 * * *',    $$CALL compute_all_org_health_scores()$$);
```

**Acceptance criteria:**
- AC-P1-1: `REFRESH MATERIALIZED VIEW CONCURRENTLY org_metrics_daily` runs without error on the production database
- AC-P1-2: `survey_health_summary` correctly classifies at least one survey as "critical," one as "attention," and one as "healthy" in the test fixture dataset
- AC-P1-3: pg_cron jobs are registered and appear in `cron.job` table
- AC-P1-4: Rollback migration (`DROP MATERIALIZED VIEW`, `DROP TABLE`) runs cleanly

---

### File: backend/src/routes/org-dashboard.ts

**What it contains:** All HTTP route handlers for the org-dashboard API surface. Phase 1 implements the main dashboard payload and the programs list. Crystal Brief, alerts, and trends are stubbed with 501 responses.

**Key function signatures:**

```typescript
import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { OrgMetricsService } from '../services/org-metrics.service';

const router = Router();

// GET /api/org/dashboard
router.get('/', requireAuth, async (req: Request, res: Response): Promise<void> => {
  // Extract org_id from req.auth (Clerk session) — never from query params
  // Call OrgMetricsService.getDashboardPayload(orgId)
  // Return 200 with typed OrgDashboardResponse
  // Return 404 with { error: 'NO_SURVEYS' } if org has zero surveys
});

// GET /api/org/dashboard/programs
router.get('/programs', requireAuth, async (req: Request, res: Response): Promise<void> => {
  // Parse and validate: page (int), pageSize (10|25|50), sort, order, tagGroupId, status
  // Call OrgMetricsService.getPrograms(orgId, options)
  // Return 200 with ProgramsListResponse
});

// GET /api/org/dashboard/trends — Phase 2
router.get('/trends', requireAuth, async (_req, res) => res.status(501).json({ error: 'NOT_IMPLEMENTED' }));

// GET /api/org/dashboard/topics — Phase 2
router.get('/topics', requireAuth, async (_req, res) => res.status(501).json({ error: 'NOT_IMPLEMENTED' }));

// GET /api/org/dashboard/alerts — Phase 2
router.get('/alerts', requireAuth, async (_req, res) => res.status(501).json({ error: 'NOT_IMPLEMENTED' }));

// GET /api/org/dashboard/crystal-brief — Phase 2
router.get('/crystal-brief', requireAuth, async (_req, res) => res.status(501).json({ error: 'NOT_IMPLEMENTED' }));

// GET /api/org/health-score
router.get('/health-score', requireAuth, async (req: Request, res: Response): Promise<void> => {
  // Call OrgMetricsService.getHealthScore(orgId)
  // Return 200 with OrgHealthScoreResponse
});

export default router;
```

Mount in `backend/src/app.ts`: `app.use('/api/org/dashboard', orgDashboardRouter);`

**Acceptance criteria:**
- AC-P1-5: `GET /api/org/dashboard` returns a 200 with all required fields (no null for fields that should have values when surveys exist)
- AC-P1-6: `GET /api/org/dashboard` returns `{ error: 'NO_SURVEYS' }` (not a 500) when called for an org with zero surveys
- AC-P1-7: Auth middleware correctly returns 401 for unauthenticated requests
- AC-P1-8: `GET /api/org/dashboard/programs` correctly paginates — page 2 returns different rows than page 1

---

### File: backend/src/services/org-metrics.service.ts

**What it contains:** All database query logic for the org-dashboard. Route handlers call this service; they do not write SQL directly.

**Key function signatures:**

```typescript
import { Pool } from 'pg';

export interface OrgDashboardPayload {
  org: { id: string; name: string };
  healthScore: OrgHealthScoreData;
  kpis: OrgKPIs;
  crystalBrief: null;  // Phase 1: always null
  dataFreshnessAt: string;
}

export interface OrgKPIs {
  activeSurveys: number;
  totalResponses: number;
  responsesToday: number;
  avgNps: number;
  npsWowDelta: number;
  avgSentiment: number;
  sentimentTrend: 'improving' | 'stable' | 'declining';
}

export interface ProgramRow {
  surveyId: string;
  surveyTitle: string;
  tagGroupId: string | null;
  tagGroupName: string | null;
  responses7d: number;
  lastNps: number;
  sentimentTrend: 'improving' | 'stable' | 'declining';
  velocityScore: number;
  healthStatus: 'healthy' | 'attention' | 'critical';
  lastActivityAt: string;
  sparkline: number[];
}

export class OrgMetricsService {
  constructor(private pool: Pool) {}

  async getDashboardPayload(orgId: string): Promise<OrgDashboardPayload>;
  // Queries: org_metrics_daily (last 30 days for KPIs), org_health_score
  // Redis cache key: org:{orgId}:dashboard, TTL: 120s

  async getPrograms(
    orgId: string,
    options: {
      page: number;
      pageSize: 10 | 25 | 50;
      sort: 'health' | 'nps' | 'responses' | 'lastActivity' | 'name';
      order: 'asc' | 'desc';
      tagGroupId?: string;
      status?: 'healthy' | 'attention' | 'critical';
    }
  ): Promise<{ programs: ProgramRow[]; pagination: PaginationMeta }>;
  // Queries: survey_health_summary + tag_groups join
  // Sparkline: separate query for last 7 days NPS per survey

  async getHealthScore(orgId: string): Promise<OrgHealthScoreData>;
  // Queries: org_health_score table (single row per org)

  private async getSparklines(surveyIds: string[]): Promise<Map<string, number[]>>;
  // Batch query: one query for all survey sparklines, not N queries
}
```

**Acceptance criteria:**
- AC-P1-9: `getDashboardPayload` executes in under 500ms on a database with 100 surveys and 50,000 responses (measured in local Docker environment)
- AC-P1-10: `getPrograms` uses a single SQL query with a JOIN (not N+1 queries for sparklines)
- AC-P1-11: Redis cache correctly returns cached data on the second call within the TTL window

---

### File: app/src/pages/OrgDashboard.tsx

**What it contains:** The top-level page component for Command Center. Phase 1 renders the TopNav stub, KPIRow, and ProgramsTable. Crystal Brief, Alerts, and Topics sections render placeholder skeletons with "Coming soon" copy.

**Key component signature:**

```typescript
import React from 'react';
import { useOrgDashboard } from '../hooks/useOrgDashboard';
import { KPIRow } from '../components/org-dashboard/KPIRow';
import { ProgramsTable } from '../components/org-dashboard/ProgramsTable';
import { t } from '../../locales/en';

export default function OrgDashboard(): React.JSX.Element {
  const { data, isLoading, error } = useOrgDashboard();

  if (isLoading) return <OrgDashboardSkeleton />;
  if (error) return <OrgDashboardError error={error} />;
  if (!data) return <OrgDashboardEmpty />;

  return (
    <div className="min-h-screen bg-gray-50">
      {/* TopNav renders separately as a fixed layout element */}
      <main className="pt-[112px] px-6 pb-12 max-w-screen-xl mx-auto">
        {/* Phase 1: KPIRow + ProgramsTable */}
        <KPIRow kpis={data.kpis} healthScore={data.healthScore} />
        <ProgramsTable orgId={data.org.id} />
        {/* Phase 2 placeholders */}
        <div className="mt-6 text-sm text-gray-400 text-center">
          {t('orgDashboard.comingSoon.crystalBrief')}
        </div>
      </main>
    </div>
  );
}
```

Route in `app/src/router.tsx`: `<Route path="/org/command-center" element={<OrgDashboard />} />`

---

### File: app/src/components/org-dashboard/KPIRow.tsx

**What it contains:** The 4-tile KPI row. Phase 1 renders static values from the REST payload (no live updates). Live counter is added in Phase 3.

**Key component signature:**

```typescript
import React from 'react';
import { t } from '../../../locales/en';

interface KPIRowProps {
  kpis: {
    activeSurveys: number;
    totalResponses: number;
    responsesToday: number;
    avgNps: number;
    npsWowDelta: number;
    avgSentiment: number;
    sentimentTrend: 'improving' | 'stable' | 'declining';
  };
  healthScore: {
    total: number;
    computedAt: string;
  };
}

export function KPIRow({ kpis, healthScore }: KPIRowProps): React.JSX.Element;
// Renders 4 KPITile components
// NPS tile includes the NPS gauge arc SVG
// Phase 1: no live counter animation — responses today is static from REST
// Phase 3 will inject the live counter via useOrgDashboardLive hook
```

---

### File: app/src/components/org-dashboard/ProgramsTable.tsx

**What it contains:** The paginated programs overview table. Phase 1 renders all columns, sorting, and pagination. Row drill-down and inline Ask Crystal button are Phase 2 additions.

**Key component signature:**

```typescript
import React, { useState } from 'react';
import { useOrgPrograms } from '../../hooks/useOrgPrograms';
import { HealthPill } from './HealthPill';
import { SparklineCell } from './SparklineCell';
import { t } from '../../../locales/en';

interface ProgramsTableProps {
  orgId: string;
}

export function ProgramsTable({ orgId }: ProgramsTableProps): React.JSX.Element;
// State: page, pageSize, sort, order, tagGroupId filter
// Data: useOrgPrograms hook (wraps GET /api/org/dashboard/programs)
// Renders: thead with sortable column headers, tbody with ProgramRow components
// Pagination: prev/next + page size selector
// Loading: skeleton rows (same row height as data rows to prevent layout shift)
```

---

**Phase 1 QA Checklist:**
- [ ] `GET /api/org/dashboard` returns correct data for a test org with 5 surveys
- [ ] `GET /api/org/dashboard` returns correct empty state for a test org with 0 surveys
- [ ] Programs table renders all 8 columns correctly
- [ ] Programs table sort by each column produces expected order
- [ ] Programs table pagination shows correct page 2 content
- [ ] 401 is returned for unauthenticated API calls
- [ ] Jordan's integration test suite passes: `npm test -- --testPathPattern org-dashboard`
- [ ] No TypeScript `strict` errors in new files (`tsc --noEmit` passes)
- [ ] All user-visible strings are in `locales/en.ts` (grep for hardcoded English in JSX)

**Phase 1 Rollback Plan:**
- Backend: Remove the `app.use('/api/org/dashboard', ...)` mount from `app.ts` (one line change, immediate deploy)
- Frontend: Remove the `/org/command-center` route from the router (one line change, immediate deploy)
- Database: The migration is non-destructive (adds new views and table, does not modify existing tables). Rollback migration drops the new objects. No data is lost.

---

## Phase 2 — Intelligence Layer (Weeks 3–4)

**Goal:** Crystal's Weekly Brief is live. Anomaly alerts are firing. The Org Health Score is computing on schedule. CrystalOS has the org brief graph running. The full Command Center payload is returned by the backend.

**Added scope (Decision 12, `DECISIONS.md`, 2026-07-01):** Org Insight History (Brief Archive) and Manual Custom-Range Summary (On-Demand Brief) ship in this phase alongside the above, per stakeholder direction overriding Priya's original recommendation to sequence Manual Summary into a later phase. The technical prerequisites are **not waived** by this acceleration and are hard blockers before Manual Summary specifically can ship within this phase:
- One reconciled max date-range cap — **resolved 2026-07-01: 90 days** (see ARCHITECTURE.md addendum).
- `org_brief_graph.py`'s custom-range guards (period-type mode flag, non-week-aligned signal suppression) implemented and reviewed — this is new scope requiring standard architecture review, not Amara's verbosity fast-path.
- 6–8 new eval cases for custom ranges (short/medium/long), plus a further 8–10 for insight-consumption/hallucination-scoring correctness (Decision 16) — 14–18 new cases total, in addition to the existing 10 weekly-brief cases.
- A dedicated `resolveOrgSummaryCost` cost curve — do not reuse the survey-level Custom Analysis tiers unchanged.
- The live-update mechanism for the generation status chip (WebSocket vs. notification-events vs. polling — see open item in DESIGN.md addendum) resolved at Architecture Review before `useOrgDashboardLive` work begins.

**HARD EXTERNAL BLOCKER (Decision 15, confirmed as a real planning gap by review — added 2026-07-01): Phase 2's insight-consumption work (citing real survey-level insights in the brief, per Decision 14) cannot start until Tag Report ships `docs/tag-report/DESIGN.md` §4.5 AC-1 (`source_insight_id` on `CitationRef`).** This is a dependency on a different feature's implementation timeline, not an internal risk this team controls. Numeric-rollup-only brief generation, Org Health Score, and Brief Archive/History are NOT blocked by this and can proceed on schedule — only the insight-citation upgrade is gated. Track Tag Report's ship date explicitly; do not let engineers start insight-consumption work assuming it's unblocked.

**ADDITIONAL RELEASE GATE (Decision 16, item 1 — compliance, non-negotiable): citation-bearing briefs (any brief containing `source_insight_ids` or cached verbatim quote text) may not go to production until Tag Report's citation-erasure redaction hook (DESIGN.md §4.5 AC-3) is both approved and Command Center's `org_crystal_briefs`/`org_custom_summaries` tables are wired in as consumers of it.** Shipping citation-bearing briefs ahead of this is a GDPR/erasure-compliance risk (a deleted respondent's verbatim text can persist indefinitely in cached brief text), not a feature gap — treat as a hard release gate.

See DESIGN.md's "Org Insight History & Manual Summary Generator" section, the new "Trust, Citation & Comparison UI" section, and ARCHITECTURE.md's two addenda for full specs.

---

### File: crystalos/graphs/org_brief_graph.py

**What it contains:** The LangGraph DAG for generating weekly org briefs. Six nodes, as specified in ARCHITECTURE.md.

**Key signatures:**

```python
from langgraph.graph import StateGraph, END
from typing import TypedDict, Annotated
from datetime import date

class OrgBriefState(TypedDict):
    org_id: str
    date_range_start: date
    date_range_end: date
    org_metrics: dict           # OrgMetricsSnapshot — filled by aggregate_org_metrics
    ranked_programs: list       # filled by identify_top_programs
    org_signals: list           # filled by detect_org_signals
    narrative: str              # filled by synthesize_narrative
    recommendations: list       # filled by generate_recommendations
    brief_id: str               # filled by publish_brief

def build_org_brief_graph() -> StateGraph:
    graph = StateGraph(OrgBriefState)
    graph.add_node("aggregate_org_metrics",    aggregate_org_metrics)
    graph.add_node("identify_top_programs",    identify_top_programs)
    graph.add_node("detect_org_signals",       detect_org_signals)
    graph.add_node("synthesize_narrative",     synthesize_narrative)
    graph.add_node("generate_recommendations", generate_recommendations)
    graph.add_node("publish_brief",            publish_brief)
    # Edge order: aggregate → (identify_top_programs + detect_org_signals in parallel) → synthesize + generate → publish
    graph.set_entry_point("aggregate_org_metrics")
    graph.add_edge("aggregate_org_metrics",    "identify_top_programs")
    graph.add_edge("aggregate_org_metrics",    "detect_org_signals")
    graph.add_edge("identify_top_programs",    "synthesize_narrative")
    graph.add_edge("detect_org_signals",       "synthesize_narrative")
    graph.add_edge("synthesize_narrative",     "generate_recommendations")
    graph.add_edge("generate_recommendations", "publish_brief")
    graph.add_edge("publish_brief",            END)
    return graph.compile()

# FastAPI endpoint in crystalos/routers/org_brief.py:
# POST /graphs/org-brief  { org_id, date_range_start, date_range_end }
# Returns: { brief_id, status: "complete" | "error", generated_at }
```

---

### File: crystalos/skills/org_signal_detector/

**Structure:**
```
crystalos/skills/org_signal_detector/
├── SKILL.md        — skill description, inputs, outputs, examples
├── EVALS.md        — 10 labeled test cases (org state → expected signals)
├── __init__.py
├── detector.py     — OrgSignalDetector class
└── signal_types.py — OrgSignal TypedDict and SignalType enum
```

**Key signatures:**

```python
# detector.py
from .signal_types import OrgSignal, SignalType

class OrgSignalDetector:
    def detect(self, org_metrics: dict) -> list[OrgSignal]:
        signals = []
        signals.extend(self._check_correlated_negative_sentiment(org_metrics))
        signals.extend(self._check_velocity_collapse(org_metrics))
        signals.extend(self._check_nps_floor_breach(org_metrics))
        signals.extend(self._check_bright_spot(org_metrics))
        return signals

    def _check_correlated_negative_sentiment(self, metrics: dict) -> list[OrgSignal]:
        # Returns signal if >= 3 surveys show declining sentiment simultaneously
        ...

    def _check_velocity_collapse(self, metrics: dict) -> list[OrgSignal]:
        # Returns signal if velocity dropped by 60%+ vs. 2 weeks ago
        ...
```

---

### Backend additions to org-dashboard.ts

**New endpoints (Phase 2):**

```typescript
// GET /api/org/dashboard/trends
router.get('/trends', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const range = (req.query.range as string) ?? '30d';
  const granularity = (req.query.granularity as string) ?? 'daily';
  // Validate range enum; return 400 if invalid
  // Call OrgMetricsService.getTrends(orgId, range, granularity)
});

// GET /api/org/dashboard/crystal-brief
router.get('/crystal-brief', requireAuth, async (req: Request, res: Response): Promise<void> => {
  // Call OrgMetricsService.getLatestCrystalBrief(orgId)
  // Return 200 with brief data or { status: 'not_generated_yet' }
});

// POST /api/org/dashboard/crystal-brief/regenerate
router.post('/crystal-brief/regenerate', requireAuth, async (req: Request, res: Response): Promise<void> => {
  // Fire-and-forget: call CrystalOS /graphs/org-brief via agentsClient
  // Return 202 { jobId, estimatedSeconds: 30 }
});

// GET /api/org/dashboard/alerts
router.get('/alerts', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const limit = parseInt((req.query.limit as string) ?? '20', 10);
  // Call OrgMetricsService.getAlerts(orgId, limit)
});

// PATCH /api/org/dashboard/alerts/:alertId/acknowledge
router.patch('/alerts/:alertId/acknowledge', requireAuth, async (req: Request, res: Response): Promise<void> => {
  // Mark alert as acknowledged in survey_anomalies table
  // Return 200 { alertId, acknowledgedAt }
});
```

---

### File: app/src/components/org-dashboard/CrystalBriefCard.tsx

```typescript
import React from 'react';
import { t } from '../../../locales/en';

interface CrystalBriefCardProps {
  brief: {
    id: string;
    briefText: string;
    recommendations: Array<{
      rank: number;
      action: string;
      rationale: string;
      surveyId: string | null;
      actionType: 'investigate' | 'review' | 'celebrate' | 'monitor';
    }>;
    generatedAt: string;
    dateRangeStart: string;
    dateRangeEnd: string;
  } | null;
  isLoading: boolean;
  onAskFollowUp: () => void;   // opens Crystal command bar with org context
  onRegenerate: () => void;    // triggers POST crystal-brief/regenerate
}

export function CrystalBriefCard(props: CrystalBriefCardProps): React.JSX.Element;
```

---

### File: app/src/components/org-dashboard/AnomalyAlerts.tsx

```typescript
import React from 'react';
import { useOrgAlerts } from '../../hooks/useOrgAlerts';
import { SeverityBadge } from './SeverityBadge';
import { t } from '../../../locales/en';

interface AnomalyAlertsProps {
  orgId: string;
  // Phase 3 will inject live alerts via WebSocket; Phase 2 is REST-only
}

export function AnomalyAlerts({ orgId }: AnomalyAlertsProps): React.JSX.Element;
// Empty state: renders the "your programs are healthy" illustration
// Alert item: SeverityBadge + description + time ago + Resolve/View buttons
// onResolve: calls PATCH /api/org/dashboard/alerts/:id/acknowledge
// onView: navigates to survey detail page
```

---

### File: app/src/components/org-dashboard/EmergingTopics.tsx

```typescript
import React, { useState } from 'react';
import { useOrgTopics } from '../../hooks/useOrgTopics';
import { TopicChip } from './TopicChip';
import { TopicDrawer } from './TopicDrawer';
import { t } from '../../../locales/en';

interface EmergingTopicsProps {
  orgId: string;
}

export function EmergingTopics({ orgId }: EmergingTopicsProps): React.JSX.Element;
// Renders: horizontal scrollable chip row
// State: selectedTopic (string | null) — controls drawer visibility
// TopicDrawer: bottom sheet with topic detail (survey breakdown + verbatims)
```

---

**Phase 2 QA Checklist:**
- [ ] Crystal Brief renders with correct narrative text and all 3 recommendations
- [ ] Crystal Brief shows loading skeleton while data is in flight
- [ ] Crystal Brief shows empty state for an org with fewer than 3 surveys
- [ ] Anomaly Alerts shows the "healthy" empty state when there are no open anomalies
- [ ] Anomaly Alerts "Resolve" button calls the PATCH endpoint and removes the item from the list
- [ ] Emerging Topics renders at least 5 topic chips for the test org
- [ ] A "New this week" chip has the blue dot indicator
- [ ] Topic drawer opens and shows survey breakdown on chip click
- [ ] CrystalOS org_brief_graph runs end-to-end without error on the test org fixture
- [ ] Org signal detector correctly identifies correlated negative sentiment in the EVALS.md test cases
- [ ] Jordan's integration tests pass, including Crystal Brief and Alerts endpoints

**Phase 2 Rollback Plan:**
- Backend: The new endpoints return 501. Remove the route handler bodies and return 501, redeploy. No database changes.
- CrystalOS: The graph endpoint is an addition; removing the route has no downstream effect. The backend scheduler job can be disabled via env var `DISABLE_ORG_BRIEF_JOB=true`.
- Database: The `org_crystal_briefs` table migration has a clean rollback (`DROP TABLE org_crystal_briefs`). No foreign key dependencies prevent this.

---

## Phase 3 — Real-time (Week 5)

**Goal:** The KPI response counter updates live as responses arrive. Anomaly alerts appear in real-time without page reload. The WebSocket infrastructure is stable and handles disconnects gracefully.

---

### File: backend/src/services/org-realtime.service.ts

```typescript
import { WebSocketServer, WebSocket } from 'ws';
import { createClient } from 'redis';
import type { Pool } from 'pg';

export type OrgRoomMap = Map<string, Set<WebSocket>>;

export class OrgRealtimeService {
  private rooms: OrgRoomMap = new Map();
  private redisSubscriber: ReturnType<typeof createClient>;

  constructor(
    private wss: WebSocketServer,
    private pool: Pool,
    redisUrl: string
  ) {}

  async initialize(): Promise<void>;
  // 1. Connect Redis subscriber
  // 2. Subscribe to pg_notify 'response_inserted' channel
  // 3. Set up WebSocket connection handler

  private handleConnection(ws: WebSocket, orgId: string): void;
  // Add to org room, set up ping/pong, handle close

  private async handleResponseInserted(payload: ResponseInsertedPayload): Promise<void>;
  // Debounce per org (3s window)
  // Compute running totals from Redis incr
  // Broadcast response_received to org room

  private broadcast(orgId: string, message: WsServerMessage): void;
  // Send to all WebSocket clients in the org room

  private startHeartbeat(ws: WebSocket): NodeJS.Timeout;
  // Send ping every 30s, close if no pong within 10s
}

// WebSocket route in backend/src/app.ts:
// const wss = new WebSocketServer({ server, path: '/api/org/dashboard/live' });
// Mount OrgRealtimeService on wss startup
```

---

### File: app/src/hooks/useOrgDashboardLive.ts

```typescript
import { useEffect, useRef, useCallback } from 'react';
import type { WsServerMessage } from '../types/org-dashboard';

interface UseOrgDashboardLiveOptions {
  orgId: string;
  onResponseReceived: (payload: ResponseReceivedPayload) => void;
  onAnomalyDetected: (payload: AnomalyDetectedPayload) => void;
  onCrystalBriefReady: (payload: { briefId: string }) => void;
  onHealthScoreUpdated: (payload: { totalScore: number }) => void;
}

export function useOrgDashboardLive(options: UseOrgDashboardLiveOptions): {
  isConnected: boolean;
  connectionStatus: 'connecting' | 'connected' | 'disconnected' | 'error';
};
// Manages WebSocket lifecycle: connect on mount, reconnect on disconnect (exponential backoff)
// Max reconnect attempts: 5 before giving up and showing "Live updates paused"
// Debounces response_received events: accumulates in a buffer, flushes every 500ms
// Sends pong in response to server ping messages
// Cleanup: closes WebSocket on component unmount
```

**Modifications to KPIRow.tsx for Phase 3:**

```typescript
// Add prop: liveResponsesToday?: number
// When liveResponsesToday is provided via the WebSocket hook, replace the static value
// Trigger the flash animation when liveResponsesToday increments
// The flash CSS class is added for 600ms then removed:
// useEffect(() => { setIsFlashing(true); setTimeout(() => setIsFlashing(false), 600); }, [liveResponsesToday]);
```

**Performance target:** From the moment a response is submitted via `POST /api/surveys/:id/responses` to the moment the KPI counter flashes on an open Command Center tab, the elapsed time must be under 2 seconds at P95.

**Measurement:** Synthetic test — automated script submits a response and measures the time until a WebSocket message is received by a connected test client.

---

**Phase 3 QA Checklist:**
- [ ] Submit a test response via the API — the KPI counter on Command Center increments within 2 seconds
- [ ] The counter flash animation plays on increment (visual inspection)
- [ ] Disconnect the WebSocket (simulate by disabling network for 5 seconds) — confirm "Live updates paused" indicator appears within 6 seconds
- [ ] Reconnect — confirm the indicator disappears and the counter is correct
- [ ] Inject a test anomaly — confirm the alert appears in AnomalyAlerts without page reload
- [ ] Load test: 10 simultaneous WebSocket connections in the same org — all receive the same update within 2s
- [ ] Memory check: no WebSocket object leak after 50 connect/disconnect cycles

**Phase 3 Rollback Plan:**
- The WebSocket endpoint can be disabled by setting `DISABLE_ORG_REALTIME=true` env var; the frontend hook falls back to polling (2-minute intervals) automatically when the WebSocket connection fails.
- No database or schema changes in this phase.

---

## Phase 4 — Full Command Center (Weeks 6–7)

**Goal:** All 9 sections from the DESIGN.md spec are live. Tag Group comparison is available. The NPS trend chart is implemented. War Room Mode is functional.

---

### File: app/src/components/org-dashboard/TagGroupGrid.tsx

```typescript
import React, { useState } from 'react';
import { useTagGroupMetrics } from '../../hooks/useTagGroupMetrics';
import { HealthPill } from './HealthPill';
import { t } from '../../../locales/en';

interface TagGroupGridProps {
  orgId: string;
  onTagGroupClick: (tagGroupId: string) => void;  // triggers drill-down navigation
}

export function TagGroupGrid({ orgId, onTagGroupClick }: TagGroupGridProps): React.JSX.Element;
// Default: collapsed. Expand/collapse controlled by local state
// Renders: collapsible grid of TagGroupCard components
// Sort options: by health, NPS, responses, name
// Card click: calls onTagGroupClick → router.push('/org/tag-group/:tagGroupId')
```

---

### File: app/src/components/org-dashboard/NPSTrendChart.tsx

```typescript
import React from 'react';
import {
  ComposedChart, Line, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine,
  ResponsiveContainer, Legend
} from 'recharts';
import { t } from '../../../locales/en';

interface NPSTrendChartProps {
  data: Array<{
    date: string;
    avgNps: number;
    totalResponses: number;
    avgSentiment: number;
  }>;
  benchmark: { nps: number | null; source: string | null };
  mode: 'aggregated' | 'by-survey';
  onModeChange: (mode: 'aggregated' | 'by-survey') => void;
  liveDataPoint?: { date: string; avgNps: number; totalResponses: number };  // Phase 3 extension
}

export function NPSTrendChart(props: NPSTrendChartProps): React.JSX.Element;
// Left YAxis: NPS -100 to 100
// Right YAxis: response count (auto-scaled)
// NPS line: indigo-500, 2px stroke
// Response volume bars: indigo-100 fill
// Benchmark ReferenceLine: dashed, gray-400, label at right edge
// Tooltip: custom component showing date, NPS, delta, response count
// Toggle: <ToggleGroup value={mode} onValueChange={onModeChange}>
```

---

### File: app/src/components/org-dashboard/WarRoomToggle.tsx

```typescript
import React from 'react';
import { t } from '../../../locales/en';

interface WarRoomToggleProps {
  isEnabled: boolean;
  onToggle: () => void;
}

export function WarRoomToggle({ isEnabled, onToggle }: WarRoomToggleProps): React.JSX.Element;
// Renders a toggle switch with label t('orgDashboard.warRoomMode.toggle')
// onToggle: calls setWarRoomMode in the OrgDashboardContext, persists to localStorage
// The toggle is placed in the user menu dropdown (TopNav)
```

**Dark mode implementation:**

The `isWarRoomMode` state is managed in `OrgDashboardContext` and sets `data-theme="war-room"` on the Command Center page root element. All War Room Mode styles are expressed as Tailwind v4 CSS variable overrides on `[data-theme="war-room"]` — no component-level conditional class switching.

```css
/* app/src/styles/war-room.css */
[data-theme="war-room"] {
  --color-bg-primary:     #0A0F1E;
  --color-bg-surface:     #111827;
  --color-bg-surface-2:   #1E2A3A;
  --color-text-primary:   #F0F4FF;
  --color-text-secondary: #94A3B8;
  --color-accent-green:   #00FF88;
  --color-accent-amber:   #FFB800;
  --color-accent-red:     #FF4757;
  --color-accent-indigo:  #818CF8;
}
```

---

### Database: tag_group_metrics migration

```sql
-- supabase/migrations/YYYYMMDDHHMMSS_tag_group_metrics.sql
-- (Same SQL as in ARCHITECTURE.md — see that document for the full CREATE statement)
-- pg_cron schedule added in this migration for 15-minute refresh
```

---

### Drill-down: Org Dashboard → Tag Intelligence View

The Tag Intelligence View is a new page at `app/src/pages/TagIntelligence.tsx`, route `/org/tag-group/:tagGroupId`. It receives the `tagGroupId` via route params.

Navigation from Command Center: `router.push(\`/org/tag-group/${tagGroupId}\`)` — a standard React Router push. The transition uses Framer Motion `AnimatePresence` with a subtle zoom-in scale from 0.98 to 1.0 on the incoming page.

The Tag Intelligence View is out of scope for Phase 4's full design — it shows the programs in the tag group using the existing `ProgramsTable` component filtered by `tagGroupId`. Full Tag Intelligence design is Phase 5+.

---

**Phase 4 QA Checklist:**
- [ ] NPS trend chart renders correctly for 30 days, 90 days, and 1 year date ranges
- [ ] Benchmark line renders when a benchmark NPS value is configured in org settings, and is absent when not configured
- [ ] Chart mode toggle switches between aggregated and by-survey views
- [ ] War Room Mode activates on toggle and persists across page reloads (localStorage)
- [ ] War Room Mode deactivates when the toggle is clicked again
- [ ] All 8 color tokens are correctly applied in War Room Mode (visual inspection against DESIGN.md)
- [ ] Tag Group grid renders in collapsed state by default, expands on click
- [ ] Tag Group card click navigates to `/org/tag-group/:id`
- [ ] Drill-down navigation returns to Command Center via the browser back button without data loss
- [ ] `tag_group_metrics` materialized view refreshes without error via pg_cron

**Phase 4 Rollback Plan:**
- Frontend: Each new component is behind the existing page render — removing the `<NPSTrendChart>`, `<TagGroupGrid>`, or `<WarRoomToggle>` render calls from `OrgDashboard.tsx` is a one-line-per-component rollback.
- Database: `tag_group_metrics` migration has a clean rollback. No FK dependencies from existing tables.

---

## Phase 5 — Polish and Scale (Week 8)

**Goal:** The product is ready to ship to Growth and Growth+ customers. Performance is validated at scale. ⌘K integration is wired. Mobile layout works. The benchmark line is configurable.

---

### ⌘K Command Bar Integration

**File to modify:** The existing `app/src/components/CommandBar.tsx` (or equivalent)

**Integration point:** When Command Center is the active page, the command bar context is pre-populated with `{ surface: 'org-dashboard', orgId: string }`. Crystal's prompt is initialized with: `"I'm looking at Command Center for my organization. Help me understand: "`.

**Implementation:**
- `OrgDashboardContext` exposes a `openCrystalWithOrgContext()` function
- TopNav's "Ask Crystal" trigger button calls this function
- The ⌘K global keybinding on the Command Center page routes to this function

---

### Mobile Responsive Layout

**Target breakpoints (sm: 640px, md: 768px):**

| Component | Mobile behavior |
|-----------|----------------|
| TopNav | Org Health Score moves to second line, sub-bar becomes a slide-out panel |
| KPIRow | `grid-cols-2` on md, `grid-cols-1` on sm (stacked tiles) |
| ProgramsTable | Condensed columns: Name + Health + NPS only. Remaining columns in row expand |
| NPSTrendChart | Full width, height reduced to 180px |
| EmergingTopics | Touch-swipeable horizontal scroll |
| TagGroupGrid | `grid-cols-1` on sm, `grid-cols-2` on md |
| AnomalyAlerts | Moves from sidebar to below ProgramsTable, full width |

---

### Performance Optimization

**Load test targets:**
- 500 surveys in the org: `GET /api/org/dashboard/programs?pageSize=25` must respond in <500ms P95
- 1 million total responses: `org_metrics_daily` refresh must complete in <30 seconds
- 50 concurrent WebSocket connections in the same org: all receive the same `response_received` event within 2 seconds

**Materialized view refresh under load:**
- Use `REFRESH MATERIALIZED VIEW CONCURRENTLY` — reads are not blocked during refresh
- Schedule refreshes during off-peak: daily computation at 03:00 UTC
- Add a `pg_stat_statements`-based query to detect if any refresh query exceeds 60 seconds (alert the on-call rotation)

---

### Industry Benchmark Configuration

**Settings page addition:** A new input field in `app/src/pages/OrgSettings.tsx` (or equivalent):
- Label: `t('orgSettings.benchmarkNps.label')` — "Industry NPS benchmark (optional)"
- Input: integer, -100 to 100
- Stored in: `organizations.benchmark_nps` column (new column, nullable integer)
- Migration: `ALTER TABLE organizations ADD COLUMN benchmark_nps INTEGER CHECK (benchmark_nps BETWEEN -100 AND 100);`
- The NPS trend chart reads this value from `GET /api/org/dashboard/trends` response and renders the dashed benchmark line

---

**Phase 5 Acceptance Criteria and Load Test Targets:**

- AC-P5-1: `GET /api/org/dashboard/programs?pageSize=25` returns in <500ms with 500 active surveys (load test with k6 or Artillery)
- AC-P5-2: `org_metrics_daily` refresh completes in <30 seconds on a database with 1M responses (tested in staging with seeded data)
- AC-P5-3: All 9 sections of Command Center render correctly on a 375px viewport (iPhone SE)
- AC-P5-4: ⌘K opens on the Command Center page with org context pre-populated
- AC-P5-5: Benchmark NPS line renders in the chart after being saved in org settings
- AC-P5-6: Lighthouse Performance score for Command Center initial load: >80 on desktop, >65 on mobile
- AC-P5-7: WCAG 2.1 AA accessibility audit passes for all 9 sections (axe-core automated scan + manual keyboard navigation test)
- AC-P5-8: All EVALS.md test cases for `org_signal_detector` pass with the production CrystalOS model

**Phase 5 Definition of Done:**
- All 5 acceptance criteria above pass in staging
- Jordan's full integration test suite passes (happy path + edge cases for all 8 endpoints)
- Marcus has completed a post-ship design review — fewer than 3 design debt tickets filed
- Load test results documented in `docs/org-dashboard/LOAD_TEST_RESULTS.md`
- Sofia's in-app copy has been QA'd: all strings exist in `locales/en.ts`, no hardcoded English in JSX
- The feature flag is enabled for the first 10% of Growth and Growth+ orgs for a soft launch

**Phase 5 Rollback Plan:**
- Feature flag: Command Center can be disabled by setting `org_dashboard_enabled: false` in the feature flag system, returning users to their previous landing page. No code deployment required for rollback.
- If a critical bug is found post-feature-flag enablement: flip the flag to 0%, hot-patch, flip back to 10%.

---

*This roadmap is updated by Priya Rajan at the start of each phase. Engineering estimates are re-validated in the architecture review before each phase begins.*
