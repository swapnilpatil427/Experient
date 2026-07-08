# Competitive Teardown — Qualtrics Action Planning vs. Medallia Alert Rules vs. Xperiq Actions

**Owner:** Simone Dufour, Senior PMM, Automation and AI Features
**Status:** Draft — category-level teardown, not a line-by-line feature audit
**A note on sourcing, read this before using any line externally:** I do not have current,
first-hand access to a live Qualtrics or Medallia environment as part of this task, and I'm
not going to invent specific limitations for either product that I can't point to a source
for. What follows is framed around **structural category differences** — how each type of
product is architected to behave — rather than specific claims like "Vendor X's alert rule
only supports email and nothing else," which I have no current basis to assert as fact. Where
I use the word **"typically"**, I mean: this is the common shape of this category of product,
based on how XM/CX platforms in this space are generally structured, not a verified audit of
one vendor's current release. Sales and marketing should treat this doc as a structural
argument to make in a conversation, not a canned "competitor does X, we do Y" slide to publish
without a named source per line.

---

## The category difference, in one paragraph

Enterprise XM platforms were built to *collect and display* experience data: surveys in,
dashboards out. Alerting and "action planning" features were added on top of that foundation
later, and they typically inherit the foundation's shape — a human looks at a report, decides
something needs to happen, and starts a tracked, human-driven process (an assigned task, an
emailed alert) to make it happen. Xperiq Actions was not built as an alerting layer bolted
onto a reporting platform — it's a workflow engine wired directly into both the survey data
model and Crystal's AI insight pipeline, with the explicit design goal that a defined signal
triggers a real downstream action (a ticket, a message, a tagged record) without a human
having to notice the signal first. That's the structural difference underneath every row
below.

---

## Comparison Table

| Dimension | Qualtrics — Action Planning (typical shape of this feature category) | Medallia — Alert Rules (typical shape of this feature category) | Xperiq Actions (verified against shipped code, 2026-07-01) |
|---|---|---|---|
| **Core model** | Action planning is typically a project-management layer: a low/negative score generates a task, assigned to an owner, tracked to resolution by a human | Alert rules are typically threshold-based notifications: a score crosses a line, a person or distribution list is emailed | A trigger (threshold, milestone, schedule, inbound webhook, or an AI-detected signal) fires a graph of actions automatically — no assignment step required for the action itself to execute |
| **Who has to notice the signal first** | A human, to open/assign the resulting task | A human, reading the alert email | No one — the workflow engine evaluates the condition and executes the action chain itself |
| **AI-detected trigger types** | Not something we can verify without vendor access; action planning is typically initiated from a scored survey response, not a pipeline-level pattern-detection signal | Not something we can verify without vendor access; alerting is typically threshold-based, not pattern-detection-based | Sentiment spike, new emerging theme, and statistical anomaly are real, shipped trigger types sourced from Crystal's insight pipeline (confidence threshold + hysteresis to avoid false-positive spam), in addition to conventional thresholds |
| **Where the response lands** | Typically inside the platform's own task/case management surface | Typically an email, sent to a person or list | Native connectors to Slack, Jira, Zendesk, ServiceNow, email, or a signed outbound webhook to your own system — the workflow can also tag survey responses directly |
| **Bridging to a team's actual tools (Slack, Jira, etc.)** | Typically requires a separate integration or middleware step to route a task into a tool outside the platform **(typical for this category — not a claim about a specific current Qualtrics integration)** | Typically limited to the alerting channel(s) natively supported; routing into a ticketing system typically requires a separate integration **(typical for this category)** | Built-in connector for each destination, credentialed per-org, executes as one step in the same workflow — no separate integration product required |
| **Builder experience** | Typically configuration screens within the platform's admin area; complexity scales with the platform's broader configuration model | Typically a rules/threshold configuration screen | Three ways to build: a linear step builder, a branching visual canvas (drag/connect), or a plain-English description parsed into a runnable workflow by Crystal, with a confidence score and a review step before anything goes live |
| **Analysis attached to the trigger** | Not something we can verify without vendor access | Not something we can verify without vendor access | A workflow step can invoke Crystal to summarize or classify the underlying signal and attach that output to the same alert (e.g., a Jira ticket body that already contains Crystal's summary) |
| **Credential/integration security model** | Not something we can verify without vendor documentation | Not something we can verify without vendor documentation | Per-org encrypted credential vault (AES-256-GCM), gated behind an explicit `workflows:manage` permission, isolated per organization — verified in code and covered by regression tests, including a real RBAC gap that was found and fixed during hardening |
| **Delivery reliability** | Not something we can verify without vendor access | Not something we can verify without vendor access | Async execution with exponential backoff retry and a dead-letter queue for actions that exhaust retries, plus an idempotency key so a redelivered trigger event cannot double-fire the same action — tested behavior, not an unverified claim |
| **Time to first automation** | Typically longer for anything beyond the platform's default action-planning flow, given configuration and rollout norms for this category **(typical, not a specific timed claim)** | Typically fast for a single email rule, slower for anything requiring custom routing **(typical)** | A workflow can be built and enabled in one sitting via the linear builder or the NL builder; TEAM.md's launch target is a median time-to-first-workflow under 10 minutes post-signup — a target we're tracking toward, not yet a measured GA result |

---

## What we will NOT say in this teardown (and why)

- We will not state a specific number of weeks/months required to configure either
  competitor's product. We have no current, sourced measurement of that.
- We will not claim either competitor "cannot" do something structurally possible for their
  platform (e.g., "Medallia cannot integrate with Jira at all") without a named, checkable
  source. The honest claim is that *our* native connector requires no separate integration
  product — that's verifiable in our own code today.
- We will not cite a specific AI-trigger precision/accuracy percentage for Xperiq Actions in
  external copy yet. The confidence-threshold-and-hysteresis design is real and tested; the
  end-to-end precision number against a live, sustained data stream (TEAM.md's Phase 3 target:
  sentiment_spike >= 90% precision on a 50-case test corpus) has not been measured against
  production traffic yet — see `POSITIONING.md`'s Known Gaps section.

## Where this argument is strongest for sales

The single most defensible, source-backed claim in this teardown is the **native-connector +
async-reliability combination**: a signal (including an AI-detected one) can travel from
detection to a ticket already open in the team's real tool of record, with retry and
dead-letter handling if a downstream service is briefly unavailable — all of that is real,
tested code today, not a slide. Lead with that structural claim in conversation rather than
any unverified statement about what a specific competitor's product can or cannot do.
