# 90-Second Demo Video Script — Xperiq Actions

**Owner:** Simone Dufour, Senior PMM, Automation and AI Features
**Status:** Draft, scripted against the real, shipped trigger/action chain — not an imagined
future state. Builds on `GTM.md`'s original script sketch (same beats: drop → Slack → Jira →
Crystal → NL builder) but grounds every on-screen claim and named field in
`backend/src/lib/workflowRegistry.ts` and `backend/src/lib/workflowEngine.ts` as they exist
today, and updates the ending to show the real NL builder UI (`WorkflowNLBuilderPage.tsx`,
`NLThinkingCrystal.tsx`) rather than a generic mockup.

**The chain this demo depicts is real and executable today:**
`score.nps_drop` (trigger) → `notify.slack` (action) → `jira.create_issue` (action) →
`crystal.summarize` (action, stub-mode: runs and returns a structured summary within the
workflow; not yet backed by a live model call in production — see note at the bottom).

---

## Script

```
0:00 — Open shot: Xperiq dashboard, NPS trend line. The line visibly ticks down.
       Text overlay: "It's 2:17 AM."

0:05 — Text overlay: "NPS just crossed the threshold. Nobody's watching."

0:10 — Cut to: a workflow card in the Xperiq Actions list, status pill "● Enabled,"
       name "NPS Drop Alert." (This is a real, buildable workflow using the shipped
       score.nps_drop trigger — not a placeholder screen.)

0:14 — Quick zoom into the workflow's trigger node: "Trigger: NPS dropped" (score.nps_drop).

0:18 — Cut to: a Slack message appearing in #cx-alerts. Message body shows the real
       templated fields the engine renders today, e.g.:
       "NPS dropped to 27 on CSAT Q3. [View workflow run]"
       Text overlay: "Step 1: Slack, the moment it fires."

0:26 — Cut to: a Jira issue opening in the CX project. Ticket summary field populated
       from the workflow's real render() templating (e.g. "NPS Alert — CSAT Q3").
       Text overlay: "Step 2: A ticket, already in the backlog your team works from."

0:34 — Cut to: the Jira ticket's description field, showing a Crystal-generated summary
       line appended to it (crystal.summarize's real output variable, `crystalSummary`,
       rendered into the ticket body).
       Text overlay: "Step 3: Crystal's read on what's happening — attached automatically."

0:42 — Text overlay: "Nobody built this at 2 AM. It ran itself."

0:46 — Cut to: 9:00 AM. A CX manager opens Slack, sees the alert already sitting there,
       opens the linked Jira ticket — already assigned, already summarized.
       Text overlay: "Your team wakes up. It's already handled."

0:53 — Hard cut to: the Xperiq Actions "New Workflow" screen. User clicks "Describe it"
       (the real Crystal Builder / NL builder entry point).

0:58 — User types: "Alert my team in Slack and open a Jira ticket when NPS drops below 30."

1:03 — The real 3D Crystal "thinking" accent briefly renders (NLThinkingCrystal.tsx —
       gated behind reduced-motion in the real product; show the full-motion version here).

1:07 — Workflow cards stagger-fill into the builder one by one: Trigger card
       ("NPS dropped"), Slack action card, Jira action card — this is the actual
       Crystal-fill animation shipped in the product, not a separate mockup.

1:13 — A confidence badge appears on the confirm card (real UI element — reflects the
       parser's actual confidence score for this parse, not a fixed prop for the demo).

1:16 — User clicks "Enable." Status pill flips to "● Enabled."
       Text overlay: "From a sentence to a running automation."

1:21 — Text overlay: "No implementation team. No config manual."

1:25 — Xperiq logo card. "xperiq.com/actions"

1:28 — End.
```

---

## Production notes

- **Do not fabricate a specific end-to-end latency overlay** (e.g., "fires in 12 seconds").
  The full live-infrastructure timing run for this chain has not been executed yet per
  `TRACKER.md` — TEAM.md's Phase 3 target of <45s end-to-end is a target, not a measured
  result. If a latency claim is wanted on screen, use directional language only: "Before your
  Monday review," not a specific second count.
- **The Slack/Jira card contents shown at 0:18–0:34 should be captured from an actual test-run
  of the `critical-alert-to-zendesk`-style chain or an equivalent NPS workflow** against a
  real (even if staging/sandboxed) org, not hand-designed mockup text — this is easy to get
  wrong by having a designer freehand a Jira card that doesn't match the real
  `jira.create_issue` connector's field mapping (`summary`, `description`, `issueType` — see
  `backend/src/lib/connectors.ts::jiraCreateIssue`).
- **The NL builder segment (0:53–1:16) should be a real screen capture, not a re-created
  animation.** `WorkflowNLBuilderPage.tsx` and `NLThinkingCrystal.tsx` are shipped, tested
  components — recording the actual UI is both more honest and very likely faster than
  re-animating it from scratch.
- **`crystal.summarize` is currently a stub action** (`live: 'stub'` in
  `workflowRegistry.ts`) — it executes within the workflow and returns a real, structured
  `crystalSummary` output today, but is not yet wired to a live production LLM call. The
  on-screen summary text in the Jira ticket at 0:34 should be captured from an actual test-run
  of the stub's real output, not invented copy — this keeps the video accurate to what a
  viewer would see if they built this exact workflow themselves today.
- **Voiceover (if added) should avoid the word "instantly"** in favor of "automatically" —
  automatic and reliable (with retry/backoff) is the honest, tested claim; a hard instantness
  claim implies a latency guarantee we haven't measured yet.
