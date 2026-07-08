# Xperiq Actions — XM Industry Scenarios (Kenji's Verification Handoff)

**Author:** Maya Okonkwo, Staff PM, Workflow Automation
**Purpose:** A test-planning document, not a marketing one. Every scenario below is
written against the REAL, current `backend/src/lib/workflowRegistry.ts` catalog and
the REAL engine behavior I verified by reading `workflowEngine.ts`, `connectors.ts`,
`channels.ts`, `alertEngine.ts`, `eventEngine/processor.ts`, `routes/responses.ts`,
and `crystalos/lib/ai_triggers.py` directly (not assumed from design docs). Kenji: for
each scenario, "what working correctly means" is written to be testable as a
pass/fail assertion, not a vibe. My risk flags are honest — several of these worry me.

**How to read the readiness tags:** `live` = really executes. `stub` = executes but
produces templated/deterministic output, not a real LLM call. `env` = executes only
if org credentials or shared env vars are configured; otherwise returns
`status: 'skipped', reason: 'not_configured'`. I call out a **fourth** category below
that the registry doesn't itself expose: **no-producer** — a trigger type that exists
in the registry and evaluates correctly if fed an event, but nothing in the codebase
ever publishes that event. A workflow built on a no-producer trigger will sit enabled
forever and never fire. This is the single most important thing for Kenji to verify
first, because it's invisible from the builder UI — nothing tells the user their
trigger choice is a dead end.

**Confirmed no-producer trigger types (as of 2026-07-01):** `survey.response_received`,
`survey.response_filtered`, `survey.milestone_reached`, `score.nps_drop`,
`score.nps_rise`, `crystal.verbatim_escalation`. Confirmed live-producer triggers:
`alert.fired` (via `alertEngine.ts::fireAlert`, carries `payload.surveyId`),
`crystal.anomaly_detected` / `crystal.sentiment_spike` / `crystal.new_theme_detected`
(via CrystalOS `ai_triggers.py` → `workflow_signal` → `routes/internal-workflows.ts`),
`time.schedule` (via `runScheduledWorkflows`, cron-swept), `external.webhook` (via the
inbound webhook route). `crystal.insight_ready` — registered but I did not find a
direct publisher distinct from the pipeline-completion path Amara's Wave 4 notes
reference; treating as unconfirmed, Kenji should verify directly.

**A related, separate finding that affects several scenarios below:** the
`survey.milestone` event that `routes/responses.ts::maybeEmitResponseMilestone`
*does* actually publish (fixed thresholds `[25, 50, 100, 500, 1000]` on total
response count) uses the string `'survey.milestone'` — **not** `'survey.milestone_reached'`,
the registry's trigger `type`. These are two different strings to
`runWorkflowsForEvent`'s exact-match `WHERE trigger_type = $2`. A workflow built
against the "Milestone reached" trigger in the builder can never match this real
producer. This is a live, concrete, reproducible bug, not a hypothetical gap — flagging
for Kenji as scenario 5's headline risk.

---

## 1. Detractor Recovery Loop (CX — the baseline case)

**Business situation:** A CSAT/NPS response comes in with a low score. The account
owner needs to know within minutes, not at next week's dashboard review, so they can
call the customer back before the relationship sours further.

**Configuration:**
- Trigger: `alert.fired` (NOT `survey.response_received` — see risk flag). An alert
  rule with `alert_type` tied to an NPS/CSAT threshold fires `fireAlert()`, which
  publishes `alert.fired` with `payload.surveyId` and `severity`.
- Scope: `survey` (the specific CSAT program survey).
- Condition: `severity == "critical"` (`eq` operator, `severity` field).
- Actions: `notify.slack` (org's single configured Slack webhook), `notify.email`
  (`config.userId` = the account owner's Xperiq user id, resolved to an address via
  `user_profiles`).
- Cooldown: 0 / none — a real detractor event should fire every time, per
  `CUSTOMER_REVIEW.md`'s own C-004 guidance for `response_submitted`-shaped triggers.
- Content customization: keep "Crystal AI Summary" off for now (see scenario 9's
  "zero-AI" pattern) or on if the org is comfortable with the stub-quality summary.

**What "working correctly" means:** A response scoring below the alert rule's
threshold on the scoped survey creates exactly one `alert_events` row, publishes
exactly one `alert.fired` event, and the workflow fires exactly once, sending one
Slack message (to whatever channel the org's single active webhook points at — see
risk flag) and one email to the configured user. An identical low score on a
different, unscoped survey does NOT fire this workflow.

**Risk flag:** This only works if the customer builds it on `alert.fired`, which
requires an underlying alert rule to already exist and be correctly configured — the
registry's more inviting-looking `survey.response_received` ("Response received")
trigger is a dead end (no producer). Nothing in the sentence-first builder tells a
user this at selection time; the tile just says "Fires when a response is submitted."
Kenji should verify a workflow built on `survey.response_received` silently never
fires and confirm there is genuinely zero UI signal warning the user.

---

## 2. Executive Weekly Digest, Scoped to a Survey Program (CX or EX)

**Business situation:** A VP wants one Monday-morning email/Slack summarizing NPS
movement across the entire "Q3 CSAT Program" — four related surveys tagged together —
not four separate emails.

**Configuration:**
- Trigger: `time.schedule` — cron `0 9 * * 1` (every Monday 9am), built via the
  existing `ScheduleTriggerConfigPanel`.
- Scope: `tag` — the "Q3 CSAT Program" tag (a `survey_tags` row with `program_config`
  populated, i.e. a Program, not a plain tag).
- Actions: `crystal.summarize` (stub — see risk flag) + `notify.email`.
- Content customization: "Key Metrics" + "Trend Chart" on, "Crystal AI Summary" on if
  the org accepts stub-quality text, "Top Verbatims" on for the email (more room than
  Slack).
- Cooldown: not applicable — `computeCooldownStatus` returns `null` for
  `time.schedule` by construction; the schedule itself is the throttle.

**What "working correctly" means:** Every Monday at 9am (server time, per
`cronMatches`), `runScheduledWorkflows` finds this workflow and runs it exactly once,
regardless of scope — `time.schedule` is explicitly NOT filtered by
`matchesScope`/`resolveEventSurveyId` (confirmed: `runScheduledWorkflows` has no scope
filtering logic at all). One email is sent. Verify: does the email actually aggregate
data across all 4 tagged surveys, or does the `time.schedule` trigger event carry no
survey/tag context at all (its event payload is just `{ type: 'time.schedule',
scheduledAt }`) — meaning `crystal.summarize`'s deterministic template has literally
nothing survey-specific to summarize?

**Risk flag (the big one for this scenario):** I need Kenji to confirm this precisely,
because it looks like a real gap: `runScheduledWorkflows` builds its event as
`{ type: 'time.schedule', scheduledAt: now.toISOString() }` — no `surveyId`, no tag,
no metric data. The `scope_tag_id` column exists on the `workflows` row and the
builder UI lets you pick "Tag: Q3 CSAT Program" for a scheduled workflow, but I could
not find where a scheduled run's action execution actually pulls in the scoped
tag's surveys to summarize. If that data-fetch doesn't exist, this template produces
an email that says "Crystal summary: event received." — a technically-fired,
functionally-empty digest. This is a "looks configured, ships nothing" risk, exactly
the kind of thing a design review can't catch and only a real execution trace will.

---

## 3. Sudden Sentiment/Theme Shift → Escalation (CX — AI-driven trigger)

**Business situation:** Something changed in how customers are talking about the
product — a new complaint theme emerges, or overall sentiment craters — well before
NPS itself would show it. The CX lead wants to know the moment Crystal's pipeline
detects this, not at the next scheduled digest.

**Configuration:**
- Trigger: `crystal.new_theme_detected` or `crystal.sentiment_spike`.
- Scope: `survey` (the specific survey the insight pipeline ran on).
- Condition: none needed — CrystalOS's `ai_triggers.py` already gates on internal
  thresholds + hysteresis (`SENTIMENT_SPIKE_MIN_DELTA_PCT`, `NEW_THEME_MAX_SENTIMENT`,
  etc.) before ever emitting the signal; a workflow condition on top is redundant
  unless the org wants a stricter bar.
- Actions: `crystal.summarize`, `notify.slack`, `jira.create_issue` (product/eng
  routing, per the existing "Anomaly to Jira Backlog" template pattern).
- Cooldown: leave workflow-level cooldown at 0/none — the signal's own
  hysteresis+cooldown (12-24h depending on signal type, coded in `ai_triggers.py`) is
  the real throttle here; a second workflow-level cooldown on top is redundant, not
  harmful, but worth being deliberate about so support doesn't get two different
  "why didn't it fire again" explanations layered on each other.

**What "working correctly" means:** When CrystalOS's insight pipeline computes a
`new_theme_detected` signal for survey X (per its own internal arm/disarm logic),
`workflow_signal_client.py` POSTs to `routes/internal-workflows.ts`, which enqueues
via `publishWorkflowTrigger` (async, not inline), and the survey-scoped workflow for
survey X fires exactly once — a workflow scoped to survey Y does not fire.

**Risk flag:** The tracker is explicit that this seam (CrystalOS → backend →
workflow engine, end to end) has **never been run against live Postgres+Redis+both
real services together** — only reconciled on paper and covered by mocked unit
tests on each side independently. This is the single highest-priority thing for
Kenji to actually execute live, not just read code for. Also: AI-trigger
thresholds/hysteresis are explicitly unvalidated against real data (Amara's own
flag) — a "sentiment spike" today is whatever the conservative-by-design defaults
say it is, not something tuned against this org's actual volatility.

---

## 4. SLA-Style Escalation with Priority Routing (CX — support-adjacent)

**Business situation:** A response on a post-support-interaction survey comes back
with high urgency language and a low score. The support ops lead wants this to open a
ticket with the right priority automatically — a "just create a ticket" flow isn't
enough if every ticket lands at default priority and still has to be manually
triaged.

**Configuration:**
- Trigger: `alert.fired` with `severity == "critical"`, OR `survey.response_filtered`
  if the org has a producer for it (see risk flag — it doesn't today).
- Scope: `survey` (the specific support-adjacent survey).
- Action: `zendesk.create_ticket` with `config.priority` explicitly set (or omitted,
  falling back to `ctx.event.severity === 'critical' ? 'urgent' : 'normal'`).
- Cooldown: 0/none — every qualifying support-adjacent response should generate its
  own ticket; suppressing "duplicate" alerts here would silently drop real tickets.

**What "working correctly" means:** A matching event creates exactly one Zendesk
ticket with `priority: 'urgent'` (when `severity === 'critical'`) — verify the actual
HTTP payload sent to `https://{subdomain}.zendesk.com/api/v2/tickets.json` carries
`ticket.priority`, not just that the workflow "completed." A non-critical-severity
event on the same survey creates a ticket at `'normal'` priority, not `'urgent'`.

**Risk flag — the one I'd bet money on being wrong if someone builds this on Jira
instead of Zendesk:** `jiraCreateIssue` (`connectors.ts:56-91`) has **no priority
field anywhere** — not read from config, not defaulted from severity, not sent in
the request body at all. A customer whose ticketing system of record is Jira (a very
common real-world choice — this is explicitly the connector the "Critical Alert"
template gallery entry recommends for CX and "Anomaly to Jira Backlog" recommends for
product/eng) cannot build this exact scenario with priority routing today, full stop.
The builder UI doesn't warn about this either — nothing in the action tile or content
panel signals "this action type doesn't support priority" the way the `live`/`stub`/
`env` readiness dot signals configuration status. This is a real capability gap, not
just an untested path — Kenji should confirm by reading `jiraCreateIssue`'s request
body construction directly.

---

## 5. Product Launch Milestone Notification (CX — single-survey scope, NEW as of Wave 6)

**Business situation:** A PM running a post-launch survey wants to know the moment
response volume hits a meaningful threshold (e.g., "we just hit our first 100
responses") so the team can sanity-check early signal before the full 48-hour window
closes.

**Configuration:**
- Trigger: `survey.milestone_reached`.
- Scope: `survey` (this exact launch survey — critically, NOT org-wide; the PM does
  not want to be notified about every other survey's milestones too).
- Actions: `notify.slack`, `notify.in_app`.
- Cooldown: not needed — milestones are inherently self-throttling (they only cross
  once per count value).

**What "working correctly" means:** The moment the survey crosses its Nth response
(N being whatever the real producer's fixed thresholds are), exactly one notification
fires for this survey; an identical response count on a different survey does not.

**Risk flag — this is the headline finding of this whole document:** This scenario
**cannot work today**, and it's not a subtle gap. `routes/responses.ts`'s
`maybeEmitResponseMilestone` is the only code in the entire backend that emits
anything milestone-shaped, and it publishes `type: 'survey.milestone'` — the registry
trigger is `'survey.milestone_reached'`. `runWorkflowsForEvent`'s SQL does an exact
`WHERE trigger_type = $2` match; these two strings never equal each other. A workflow
built on "Milestone reached" in the builder will show as `● Enabled`, pass every
validation check, and simply never fire — for any survey, ever. Compounding this: the
real producer's thresholds are hardcoded (`[25, 50, 100, 500, 1000]` total responses,
`routes/responses.ts:19`), not configurable per workflow, so even after the naming
mismatch is fixed, "first 100 responses" is only expressible if 100 happens to be one
of those five fixed values — "every 500" from the High-Volume Product Launch scenario
in `CUSTOMER_REVIEW.md` works by coincidence with the fixed list, "every 250" would
not. Kenji: please verify this exact string mismatch by re-reading both files
yourself — I want a second pair of eyes on something this consequential before it's
called a confirmed bug in a bug tracker.

---

## 6. Silent Churn-Risk Signal on a Renewal-Adjacent Survey (CX — cooldown-critical)

**Business situation:** A response on a renewal/relationship-health survey combines
low effort score with low satisfaction — a classic quiet churn-risk pattern that
doesn't trip a hard NPS-detractor threshold but should still get a CSM's attention.
Renewal-adjacent scores are naturally noisy (the same account might dip and recover
week to week), so this must not become alert-fatigue spam.

**Configuration:**
- Trigger: `alert.fired` (a custom alert rule with `alert_type` for this
  effort+satisfaction combination) or `crystal.anomaly_detected` if Crystal's
  pipeline is tracking this survey's metric trend.
- Scope: `survey` (the renewal-health survey specifically).
- Condition: `csat <= 2` — note `csat` IS declared in `CONDITION_FIELDS` but I could
  not confirm any real producer populates a `csat` context key on any event today
  (see risk flag).
- Action: `notify.slack` to the CSM-facing channel.
- Cooldown: **this is the scenario cooldown exists for** — recommend 24-48 hours per
  account/survey, matching `CUSTOMER_REVIEW.md`'s own guidance that a naturally
  volatile score needs a longer window than a hard-detractor alert.

**What "working correctly" means:** The first qualifying response fires the alert.
A second qualifying response on the SAME survey within the cooldown window does
NOT re-fire (verify a `workflow_executions` row is inserted with `status='cooldown'`,
not silently dropped with no row at all). A qualifying response on a DIFFERENT
renewal-adjacent survey, scoped to a different workflow, is NOT suppressed by the
first workflow's cooldown.

**Risk flag:** Cooldown state (`cooldown_last_fired_at`) lives on the `workflows` row
itself — it is a single per-workflow clock, not per-survey and not per-account/
respondent. This is fine for a `survey`-scoped workflow (one survey per workflow
already), but if this pattern is ever built as a `tag`-scoped workflow across
multiple renewal-adjacent surveys (a very plausible real ask — "everything tagged
Renewal"), the SAME 24-hour cooldown clock is shared across every surveyed account
under that tag. A churn signal on Account A firing at 9am would silently suppress a
genuinely independent churn signal on unrelated Account B at 10am, because both hit
the same `tag`-scoped workflow's single cooldown clock. Compare this to
`alertEngine`'s own dedup, which IS keyed per-rule-per-entity/survey
(`alert:dedup:{orgId}:{ruleId}:{entityId||'org'}:{windowKey}`) — the alert layer
already solved the sharper version of this problem the workflow cooldown layer did
not inherit. Kenji, this is worth a dedicated test: two different "accounts" (however
that's representable — likely two different survey response records) both matching
the same tag-scoped, cooldown-set workflow in quick succession, and confirm whether
the second one is wrongly suppressed.

---

## 7. Win-Back / Positive Signal → Marketing Testimonial Flag (CX — positive path)

**Business situation:** An unusually high NPS response is exactly the kind of
signal a CX team should route to marketing for testimonial-sourcing, not just
celebrate internally — this is the "NPS Win Celebration" template's premise, extended
to actually route the signal somewhere marketing can act on it.

**Configuration:**
- Trigger: `score.nps_rise` per the seeded template — **but see risk flag, this
  trigger has no producer**. Realistic working alternative: `alert.fired` with an
  alert rule configured for an NPS-rise `alert_type` (confirmed `evalNpsRise` exists
  in `alertEngine.ts` and defaults `severity` to `'success'`).
- Scope: `survey`.
- Condition: `nps >= 9` (`gte` operator).
- Actions: `notify.slack` (to a #marketing or #cx-wins channel), `data.tag_responses`
  with a `"testimonial-candidate"` tag — **see risk flag, this action does not
  persist**.
- Cooldown: none — every qualifying win is independently worth surfacing.

**What "working correctly" means:** A matching high-NPS response on the scoped survey
sends exactly one Slack notification and — if `data.tag_responses` genuinely
persisted — the response would show up tagged `testimonial-candidate` in a later
query for marketing to pull from.

**Risk flag (two, stacked):** First, the seeded template literally uses
`score.nps_rise`, a confirmed no-producer trigger — the shipped template gallery
entry cannot fire as configured; it needs to be rebuilt on `alert.fired` to actually
work, which is a gap between what's "in the gallery" and what's real. Second, even
routing through `alert.fired` correctly, `data.tag_responses`'s switch case
(`workflowEngine.ts:215-218`) returns a success-shaped `{ status: 'completed',
output: { tagged, tag } }` without ever writing to any table — there is no `UPDATE`/
`INSERT` in that code path. A marketing team querying "show me all
testimonial-candidate-tagged responses" later will find nothing, even though every
run in the execution history shows this step as `completed`, not `skipped` or
`failed`. This is worse than an honest `stub` label because the registry marks
`data.tag_responses` as `live: true` — the readiness signal in the builder UI will
tell the user this action is fully wired when it silently isn't.

---

## 8. Exit Survey / Offboarding — HRBP Notification (EX)

**Business situation:** An employee completes an exit survey. HR wants the assigned
HR Business Partner notified immediately, with extra scrutiny given the sensitivity
of exit-survey content (this data should not casually fan out to whoever happens to
be watching a general HR Slack channel).

**Configuration:**
- Trigger: `alert.fired` (an alert rule scoped to the exit-survey's low-sentiment or
  specific-flag pattern) — realistically the only live-producer path, since
  `survey.response_received` has no producer.
- Scope: `survey` — this exact exit survey, and only this survey. This is the load-
  bearing configuration choice for this scenario: an org-wide or tag-scoped workflow
  here would be a serious mistake (see risk flag).
- Action: `notify.email` with `config.userId` = the specific HRBP's Xperiq user id
  (a static, author-typed value — see risk flag on how that id gets chosen and kept
  current).
- Cooldown: none — every exit survey response is a distinct, individually
  actionable event; suppressing any of them is unacceptable.

**What "working correctly" means:** A response on this exact exit survey notifies
exactly the HRBP whose user id is configured — no one else, not the general HR
channel, not an org admin fallback. A response on any other survey (including other
EX pulse surveys) must not trigger this workflow at all.

**Risk flag:** `notify.email`'s recipient (`config.userId`) is a single static value
typed once at workflow-authoring time by whoever built the workflow — there is no
mechanism to keep it correct as HRBP assignments change (an employee's actual HRBP
is presumably assignable/reassignable elsewhere in the org, but the workflow has no
awareness of that assignment; it only knows the id someone hardcoded when the
workflow was built). `CUSTOMER_REVIEW.md`'s own "Missing Enterprise Workflow
Features" section flags exactly this ("Notification routing by role, not by user
ID") as unbuilt. For exit-survey data specifically, a stale hardcoded HRBP id is not
just an inconvenience — it risks a departed or reassigned HRBP no longer receiving
sensitive offboarding signals, or a former employee somehow still being addressable
if ids aren't cleaned up on offboarding. Kenji should verify what happens when
`config.userId` refers to a deactivated/deprovisioned user (does `user_profiles`
lookup silently fail into `no_recipient`, silently dropping the notification with no
visible failure signal to anyone?).

---

## 9. Employee Engagement Pulse — Quarterly Leadership Digest (EX — tag scope)

**Business situation:** An HR analytics lead runs a quarterly pulse program across
multiple surveys (Q1/Q2/Q3 pulses, onboarding pulse, manager-effectiveness pulse) and
wants one consolidated leadership digest, not five separate emails from five separate
survey owners.

**Configuration:**
- Trigger: `time.schedule` — quarterly cron.
- Scope: `tag` — a "FY26 Engagement Program" tag (a Program, per `program_config`)
  spanning all the relevant pulse surveys.
- Actions: `crystal.summarize`, `notify.email`.
- Content customization: "Key Metrics" + "Trend Chart" on; "Crystal AI Summary" is
  a real decision point for EX data specifically (see scenario 11 — many HR orgs are
  more AI-cautious with people data than CX data).

**What "working correctly" means:** Fires once per quarter per the cron. Same open
question as scenario 2: does the scheduled run's action execution actually aggregate
data from the tag's mapped surveys, or does it run against an empty/generic event
context?

**Risk flag:** Identical to scenario 2's — `time.schedule` events carry no survey/tag
payload at all in `runScheduledWorkflows`'s event construction. This is the same gap
appearing twice because it's structural: EVERY scheduled, tag-scoped digest scenario
(CX or EX) depends on a data-fetch step that I could not confirm exists between "cron
fired" and "here's what to put in the email." Kenji, this is worth verifying once,
generally, rather than once per scenario — if the gap is real, it invalidates every
tag-scoped digest template in the gallery, not just this one.

---

## 10. Manager-Effectiveness Flagging — HRBP Escalation, NOT the Manager (EX — the scenario I'm most worried about)

**Business situation:** A specific low-scoring pattern on a manager-effectiveness
survey question (e.g., "My manager supports my growth" scoring consistently low for
a given team) should escalate to the HRBP for coaching intervention — and must
absolutely never reach the manager being scored. This is the single most
reputationally dangerous misfire this product could produce for an EX customer: an
automated system accidentally CC'ing or notifying the subject of a critical
people-management signal would be a trust-destroying, possibly HR-policy-violating
failure.

**Configuration (best available today):**
- Trigger: `alert.fired` (an alert rule for this survey/question pattern), or
  `crystal.anomaly_detected` if the pipeline tracks this metric.
- Scope: `survey` — the manager-effectiveness survey.
- Condition: `nps`/`csat`-equivalent threshold on the relevant question's score.
- Action: `notify.email` with `config.userId` = the HRBP's id, hardcoded at
  authoring time — the ONLY targeting mechanism the system has.
- Cooldown: recommend a meaningful window (weekly+) since this is a pattern
  signal, not a single-response spike.

**What "working correctly" means — and this is where I have to be blunt:** "Working
correctly" here cannot just mean "the configured recipient receives the email." It
must mean the system is STRUCTURALLY INCAPABLE of ever resolving the recipient to the
scored manager, even under a future misconfiguration, a copy-paste error building the
workflow, or a workflow edit six months later by someone who doesn't remember why the
original author chose that specific `userId`. I do not believe the current
implementation clears that bar.

**Risk flag — surfacing, not certifying:** I confirmed directly (reading
`workflowEngine.ts`, `channels.ts`, `connectors.ts`) that there is **no concept of
"the subject of this response" anywhere in the targeting path**, which sounds safe
(nothing auto-targets the manager) but is actually the opposite of reassuring: it
means the ONLY thing standing between "HRBP gets it" and "the scored manager gets it"
is a human correctly typing the right static `userId` into a config field once, with
zero system-level check that the chosen recipient isn't the manager being evaluated.
Concretely:
- There is no org-chart/reporting-relationship data model anywhere I could find in
  this schema pass, so the system has no way to even ask "is this recipient the
  subject's manager?" — the question isn't just unanswered, it's unaskable with data
  that exists today.
- `notify.email`'s fallback chain (`config.userId` → `event.userId`) means if a
  workflow author leaves `config.userId` unset (a real, easy authoring mistake — the
  interim generic config editors from Wave 5 were explicitly minimal), the recipient
  silently falls back to `ctx.event.userId`. If a manager-effectiveness alert's
  underlying event ever carries the scored manager's own user id in `event.userId`
  (plausible if the alerting/anomaly pipeline attaches "the person this metric is
  about" to the event for other legitimate reasons, e.g. for a manager
  self-service dashboard elsewhere in the product), an unset config field would
  misdirect the alert to exactly the person it must never reach — silently, with the
  execution log showing a clean `completed` status.
- There is no confirm-card, dry-run, or "who will this actually notify" preview
  callout anywhere in the builder for EX-sensitive workflows specifically (nothing
  distinguishes an EX-sensitive workflow from any other workflow at all, structurally
  — scope is survey/tag/org, never a sensitivity classification).

**This is my top flag for Kenji, full stop.** I want him to specifically construct
the misconfiguration case (empty `config.userId`, event context containing the scored
manager's own id in `event.userId`) and confirm exactly what happens end to end,
because "we don't think this would happen" is not the same as "the system prevents
it," and for this specific scenario type only the second one is acceptable.

---

## 11. New-Hire Onboarding Feedback → Welcome Check-in (EX)

**Business situation:** A new-hire pulse survey milestone (e.g., "30-day check-in
survey submitted") should trigger a lightweight, low-stakes welcome/check-in
notification to the hiring manager or onboarding buddy — a much lower-stakes EX
scenario than #10, useful as a contrast case.

**Configuration:**
- Trigger: `survey.milestone_reached` (as designed) — **no producer, same as
  scenario 5's gap** — or realistically `alert.fired` if an alert rule can be
  authored around "onboarding survey submitted."
- Scope: `survey` — the specific 30-day onboarding survey.
- Action: `notify.slack` or `notify.in_app` to the onboarding buddy/manager.
- Cooldown: none — each new hire's milestone is independently meaningful.

**What "working correctly" means:** Each distinct new-hire's onboarding-survey
completion notifies the correct recipient once; this is lower-stakes than scenario 10
because a wrong recipient here is an inconvenience, not a trust/compliance incident —
worth Kenji verifying as a contrast baseline to confirm the "low stakes done right"
case actually works even while the "high stakes" case (10) is the one I'm worried
about.

**Risk flag:** Same producer gap as scenario 5 if built literally as designed. Also:
if "the onboarding buddy" varies per new hire (it should — different new hires have
different buddies), this hits the exact same static-`config.userId`-per-workflow
limitation as scenario 8 — one workflow definition cannot express "notify whoever
this specific respondent's buddy is," only "notify this one hardcoded person,"
meaning a real onboarding program needs either N workflows (one per new hire, absurd)
or accepts that this only works for a role-based recipient (e.g., always the same HR
onboarding coordinator, not a per-hire buddy).

---

## 12. First-Ever Workflow via NL Builder (Cross-Cutting — Crystal Proposes)

**Business situation:** A brand-new CX manager, zero prior tool experience, opens
the NL builder and types a plain-English description of what they want, trusting
Crystal to translate it correctly and tell them plainly if it can't.

**Configuration:** N/A by design — the point is the user provides none of the
registry vocabulary themselves. Test input: "When our CSAT survey NPS drops below
30, send a Slack message to #cx-alerts and open a Jira ticket."

**What "working correctly" means:** `POST /api/workflows/parse-nl` returns a
structured `{ name, description, triggerType, nodes, edges, confidence,
warnings[] }` shape; the frontend confirm-card shows the correctly-parsed trigger/
scope/actions; confirming creates a real graph-shaped workflow via
`api.createGraphWorkflow()` (the modern path, not the retired legacy flat shape). A
request containing an explicitly out-of-scope ask (e.g., "...and if it's not resolved
in 48 hours, close both surveys") should produce a partial-parse degradation card
per `CUSTOMER_REVIEW.md`'s C-006 tiers, not silence or a raw error.

**Risk flag:** The tracker is explicit and I'm taking it at face value rather than
re-litigating it: this entire seam (CrystalOS's NL parser ↔ backend proxy ↔ frontend
confirm-card) has been reconciled ON PAPER by two agents working from a shared
contract doc, verified only by mocked unit/integration tests on each side
independently. **Nobody has run a real end-to-end request through live
Postgres+Redis+CrystalOS+backend+frontend together.** This is Amara's AND Nina's own
top-flagged risk, not just mine — for a "first-ever workflow, zero prior trust
established" user journey specifically, a seam that has literally never been
exercised live is the worst possible place for a first impression to break. I'd
prioritize this above almost everything else in this document for a live run, not a
code read.

---

## 13. Editing an Already-Live, Currently-Firing Workflow (Cross-Cutting)

**Business situation:** A CX manager wants to change an active NPS-alert workflow's
Slack channel wording, or lower its threshold, without disabling it first and without
losing in-flight cooldown state or breaking anything for the run that might fire
between "I hit save" and "the change is live."

**Configuration:** Any already-`active`-status workflow, edited via `PUT
/api/workflows/:id` (name/description/nodes/edges/scope/cooldown all independently
settable) while `status` stays `'active'` throughout.

**What "working correctly" means:** A `PUT` mid-flight does not corrupt
`cooldown_last_fired_at` (verify: does an edit reset or preserve it? — I could not
confirm this from the schema/engine alone, this needs a direct test), does not lose
`scope_type`/`scope_survey_id`/`scope_tag_id` if the edit's request body omits scope
fields entirely (recall: the API "requires `scopeType` explicitly whenever either id
field is touched" — verify a partial PATCH-shaped update that doesn't touch scope at
all correctly leaves existing scope untouched, not nulled), and any execution already
`'executing'` at save-time completes against the OLD node graph it started with, not
a half-updated one.

**Risk flag:** This is exactly the kind of scenario that only breaks under real
concurrency (a save landing in the same window as an in-flight `runWorkflow` call) —
a single-threaded manual test clicking "Save" and then checking the next run is not
sufficient coverage. Kenji, this needs an actual concurrent-execution test: trigger a
run, and mid-execution, PUT an edit to the same workflow, then confirm the in-flight
run completes against a consistent snapshot of the graph it started with.

---

## 14. Genuinely Branching Workflow via the Advanced Canvas (Cross-Cutting)

**Business situation:** A workflow that needs real if/else logic — e.g., "if severity
is critical, open a Jira ticket AND page Slack; otherwise just log it internally" —
which the sentence-first linear builder cannot express (a sentence degrades to a
comma-joined action list, not a conditional branch).

**Configuration:** Built via `WorkflowCanvasPage` (the separate reactflow-based
branching surface, explicitly out of scope for the Wave 6 sentence-first redesign
per `BUILDER_REDESIGN_V2_CONCEPT.md` §8), using `flow.approval`/branch nodes in the
graph's `nodes`/`edges` JSON.

**What "working correctly" means:** A branching workflow correctly routes to
different action paths based on the same condition evaluation logic
(`evaluateConditions`) the linear builder uses — same engine, different graph shape.
Editing a branching workflow correctly routes back into the canvas builder, not the
sentence builder (`resolveEditRoute()`'s branching → canvas / linear → builder logic,
per Wave 2).

**Risk flag:** The sentence-first redesign concept doc itself flags that the exact
placement/discoverability of the "switch to canvas" escape hatch was NOT resolved in
that pass ("a detail for the Figma pass, not resolved here") — Kenji should verify a
first-time user attempting a branching workflow in the NEW builder can actually find
their way to the canvas at all, since the new IA's core selling point (a single
always-visible sentence) has no natural affordance for "this needs to not be a
sentence." A user who doesn't already know the canbas exists as a separate route may
simply not find the escape hatch.

---

## 15. Multiple Overlapping Workflows on the Same Survey (Cross-Cutting)

**Business situation:** A CX team builds two workflows on the same CSAT survey: one
fires on `alert.fired`/critical → Slack, another fires on `alert.fired`/critical →
Jira (built by two different team members who didn't coordinate, a realistic
enterprise pattern `CUSTOMER_REVIEW.md`'s C-005 RBAC section already anticipates).
Do both fire correctly and independently, or does one interfere with the other?

**Configuration:** Two `survey`-scoped workflows, same `trigger_type` (`alert.fired`),
same scope (`scope_survey_id` = the same survey), same condition
(`severity == "critical"`), different actions.

**What "working correctly" means:** One qualifying alert event causes BOTH workflows
to run and BOTH to succeed — one Slack message AND one Jira ticket, not one-or-the-
other, not a double-Slack-message, not a skipped second workflow. Verify via
`workflow_executions` rows: exactly 2 rows for the 2 workflows, both `status:
'completed'`, from one underlying alert event.

**What "correctly" does NOT require, but I want confirmed anyway:** that a slow or
failing action in workflow A does not delay or block workflow B's evaluation — per
`runWorkflowsForEvent`'s sequential `for...of` loop with per-workflow try/catch, a
hung fetch in workflow A's action (bounded by `CONNECTOR_FETCH_TIMEOUT_MS`, currently
10s) would still make workflow B wait up to 10 seconds before its turn, since the
loop is NOT parallelized (`Promise.all` is not used). For 2 workflows this is a minor
latency issue; for a survey with 10+ overlapping workflows sharing a trigger, this
could become a meaningfully slow serial chain.

**Risk flag:** The real test coverage I found (`workflowScope.test.js`'s "mixed
org+survey+tag" test) proves scope-matching selects the right SET of workflows
correctly, but does NOT test true concurrent-safety or timing — no test makes one
workflow's action slow/fail and asserts the sibling workflow still completes reliably
and within a reasonable time. This is a real, not hypothetical, coverage gap Kenji
should close with a new test, not just reasoning about the code.

---

## 16. Zero-AI-Content Compliance Mode (Cross-Cutting — compliance-sensitive org)

**Business situation:** A regulated or simply AI-cautious org (this shows up in both
CX — e.g. financial services — and EX — most HR orgs are more AI-cautious with people
data than marketing is with NPS data) wants a workflow whose every customer-facing or
HR-facing communication is 100% author-written, with zero Crystal-generated content
anywhere in the chain, verified, not just "unchecked by default."

**Configuration:** Any workflow using `notify.email`/`notify.slack` with the
`ContentCustomizationPanel`'s "Crystal AI Summary" checkbox explicitly OFF, and
critically, NO `crystal.summarize`/`crystal.classify`/`crystal.write` action node
anywhere in the graph at all (the content-customization toggle only controls whether
a summary SECTION appears inside a notify action's own template — it does not
prevent a separate `crystal.*` action node from existing elsewhere in the same
workflow's chain).

**What "working correctly" means:** The actual Slack/email payload sent contains
zero Crystal-generated text — verify by inspecting the real rendered `body`/
`blocks` sent to the Slack webhook / SendGrid API, not just the persisted section-
config JSON (a bug where the config says "off" but the render path still includes it
would be invisible without checking the literal outbound payload). Additionally
verify the workflow's execution log/steps table doesn't itself leak a Crystal-
generated string into a field a compliance reviewer might read later even if it
wasn't sent externally.

**Risk flag:** I could not confirm from reading `workflowEngine.ts` alone whether
`ContentCustomizationPanel`'s section-toggle state actually reaches the render path
for `notify.email`/`notify.slack`, or whether it's currently only a persisted config
value with the actual message template construction elsewhere not yet consulting it
— Wave 6's tracker entry describes the checkbox as controlling "the live preview"
and "the persisted section config" but I don't have direct confirmation the SAME
config is read by `executeAction`'s `notify.email`/`notify.slack` cases at run time,
as opposed to only affecting the builder's preview rendering. This distinction
(preview-only vs. actually enforced at send-time) is exactly the kind of gap that
looks fine in a demo and fails in production for a compliance-sensitive customer.
Kenji, this needs a direct trace: toggle the section off, save, trigger a real
execution, and inspect the literal payload sent to Slack/SendGrid.

---

## Scenarios explicitly NOT achievable today

Naming these clearly rather than forcing a fit, per the brief.

**1. Multi-survey compound triggers ("Survey A drops AND Survey B drops
simultaneously").** Confirmed explicit anti-goal in `TRACKER.md`'s "Anti-goals
honored" section and `CUSTOMER_REVIEW.md`'s C-006. Scope is one-survey-or-one-tag-
group per workflow; there is no AND-across-surveys condition primitive anywhere in
`evaluateConditions` or the scope model. Not a bug — a deliberate design boundary.

**2. Time-based escalation ("if not resolved in 48 hours, escalate to the VP").**
No `delay_minutes`-style field exists on any action config in `workflowEngine.ts`'s
`executeAction`, and there is no polling/re-check mechanism for "has this been
acknowledged yet." `CUSTOMER_REVIEW.md`'s N-002/"Multi-channel escalation with time
delay" section already names this as unbuilt. Branching (`flow.approval`) can pause
for a human decision, but nothing resumes it automatically after an elapsed time
window.

**3. "Fire at every Nth response" as a configurable per-workflow value.** The only
real response-count producer (`routes/responses.ts`) hardcodes
`[25, 50, 100, 500, 1000]` — there is no way for a workflow author to configure "every
250 responses" or "every 50 after the first 500." `CUSTOMER_REVIEW.md`'s own Scenario
5 already flagged this as an acceptable Phase-1 limitation (build N workflows
instead) — still true today, and now compounded by the `survey.milestone_reached`
vs. `survey.milestone` naming bug (Scenario 5 above), so even the workaround (build
one workflow per fixed threshold) doesn't currently work either.

**4. Role-based / dynamic recipient targeting ("notify whoever is currently this
survey's owner" or "notify this respondent's manager").** Every notification/ticket
action's recipient is a static value typed once at authoring time
(`config.userId`, `config.requesterEmail` via templating from event fields — never a
live lookup against a role, a reporting-line relationship, or a "current owner of X"
resolution). `CUSTOMER_REVIEW.md`'s "Notification routing by role, not by user ID"
section already names this gap. This is the structural root cause behind my risk
flags on scenarios 8, 10, and 11 above — it is not scenario-specific, it is a
platform capability that does not exist yet.

**5. Rolling-window/trend conditions ("NPS dropped over the last 7 days" as a trend,
distinct from a single instantaneous crossing).** `BUILDER_SPEC_WAVE2.md` §3 already
flagged this precisely: only instantaneous per-response/per-event fields exist in
`CONDITION_FIELDS` (`nps`, `csat`, etc. as point values at evaluation time) — there is
no aggregate/rolling-window condition primitive in `evaluateConditions`. The
`nps_threshold` hysteresis behavior (`CUSTOMER_REVIEW.md` Scenario 3) is the closest
analog, and it lives in CrystalOS's AI-trigger layer for the 3 AI trigger types only,
not as a general condition operator any trigger type can use.

**6. Guaranteed-safe sensitive-audience routing (a hard system-level guarantee that
an alert about a manager can never reach that manager).** Related to #4 but distinct
enough to name on its own, since it's the crux of Scenario 10: there is no
sensitivity classification on any workflow, no org-chart data model to even express
"is recipient X the subject of this event," and therefore no mechanism — automatic
or advisory — that could prevent this misconfiguration even in principle. This isn't
"unbuilt but plausible with today's data model" like #4; it requires new data (a
reporting-hierarchy or "excluded recipients" concept) that doesn't exist anywhere in
this schema today.

---

## Summary for Kenji — prioritized

**Top 3 risk flags, in the order I'd want them investigated:**

1. **Scenario 10 (manager-effectiveness misdirection).** Construct the actual
   misconfiguration (empty `config.userId`, event context carrying the scored
   manager's own id in `event.userId`) and confirm what happens end to end. This is
   the one true reputational/trust-destroying failure mode in this whole document,
   and today's system has no structural defense against it — only "hope the workflow
   author typed the right id."
2. **Scenario 5 / the `survey.milestone_reached` vs. `survey.milestone` string
   mismatch, plus the broader no-producer trigger list** (`survey.response_received`,
   `survey.response_filtered`, `score.nps_drop`, `score.nps_rise`,
   `crystal.verbatim_escalation`). These are concrete, reproducible, verify-by-
   reading-two-files bugs that make several registry triggers and one seeded
   template silently non-functional. High confidence, low effort to confirm, high
   value once confirmed (it's a real bug ticket, not a judgment call).
3. **Scenario 12 / the CrystalOS↔backend↔frontend live seam** (NL builder AND AI
   triggers, scenarios 3 and 12) — both flagged by their own building agents as never
   run end-to-end against real infrastructure. For a first-time-user NL-builder
   journey specifically, this is the worst possible place for the product's very
   first impression to silently fail.

**Also worth flagging, slightly lower priority but real:** `data.tag_responses`
marked `live: true` in the registry while never persisting anything (scenario 7);
Jira's total absence of a priority field undermining any Jira-based SLA-escalation
scenario (scenario 4); whether `time.schedule` events actually carry enough context
for tag/survey-scoped digests to produce non-empty content (scenarios 2 and 9,
same root cause, worth one investigation covering both); and whether the Wave 6
content-customization toggle is enforced at send-time or only in the builder's
preview (scenario 16).
