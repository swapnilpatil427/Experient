# 5 Automations Every CX Team Should Have Running

**Author:** Simone Dufour, Senior Product Marketing Manager, Xperiq
**Target length:** ~800 words (body below is written to spec)
**SEO target:** "cx automation," "customer experience automation," "nps alert workflow"
**Template links:** all five automations below correspond to real, seeded templates in the
Xperiq Actions gallery (`docs/automation-hub/TEMPLATE_GALLERY.md`) — every trigger, condition,
and action named here exists in `backend/src/lib/workflowRegistry.ts` today. Nothing below is
a roadmap item wearing a launch post's clothing.

---

It's Monday morning. You open your CX dashboard. NPS dropped last Thursday. Nobody noticed
until now, because nobody was looking at a chart on a Thursday — they were doing their jobs.
By the time you forward the screenshot to three people in three separate emails, the moment
to catch it early is gone.

This is not a data problem. Every platform in this category will show you the chart. The gap
is what happens between the chart updating and a human doing something about it. Xperiq
Actions exists to close that gap — not with another dashboard, but with a workflow engine that
watches for a defined signal and executes a real response the moment it fires: a Slack
message, a Jira ticket, a Zendesk case, a tagged response, or a Crystal-written summary.

Here are five automations, live in the Xperiq Actions template gallery today, that we'd put on
every CX team's list before anything fancier.

### 1. Critical Alert to Zendesk

**What it does:** When a critical-severity alert fires, Crystal classifies it, a Zendesk
ticket opens automatically tagged and prioritized, and your team gets a Slack ping — all
before anyone has to notice the alert exists.

**Real-world scenario:** Imagine you run CX for a 300-person SaaS company. Your support team
lives in Zendesk, not in your XM platform's alert center. A critical signal that lands
somewhere your support team doesn't check is functionally the same as a signal that never
fired. This template closes exactly that gap — the alert becomes a ticket in the tool your
team already triages daily, with no manual routing step.

**Template:** [Critical Alert to Zendesk](TEMPLATE_GALLERY.md#4-critical-alert-to-zendesk) —
trigger: `alert.fired` (severity = critical) → `crystal.classify` → `zendesk.create_ticket` →
`notify.slack`. Time to set up: under 5 minutes.

### 2. Anomaly to Jira Backlog

**What it does:** When Crystal detects a statistical anomaly — a topic spiking, a metric
moving outside its normal band — the finding becomes a Jira issue in your backlog, with a
Crystal-written summary attached, plus an email so the assignment doesn't get missed.

**Real-world scenario:** Your product and engineering teams don't live in an insights feed.
They live in their sprint backlog. An anomaly that only ever shows up as a dashboard tile
competes with every other tile for attention and loses. This template routes the finding
straight into the system the owning team already works from — the same "detect, route, land
where the work already happens" pattern as the Zendesk template above, aimed at product/eng
instead of support.

**Template:** [Anomaly to Jira Backlog](TEMPLATE_GALLERY.md#5-anomaly-to-jira-backlog) —
trigger: `crystal.anomaly_detected` → `crystal.summarize` → `jira.create_issue` →
`notify.email`. Time to set up: under 5 minutes.

### 3. Slow Completion Flag

**What it does:** Any response that takes 15+ minutes to complete gets auto-tagged and
surfaced in-app — before your completion rate quietly falls off a cliff.

**Real-world scenario:** Imagine your team ships a 3-minute pulse survey and starts seeing
completion times of 18 minutes on a handful of responses. That's not noise — it's respondents
getting stuck, confused, or multitasking through a broken question. Completion time is one of
the quietest leading indicators of survey fatigue, and it almost never shows up until it's an
average buried in a post-hoc analytics tab. This template gives you a pre-filtered list of
outliers waiting for you instead of a haystack to search.

**Template:** [Slow Completion Flag](TEMPLATE_GALLERY.md#3-slow-completion-flag) — trigger:
`survey.response_received` (completion_time >= 900s) → `data.tag_responses` →
`notify.in_app`. Time to set up: under 5 minutes.

### 4. Survey Milestone Kickoff

**What it does:** The moment a survey crosses a response-volume milestone, Crystal runs an
early summary and posts it to Slack, so someone gets a first look before the survey closes —
not after.

**Real-world scenario:** The classic failure of a 3-week survey program: nobody looks at the
data until it closes, by which point a confusing question or a broken skip-logic branch has
already contaminated the full dataset. This template turns "check on it sometime" into
something that just happens automatically at the volume that matters — catching a bad
question on response 100 instead of response 4,000.

**Template:** [Survey Milestone Kickoff](TEMPLATE_GALLERY.md#2-survey-milestone-kickoff) —
trigger: `survey.milestone_reached` → `crystal.summarize` → `notify.slack` →
`notify.in_app`. Time to set up: under 5 minutes.

### 5. NPS Win Celebration

**What it does:** When NPS rises, your team hears about it — not just when it drops.

**Real-world scenario:** Most XM platforms treat NPS movement as a one-directional alarm: it
only fires when things get worse. Teams that only ever hear about NPS in a crisis start to
associate the entire measurement program with bad news. Closing the loop on wins as fast as
losses is one of the highest-leverage, lowest-cost things a CX team can do for morale and
executive buy-in — "what did we just do right, and can we do more of it" needs to be asked
within days, not rediscovered three months later in a QBR deck.

**Template:** [NPS Win Celebration](TEMPLATE_GALLERY.md#1-nps-win-celebration) — trigger:
`score.nps_rise` → `notify.slack` → `notify.in_app`. Time to set up: under 5 minutes.

---

None of these require an engineering ticket, a services engagement, or a week of
configuration. Each one is a template in the Xperiq Actions gallery today — clone it, point it
at your survey, turn it on.

**Start with the Critical Alert to Zendesk template →** (or NPS Win Celebration, if your team
could use some good news this week too.)

---

*Three more templates exist in the gallery today (NPS Recovery on detractor response, Weekly
Digest on a schedule, Verbatim Escalation on an urgent flagged comment) — see the full gallery
in `TEMPLATE_GALLERY.md`. We picked these five for this post because they span the widest
range of "signal type" (threshold, milestone, AI anomaly, data-quality, positive-signal) in
the smallest number of automations.*
