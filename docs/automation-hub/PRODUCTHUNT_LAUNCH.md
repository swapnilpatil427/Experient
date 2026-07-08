# ProductHunt Launch Plan — Xperiq Actions

**Owner:** Simone Dufour, Senior PMM, Automation and AI Features
**Status:** Draft plan. Builds on `GTM.md`'s Phase 2 launch section (title/tagline/day-of
mechanics already sketched there) — this doc expands it into an executable plan and updates
the demo asset references to match what's actually shipped, so nothing in the launch
overclaims relative to `POSITIONING.md`'s Known Gaps.

---

## Title

**Xperiq Actions — Workflows that fire when Crystal sees something, not when you check a dashboard**

(Shorter alt, matching GTM.md's existing framing: **"Xperiq Actions — AI-triggered automations for CX teams"**)

## Tagline

**"Your data acts. Before you check it."**

(Carried forward verbatim from GTM.md — already-approved 7-word line, no reason to replace a
line that compresses the value prop correctly.)

## Thumbnail Concept

A looping, 3-second animation (GIF or short MP4, autoplay-muted-loop per PH norms):

1. Frame 1: a chat-style input box. Text types itself: *"Alert my team when NPS drops below 30 and open a ticket."*
2. Frame 2: the Crystal "thinking" moment — the existing 3D crystal accent
   (`NLThinkingCrystal.tsx`, gated behind `prefers-reduced-motion` with a CSS fallback in the
   real product) briefly renders, then workflow cards stagger-fill into place beneath the
   input (this is the real, shipped Crystal-fill animation, not a mockup).
3. Frame 3: a Slack message appears: *"NPS dropped to 27 on CSAT Q3"* — cut immediately to a
   Jira ticket card opening.
4. Loop back to frame 1.

**Why this concept and not a generic dashboard screenshot:** it shows the actual
differentiator (natural language → running workflow → real downstream action) in three
seconds, using motion that exists in the shipped product today — nothing here is a designer's
imagined future state.

## Video Description (90-second demo — full script in `DEMO_SCRIPT.md`)

> Every XM platform gives you a dashboard. Xperiq gives you a system that acts. Watch an NPS
> drop go from silent signal to a Slack alert, a Jira ticket, and a Crystal-written summary —
> automatically, before anyone opens a dashboard. Then watch the same automation get built
> from scratch in under a minute, just by describing it in plain English. No implementation
> team. No config manual. Full script and trigger/action chain in the demo video description
> on the product page.

(Video description intentionally does not cite a specific end-to-end latency number — see
`POSITIONING.md` Known Gaps: the full live-infrastructure timing run for the AI-trigger path
hasn't happened yet. The demo's threshold-trigger path, `score.nps_drop` → `notify.slack` →
`jira.create_issue` → `crystal.summarize`, is fully real and doesn't carry that caveat.)

## Maker Comment (first comment, posted immediately at launch by Simone)

**"The Monday Morning Pain" — first-person, ~200 words:**

> I've spent years watching CX teams live the same Monday. You open your dashboard, NPS
> dropped sometime last week, and now you're playing detective: when did this start, who do I
> tell, what actually caused it. By the time you've forwarded the chart to three people and
> filed a ticket for someone to look into it, the moment where you could've caught this early
> is gone. That's not a data problem — XM platforms are very good at collecting and displaying
> data. It's a distance problem. The distance between a system that sees a signal and a human
> who has to notice it, interpret it, and manually go do something about it in a totally
> different tool.
>
> Xperiq Actions is what we built to close that distance. A threshold crossing, a survey
> milestone, or a pattern Crystal detects in your open-text responses — each one can trigger a
> real action automatically: a Slack message, a Jira ticket, a Zendesk case, a Crystal-written
> summary attached to the alert. Built with a visual canvas, a linear builder, and a
> plain-English builder where you just describe what you want and Crystal builds it.
>
> We've been heads-down on making this reliable, not just demo-able — async execution with
> retries and a dead-letter queue, per-org encrypted credentials, real connector integrations.
> Would love your feedback, especially on what automation you'd build first.

## Comment Strategy (launch day + week 1)

1. **T-0 (12:01 AM PST, Tuesday):** Maker comment goes up immediately (above).
2. **T+1–2 hours:** Simone personally replies to every early comment with a specific, concrete
   answer (not a generic "thanks!") — if someone asks about a trigger type or integration,
   answer with the real registry name, not marketing language, to build credibility with a
   technical PH audience.
3. **Beta users (recruited per GTM.md's Phase 1 beta cohort) notified 1 week prior** to be
   ready to comment with a real use case, not just an upvote — PH's algorithm and community
   both reward comments describing genuine usage over generic praise.
4. **Mid-day comment (Simone):** a reply thread surfacing one of the 8 real templates
   (`TEMPLATE_GALLERY.md`) with the exact trigger → action chain, inviting people to guess
   what they'd automate first — designed to surface real use-case comments from the broader PH
   audience, not just the seeded beta cohort.
5. **End-of-day comment:** a transparent note on what's next — explicitly mention that AI
   triggers (Crystal Signals) are live and that we're in the process of validating them
   against sustained production traffic, rather than letting silence read as evasiveness if a
   technical commenter asks a hard question about precision/latency. This mirrors
   `POSITIONING.md`'s Known Gaps section — say the true thing before someone else asks.
6. **Week 1 follow-up:** reply to any comment asking "does this replace [tool]" with the
   objection-handling language from `POSITIONING.md` (iPaaS/Zapier comparison, "reacts to
   meaning not events") — consistent messaging across every channel.

## What NOT to do in comments

- Do not state a specific AI-trigger precision/accuracy number (not yet measured against live
  traffic — see Known Gaps).
- Do not claim a specific end-to-end trigger-to-action latency number for the AI-trigger path.
- Do not disparage a named competitor's product with a specific unverified claim — if asked to
  compare, use the structural framing from `COMPETITIVE_TEARDOWN.md`.

## Target

Top 3 Product of the Day (unchanged from GTM.md's existing target — no new information changes
this goal).
