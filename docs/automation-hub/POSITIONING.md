# Xperiq Actions — Positioning Document

**Owner:** Simone Dufour, Senior PMM, Automation and AI Features
**Status:** Draft for team review — grounded in what is built and tested as of 2026-07-01
(Phase 1 + 2 + 3 complete per `docs/automation-hub/TRACKER.md`; 75 backend test files / 911
tests, 1666 CrystalOS tests, 58 frontend test files / 593 tests, all passing).
**Builds on:** `docs/automation-hub/GTM.md` (v1.0, 2026-06-29) — that doc was written before
the engine existed and describes the target narrative correctly, but its competitive matrix
predates real trigger/action names. This doc reconciles the message with the shipped system
and should be read as GTM.md's grounding update, not a replacement. Where the two differ on a
specific claim, this doc's wording is the one to use externally, because it is checked against
source.

---

## One-Pager

### The problem

A CX program today produces a lot of signal and very little movement. NPS drops on
Thursday. Someone notices on Monday. The chart gets forwarded to three people in three
emails. Someone requests an ad hoc analysis. Two days later, an answer arrives — usually
after the moment to act on it has already passed. None of this is a data problem. It's a
distance problem: the distance between the system that sees a signal and the system a human
actually has to act inside (Slack, Jira, Zendesk, a backlog) is too far to close by hand,
every time, for every signal, forever.

### The unlock

Xperiq Actions closes that distance. It is a workflow engine, wired directly into the survey
data model and into Crystal's insight pipeline, that watches for a defined signal — a
threshold crossed, a milestone hit, an AI-detected pattern — and executes a chain of real
actions the moment it fires: a Slack message, a Jira ticket, a Zendesk ticket, a tagged
response, a Crystal-generated summary attached to the alert. No dashboard tab required. No
human has to remember to check.

This is not a vision-stage feature. As of this pass, the engine runs async with retry and a
dead-letter queue, actions are delivered through six real connectors (Zendesk, Jira,
Salesforce, ServiceNow, Slack, email, and signed outbound webhooks), credentials are stored
per-org in an encrypted vault, and workflows can be built three ways — a linear step builder,
a branching visual canvas, or by describing the automation in plain English to Crystal.

### Seven words

**"Your CX data stops waiting to be read."**

(Alternate, action-forward: **"Signal in. Action out. No human required."**)

### Proof it's real, not a slide

| Capability | Status |
|---|---|
| Async execution engine (Redis Streams, retry w/ backoff, dead-letter queue, idempotency) | Built, tested |
| Per-org encrypted credentials vault (AES-256-GCM) | Built, tested |
| Connectors: Zendesk, Jira, Salesforce, ServiceNow, Slack, email, signed webhook (HMAC-SHA256) | Built, tested |
| Workflow list UI, linear builder, branching visual canvas | Built, tested |
| Natural-language builder (describe it, Crystal builds it) with confidence scoring and a 3D "thinking" moment | Built, tested |
| AI-driven triggers sourced from Crystal's insight pipeline: sentiment spike, new theme detected, statistical anomaly | Built, tested (CrystalOS side); backend seam reconciled on paper, full live integration pass still pending — see Known Gaps below |
| 8 ready-made templates, each mapped to a real trigger/condition/action combination that executes today | Built, seeded |

---

## Competitive Matrix

Framed by capability category, not by specific claims about a named competitor's current
product that we can't verify firsthand. Where we don't have direct product access to confirm
a competitor detail, it's marked **(typical)** — a structural pattern common to the category,
not a specific claim about one vendor's roadmap.

| Capability category | Traditional XM alerting (typical) | Xperiq Actions |
|---|---|---|
| What triggers a response | A person reads a dashboard or digest and decides to act | The system detects the condition and acts automatically |
| Trigger source | Manual thresholds a human configures and checks periodically | Manual thresholds **and** AI-detected signals sourced directly from the insight pipeline (sentiment spike, emerging theme, statistical anomaly) |
| Where the alert lands | Email inbox or an in-platform alert center the response team may not monitor | The system your response team already works in — Slack, Jira, Zendesk, ServiceNow — via native connectors, not a generic export |
| Response team's tool doesn't match the alerting tool | Typically requires a middleware integration (iPaaS/Zapier-style) or a services engagement to bridge the gap **(typical)** | Native connector, no middleware step |
| How a workflow is built | Configuration screens and/or a services/professional-services engagement for anything beyond a single email rule **(typical for enterprise alerting tooling)** | Visual canvas, linear step builder, or plain-English description parsed by Crystal into a runnable workflow |
| Credential storage for third-party tools | Varies by vendor; enterprise-tier integrations are common but the storage/security model is not something we can verify without vendor documentation | Per-org encrypted credentials vault (AES-256-GCM), gated by an explicit `workflows:manage` permission, isolated from other orgs' credentials |
| Reliability model | Not independently verifiable from outside the product | Async queue with exponential backoff retry, dead-letter queue for undeliverable actions, idempotency key so a redelivered event can't double-fire an action |
| Analysis attached to the alert | Typically a link back to a dashboard, requiring a second tool-switch to interpret | Crystal can generate a written summary as part of the same automation, delivered alongside the alert |

**How to read this table honestly:** we have not independently audited Qualtrics' action
planning workflows or Medallia's alert rules against their current shipped state — this
section deliberately avoids specific claims like "Vendor X's alerts only support email" or
"Vendor X requires N weeks of professional services," because we don't have a current,
sourced basis for those numbers. The real, defensible claim is structural: XM platforms are
built to *display* signal; Xperiq Actions is built to *act on* it, with the trigger surface
(including AI-detected signals) and the action surface (native, credentialed integrations)
to back that up today, in tested code — not on a roadmap slide.

---

## Objection Handling

**"How is this different from a Zapier/iPaaS integration bolted onto our XM platform?"**
> An iPaaS tool reacts to events — a new row, a form submission, a webhook payload. Xperiq
> Actions reacts to CX *meaning*: an NPS threshold crossing (with the survey data model
> already understood, not remapped field-by-field), or a Crystal-detected sentiment spike
> that has no equivalent "event" in a generic automation tool because it doesn't exist until
> Crystal's insight pipeline produces it. That's a different input signal, not a different
> plumbing layer for the same one.

**"AI-detected triggers sound like a black box. How do I trust `sentiment_spike` won't spam my team?"**
> Every AI trigger in the shipped system uses a defined confidence threshold plus a hysteresis
> rule specifically to prevent flapping/false-positive spam — this was a named design
> requirement (Amara Osei's Wave 3 build), not an afterthought. It's also fair to say the
> full live-traffic validation pass (confidence tuning against a real, sustained data stream)
> is the next step before we'd claim a specific precision number externally — see Known Gaps.

**"We already have alert rules / action planning in our current platform. Why switch?"**
> You likely already have a way to get *notified*. The question worth asking is what happens
> after the notification — does it open a ticket in the system your response team already
> works from, automatically, with no one having to notice the alert and manually create that
> ticket? That handoff — signal to native action, not signal to inbox — is the category
> difference, and it's what Xperiq Actions is built around end to end.

**"Is this an enterprise-only, services-required feature?"**
> No — a workflow can be built three ways (visual canvas, linear builder, or a plain-English
> description that Crystal turns into a runnable workflow), and none of the three requires an
> implementation engagement. Per-org credentials are self-serve through the workflow
> credentials settings screen.

**"What happens if a downstream action (Slack, Jira, etc.) is down or times out?"**
> The execution engine is async with automatic retry (exponential backoff) and a dead-letter
> queue for actions that exhaust retries — failures are visible and recoverable, not silent.
> This is tested behavior (reliability test suite), not a claim without a corresponding test.

---

## Known Gaps — flagged, not hidden

Per the "ground copy in what's true today" mandate, here is what is real but not yet fully
closed, so no launch asset overclaims:

1. **AI trigger seam (CrystalOS → backend) is reconciled on paper, not yet run end-to-end
   against live infrastructure.** Both sides were built independently against a documented
   contract and cross-checked line-by-line, but there has been no live Postgres+Redis run of
   the full chain yet. External copy should say "Crystal-detected signals can trigger
   workflows" (true, tested on each side) and should NOT cite a specific end-to-end latency
   number until that run happens (TEAM.md's Phase 3 target of <45s end-to-end is a target, not
   yet a measured result).
2. **Three Crystal actions (`crystal.summarize`, `crystal.classify`, `crystal.write`) are
   implemented as stubs** (`live: 'stub'` in the registry) — they run and return a structured
   result inside a workflow today, but are not yet backed by a live LLM call in production.
   Copy should describe "Crystal generates a summary as part of the workflow" without implying
   the summary text comes from a fully live model call in this build.
3. **Three integration connectors (Jira, Salesforce, ServiceNow, Zendesk) run in "env" mode**
   — they execute for real once an org's environment/credentials are configured, and no-op
   gracefully otherwise. This is a legitimate and common pattern (nothing fires until you
   connect the tool), but it means "native Jira integration" should not be read as "zero setup
   required" — a credential/connection step is real and expected.
4. **Two of TEAM.md's Phase 1 literal success metrics are unmeasured, not failing** — the
   100-concurrent-trigger/<5s throughput target and the 20-case threshold-trigger test corpus
   were flagged by Maya's acceptance review as not yet run against real infrastructure. Do not
   cite either number externally until Kenji's reliability suite produces a measured result.
5. **Integration-partner listings (Slack App Directory, Atlassian Marketplace, Zendesk
   Marketplace) and co-marketing collateral are out of scope for this pass.** GTM.md's Phase 4
   describes target listings; those require actual partner relationships and submission
   processes this documentation task cannot create. Tracked as a follow-up for whoever owns
   partner relationships, not fabricated here.

---

## "Zero Dead Data" Narrative + Launch Copy

### Headline
**Your data stops sitting there.**

### Subhead
Xperiq Actions turns every signal your platform detects — a threshold crossed, a milestone
hit, a pattern only Crystal can see — into a Slack message, a Jira ticket, a Zendesk case, or
a written analysis, the moment it happens. No dashboard required. No one has to remember to
look.

### Three supporting bullets

1. **It watches, so your team doesn't have to.** NPS threshold crossed, a survey milestone
   reached, a response flagged as an outlier — Xperiq Actions evaluates the condition and
   fires the response automatically, on a workflow engine built for retries and delivery
   guarantees, not a cron job someone forgot about.
2. **It lands where your team already works.** Slack, Jira, Zendesk, ServiceNow, email, or a
   signed webhook into your own system — native connectors, not a spreadsheet export someone
   has to manually route.
3. **It thinks, not just notifies.** Attach a Crystal-generated summary to the alert itself,
   or let Crystal build the entire workflow from a plain-English description — "tell me when
   NPS drops and open a ticket" becomes a running automation without a configuration manual.

### One-line versions (for ad copy / social)
- "Your data acts. You don't have to ask it to." (evolution of GTM.md's existing 7-word line,
  kept consistent with the "Your data acts. Before you check it." line already approved there)
- "Dead data doesn't file its own Jira ticket. Xperiq does."

---

## Notes on continuity with GTM.md

GTM.md (2026-06-29) already established: the brand names (Xperiq Actions, Crystal Signals,
Action History, Crystal Builder, Action Playbooks, Safe Run), the primary/secondary/tertiary
audience definitions, the pricing tier table, and the core "signal to action" narrative. This
document does not re-litigate any of that — it exists to update the *evidentiary basis* under
the same narrative now that the product is real, and to add the specific proof points,
objection handling, and gap-flagging that GTM.md (written pre-build) couldn't yet include.
One correction worth carrying forward: GTM.md's competitive matrix cites a generic
"NPS threshold" trigger — the shipped registry implements this as two directional triggers,
`score.nps_drop` and `score.nps_rise` (the latter is also a template, "NPS Win Celebration" —
see BLOG_5_AUTOMATIONS.md). Future copy should reflect the directional pair, since the "don't
just alarm on the bad news" angle is a genuine, differentiated product decision worth using
in narrative copy, not just an implementation detail.
