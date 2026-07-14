# Org Dashboard (Command Center) — Reconciled Implementation Spec

Status: binding for this branch (`org-dashboard`, based on `tag-report-final`). Written after a full
ground-truth audit of the codebase against `ARCHITECTURE.md`/`DESIGN.md`/`ROADMAP.md`/`DECISIONS.md`.
Those documents describe the *design intent*; this document reconciles it against what actually
exists so every engineer/agent builds against the same real contracts. Where this doc conflicts with
the older docs, **this doc wins** for implementation purposes. See `DECISIONS.md` Decisions 22-26 for
the rationale behind each divergence.

## Why this doc exists

Ground-truth audit found the original docs assume infrastructure that doesn't exist (`organizations`
table, `survey_responses`, `survey_anomalies`, `tag_groups`, pg_cron, WebSocketServer) and, conversely,
undersell infrastructure that already exists and should be reused (`org_metric_snapshots`,
`survey_metric_snapshots`, `alert_events`/`alert_rules`, `survey_topics`, SSE notification stream).

## Real schema this feature builds on (verified, not assumed)

- `surveys(id, org_id TEXT, title, description, status draft|active|paused|closed, survey_type_id, questions, created_by, publish_token, nps_score, deleted_at, created_at, updated_at)`. Exclude filter is `deleted_at IS NULL` (NOT a status check).
- `responses(id, survey_id, org_id TEXT, answers, nps_score, respondent_id, submitted_at)` — this is the response table (NOT `survey_responses`).
- `response_embeddings(id, response_id FK responses, survey_id, org_id, question_id, text, embedding, language, emotion, aspect, sentiment NUMERIC(3,2) range -1..1, model, created_at)` — sentiment lives here, one row per open-text answer, so aggregate to response grain first (`AVG` per `response_id`) before aggregating to org/day grain.
- `survey_tags(id, org_id, name, slug, color, description, program_config, created_by, created_at, updated_at)` + `survey_tag_mappings(survey_id, tag_id, org_id, created_at)` — many-to-many, max 5 tags/survey (DB-enforced trigger). **There is no `tag_groups` table and no `tag_group_id` column on `surveys`.** "Tag Group" in the design docs = a `survey_tags` row. A survey can belong to 0-5 tags.
- `alert_rules`/`alert_events`/`alert_subscriptions`/`alert_thresholds`/`alert_history` (`supabase/migrations/20260603000016_alerts_core.sql`, `20260603000017_alert_events_system.sql`) — full alerting system already exists. `alert_events.survey_id` is nullable (NULL = org-wide). `alert_events.source` is `'rule'|'crystal'|'system'`. `status` is `'active'|'acknowledged'|'snoozed'|'resolved'`. **This is what `survey_anomalies` was describing — it does not need to be built; it needs to be extended.**
- `org_metric_snapshots(id, org_id, captured_at, active_survey_count, total_responses, avg_nps, avg_csat, avg_completion_rate, top_urgent_topic, top_driver_topic)` — hourly time series, written by `crystalos/scheduler.py::run_org_aggregation()`. No sentiment, no day-grain dedup, no health status. Org-dashboard's `org_metrics_daily` is additive to this, not a replacement — it exists because this table lacks sentiment and a stable day-grain.
- `survey_metric_snapshots(..., response_velocity_7d, anomaly_flag, nps, csat, ...)` — written once per insight-pipeline run, not a fixed cadence.
- `survey_topics(id, survey_id, org_id, ..., health_label emerging|growing|worsening|fading|stable, sentiment fields, time_window)` — exists; org-level "Emerging Topics" rolls this up cross-survey rather than re-deriving topics from scratch.
- `insights(id, survey_id, org_id, layer descriptive|diagnostic|predictive|prescriptive, category, headline, narrative, metric_json, citations_json, trust_score INT 0-100, trust_json, priority, insight_hash, time_window, superseded_by, superseded_at, generated_at)`.
- `agent_runs(id, org_id TEXT, user_id TEXT, thread_id, run_type, status, intent, survey_id NULLABLE FK ON DELETE SET NULL, credit_log, total_tokens, cost_usd, trigger_type, ...)`.
- `org_profiles(org_id TEXT PRIMARY KEY, brand_name, ..., plan_tier, sub_vertical, region, ...)` — all columns nullable/defaulted. This is where `benchmark_nps` goes (there is no `organizations` table).
- No `users` table exists anywhere — all "who did this" columns are bare Clerk-issued `TEXT`, no FK.
- Postgres image is a custom `pgvector/pgvector:pg16` build (`docker/postgres/Dockerfile`) with no `pg_cron`. Scheduling in this codebase is 100% application-level (`backend/src/scheduler/jobs/`, `setInterval`-based, see `backend/src/scheduler/runner.ts`).
- No WebSocket infra exists anywhere (no `ws` npm dependency, no `WebSocketServer`). All server push is SSE + Redis pub/sub (`backend/src/routes/notifications.ts`, `backend/src/lib/redis.ts`).
- `ExperienceHubPage.tsx` (965 lines) has documented `§1-§5` sections; `crystalOpening` (line ~77/104/273-278) is the primary hero narrative and must never be removed/replaced. `KpiTile` is defined inline (lines 614-655), not exported — extract it. KPI grid is `grid-cols-2 md:grid-cols-4` (line 372).
- `OrgTrendsPage.tsx` (34 lines, real, not a stub) is registered at `ROUTES.EXPERIENCE_ORG_TRENDS = '/app/experience/org/trends'` (`app/src/constants/routes.ts:58`) and calls `useOrgOverview()` → `GET /api/experience/org/overview` (`backend/src/routes/experience.ts:477`). This is the page to promote into the full Command Center. Its existing behavior must keep working (additive).
- `ConfidenceChip`/`CitationChip` exist in `app/src/pages/insights/shared.tsx` (lines 54-75, 34-49). `CitationChip` currently has **no click handler** — add one as an optional prop, don't change default behavior for existing callers.
- No `HealthPill` exists anywhere — build fresh, single new unified module.
- `npsColor()` is independently redefined in 6 files — do not refactor all of them (out of scope, risk of breaking unrelated pages). New org-dashboard code uses one new unified palette; note the pre-existing fragmentation as a follow-up in TRACKER.md, not a to-do now.
- No permission/role gating exists on Tag Report today (open to any authenticated org member) — so the Hub teaser additions (5th KPI tile, Weekly Brief card, Tag Groups strip) also render for all authenticated org members. No new role system is invented.
- `openCrystal(query, ctx?)` from `useCrystalPanel()` (`app/src/contexts/crystalPanel.tsx:103`) is the existing "ask Crystal" mechanism used throughout `ExperienceHubPage.tsx` — reuse this for "Ask a follow-up" buttons; there is no generic `CommandBar.tsx` (only `SupportCommandPalette.tsx`, scoped to the support system) so ⌘K global command-bar integration (Phase 5 item) is descoped — documented in TRACKER.md as descoped, not silently dropped.
- `useNotifications.ts` (SSE via native `EventSource` against `/api/notifications/stream`) has one flat `'notification'` event type dispatched through `mapLive()`; new event types are added by extending that mapping, not a per-type switch.
- Two anomaly-detection systems already exist and are survey-scoped: `alertEngine.ts` (deterministic evaluators incl. a working z-score volume-anomaly detector) and `crystalos/lib/ai_triggers.py` (Redis-hysteresis based). `org_signal_detector` (new, org-scope, cross-survey correlation) must **consume** these existing signals/alert rows, not re-implement per-survey anomaly math a third time.

## Reconciliation decisions (recorded in full in DECISIONS.md as Decisions 22-26)

1. **Real-time**: KPI live counter + anomaly alerts use the existing SSE + Redis pub/sub pattern (new route `GET /api/org/dashboard/stream`, new Redis channel `org:{orgId}:events`), not a new WebSocket stack. `useOrgDashboardLive.ts` wraps `EventSource`, exposing the same `isConnected`/`connectionStatus` contract the design calls for, with a manual reconnect-attempt cap (5) before falling back to 2-minute polling.
2. **Scheduled refresh**: materialized views are refreshed by new jobs in `backend/src/scheduler/jobs/` (setInterval-based, matching the existing pattern) that run `REFRESH MATERIALIZED VIEW CONCURRENTLY ...` over a pg client — not pg_cron.
3. **Tag Group → survey_tags**: many-to-many. `ProgramRow.tags: Array<{id,name,color}>` replaces the singular `tagGroupId`/`tagGroupName` from the original doc. Tag-scoped aggregation (`tag_metrics` view, "Tag Groups strip", full Tag Intelligence grid) is keyed by `survey_tags.id` via `survey_tag_mappings`.
4. **Anomaly alerts reuse `alert_events`**: no new `survey_anomalies` table. `survey_health_summary.anomaly_count` = `COUNT(*) FROM alert_events WHERE survey_id = s.id AND status = 'active'`. Org-level Crystal signals (correlated sentiment, velocity collapse, NPS floor breach, bright spot) insert into `alert_events` with `source='crystal'`, `survey_id` NULL for genuinely org-wide signals or a specific survey id when the signal centers on one program, `rule_id` NULL (already nullable per `20260603000017_alert_events_system.sql`). The `PATCH /api/org/dashboard/alerts/:id/acknowledge` endpoint updates `alert_events.status`.
5. **Citation-bearing briefs stay behind a flag**: the CrystalOS insight-consumption path (headline-only, never raw verbatims) is fully implemented but gated by `ORG_BRIEF_ENABLE_INSIGHT_CITATIONS` (default `false`) because Tag Report's citation-erasure redaction hook (DESIGN.md §4.5 AC-3) does not exist in code anywhere — confirmed by direct grep, not inferred. Numbers-only narrative ships to production now; flipping the flag on is a one-line follow-up once the redaction hook lands. This honors Decision 16 item 1's non-negotiable release gate without blocking the rest of the feature.
6. **`benchmark_nps`** goes on `org_profiles` (nullable INTEGER, CHECK -100..100) — there is no `organizations` table to alter.
7. **No new role-gating system** — matches Tag Report's actual current open-access model.

## File ownership (to avoid parallel-agent collisions)

- **Data/migrations**: `supabase/migrations/2026070500000{1..9}_*.sql` (new files only), `backend/src/scheduler/jobs/org*.job.ts` (new files only), registration line in `backend/src/scheduler/runner.ts` (single-line addition, coordinate before editing).
- **Backend**: `backend/src/services/org-metrics.service.ts`, `backend/src/routes/org-dashboard.ts`, `backend/src/services/org-realtime.service.ts` (SSE, not WS), `backend/src/lib/orgSummaryCost.ts` (new `resolveOrgSummaryCost`). Mount line in `backend/src/index.ts` (single-line addition, coordinate).
- **CrystalOS**: `crystalos/graphs/org_brief_graph.py`, `crystalos/skills/org_signal_detector/*`, `crystalos/routers/org_brief.py`, `crystalos/lib/org_brief_verify.py` (verify_and_score). Registration line in `crystalos/main.py` (single-line addition, coordinate).
- **Frontend design system**: `app/src/components/org-dashboard/*.tsx` (all new files), extracting `KpiTile` out of `ExperienceHubPage.tsx` into `app/src/components/org-dashboard/KpiTile.tsx`.
- **Frontend hooks**: `app/src/hooks/useOrgDashboard*.ts`, `app/src/hooks/useOrgDashboardLive.ts`, extending `app/src/hooks/useNotifications.ts` (coordinate — shared file).
- **Frontend pages**: additive edits to `app/src/pages/experience/ExperienceHubPage.tsx` and full rebuild of `app/src/pages/experience/OrgTrendsPage.tsx` — these are the two shared/risk-sensitive files; final integration pass only, after standalone components exist.
- **Shared/integration-only files** (touched once, at the end, by the integration pass): `app/src/locales/en.ts`, `app/src/lib/dataBus.ts` (add `'orgDashboard'` resource), `app/src/constants/routes.ts` (no new routes needed — `EXPERIENCE_ORG_TRENDS` already exists), `backend/src/index.ts`, `backend/src/scheduler/runner.ts`, `crystalos/main.py`.

## Tracking

See `docs/org-dashboard/TRACKER.md` for the full task breakdown, owners, and status.
