# Org Dashboard (Command Center) — Integration Guide

How Command Center connects to the rest of Xperiq. Written after implementation, not before —
every path below was verified against real code, not assumed from the design docs.

## Drill-down paths

```
ExperienceHubPage (/app/experience)                 [Hub — teasers only]
  ├─ 5th KPI tile (Org Health Score)                 → scrolls to nothing further; informational
  ├─ WeeklyBriefTeaserCard                            → "View full Command Center" → OrgTrendsPage
  │    └─ recommendation with survey_id               → Link to ROUTES.EXPERIENCE_SURVEY (direct,
  │                                                       skips Tag Report per the "shortcut" rule)
  └─ TagGroupsStrip (at-risk tags only)
       └─ "View Tag Report" CTA                       → full navigation to
                                                          /app/experience/tags/:tagId/report
                                                          (existing Tag Report page, untouched)

OrgTrendsPage (/app/experience/org/trends)          [Full Command Center]
  ├─ Health Score breakdown                          → tap/hover-expand in place, no navigation
  ├─ CrystalBriefCard (full)                          → recommendation.surveyId → EXPERIENCE_SURVEY
  ├─ BriefArchive                                     → inline-expand entry → CheckpointDiffPanel
  │                                                      (lazy-fetched on click, org-level only)
  ├─ ManualSummaryGenerator                            → Dialog (desktop/tablet) / Sheet (mobile)
  ├─ TagIntelligenceGrid (all tags)                    → card click → full nav to Tag Report
  ├─ AnomalyAlerts ("Program Alerts")                  → "View" → survey detail; "Resolve" → PATCH
  ├─ ProgramsTable                                     → row expand in place; tags rendered as
  │                                                       pill badges (not a single tagGroupId)
  └─ NPSTrendChart                                     → no further drill-down (terminal view)
```

Rule of thumb applied throughout (Decision 17): inline-expand answers "is this worth my
attention"; full navigation is reserved for genuinely separate trust/audit surfaces (Tag Report,
survey Insight Trail, Response Detail). Command Center never re-implements Tag Report's own
drill-down/backfill/provenance machinery inline — every Tag Report exit is a single CTA doing a
real navigation.

## Real-time delivery (Decision 22)

Two independent channels, deliberately not unified into one, because they answer different
questions (see Decision 21's reasoning):

1. **`GET /api/org/dashboard/stream`** (new, this feature) — SSE over a dedicated Redis channel
   `org:{orgId}:events`. Carries only `response_received` (3s-debounced) and `anomaly_detected`.
   Publishers: `backend/src/routes/responses.ts` (after a real response insert — not the
   synthetic sample-response generator in `surveys.ts`) and `backend/src/lib/alertEngine.ts`
   (`fireAlert`). `useOrgDashboardLive.ts` wraps this; caps reconnect attempts at 5 before
   falling back to 2-minute polling of `GET /api/org/dashboard`.
2. **`/api/notifications/stream`** (existing, app-wide) — manual summary completion and the
   brief trust-score-arrival race (Decision 21 items 1 and 3). No new infrastructure; `useNotifications.ts`'s
   `mapLive()` gained two new type branches (`org_summary_ready`, `brief_trust_score_ready`).

`health_score_updated`/`crystal_brief_ready` do **not** ride the new SSE stream — they were in
the original ARCHITECTURE.md sketch but neither is "the user is watching a number change right
now" (the only case that justifies a dedicated live channel per TEAM.md's own decision tree), so
they're picked up on the next natural refetch (dashboard payload cache TTL / brief cache TTL)
rather than adding a third notification path for a two-cases-a-week event.

## DataBus invalidation

`'orgDashboard'` was added to `app/src/lib/dataBus.ts`'s `DataResource` union. Invalidate it after:
alert acknowledge (PATCH succeeds), manual summary reaching `completed` (via the SSE/notification
event), and brief regeneration completing. Existing resources (`'tagReports'`, `'insights'`, etc.)
are untouched — Command Center does not invalidate them, since it doesn't mutate their underlying
data.

## What Command Center depends on from other features (and what happens if they're not ready)

- **Tag Report's citation-erasure redaction hook** (DESIGN.md §4.5 AC-3) — does not exist yet.
  Insight-citation in `org_brief_graph.py` is fully built but gated off (`ORG_BRIEF_ENABLE_INSIGHT_CITATIONS=false`).
  Flipping it on once the hook lands is a one-line env change, no code change, no migration.
- **`survey_tags`/`survey_tag_mappings`** (Tag Report's own tables) — hard dependency, already
  shipped on this branch lineage. If a survey has zero tags, it simply doesn't appear in any
  tag-scoped view; nothing errors.
- **`alert_events`/`alert_rules`** (existing alerting system) — hard dependency for anomaly
  alerts and survey health's `anomaly_count`. If this system is ever renamed/restructured,
  `survey_health_summary`'s materialized view definition and `org_signal_detector`'s writes both
  need updating together.

## Known gaps (see TRACKER.md §8 for the full list with reasoning)

⌘K global command bar, load testing at scale, automated Lighthouse/WCAG scans, and full
`npsColor()`/`HealthPill` unification across pre-existing pages are explicitly deferred, not
silently missing — each has a one-line reason in the tracker.
