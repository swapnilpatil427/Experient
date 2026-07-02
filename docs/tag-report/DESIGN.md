# Tag Report — Design Document

**Owner:** Morgan (Product Owner) — Architecture section owned by Devon (Tech Lead)
**Status:** Final — ready for implementation handoff
**Version:** 1.0
**Last updated:** 2026-07-02
**Tagline:** "Tag them, see their insights together, and compare the trend." (product name stays "Tag Report" — decided 2026-07-02 after a cross-functional marketing/advertising/sales/customer/product-owner naming review; see `docs/tag-report/TRACKER.md` for the naming panel notes)

---

## 1. Problem Statement & Goals

### 1.1 The problem

CX and VoC teams rarely run a single survey in isolation. A typical program tags a family of related surveys — e.g. `nps-quarterly`, `onboarding-pulse`, `renewal-survey` — and needs to answer questions that span the *whole tagged set*, not any one survey:

- "Across all our quarterly NPS pulses, is sentiment trending up or down this half?"
- "We just ran our Q2 wave across 5 regional surveys tagged `q2-wave` — how does it compare to Q1?"
- "Leadership wants a standing weekly digest of everything tagged `exec-dashboard` without an analyst manually stitching decks together."

Today, Xperiq generates AI insights (`insight_checkpoints_v2`) per survey. There is no cross-survey rollup. Analysts currently do this by hand: opening each survey's insight report, copying headline numbers into a spreadsheet, and eyeballing trend direction — a process that is slow, error-prone, and impossible to standardize across teams. It also actively discourages the wave-over-wave comparisons that are the bread and butter of mature VoC programs (comparing this quarter's wave to last quarter's, this year's annual sweep to last year's).

### 1.2 Why now

Xperiq already has the two ingredients this needs: `survey_tags`/`survey_tag_mappings` for grouping, and `insight_checkpoints_v2` as a per-survey AI insight checkpoint history. Tag Report's entire value proposition is **connecting these two things that already exist** — it is explicitly not a new AI generation surface. That constraint is also what makes it fast, cheap, and trustworthy: every Tag Report is arithmetic and aggregation over insights that have already been generated, reviewed, and (in many orgs) acted upon. There is zero fresh LLM fan-out in the critical path of producing a report.

### 1.3 Goals

1. **Give VoC/CX teams a standing cross-survey view** for any tag, on demand (Manual), on a schedule (Automated), or over an arbitrary historical window (Custom Range).
2. **Make wave-over-wave comparison a first-class, structured capability** — not a spreadsheet exercise — via the Bracketed Snapshot method (nearest-checkpoint-at-or-before start/end, delta between them).
3. **Never fabricate cross-survey confidence that isn't earned.** Every synthesized claim must show its work: which surveys contributed, how many responses, how stale each checkpoint is, and whether the underlying metrics are even comparable.
4. **Respect that "a tag" is not "a metric."** Surveys under a tag may measure NPS, CSAT, CES, or none of the above uniformly — the report must reflect that reality rather than paper over it with a fake blended score.
5. **Make the generation process itself legible.** Because there's no LLM latency to hide behind a spinner, the wait time is dominated by fetch/aggregation — which means we can and should *show* the actual selection, backfill, and merge logic happening, turning what would otherwise be dead time into the most trust-building part of the experience.

### 1.4 Non-goals

See Section 2 for the explicit non-goals list. In one line: **no response-level tagging, no fresh AI generation, no segment/cohort breakdown in v1.**

---

## 2. Non-Goals

These are stated explicitly because each was considered and deliberately excluded — not overlooked.

### 2.1 No response-level tagging (corrected scope)

An earlier framing of this feature considered tagging individual *responses* (e.g., tagging a specific verbatim as "billing complaint") and rolling those response-level tags into the report. **This was corrected away during design review.** Tag Report operates exclusively on **survey-level tags** (`survey_tags` / `survey_tag_mappings`) — a tag is applied to a whole survey, and the report aggregates across the *surveys* sharing that tag, using each survey's own existing insight checkpoints. Response-level tagging is a materially different feature (closer to verbatim theme-coding) with its own data model, UI, and AI-classification needs, and is out of scope for this document entirely — not deferred, not fast-follow, simply a different feature that should not be conflated with this one going forward.

### 2.2 No fresh AI generation, ever, in any mode

Tag Report does not call an LLM to generate new analysis. All three modes (Manual, Automated, Custom Range) read from `insight_checkpoints_v2` checkpoints that were produced by each survey's own independent insight pipeline. If a survey has no checkpoint in the relevant window, that survey is excluded (with disclosure — see Section 4) rather than triggering on-demand generation. This is a hard boundary, not a v1 limitation: it is what keeps the report fast, cheap, and auditable.

### 2.3 No segment/region/cohort breakdown (deferred to fast-follow)

v1 reports are computed at the whole-survey level per contributing survey — there is no "NPS trend for the EMEA segment across these 5 surveys" capability. This was validated as an acceptable v1 exclusion specifically *because* drill-down into each source survey's own existing insight trail is fast and prominent (Section 4.4) — an analyst who needs segment detail can drill into the specific source survey that has it. If drill-down were slow or buried, this deferral would not be acceptable. Segment breakdown is the leading fast-follow candidate (Section 6).

### 2.4 No cross-metric blending into a single score

Explicitly not building: an NPS+CSAT+CES "composite health score." See Section 1.3 goal 4 and Section 4 requirements — multi-metric tracks are shown side-by-side, never mathematically merged.

### 2.5 No new survey-level AI insight pipeline changes

This feature is a consumer of `insight_checkpoints_v2`, not a modification to how those checkpoints get generated. Automated mode's reliability is *entirely* inherited from each survey's own automated insight pipeline already being healthy — Tag Report does not add retry logic, freshness guarantees, or generation triggers on top of that pipeline (it only surfaces staleness when that pipeline has fallen behind, per Section 4.3).

---

## 3. User Stories

### 3.1 Manual Mode

> **As a VoC analyst**, I've just been asked in a leadership meeting "how are we doing across all our onboarding surveys?" I don't have time to open five separate insight reports and mentally average them. I want to select the `onboarding` tag, hit generate, and in seconds get a single view showing each metric's trend across those surveys, so I can answer the question in the meeting instead of promising a follow-up email.

> **As a program owner**, before I present quarterly results, I want to sanity-check a tag rollup on demand — not wait for a scheduled run — because I need the freshest possible read using whatever insight checkpoints already exist right now.

> **As an analyst investigating a surprising number**, I want to click into any claim in the report and see exactly which surveys, which checkpoints, and how many responses produced it, so I can defend the number if someone on the leadership call pushes back.

### 3.2 Automated Mode

> **As a CX team lead**, I run a standing weekly digest of everything tagged `exec-dashboard` that lands in a channel every Monday morning, so leadership always has a current cross-program view without anyone manually assembling it.

> **As an admin**, I want to configure how many surveys (up to my org's ceiling) get included per tag in the automated run, because some of our tags have 20+ surveys and I don't want every single one dragging down report legibility or runtime.

> **As a recipient of the automated digest**, if one of the surveys feeding my weekly report hasn't had a fresh insight checkpoint generated in three weeks because its own pipeline broke, I want the report to *tell me that survey's data is stale* rather than silently blending a three-week-old number in with everyone else's fresh one.

### 3.3 Custom Range Mode

> **As a VoC program manager doing wave-over-wave tracking**, I want to compare "start of Q1" to "end of Q2" across all five surveys tagged `q2-wave`, and have the system find the closest available checkpoint to each boundary per survey — because I know not every survey's insight checkpoints land on the exact day I care about, and I'd rather see a clearly-labeled nearest-available comparison than get an error.

> **As an analyst preparing a year-over-year readout**, I want to request a 12-month custom window and get a rollup showing the delta between the earliest and latest checkpoints in that window per survey, with each survey's actual (not requested) checkpoint dates shown, so I can flag in my readout that "Survey X's data point is from March 3rd, not exactly January 1st" if it matters to my audience.

> **As a skeptical stakeholder**, when I'm shown a custom-range trend claim, I want to see whether it's backed by two or more surveys moving the same direction (real signal) versus just one survey happening to move that way (anecdote), so I know how much weight to put on it.

---

## 4. Requirements & Acceptance Criteria

Requirements are grouped by mode, followed by cross-cutting Trust Layer requirements that apply to all three modes and are **hard v1 requirements, not nice-to-haves.**

### 4.1 Manual Mode

**R-M1 — On-demand generation from existing checkpoints only.**
- AC: Given a tag with ≥1 survey that has ≥1 `insight_checkpoints_v2` checkpoint, triggering a Manual report returns a result using each qualifying survey's *latest* checkpoint as of trigger time.
- AC: No LLM call is made during report generation. Report generation is measured purely as read + aggregation latency (see Section 5).

**R-M2 — Survey selection with disclosed backfill.**
- AC: The system selects the top-N most-recently-active surveys under the tag (N = `survey_tags.max_surveys_override` if set, else org default, else hardcoded ceiling of 20; default N if nothing configured = 5).
- AC: If a selected survey is excluded (no checkpoint available, or fails the response-count gate in 4.4), the system automatically backfills with the next-most-recently-active survey under the tag, repeating until N surveys are included, the ceiling is hit, or the tag has no more surveys to offer.
- AC: The report surface discloses this process verbatim, e.g. "Examined 8 of 12 surveys to find 5 usable," and lists every examined-but-skipped survey with its specific exclusion reason (no checkpoint / below response-count floor / other). This disclosure is a required element of the report output, not an optional tooltip.

**R-M3 — Multi-metric side-by-side output.**
- AC: If the qualifying surveys collectively measure more than one metric type (NPS, CSAT, CES), the report produces one headline finding block per metric type that has enough qualifying data — never a single blended number across metric types.
- AC: Each metric track independently displays its own survey count, trend direction/magnitude, and provenance.
- AC: If two or more metric tracks move in the same direction over overlapping surveys/window, the report surfaces this as a corroboration note attached to both tracks, explicitly stated as directional agreement between independently-computed tracks — never as a merged statistic.

### 4.2 Automated Mode

**R-A1 — Schedule-triggered, identical computation to Manual.**
- AC: Automated mode uses the exact same selection, backfill, multi-metric, and trust-layer logic as Manual mode — the only difference is the trigger source (workflow engine schedule vs. user action).
- AC: Automated mode never triggers generation of a fresh `insight_checkpoints_v2` checkpoint on any source survey. It reads whatever exists at run time, full stop.

**R-A2 — Staleness is a first-class signal, not a silent gap.**
- AC: If the checkpoint ages of contributing surveys diverge beyond a defined threshold (e.g., one survey's checkpoint is 3+ weeks older than the median of the others), a staleness warning is attached to every claim that survey contributes to — not shown as a generic banner.
- AC: An automated run must never present a stale-checkpoint survey's contribution with the same visual/textual confidence as a fresh one.

**R-A3 — Org-configurable survey ceiling.**
- AC: Admins can configure `survey_tags.max_surveys_override` per tag, bounded by an org default and a hardcoded ceiling of 20. Automated runs respect this exactly as Manual runs do.

**R-A4 — Cross-team dependency gate (see Section 6).**
- AC: Automated mode ships only once the Automation Hub's workflow scheduling engine can reliably invoke the Tag Report generation path on a recurring schedule. This is tracked as an explicit external dependency, not an internal Tag Report task.

### 4.3 Custom Range Mode

**R-C1 — Bracketed Snapshot resolution per survey.**
- AC: For each qualifying survey, the system finds the nearest existing checkpoint at-or-before the requested window's start ("baseline") and the nearest existing checkpoint at-or-before the requested window's end ("latest"), independently per survey.
- AC: If a survey has no checkpoint at-or-before the window start (i.e., its history doesn't reach back far enough), it is excluded from that report with a disclosed reason ("no checkpoint before window start") — never approximated forward.
- AC: The delta (baseline → latest) is pure arithmetic on already-computed checkpoint values. No fresh AI generation occurs at any point in Custom Range resolution.
- **AC (added post-QA-review, closes a real gap): if baseline and latest resolve to the *same* checkpoint** (only one checkpoint exists anywhere near the requested window, or the survey's checkpoint cadence is coarser than the window), the survey shows a **flat snapshot value explicitly labeled "no comparison available in this range"** — it must never render as a "0% change" trend, since that would misrepresent "no second data point exists" as "we measured and found no change," a real finding. This case is structurally identical to §4.4's single-survey/insufficient-agreement handling: descriptive value shown, no trend claim made.

**R-C2 — Window-mismatch / temporal-offset disclosure.**
- AC: For every survey included via Bracketed Snapshot, the report shows both the *requested* window boundary and the *actual* checkpoint date used, per survey, wherever that survey's data appears in the report (not only in a footnote).
- AC: If the offset between requested and actual date exceeds a defined threshold, a temporal-offset warning is attached directly to that survey's contribution to each affected claim.
- **AC (formula fixed post-QA-review, then corrected again post-final-review to close a second, independently-confirmed bug):** confidence tiering uses a **hybrid absolute/ratio formula with a blended boundary zone**, not a hard cutover between the two methods:
  - For `requested_span_days < 10`: tier by **absolute total offset in days** only — `≤1d` high confidence, `≤3d` medium, `≤7d` low, `>7d` severe (excluded from stated trend numbers, descriptive-only).
  - For `requested_span_days ≥ 18`: tier by the **ratio** `(start_offset_days + end_offset_days) / requested_span_days` only — `≤0.1` high, `≤0.5` medium, `≤1.0` low, `>1.0` severe.
  - **For `10 ≤ requested_span_days < 18` (the blend zone): compute BOTH the absolute-day tier and the ratio tier, and use whichever is MORE SEVERE (stricter).** This zone exists because a hard cutover at any single boundary produces a real, confirmed inversion bug: a *narrower* window with the same absolute offset could score a *better* (less severe) confidence tier than a *wider* window with the identical offset — backwards from the ratio method's own rationale that wider windows should tolerate more absolute drift. Taking the stricter of the two tiers in this zone costs nothing extra (both formulas are already pure arithmetic) and eliminates the inversion without needing a smoothed/interpolated formula.
  - This is the authoritative, final formula — TRACKER.md's CrystalOS implementation notes must match this exactly, including the blend zone, not just the two-tier version from the prior fix.

**R-C3 — Trend-eligibility floor still applies within the window.**
- AC: A survey's baseline and/or latest checkpoint must each independently satisfy the Gate 1 response-count threshold (Section 4.4) to count toward `trend_eligible` status for that comparison; sub-threshold checkpoints still appear in the descriptive rollup but do not vote on trend direction.

### 4.4 Trust Layer (applies to all three modes — non-negotiable v1 scope)

**R-T1 — Gate 1: statistical floor per survey.**
- AC: Each contributing survey's checkpoint response count is checked against a minimum threshold. Below threshold: the survey's data appears in the descriptive rollup (so its raw numbers are still visible) but is flagged `trend_eligible=false` and excluded from trend/anomaly voting.
- AC: The report visually and textually distinguishes trend-eligible from descriptive-only surveys everywhere they appear — never presented identically.

**R-T2 — Trust-weighted merge with a hard agreement floor.**
- AC: When multiple trend-eligible surveys contribute to a tag-level trend claim, each survey's vote is weighted by `trust_score * log(response_count)`.
- AC: A tag-level trend claim ("Tag X's NPS is trending up") may only be stated when **at least 2 trend-eligible surveys agree on direction**. If only one trend-eligible survey supports a direction, the report must state the finding as single-survey-sourced (naming that survey) — it must never be phrased as a blended, tag-wide claim.
- AC: This floor is enforced in the aggregation logic itself, not left to UI copywriting — a report that cannot meet the floor for a given metric track simply does not emit a tag-level trend claim for it.

**R-T2a — Single-survey tag behavior (added post-QA-review).** A tag with exactly one qualifying survey can structurally never clear the R-T2 agreement floor. AC: the report still renders that survey's descriptive numbers as a single-survey-sourced finding (per R-T2's existing fallback language) — it does not block generation or render a blank/suppressed card with no explanation. This resolves an ambiguity QA review found: R-T2 covered "only one of several surveys supports a direction" but not the edge case of a tag with only one survey ever.

**R-T3 — Comparability, window-mismatch, and staleness warnings attached to specific claims.**
- AC: Comparability warnings (cadence mismatch, scale mismatch e.g. 0–10 vs. 1–5, question-type mismatch between surveys claimed to measure "the same" metric) are computed per pair/group of contributing surveys and attached to the exact claim they affect.
- AC: No warning may be rendered as a single generic disclaimer banner detached from the claims it concerns. Every warning must be traceable to which survey(s) and which claim triggered it.

**R-T4 — Inline provenance on every synthesized claim.**
- AC: Every claim that synthesizes data across more than one survey displays, adjacent to the claim (not behind a separate "sources" tab only), the contributing surveys' names, response counts (N), checkpoint dates, and checkpoint age.
- AC: This provenance must be visible without requiring a click to reveal for the primary N/date/age summary; deeper detail may be progressive-disclosure (see R-T5).

**R-T5 — Full audit trail with drill-down.**
- AC: From any claim or any contributing survey listed in provenance, a user can drill down into that source survey's own existing insight trail (its own `insight_checkpoints_v2` history and detail).
- AC: Drill-down must terminate at a **Response Detail page showing the single respondent's full verbatim** (route `RESPONSE_DETAIL`, per TRACKER.md Task 16) — not merely the source survey's insight trail. Landing on the insight trail alone is one level short of the audit trail this requirement promises; a reviewer must be able to reach the actual cited response, not just the checkpoint that summarized it.
- AC: Drill-down must be fast (no additional AI computation — it is a read of already-existing per-survey data) and prominent (surfaced directly from the claim, not buried in a separate navigation path) — this is the condition under which deferring segment breakdown (Section 2.3) was judged acceptable.

### 4.5 Citation Contract & Response Viewer — Cross-Feature Dependency (added 2026-07-01)

**Why this section exists:** the Org Intelligence Dashboard ("Command Center") is sequenced to implement *after* Tag Report and will consume Tag Report's citation/checkpoint output as an input to its own org-level briefs (see `docs/org-dashboard/ARCHITECTURE.md`). An integration audit (Jordan Whitfield, Command Center's Platform Integration owner) found that TRACKER.md already plans fixes for two of the three gaps below, but they were not yet reflected as binding Section 4 acceptance criteria in this document — which is marked final. This section promotes them to binding scope and adds one gap TRACKER.md does not yet cover.

**AC-1 (new) — Citation objects must resolve to a specific insight row, not just a checkpoint.** `insight_checkpoints_v2` and `group_insight_run_sources.checkpoint_id` are denormalized-metrics/batch pointers — they do not FK to an individual `insights` table row. Every citation object emitted by `merge_citation_manifest` MUST carry `survey_id`, `response_id`, **and `source_insight_id`** (the originating `insights.id` row it was drawn from), not checkpoint/survey identifiers alone. This is required so a consumer outside Tag Report (e.g. Command Center's `source_insight_ids` field on its own recommendations) can resolve a citation to one `insights` row without a separate lookup table. TRACKER.md §2 item 11 already plans adding `survey_id`/`response_id` to the shared `CitationRef` schema — `source_insight_id` must be added alongside it, not as a follow-up. **Owner: Devon (Tech Lead)** — this is an Appendix A schema decision (extend `CitationRef` and, if needed, `group_insight_run_sources`).

**AC-2 (promoted from TRACKER.md Task 16) — see R-T5 above.** The Response Detail viewer is a blocking prerequisite for R-T5, not an implementation-plan nicety; it is now a Section 4 AC and must ship with Phase 1, not be deferred. **Owner: Jordan (Tag Report's Frontend Engineer)** — already scoped in TRACKER.md; the ask is to carry it through as binding, not to design it from scratch.

**AC-3 (promoted from §7 item 0) — the citation-erasure redaction hook is binding scope once the business decision lands, and downstream consumers must reuse it, not reimplement it.** TRACKER.md §4a already has a concrete engineering proposal (async redaction hook, SLA-bounded, scanning `citations_json`/`group_insights`/`result_json`/`stream_events`) pending the Business Stakeholder decision tracked in §7 item 0. Once approved, Command Center's `org_crystal_briefs`/`org_custom_summaries` JSONB blobs are named consumers of this same hook — they must not implement a second, divergent erasure path. **Owner: Morgan (Product Owner)** drives the business decision to closure; **Devon** implements the hook once decided.

---

## 5. Success Metrics

Because this feature has zero fresh LLM generation in its critical path, its performance bar should be held to aggregation-query speed, not AI-generation speed — and that distinction is itself a metric worth tracking to prove the architecture's value.

| Metric | Target / Direction | Why it matters |
|---|---|---|
| **Time-to-report latency** (trigger → rendered report) | Sub-few-seconds for Manual/Custom Range at default N=5; degrade gracefully (not cliff-fail) as N approaches the 20 ceiling | Directly validates the "zero fresh AI generation" architectural bet — if this isn't dramatically faster than opening N insight reports by hand, the feature hasn't earned its keep |
| **Adoption rate** | % of orgs with ≥1 tag containing ≥2 surveys that generate at least one Tag Report within 30 days of tag creation | Measures whether tagging behavior actually converts into cross-survey analysis behavior, the core hypothesis of the feature |
| **Automated mode retention** | % of Automated tag reports still active (not disabled) 60 days after setup | A scheduled report that gets silently disabled is a signal the output wasn't trusted or wasn't useful — this is an early warning metric |
| **Drill-down click-through rate** | % of report views that result in at least one drill-down into a source survey | This is the trust-layer's core health metric: it validates the bet that fast/prominent drill-down (not segment breakdown) is what analysts actually need to trust a rollup — if this is low, drill-down isn't doing its job and the Section 2.3 deferral should be revisited |
| **Backfill disclosure engagement** | % of reports where the user expands/reads the "Examined X of Y surveys" disclosure when backfill occurred | Validates whether the disclosure UX is actually being noticed, not just technically present |
| **Trend-claim suppression rate** | % of metric tracks per report where a tag-level trend claim was withheld due to the 2-survey agreement floor (R-T2) | Not a "failure" metric — tracks how often the trust floor is doing its job. If this is persistently near 100% for a given tag, that tag likely doesn't have enough trend-eligible surveys to be a good Tag Report candidate, which is itself useful product signal |
| **Staleness-flagged claim rate (Automated mode)** | Trend over time, target: decreasing | A proxy for the health of the *underlying* per-survey automated insight pipelines that Automated mode depends on — rising staleness rates point at a problem upstream of Tag Report, not within it |
| **Downstream usage rate** (report exported, shared, or cited in another artifact) | % of reports with at least one export/share action | Added per XM-expert review: adoption/drill-down metrics prove the feature gets *opened*, not that its output gets *trusted enough to act on* — this is the real bar for a VoC analyst audience, and needs its own signal separate from view/click metrics |

---

## 6. Phased Rollout Plan

Rollout is sequenced by AI-generation dependency risk (lowest first) and by cross-team dependency readiness.

### Phase 1 — Manual Mode
- Full Trust Layer (Gate 1, trust-weighted merge + agreement floor, comparability/staleness warnings, inline provenance, drill-down) ships in this phase — **not deferred to a later phase.** The Trust Layer is v1 scope for the first mode that ships, because it is the mechanism that makes any rollup trustworthy, and Manual mode is where it will get the most real-world scrutiny first.
- Multi-metric side-by-side output ships in this phase.
- Live "pipeline visualization" UX (see Appendix B) targets this phase, since Manual mode is the interactive, user-triggered surface where the generation experience is most visible.
- **Exit criteria:** A tag with a mix of trend-eligible and sub-threshold surveys, and a mix of NPS/CSAT surveys, produces a correct, fully-disclosed report; drill-down into every contributing survey works.

### Phase 2 — Custom Range Mode
- Adds Bracketed Snapshot resolution (R-C1), window-mismatch/temporal-offset disclosure (R-C2), and the trend-eligibility-within-window rule (R-C3) on top of the Phase 1 foundation.
- No new AI dependency — this phase is pure extension of Phase 1's read/aggregate/disclose model to a second axis (time), which is why it is sequenced before Automated mode despite Automated mode being operationally simpler to trigger.
- **Exit criteria:** A wave-over-wave comparison (e.g., "start of Q1" to "end of Q2") across a tag with surveys on non-aligned checkpoint cadences produces correct deltas with correctly-disclosed actual-vs-requested dates on every contributing survey.

### Phase 3 — Automated Mode
- **Gated dependency: the Automation Hub's workflow scheduling engine must be able to reliably invoke the Tag Report generation path on a recurring schedule before this phase can begin.** This is an explicit cross-team dependency on the Automation Hub workstream (`docs/automation-hub/`), not something Tag Report can unblock on its own.
- Adds staleness-as-first-class-signal (R-A2) on top of the Phase 1/2 foundation — this is the one genuinely new trust concern Automated mode introduces (checkpoint age divergence becomes more likely the less a human is actively watching).
- Org-configurable ceiling (R-A3) should already exist from Phase 1 (it's not mode-specific) — Phase 3 just confirms it's respected under a scheduler trigger rather than a user click.
- **Exit criteria:** A recurring scheduled run correctly re-selects surveys (including re-running backfill if a previously-included survey ages out), correctly flags any newly-stale contributor, and reliably lands on schedule via the Automation Hub's workflow engine.

### Sequencing rationale (why not Automated second)
Automated mode looks simpler on paper — same computation as Manual, just triggered differently — but it is intentionally sequenced last because (a) it depends on external infrastructure (Automation Hub scheduling) that is not yet built, and (b) it introduces the one new trust concern (staleness across unattended runs) that benefits from Trust Layer patterns already having been battle-tested by real usage in Phases 1–2. Custom Range, despite manipulating a harder concept (time-bracketed deltas), has no external dependency and reuses the Phase 1 trust machinery almost entirely, making it the lower-risk second phase.

---

## 7. Open Questions for External Reviewers

These are specifically flagged for the two human-only roles on this team — **Business Stakeholder / Executive Sponsor** and **Customer Advisory Reviewer** — because they require judgment calls this team cannot make on its own.

### For the Business Stakeholder / Executive Sponsor

0. **[Added post-security-review] Does cached verbatim quote text in citation blobs need to be scrubbed when a respondent's underlying response is erased?** Tag Report aggregates citations across more surveys/checkpoints than any single-survey report did before, which multiplies this exposure. Security review found no existing purge/erasure code path that scrubs already-cached quoted text out of `citations_json`/`group_insights` blobs when the source `responses` row is deleted. This is a compliance/business-policy decision (how strict is the org's erasure obligation) as much as an engineering one — needs a decision before launch, not just a fix.
1. **What is the acceptable floor for N in a leadership-facing report?** Default N=5 with a 20-survey ceiling was chosen as a reasonable starting point — is 5 right for the kinds of tags leadership actually cares about? Should the default differ by org size or tag size?
2. **Is a suppressed tag-level trend claim (R-T2's 2-survey agreement floor) an acceptable answer to show an executive**, or does "we can't tell you a trend because only one survey qualifies" read as the product failing to deliver an answer, even though it's the honest one?
3. **Does the business consider Automated mode's dependency on Automation Hub Phase 1 an acceptable sequencing risk** — i.e., is it acceptable that Tag Report's most "set it and forget it" mode is the last to ship?

### For the Customer Advisory Reviewer

4. **When shown the "Examined 8 of 12 surveys to find 5 usable" disclosure, does this build trust or does it read as the product being unable to do something simple?**
5. **Is drill-down into a source survey's own insight trail genuinely fast/prominent enough, in practice, to make the lack of segment/cohort breakdown a non-issue** — or does a real analyst still hit a wall wanting "show me this trend broken down by region" even with good drill-down?
6. **For multi-metric tags (NPS + CSAT surveys under the same tag), is side-by-side presentation of separate tracks intuitive, or do customers instinctively expect (and want) some form of unified read** even if blending them would be statistically dishonest?
7. **For Custom Range mode, is the Bracketed Snapshot method's core mental model — "nearest checkpoint at or before your boundary, not an exact date" — intuitive to a real analyst,** or does the gap between "the date I asked for" and "the date I actually got" undermine confidence even with full disclosure of the offset?

---

*This document reflects the final, fully-reviewed design following multi-round input from Product, Architecture, CrystalOS, Backend, Frontend, an independent AI/ML scientist, and an independent XM domain expert. Implementation should treat Sections 4 (Requirements & Acceptance Criteria), the Trust Layer subsection (4.4), and the Citation Contract & Response Viewer subsection (4.5, added 2026-07-01 per the Command Center cross-feature dependency audit) as binding scope for Phase 1 — not aspirational.*

---

## Appendix A — Architecture & Data Model

*Owner: Devon (Tech Lead). Consolidates every incremental schema/API/graph decision made across design review into one authoritative reference. Extends infrastructure that already ships in `main` — this is not a parallel system.*

### A.0 Scope and starting point

- `survey_tags`, `survey_tag_mappings`, `group_insight_runs`, `group_insights` (migration `20260622000001_survey_groups.sql`)
- `org_insight_defaults` / `survey_insight_settings` (migration `20240522000000_insight_settings.sql`) — the existing 3-tier settings resolution pattern (per-survey → org default → platform constant) that this feature reuses at the tag level
- `POST /api/group-insights/generate`, `GET /api/survey-tags/:id/latest-report`, and the rest of `backend/src/routes/survey-groups.ts` / `tags.ts`
- `crystalos/graphs/group_insights.py` (the existing shallow one-shot pipeline) and `crystalos/tools/delta.py` (`compute_delta`, `compute_topic_lifecycle`) — the checkpoint-delta primitives already proven in the single-survey insight pipeline (v2)

Everything below is additive: new columns on existing tables, one new table, and a new CrystalOS graph that sits alongside (not inside) `group_insights.py`.

> **✅ Resolved 2026-07-01, verified against live code (see TRACKER.md reconciliation log for full detail):** the checkpoint FK below targets `insight_checkpoints_v2`, confirmed as the live per-survey checkpoint table by directly reading its migration (`20240523000000_insight_checkpoints_v2.sql`) and confirming `crystalos/graphs/insights.py` actually queries this exact table for parent-chain walks and checkpoint writes. This schema (including the `'single'|'start'|'end'` bracket-position enum needed for Custom Range's checkpoint pairs) is final and authoritative.

### A.1 Schema

#### A.1.1 `group_insight_runs` — additions

`group_insight_runs` already exists as the run/status/stream_events envelope shared by all group-scope generation. Tag Report reuses it as-is and adds four columns to distinguish *how* and *over what window* a run was requested:

| Column | Type | Notes |
|---|---|---|
| `run_mode` | `TEXT NOT NULL DEFAULT 'manual'` — `CHECK (run_mode IN ('manual','automated','custom_range'))` | Which of the three generation modes produced this run. Orthogonal to `trigger` below — `run_mode` is *what the user asked for*, `trigger` is *what caused it to fire*. |
| `window_start` | `TIMESTAMPTZ` | Only populated when `run_mode = 'custom_range'`. The **requested** start of the analysis window — not the actual matched checkpoint boundary (that lives per-source in `group_insight_run_sources.matched_checkpoint_window_start`). NULL for `manual`/`automated`. |
| `window_end` | `TIMESTAMPTZ` | Same as above, requested end of window. `CHECK (window_end IS NULL OR window_start IS NULL OR window_end > window_start)`. |
| `parent_run_id` | `UUID REFERENCES group_insight_runs(id) ON DELETE SET NULL` | Chains a run to the run it's being compared against / superseding, so a tag's report history is a traversable linked list rather than an unordered bag joined only by `tag_ids` + `created_at`. |
| `trigger` | `TEXT NOT NULL DEFAULT 'manual'` — `CHECK (trigger IN ('manual','scheduled','api'))` | Causal origin: a human clicked "Generate" (`manual`), the org's cron/schedule fired it (`scheduled`), or an external API/integration call created it (`api`). |

```sql
ALTER TABLE group_insight_runs
  ADD COLUMN run_mode      TEXT NOT NULL DEFAULT 'manual'
                            CHECK (run_mode IN ('manual','automated','custom_range')),
  ADD COLUMN window_start  TIMESTAMPTZ,
  ADD COLUMN window_end    TIMESTAMPTZ
                            CHECK (window_end IS NULL OR window_start IS NULL OR window_end > window_start),
  ADD COLUMN parent_run_id UUID REFERENCES group_insight_runs(id) ON DELETE SET NULL,
  ADD COLUMN trigger       TEXT NOT NULL DEFAULT 'manual'
                            CHECK (trigger IN ('manual','scheduled','api'));

CREATE INDEX idx_gir_parent_run ON group_insight_runs (parent_run_id) WHERE parent_run_id IS NOT NULL;
CREATE INDEX idx_gir_run_mode   ON group_insight_runs (org_id, run_mode, created_at DESC);
```

No changes to `status`, `stream_events`, `error_log`, `result_json`, `tag_ids`, `survey_ids` — those remain the shared envelope across all three modes.

#### A.1.2 `group_insight_run_sources` — new table

The single biggest gap in the original `group_insight_runs`/`group_insights` pair: there was no durable record of *which checkpoint, for which survey, was actually used* to build a given run's numbers. One row is written **per checkpoint selected for a run**, per survey. A survey contributes either one row (`bracket_position = 'single'`) or two rows (`'start'` and `'end'`) when a bracket pair is used to compute a Custom Range delta.

```sql
CREATE TABLE group_insight_run_sources (
  id                              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                          UUID         NOT NULL REFERENCES group_insight_runs(id) ON DELETE CASCADE,
  survey_id                       UUID         NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
  checkpoint_id                   UUID         REFERENCES insight_checkpoints_v2(id) ON DELETE SET NULL,
  org_id                          TEXT         NOT NULL,

  bracket_position                TEXT         NOT NULL
                                   CHECK (bracket_position IN ('single','start','end')),
  source_mode                     TEXT         NOT NULL
                                   CHECK (source_mode IN ('latest','bracket_pair')),

  matched_checkpoint_window_start TIMESTAMPTZ,
  matched_checkpoint_window_end   TIMESTAMPTZ,
  boundary_offset_interval        INTERVAL,

  trend_eligible                  BOOLEAN      NOT NULL DEFAULT FALSE,
  response_count_at_generation    INT          NOT NULL DEFAULT 0,

  -- Only ever set on HARD exclusions (checkpoint_id IS NULL — survey never
  -- entered the run at all). The SOFT case (survey included, but below the
  -- response-count floor) is fully captured by trend_eligible=false +
  -- response_count_at_generation below; it does not get a text reason here.
  exclusion_reason                TEXT
                                   CHECK (exclusion_reason IS NULL OR exclusion_reason IN (
                                     'no_checkpoint_in_range',
                                     'excluded_by_recency_cap'
                                   )),

  created_at                      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  -- One partial unique index per tag blocks ANY concurrent run (manual,
  -- automated, or custom_range) for the same tag — see Appendix A.4 for the
  -- full concurrency/idempotency design.
  UNIQUE (run_id, survey_id, bracket_position)
);

CREATE INDEX idx_girs_run       ON group_insight_run_sources (run_id);
CREATE INDEX idx_girs_survey    ON group_insight_run_sources (survey_id, checkpoint_id);
CREATE INDEX idx_girs_excluded  ON group_insight_run_sources (run_id) WHERE exclusion_reason IS NOT NULL;
```

Design notes:
- Tag Report **never generates new checkpoints**; it only reads and diffs checkpoints the per-survey automated/manual insight pipeline already produced. This is the load-bearing reuse decision that keeps Tag Report cheap (§A.3).
- Rows with `exclusion_reason IS NOT NULL` and `checkpoint_id IS NULL` are how the UI renders "17 of 20 tagged surveys included — 3 excluded (see why)" without a separate exclusions payload.
- `trend_eligible` is denormalized onto the source row (not recomputed from timestamps at read time) because eligibility depends on runtime settings that can change later — the row must freeze the decision actually made for this run.
- **Survey un-tagged/deleted mid-run**: the candidate pool is snapshotted once when `fetch_next_batch` first runs; there is no mid-run re-validation of tag membership. A survey that gets un-tagged after being selected still completes normally as part of that run. Deliberate, not an oversight — keeps run semantics simple and consistent with treating a run's inputs as fixed once resolution starts.

#### A.1.3 `group_insights` — addition

```sql
ALTER TABLE group_insights
  ADD COLUMN metric_key TEXT CHECK (metric_key IS NULL OR metric_key IN ('nps','csat','ces'));

CREATE INDEX idx_gi_run_metric ON group_insights (run_id, metric_key);
```

Rationale: once Tag Report evaluates NPS/CSAT/CES independently per §A.3's partitioned trend-eligibility gating, a single run must produce **N independent findings**, one per qualifying metric track, each fully self-contained (own `headline`, `narrative`, `metric_json`, `trust_score`, `citations_json`). `metric_key = NULL` is preserved for existing non-metric-partitioned categories — additive, not breaking.

#### A.1.4 Max-surveys-per-tag-report resolution

```sql
ALTER TABLE org_insight_defaults
  ADD COLUMN max_surveys_per_tag_report INT
    CHECK (max_surveys_per_tag_report IS NULL OR
           (max_surveys_per_tag_report >= 1 AND max_surveys_per_tag_report <= 20));

ALTER TABLE survey_tags
  ADD COLUMN max_surveys_override INT
    CHECK (max_surveys_override IS NULL OR
           (max_surveys_override >= 1 AND max_surveys_override <= 20));
```

**Resolution order:** `survey_tags.max_surveys_override` (if set) → `org_insight_defaults.max_surveys_per_tag_report` (if set) → hardcoded platform fallback **20**. Platform *default* when neither override is set is **5** (documented product decision — the sane default report size before an org or tag owner opts into more).

### A.2 API contract

**Decision: extend the existing `/api/survey-groups` and `/api/survey-tags` surfaces; do not stand up a parallel `/api/tag-reports` namespace.** `group_insight_runs`/`group_insights` are the system of record for all group-scoped generation today — the three Tag Report modes are different *inputs* to the same run lifecycle, not a different lifecycle.

`POST /api/group-insights/generate` — extended request shape:

```json
{
  "tag_ids":       ["<uuid>", "..."],
  "run_mode":      "manual | custom_range",
  "window_start":  "2026-03-01T00:00:00Z",
  "window_end":    "2026-03-31T23:59:59Z",
  "parent_run_id": "<uuid>"
}
```

`run_mode` defaults to `'manual'` so every existing caller continues to work unchanged. `'automated'` is never client-supplied — automated runs are created internally by the scheduler path, never via this public endpoint directly.

**Fixed 2026-07-01, closes a security-review finding: `survey_ids` is removed from the request contract entirely for tag-scoped calls.** Security review found the existing endpoint accepts client-supplied `survey_ids` with zero validation that they belong to the calling org or the specified tag — those IDs flow straight to the DB insert and to CrystalOS with no ownership check. Tag Report's request shape does not accept `survey_ids` at all: **survey membership is always derived server-side from `tag_id → survey_tag_mappings`, scoped to `org_id`, never taken from the client.** The existing (pre-Tag-Report) endpoint accepting bare `survey_ids` for non-tag-scoped calls is a separate, pre-existing gap — tracked as its own follow-up fix (§1 below), not inherited by anything new here.

New read endpoint: `GET /api/group-insights/:runId/sources` — returns `group_insight_run_sources` joined with survey title, backing the transparency/exclusion panel. Existing reads (`:runId/status`, `:runId`, `:id/latest-report`) gain the new run columns as additive fields — no shape break.

### A.3 CrystalOS contract — `tag_report.py`

**Decision: a new graph, not an extension of `group_insights.py`.** `group_insights.py` is a straight-line, one-shot DAG built around "sample responses, ask an LLM to synthesize one narrative" — it has no concept of checkpoints, deltas, brackets, or per-metric partitioning, and there's nowhere in that shape to insert the survey-selection-with-backfill *loop* this feature needs.

Node pipeline (design-level):

```
select_surveys_with_backfill   (loop, not a DAG step)
        ↓
resolve_checkpoints_per_survey  (pure DB reads, zero LLM)
        ↓
compute_bracket_deltas          (pure Python — reuses compute_delta / compute_topic_lifecycle)
        ↓
gate_trend_eligibility_per_metric   (partitions NPS / CSAT / CES independently)
        ↓
merge_trust_weighted_per_metric     (≥2-agreement floor, per metric_key)
        ↓
detect_comparability_warnings       (window mismatch, staleness, single-source caveats)
        ↓
narrate                              (template-filled facts; LLM phrases, never invents numbers)
        ↓
merge_citation_manifest
        ↓
publish
```

**Cost note (the key tradeoff):** a naive per-survey-narration design would cost ~O(5N) LLM calls for N surveys. By reading pre-computed checkpoints (zero LLM), doing all delta/lifecycle/merge math in pure Python (zero LLM), and invoking the LLM exactly once per **qualifying metric track** in `narrate`, cost collapses to **O(number of qualifying metric tracks)** — bounded by 3 (NPS/CSAT/CES) regardless of N. Full node-by-node design, state shape, and the complete streaming event vocabulary are in `docs/tag-report/TRACKER.md` (Priya's CrystalOS Implementation Plan).

### A.4 Seam-consistency notes

| Field | Written by | Read by |
|---|---|---|
| `group_insight_runs.run_mode`, `window_start/end`, `trigger` | Backend, at run-creation time | CrystalOS (drives resolution branch), Frontend (chrome/labels) |
| `group_insight_runs.parent_run_id` | Backend, at creation | CrystalOS (comparator for manual/automated), Frontend (history chain UI) |
| `survey_tags.max_surveys_override`, `org_insight_defaults.max_surveys_per_tag_report` | Backend only, via settings CRUD | Backend resolves the cap before calling CrystalOS — CrystalOS receives the already-resolved integer, never re-reads these tables |
| `group_insight_run_sources.*` | CrystalOS only | Backend (`:runId/sources`), Frontend (transparency/exclusion panel) |
| `group_insights.metric_key` + finding fields | CrystalOS only (`narrate`) | Backend (serves as-is), Frontend (one card per `metric_key`) |
| `CitationRef.survey_id`/`response_id`/`source_insight_id` (§4.5 AC-1) | CrystalOS (`merge_citation_manifest`) | Backend (serves as-is), Frontend (Response Detail drill-down), **Command Center** (`org_crystal_briefs.recommendations[].source_insight_ids`) |
| `group_insight_runs.stream_events` | CrystalOS, appended node-by-node | Backend (SSE passthrough), Frontend (live visualization) |

**Backward compatibility:** every additive column defaults such that existing rows/callers continue to function unchanged — `run_mode='manual'` behaves exactly like today's only mode, `metric_key IS NULL` is the existing valid shape, and `group_insight_run_sources` is simply empty for any run produced by the old `group_insights.py` graph — the frontend must treat "no source rows" as "predates per-checkpoint tracking," not an error state.

### A.5 Concurrency & idempotency (fixed 2026-07-01, closes a QA-review gap)

QA review found the original idempotency design (`(org_id, tag_id, window_bucket)`) only covered automated-vs-automated races — a manual trigger, or a manual trigger racing a scheduled one for the same tag, had no collision guard at all. Fixed with one uniform rule instead of mode-specific handling:

```sql
CREATE UNIQUE INDEX uq_gir_tag_inflight
  ON group_insight_runs (org_id, tag_ids)
  WHERE status IN ('pending', 'running');
```

**Any run — manual, automated, or custom_range — for the same tag blocks any other run for that same tag while one is already in flight**, regardless of mode or trigger source. There is no legitimate case where two simultaneous reports for the same tag are useful; they'd be redundant and wasteful (double the checkpoint reads, double the narration LLM calls). A trigger request that hits this constraint returns the already-in-flight `run_id` (poll it) rather than erroring — from the caller's perspective, "generate" is idempotent while a run is active, full stop, independent of what triggered the earlier one. This single rule replaces the earlier `(org_id, tag_id, window_bucket)` scheme entirely — simpler, and closes the manual-race gap QA found by construction rather than by adding a second mechanism.

**AC added post-final-review (three independent reviewers — QA, the AI scientist's review partner, and the XM domain expert — converged on the same gap): the API-level fix above is necessary but not sufficient on its own.** Silently attaching a user's "Generate" click to someone else's (or a schedule's) already-running report, with no indication that's what happened, reintroduces the exact "invisible substitution" trust problem this design otherwise eliminates everywhere else (backfill, staleness, comparability are all disclosed — this must be too). **Required frontend behavior**: when a trigger resolves to an in-flight run rather than a new one, the UI must surface this explicitly before/while showing the result — e.g. "A report is already generating for this tag (started 2 min ago) — showing that run" — never present the polled result as if the user's own click produced a fresh one. This is a one-line addition to Jordan's frontend spec (Appendix B), not a redesign, and is required before this is considered fully closed.

---

## Appendix B — UX/UI Specification

The full streaming pipeline visualization spec and final report page layout (owned by Jordan, Frontend Engineer) is maintained as its own document: see `docs/tag-report/TRACKER.md` → "Frontend Implementation Plan" for the implementation task list, and the UX spec is included there in full (visual composition, motion timing, color language, accessibility/reduced-motion fallback, and Figma-ready component anatomy for the Disclosure Banner, Metric Headline Cards, Comparison/Wave Cards, and Trail Entry Point). Figma file creation was blocked this round by a view-only seat on the connected Figma account — this written spec is the source of truth until Figma access is resolved.

**Updated 2026-07-02 — two gaps closed, still zero Figma calls spent.** With the Figma seat still view-only and rate-limited (it hit its call ceiling after a single file-creation attempt), the two remaining UX gaps identified in review (the Reports index page had a route but no layout spec, and Tag Report had no entry point from the Survey List page) were closed the same way as Part A/B — a written, hand-off-ready spec grounded directly in the app's real existing components, not a new Figma file. See `docs/tag-report/TRACKER.md` → "Part C — Reports Index Page" and "Part D — Survey List Entry Point," plus the "Component Reuse Ledger" table mapping every new element to an exact existing primitive (`TagsSettingsPage`, `SurveysListPage`, `WorkflowsPage`, `TagBadge`, `GlassCard`).

---

## Appendix C — Navigation & Placement

*Decided jointly by Morgan (Product) and Sam (UX) after the user asked whether Tag Report could nest under the existing `/experience` area instead of getting a new top-level nav item.*

**Decision: Tag Report gets its own dedicated route nested under `/experience` — not a tab or scroll-section inside `ExperienceHubPage`, and not a new top-level sidebar item.**

- **Route**: `/app/experience/tags/:tagId/report/:runId` (report), `/app/experience/tags/:tagId/report` (latest), `/app/experience/tags/:tagId/report/trail` (audit trail).
- **Discovery surface**: a lightweight **Reports** sub-nav under Experience — either an expandable sidebar child of "Experience" or a segmented control at the top of `/app/experience` (**Overview | Reports**) — with `/app/experience/reports` as an index page listing tags that have generated reports. This is the fix for ongoing discoverability (Automated mode's "standing weekly digest" use case needs a stable, bookmarkable, re-findable address, not a state buried in another page).
- **Contextual entry points**: the existing "View Report" button in `TagsSettingsPage` (Settings → Tags) must be repointed to this route — it currently points at the old `GROUP_REPORT` route, which is not mounted in `App.tsx` and is effectively dead. Fixing this wiring is an immediate, low-effort prerequisite, independent of any new feature work.
- **Survey List entry point (added 2026-07-02, closes a gap this appendix originally missed).** Every tag chip rendered on a survey row (`SurveysListPage`) becomes a live entry point to that tag's report — not just Settings → Tags and the Reports sub-nav. This reuses the existing `TagBadge` component (already clickable-to-report in `TagsSettingsPage` today) rather than adding a new column or menu affordance. Full interaction spec: `docs/tag-report/TRACKER.md` → "Part D — Survey List Entry Point."

> **Resolved 2026-07-01 — Morgan and Sam sign-off recorded (was: pending cross-team item re: Command Center, `docs/org-dashboard/DECISIONS.md` Decision 17).** Command Center's original proposal (replacing this Hub's hero) was revised by their stakeholder to a strictly additive design after a hard no-information-loss constraint was imposed: nothing in `ExperienceHubPage` is replaced or hidden. The revised design adds a 5th KPI tile (Org Health Score), a visually-subordinate labeled "Crystal's Weekly Brief" card directly beneath the existing hero narrative (never replacing it), and a Tag Groups strip between the existing Live Intelligence and Survey Grid sections — hard-scoped at the data layer to `health_status != healthy` tags only, with its only exit being a CTA to this section's Tag Report route unchanged. **Verdict: Morgan — APPROVE WITH CONDITIONS; Sam — APPROVE WITH CONDITIONS.** Binding conditions (both required): the Weekly Brief card must never compete visually with this page's existing hero narrative, the strip must be structurally incapable of becoming a general tag browser, and role-gating must reuse this feature's existing access-control check rather than a new parallel one. Full record: `docs/org-dashboard/DECISIONS.md`, Decision 18. Morgan is tracking one post-launch signal: if this section's own drill-down/backfill-disclosure engagement rate (§5) drops after Command Center's strip ships, that indicates the strip became real competition for this "Reports" tab rather than a teaser, and the decision should be revisited.

**Why not `ExperienceHubPage` itself:** its existing audience/mental model is a glanceable executive KPI check (hero KPI strip, portfolio cards, "Live Intel" from top-responded surveys) — the opposite of Tag Report's actual usage pattern (an analyst deliberately picking a tag, choosing a generation mode, watching the pipeline visualization, then reading a dense multi-metric report with drill-down). Embedding it as a tab/section would either bloat the Hub into two different products on one page, or visually demote the flagship pipeline-visualization moment into "just another card."

**Why not a new top-level nav item:** today there is exactly one fully-working report surface (survey-level) plus one broken/orphaned route (`GROUP_REPORT`) and one KPI dashboard (`ExperienceHubPage`). Standing up a permanent new nav concept overstates the current surface area for what is architecturally "the same report pipeline, different survey pool" (see the org-report-is-tag-report-with-no-filter opportunity noted separately). Nav items are expensive to remove once shipped; sub-routes are cheap to promote to top-level later if usage data justifies it.

**Where the "Org Report" idea fits:** not built in v1 (see Non-Goals framing is implicit — this was raised as a future opportunity, not committed scope), but the navigation structure above does not preclude it — an org-wide report would reuse the exact same `/app/experience/reports` index and report-shell components with an empty/no-op tag filter, should it get prioritized later.
