# Tag Report — Implementation Tracker

**Status:** Design complete and fully reconciled through TWO review gates (2026-07-01: initial security/QA round, then a final consistency sweep that caught and fixed several bugs the first round's fixes had introduced or missed — see §4a/§4b/§4c for the full resolution log). **Implementation started 2026-07-02** on the `tag-report` branch/worktree. Remaining pre-implementation open item is a business decision, not an engineering gap: DESIGN.md §7 item 0 (citation-erasure policy).
**Last updated:** 2026-07-02

## Implementation Status (live — updated as work lands)

| Area | Status | Notes |
|---|---|---|
| Backend migrations (Tasks 1-4) | ✅ Done | 3 migrations written (`20260702110000/120000/130000_*.sql`), additive-safety verified against every existing INSERT/UPDATE call site. Not run against a live DB — no Postgres available in this sandbox; correctness verified by direct reading of live schema files instead. Two real corrections made along the way, see §1 Query Implementation Notes. |
| Backend endpoints/selection logic (Tasks 5-18) | ✅ Done | 1248/1249 backend tests passing (79 new, same 1 pre-existing RED, zero regressions). RBAC fix applied to old `/generate` route too. `has_active_warning` proxy independently verified consistent with CrystalOS's actual `group_insight_run_sources` columns. Open item: `backend/.env.example` needs `TAG_REPORT_MANUAL_DAILY_LIMIT`/`TAG_REPORT_JITTER_WINDOW_MS` added manually — sandbox blocked that specific write (path is outside this worktree's write allowlist); `docs/ENV_VARS.md` already has both documented. Automated-mode cadence storage (`survey_tags.program_config.tag_report_automated`) is a documented assumption pending team confirmation. |
| CrystalOS `tag_report.py` (Tasks 1-17) | ✅ Done | 1748/1748 crystalos tests passing (70 new, zero regressions), cost-invariant (`llm_call_count` == qualifying tracks, never O(N)) verified at N=5/20/50. 3-zone comparability formula implemented exactly per spec with an explicit inversion-bug regression test. Known scope limits (flagged by design, not oversights): citation manifest dedupes at `(survey_id, checkpoint_id)` not full response-level (needs blob loading, outside this graph's scope — flagged for Devon); cadence/scale/question-type comparability checks (R-T3) are a documented no-op pending survey-metadata fetch. |
| Frontend pages/viz/index/entry-points (Tasks 1-19) | ✅ Done | 1060/1060 app tests passing (114 new, zero regressions). Built against the documented contract as typed interfaces since backend/CrystalOS didn't exist yet when this agent ran — see Integration row below for the reconciliation pass this required. |
| Integration + full regression pass | ✅ Done | See "Integration reconciliation" section below for the full list of real cross-team contract mismatches found and fixed. Final: backend 1258/1259 (79+5 new tests, same 1 pre-existing unrelated RED), app 1060/1060, crystalos 1761/1761 (70+9 new tests). Zero regressions across all three. |
| Security review (Riley) | ✅ Done | Fresh adversarial pass against the actual shipped code (not the design doc). Two real findings, both fixed and regression-tested: (1) HIGH — Response Detail endpoint only checked the response's own `deleted_at`, not its parent survey's; a soft-deleted survey's verbatim response content stayed readable forever via any Tag Report citation that referenced it — fixed with a `surveys` JOIN requiring both `deleted_at IS NULL`. (2) MEDIUM — the pre-existing `/generate` route shared `group_insight_runs` with Tag Report's rate-limited endpoints but had no rate limit itself, and its underlying graph makes real fresh LLM calls — a genuine cost/quota bypass, not cosmetic; fixed by applying the same daily-limit check. Everything else (org/tag/survey scoping, RBAC incl. `requireInternalKey`'s constant-time comparison, SQL injection, the concurrency guard's org-scoping, the new citation-resolution query's implicit safety) traced end-to-end and confirmed clean. Final: backend 1264/1265 (3 new regression tests, same 1 pre-existing unrelated RED). |
| QA pass | ✅ Done | Adversarial pass against every numbered AC in DESIGN.md §4 (R-M1/R-A1/R-A2/R-C1/R-C2/R-T1 through R-T5/R-T2a), verified against actual code, not doc intent. Confirmed working end-to-end: R-T5's citation drill-down (CrystalOS's real-citation resolution → backend view → frontend rendering → ResponseDetailPage, full chain traced), the zero-fresh-AI-generation architectural invariant (§2.2), R-T2's core agreement-floor math, R-C1 bracketing, R-C2's 3-zone formula, R-M2's 3-tier survey cap. Found and fixed 3 real issues: (1) R-T3's cadence/scale/question-type comparability checks were an unconditional no-op despite DESIGN.md declaring the full Trust Layer non-negotiable v1 scope — implemented all three checks in `crystalos/graphs/tag_report.py` (`detect_metric_comparability_mismatches`), reading real survey question metadata and checkpoint-interval history, wired into `node_detect_comparability_warnings` for all three modes. (2) R-T2's "name that survey" disclosure only fired for the trivial single-survey-total case (R-T2a); the general case (≥2 eligible surveys, only one actually agreeing) silently named no one — fixed the `single_survey_id` resolution logic in `merge_metric_tracks`, AND found it was never even persisted to `group_insights.metric_json` at all (a second, deeper bug in the same area), AND fixed backend's independent re-derivation in `tagReportView.ts` to use the real persisted value instead of guessing from survey count. (3) The regression test TRACKER.md itself cited as proof of the historical comparability-formula "inversion bug" fix doesn't actually discriminate a correct implementation from a naive one at the current threshold constants (empirically verified) — added a direct monotonicity property test across a full offset/span grid instead, with an honest note about what it does and doesn't prove. Final: backend 1263/1264, app 1059/1060 (1 confirmed pre-existing flaky timing test, passes 3/3 in isolation, unrelated to Tag Report), crystalos 1785/1785 (23 new tests this pass). Zero real regressions across all three languages. |

**Test baseline (2026-07-02, before any Tag Report code):** backend 1169/1170 (1 pre-existing intentional-red TDD test, unrelated), app 946/946, crystalos 1678/1678. Any newly-failing pre-existing test from this point forward is a regression to fix, not route around.

### Integration reconciliation (2026-07-02, after all three layers landed independently)

Backend, CrystalOS, and frontend were built in parallel by three separate agents, each briefed from the same design docs but unable to see each other's actual code as it was written. The streaming event contract (TRACKER.md §2's table) was specified precisely enough that all three sides converged on it exactly except one gap; the REST response/request shapes were specified less rigorously and diverged more. Found and fixed, all independently re-verified with tests:

1. **Wrong API base paths.** Frontend built against TRACKER.md's literal (stale) path prose (`/api/survey-groups/...`, `/api/tags/...`); the backend agent had already corrected its own docblocks to the real mounts (`/api/group-insights`, `/api/survey-tags`, per `backend/src/index.ts`) but frontend had no visibility into that correction. Fixed in `app/src/lib/api.ts`.
2. **Missing `run_started` event.** No CrystalOS node ever emitted it, despite being the contract's first event and the only one carrying `target_n`/`ceiling_n` — frontend's progress reducer read those fields exclusively off it, so they were permanently `null`. Fixed by seeding it in `run_tag_report_generation` before `graph.ainvoke()`.
3. **`run_complete.duration_ms` hardcoded to `None`** against a non-nullable frontend type. Fixed to compute real elapsed time from the (now-guaranteed) `run_started` event's timestamp.
4. **Citation manifest was checkpoint-level, not response-level.** The original `merge_citation_manifest` only read `insight_checkpoints_v2.citations_manifest_ref`, whose blob is a lightweight response-id *index* with no quote text (confirmed by reading `graphs/insights.py`'s `_build_citations_manifest`) — not the full `CitationRef` shape (`response_id`, `quote`, `sentiment`, `relevance`) DESIGN.md §4.5 AC-1 and the frontend both require for the drill-down promise. Fixed by joining `insights.citations_json` via the `run_id` a checkpoint and its contributing insights share (both reference the same `agent_runs` row) — precise, no blob I/O, no timestamp-proximity guessing. Falls back to the old checkpoint-level placeholder only when no real citation resolves (e.g. a survey whose insights predate citation tracking).
5. **`GET /tag-reports` index returned `{tags}`; frontend's `TagReportsIndexResponse` expects `{reports, total}`.** Fixed (this endpoint had not shipped to any real caller yet, so this was a straight rename, not a compatibility shim).
6. **`GET /tag-report/:runId` returned raw table rows; frontend was built against a pre-shaped `TagReportMetricTrack[]` + disclosure summary** (matching what the UX spec actually describes rendering — trust bars, warning chips, single-survey flag, corroboration, per-survey breakdown). Rather than rework the frontend's already-correct rendering logic, added `backend/src/lib/tagReportView.ts` to derive that shape from the raw `group_insights`/`group_insight_run_sources`/`stream_events` data the route already fetches. One known approximation: `survey_breakdown[].trust_score` is a monotonic-in-response-count display/sort proxy, not CrystalOS's real trust score, since that value is computed in-memory during generation and never persisted per-survey anywhere in the schema.
7. **Response Detail backend endpoint never assigned to anyone.** Frontend's `ResponseDetailPage` (Task 16) and its `api.getSurveyResponse()` caller were built against `GET /api/surveys/:surveyId/responses/:responseId`, which didn't exist — neither the backend nor CrystalOS brief included it. Added to `backend/src/routes/responses.ts` with the exact access-control (`survey_id`+`org_id` scoping via `requireAuth`) and soft-delete (`deleted_at IS NULL`) guards DESIGN.md's R-T5 requires; a missing/wrong-org/soft-deleted response all return an identical 404.
8. **Real crash bug, not just a contract mismatch:** `crystalos/main.py`'s `/tag-reports/generate` handler computed its `effective_max_surveys` fallback via `crystalos.lib.constants.TAG_REPORT_DEFAULT_TARGET_N` — a module that doesn't have that attribute, since the CrystalOS agent deliberately kept Tag Report's tunables inside `graphs/tag_report.py` itself (out of scope for the shared constants module). Would have raised `AttributeError` on any request with a falsy `effective_max_surveys`. Not currently reachable through the real wired flow (`tagReportRunner.ts` always resolves a positive-integer default via the 3-tier COALESCE, floor 5) but fixed as a defense-in-depth correctness issue — no test had ever exercised this route at all. Fixed by deferring to `run_tag_report_generation`'s own already-correct fallback instead of duplicating (and having gotten wrong) it in `main.py`; added `crystalos/tests/test_tag_report_generate_endpoint.py` (4 tests, including the exact falsy-value regression case).

**Not fixed, deliberately deferred (pre-existing/out-of-scope, flagged not hidden):** `insight_reports.ts`'s own stale "Mounted at" docblocks (unrelated files, not touched); `survey_breakdown`'s trust-score approximation (item 6 above); `crystalos.CitationRef.source_insight_id` (DESIGN.md AC-1 names it, but it's populated correctly now via the citation-resolution fix in item 4 — the CrystalOS agent's original concern about it not being derivable is resolved by that same fix, since the `insights.id` used to build the citation IS the `source_insight_id`).

## ✅ Reconciliation items — all resolved 2026-07-01, verified against live code

1. **`group_insight_run_sources` schema — Devon's version is final.** Confirmed authoritative: `bracket_position: 'single'|'start'|'end'` (supports the checkpoint pair Custom Range needs). Alex's original draft (integer rank, no pair support) is superseded — see corrected Migration 2 in §1 below.
2. **Checkpoint table name — RESOLVED: `insight_checkpoints_v2`, verified in code.** Read `supabase/migrations/20240523000000_insight_checkpoints_v2.sql` directly and confirmed `crystalos/graphs/insights.py` actually queries this exact table (`SELECT * FROM insight_checkpoints_v2`, `INSERT INTO insight_checkpoints_v2`) for parent-chain walks and checkpoint writes — this is the live, current per-survey checkpoint store (PK `id UUID`, holds `nps`/`csat`/`ces` metric snapshots, `delta_from_prior`, `parent_checkpoint_id` self-FK). Devon's original FK reference was correct. `insight_reports` (the table Alex found defined twice) is a separate, different table — not the checkpoint chain Tag Report reads from. **`group_insight_run_sources.checkpoint_id` FKs to `insight_checkpoints_v2(id)`, final.**
3. **`exclusion_reason` enum — final, merged.** `CHECK (exclusion_reason IS NULL OR exclusion_reason IN ('no_checkpoint_in_range', 'excluded_by_recency_cap'))`. Scoped down from both drafts: `exclusion_reason` is only ever set on **hard exclusions** — rows where `checkpoint_id IS NULL` because the survey never made it into the run at all. The **soft** case (survey included, but below the response-count floor) is fully captured by `trend_eligible=false` + `response_count_at_generation` — no separate text reason needed there, since the recorded count is self-explanatory. Alex's `survey_deleted`/`manual_exclude`/`checkpoint_stale` values are dropped: `checkpoint_stale` is superseded by the staleness *warning* mechanism (a property of an included survey, not an exclusion reason), `manual_exclude` was never a real feature in this design, and `survey_deleted` is resolved by decision 4 below rather than needing its own enum value.
4. **Survey un-tagged/deleted mid-run — decision: the candidate pool is snapshotted once at run start; no mid-run re-validation.** A survey that gets un-tagged or deleted after `fetch_next_batch` selects it still completes normally as part of that run (it was already a valid candidate when selected). This is a deliberate, standard snapshot-consistency choice, not an oversight — it keeps run semantics simple and matches how the rest of the pipeline treats a run's inputs as fixed once resolution starts. Next run naturally reflects the updated tag membership.
5. **Automated-mode single-tag-per-run — decision: confirmed, by design.** Nothing in this feature was ever designed to generate one report across multiple tags at once — every Tag Report run is scoped to exactly one tag. `group_insight_runs.tag_ids` stays an array only for schema compatibility with the older `group_insights` system; Tag Report always populates it with exactly one ID. Alex's partial unique index on `tag_ids[1]` is valid as designed (see the widened concurrency fix in §4 below, which supersedes the original index).
6. **`runScheduledWorkflows()` — CONFIRMED wired, verified directly in code, with one deployment nuance.** `backend/src/eventEngine/processor.ts:177-186` runs a real `setInterval(..., 60 * 1000)` calling `workflowEngine.runScheduledWorkflows()` every 60 seconds. `backend/src/index.ts` starts this processor whenever `ENABLE_EVENT_ENGINE=true`. **Nuance for Task 14/15**: in production this runs as a separate dedicated `event-engine` service, not in-process with the main API — Automated mode's due-tags sweep (Task 15) must confirm it's hooking into whichever process actually has the flag/service active in the target deployment, not assume in-process wiring.
7. **(Added 2026-07-02, resolved before implementation split) Layer boundary between Backend's "recency-ranking query" and CrystalOS's `fetch_next_batch`/`resolve_and_gate_batch` — these described overlapping work in two places.** Resolved by following the existing `group_insights.py` precedent exactly (backend resolves tag→surveys and hands off; Python does all checkpoint-level work): **Backend's `lib/tagReportSelection.ts` (§1 Task 5) owns only**: resolving `effective_max_surveys` (the 3-tier COALESCE query), validating tag ownership/org-scoping, a cheap "does this tag have ≥1 candidate survey at all" existence check for early 400s, and the `uq_gir_tag_inflight` concurrency check before creating the run row. It does **not** touch `insight_checkpoints_v2` at all. **CrystalOS's `tag_report.py` (§2) owns everything else**: recency-ordered survey candidate fetching, checkpoint bracket/nearest resolution, backfill looping, gating, merge, narrate, publish — exactly as §2's node-by-node table already describes, using backend's resolved `effective_max_surveys` as `target_n`. The backend passes `{run_id, org_id, tag_id, run_mode, window_start, window_end, effective_max_surveys}` to CrystalOS via a new `agentsClient.generateTagReport(...)` call, mirroring the shape of the existing `agentsClient.generateGroupInsights(...)`.

---

## 1. Backend Implementation Plan (Alex)

### Grounding — what already exists (verified against current code)

- `survey_tags` (`supabase/migrations/20260622000001_survey_groups.sql`) — has `program_config JSONB` (no `max_surveys_override` yet).
- `group_insight_runs` — currently `{ id, org_id, tag_ids UUID[], survey_ids UUID[], status, stream_events, error_log, result_json, created_by, created_at, completed_at, heartbeat_at }`. No `run_mode`/`window_start`/`window_end`/`parent_run_id` yet.
- `group_insights` — currently no `metric_key` column; `metric_json` is a single JSONB blob per insight.
- `org_insight_defaults` (`20240522000000_insight_settings.sql`) — per-org nullable overrides table, PK `org_id TEXT`, no `max_surveys_per_tag_report` yet.
- `insight_reports` — defined twice (see reconciliation item 2 above).
- `backend/src/routes/survey-groups.ts` — mounted for `group_insight_runs`/`group_insights` CRUD-ish endpoints (generate/status/stream/get/crystal). Natural home for report-trigger/read endpoints.
- `backend/src/routes/tags.ts` — owns tag CRUD + `GET /:id/latest-report`. Natural home for tag-level config endpoints.
- LATERAL join precedent: `backend/src/routes/dashboard.ts` lines ~110–118 — per-row "most recent N" pattern, reusable for per-survey most-recent-checkpoint lookups.
- `runScheduledWorkflows()` **appears wired** — called every 60s from a `setInterval` in `backend/src/eventEngine/processor.ts`, itself started from `backend/src/index.ts`. Matches the automation-hub tracker's own correction of an earlier bad audit. **Re-verify fresh before Automated mode ships (see reconciliation item 5).**
- Auth pattern: `requireAuth` on all routes, `requireRole('analyst')` gating mutations in `tags.ts`; `survey-groups.ts` currently has **no role gate beyond `requireAuth`** on its existing `/generate` route — flagged for Riley as a pre-existing gap this feature would otherwise inherit.

### Migration Plan

Three migrations, strictly ordered.

**Migration 1** — `group_insight_runs` additions (`run_mode`, `window_start`, `window_end`, `parent_run_id`). See DESIGN.md Appendix A.1.1 for final column shapes (authoritative).

**Migration 2** — `group_insight_run_sources` new table. **Final, copy-paste-ready — supersedes Alex's original draft in every prior version of this document:**
```sql
CREATE TABLE IF NOT EXISTS group_insight_run_sources (
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

  -- Only set on HARD exclusions (checkpoint_id IS NULL). The soft case
  -- (included but below the response-count floor) uses trend_eligible=false
  -- + response_count_at_generation instead — no text reason needed there.
  exclusion_reason                TEXT
                                   CHECK (exclusion_reason IS NULL OR exclusion_reason IN (
                                     'no_checkpoint_in_range',
                                     'excluded_by_recency_cap'
                                   )),

  created_at                      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  UNIQUE (run_id, survey_id, bracket_position)
);

CREATE INDEX IF NOT EXISTS idx_girs_run       ON group_insight_run_sources (run_id);
CREATE INDEX IF NOT EXISTS idx_girs_survey    ON group_insight_run_sources (survey_id, checkpoint_id);
CREATE INDEX IF NOT EXISTS idx_girs_excluded  ON group_insight_run_sources (run_id) WHERE exclusion_reason IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_gir_tag_inflight
  ON group_insight_runs (org_id, tag_ids)
  WHERE status IN ('pending', 'running');
```
This is identical to DESIGN.md Appendix A.1.2/A.5 — reproduced here in full so the migration can be written directly from this tracker without cross-referencing. `checkpoint_id` targets `insight_checkpoints_v2`, confirmed live in `crystalos/graphs/insights.py`'s actual queries (see reconciliation log above). The `uq_gir_tag_inflight` index is Migration 1's concern by table (`group_insight_runs`), included here for visibility since it's part of the same reconciliation fix — actual migration file placement is engineering's call (either Migration 1 or 2, as long as it lands before Task 6).

**Migration 3** — Config + multi-metric partitioning:
```sql
ALTER TABLE survey_tags
  ADD COLUMN IF NOT EXISTS max_surveys_override INT
    CHECK (max_surveys_override IS NULL OR (max_surveys_override BETWEEN 1 AND 20));

ALTER TABLE org_insight_defaults
  ADD COLUMN IF NOT EXISTS max_surveys_per_tag_report INT
    CHECK (max_surveys_per_tag_report IS NULL OR (max_surveys_per_tag_report BETWEEN 1 AND 20));

ALTER TABLE group_insights
  ADD COLUMN IF NOT EXISTS metric_key TEXT
    CHECK (metric_key IS NULL OR metric_key IN ('nps', 'csat', 'ces'));

CREATE INDEX IF NOT EXISTS idx_gi_metric_key ON group_insights (org_id, run_id, metric_key)
  WHERE metric_key IS NOT NULL;
```
**Resolution query, fixed post-QA-review (closes a real gap — the org row may not exist at all, not just be NULL):**
```sql
SELECT COALESCE(t.max_surveys_override, o.max_surveys_per_tag_report, 5) AS effective_max_surveys
FROM survey_tags t
LEFT JOIN org_insight_defaults o ON o.org_id = t.org_id
WHERE t.id = $1;
```
The `LEFT JOIN` is required, not optional — an org that was never provisioned an `org_insight_defaults` row at all (not merely one with NULL columns) must still resolve to the hardcoded default of 5. An inner join would silently return zero rows for such an org instead of falling through.

**Migration ordering rule:** 1 → 2 → 3, strictly — land all three before any endpoint work starts.

### Endpoints

`backend/src/routes/survey-groups.ts` additions:
- `POST /api/survey-groups/insights/tag-report/manual` — `{ tag_id }` → 202 `{ run_id }`
- `POST /api/survey-groups/insights/tag-report/custom-range` — `{ tag_id, window_start, window_end }` → 202 `{ run_id }`
- `POST /api/survey-groups/insights/tag-report/automated` — internal-only, `X-Internal-Key` gated (not `requireAuth`), called by the scheduler
- `GET /api/survey-groups/insights/tag-report/:runId` — joins `group_insight_run_sources`, partitions `group_insights` by `metric_key`
- `GET /api/survey-groups/insights/tag-report/:runId/trail` — full provenance + bounded `parent_run_id` lineage walk (cap depth ~10)

`backend/src/routes/tags.ts` additions:
- `GET/PATCH /api/tags/:id/report-config` — effective + raw max-surveys config
- `GET /api/tags/:id/tag-report-history` — paginated run history across all three modes

`backend/src/routes/survey-groups.ts` additions (2, for the Reports index page — added 2026-07-02):
- `GET /api/survey-groups/insights/tag-reports` — list, org-scoped: for every tag with ≥1 `group_insight_runs` row, returns `{tag_id, tag_name, tag_color, survey_count, latest_run: {mode, created_at, has_active_warning}}`. Supports `?q=` (name search) and `?sort=recent|alpha|survey_count` (default `recent`). Backs `TAG_REPORTS_INDEX` — no new table, a join over `survey_tags`/`group_insight_runs`/`group_insight_run_sources`.
- `has_active_warning` is derived, not stored: true if the latest run has any unresolved comparability/staleness warning or is in the single-survey (R-T2a) case — reuses the same warning objects the report page already renders, just surfaced as a boolean for the card list.

Org-level: confirm whether `org_insight_defaults` already has a GET/PATCH route before building a new one — add `max_surveys_per_tag_report` to its allow-list if so.

### Query Implementation Notes

- **Recency-ranking query**: LATERAL join per survey → most recent `insight_checkpoints_v2` row per survey. **CORRECTED 2026-07-02, verified by reading the live migration directly (`20240523000000_insight_checkpoints_v2.sql`): `insight_checkpoints_v2` has NO `status` column at all.** The `status='ready'` filter described in every prior version of this note does not exist and was never implementable — it was inherited confusion with the adjacent, differently-scoped `insight_reports` table (`20240524000000_insight_reports.sql`), which genuinely does have a `status IN ('generating','ready','failed')` column but is a *different* table (single-survey manual expert/quick report documents, not the checkpoint chain). The real mechanism that makes "zero fresh generation" safe needs no filter at all: `insight_checkpoints_v2` rows are written exactly once, atomically, only at successful publish time (`crystalos/graphs/insights.py`'s `_write_checkpoint_v2`, a single `INSERT ... RETURNING id` with no prior placeholder row) — there is no "generating" or "failed" state ever represented as a row in this table, so any row that exists is by construction ready. Selection is simply: most recent row per `(survey_id, org_id)` across both lanes, `ORDER BY created_at DESC LIMIT 1`. **No new index needed** — the existing `idx_ckpt_v2_survey_created ON insight_checkpoints_v2 (survey_id, org_id, created_at DESC)` already serves this exactly. Over-fetch candidates (e.g. `effective_max_surveys * 3`) so the backfill loop has room without a second round-trip in the common case.
- **Backfill loop**: walk the over-fetched, ordered candidate list in application code (not a recursive CTE — exclusion reasons involve app-layer concepts). Cap re-fetch to a single additional round-trip if the first batch doesn't yield enough qualifying surveys; proceed with a shortfall rather than looping unboundedly, and surface the shortfall via `group_insight_run_sources`.
- **Multi-metric partitioning read**: partition by `metric_key` in SQL (`ORDER BY COALESCE(metric_key, 'zzz_unpartitioned')`), bucket into `insights_by_metric` in one pass in the route handler — not N queries per metric.

### Rate Limiting / Operational Concerns

- **Thundering-herd avoidance (Automated mode):** deterministic per-(org,tag) jitter at trigger time (not cron-registration time), enqueued onto the existing Redis-Streams-backed async queue from Automation Hub Wave 1 (`backend/src/lib/workflowQueue.ts`) rather than building a second queue. **Concurrency/idempotency corrected post-final-review — this section previously described a superseded `(org_id, tag_id, window_bucket)` key; the actual, current mechanism is the uniform `uq_gir_tag_inflight` partial unique index defined in DESIGN.md Appendix A.5**, which blocks any concurrent run (manual, automated, or custom_range) per tag, not just automated-vs-automated. A jittered automated trigger that lands while another run is already in flight for that tag simply attaches to the existing run rather than creating a duplicate — no separate idempotency key needed on top of the index.
- **Manual/custom-range rate limit**: mirror `survey_insight_settings.manual_daily_run_limit`-style caps to prevent trigger spam.
- **Zero fresh AI generation is enforceable at the query layer**, not just convention — `insight_checkpoints_v2` rows only ever exist in a completed state (see correction above, no filter needed) and there is a complete absence of any `agentsClient`/CrystalOS call in the selection path, so there is no code path in this feature that can trigger generation. Worth stating explicitly in the PR description for Riley's review.
- **Interaction found with the existing `/generate` route (2026-07-02):** the new `uq_gir_tag_inflight` partial unique index (Appendix A.5) applies to `group_insight_runs` as a whole, which the *existing* `POST /api/survey-groups/insights/generate` route also inserts into with the same `(org_id, tag_ids)` shape. Without a code change, a concurrent duplicate call to the *old* route would now surface a raw Postgres `23505` unique-violation as a 500 instead of its previous (silent, redundant-row) behavior — a real regression risk for existing callers, not just new Tag Report endpoints. Fix: wrap the `INSERT INTO group_insight_runs` in both the old `/generate` handler and the new tag-report handlers with the same catch-and-attach helper (on `23505`, `SELECT id FROM group_insight_runs WHERE org_id=$1 AND tag_ids=$2 AND status IN ('pending','running')` and return that `run_id` instead of raising) — this is also exactly the caller-facing behavior DESIGN.md Appendix A.5 already specifies, so this is one shared fix, not two.

### Task List (ordered)

| # | Task | Depends on | Complexity |
|---|------|-----------|------------|
| 1 | Migration 1 (`run_mode` etc. on `group_insight_runs`) | Reconciliation items resolved | S — blocks everything |
| 2 | Migration 2 (`group_insight_run_sources`) — **use Devon's schema, resolve checkpoint table name first** | Task 1, reconciliation items 1–3 | S |
| 3 | Migration 3 (config + `metric_key`) | Task 1 | S — parallel with Task 2 |
| 4 | Confirm/flag the duplicate `insight_reports` table definition | none | XS |
| 5 | Shared recency-selection + backfill helper (`lib/tagReportSelection.ts`) | Tasks 1–3 | M — build once, reused by all 3 modes |
| 6 | `POST .../tag-report/manual` | Task 5 | M — establishes response shape other modes reuse |
| 7 | `POST .../tag-report/custom-range` | Task 6 | S |
| 8 | `GET .../tag-report/:runId` + `:runId/trail` | Task 6 | M |
| 9 | `GET/PATCH /api/tags/:id/report-config` | Task 3 | S — parallelizable |
| 10 | `GET /api/tags/:id/tag-report-history` | Task 6 | S |
| 11 | Confirm/extend `org_insight_defaults` settings route | Task 3 | XS–S |
| 12 | RBAC fix: `requireRole('analyst')` on `survey-groups.ts`'s existing `/generate` route | none | XS — flag to Riley regardless |
| 12b | **(Added post-security-review)** Fix `/generate`'s existing acceptance of bare, unvalidated `survey_ids` for non-tag-scoped calls — same root cause as the fix already applied to Tag Report's new request contract (DESIGN.md A.2), but this is the pre-existing endpoint's own separate half of the gap | none | S |
| 13 | `POST .../tag-report/automated` (internal-only) | Task 6, Task 14 | M |
| 14 | **Re-verify `runScheduledWorkflows()` wiring fresh** (reconciliation item 5) | none, gates 13/15 | XS |
| 15 | Automated scheduler: due-tags sweep + jitter + enqueue onto async queue | Tasks 13, 14 | L — largest single task |
| 16 | Manual/custom-range daily rate limit | Task 6 | S |
| 17 | Full test pass: migration idempotency, backfill shortfall case, route permission matrix, thundering-herd/idempotency collision test | All above | M |
| 18 | **(Added 2026-07-02)** `GET /api/survey-groups/insights/tag-reports` (index list) | Task 8 | S — read-only join, no new schema |

**Critical path:** 1 → 2/3 → 5 → 6 → 7/8/10/13 → 14 → 15 → 17. Tasks 9, 11, 12, 18 peel off in parallel.

---

## 2. CrystalOS Implementation Plan (Priya)

**File:** `crystalos/graphs/tag_report.py`. **Precedent graphs:** `graphs/group_insights.py` (structural template), `tools/delta.py` (`compute_delta`/`compute_topic_lifecycle` — reused, not reimplemented), `graphs/insights.py` (`has_nps`/`has_csat`/`has_ces` capability-flag pattern).

### Design principle

Not a linear DAG like `group_insights.py`. The batch-resolution phase is a **LangGraph cycle**: `fetch_next_batch → resolve_and_gate_batch` loops back via a conditional edge until target-N surveys included, ceiling hit, or the tag's survey pool is exhausted. Everything after the loop is a straight pipeline.

### State shape — `TagReportState(TypedDict)`

Key fields: `org_id, run_id, tag_id, report_mode, window_start/end, target_n, ceiling_n, candidate_survey_ids, cursor, batch_size, included_surveys, excluded_surveys, loop_stop_reason, boundary_checkpoints, bracket_deltas, bracket_topic_lifecycle, metric_tracks, eligible_surveys_by_metric, merge_votes, merged_metric_deltas, corroboration_signals, comparability_warnings, narrated_tracks, llm_call_count, citation_manifest, stream_events, errors`.

`metric_tracks[metric_key]` shape: `{eligible, eligible_survey_ids, trend_gate_passed, raw_deltas, trust_weights, merged_delta, agreement_count, confidence_tier}`.

### Node-by-node

| # | Node | Type | Behavior |
|---|---|---|---|
| 1 | `fetch_next_batch` | loop entry/re-entry | Fetches next `batch_size` survey IDs for `tag_id` (candidate pool queried once, ordered `created_at DESC`, `org_id`-scoped, `deleted_at IS NULL`). Advances cursor. Emits `survey_selected` per row. |
| 2 | `resolve_and_gate_batch` | loop body | Resolves boundary-nearest checkpoint(s) per survey; applies trust/response-count gate. Appends to `included_surveys` or `excluded_surveys` with reason. Emits `checkpoint_resolved`/`survey_excluded`. |
| — | conditional edge → `{fetch_next_batch \| compute_bracket_delta}` | cycle control | Exits when `included_count >= target_n` (`target_reached`), `loop_iterations >= ceiling_n` (`ceiling_hit`), or pool exhausted (`pool_exhausted`). Emits `batch_loop_resolved`. |
| 3 | `compute_bracket_delta` | pure Python, **Custom Range only** | Pass-through for `rolling_window` mode (reuses parent-chain-adjacent delta directly). For `custom_range`: pulls two boundary-nearest checkpoints per survey, calls `compute_delta`/`compute_topic_lifecycle` **unmodified** — only the checkpoint pair passed in differs from the existing parent-chain usage. Emits `bracket_delta_computed`. |
| 4 | `apply_trend_eligibility_gate` | pure Python, per-metric-key | Independently filters `included_surveys` per NPS/CSAT/CES using `has_nps`/`has_csat`/`has_ces` flags (already computed, read not recomputed). A survey lacking CSAT doesn't affect its NPS/CES eligibility. Emits `metric_track_gated`. |
| 5 | `merge_metric_tracks` (trust-weighted merge) | pure Python | Weight = `trust_score * log(max(response_count, 2))` per survey. **≥2-survey-agreement floor**: fewer than 2 agreeing → `confidence_tier="insufficient"`, excluded from narration. Emits `merge_vote`/`merge_resolved`. |
| 6 | `check_cross_track_corroboration` | pure Python | If two tracks both pass the gate, move the same direction, and overlap in surveys/window: annotate `corroboration_signals`. Never touches merge math — annotation only. Emits `corroboration_detected`. |
| 7 | `detect_comparability_warnings` | pure Python | Cadence/scale/question-type checks + temporal-offset, **using the final blended formula in DESIGN.md R-C2 (this row must match exactly — two earlier versions here were superseded, first a pure-ratio formula that diverged on short windows, then a hard 14-day cutover that had its own confirmed inversion bug at the boundary)**: `<10d` → absolute total offset days only (`≤1` high, `≤3` medium, `≤7` low, `>7` severe); `≥18d` → ratio `(start_offset_days + end_offset_days) / requested_span_days` only (`≤0.1` high, `≤0.5` medium, `≤1.0` low, `>1.0` severe); `10–18d` (blend zone) → compute both, use whichever tier is stricter. Emits `comparability_warning`. |
| 8 | `narrate_tag_report` | **LLM, one call per qualifying metric track** | Template-filled facts only — the LLM phrases prose, never computes/invents numbers. Increments `llm_call_count`. Emits `narration_started`/`narration_complete`. |
| 9 | `merge_citation_manifest` | pure Python | Dedupes citations by `(survey_id, checkpoint_id)` across all narrated tracks. Emits `citations_merged`. |
| — | `publish` | terminal | Writes `group_insights` rows (one per metric_key) + final `stream_events` + `result_json`. Emits `run_complete`/`run_failed`. |

### Streaming event contract (critical cross-team dependency for Jordan)

Common envelope: `{"event": "<type>", "ts": "<iso8601>", "run_id": "<run_id>", ...}`. Full vocabulary:

| Event | Key fields | Frontend affordance |
|---|---|---|
| `run_started` | `tag_id, report_mode, target_n, ceiling_n` | Initialize timeline canvas |
| `batch_fetched` | `batch_index, survey_ids, cursor, pool_size` | Pre-render placeholder nodes |
| `survey_selected` | `survey_id, position, title, created_at` | Survey "lights up" |
| `checkpoint_resolved` | `survey_id, bracket_position, checkpoint_date, offset_days` (signed) | Checkpoint marker snaps to timeline |
| `survey_excluded` | `survey_id, reason, detail` | Node dims/greys with tooltip |
| `batch_loop_resolved` | `included_count, target_n, loop_stop_reason` | Progress bar completes or shows early-stop |
| `bracket_delta_computed` | `survey_id, nps_delta, csat_delta, ces_delta, start/end_checkpoint_id` | Delta arrow draws between boundary checkpoints |
| `metric_track_gated` | `metric_key, eligible_survey_ids, excluded_survey_ids` | Per-metric lane shows contributing surveys |
| `merge_vote` | `metric_key, survey_id, weight (pre-normalized to sum 1.0), trust_score, response_count, delta_value` | Weighted vote line converges, thickness ∝ weight |
| `merge_resolved` | `metric_key, merged_delta, agreement_count, confidence_tier` | Track's final number appears, colored by tier |
| `corroboration_detected` | `tracks, direction, overlap_surveys, window_overlap_pct` | Two lanes visually connect (not merge) |
| `comparability_warning` | `scope, warning_type, distortion_score, confidence_tier, affected_survey_ids` | Warning badge on affected surveys/claim |
| `narration_started` / `narration_complete` | `metric_key` / `+ headline, confidence` | Generating spinner → narrative card populates |
| `citations_merged` | `citation_count, survey_count` | Citation count badge |
| `run_complete` | `metric_tracks_narrated, llm_call_count, total_surveys_scanned/included, duration_ms` | Final cost/coverage summary |
| `run_failed` | `node, error` | Error banner, partial state preserved |

Notes for Jordan: events are ordered within a run but multiple `survey_selected`/`checkpoint_resolved` fire per batch — animate as a stream, not a single update. `position` is stable across the run (index in full candidate pool). `offset_days` is signed.

### Cost accounting

**Final LLM call count per report: `len(qualifying metric tracks)` — O(1)–O(3), never O(N).** This is a hard architectural invariant: N (surveys scanned) must never multiply LLM call count, since the batch-resolution loop is bounded SQL + arithmetic regardless of iteration count. `llm_call_count` is tracked and emitted in `run_complete` specifically so this is observable in production (alert if `> 3` for any run — would indicate a regression).

### Task List

1. State + constants scaffolding (`TagReportState`, tunables in `lib/constants.py`: `tag_report_target_n`, `ceiling_n`, `batch_size`, `min_trust_score`, `min_response_count`, `agreement_floor=2`, offset-distortion thresholds).
2. `fetch_next_batch` node.
3. `resolve_and_gate_batch` node (extract boundary-nearest checkpoint resolution as a reusable library function, not a second tool round-trip).
4. Conditional edge / loop control — unit-test all three exits independently.
5. `compute_bracket_delta` node (mode branch, unmodified reuse of `compute_delta`/`compute_topic_lifecycle`).
6. `apply_trend_eligibility_gate` node.
7. Trust-weighted merge function — independently unit-testable with synthetic survey sets (0/1/2/N agreeing).
8. `check_cross_track_corroboration` node — verify it never mutates `merged_metric_deltas`.
9. `detect_comparability_warnings` node — unit-test boundary values at each distortion tier.
10. `narrate_tag_report` node — regression test asserting call count == qualifying-track count for 0/1/2/3-track fixtures.
11. `merge_citation_manifest` node. **Verified gap, revised 2026-07-01: fix at the source, not just at merge time.** Add `survey_id` directly to the shared `CitationRef` schema (`crystalos/schemas/insight.py`) so every citation is unambiguous by construction — every insight-generation caller (not just Tag Report) benefits. Confirmed low-risk: `survey_id` is already in scope (`state["survey_id"]`) at the primary construction site (`crystalos/graphs/insights.py:3697`, topic citations), the DB column is untyped JSONB (additive-safe), and both the backend (`citations_json?: unknown[]`) and frontend (`InsightCitation` interface) type surfaces are lenient — no migration or breaking change. **One follow-on gap found**: some citation construction paths in `crystalos/agents/tiered_report.py` don't even carry `response_id` today (only `quote`+`relevance`, synthetic/fallback citations) — these need `response_id` added before `survey_id` is meaningful there; not blocking for Tag Report (which only consumes citations that already have `response_id`), but worth a follow-up ticket.

12a. **Blocking prerequisite for R-T5, tracked in full under §3 Frontend Implementation Plan, Task 16: Response Detail page.** No response drill-down landing page exists anywhere in the app today — see Jordan's task list below for the full spec (route, soft-delete guard, sequencing).
12. `publish` node — **coordinate column names with Devon/Alex's reconciled `group_insight_run_sources`/`group_insights` schema before this task starts.**
13. Graph assembly (`build_tag_report_graph()`, `run_tag_report_generation(...)` entry point).
14. SSE wiring — confirm `stream_events` push live through `lib/event_publisher.py`, not just batched at publish.
15. **Cost-invariant test** — `llm_call_count <= 3` and `== len(qualifying tracks)` across fixtures with N=5, 20, 50 surveys.
16. `EVALS.md`/`SKILL.md` if `narrate_tag_report`'s prompt is promoted to a registered skill; otherwise document why it stays inline.
17. Integration test against DESIGN.md's acceptance criteria (mixed NPS/CSAT/CES tag, deliberately including a low-trust survey and an offset-mismatched checkpoint).

**Open dependency for Devon:** `group_insights`/`group_insight_run_sources` persistence schema (JSONB shapes for `metric_tracks`, `comparability_warnings`, `citation_manifest`) must be locked before Task 12.
**Open dependency for Jordan:** confirm the event vocabulary above covers what the visualization needs (e.g. explicit x/y timeline coordinates vs. just `position`/`offset_days`) before Task 14 locks SSE wiring.

---

## 3. Frontend Implementation Plan (Jordan)

**Grounding:** `app/src/pages/GroupReportPage.tsx` (existing report-page convention — run resolution, polling, streaming view, trust bars, gap/suggest cards), `app/src/constants/routes.ts`, `app/src/lib/dataBus.ts` (`DataResource` union, invalidation), `app/CLAUDE.md` (Three.js lazy-load + `prefers-reduced-motion` rules, locales/brand-token rules), `app/src/pages/insights/shared.tsx` (trust-tier/`GlassCard` visual language).

### Plan

- **Routes** (updated 2026-07-01 per DESIGN.md Appendix C nav decision — nested under `/experience`, not a standalone top-level route): `TAG_REPORT_NEW`/`TAG_REPORT_LATEST`/`TAG_REPORT` at `/app/experience/tags/:tagId/report[/:runId]`, `TAG_REPORT_TRAIL` at `/app/experience/tags/:tagId/report/trail`, a new `TAG_REPORTS_INDEX` at `/app/experience/reports` (lists tags with generated reports — the Reports sub-nav landing page), and **new** `RESPONSE_DETAIL` (`/app/surveys/:surveyId/responses/:responseId`).
- **Nav change**: add a Reports sub-nav under the existing Experience nav item (expandable child, or an Overview | Reports segmented control atop `/app/experience`) — no new top-level sidebar entry.
- **Fix required, independent of new work**: `TagsSettingsPage`'s existing "View Report" button points at the old, unmounted `GROUP_REPORT` route — repoint it to `TAG_REPORT_LATEST`.
- **Pages**: 3 new tag-report pages + a `tag-report/` component directory (including a `three/` subfolder for the visualization scene graph), **plus a new `ResponseDetailPage`** (see Task 16 below).
- **State/data-fetching**: mirrors `GroupReportPage`'s polling approach; new `useApi()` methods for the tag-report endpoints; new `'tags'` `DataResource` entry for DataBus invalidation after generation.
- **Locales**: full `tagReport` namespace needed in `locales/en.ts` — every string in the spec below (`tagReport.stream.*`, disclosure banner copy, warning chip labels, etc.) must go through `t('key')` per root CLAUDE.md, never hardcoded.
- **Task list** (sequenced): scaffolding → routes/pages → data hooks → DataBus wiring → static report page (disclosure banner, metric cards, comparison cards, trail entry) → Three.js visualization scene → reduced-motion fallback → locales → responsive pass → integration with real backend once Tasks in §1/§2 land. **Explicit blockers**: DESIGN.md must be finalized (done — this tracker supersedes that blocker) and the tag data model contract (Appendix A in DESIGN.md) must be locked before data-hook work starts.

**Task 16 — Response Detail page (added 2026-07-01, blocking prerequisite for DESIGN.md R-T5).** No response drill-down landing page exists anywhere in the app today — citations currently render as read-only quoted text with no click-through (`app/src/pages/insights/UnifiedInsightsView.tsx`). Without this page, the citation `(survey_id, response_id)` pairs Priya's CrystalOS plan now attaches (§2, item 11) have nowhere to navigate to, and the "click into any finding to see exactly which response it came from" promise in DESIGN.md fails at the last step.
  - New route `RESPONSE_DETAIL` at `/app/surveys/:surveyId/responses/:responseId`, survey-scoped (not global) to match how the rest of the response data is scoped.
  - Shows the full response in context: the cited quote plus surrounding question/answer context for that response, sentiment/emotion tags if available, and a link back to the survey it belongs to.
  - **Access control (added post-security-review, closes a real gap):** the backend endpoint behind this page must re-check the requesting user's access to `:surveyId` on every request — the same permission check the app already applies when viewing that survey's responses normally, not just a check that the response row exists. Do not treat "user can see the Tag Report" as sufficient authorization to see arbitrary response content across every survey the tag touches; each response's own survey-level access rule still applies.
  - **Must guard on `responses.deleted_at IS NULL`** — checkpoints and Tag Report citations can reference a response that's since been soft-deleted; show a graceful "this response is no longer available" state rather than erroring or showing a blank page.
  - **Legacy-citation fallback (added post-QA-review, closes a real gap):** citations created before `survey_id` was added to `CitationRef` (§2, item 11) have no `survey_id` and cannot construct this route at all. Citation rendering (`UnifiedInsightsView.tsx` and the new Tag Report metric cards) must check for `citation.survey_id` presence and render as **non-clickable plain text** when absent — never attempt to build a `RESPONSE_DETAIL` link with a missing path parameter.
  - Wire citation rendering in both `UnifiedInsightsView.tsx` (single-survey, existing) and the new Tag Report metric cards to link through to this page using the `(survey_id, response_id)` pair — this is also the first real consumer of the `survey_id` field being added to `CitationRef` (§2, item 11), so sequence this after that schema change lands.
  - Not blocking for Tag Report's backend/CrystalOS work, but blocking for the UX being fully functional end-to-end — should land before or alongside the Phase 1 (Manual mode) exit criteria in DESIGN.md §6, since R-T5 is explicitly non-negotiable v1 scope.

**Task 17 — In-flight-run disclosure (added post-final-review, closes a gap three independent reviewers converged on).** When a "Generate" trigger resolves to an already-in-flight run (DESIGN.md Appendix A.5's concurrency guard) rather than creating a new one, the UI must say so explicitly — e.g. "A report is already generating for this tag (started 2 min ago) — showing that run" — surfaced before or alongside the streaming visualization/result. Never silently show the polled result as if the user's own click produced a fresh run; this is the same disclosure principle already applied rigorously to backfill, staleness, and comparability warnings elsewhere in this design, and leaving it unstated here would be an inconsistency, not a new pattern. Small, self-contained addition — one banner/toast state plus reading `run.trigger`/`run.created_at` off the already-returned run object (no new API surface needed).

**Task 18 — Reports Index page (`TAG_REPORTS_INDEX`, added 2026-07-02, closes a real gap: the route existed since 2026-07-01 but had no page spec).** Full layout in Part C below. New page `TagReportsIndexPage.tsx`, new `useApi()` method against Task 18's backend endpoint (§1), new `TagReportsIndexSkeleton` loading component.

**Task 19 — Survey List entry point (added 2026-07-02, closes the gap flagged in the 2026-07-01 nav discussion — every tag becomes a live entry point, not just Settings → Tags).** Extend `TagBadge` (`app/src/components/TagBadge.tsx`) with an `onNavigate?: (tagId: string) => void` prop; wire it in `SurveysListPage.tsx`'s per-row tag rendering (~line 578-584) to `navigate(ROUTES.TAG_REPORT_LATEST(tag.id))`, `stopPropagation`'d so it doesn't trigger the row's own click-through. Do **not** wire it on the active-filter pill usage (~line 479-486) — that instance stays `removable`/filter-only, already a contextually separate usage in the existing code. Full spec in Part D below.

### Component Reuse Ledger (Tasks 18–19 — every new element mapped to an existing primitive, added 2026-07-02)

Verified directly against the current codebase so Jordan builds from real primitives instead of inventing new ones:

| New element | Reuses | Source |
|---|---|---|
| Index page card grid | `grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4` + Framer Motion stagger/rise | `TagsSettingsPage.tsx:106` (identical surface: a grid of tag-scoped cards) |
| Index page stats strip | 3-up `grid grid-cols-3` stat row pattern | `WorkflowsPage.tsx:208` — collapsed to `grid-cols-1 sm:grid-cols-3` on mobile, a deliberate one-line improvement over the source pattern since this page is meant to be checked from a phone (the "weekly digest" use case) |
| Index page search input | Debounced custom input (not shadcn `Input` directly) | `SurveysListPage.tsx:387` |
| Index page sort control | `SortDropdown` built on shadcn `DropdownMenu` | `SurveysListPage.tsx:7` and its `SortDropdown` usage |
| Index page loading state | Dedicated skeleton, not a spinner | `SurveyListSkeleton`, `app/src/components/LoadingStates`, used `SurveysListPage.tsx:8,505` — the one page in the app already doing loading right; `TagReportsIndexSkeleton` should match its shape/rhythm |
| Index page org-wide empty state | Icon-in-circle + heading + gradient CTA | `WorkflowsPage.tsx:436-455` |
| Index page zero-search-results empty state | Small inline row, distinct from the org-wide empty state (never conflate "no reports exist" with "your search was too narrow") | New composition — no direct precedent, but follows this design's existing rule against generic/misleading disclosure (R-T3) |
| Index card tag identity | Dot + label only (not the full pill) | `TagBadge.tsx:13-50`'s internal dot+name markup, not the whole component |
| Index card mode badge | shadcn `Badge`, neutral variant | Must NOT reuse `LAYER_COLOR`/metric colors for mode — mode ≠ metric identity, and this design already has a hard rule that trust/agreement encoding never collides with metric-color encoding (TRACKER §3 Part A); the same separation applies here |
| Index card health signal | `ConfidenceChip` tiering logic (not the component verbatim, its amber/none logic) | `app/src/pages/insights/shared.tsx:54-75` — omit the chip entirely when there's no active warning, never render a fake "all good" state (same omission rule already used for warning chips on the report page itself) |
| Index card click-through | Whole-card `onClick` → `TAG_REPORT_LATEST` | `TagsSettingsPage.tsx:111-116` — identical existing precedent, just repointed at the corrected (non-dead) route |
| Survey List tag-chip entry point | `TagBadge` + new `onNavigate` prop, hover lift + fade-in chevron, `stopPropagation` | Mirrors `TagBadge`'s own existing `removable`/✕ conditional-icon and `stopPropagation` pattern (`TagBadge.tsx:13-50`) — same component, same interaction shape, new prop |

**Two pre-existing inconsistencies to know about, not to fix here:** (1) two different layer-color maps exist — `insights/shared.tsx`'s `LAYER_CONFIG` and `GroupReportPage.tsx`'s own local `LAYER_COLOR`; TRACKER's cited hex values (`#2a4bd9`/`#d97706`/`#8b5cf6`/`#059669`) match `GroupReportPage.tsx`'s local map, so **new Tag Report work should copy that local map, not import `LAYER_CONFIG`**. (2) `#8b5cf6` (predictive purple) is not a `@theme` CSS variable like `--color-primary`/`--color-success`/`--color-warning` (`app/src/index.css:40-135`) — it's hardcoded today and should stay hardcoded for consistency rather than inventing a token that doesn't exist elsewhere yet.

**On Figma:** the connected Xperiq Figma seat is view-only and rate-limited (hit its call limit after a single file-creation attempt in an earlier session). Given how scarce that seat is, Parts C and D below were produced as a written, hand-off-ready spec with zero Figma MCP calls, following the same convention Part A/B already established — this document is the source of truth, not a Figma file, until seat access is resolved.

### UX/UI Specification

*(Full spec — hand-off ready for Figma construction or direct engineering build without further clarification. Figma file creation was blocked this round by a view-only seat on the connected account; this is the source of truth until that's resolved.)*

Visual language baseline: reuses the existing Crystal brand system — `--color-primary` (`#2a4bd9`), the four insight-layer colors (descriptive `#2a4bd9`, diagnostic `#d97706`, predictive `#8b5cf6`, prescriptive `#059669`), the `GlassCard` surface component, and the CSS Crystal-orb motif already used for AI-generation loading states. Motion timing follows the house ease curve `[0.22, 1, 0.36, 1]`.

#### Part A — Streaming Pipeline Visualization

**Canvas & global rules**: full-width panel in the `max-w-7xl` content column, `16:7` aspect on desktop / `4:5` on mobile. Dark glass background (`radial-gradient(ellipse at center, #0b1020 0%, #05060d 100%)`). Static orthographic camera, no orbit controls. Persistent top HUD caption (13px, cross-fades 200ms between stage labels — this is the accessible anchor; a user should be able to follow the pipeline with the visual switched off). Bottom progress rail, 6 (or 5) segments.

Color-coding: NPS = `--color-primary` blue, CSAT = `#8b5cf6` purple, additional metrics cycle `#059669`/`#d97706`. Gated-out = desaturated grey `#94a3b8` @ 35%, dashed. **Trust/agreement strength = line/node thickness and brightness, never color** — color is reserved for metric identity so the two encodings never collide.

**Stage 1 — Survey Discovery**: full tag population fades in at 20% opacity (establishes "here is the full population"). Top-N light up one at a time, most-recent-first, with a scale pulse + particle burst. **Backfill**: the next node "wakes" with a slower, more deliberate pulse while the HUD caption reads "Checking next most recent…" — this is the one place the pipeline visually loops back, which is what makes backfill legible rather than magic.

**Stage 2 — Checkpoint Resolution**: each lit node grows a timeline arm with tick marks; a marker travels to the nearest usable checkpoint and snaps with a radial pulse. Non-exact matches get a persistent gap label ("+12d gap", muted amber) that feeds the staleness warning system later.

**Stage 3 — Comparison** (Custom Range only, skipped in Manual/Automated): a connecting arc draws between each survey's two snapshot points, colored by direction (green/red/grey) and thickened/glowing by magnitude, with a floating delta label.

**Stage 4 — Gating**: brisk pass (~120ms/node) — qualifying nodes flash a green ring; disqualified nodes dim to 35% opacity, connections go dashed, and a persistent exclusion-reason label anchors to the node. Triggers the Stage 1 backfill loop-back if needed. Longest deliberate pause (500ms) once the final qualifying set is settled.

**Stage 5 — Merge & Voting**: qualifying trend-lines migrate toward per-metric convergence zones (NPS left-of-center, CSAT right — matching the side-by-side non-blended final layout). Travel order/settling position is by trust weight (higher trust = arrives first, settles nearer center). Convergence zone glow intensity = aggregate trust. **Agreement-floor visualization**: a zone with only 1 contributing line renders its core in warning amber instead of the metric's color. A subtle corroboration arc connects two zones if their findings agree.

**Stage 6 — Narrative Generation**: convergence zone glow morphs into the literal report card shape; headline streams in word-by-word (not rushed — 800ms–1.4s). Claims become hoverable once rendered — hovering draws a faint line back to the source survey-node (the flagship "still connected to the live pipeline" payoff moment). Canvas persists collapsed (~120px) above the report rather than disappearing, preserving hover-to-source.

**Transitions**: soft crossfade + subtle camera nudge between stages, never a hard cut — prior-stage elements recede to ~50-60% opacity rather than clearing.

**Reduced motion / accessibility**: `prefers-reduced-motion: reduce` → don't mount the Three.js canvas at all; render a shadCN vertical stepper instead, carrying 100% of the same information (stage name, backfill note, gating reasons, trust outcome) via text/icons only. **Clarified 2026-07-02**: `HeroCanvas.tsx` itself has no internal reduced-motion gate — the gating is the caller's responsibility (`React.lazy()` + `<Suspense fallback={null}>` + a `window.matchMedia('(prefers-reduced-motion: reduce)')` check before mounting, per `app/CLAUDE.md`'s Three.js conventions). The new pipeline-visualization component must implement this gating itself, the same way any `HeroCanvas` caller does — don't assume it's inherited for free. Same fallback on WebGL failure. Canvas is `aria-hidden`; a visually-hidden `aria-live="polite"` region announces stage transitions in audio form for screen readers.

**Fast/cached response rule**: stages always flash briefly — **never skip straight to the result**, since that would make the flagship feature feel inconsistent depending on cache state. Each stage gets a 350ms minimum on-screen duration (~2.1s total floor, ~1.75s when Comparison is skipped). If the backend resolves in under ~200ms, stages compress to their floor with simplified motion, but Stage 6's narrative streaming is never shortened.

#### Part B — Final Report Page Layout

Route: `/app/experience/tags/:tagId/report/:runId` (see DESIGN.md Appendix C — nested under Experience, not a standalone top-level route). `max-w-7xl mx-auto`, `PageHeader` with 3-crumb trail (Experience → Reports → Tag Name).

Vertical layout: PageHeader → Streaming Visualization (collapsed strip, ~120px, post-generation) → Disclosure Banner → Metric Headline Cards (grid) → Comparison/Wave Cards (Custom Range only) → Trail Entry Point.

**Disclosure Banner**: full-width, `--color-primary` @ 6% tint over `GlassCard`. Collapsed: single line + chevron ("Examined 8 of 12 to find 5 usable" + backfill note if applicable). Expanded: two-column Included/Excluded list with reason chips.

**Metric Headline Cards**: `grid-cols-1 md:grid-cols-2`, wraps to a second row for 3+ metrics rather than going 3-wide (metrics should never feel cramped or secondary). Each card: metric label + colored dot → headline (bold) → trust line (count + tier + bar, reusing existing trust_score bar pattern) → warning chip row (omitted if none) → narrative body with hoverable claim spans → "View source" link to trail. **A metric that fails the ≥2-survey-agreement floor gets a prominent amber top-edge accent bar and an unmissable "Only 1 survey supports this finding" chip, always first in the row.**

**Comparison/Wave Card** (Custom Range only): title + delta badge (colored by direction, matching viz arc colors) → 2-point Recharts sparkline (NOT Three.js — this is a static chart artifact) → expandable per-survey breakdown list, sorted highest-trust-first.

**Trail Entry Point**: ghost/outline card, lowest visual emphasis on the page (appropriate for a power-user affordance), links to `TagReportTrailPage`.

**Color/type token table** (for Figma): `--color-primary` #2a4bd9 (NPS), predictive purple #8b5cf6 (CSAT), success green #059669, warning amber #d97706, error red #dc2626, neutral slate #64748b, muted grey #94a3b8@35%. Metric-identity and status colors are **not** brand-overridable per the existing "Non-Brandable Tokens" rule — hardcode exactly as `LAYER_COLOR`/`GAP_SEVERITY_COLOR` already are in `GroupReportPage.tsx`.

#### Part C — Reports Index Page (`TAG_REPORTS_INDEX`, added 2026-07-02)

*(Closes gap #1 from the 2026-07-02 review: the route has existed since 2026-07-01, but nothing specified its layout. Written spec only — see the Figma note at the top of this section.)*

Route: `/app/experience/reports`. `max-w-7xl mx-auto`, `PageHeader` "Reports" with a 2-crumb trail (Experience → Reports) — this page is the trail's middle link for every report page below it.

**Vertical layout:** PageHeader → Stats Strip → Toolbar (search + sort) → Card Grid → (pagination is out of scope for v1 — org tag counts are small enough that "Load more" isn't yet justified; revisit if a customer's tag count grows past ~50).

**Stats Strip** (3-up, `grid grid-cols-1 sm:grid-cols-3 gap-4`, `GlassCard` per stat — reuses `WorkflowsPage.tsx`'s stats-row pattern with one deviation: made responsive, since this page is explicitly meant to be checked from a phone during the Automated-mode "standing weekly digest" scenario that `WorkflowsPage`'s desktop-only stats row doesn't need to support):
1. **Tags with reports** — total count.
2. **Needs attention** — count of tags whose latest run has an active warning (amber number if >0, neutral slate if 0 — never a fake green "all good," matching the omission rule used elsewhere in this design).
3. **Automated schedules active** — count of tags with Automated mode enabled. Directly serves discoverability for the weekly-digest use case that motivated this whole sub-nav (DESIGN.md Appendix C).

**Toolbar**: debounced search (filters by tag name, same input pattern as `SurveysListPage.tsx`) + `SortDropdown` (Recently generated [default] / Alphabetical / Most surveys).

**Card Grid**: `grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4`, Framer Motion stagger/rise entrance (matches `TagsSettingsPage.tsx`). Each card (`GlassCard`, whole card clickable → `TAG_REPORT_LATEST` for that tag):
- Tag color dot + tag name (header row)
- Survey count ("6 surveys")
- Latest run: relative timestamp ("Generated 2 hours ago") + mode badge (shadcn `Badge`, neutral/slate variant — never a metric color, mode identity and metric identity must never share an encoding, same rule as Part A's color-coding)
- Health signal: amber dot + "Needs attention" text, using the same tiering logic as `ConfidenceChip` — **rendered only when there's an active warning; omitted entirely otherwise**, never a positive/"healthy" badge

**Empty states (two, deliberately distinct — do not conflate them):**
1. **Zero tags have any report yet** (org-wide first run): centered icon-in-circle + heading "No tag reports yet" + body copy + gradient CTA "Go to Tags" → `TagsSettingsPage`. Matches `WorkflowsPage.tsx`'s empty-state visual pattern.
2. **Search yields zero results** (reports exist, query too narrow): small inline row, "No tags match “{query}”" + "Clear search" link. Must not reuse state 1's illustration/copy — that would falsely imply no reports exist at all when the real issue is the search term.

**Loading state**: dedicated `TagReportsIndexSkeleton` (new, modeled on `SurveyListSkeleton`'s shape/rhythm) — not a spinner. This page should follow the one existing page (`SurveysListPage`) that already does loading right, not the two that don't (`WorkflowsPage`, `TagsSettingsPage`).

**Responsive**: 1 col mobile → 2 col tablet (`md:`) → 3 col desktop (`lg:`), matching the house grid convention confirmed across `TagsSettingsPage`, `GroupReportPage`, and `AdvancedInsightsPage`.

#### Part D — Survey List Entry Point (added 2026-07-02)

*(Closes gap #2 from the 2026-07-02 review: Tag Report previously had exactly two entry points — the `TagsSettingsPage` button and the Reports sub-nav — neither of which is where a user is looking at a specific survey and thinking about its tag.)*

**Decision: extend the existing `TagBadge` component rather than add a new column, menu item, or icon** — every survey row already renders `TagBadge` per tag (`SurveysListPage.tsx` ~line 578-584), and `TagBadge` is *already* clickable-to-report in one place in the app today (`TagsSettingsPage.tsx:111-116`, via its parent `Card`'s `onClick`). This reuses a pattern that already exists rather than introducing new UI vocabulary for the same action.

**Change**: add an optional `onNavigate?: (tagId: string) => void` prop to `TagBadge` (`app/src/components/TagBadge.tsx`). When present:
- Hover: subtle brightness/scale lift + `cursor-pointer`, small chevron glyph fades in (mirrors the component's existing conditional-icon pattern already used for `removable`'s ✕).
- Click: calls `onNavigate(tag.id)` → `navigate(ROUTES.TAG_REPORT_LATEST(tag.id))`. Must `stopPropagation()` so it doesn't also trigger the survey row's own click-through to survey detail — same precedent as the existing ✕ remove handler's `stopPropagation`.
- Accessibility: `title`/`aria-label="View Tag Report for {tag.name}"` — the chip is otherwise an unlabeled interactive element today.

**Where it's wired, and where it deliberately is not**:
- **Wired**: `SurveysListPage.tsx`'s per-row tag rendering (~line 578-584) — this is informational/display context, safe to make navigable.
- **Not wired**: the active-filter pill row (~line 479-486), which already uses `TagBadge` in `removable` mode for filter-clearing — that's a different, already-established interaction; don't overload the same chip instance with two conflicting click behaviors.

**No "not enough surveys" dead-end to design for**: every tag is clickable regardless of how many surveys carry it — Tag Report already has explicit single-survey handling (DESIGN.md R-T2a), so clicking a tag used by only one survey still lands on a valid (if disclosure-heavy) report rather than an error state.

---

## 4. Security & QA (Wave 2 — complete, 2026-07-01)

Per `docs/tag-report/TEAM.md`'s coordination rule, this review ran after the engineering scope above was locked.

### 4a. Security findings (Riley) — status after fixes

1. ✅ **Fixed.** `survey_ids` removed from Tag Report's request contract entirely (see DESIGN.md A.2) — server always derives membership from `tag_id → survey_tag_mappings`, scoped to `org_id`. The pre-existing `/generate` endpoint's bare-`survey_ids` acceptance is tracked as its own follow-up (§1 Task 12b, added below).
2. **Accepted risk for v1, not fixed** — no per-survey access restriction beyond org-level trust. Documented remediation path if ever needed: wire the existing `requirePermission.ts` engine (already live elsewhere in the codebase) into `survey-groups.ts`/`responses.ts`/`insights.ts`. No action required now.
3. ✅ Tracked, unchanged — §1 Task 12 (`requireRole('analyst')` fix on the existing `/generate` route).
4. ✅ **Fixed.** Task 16 (§3) now explicitly requires the Response Detail endpoint to re-check per-survey access on every request, not just response existence.
5. ✅ Confirmed fine as designed, no change.
6. **Not an engineering fix — needs a business decision, now with a concrete proposal attached.** See DESIGN.md §7 item 0 (added) and the proposal below.

**Proposed default for the citation-erasure question** (engineering recommendation, pending business/compliance sign-off — DESIGN.md §7 item 0), **tightened post-final-review per Riley's follow-up check**: implement an async redaction hook triggered on response erasure (hard delete or a formal right-to-erasure request, not routine soft-delete) with two additions the first draft of this proposal was missing:
1. **A stated maximum redaction SLA** (e.g., "within 15 minutes of erasure confirmation") — the original proposal left "async" open-ended, which leaves an unbounded window where a report already fetched client-side (or cached server-side) still shows the verbatim quote.
2. **Full JSONB-location coverage, not just `citations_json`/`group_insights`.** The redaction scan must also cover `group_insight_runs.result_json` and `group_insight_runs.stream_events` — both can independently hold a copy of cited quote text (e.g. a `narration_complete` stream event snapshotting the narrative text at generation time), and a hook that only scans `citations_json`/`group_insights` would miss these.

Scanning for matching `(survey_id, response_id)` pairs across all four locations, replacing the cached `quote` text with a `"[response no longer available]"` placeholder while leaving other citation metadata (sentiment, relevance) intact for aggregate statistics. Still a recommendation to build, not yet an approved requirement — needs the Business Stakeholder's answer to DESIGN.md §7 item 0 before it becomes scoped work.

**New follow-up task, §1 Task 12b**: audit and fix `POST /api/group-insights/generate`'s existing bare `survey_ids` acceptance for non-tag-scoped calls (Riley finding 1's pre-existing half) — separate from Tag Report's fix, same root cause.

### 4b. QA edge-case matrix (Casey) — status after fixes

1. ✅ **Fixed.** Now R-T2a in DESIGN.md §4.4 — single-survey tag shows a single-survey-sourced descriptive finding, never blocked or silently blank.
2. ✅ **Fixed, both halves — required a second pass.** Degenerate bracket case is an explicit AC under R-C1 (flat snapshot, labeled "no comparison available," never a false "0% change"). The distortion formula's first fix (a hard 14-day cutover) was itself re-reviewed and found to have a confirmed inversion bug (a narrower window could score better than a wider one at the same absolute offset) — corrected again to a three-zone formula (absolute below 10 days, ratio above 18 days, stricter-of-both in the 10–18 day blend zone). DESIGN.md R-C2 and TRACKER §2 node 7 now match exactly.
3. ✅ **Fixed, required a second pass.** The concurrency guard itself (Appendix A.5) was confirmed correct by three independent reviewers, but all three separately flagged the same follow-on gap: the API-level fix alone left the frontend UX unspecified. Closed with an explicit disclosure requirement (Appendix A.5 AC + new Task 17) — an in-flight-run collision must be surfaced to the user, never silently substituted.
4. ✅ **Fixed.** Resolution query now explicit `LEFT JOIN` (§1 above) — an org with no `org_insight_defaults` row at all still resolves to the hardcoded default of 5.
5. ✅ **Fixed.** Task 16 (§3) now explicitly specifies the non-clickable plain-text fallback for citations missing `survey_id`.

### 4c. Final consistency sweep (Devon) — found and fixed 2026-07-01

A dedicated final-gate read (beyond the 4a/4b fixes above) found three more real inconsistencies, all now fixed: (1) a stale idempotency-key description in §1's Rate Limiting notes contradicting the actual A.5 concurrency guard — corrected; (2) **the most serious of the three** — most of DESIGN.md's prose (7 lines, including three requirement ACs) still described Tag Report as reading from `insight_reports`, the table name from *before* the checkpoint-FK correction, and TRACKER.md had gone as far as proposing a concrete new database index against that wrong table — both corrected to `insight_checkpoints_v2` throughout; (3) a casing mismatch on the `metric_key` CHECK constraint (`'NPS'` in DESIGN.md vs. `'nps'` in TRACKER.md's migration SQL) — standardized on lowercase to match the CrystalOS code's own existing `has_nps`/`has_csat`/`has_ces` convention.

**Final verdict across all reviewers**: every finding from this review round — QA, security, the independent AI scientist, the independent XM expert, and this final architectural consistency sweep — now has a concrete, verified fix in the documents. The only remaining open item across both documents is DESIGN.md §7 item 0, a business/compliance decision (not an engineering gap) with a concrete engineering proposal already attached. Recommend one lighter confirmation pass once implementation begins, to verify the actual code matches these now-concrete specs — but no further design brainstorming is needed before that.

## 5. Naming & Branding (resolved 2026-07-02)

A cross-functional naming panel (Marketing, Advertising, Sales, an XM-customer/VoC practitioner voice, and Morgan as Product Owner) evaluated a shortlist against DESIGN.md's actual requirements — not generic branding theory.

**Product name: stays "Tag Report."** Three shortlist alternatives were vetoed on substantive grounds: "Crystal Trendline" contradicts the Trust Layer's own trend-suppression behavior (R-T2/R-T2a); "Crystal Compass" overpromises active guidance the feature doesn't do (§2.2/§2.4 forbid fresh generation and cross-metric blending); "Facet" collides with existing "faceted search/filter" meaning in enterprise software. "Crystal Program Pulse" (Sales/PO's top pick) was dropped after the customer-voice reviewer flagged a real collision risk with existing survey-naming conventions (e.g. a survey literally named `onboarding-pulse`). The customer reviewer's bottom line — "Tag Report" is findable and not actually a problem, discoverability beats cleverness — was weighted heavily in the final call to keep the working name.

**Tagline (decided): "Tag them, see their insights together, and compare the trend."** Chosen because it maps directly to the three real mechanics rather than being generic AI-marketing copy: *tag them* = grouping surveys under a tag, *see their insights together* = Manual/Automated mode reading existing per-survey Crystal checkpoints (never generating new ones, §2.2), *compare the trend* = Custom Range's bracketed wave-over-wave delta (§4.3/R-C1).
