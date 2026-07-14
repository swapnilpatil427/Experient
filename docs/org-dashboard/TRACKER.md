# Org Dashboard (Command Center) — Implementation Tracker

Branch: `org-dashboard` (from `tag-report-final`). Worktree: `/private/tmp/claude-501/org-dashboard-worktree`.
See `IMPLEMENTATION_SPEC.md` for the reconciled architecture, `DECISIONS.md` (22-27) for why it
diverges from `ARCHITECTURE.md`/`ROADMAP.md` in several places, and `INTEGRATION_GUIDE.md` for
how it wires into the rest of the platform.

## Status legend
`[ ]` not started · `[~]` in progress · `[x]` done & verified · `[!]` blocked/descoped (see note)

---

## 0. Reconciliation
- [x] Ground-truth audit of docs vs. real schema/infra (4 recon passes)
- [x] `IMPLEMENTATION_SPEC.md` written
- [x] `DECISIONS.md` Decisions 22-26 recorded (implementation-time reconciliation)
- [x] Decision 27 recorded (recommendations JSONB snake_case→camelCase mapping, tagId resolution — found during integration, see §7)

## 1. Database layer — DONE
- [x] `org_metrics_daily` materialized view
- [x] `org_metrics_weekly` materialized view (LAG-based WoW deltas)
- [x] `survey_health_summary` materialized view (alert_events-derived anomaly_count, survey_tags array agg)
- [x] `org_health_score` table + `compute_all_org_health_scores()` procedure
- [x] `tag_metrics` materialized view
- [x] `org_topic_trends` table + `compute_org_topic_trends()` procedure (rolls up real `survey_topics` columns: name/volume/sentiment_score)
- [x] `org_crystal_briefs` table (parent_checkpoint_id, delta_from_prior, hallucination_score, trust_json)
- [x] `org_custom_summaries` table (compared_against_brief_id, requested_by TEXT NOT NULL no FK)
- [x] `org_report_history` view
- [x] `org_profiles.benchmark_nps` column + `agent_runs.run_type` CHECK widened (constraint name confirmed by grep before drop)
- [x] `idx_insights_survey_layer_trust` (CONCURRENTLY, isolated in its own migration file)
- [x] `responses(org_id, submitted_at)` index (CONCURRENTLY, isolated)
- [x] Rollback comment block in every migration file
- [x] Scheduler jobs (`orgMetricsDaily`/`surveyHealthSummary`/`orgMetricsWeekly`/`orgTopicTrends`/`orgHealthScore`) — registered in `backend/src/scheduler/registry.ts` (not `runner.ts` — the data engineer correctly found `runner.ts` is a generic tick loop with no per-job code; `registry.ts`'s `JOBS` array is the real registration site)
- [~] **Not executed against a live database** — Docker socket and even `localhost:5432` are blocked by this sandbox's network policy (confirmed independently by 2 separate agents + myself). Verified instead by: (a) hand-tracing every statement against Postgres 16 syntax, (b) cross-referencing every column reference against the real schema via direct migration grep, (c) `scripts/migrate.js`'s CONCURRENTLY-detection logic reviewed line-by-line and confirmed non-destructive to the ~90 pre-existing migrations (diff shows the non-CONCURRENTLY path is byte-identical to before). **First real action item when this reaches an environment with DB access: run `node scripts/migrate.js` and confirm all 12 files apply cleanly.**

## 2. Backend API — DONE
- [x] `org-metrics.service.ts` — all query logic, stale-while-revalidate Redis caching
- [x] All 8+ REST endpoints (`/dashboard`, `/programs`, `/trends`, `/topics`, `/tags`, `/alerts` + acknowledge, `/crystal-brief` + regenerate, `/health-score`, `/briefs` + compare, `/summaries` + preview/list/detail)
- [x] `org-realtime.service.ts` — SSE (not WebSocket, per Decision 22), `publishOrgEvent`/`publishResponseReceivedDebounced`
- [x] `resolveOrgSummaryCost` (own cost curve, not a reuse of survey-level tiers)
- [x] `agentsClient` extended (`triggerOrgBrief`/`triggerOrgCustomSummary`, corrected to the real single CrystalOS endpoint)
- [x] Additive hooks into `alertEngine.ts` (`fireAlert`) and `responses.ts` (real insert path only, not the synthetic sample-response generator) — reviewed, confirmed fire-and-forget with `.catch(() => {})`, zero change to existing return values
- [x] Route mounted in `backend/src/index.ts`; SSE registered via `registerOrgDashboardStream(app)` (applied during integration pass)
- [x] `org-dashboard.test.js` — 6/6 passing
- [x] Full backend suite re-run after integration fixes: **97 files / 1353 tests pass**
- [x] `tsc --noEmit` clean (only pre-existing, unrelated `prism/uploads.ts` errors — missing `@aws-sdk/client-s3` dep)

## 3. CrystalOS — DONE
- [x] `org_brief_graph.py` — 6 nodes, weekly/custom period modes, structured-JSON grounding isolation + injection canary
- [x] Insight-consumption gated behind `ORG_BRIEF_ENABLE_INSIGHT_CITATIONS` (default false, per Decision 24)
- [x] `org_brief_verify.py` — 3-pass `verify_and_score` (numeric grounding + LLM grounding reused as-is + new grounding-completeness pass)
- [x] `org_signal_detector/` skill — SKILL.md, EVALS.md (all 18 cases with concrete fixtures), detector.py, signal_types.py — writes to `alert_events` (not a new table)
- [x] `crystalos/routers/org_brief.py` — registered in `crystalos/main.py` during integration pass; verified via live import (`POST /api/crystal/graphs/org-brief` present in `app.routes`)
- [x] Custom-range guards (90-day cap enforced at API layer, sample-size floor, signal suppression below 7-day floor)
- [x] Checkpoint lineage via `tools/delta.py::compute_delta()` directly on `org_crystal_briefs` (no separate checkpoint table, per Decision 15/16's own simplification)
- [x] EVALS.md cases 1, 2, 3, 4, 7, 11, 15 manually traced against live code during CrystalOS agent's own verification pass; found and fixed a real "fewer than 3 recommendations on sparse data" bug and an `alert_events.metadata`/`org_topic_trends` omission by cross-checking against the data-layer agent's already-committed migrations
- [x] `python -m py_compile` + live import of all 5 new modules + `build_org_brief_graph()` — verified during integration pass (this session, with the repo's real `.venv`)

## 4-6. Frontend — DONE
- [x] `KpiTile.tsx` extracted verbatim (verified: all 4 original `<KpiTile>` call sites in `ExperienceHubPage.tsx` untouched; new file is byte-identical rendering logic)
- [x] `HealthPill.tsx`, `SparklineCell.tsx`, `SeverityBadge.tsx`, `TopicChip.tsx`, `war-room.css`, `WarRoomToggle.tsx`
- [x] `CitationChip` gained an optional `onClick?` prop (additive, default `undefined` preserves prior no-op behavior)
- [x] 6 new hooks + `useOrgDashboardLive.ts` (SSE-based) + `useNotifications.ts` extended for 2 new event types
- [x] All ~14 new components (`CrystalBriefCard`, `WeeklyBriefTeaserCard`, `AnomalyAlerts`, `EmergingTopics`+`TopicDrawer`, `TagGroupsStrip`, `TagIntelligenceGrid`, `NPSTrendChart`, `ProgramsTable`, `BriefArchive`, `ManualSummaryGenerator`, `GenerationStatusChip`, `CheckpointDiffPanel`)
- [x] `ExperienceHubPage.tsx` — **verified additive-only** via full `git diff` read: no pre-existing JSX removed/reordered, `crystalOpening` never appears in the diff (fully untouched), all 4 original KPI tiles intact, only new insertions (imports, 2 hooks, 5th KPI tile, Weekly Brief teaser, Tag Groups strip) plus the KpiTile extraction
- [x] `OrgTrendsPage.tsx` — promoted to full Command Center; original `useOrgOverview()` 4-stat grid verified still rendering (now through `t()` instead of hardcoded English — a compliance improvement, not a regression)
- [x] Mobile responsive via existing `useBreakpoint()` (Dialog→Sheet branch for Manual Summary Generator, etc.)
- [x] `locales/en.ts` — new `orgDashboard` namespace; **verified during integration pass**: all 89 distinct `t('orgDashboard.*')` call sites across every new/edited file resolve to a real key (0 missing), and a JSX heuristic scan of the new components found no hardcoded English
- [x] `tsc --noEmit` clean on both `app/` and `backend/` (only pre-existing, unrelated `reactflow`/`prism` errors remain, confirmed untouched files)
- [x] `npx vite build` — all 4263 modules transform with zero errors (fails only at final bundling on the pre-existing unrelated `@reactflow/core` issue)

## 7. Integration pass — DONE (this session)
- [x] `app/src/lib/dataBus.ts` — `'orgDashboard'` resource added
- [x] Drill-down wiring: `CrystalBriefCard`/`WeeklyBriefTeaserCard` recommendation → `EXPERIENCE_SURVEY` when `surveyId` present; Tag Groups strip → full nav to Tag Report
- [x] **Mount points wired**: `backend/src/index.ts` (route + SSE registration), `backend/src/scheduler/registry.ts` (5 jobs), `crystalos/main.py` (org_brief router) — all 3 were deliberately left as TODO handoff notes by the parallel agents per the file-ownership rule; applied here and verified via live import/typecheck
- [x] **Real bug found and fixed**: `org_brief_graph.py` wrote recommendation objects with raw snake_case keys (`survey_id`, `action_type`, `tag_id`/`tag_group_id`, `source_insight_ids`) into JSONB; the backend passed them through as `unknown[]` with no transformation; the frontend's TS type declared camelCase fields. At runtime every recommendation's `surveyId`/`actionType`/`tagId` would have been `undefined`, silently breaking the drill-down link and action-type icon on every rendered brief. Fixed with a single `mapRecommendation()` in `org-metrics.service.ts`, resolving `tagId` as the canonical field (over `tagGroupId`) per Decision 23, and adding the missing `sourceInsightIds` field to the frontend type. Re-verified: full backend suite still 1353/1353 passing, `tsc` clean both sides.
- [x] `tsc --noEmit` clean for all new/edited frontend AND backend files
- [x] Backend integration tests passing (97 files / 1353 tests, incl. the 6 org-dashboard-specific ones)
- [x] Manual regression pass on `ExperienceHubPage`/`OrgTrendsPage` — full diff read, confirmed additive/preserving as documented above
- [x] `INTEGRATION_GUIDE.md` written
- [x] `agent_runs_run_type_check` constraint name verified against the actual prior migration before being dropped/recreated (not guessed)

## 8. Explicitly descoped / deferred (documented, not silently dropped)
- [!] ⌘K global command bar integration — no generic `CommandBar.tsx` exists (only `SupportCommandPalette.tsx`, support-scoped); "Ask a follow-up" buttons reuse `openCrystal()` from `useCrystalPanel()` instead
- [!] k6/Artillery load testing at 500 surveys / 1M responses — no staging environment or DB access available in this sandbox (Docker socket and even `localhost:5432` are blocked); query plans are sound by construction (all matviews have covering unique indexes) but genuinely untested at scale. **Do this before the soft launch.**
- [!] Lighthouse/WCAG automated audit — no browser automation harness available; components were built directly against DESIGN.md's accessibility spec (aria-labels, focus rings, contrast-checked palette) but not scanned
- [!] Full `npsColor()`/`HealthPill` unification across the 6 pre-existing call sites — flagged as a follow-up, not done now, to avoid touching unrelated stable pages
- [!] Multi-org switcher for CX agencies — explicitly out of scope per Decision 19/DESIGN.md's "Out of scope" note
- [!] Citation-bearing briefs / insight consumption — fully built, shipped OFF (`ORG_BRIEF_ENABLE_INSIGHT_CITATIONS=false`) pending Tag Report's citation-erasure redaction hook (confirmed not built anywhere in this codebase). One-line flag flip once that hook lands — no further code change needed.

## 9. Final verification summary

| Check | Result |
|---|---|
| Migrations hand-traced + cross-referenced against real schema | Done — no live DB in this sandbox, see §1 |
| `scripts/migrate.js` CONCURRENTLY-handling change reviewed for safety to the other ~90 migrations | Done — non-CONCURRENTLY path confirmed byte-identical |
| Backend test suite | **1353/1353 passing** (Node 22 via nvm; the repo's default shell Node 16 cannot run this vitest version) |
| Backend `tsc --noEmit` | Clean (pre-existing unrelated errors only) |
| CrystalOS `py_compile` + live import + graph compile | Clean, verified this session |
| `crystalos/main.py` live import with new router registered | Clean, route confirmed present in `app.routes` |
| Frontend `tsc --noEmit` | Clean (pre-existing unrelated errors only) |
| Frontend `vite build` | All new modules transform cleanly |
| Locale key coverage | 89/89 `orgDashboard.*` keys used resolve to real entries |
| `ExperienceHubPage.tsx` additive-only guarantee | Verified via full diff read |
| Cross-track integration bug found & fixed | Yes — recommendations JSONB casing/naming (§7) |
| Branch state | `org-dashboard`, not merged, all work committed (see below) |

**Not possible in this sandbox, flagged honestly rather than faked:** executing migrations against
a live Postgres, running the app end-to-end in a browser, load testing, automated accessibility
scanning. Everything else that could be verified without those was verified, not assumed.
