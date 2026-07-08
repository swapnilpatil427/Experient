# Xperiq Actions Builder — Rebuild Scope

**Owner:** Maya Okonkwo, Staff PM, Workflow Automation
**Date:** 2026-07-01
**Companion doc:** Rohan's implementation-ready translation of DESIGN.md §"Surface 2: Unified Builder" (parallel workstream — this doc governs *what*, his governs *how*)
**Trigger for this doc:** Stakeholder review of the shipped builder — "generic UX, can't schedule the Weekly Digest template, workflow creation/editing feels inflexible" — plus an explicit ask to validate usefulness before any rebuild work starts.

---

## 1. Usefulness verdict — has the ground shifted since Tom Reyes' review?

Tom Reyes' review (`CUSTOMER_REVIEW.md`, 2026-06-29) was a **design-doc review** — he never touched a running product. His verdict: promising and genuinely differentiated (Crystal Signals — AI-detected triggers — have no competitor equivalent at this price point), but not trustworthy for daily reliance, with gaps concentrated in three places: (1) the product speaks in system vocabulary instead of situations, (2) there's no health signal distinguishing "enabled" from "working," (3) there's no collaboration/ownership model.

Two days and four build waves later (Phase 1–3 + Wave 3b/4, per `TRACKER.md`), I re-ran his verdict against what's actually shipped and real code, not the design doc he reviewed. **The verdict holds, but on narrower and more specific grounds than he could have known:**

- **His core read is still right.** The product is not yet something I'd tell a CX ops manager to rely on Monday morning — but not for the reasons he listed as most urgent. His two most-cited would-be blockers (workflow list health signal, RBAC) are still genuinely absent. But the thing our own stakeholder actually hit — cannot schedule the Weekly Digest — is a gap Tom's review structurally could not have caught, because he was reviewing a design spec that already had a full Schedule Trigger Config Panel on paper (DESIGN.md §2.4). **The bug is that DESIGN.md's specified panel was never built.** What shipped is a raw `cron` string in the `weekly-digest` seed template's JSON config (`supabase/migrations/20260603000018_workflows_v2.sql:79`, `"config":{"cron":"0 8 * * 1"}`) with no UI surface to edit it at all in either `WorkflowBuilderPage.tsx` or `WorkflowCanvasPage.tsx`. This is worse than what Tom reviewed, not the same as it — he was evaluating a spec that promised a human-friendly picker; we shipped neither the picker nor a cron text field.
- **Some ground has genuinely shifted in our favor.** Tom's C-006 (Crystal Builder has no graceful degradation path) is **partially resolved** by what Wave 2/3 actually built. `WorkflowNLBuilderPage.tsx` today has real `low-confidence` / `unparseable` / `timeout` view states (not a blank error), each with a specific next step: low-confidence shows the parsed-but-uncertain workflow with "Edit in Canvas" / "Try rewording" (no bare "Create" button — a deliberate guardrail per the inline comment at line 492); unparseable shows the failure message plus concrete example prompts to try; timeout offers retry or manual-build. This is meaningfully more than "nothing, or an error." It does not yet match Tom's exact three-tier spec (no per-skipped-part explanation on partial parses, no interactive clarifying-question tier) — but the foundation and state machine are there, so closing the remaining gap is copy-and-wiring work, not new architecture.
- **The AI-triggers differentiation Tom praised is now real, not aspirational.** `crystal.sentiment_spike` / `crystal.new_theme_detected` / `crystal.anomaly_detected` are wired end-to-end into the insight pipeline with threshold+hysteresis (Wave 3), and Crystal chat can propose a workflow in natural language through to a real graph workflow (Wave 3b). Tom evaluated this as a paper promise; it now exists, with the caveat (documented honestly in `TRACKER.md`) that thresholds are unvalidated against live traffic and there's no live end-to-end run against real Postgres+Redis+CrystalOS yet.
- **Cooldown is a bigger, more literal gap than Tom's review implies.** Tom's C-004 write-up assumes `cooldown_minutes` exists as an architecture-level default (60 min) that's simply not surfaced in the UI. I checked: **no cooldown or rate-limiting concept exists anywhere in this codebase today** — not in `workflowEngine.ts`, not in `workflowQueue.ts`, not in any migration touching `workflows`/`workflow_executions`. The only adjacent mechanisms are (a) NPS hysteresis (re-arm only after recovering past threshold — a *re-fire condition*, not a throttle) and (b) `idempotency_key` dedup (prevents double-processing *the same* redelivered event, not repeated *distinct* firings). This means C-004 is not "surface an existing setting" — it is a net-new column, a net-new engine check, and a net-new UI. Scope and estimate accordingly (see §2.3 below); Tom's "zero backend changes" Quick-Win-3 claim in his Recommended Quick Wins section is incorrect for this codebase and should not be used to size the work.

**Net verdict, in my own words:** the ground has shifted — real triggers, real AI signals, and a real (if incomplete) NL degradation path now exist where Tom saw only paper promises. But the specific complaint that triggered this rebuild (Weekly Digest can't be scheduled) is a **regression against DESIGN.md's own spec**, not a previously known gap, and it sits alongside a still-real, still-unaddressed vocabulary problem (C-001) and a cooldown mechanism that has to be built from zero rather than exposed. This is not a "rebuild the builder" problem — it's a "finish building three specific pieces of the builder that were speced but never shipped" problem. Scope narrowly.

---

## 2. Prioritized scope for this rebuild pass

Scope is **the builder UI only** — `/app/workflows/build` (Surface 2 in DESIGN.md) and its NL counterpart (Surface 3). Not the list page, not RBAC, not analytics. Confirming the orchestrator's three Must-Fix picks below, in priority order, with one adjustment to sequencing.

### 2.1 Schedule Trigger Config Panel (P0 — do first)

**This is the reported bug, not a nice-to-have.** It's the one item on this list a real user hit directly, today, trying to do something the product should obviously support (schedule a Weekly Digest). Build DESIGN.md's full spec (§2.4, "Schedule Trigger Config Panel," lines 856–946): Daily/Weekly/Monthly/Custom-interval `ToggleGroup`, a live human-readable preview line ("Runs every Monday at 9:00 AM Pacific Time · Next run: Mon, Jun 30"), and cron as a collapsed developer-mode escape hatch only — never the primary interface. `buildCronFromConfig()` / `getNextRunFromCron()` are pure functions per the spec; a `cron-parser`-equivalent npm package is required (CUSTOMER_REVIEW.md's Scenario 2 independently arrived at the same need, citing the Priya/first-Monday-vs-first-day cron misconfiguration risk as the reason a raw cron field is unacceptable even as a fallback default).

Confirm scope boundary: this panel configures the **trigger card's** schedule config only. It does not touch the Intelligence Briefing type's other cards (Generate Briefing / Deliver via Email/Slack) — those config panels are unaffected and already speced.

### 2.2 Grouped trigger picker (C-001) (P1)

Confirmed correctly scoped as Must-Fix and correctly a builder-surface concern (it's the left-panel palette, DESIGN.md §2.2). Build the four-group structure CUSTOMER_REVIEW.md specifies (Alerts / Thresholds / AI Signals / Scheduled / Events — the review's five conceptual buckets collapse cleanly onto DESIGN.md's existing Trigger/Condition/Action palette categories) using the **real 12-trigger registry** in `workflowRegistry.ts`, not the 10-trigger illustrative set in Tom's writeup. Concretely, group as:
- **Alerts:** `score.nps_drop`, `score.nps_rise`, `crystal.anomaly_detected` [Crystal], `crystal.sentiment_spike` [Crystal]
- **Thresholds:** `survey.milestone_reached`
- **AI Signals:** `crystal.new_theme_detected` [Crystal], `crystal.insight_ready` [Crystal], `crystal.verbatim_escalation` [Crystal]
- **Scheduled:** `time.schedule`
- **Events:** `survey.response_received`, `survey.response_filtered`, `external.webhook`, `alert.fired`

This is genuinely cheap (CUSTOMER_REVIEW.md's own Quick Win 1 estimate of ~30 min frontend still roughly holds — it's a data-grouping + label change against an existing palette component, not new state).

### 2.3 Cooldown UI + backend enforcement (C-004) (P1, ship alongside or immediately after 2.2)

Confirmed Must-Fix, but **re-scoped from "surface a setting" to "build a setting."** Three real pieces of work, not one:
1. **Migration:** add `cooldown_minutes INTEGER` (nullable = no cooldown) to `workflows`.
2. **Engine check:** `workflowEngine.ts` (or wherever a trigger evaluation decides to enqueue an execution) needs a new gate — "has this workflow fired within the last `cooldown_minutes`, per `last_run_at`?" — before an execution is queued. This is a new code path, not a config toggle on existing logic.
3. **UI:** the Workflow Settings panel in DESIGN.md's right-panel no-selection state, with the preset dropdown + per-trigger-type suggested defaults CUSTOMER_REVIEW.md describes (C-004's mock).

Sequencing note: cooldown is **per-workflow, not per-trigger-type-card**, so it belongs in the right panel's "no card selected" state (DESIGN.md §2.4's documented no-selection view), not inside any individual trigger config panel — flagging this so Rohan's implementation spec and this scope call agree on where it lives in the 3-panel layout.

### Priority order confirmation

I'd keep the orchestrator's order (Schedule → Trigger grouping → Cooldown) with one nuance: **Schedule is the only one that's a hard blocker on a named, already-broken user path** (Weekly Digest). Trigger grouping and cooldown are both real onboarding/trust gaps but neither is currently broken for an existing template the way Schedule is. If forced to cut one of the three from this pass, cut cooldown before trigger grouping — an unthrottled workflow is an annoyance (extra Slack messages) recoverable by disabling it; a trigger picker a new user can't parse is a completion-rate killer with no workaround. I don't recommend cutting either, but that's the fallback order.

I do not think list-page or RBAC items belong in this pass, and none of Rohan's DESIGN.md Surface 2 spec requires them as a dependency — confirming the orchestrator's boundary.

---

## 3. What to explicitly defer, and why

| ID | Item | Why deferral is acceptable given what the user actually complained about |
|---|---|---|
| C-002 | Historical trigger replay in test mode | The user's complaint was about *creating* a schedule, not *trusting* an already-configured trigger via historical replay. This needs a new read endpoint (`GET /api/surveys/:id/trigger-events`) that doesn't exist — real backend work, zero overlap with the builder-UI rebuild. Sequence after the builder ships. |
| C-003 | Cross-action variable chips (`{{steps.1.jira_key}}`) | Real gap, but it's a chip-autocomplete/documentation problem on the *action config panels*, which are not part of what's broken today (Weekly Digest's break is entirely on the trigger side). No user pain reported here yet — defer until action-chaining usage exists to make it urgent. |
| C-005 | Workflow RBAC / ownership beyond `workflows:manage` | This is a list-page and org-settings surface, not a builder surface — literally out of scope for "rebuild the builder," and DESIGN.md's Surface 2 spec has no RBAC affordance to build against. Also the biggest single scope item on the whole review (three-tier permission model); folding it in here would blow the pass wide open. |
| C-006 | Crystal Builder degradation messaging | **Substantially already addressed** — see §1 above. `WorkflowNLBuilderPage.tsx` has real `low-confidence`/`unparseable`/`timeout` states with next-step affordances, not a blank error. What's left (per-skipped-part explanation text, an interactive clarification tier) is copy + minor state additions on an existing, working state machine — real but small, and not related to the schedule/trigger-picker/cooldown complaint. Worth a follow-up ticket, not this pass. |
| C-007–C-011 | Workflow list page features (health summary, bulk ops, analytics, live trigger preview, action-chaining docs) | All five are `/app/workflows` list-page or run-history-page concerns per their own specs in CUSTOMER_REVIEW.md — none touch `/app/workflows/build`. Correctly out of scope for a builder rebuild by definition, not by convenience. |

---

## 4. Quick wins worth folding in, and ones I'm rejecting for scope discipline

Reviewed both "Missing Enterprise Workflow Features" and "Recommended Quick Wins" sections in full.

**Worth folding into this pass (genuinely cheap, genuinely touches the builder surface already being worked):**
- **Cron misconfiguration guard (Scenario 2 / Quick Win 2).** This isn't a separate quick win — it's already inside the Schedule Trigger Config Panel spec (§2.1 above; DESIGN.md's live preview line *is* this fix). No separate ticket needed, but calling it out so it isn't accidentally dropped as "just the picker UI" — the preview-line-updates-on-every-field-change behavior is the actual fix for the first-Monday-vs-first-day bug Tom's Scenario 2 describes, not a cosmetic addition.
- **NPS hysteresis tooltip copy (Scenario 3).** Zero code change — a one-line explanatory tooltip on the NPS Threshold Trigger Config Panel ("fires once when NPS crosses below 30, won't re-fire until it recovers above 35 and drops again"). Since we're already in that config panel's code for other reasons this pass, and it directly prevents a "why didn't my workflow fire again" support ticket, add it. Costs minutes.
- **Retry button copy clarity (Scenario 5).** "Retry step" → "Retry from here (step 3 only)" plus a one-line note on what won't re-run. Also a pure copy change, but this lives in `RunRow.tsx` on the run-history view, not the builder — flagging it as fair game for *someone's* backlog this sprint, but it is not builder-surface work and I'm not pulling it into this doc's scope just because it's cheap. Recommend Rohan or whoever owns run-history picks it up opportunistically.

**Explicitly rejecting for this pass, despite low cost, to protect scope discipline:**
- Survey variable chip expansion (`{{survey.response_url}}` etc., Scenario 4) — real and cheap, but it's the same category of problem as deferred C-003 (variable documentation/autocomplete), and pulling in one variable-chip fix without the other creates an inconsistent half-fix. Bundle both into the deferred C-003 ticket instead of cherry-picking.
- Everything in "Missing Enterprise Workflow Features" (audit log, emergency pause-all, role-based routing, multi-channel escalation, distribution-event triggers, opinionated template Crystal configs) — every one of these is either a list/settings-page feature, a new trigger type, or a new action config concept. None touch the three things this pass exists to fix. Correctly excluded, not overlooked.

**Bottom line on scope discipline:** the team has three real items (Schedule panel, trigger grouping, cooldown) that together already touch the header, left panel, and right panel of the same 3-panel builder. Two cheap copy-only additions (hysteresis tooltip, cron preview line — which is really part of item 1) ride along for free. Everything else stays out. This keeps my scope call and Rohan's implementation spec aligned on exactly three build items.
