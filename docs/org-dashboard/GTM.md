# Org Intelligence Dashboard — Go-to-Market Strategy

**User-facing product name:** Command Center  
**Document owner:** Sofia Reyes (Senior PMM)  
**Last updated:** 2026-06-29  
**Status:** Approved for Phase 2 launch planning

---

## Core Message and Narrative

### Primary Tagline

**"For the first time, your entire CX program is visible in one intelligent view. No more tab-switching. No more manual roll-ups. Xperiq Command Center."**

This line earns its place because it does three things simultaneously: it names the pain (tab-switching, manual roll-ups), it names the category claim (the first time), and it promises relief through a proper noun (Command Center). It is not aspirational fluff — it is a factual statement of what we built.

### The Monday Morning Story

Every VP of CX we have interviewed describes the same Monday morning ritual. They run between 8 and 20 active survey programs. Before their 9 AM leadership standup, they need to answer: "How are we doing?" They currently answer that question the same way every time: they open four browser tabs (one per platform), export three CSVs, paste everything into a Google Sheet that someone built in 2022 and has been incrementally broken ever since, and spend 60 to 90 minutes constructing a single NPS number that they could have had in 3 seconds.

This is the moment Command Center is designed for.

Here is the story in its customer-facing form:

> Sarah is VP of CX at a 400-person SaaS company. She runs 12 survey programs: post-purchase NPS, onboarding CSAT, quarterly EX pulse, renewals health, product feedback loops, and several others. Every Monday morning, she spends 90 minutes in spreadsheets before she can walk into her 9 AM exec meeting with a coherent answer to "how are we doing?"
>
> On the Monday after she enables Xperiq Command Center, she opens her laptop at 8:52 AM. Command Center loads. In three sentences, Crystal has already told her what she needs to know: "Your org NPS is +34, up 6 points from last week, driven by strong onboarding program performance. Your Renewals Health survey needs attention — NPS dropped 12 points this week. Recommend reviewing the open-text responses from at-risk accounts before your exec meeting." She walks into the 9 AM meeting with confidence she has never had before.

**The emotional job-to-be-done is not "save time." It is "walk into the meeting with confidence."** Time saving is the mechanism. Confidence is the emotional payoff. Our marketing speaks to the payoff, not the mechanism.

---

## Competitive Positioning Matrix

### Qualtrics XM Directory / XM Platform Manager

**What they do:** Qualtrics provides an "XM Platform Manager" view that shows active survey counts and basic completion metrics across an organization. Enterprise customers can build custom dashboards in iQ Dashboards.

**What they lack:**
- iQ Dashboards require dedicated dashboard builder skills — a VP cannot self-serve a meaningful org-level view
- No AI synthesis layer — there is no equivalent of Crystal's weekly brief
- The platform manager is operational (are surveys collecting data?) not strategic (is the data telling me something worth acting on?)
- No real-time response feed or anomaly detection across programs
- Pricing: building custom cross-survey dashboards requires the most expensive enterprise tier

**Xperiq's angle:** "Qualtrics gives your team the tools to build a dashboard. Command Center is the dashboard. Already built. Already intelligent. Available to every Xperiq customer from day one."

---

### Medallia Experience Cloud

**What they do:** Medallia's platform has strong signal-capture and role-based dashboards. Their "Experience Intelligence" layer (acquired from Mindful) can aggregate signals across touchpoints. Primarily deployed in very large enterprises with dedicated CX operations teams.

**What they lack:**
- Medallia is a high-touch, long-implementation platform — the org-level view is built during a 6-month onboarding, not available on day one
- No AI narrative layer accessible to non-technical users; insights require analyst interpretation
- Cost is prohibitive for companies under 2,000 employees
- No self-serve; everything goes through Medallia's professional services team

**Xperiq's angle:** "Medallia was built for enterprises with dedicated CX operations teams. Command Center was built for the VP of CX who is also the CX operations team."

---

### Salesforce + Tableau (BI Approach)

**What they do:** Many mid-market CX teams connect Salesforce survey data (via Feedback Management) to Tableau for cross-program dashboards. This is the DIY org-level view.

**What they lack:**
- Requires a Tableau developer to build and maintain the dashboard
- No native XM semantics: NPS, sentiment, and survey health have to be hand-built as calculated fields
- No AI synthesis — the dashboard shows what happened, not what it means
- Data freshness is typically day-old (batch ETL, not real-time)
- When the Tableau developer leaves, the dashboard breaks

**Xperiq's angle:** "If your XM visibility depends on your Tableau developer being happy and employed, you don't have an XM strategy — you have a fragile data project. Command Center is maintained by Xperiq. It gets smarter every week. It never breaks."

---

### Google Forms + Looker (Prosumer Approach)

**What they do:** Some scrappy CX teams use Google Forms or Typeform, push data to BigQuery, and use Looker or Data Studio for an aggregate view.

**What they lack:**
- No enterprise security, GDPR controls, or audit trails
- No survey intelligence (distribution logic, question branching, response quality analysis)
- Looker dashboards are static snapshots, not live
- Zero AI layer

**Xperiq's angle:** This is not a direct competitive position — customers in this category are prospects we want to move up-market. The Command Center is the proof that enterprise XM capability doesn't require enterprise XM pricing.

---

## Feature Naming and Vocabulary

### Internal vs. User-Facing Names

| Internal Name | User-Facing Name | Notes |
|---------------|-----------------|-------|
| Org Intelligence Dashboard | Command Center | "Command Center" is the branded name on all surfaces |
| org_health_score | Org Health Score | All caps in navigation, title case in body text |
| CrystalOS org_brief_graph | Crystal's Weekly Brief | Never expose the technical name to users |
| anomaly_alerts | Program Alerts | "Alerts" alone is fine in context; "anomaly" is too technical |
| tag_group_metrics | Tag Intelligence View | Used for the drill-down destination |
| survey_health_summary | Program Health | "Programs" is our user-facing word for surveys in this context |
| War Room Mode | War Room Mode | This name is used directly — it tests well with CX leaders |
| response_velocity | Response Velocity | Used as-is; it's intuitive enough in context |
| Org Insight History | Brief Archive | Pairs with "Crystal's Weekly Brief" — every past report frames as a Crystal Brief, not a database record. "History" reads like an audit log; "Archive" reads like something worth revisiting. |
| Manual org-level summary generation | Ask Crystal for a Brief | Crystal is always the subject, never a report generator — this is Crystal doing something *for* the VP, not a tool being run. The generated item is called an "On-Demand Brief." |

### Glossary of Terms (Consistent Across All Product Copy)

- **Program** — A survey program. We say "program" when talking at the org level, "survey" when talking at the survey level. A VP has "programs." A survey creator has "surveys."
- **Org Health Score** — The single 0-100 composite score for the organization. Always written as "Org Health Score" (not "health score," not "organization health score").
- **Crystal Brief** or "Crystal's Weekly Brief" — The AI-generated narrative. Crystal is always the subject — "Crystal says..." not "the AI says..." or "the brief says..."
- **Command Center** — The product name. Always two words, always capitalized, always "Command Center" not "the Command Center" (except in sentences where "the" is grammatically necessary).
- **Tag Group** — A grouping of surveys, e.g., "Customer Touchpoints," "Employee Programs." These are the org's org chart for their XM programs.
- **War Room Mode** — The dark mode variant. Always "War Room Mode" — not "dark mode," not "dark theme." The name earns emotional weight.

### Names to Avoid (and Why)

- **"Dashboard"** in user-facing copy — too generic. We say "Command Center."
- **"Anomaly"** in user-facing copy — too clinical, slightly alarming without context. We say "program alert" or "alert."
- **"Materialized view"** — never in any user-facing copy or tooltip.
- **"AI-powered"** — overused to the point of meaninglessness. We say "Crystal spotted" or "Crystal identified" — Crystal is the agent, not "AI."
- **"Single pane of glass"** — industry jargon that real users find opaque. We say "one view" or "one place."
- **"XM Platform"** — Qualtrics owns this phrase in enterprise minds. We say "experience intelligence" or "experience programs."
- **"Futuristic"** (and close synonyms: "sci-fi," "next-gen") — per Decision 13 in `DECISIONS.md`, this reads as "unproven / beta" to a risk-averse enterprise VP buyer and directly undercuts our core pitch ("this should already exist, and now it does"). We say **"sharp and effortless"** or **"finally obvious"** instead — same sense of novelty, none of the credibility tax. This applies to all customer-facing copy, marketing material, and positioning language; it does not restrict internal design/engineering docs from describing the underlying interaction patterns as advanced or ambient for team clarity.
- **"Hallucination," "low confidence," "unverified"** (per Decision 16) — all read as "something is broken" to a VP, not "here's a nuance." When a brief claim carries a flagged trust verdict, we say **"Crystal's best read"** or **"Early read — based on limited data so far."** When showing an exact score, we ask **"How sure is Crystal?"** — never "confidence score" or "trust score," both of which sound like grading the AI and invite doubt we don't need to invite.

### Brief Archive & On-Demand Brief — Supplementary Copy

*Prepared by Sofia Reyes, extending the vocabulary above.*

- **Generate button label:** "Ask Crystal for a Brief" — rejects "Generate Report" (BI-toolish, Tableau-coded) and "Run Query" (too technical, breaks the "Crystal is the agent" rule).
- **Button microcopy:** "Pick a date range. Crystal will read it and tell you what matters."
- **Trigger confirmation:** "Crystal is putting together your brief for {dateRange}."
- **Empty state (Brief Archive, zero past reports):** Headline "Crystal hasn't written a brief yet." Body: "Once your first Weekly Brief lands, it'll show up here — along with any brief you ask Crystal to put together on demand." CTA: "Ask Crystal for a Brief →". Avoid "No reports found" — clinical, implies something's missing rather than simply not-yet.
- **In-progress copy:** "Crystal is reading {surveyCount} programs for {dateRange}. This usually takes about a minute." Never "Processing," "Job queued," or "Generating report" — these read as infrastructure, not an agent at work.

---

## Ideal Customer Profile (ICP)

### Primary ICP — VP or Director of Customer Experience

**Job title variants:** VP of Customer Experience, Director of CX, Head of Customer Success & Experience, VP of Customer Insights

**Company size:** 100–1,000 employees (SMB and lower mid-market)

**Pain points:**
- Running 5–20 survey programs with no unified visibility
- Manual Monday morning reporting ritual (60–90 minutes of spreadsheet work)
- No early warning system for deteriorating programs — they find out a program has a problem from a customer complaint, not from their data
- Difficulty getting executive sponsorship for CX budget because they cannot show the CX program's health in 30 seconds
- Fear of being blindsided in executive meetings because their data is always 24–48 hours stale

**What success looks like:** Walking into any executive meeting with a real-time answer to "how is CX doing?" in one number (Org Health Score) plus three sentences of context (Crystal Brief). Getting an alert before a program goes critical, not after.

**How they currently solve this problem:** Google Sheets, Tableau dashboards maintained by someone else, weekly email reports from their team, or simply not solving it (status quo: manually check each survey platform).

**Why Command Center is the unlock:** It is the first time they can see everything in one place without building anything. Crystal Brief is the first time they have had someone (Crystal) do the synthesis for them — telling them what to care about, not just showing them all the data.

---

### Secondary ICP — C-Suite (COO, CEO)

**Job title variants:** COO, CEO, Chief People Officer, Chief Customer Officer

**Company size:** 200–2,000 employees

**Pain points:**
- Cannot get a quick read on CX health without scheduling a meeting with the CX team
- Experience programs are a black box — money goes in, results are unclear
- No confidence when analysts or board members ask "what is your NPS trend?"

**What success looks like:** Org Health Score as a board-level metric. Being able to self-serve a 30-second CX pulse without interrupting their CX VP.

**How they currently solve this problem:** They don't — they rely on quarterly reports and ad-hoc requests to the CX team.

**Why Command Center is the unlock:** Org Health Score gives the C-suite a single defensible number. Command Center becomes the tool they pull up when they want to spot-check CX health without a formal meeting.

---

### Tertiary ICP — CX Agencies (Multi-Client Programs)

**Job title variants:** CX Consultant, Client Success Manager at a CX agency, VP of Client Strategy

**Company size:** Agency managing 5–50 client programs simultaneously

**Pain points:**
- Manually switching between client accounts to build weekly reports
- No org-level view that spans multiple client programs
- Reporting to clients requires manual aggregation — high labor cost, error-prone

**What success looks like:** A single Command Center view per client that the agency can share (read-only) with the client's executive team, reducing the weekly reporting burden to near zero.

**How they currently solve this problem:** Custom Google Data Studio dashboards per client, weekly exports, manual roll-ups.

**Why Command Center is the unlock:** Command Center is the client report. The agency's weekly deliverable becomes "log in and look at Command Center." Crystal Brief is the analyst commentary the agency used to write manually.

---

## Launch Phases

### Phase 1 — Teaser (Pre-launch, 4 weeks before)

**Theme:** "One number. Your entire CX health."

**Tactic:** Post a single image on LinkedIn, Twitter, and the Xperiq blog. The image shows the Org Health Score component in isolation — a large number (e.g., "74"), the green "Healthy" label, the sparkline, and nothing else. No explanation. No product name. Just the number and "Coming soon to Xperiq."

**Target emotion:** Curiosity. CX leaders should feel "I want to know what that number is for my org."

**Copy for the teaser post:**
> "What if your entire CX program had a health score?
> One number. Updated live. Explained by Crystal in three sentences.
> Command Center is coming to Xperiq."

---

### Phase 2 — In-App Trigger

**Trigger condition:** The user's org has 3 or more active surveys with at least 10 responses each.

**Banner copy:**

```
t('orgDashboard.inAppBanner.headline') = "Your org now has a Command Center."
t('orgDashboard.inAppBanner.body') = "See all {surveyCount} of your programs in one view. Crystal has already written your first brief."
t('orgDashboard.inAppBanner.cta') = "Open Command Center →"
```

Banner styling: Full-width banner below the main nav, `bg-indigo-600 text-white`, dismissible with an X. CTA button: `bg-white text-indigo-700 font-semibold`. The banner appears once per user and does not reappear after dismissal.

---

### Phase 3 — LinkedIn Video (60 seconds)

**Format:** Screen recording with voiceover, Xperiq logo watermark, captions.

**Voiceover script (to be recorded by Sofia or a hired VO):**

> "It's Monday morning. You run 12 CX programs. Your exec meeting starts in 8 minutes.
>
> Usually, you'd spend the next 90 minutes in spreadsheets. Not today.
>
> This is Xperiq Command Center.
>
> Your Org Health Score is 74. Up 6 points from last week. Green.
>
> Crystal has already written your brief: 'NPS is up 6 points, driven by onboarding. Renewals needs attention — NPS dropped 12 points. Three responses mention contract confusion.'
>
> Three things to watch. Zero spreadsheets. One minute to read.
>
> Your renewal team is already flagged. The alert fired 20 minutes ago.
>
> You walk into the 9 AM meeting and you know exactly what to say.
>
> This is Command Center. It's included in every Xperiq plan.
>
> [Xperiq logo] Experience intelligence. In one view."

**Video length:** 58 seconds. No transitions longer than 1 second. Show the actual UI — no motion graphics over the screen.

---

### Phase 4 — Press and Analyst Outreach

**Target publications:** CX Today, CMSWire, CustomerThink, MarTech Alliance

**Analyst pitch paragraph (for Gartner XM coverage, Forrester CX Platforms wave):**

> "Xperiq is announcing Command Center, the first real-time AI briefing layer for enterprise experience management programs. Unlike existing XM platforms — which offer either raw data dashboards or high-touch analyst services — Command Center delivers a live, AI-synthesized executive view of an organization's entire CX health without requiring dashboard-building expertise or professional services engagement. The feature introduces Org Health Score, a composite real-time metric across NPS, sentiment, response velocity, and anomaly presence, and Crystal's Weekly Brief, a three-sentence AI narrative generated by CrystalOS, Xperiq's LangGraph-based AI agent layer. Command Center is available to all Xperiq Growth and Growth+ customers without additional configuration."

---

### Phase 5 — Enterprise Sales ("Executive Sponsor Hook")

**Positioning:** Command Center is the feature that gets a C-suite executive excited about renewing or expanding the Xperiq contract.

**Sales narrative:**
> "Most XM platforms are built for the CX analyst. Xperiq is built for the CX analyst AND the CEO who needs to ask 'how are we doing?' in real time. Command Center gives your executive sponsor a reason to open Xperiq every Monday morning. When your exec sponsor is checking Command Center, your budget is safe."

**Demo sequence for enterprise sales (5-minute demo):**
1. Open Command Center — pause on Org Health Score (10 seconds)
2. Read Crystal's Brief out loud, as if it's Monday morning (20 seconds)
3. Show the Programs table — highlight a "Critical" program, click to show the inline detail (30 seconds)
4. Show an anomaly alert — "this fired 20 minutes ago, before you would have found it manually" (20 seconds)
5. Toggle War Room Mode — "this is what Command Center looks like when you're running a live response center" (15 seconds)
6. Close on the Org Health Score — "this is the number that goes in your board deck" (10 seconds)

---

## Pricing and Packaging

### Starter Tier — Basic Command Center

**Features included:**
- KPI Row (4 tiles: active surveys, total responses, org NPS, avg sentiment)
- Programs Overview table with health status (no sparklines)
- Data freshness: hourly (not real-time)
- No Crystal Brief
- No anomaly alerts
- No tag group comparison

**Feature gate messaging:**
```
t('orgDashboard.upgrade.crystalBrief') = "Crystal Briefs are available on the Growth plan. Crystal reads your data so you don't have to."
t('orgDashboard.upgrade.alerts') = "Real-time alerts are available on the Growth plan. Know about program issues before your users do."
```

**Pricing rationale:** Basic Command Center is a discovery surface — it shows users what they are missing. The absence of Crystal Brief and real-time alerts should feel like a gap, not a complete product.

---

### Growth Tier — Full Command Center

**Features added:**
- Crystal's Weekly Brief (full AI narrative + recommendations)
- Anomaly Alerts (real-time, via WebSocket)
- Emerging Topics (cross-survey topic trends)
- Programs table with sparklines
- Data freshness: 15-minute refresh (near real-time)
- Tag Group Comparison Grid

**Upgrade CTA copy (shown in Starter tier when hovering over locked areas):**
```
t('orgDashboard.upgrade.growth.cta') = "Upgrade to Growth to unlock Crystal's Weekly Brief →"
t('orgDashboard.upgrade.growth.value') = "Growth customers report saving 90 minutes per week on Monday morning reporting."
```

**Pricing rationale:** Crystal Brief is the primary value driver for this tier. It is the feature that creates the emotional payoff (confidence walking into Monday meetings). Once a user experiences one Crystal Brief, the tier is sticky.

---

### Growth+ Tier — Real-time + Advanced

**Features added:**
- Real-time live response counter (WebSocket)
- War Room Mode (dark theme)
- Industry benchmark line in NPS chart
- Tag Intelligence View (drill-down to tag group level)
- Crystal Brief regeneration on-demand (not just weekly)
- Crystal Brief with drill-down recommendation links

**Upgrade CTA copy:**
```
t('orgDashboard.upgrade.growthPlus.cta') = "Upgrade to Growth+ for live response tracking and War Room Mode →"
```

**Pricing rationale:** Real-time is a power-user feature. The VP of CX who runs a live customer feedback war room during a product launch or incident is a Growth+ customer. War Room Mode exists specifically to create aspiration — seeing it in a demo makes CX leaders want it.

---

### Enterprise Tier — Multi-Org View

**Features added:**
- Multi-org Command Center (agencies managing multiple client orgs)
- Custom Org Health Score weighting (override the default 40/30/20/10 split)
- API access to org health score data (for embedding in internal BI tools)
- White-label Command Center (for agencies sharing with clients)
- SLA-backed data freshness (5-minute refresh guaranteed)

**Upgrade CTA copy:**
```
t('orgDashboard.upgrade.enterprise.cta') = "Contact us to set up multi-org Command Center for your agency →"
```

**Pricing rationale:** The multi-org view is the agency use case unlocked. This is a pure expansion revenue driver — agencies will pay for the ability to show clients a Command Center branded with the agency's colors.

---

## Success Metrics for Launch

### Adoption Metrics (measured 30 days post-launch)
- **Command Center DAU/MAU ratio target:** 40% (users who open it on most weekdays)
- **Feature activation rate:** 60% of eligible orgs (those with 3+ surveys) activate Command Center within 30 days of the in-app banner appearing
- **Crystal Brief open rate:** 70% of Growth+ users open the Crystal Brief within 24 hours of it generating

### Engagement Metrics
- **Time on Command Center:** P50 session length > 3 minutes (indicates users are actually reading the data, not bouncing)
- **Drill-down rate:** 30% of Command Center sessions include at least one drill-down to a survey detail page
- **Crystal Brief CTA click rate:** 20% of Crystal Brief views result in clicking "Ask follow-up" (opens Crystal chat)
- **Alert acknowledgment rate:** 50% of anomaly alerts are acknowledged within 1 hour of detection

### Business Metrics
- **Upgrade conversion driven by Command Center:** 15% of Free → Growth upgrades are attributed to Command Center feature gate exposure (measured via UTM + in-app event tracking)
- **Growth → Growth+ upgrade rate:** 10% of Growth customers upgrade to Growth+ within 90 days of Command Center launch, attributed to War Room Mode exposure in the demo flow
- **Churn reduction signal:** Measure 90-day retention rates for organizations where at least one user has Command Center as a weekly active feature; target 15% lower churn than organizations without Command Center activation

### NPS for the Feature Itself
- **In-app CSAT prompt** shown 14 days after first Command Center activation: "How useful is Command Center for your Monday morning planning?" (1-5 stars)
- **Target:** 4.2+ average
- **Verbatim collection:** Capture free-text on any rating below 3 to feed the product backlog

---

*This GTM strategy is reviewed quarterly by Priya Rajan and Sofia Reyes. Launch phase timelines are coordinated against the engineering phases in ROADMAP.md.*
