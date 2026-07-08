# Xperiq Actions — Template Gallery (Phase 1 expansion)

**Owner:** Maya Okonkwo, Staff PM, Workflow Automation
**Status:** 8 of 12 target templates seeded (3 original + 5 new below). Remaining 4 are
gated on capabilities that don't exist in `workflowRegistry.ts` yet — see "Gaps for
later waves" at the bottom, not built here per scope.

This doc exists so nobody has to reverse-engineer *why* a template is in the gallery
from its JSON graph. Each entry below answers the only question that matters to a CX
manager evaluating whether to turn a template on: **what Monday-morning problem does
this eliminate, and what happens if it's off?**

Every trigger, condition field, and action referenced by these templates exists today
in `backend/src/lib/workflowRegistry.ts` (checked against `TRIGGERS`, `CONDITION_FIELDS`,
`CONDITION_OPERATORS`, `ACTIONS` as of 2026-07-01). None of these are aspirational —
they will actually execute against the current engine. Migration:
`supabase/migrations/20260701090200_workflow_templates_phase1_expansion.sql`.

---

## 1. NPS Win Celebration (`nps-win-celebration`)

**Trigger:** `score.nps_rise` · **Actions:** `notify.slack`, `notify.in_app`

**Why a real CX manager needs this:** Every XM platform I've worked on treats NPS
movement as a one-directional alarm — it only fires when things get worse. That's a
mistake I watched play out at my last company: teams that only ever hear about NPS
when it drops start to associate the whole measurement program with bad news, and
"resolve NPS deterioration" quietly becomes the CX team's entire identity. The single
highest-leverage, lowest-cost thing a CX leader can do for team morale and executive
buy-in is close the loop on wins as fast as losses — "what did we just do right, and
can we do more of it" is a question that has to be asked within days of the signal,
not rediscovered three months later in a QBR deck. This template exists so a positive
swing gets the same 38-minute response time I built for negative ones, not a shrug.

## 2. Survey Milestone Kickoff (`survey-milestone-kickoff`)

**Trigger:** `survey.milestone` (renamed from `survey.milestone_reached` — Nina,
2026-07-01, XM_VERIFICATION_REPORT.md Priority 2: the registry's trigger type
never matched the real producer, `routes/responses.ts::maybeEmitResponseMilestone`,
which publishes `survey.milestone`. Fixed in `workflowRegistry.ts` and backfilled
onto the already-seeded template row via
`supabase/migrations/20260701130100_workflow_template_fixes.sql`.) · **Actions:**
`crystal.summarize`, `notify.slack`, `notify.in_app`

**Why a real CX manager needs this:** The classic failure mode of a 3-week survey
program is that nobody looks at the data until the survey closes — by which point any
early, fixable pattern (a confusing question, a broken skip-logic branch, a channel
that's clearly underperforming) has already contaminated the full dataset. A CX
manager running a launch survey needs an automatic "first look" the moment there's
enough volume to say something real, not a calendar reminder to "check on it
sometime." Firing Crystal's summary and a Slack ping at a response milestone turns a
manual, easy-to-forget checklist item into something that just happens — and gives the
survey owner a chance to fix a bad question on response 100 instead of response 4,000.

## 3. Slow Completion Flag (`slow-completion-flag`)

**Trigger:** `survey.response_received` · **Condition:** `completion_time >= 900`
(15 min) · **Actions:** `data.tag_responses`, `notify.in_app`

**Why a real CX manager needs this:** Completion time is the quietest leading
indicator of survey fatigue and question design failure, and it is almost never
monitored in real time on any XM platform I've used — it shows up, if at all, as an
average in a post-hoc analytics tab, long after the damage to the response rate is
done. A response that takes 15+ minutes on a survey designed for 3 is either a
respondent who got stuck, confused, or multitasking through it — and a cluster of
those is an early warning that your completion rate is about to fall off a cliff. This
template auto-tags the outlier responses so a CX manager has a pre-filtered list
waiting for them instead of having to go hunting through raw response-level data to
even notice the pattern exists.

## 4. Critical Alert to Zendesk (`critical-alert-to-zendesk`)

**Trigger:** `alert.fired` · **Condition:** `severity == "critical"` ·
**Actions:** `crystal.classify`, `zendesk.create_ticket`, `notify.slack`

**Why a real CX manager needs this:** This is the template closest to the alerting
redesign I shipped at my last company, and it targets the exact failure mode that made
mean-time-to-respond 4.2 days instead of 38 minutes: a critical signal firing into a
dashboard or inbox that a support team doesn't monitor is functionally the same as the
signal not firing at all. Support and CX teams live in Zendesk, not in an XM
platform's alert center. A critical alert that doesn't automatically become a ticket in
the system the response team already works out of will get triaged whenever someone
happens to check the other tool — which, on a bad week, is never. This closes that gap
without requiring a human in the loop to notice the alert exists in the first place.

## 5. Anomaly to Jira Backlog (`anomaly-to-jira`)

**Trigger:** `crystal.anomaly_detected` · **Actions:** `crystal.summarize`,
`jira.create_issue`, `notify.email`

**KNOWN GAP — action required before enabling (Nina, 2026-07-01,
XM_VERIFICATION_REPORT.md Priority 1 fix):** this template's `notify.email` node
has no `config.userId`. Before this pass it "worked" only because
`workflowEngine.ts` silently fell back to `ctx.event.userId` — a misdirection risk
now removed (see Priority 1). As of this fix, the email action will return
`status: 'skipped'`/`reason: 'no_recipient_configured'` and never actually send
until an org admin sets an explicit recipient on that action node. This is a
known, intentional trade-off (fail-clean over fail-silent-wrong) — not a
regression to "fix" by restoring the fallback.

**Why a real CX manager needs this:** Statistical anomalies Crystal detects — a
sudden spike in a topic, a metric moving outside its normal band — are exactly the
kind of "passive insight" that dies in a dashboard nobody proactively checks. The
product and engineering teams who'd actually act on an anomaly don't live in an
insights feed; they live in their backlog. If a real anomaly can't turn into a
ticket in the system-of-record the owning team already triages daily, it competes for
attention with every other dashboard tile and loses. This template is the same "detect
→ route → land where work already happens" pattern as the Zendesk template above,
aimed at product/eng instead of support — because the failure mode is identical
regardless of which team is supposed to receive the signal.

---

## Gaps for later waves (not buildable against today's registry — flagging, not building)

These four ideas from `WORKFLOW_SYSTEM.md` §14's aspirational 15-template list are
good product ideas but need a trigger/action/condition-field that does not exist in
`workflowRegistry.ts` today. Per scope, I am not adding these myself — noting them for
Amara (AI triggers, Wave 3) or a future integrations wave instead of shipping a
template that would silently no-op or error at runtime:

- **New Topic Alert** (WORKFLOW_SYSTEM.md Template 4) — needs `crystal.topic_emerged`,
  which is not in `TRIGGERS`. Closest existing trigger is `crystal.insight_ready`, but
  that fires on pipeline completion, not topic emergence specifically — using it would
  misrepresent what the template does. Candidate for Amara's Wave 3 AI trigger work.
- **Survey Close-Date Warning** (Template 6) — needs `survey.expiring_soon`, not in
  `TRIGGERS`. No existing trigger approximates a time-until-close signal.
- **Customer Churn Risk Alert** (Template 13) — needs `crystal.prediction_alert`
  (churn-risk scoring), not in `TRIGGERS`. This is a genuinely different capability
  from the existing `crystal.anomaly_detected`/`crystal.insight_ready` triggers, not a
  relabeling of one of them.
- **PagerDuty escalation** (referenced in Template 3's original spec and the
  competitive matrix in §15) — there is no PagerDuty connector in `connectors.ts` and
  no `pagerduty.*` action in `ACTIONS`. The seeded `verbatim-escalation` template
  (from the original 3) correctly uses `notify.slack` instead, which is what's
  actually wired — worth flagging so nobody assumes PagerDuty support exists because
  the design doc mentions it.

I did not force any of these into the registry myself — that's a scope violation
(engineering owns `workflowRegistry.ts`) and would produce a template that looks real
in the gallery but silently does nothing (`status: 'skipped', reason: 'not_wired'`)
when a customer tries to use it, which is worse than not offering it at all.
