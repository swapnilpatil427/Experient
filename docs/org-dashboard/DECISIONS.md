# Org Intelligence Dashboard — Decision Log

Append-only. See `TEAM.md` for the entry format and escalation rules.

---

## Decision 31: Full 7-persona production-readiness audit — 24 confirmed bugs fixed, 8 deferred with reasoning

**Date:** 2026-07-06
**Decision-maker:** Engineering, in response to a direct product request to review the feature "very carefully" for production readiness before real customers touch it.
**Context:** A 7-persona expert panel (enterprise customer, mid-market/SMB customer, AI/ML engineer, professional services, marketing, sales, UX designer, product/platform engineer) each independently read the actual shipped code — not the design docs — and traced real behavior at realistic scale. This surfaced 24 confirmed, independently-verified bugs spanning AI correctness (raw survey UUIDs in customer-facing text, a failed narrative silently scoring as maximum trust, manual summaries never being verified due to a missing schema column), operational risk (a scheduler bug that could permanently prevent the weekly brief from ever auto-firing in a stable deployment, a confirmed Redis thundering-herd path, zero rollout control despite a proven gating pattern already existing elsewhere in the codebase), and UX correctness (a dead permalink, a null trust state rendering as if verified, broken/missing accessibility labels, unstyled dark-mode components).
**Decision:** Fixed all 24 confirmed bugs across three parallel tracks (CrystalOS/AI, backend, frontend) plus one additional fix found during integration (a missing safety log for the citation-compliance flag). Full list and reasoning in `docs/org-dashboard/PRODUCTION_READINESS_AUDIT.md`. Explicitly deferred 8 items with written reasoning rather than silently dropping them — most significantly, a full incremental-refresh redesign of the materialized views (confirmed real and serious, but a correct fix requires verifying exactly what date range every downstream KPI needs against a live database, which this environment cannot provide; a rushed fix risks a worse, silent correctness regression than the current, at least honestly-documented, scale limitation).
**Verification:** Backend suite 1364/1364 passing (1361 baseline + 3 new gate tests), `tsc` clean on both `app/` and `backend/`, CrystalOS graph compiles and imports cleanly, 6/6 new `org_brief_verify.py` tests passing, 3 EVALS.md cases hand-traced against the modified detector code with no change to documented expected outputs.
**Reversibility:** Mixed. Most fixes are additive (new columns, new indexes, new middleware, new event types) and trivially reversible. The scheduler cadence change (daily→hourly for two jobs) and the plan-tier gate are the two with the broadest behavioral effect — both are env-var-controlled and can be reverted without a code change.

---

## Decision 30: Brief Provenance Panel is the "trail" for org briefs — audit-surface disclosure rules apply, not the live card's suppression rules

**Date:** 2026-07-05
**Decision-maker:** Engineering (in response to a direct product question: "can the user see what generated the report," "could we utilize trails view for this one")
**Context:** No shared trail/timeline component exists anywhere in this codebase to reuse (`InsightTrailPage.tsx` and `TagReportTrailPage.tsx` are both fully bespoke). `BriefArchive.tsx` already provides the chronological-list-plus-inline-expand shape the org level needs — building a second, parallel full-page trail view would duplicate that navigation structure for no benefit.
**Decision:** Add `BriefProvenancePanel.tsx` as a second inline-expand trigger ("How was this generated?") inside each already-expanded `BriefArchive` entry, sibling to the existing "Compare to previous" trigger — not a new page or route. Unlike the live `CrystalBriefCard` (a verdict surface, per Decision 16, where a "pass" trust badge must never render inline), this panel is an explicit, opt-in audit surface and shows the full 3-pass trust breakdown plainly (numeric+LLM grounding verdict, and any `pass_3_grounding_completeness.grounding_failures` clauses) — Decision 16's suppression rule governs the at-rest primary read, not this deeper, deliberately-clicked-into disclosure level.
**Rationale:** Matches Decision 16's own "same disclosure depth as history itself, not the primary read" principle, applied to a new case (full generation provenance) rather than just checkpoint comparison.
**Reversibility:** Easy — additive component and endpoint, no schema change.

---

## Decision 29: Crystal's org-chat follow-up is grounded via a synthetic insight, not a new CrystalOS contract field

**Date:** 2026-07-05
**Decision-maker:** Engineering (in response to a direct product question: "can Crystal ask queries across the org report")
**Context:** "Ask a follow-up" on the Crystal Brief Card opened the pre-existing general org-portfolio Crystal chat, whose context loader (`loadCrystalContext`) independently re-derives insights/topics/metrics from scratch — it never read the specific `org_crystal_briefs` row on screen, so Crystal's answer wasn't guaranteed to reference, or even agree with, the visible brief. Investigation found `CrystalInput.metrics` (the generic dict field) is parsed by a narrow, fixed formatter (`_build_metrics_context`, reads only `nps`/`csat`) that would silently ignore anything else stuffed into it — but `_build_insights_context` is generic and renders full narrative text for any dict in the `insights` list carrying a real `layer` value.
**Decision:** Ground the follow-up entirely on the Node backend: `loadCrystalContext` gains an optional `briefId` param; when present, it fetches that brief (org-scoped), resolves each recommendation's `survey_id` to a title, and prepends one synthetic insight-shaped dict (`layer: 'prescriptive'`, narrative = brief text + numbered recommendations with resolved survey names) into `ctx.insights`. Zero CrystalOS/Python changes. The client threads the viewed brief's id through as `CrystalCtx.focused_brief_id` → request body `brief_id`, mirroring the existing `focused_tag_id` pattern exactly.
**Alternatives considered:** Adding a dedicated `brief_id`/`org_brief` field to CrystalOS's `CrystalInput` model and a matching formatter (rejected — more surface area for the same outcome, and the existing insights-formatter already does exactly what's needed with zero new Python code, which is a stronger "build vs. reuse" fit).
**Reversibility:** Easy — purely additive on both sides; removing `attachBriefGrounding`'s call site reverts to prior behavior exactly.

---

## Decision 28: Auto-scheduled weekly brief generation — env-tier cadence, not a new "daily period" concept

**Date:** 2026-07-05
**Decision-maker:** Engineering, per explicit user instruction ("Implement automatically weekly in staging or Production. 1 day in Dev")
**Context:** The brief only ever generated on-demand (manual "Regenerate" click) — no scheduled trigger existed anywhere, a real gap against the original ARCHITECTURE.md intent ("the graph runs once per org per week, triggered by the backend scheduler") that none of the original parallel build agents actually built.
**Decision:** New job `orgCrystalBrief.job.ts`, registered on the existing registry's daily tick (mirroring `orgTopicTrends.job.ts`'s own "tick daily, self-gate inside the handler" pattern, since the registry has no day-of-week primitive). The handler self-gates on environment tier (`NODE_ENV === 'production'` → production; `NODE_ENV === 'staging'` or `AGENTS_ENV === 'staging'` → staging; else dev): production/staging only proceed past the gate on Monday UTC (real weekly cadence, one brief per org per ISO week); dev proceeds on every tick. Dev-tier ticks do **not** introduce a new daily-period shape — they regenerate the same current-ISO-week range every time, landing on the same upsert-on-`(org_id, date_range_start)` row the manual regenerate button already targets, just automatically and more often, so a developer isn't stuck waiting a week to see the automation work.
**Also shipped as part of this decision:** a real eligibility gate (`BRIEF_MIN_SURVEYS = 3`, `BRIEF_MIN_DATA_DAYS = 14`, shared between the per-org and batched-all-orgs eligibility queries) — previously the "Crystal needs at least 2 weeks of data from 3 programs" empty-state copy existed with no actual check wired to it anywhere (`minDataMet` was always `true` in practice). Sequential per-org processing with a small configurable delay (`ORG_CRYSTAL_BRIEF_INTER_ORG_DELAY_MS`, default 2s) and per-org error isolation — one org's CrystalOS failure never aborts the sweep for the rest.
**Reversibility:** Easy — new job, additive `minDataMet` field, no schema change. Disabling: `JOB_ORG_CRYSTAL_BRIEF=false`.

---

## Decision 27: Recommendation JSONB — resolve snake_case/camelCase and tagId naming during integration

**Date:** 2026-07-04
**Decision-maker:** Engineering (integration pass)
**Context:** Four parallel workstreams built against the same `org_crystal_briefs.recommendations` JSONB shape without a live shared type to compile against. `org_brief_graph.py` wrote raw Python/SQL-native snake_case keys (`survey_id`, `action_type`, `source_insight_ids`, and — per the ambiguity the CrystalOS engineer flagged in their own handoff report — both `tag_group_id` and `tag_id`, always null). The backend passed the JSONB array through as `unknown[]` with no transformation. The frontend's `CrystalBriefRecommendation` TypeScript type declared camelCase fields (`surveyId`, `actionType`, `tagGroupId`) and was missing `sourceInsightIds` entirely. Caught during the integration pass by tracing `CrystalBriefCard.tsx`'s actual render logic (`rec.surveyId ? <Link>... : <span>...`) against what the JSONB would really contain at runtime: every recommendation's `surveyId` and `actionType` would have been `undefined`, silently disabling the survey drill-down link (Decision 17's "shortcut" navigation rule) and always falling back to the default icon, on every brief, in production.
**Decision:** Added a single `mapRecommendation()` function in `backend/src/services/org-metrics.service.ts` — the one place recommendations are read for client consumption — that maps snake_case → camelCase and resolves the tag-field ambiguity to `tagId` (canonical, since a "tag group" is a `survey_tags` row per Decision 23, not a `tag_group_id`). Updated `CrystalBriefRecommendation` (both the backend service type and `app/src/types/orgDashboard.ts`) to include `sourceInsightIds: string[]`, which existed in the DB shape and CrystalOS's output but had no frontend type field at all. `org_brief_graph.py` itself was left unchanged (it already defensively emits both tag-field names); the mapper's fallback chain (`tag_id ?? tagId ?? tag_group_id ?? tagGroupId`) absorbs the ambiguity at the read boundary instead.
**Verification:** Full backend test suite re-run after the fix (1353/1353 passing, no regressions), `tsc --noEmit` clean on both sides.
**Rationale:** Fixing this at the single service-layer read site is lower-risk than editing the CrystalOS write site (which would require re-verifying the graph's own EVALS.md traces) and is the natural boundary for a snake_case (DB/Python) ↔ camelCase (TS/JSON-over-the-wire) translation in this codebase's existing conventions (no other JSONB column read by this service is passed through untransformed).
**Reversibility:** Easy — additive mapping function, no schema change, no API contract change (the wire shape was always meant to be camelCase; this just makes it actually be that).

---

## Decision 26: No new role-gating system for Hub teaser elements

**Date:** 2026-07-04
**Decision-maker:** Engineering (implementation-time reconciliation)
**Context:** Decision 18 requires the Hub teaser additions to reuse "the exact permission check that already gates Tag Report access today." A direct audit of every Tag Report page/component/hook found no role or permission check anywhere — Tag Report is open to any authenticated org member today.
**Decision:** The 5th KPI tile, Weekly Brief card, and Tag Groups strip render for all authenticated org members, matching Tag Report's actual current access model. No new permission system is introduced speculatively.
**Alternatives considered:** Invent a VP/C-suite role check for this feature alone (rejected — would create a permission model Tag Report itself doesn't have, and TEAM.md's Build vs Reuse rule explicitly requires reusing what exists, not inventing new structure to satisfy a doc's assumption that turned out to be false).
**Reversibility:** Easy — additive; a role check can be layered on later if a real role system is introduced platform-wide.

---

## Decision 25: benchmark_nps lives on org_profiles, not organizations

**Date:** 2026-07-04
**Decision-maker:** Engineering (implementation-time reconciliation)
**Context:** ROADMAP.md Phase 5 specifies `ALTER TABLE organizations ADD COLUMN benchmark_nps`. No `organizations` table exists anywhere in this codebase — org identity is Clerk-owned, represented as a bare `TEXT` org_id with no local table, confirmed by direct migration audit.
**Decision:** Add `benchmark_nps INTEGER CHECK (benchmark_nps BETWEEN -100 AND 100)` to `org_profiles` (the existing per-org settings table; every existing column there is nullable or defaulted, so this is a safe non-locking addition).
**Reversibility:** Easy — single nullable column.

---

## Decision 24: Citation-bearing org briefs ship behind a flag, defaulted off

**Date:** 2026-07-04
**Decision-maker:** Engineering (implementation-time reconciliation)
**Context:** Decision 16 item 1 makes shipping citation-bearing briefs (anything containing `source_insight_ids`) to production a hard, non-negotiable release gate until Tag Report's citation-erasure redaction hook (DESIGN.md §4.5 AC-3) is approved and wired in. A direct code audit (grep across `crystalos/` and `backend/src` for redaction/erasure logic near citations) confirms that hook does not exist anywhere — it is described in Tag Report's own docs as pending an unresolved business-stakeholder decision, not yet implemented.
**Decision:** Build the full insight-consumption pipeline in `org_brief_graph.py` (headline-only grounding, `source_insight_ids` citation, `verify_and_score`) exactly as designed in Addendum 2, but gate it behind an environment flag `ORG_BRIEF_ENABLE_INSIGHT_CITATIONS` defaulting to `false`. With the flag off, `aggregate_org_metrics` skips the insight-retrieval query entirely and `synthesize_narrative` produces the numbers-only narrative. This ships real value now (weekly briefs, health scores, signal detection, brief archive) without violating the compliance gate, and flipping the flag is a one-line change once the redaction hook lands elsewhere.
**Alternatives considered:** (a) Ship citation-bearing briefs now on the reasoning that we only store `headline` text and pointers, never raw verbatims, so the GDPR risk is lower than the gate implies — rejected, because Decision 16 defines "citation-bearing" as "containing `source_insight_ids`" full stop, not conditioned on whether raw quotes are present, and the instruction is explicit that this is non-negotiable. (b) Skip insight-consumption entirely until the hook ships — rejected, wastes the opportunity to have the code ready to flip on immediately.
**Reversibility:** Easy — single flag flip once the upstream redaction hook exists.

---

## Decision 23: Anomaly alerts reuse alert_events; no new survey_anomalies table

**Date:** 2026-07-04
**Decision-maker:** Engineering (implementation-time reconciliation)
**Context:** ARCHITECTURE.md assumes a pre-existing `survey_anomalies` table. No such table exists. A direct audit instead found a complete, already-shipped alerting system (`alert_rules`/`alert_events`/`alert_subscriptions`/`alert_history`) with exactly the shape `AnomalyAlerts` needs: nullable `survey_id` (NULL = org-wide), `severity` (critical/warning/info/success), `status` (active/acknowledged/snoozed/resolved), and a `source` column (`'rule'|'crystal'|'system'`) already designed to accommodate AI-detected, rule-less alerts.
**Decision:** `survey_health_summary.anomaly_count` counts `alert_events` rows with `status = 'active'` per survey. The new `org_signal_detector` skill writes its cross-survey signals into `alert_events` with `source = 'crystal'`, `rule_id = NULL`, and `survey_id` set only when a signal centers on one program (NULL for genuinely org-wide signals). `PATCH /api/org/dashboard/alerts/:id/acknowledge` updates `alert_events.status`. No new anomaly-storage table is created.
**Rationale:** Per TEAM.md's Build vs Reuse rule — this table already covers the need, including the AI-detected/rule-less case the design explicitly wanted.
**Reversibility:** Easy — purely additive rows into an existing table; no schema changes to `alert_events` required.

---

## Decision 22: Real-time layer uses SSE, not a new WebSocket stack; scheduled refresh uses the app-level scheduler, not pg_cron

**Date:** 2026-07-04
**Decision-maker:** Engineering (implementation-time reconciliation)
**Context:** ARCHITECTURE.md and ROADMAP.md Phase 3 specify a new `ws`-based `WebSocketServer` (`org-realtime.service.ts`) for the KPI live counter and anomaly alerts, and pg_cron for materialized view refresh schedules. A direct audit found: (a) no `ws` npm dependency and no `WebSocketServer` usage exists anywhere in the backend — all existing real-time push in this codebase is Server-Sent Events over Redis pub/sub (`backend/src/routes/notifications.ts`); (b) the local/prod Postgres image is a custom `pgvector/pgvector:pg16` build with no `pg_cron` extension installed, while a mature application-level scheduler already exists (`backend/src/scheduler/`, setInterval-based jobs) with multiple precedents (`docAutoApprove.ts`, `eventEngine/processor.ts`'s `cronTick`/`alertSweep`, a dedicated `scheduler` Docker service).
**Decision:**
1. KPI live counter and anomaly-alert real-time delivery (the two cases Decision 21 confirmed still need a live channel) are delivered via a new SSE route (`GET /api/org/dashboard/stream`) backed by a new Redis pub/sub channel (`org:{orgId}:events`), following the exact pattern already proven in `notifications.ts`. `useOrgDashboardLive.ts` wraps `EventSource`, not `WebSocket`.
2. Materialized view refreshes (`org_metrics_daily` 15-min, `survey_health_summary` hourly, `org_metrics_weekly`/`org_topic_trends`/`org_health_score` daily) run from new jobs under `backend/src/scheduler/jobs/`, using the existing setInterval-based runner, executing `REFRESH MATERIALIZED VIEW CONCURRENTLY` over a plain pg client — not pg_cron.
**Rationale:** Per TEAM.md's own Build vs Reuse rule and the same logic Decision 21 already applied to the manual-summary/compare/trust-score flows — building a second, parallel real-time transport (WebSocket) and a second, parallel scheduling mechanism (pg_cron) alongside working, proven equivalents that already exist in this codebase is exactly the kind of uncosted infrastructure duplication the team's own decision framework exists to prevent. This is a broader application of Decision 21's reasoning to the two real-time cases Decision 21 explicitly left in place, not a reversal of it.
**Reversibility:** Easy — additive new route/channel/jobs; no schema impact. If genuine WebSocket bidirectional needs emerge later (none identified today), this can be layered on without touching the SSE path.

---

## Decision 21: Live-update mechanism — resolved (closes an item open since the first design round)

**Date:** 2026-07-01
**Decision-maker:** Joint Architecture Review (Dariusz, Yuki, Amara, Jordan)
**Context:** Flagged as unresolved across four separate design rounds: which mechanism notifies the UI when a manual summary finishes generating, given the user may navigate away mid-job. Three candidates were on the table: page-scoped polling, a new `useOrgDashboardLive` WebSocket hook, or the existing app-wide `notification_events`/SSE system.

**Decision:** Use the existing `notification_events`/SSE stream (`/api/notifications/stream`) for all three cases that needed a live-update answer:
1. **Manual summary completion** — the bell/toast notification consumer gains a new event-type handler. No polling as a completion contract (in-dialog polling may still show cosmetic progress text while the page happens to be open, but the actual "done" signal is the SSE event).
2. **"Compare to previous" readiness** — subscribes to the same stream, keyed by `(org_id, period_key)`, since manual regeneration upserts onto the same brief row per period.
3. **Trust/hallucination score arriving after the rest of the brief** — a second SSE payload (`brief_trust_score_ready`) patches the already-open Crystal Brief Card's confidence indicator in place, closing the cache-ordering race flagged in ARCHITECTURE.md's Addendum 2.

**No WebSocket infrastructure is needed for this feature.** This is a net reduction in planned scope, not just a resolved ambiguity — `useOrgDashboardLive` is not required for the generation/comparison/trust-score flows; the org-dashboard real-time layer (still needed for live KPI response counters and anomaly alerts, per the original v1 design) is unaffected and stays scoped to exactly that.

**Rationale, against the team's own "Real-time Cost vs. Latency" decision tree (TEAM.md):** none of these three cases are "the user is actively watching a number change" (the only branch that justifies WebSocket cost) — the defining premise is the opposite: the user may have left the page. Reaching for a new WebSocket hook here would have been exactly the uncosted real-time expansion that decision tree exists to block, and would have required a written Decision Log justification (per TEAM.md's own rule) that never materialized across four rounds of flagging this as open. The existing SSE/`notification_events` system already satisfies the actual requirement (survives page unmount) with zero new infrastructure.

**Reversibility:** Easy — additive event-type handlers on an existing consumer, no new service or schema.

---

## Decision 20: Figma is blocked — pivot to an exceptionally detailed written design spec, not code

**Date:** 2026-07-01
**Decision-maker:** Stakeholder
**Context:** TEAM.md mandates Marcus produce Figma designs for all sections before engineering begins. Figma access is not currently usable (the same class of blocker Tag Report's own Appendix B hit — "Figma file creation was blocked this round by a view-only seat"). An initial version of this decision proposed building coded React component prototypes as the substitute artifact — the stakeholder corrected this: **no code is to be written at this stage.** Design and UX specification only.

**Decision:** Skip Figma for this feature, and do not substitute it with code either. Instead, raise the written design spec itself to Figma-equivalent precision — exact spacing, color values, motion timing/easing curves, component anatomy, and state-by-state behavior described in enough detail that an engineer could build it without ambiguity, the same bar a redline'd Figma file would need to clear. This applies specifically to the components that were still under-specified relative to the rest of `DESIGN.md`: the Weekly Brief card, Tag Groups strip, generation status chip, and `CheckpointDiffPanel`.

**Rationale:** The gap TEAM.md's Figma mandate exists to close is ambiguity between design intent and what gets built — that gap can be closed by precision of specification, not only by a visual tool. Given Figma is unavailable, the fallback is more rigorous prose, not code, since building code without the underlying design/UX decisions being fully settled first would risk locking in choices before they've had proper design scrutiny.

**Reversibility:** Easy — nothing prevents producing Figma files later from this written spec if Figma access is restored.

---

## Decision 19: Failure states, responsive design, and loading states closed; multi-org switcher descoped; honest remaining-gap inventory

**Date:** 2026-07-01
**Decision-maker:** Stakeholder
**Context:** Following Decision 18's cross-team sign-off, the stakeholder asked for the design to be closed out end-to-end: failure states, full responsiveness, loading states, and an honest completeness check.

**Decision:**
1. Multi-org switcher for CX agencies is explicitly out of scope for this design (not deferred-with-a-plan — simply not designed against speculatively).
2. The Hub-vs-full-page split is now explicit: `/app/experience` shows teasers only; the complete Command Center (Brief Archive, manual generator, full Tag Intelligence grid, alerts, Checkpoint Compare) lives at `/app/experience/org/trends`.
3. Failure states, responsive behavior (mobile/tablet/desktop), and loading states are specified for every component introduced this session — see `DESIGN.md`'s three new sections.

**Honest remaining gaps — not closed by this decision, named explicitly rather than implied-done:**
- **War Room Mode (dark theme) tokens are not yet verified for any component added this session** (Weekly Brief card, Tag Groups strip, `CheckpointDiffPanel`, the generation status chip). Theo's original dark-mode spec predates all of them.
- **The live-update mechanism (WebSocket vs. notification-events vs. polling) is still unresolved** — this requires an actual Architecture Review conversation (Dariusz, Yuki, Amara, Jordan), not further doc-writing.
- **No Figma artifacts exist for anything designed this session**, despite TEAM.md's mandate that Marcus "produce Figma designs for all 9 sections... before each phase begins engineering." Everything to date is a thorough written spec, not a visual mock — the same gap Tag Report's own Appendix B hit (blocked by Figma seat access) applies here by omission, not by blocker.
- **No usability testing has occurred** — TEAM.md mandates at least 2 sessions per phase with real users before sign-off; none are possible within a design-only exercise.
- **`CheckpointDiffPanel`'s mobile layout is now specified, but the component itself still has no visual mock** — only written interaction/layout rules.

**Reversibility:** N/A — this decision records completion status, not a technical or product choice.

---

## Decision 18: ExperienceHubPage integration — resolved, additive-only, jointly signed off

**Date:** 2026-07-01
**Decision-makers:** Stakeholder (constraint), Marcus Osei (revised design), Morgan and Sam of Tag Report (joint cross-team sign-off — this closes the pending item from Decision 17)
**Context:** Decision 17 proposed merging Command Center's hero into `ExperienceHubPage` by role-conditionally *replacing* the existing `crystalOpening` narrative, and flagged that the merge conflicted with Tag Report's Appendix C reasoning, requiring Morgan/Sam's actual sign-off before implementation. The stakeholder then imposed a hard constraint — verified against the real, shipped `ExperienceHubPage.tsx` (962 lines) — that no existing content may be removed, hidden, or replaced for any user; changes must be pure amendments. This decision replaces Decision 17's "role-conditional replace" design with a strictly additive one and records the actual sign-off obtained.

**Final design (all four elements are pure insertions — nothing in `ExperienceHubPage.tsx` §1–§5 is touched or removed):**

1. **Org Health Score** — a 5th tile in the existing KPI grid (`grid-cols-2 md:grid-cols-4` → `grid-cols-2 md:grid-cols-4 lg:grid-cols-5`), reusing the existing `KpiTile` component verbatim — no new visual vocabulary.
2. **Crystal's Weekly Brief** — a new, distinctly-styled card inserted immediately after the existing `crystalOpening` paragraph (which remains exactly as-is, full weight, for everyone). Binding conditions from sign-off: must use existing card styling already established elsewhere in Command Center's spec (gradient background + border treatment), carry an explicit "Crystal's Weekly Brief for [org]" eyebrow label, and render at **visually subordinate weight** to `crystalOpening` (smaller/secondary treatment, e.g. collapsed-to-one-line with an expand affordance) — one primary hero voice per viewer, `crystalOpening`, always; the Brief is a clearly-labeled secondary artifact, never a competing equal.
3. **Tag Groups strip** — a new section between the existing §3 (Live Intelligence) and §4 (Survey Intelligence Grid). Binding conditions: **hard-scoped at the data layer** (not just a UI filter) to `health_status != healthy` tag groups only — it must be structurally incapable of becoming a general tag browser; inline-expand shows aggregate NPS + top topic only; its only exit is a single CTA performing full navigation to the existing Tag Report route (`/app/experience/tags/:tagId/report`) — it must never render Tag Report's multi-metric/provenance/drill-down machinery inline, which would duplicate rather than tease.
4. **Role-gating** applies only to whether these four new elements render — existing content is unconditional for all viewers, always. The permission check must be the exact one that already gates Tag Report access today — no new parallel permission system.

**Sign-off obtained:**
- **Morgan (Tag Report Product Owner) — APPROVE WITH CONDITIONS.** Verdict: pure insertion resolves the "replacement" risk but not the "cognitive competition" risk on its own — conditions above (subordinate Brief styling, reused permission check, teaser-only strip, progressive disclosure) are what close the gap. Flagged as a metric to watch: if Tag Report's own drill-down/backfill-disclosure engagement metrics (DESIGN.md §5) drop post-launch, that's the signal the strip became real competition for the Reports tab rather than a teaser, and this decision should be revisited.
- **Sam (Tag Report UX) — APPROVE WITH CONDITIONS.** Verdict: coherent, not clutter, if and only if all three narrative-differentiation conditions ship together (distinct container, explicit label, role-gating) — not just the label alone. Requires the Tag Groups strip distinction to be behavioral (data-layer health-status scoping), not cosmetic.

**This closes the "explicitly pending" item from Decision 17.** Implementation may proceed against the final design above.

**Reversibility:** Easy — every element is additive; removing any of the four later restores the page to its current shipped state exactly, with no cleanup required elsewhere.

---

## Decision 17: Navigation strategy — Org → Tag → Survey → Response, role-conditional landing

**Date:** 2026-07-01
**Decision-maker:** Stakeholder, following review from Priya Rajan and Marcus Osei
**Context:** Stakeholder wanted an org head to land on the Org-level report first, then drill into tag-level and survey-level reports. Review found this isn't a blank-slate design — it interacts with an already-shipped page (`ExperienceHubPage`, the current landing content at `/app/experience`) and an already-decided cross-feature placement (Tag Report's Appendix C, its own "Overview | Reports" segmented control).

**Decision:**
1. **Role-conditional hero, not a stacked or replaced one.** `ExperienceHubPage`'s hero slot (currently `crystalOpening`) renders the Command Center hero (Org Health Score, sparkline, Crystal's Weekly Brief, Past Briefs strip) for VP/C-suite-role viewers, and today's unchanged content for everyone else. The shared KPI strip below is extended (WoW delta, sentiment) rather than duplicated.
2. **Drill-down rule:** inline-expand (200ms, matching the existing Programs Table / Brief Archive pattern) when the interaction answers "is this worth my attention" (Org hero → tag group card); full page navigation only when the destination is a genuinely separate trust/audit surface (Tag Report → Survey Insight Trail → Response Detail). Never inline-expand a citation trail into an already-dense page.
3. **Shortcut:** when an Org Brief recommendation's `survey_id` field is populated (the common case per `generate_recommendations`), navigate directly to that survey's Insight Trail, skipping the Tag Report hop. Tag Group is the fallback path only when `survey_id` is null.
4. **Checkpoint-diff (`CheckpointDiffPanel`) stays Org-level only for now.** Tag Report's own comparison primitive (Bracketed Snapshot, DESIGN.md §4.3) is a different shape and should not be forced to converge with Org-level's diff view before the latter has even shipped and proven out.
5. **Accessibility fix required before ship:** `HealthPill`'s status palette and `npsColor()`'s thresholds (used by `SurveyCard`) are not currently unified — stacking Org/Tag/Survey health indicators on one page (especially on mobile, single-column) risks a colorblind/low-vision user being unable to tell which "red" belongs to which hierarchy level. Audit and unify before this ships; ensure text/icon redundancy everywhere color is used, not just in `HealthPill`.

**Explicitly NOT decided here — requires cross-team sign-off:** merging Command Center's hero into `ExperienceHubPage` genuinely conflicts with Tag Report's own Appendix C reasoning (Morgan/Sam explicitly rejected embedding dense, deliberately-triggered report experiences into the Hub — "bloat the Hub into two different products on one page" — and Command Center's hero is denser than what they rejected). This is not Command Center's team's call to make unilaterally. **Proposed compromise, pending Morgan/Sam's actual approval:** Org hero above the fold (role-gated) + "Overview" tab unchanged (survey creators) + "Reports" tab unchanged (Tag Report's existing address). Do not implement the `ExperienceHubPage` merge until this sign-off is obtained and recorded as its own decision (in either this log or Tag Report's).

**Also flagged, unresolved:** CX agencies (GTM.md tertiary ICP) break silently under this model — there is no multi-org switcher concept in the current design, and agencies should not simply inherit the same role-gate as internal org admins. Tracked as an open item, not solved by this decision.

**Reversibility:** Easy for items 2–5 (additive UI patterns). Item 1 is reversible but touches a shipped page — should not be implemented ahead of item's cross-team sign-off resolving.

---

## Decision 16: Full-design review round — keep the LLM narrative, adopt all raised guardrails

**Date:** 2026-07-01
**Decision-maker:** Stakeholder, following a full internal-team review (all 9 TEAM.md members) plus two independent outside reviews (an unaffiliated AI/ML systems reviewer and a skeptical real-world VP-of-CX persona)
**Context:** A full review of the cumulative design (Decisions 12–15) surfaced a fundamental question from both outside reviewers independently: should the org brief remain an LLM narrating over other LLMs' insights (current design), or ship v1 as a structured view of real cited insights + deterministic signals with no extra narrative LLM call? The stakeholder chose to keep the LLM narrative. This decision records the full set of guardrails and fixes raised during the review that must now be implemented as a condition of that choice.

**Decision:** Keep `synthesize_narrative` consuming real survey-level insights as designed in Decision 14. Adopt, as binding scope, every fix below:

1. **GGDPR/compliance sequencing (highest severity — Jordan's finding):** Org Dashboard must not ship citation-bearing briefs (real respondent verbatims in `org_crystal_briefs`/`org_custom_summaries`) until Tag Report's citation-erasure redaction hook (DESIGN.md §4.5 AC-3) is both approved and actually wired into Command Center's tables as a consumer — not merely "named" as a future consumer. This is now a hard release gate, not a parallel-track nice-to-have.
2. **ROADMAP.md must be updated** to explicitly show Decision 15's Tag Report dependency as a Phase 2 blocker line, the same way Decision 12's prerequisites are already shown — an engineer reading only ROADMAP.md must see the blocker.
3. **Range cap reconciled to 90 days** (Dariusz's recommendation) — the only value that satisfies both the servability constraint (Addendum 1) and the signal-logic-validity constraint (Amara's guards), since the 12-month option was conditional on guards that are themselves unshipped, review-gated scope.
4. **Cost model re-baselined to "1 guaranteed + 1 conditional LLM call per brief"** (Amara) — the hallucination scorer's LLM-grounding fallback fires whenever deterministic numeric-match confidence is below 0.80, which is expected to be common, not rare, once qualitative claims enter the narrative via `grounding_insights_text`. All latency/cost estimates (`estimatedSeconds` on the regenerate endpoint, eval budget) must reflect this.
5. **Hallucination scoring and lineage/delta computation split out of the main `org_brief_graph.py` DAG into a post-publish step** (Amara) — neither has a dependency on the synthesis nodes' live state beyond the already-persisted `narrative`/`input_snapshot`, so keeping them in-graph adds coupling without benefit, mirroring why Tag Report itself chose a new graph over extending an old one when the shape didn't fit.
6. **Progressive disclosure is mandatory, not optional, for all new trust/citation/comparison UI** (Marcus, Sofia, Theo — independently converged): no inline "pass" badges (only surface on `flag`/`fail`), citations stay click-to-reveal with no added visual weight at rest, "Compare to previous" never renders by default alongside the live brief. Full spec in `DESIGN.md`.
7. **Banned/required copy for trust signaling** (Sofia): never "hallucination," "low confidence," or "unverified" in user-facing copy — use "Crystal's best read" / "Early read" / "How sure is Crystal?" instead. Added to `GTM.md`'s Names to Avoid.
8. **Reuse `ConfidenceChip`, do not fork a new trust-token system** (Theo) — same underlying question ("can I trust this text?") as the existing survey-level Reliable/Indicative/Low-signal vocabulary; map `hallucination_score`'s `pass/flag/fail` onto the existing three tiers rather than inventing a fourth state.
9. **Data model fixes** (Leila): add `(survey_id, layer, trust_score DESC)` index to support the new insight-retrieval query; update the `org_report_history` view to expose `parent_checkpoint_id`/`compared_against_brief_id`/a comparability flag; resolve the `trust_score` naming collision between per-insight (`insights.trust_score`, 0-100 int) and per-brief (`hallucination_score`) by using distinct field names, not the same term at two different scales; use `CREATE INDEX CONCURRENTLY` on `survey_responses` and `NOT VALID` + `VALIDATE CONSTRAINT` for the new FK, since both tables may already hold production rows.
10. **"Compare to previous" needs a real UX spec before any frontend work starts** (Yuki, confirmed by Marcus/Theo) — currently only a backend endpoint exists. Marcus owns producing this spec; it is a blocking prerequisite for the feature, not a parallel task.
11. **Citation contract disambiguation** (Jordan): document explicitly in `ARCHITECTURE.md` that `insights.citations_json` (survey-level, read directly by `aggregate_org_metrics`) and Tag Report's `CitationRef.source_insight_id` (used only by cross-survey paths) are two distinct, non-interchangeable citation shapes — a future reader must not assume they're the same contract.
12. **`checkpoint_store.py` org-scope reuse needs an explicit acceptance criterion**, not an assumption — confirm and document the key path used for org-scope blob writes (e.g., a sentinel value in place of `survey_id`).

**Reversibility:** Mixed. Items 6–9, 11–12 are additive/low-risk. Items 1–2 are process/sequencing fixes with no schema impact. Item 5 (graph restructuring) is a design change that should happen before any `org_brief_graph.py` code is written, since it's much cheaper to design correctly upfront than to refactor after implementation.

---

## Decision 14: Org brief must consume real survey-level insights and score its own trust, not just narrate numbers

**Date:** 2026-07-01
**Decision-maker:** Stakeholder, following an Applied Scientist + CrystalOS Expert technical review
**Context:** As originally specified, `aggregate_org_metrics` only reads pre-aggregated numeric tables (`org_metrics_weekly`, `survey_health_summary`, `org_topic_trends`) — never the survey-level `insights` table (headlines, narratives, `trust_score`, `citations_json`). Review found this makes the weekly brief structurally likely to "feel templated" (Amara's own stated risk in TEAM.md), since the LLM narrating it has no qualitative material to draw from.

**Decision:** Adopt both recommendations in full:
1. The org brief (all three modes) consumes top-trust-score survey-level insights as grounding input to `synthesize_narrative`, with citations traceable to specific `insights.id` rows (`source_insight_ids` on each recommendation).
2. The org brief gets its own hallucination/trust-scoring pass (reusing the existing `score_insight()`/`hallucination_scorer.py` numeric-grounding check) before publish, since consuming LLM-generated insight text makes it a synthesis-of-a-synthesis with compounding hallucination risk.

Full technical spec: `ARCHITECTURE.md`, "Addendum 2: Insight Consumption, Trust Scoring, and Checkpoint Lineage."

**Alternatives considered:** Ship the numbers-only brief as originally spec'd and revisit only if user feedback confirms it feels templated (rejected — the risk was identified pre-emptively with a known, cheap fix available; no reason to ship the known-worse version first).

**Reversibility:** Moderate — the citation/trust-scoring additions are additive schema (new JSONB fields, new columns), but they add LLM calls (insight retrieval doesn't need one; the hallucination pass does) to every brief generation, which is a real cost/latency change from the original design, not purely additive.

---

## Decision 15: Org report checkpoint lineage adopted for Automated/Manual; sequencing dependency on Tag Report locked in

**Date:** 2026-07-01
**Decision-maker:** Stakeholder
**Context:** (1) The org-dashboard design had no checkpoint/lineage system — "Brief Archive" was a flat list with no real trail of how a brief's numbers changed week to week. (2) Tag Report is now confirmed to ship before Org Dashboard, and Org Dashboard's citation design (Decision 14) has a hard dependency on Tag Report exposing `source_insight_id`-level citations and a Response Detail viewer — neither of which were binding acceptance criteria in Tag Report's (final, implementation-ready) `DESIGN.md` at the time of this review.

**Decision:**
1. Adopt checkpoint lineage for Automated weekly briefs (`parent_checkpoint_id`/`delta_from_prior` directly on `org_crystal_briefs`, reusing `tools/delta.py`) and Manual regeneration (links into the same chain, does not fork). Custom Range summaries remain standalone by design, with an optional `compared_against_brief_id` pointer.
2. Tag Report's `docs/tag-report/DESIGN.md` has been updated (new §4.5 "Citation Contract & Response Viewer — Cross-Feature Dependency") to promote the `source_insight_id` citation field, the Response Detail viewer (R-T5), and the citation-erasure redaction hook from TRACKER.md implementation notes to **binding Section 4 acceptance criteria**, since DESIGN.md — not TRACKER.md — is the document marked final/binding for Tag Report's implementation handoff.
3. Org Dashboard's insight-consumption work (Decision 14) is blocked on Tag Report's §4.5 AC-1 shipping — this is now an explicit cross-feature sequencing dependency, not an assumption.

**Alternatives considered:** Have Org Dashboard build its own independent survey_id/insight_id citation resolution, decoupled from Tag Report (rejected — duplicates work Tag Report is already positioned to do correctly once, and risks two divergent citation schemas across the platform).

**Rationale:** Tag Report ships first; its citation contract becomes the platform-wide citation primitive rather than a Tag-Report-specific one. Fixing the gap in Tag Report's own DESIGN.md before its implementation begins is far cheaper than discovering the mismatch after Org Dashboard starts building against it.

**Reversibility:** Easy for the Org Dashboard schema additions (additive, reversible). Harder for the Tag Report DESIGN.md promotion if Tag Report implementation has already started elsewhere by the time this is read — flag immediately to Devon (Tag Report Tech Lead) if so.

---

## Decision 12: Scope and phasing for Org Insight History and Manual Custom-Range Summary

**Date:** 2026-07-01
**Decision-maker:** Priya Rajan (recommendation), overridden by stakeholder decision
**Context:** Two capabilities were approved for design that are not in the original v1 scope: (1) a browsable history of past org-level reports, and (2) an on-demand, user-triggered summary for an arbitrary date range, mirroring the existing per-survey Custom Analysis feature.

**Decision:** Both features ship together in the same phase, rather than Priya's recommended sequencing (History first; Manual Summary deferred to a later phase pending weekly-brief telemetry).

**Alternatives considered:**
- Priya's original recommendation: History added to Phase 2 (low-risk, additive read over existing data); Manual Summary deferred to Phase 4+, gated on weekly-brief action-rate telemetry validating the AI narrative quality first.
- Ship both now (chosen).

**Rationale:** Stakeholder priority overrides the phased-risk-reduction sequencing. Accepted explicitly as part of this decision: the technical prerequisites Amara and Dariusz identified as blocking for Manual Summary are **not waived** by this decision — they must still be resolved before Manual Summary ships, specifically:
- A single, reconciled max date-range cap (Dariusz proposed 90 days for matview-servability; Amara proposed 12 months for signal-logic validity — engineering must converge on one number, not ship with two different limits).
- Amara's signal-logic guards for non-week-aligned ranges (`identify_top_programs` velocity normalization, `detect_org_signals`' "two weeks ago" comparison) must be implemented, not skipped, since these break silently outside the weekly cadence.
- A minimum 6–8 new eval cases for custom ranges (short/medium/long) per Amara, in addition to — not instead of — the existing 10 weekly-brief cases.
- A dedicated org-scale credit cost curve (Jordan flagged that reusing the survey-level `resolveCustomCost` tiers unchanged will systematically undercharge org-wide corpora).

**Reversibility:** Easy — both features are additive to existing contracts; shipping them together vs. sequenced does not change the underlying schema or API design, only the delivery timeline and the amount of concurrent engineering risk carried in one phase.

---

## Decision 13: "Futuristic" is a design direction, not a customer-facing word

**Date:** 2026-07-01
**Decision-maker:** Stakeholder, following Sofia Reyes's positioning review
**Context:** The stakeholder's brief for this design round asked for "the easiest thing to use, futuristic UI." Sofia's GTM review flagged that literally marketing this as "futuristic" risks reading as "unproven / beta" to a risk-averse enterprise VP buyer — directly undercutting Command Center's core pitch ("this should already exist, and now it does").

**Decision:** Keep all the novel micro-interactions this design round produced (the crystal-motif status chip for in-progress generation, the shimmer-on-first-view treatment for freshly synthesized briefs, the animated timeline entry for new history items). Do not use the word "futuristic" — or close synonyms like "sci-fi," "next-gen" — in any customer-facing copy, tooltip, marketing material, or GTM.md positioning language. Internal engineering/design docs may continue to describe these as advanced/ambient interaction patterns for clarity among the team.

**Alternatives considered:** Keep "futuristic" as the explicit external design/marketing direction (rejected).

**Rationale:** Sofia's proposed replacement framing — "sharp and effortless" / "finally obvious" — delivers the same perceived novelty without the credibility tax. This is a wording and positioning decision only; it does not change any interaction design, animation, or component spec produced in this round.

**Reversibility:** Easy — pure copy/positioning change, no code or schema impact.
