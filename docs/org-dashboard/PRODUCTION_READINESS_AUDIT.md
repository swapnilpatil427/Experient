# Command Center — Production Readiness Audit

Conducted 2026-07-06 by a 7-persona expert panel (enterprise customer, mid-market/SMB customer,
AI/ML engineer, professional services, marketing, sales, UX designer, product/platform engineer),
each independently reading the actual shipped code (not the design docs) on branch `org-dashboard`.
This document consolidates every confirmed finding and records what was fixed vs. deliberately
deferred, with reasoning. Superset of `TRACKER.md` §8's earlier, narrower descope list.

## Fixed in this pass

### AI/CrystalOS correctness
- Recommendation text rendered raw survey UUIDs instead of program names (`org_brief_graph.py`) —
  every "Review program {uuid}" string a VP would see. Fixed by joining `surveys` for titles and
  threading them through ranking/formatting/fallback-recommendation text; soft-deleted surveys
  degrade to a "[deleted survey]" label instead of a dead reference.
- A failed/empty LLM narrative was silently published (overwriting a prior good brief on manual
  regenerate) and scored as maximum trust (`pass`) by the verification pipeline — the single worst
  output was rated the most confident. Fixed: empty narrative aborts publish (keeps prior brief
  intact) and is never scored as `pass`.
- Pass 3 (grounding-completeness) failed *open* on an exception (silently returned "no issues
  found"), inconsistent with pass 1/2's fail-*closed* convention. Fixed to match.
- `org_custom_summaries` had no `hallucination_score`/`trust_json` columns at all — every manual
  summary's verification write threw (caught, logged, never surfaced), so manual summaries were
  never actually verified, 100% of the time, silently. Added the missing columns via migration.
- `_format_topics_text` interpolated LLM-produced, respondent-influenced `topic_label` values
  directly into prose (no structured-JSON isolation), an unaddressed prompt-injection surface
  parallel to the one `grounding_insights_text` already defends against. Isolated the same way.
- Stale docstring in `crystalos/routers/org_brief.py` referencing a deleted TODO file. Cleaned up.
- `estimatedSeconds` on the regenerate endpoint didn't account for pass 3's unconditional LLM call
  (up to 3 sequential LLM round-trips per brief, not "1 guaranteed + 1 conditional"). Updated.

### Backend / scale / operational
- `orgTopicTrends.job.ts` and `orgCrystalBrief.job.ts`'s Monday-UTC gate was checked against a pure
  relative-interval scheduler (`now - lastRun >= 24h`) — in a stable, long-running deployment this
  locks onto whatever day-of-week the process happened to last restart on and can **never** land on
  Monday again. Fixed by ticking hourly instead of daily (both jobs are independently idempotent
  within a calendar week, so extra ticks are harmless no-ops).
- `GET /dashboard/crystal-brief`'s response was bare `null` when no brief existed yet, and
  `getDashboardPayload` never computed eligibility at all — both silently made the "why don't I
  have a brief" messaging unreachable (defaulted to "true"/hidden). Restructured both responses to
  always carry eligibility as a sibling field, never bundled onto a value that can be null.
- "Regenerate" returned 202 immediately with no way to observe completion — no SSE event was ever
  actually published, the frontend never refetched, and the button's own "in progress" state
  cleared within milliseconds regardless of whether generation had even started. Wired a real
  `crystal_brief_ready` event over the existing SSE channel, consumed by the frontend to refetch.
- No per-key request coalescing on `cachedFetch`'s cold-miss/Redis-down path — confirmed thundering-
  herd risk. Added in-process coalescing so concurrent requests for the same cache key share one
  live fetch instead of each hitting Postgres independently.
- `ALTER TABLE agent_runs ... ADD CONSTRAINT` (widening `run_type`) took a full-table lock without
  `NOT VALID`, against the project's own stated convention for exactly this situation. Fixed.
- Added the missing supporting indexes (`response_embeddings(response_id)`,
  `responses(submitted_at)`) that three separate materialized views' CTEs and window-filtered
  queries had no index path for.
- Corrected load-bearing but factually wrong code comments claiming `org_metrics_daily`/
  `tag_metrics` "only read the current day's partition" — they have no date bound at all and
  recompute full org history every 15 minutes. **Not fully redesigned in this pass** (see Deferred).
- `ORG_BRIEF_ENABLE_INSIGHT_CITATIONS` — the feature's own stated non-negotiable compliance gate —
  was undocumented in `docs/ENV_VARS.md`, the repo's declared source of truth for every env var.
  Added, plus a startup assertion so it can't be silently flipped on without the redaction hook.
- No rollout control existed at all — this would have shipped to 100% of every customer instantly,
  despite a proven plan-tier gating pattern (`planGating.ts`) already used elsewhere for exactly
  this purpose. Applied it (Growth/Growth+ gate, matching the original ROADMAP.md intent).
- No per-org kill switch (only a global env-var disable). Added an `org_profiles` override column
  support can flip per-customer without a redeploy or affecting anyone else.
- `dataFreshnessAt` was fetched by the frontend but never rendered anywhere — the one field a
  support rep would need for "is this stale" triage was invisible. Surfaced it.

### Frontend
- `BriefProvenancePanel` crashed (`Cannot read properties of undefined`) when opened on any manual/
  custom-range summary, since `top_topics` is a weekly-only field. Guarded.
- `WeeklyBriefTeaserCard` never accepted a `minDataMet` prop at all — the Hub's empty state was a
  permanent, unexplained "Crystal hasn't written a brief yet" for any org below the eligibility bar,
  forever, with zero path forward. Added the same messaging `CrystalBriefCard` already has.
- `AnomalyAlerts`'s slide-in/pulse animation for new live alerts was never wired to `OrgTrendsPage`
  — a real-time anomaly would silently appear in the list with no visual "this just happened" cue.
  Wired.
- `ConfidenceChip` in `BriefProvenancePanel` was passed a raw 0.0–1.0 trust score against a
  component whose tiers expect 0–100 — every real score rendered as the lowest tier. (Fixed in the
  prior round; re-verified here.)
- A `null` `trustVerdict` (the real state while verification is still pending post-publish, per
  Decision 21) rendered identically to a verified `pass` — no visual difference between "checked,
  fine" and "not checked yet." Added a distinct "still verifying" indicator.
- `BriefArchive`'s "View as page" permalink pointed at `/app/experience/org/summary/:id`, a route
  that doesn't exist anywhere — a guaranteed 404. Removed until the target page is built.
- KPI tiles had zero `aria-label`s despite DESIGN.md specifying exact patterns for all four; the one
  aria-label that *was* wired (Org Health Score) had a hardcoded empty-string `trend` interpolation,
  rendering "...30-day trend: ." Fixed both.
- War Room Mode (dark theme) had no styling at all for `BriefProvenancePanel`, `CheckpointDiffPanel`,
  `TagGroupsStrip`, or `GenerationStatusChip` — all four hardcode light-mode colors that can never
  repaint under `[data-theme='war-room']`. Migrated to theme tokens.

## Deferred (documented, not silently dropped)

- **Full incremental-refresh redesign of `org_metrics_daily`/`tag_metrics`/`survey_health_summary`**
  (bounding/windowing their materialized-view definitions properly, per ARCHITECTURE.md's original
  incremental-aggregation intent). This is a genuine, confirmed scale problem, but a correct fix
  requires verifying exactly what date range each downstream KPI/consumer actually needs (e.g.,
  "Total Responses" may be a true all-time cumulative figure that a naive rolling-window bound would
  silently undercount) — that verification needs a live database, which this sandbox cannot provide.
  Fixing this without that verification risks a worse, silent correctness regression than the
  current (real, but at least honestly documented) scale problem. **This is the single most
  important thing to do before this feature reaches meaningfully large customers** — recommend a
  dedicated data-engineering pass with real staging data before that point.
- **Credit-ledger refund-on-failure / stuck-`pending`-row reconciliation** for manual summaries.
  Confirmed real, but it's a pre-existing, systemic gap this feature inherited by mirroring the
  survey-level Custom Analysis flow (`reports.ts`) it was modeled on — not unique to Command Center.
  Fixing it here alone would create an inconsistency between two mirrored flows; it needs a
  platform-wide fix, not a local patch.
- **Per-org / per-signal alerting on org-brief health** (e.g., "org X hasn't gotten a fresh brief in
  N weeks despite being eligible"). The scheduler's existing generic per-job metrics
  (`schedulerJobRuns`/`schedulerJobLastSuccess`) do cover "is the job itself failing," which is a
  real, non-trivial floor — but not the finer-grained "is this specific customer silently degraded"
  signal. Building that out is a genuine monitoring project, not a bug fix.
- **Full `HealthPill`/`npsColor()` palette unification** across the 6 pre-existing survey-level call
  sites. Confirmed as a real, self-acknowledged contradiction of Decision 17's original "hard
  accessibility requirement before ship" — reaffirmed as deferred anyway, because touching 6
  unrelated, already-shipped, stable files for a color-token refactor carries real regression risk
  disproportionate to a feature that hasn't yet had a single live-database test run. Recommend
  addressing as its own dedicated, carefully-tested change.
- **NPS chart keyboard navigation, count-up animation, live response-counter flash, chart live-
  extension pulse.** Real, specified, unimplemented micro-interactions — genuine polish gaps, not
  correctness bugs. Lower severity than everything above; picked up only if time remained after the
  correctness/production-readiness fixes.
- **GDPR erasure cascade.** Confirmed no worse than a pre-existing, platform-wide gap (no erasure
  pipeline touches `responses`/`response_embeddings` content anywhere in this codebase yet). This
  feature's own tables (`org_crystal_briefs`/`org_custom_summaries`) were confirmed to store
  aggregate-only data (no verbatim text, no respondent IDs) — so Decision 24's citation-gate
  correctly prevents this feature from making that platform-wide gap worse, but doesn't fix it.
- **Demo/seed-data tooling** to bypass the eligibility gate for sales demos. A real GTM/sales-
  enablement need, not a product defect — recommend Sales/PS build a seed script separately.
- **k6/Artillery load testing, automated Lighthouse/WCAG scans.** Unchanged from the original
  TRACKER.md §8 — this sandbox has no live database or browser automation available.
