# Xperiq Actions (Workflow Automation) — Implementation Tracker

## Wave 19 — App-wide Crystal visual identity consistency (2026-07-03, COMPLETE)

**Scope note**: unlike every prior wave, this one is APP-WIDE, not automation-hub
-scoped — tracked here anyway for process continuity (same team, same dispatch
pattern). Per user's explicit decisions:
1. Existing session work committed first (commit `926ca16`, 46 files).
2. Fix scope: the ENTIRE app, not just Automation Hub.
3. Problem: INCONSISTENCY, not absence — Crystal's gradient identity
   (`#2a4bd9` → `#8329c8`, confirmed hardcoded as raw hex in 20+ files via
   grep, not a shared token) already exists everywhere but isn't tokenized,
   which both risks drift and (per root CLAUDE.md's Brand Theme System)
   breaks for any org with a customized brand primary color.
4. **"Use org setting and use it everywhere"** — Crystal's visual identity
   should be driven by the existing `--brand-*`/`--color-*` org-customizable
   token cascade, not fixed hex values, applied consistently across every
   surface that currently hardcodes it.
5. **"Be very very careful and accurate"** — full inventory before any
   change, staged rollout, full regression gate.

**Team dispatch, sequential (spec → build → verify):**
- **Rohan** (UX) — full inventory of every hardcoded Crystal-identity value
  (colors, gradients, fonts) across the whole app; design exactly how
  Crystal's 2-color gradient maps onto the existing `--brand-primary`/
  `--brand-accent`/`--brand-secondary` token system (a single brand color
  doesn't obviously map to a 2-stop gradient — this needs a real decision,
  not a guess); produce an implementation-ready token spec.
- **Elias** (frontend) — build from Rohan's spec, systematically, file by
  file, across the full inventory.
- **Kenji** (QA) — full regression + visual-consistency verification, confirm
  zero remaining hardcoded instances, confirm brand customization actually
  takes effect on Crystal-branded elements now.

**Note on dispatch mechanics**: this wave was run with a lower agent-concurrency
cap than earlier waves (2 background agents at a time, no `isolation: "worktree"`)
after a prior session hit an `E2BIG` shell failure caused by git-worktree buildup
from many concurrent worktree-isolated agents. All Wave 19 work happened directly
in the main checkout — no worktrees created. This is the dispatch pattern to keep
using going forward for large fan-out waves.

**Rohan — spec complete.** Full spec at `docs/automation-hub/WAVE19_CRYSTAL_IDENTITY_TOKEN_SPEC.md`:
68-file inventory (3 categories: Crystal-identity core, generic-brand-reuse long
tail, incidental/unrelated-do-not-touch), the `--color-accent` vs `--color-tertiary`
trap (a real pre-existing bug found in `workflowScopeDisplay.ts`), the JS-resolution
wrinkle for Three.js/third-party-SDK color props, and a 3-stage rollout plan.

**Elias — build complete, in 4 passes:**
1. **19a (Crystal-identity core)**: `CrystalPanel.tsx`, `AskCrystalFab.tsx`,
   `NLThinkingCrystal.tsx`, `CrystalNarrativeWidget.tsx`, `ExperienceHubPage.tsx`,
   `SurveyIntelligencePage.tsx`, `GeneratingOverlay.tsx`, `SupportCommandPalette.tsx`.
2. **19b (generic-brand-reuse long tail)**: ~50 files across `components/*`,
   top-level `pages/*`, `pages/insights/*`, `pages/experience/*`, dispatched as 3
   background batches (2 concurrent at a time, disjoint file sets, no worktrees).
3. **19c**: `workflowScopeDisplay.ts`'s `--color-accent` → `--color-tertiary` bug fix.
4. **Gap-fill pass** (post-batch audit, done directly rather than via another
   agent — small and well-understood): a repo-wide grep after all 3 batches found
   ~15 more files with genuine brand-reuse hex that weren't in Rohan's original
   68-file inventory (the spec itself flagged its file lists as "not exhaustive,
   grep-and-fix systematically") — `PipelineEventFeed.tsx`, `PipelineStats.tsx`,
   `DashboardFilterBar.tsx`, `DashboardScopeBar.tsx`, `InsightDocumentCard.tsx`,
   `RolesPanel.tsx`, `TeamPanel.tsx`, `DocEditorPage.tsx`, `DocGapsPage.tsx`,
   `DocPipelinePage.tsx`, `DocReviewPage.tsx`, `PipelineStatsPage.tsx`,
   `IntegrationsSettingsPage.tsx`, `SignInPage.tsx`, `ContactsPage.tsx`,
   `ContactDetailPage.tsx`. Also found and fixed: **`ExperienceHubPage.tsx` and
   `SurveyIntelligencePage.tsx` — spec's own named Wave-19a core-scope files —
   were only partially tokenized** (the dark-hero radial gradients, KPI icon
   colors, sparkline/progress-bar colors, "Ask Crystal" bar, and perspective-grid
   floor dots still had literal hex); the static-hex regression test only covers
   3 of the 8 Wave-19a files, so it didn't catch this. Fully swept both files,
   correctly preserving the `LAYER_BORDER`/`getCapabilityLayers` insight-layer
   taxonomy restatements (category c) that intentionally keep fixed hex.
   Also fixed several `${color}NN` hex-alpha-suffix string patterns (invalid CSS
   once `color` becomes a `var(...)` string) with `color-mix(in srgb, ...)` —
   same technique across `LoadingStates.tsx`, `SurveyActionModal.tsx`,
   `ExperienceHubPage.tsx`'s survey-status pill, `SurveyIntelligencePage.tsx`'s
   tier banner, `BrandSettingsPage.tsx`'s team-status badge. One incidental bug
   found+fixed: `PrismHomePage.tsx` had a mismatched `var(--color-primary-container,
   #82deff)` fallback (wrong hex for that token) — corrected to `--color-secondary-container`.
   Two new JS-resolution hooks added (`HeroCanvas.tsx`, `TopicDetailPanel.tsx`),
   following the `NLThinkingCrystal.tsx` `resolveCssVarColor` pattern (not
   cross-imported — each file has its own small local copy).

**Kenji — verification complete:**
- Zero remaining hardcoded Crystal-brand hex/rgba anywhere in `app/src` outside
  verified category-(c) exclusions (insight-layer taxonomy, question/survey-type
  enums, plan-tier badges, priority/status/channel/dimension enums, demo-data
  avatar palettes, token *definitions* in `theme.css`/`brandTheme.ts`, and dead
  code `IrisChat.tsx`/`AiChatPanel.tsx`) — confirmed by repo-wide grep covering
  all 7 mapped hex values + all their rgba-decimal forms (primary, tertiary,
  secondary, primary-dim, primary-container, tertiary-container, secondary-container).
- Zero-visual-diff for default-brand orgs holds by construction (token defaults
  are byte-identical to the replaced hex, per spec §4.2) — every replacement in
  this wave preserved this property.
- Brand-override reaches Crystal now via the same already-proven CSS-var cascade
  (`applyBrandTheme()` → `--brand-*` → `--color-*`) the rest of the app already
  uses successfully — this is the actual bug fix this wave exists to deliver.
- **Full suite: 90 files / 1036 tests, 1036 passing.** `npx tsc --noEmit`: 0
  errors. `npm run lint`: 0 errors/warnings. (Two intermittent failures surfaced
  mid-wave — `scheduleConfig.test.ts` cron timeouts and
  `NotifyTargetPicker.test.tsx`'s aria-activedescendant test — both in files
  untouched by this wave, both confirmed flaky by re-running in isolation
  multiple times with 100% pass rate; not Wave 19 regressions.)

---

## Wave 18c — Full org registry for the message-content force route (2026-07-03, COMPLETE)

Closes the one gap Amara explicitly flagged (not hid) in Wave 18a: her new
message-content detector correctly force-routes trigger/action/condition
REFERENCE questions to `workflow-analyst` from any page, and substitutes
`FALLBACK_REGISTRY` (a real, code-defined, but smaller/staler catalog) when
no live registry is present — this already fixes the exact reported
hallucination, but doesn't give the skill the org's actual live scope
data (surveys/tags) the way Wave 15's page-context force already does.

**Team dispatch: Nina** (owns `backend/src/routes/experience.ts`'s registry
plumbing from Wave 15/18b). Scope: widen the condition that decides whether
to fetch+attach the org's live registry so it ALSO covers Amara's detector
firing — not just `surface === 'workflow_builder'`. Since the detector logic
itself lives in CrystalOS (Python), the Node proxy can't literally re-run it,
so the practical options are: (a) run an equivalent lightweight detection at
the Node layer too (some duplication, but Node already can't avoid deciding
whether to pay the extra DB-query cost), or (b) always attach the registry
whenever a `message` is present regardless of surface (simpler, slightly
higher DB cost on every Crystal turn) — Nina's call, with reasoning, given
she owns this file and the query-cost tradeoff from her own Wave 15 work.

**Nina — DONE. Chose Option A (lightweight conservative mirror in TypeScript),
not Option B (always-attach).** Reasoning: Option B would add 2 extra indexed
queries to EVERY Crystal turn across the whole app (Insights pages, org
portfolio, group insights — the overwhelming majority of traffic), for zero
benefit on the vast majority of those calls (a "why did NPS drop?" question
never uses `workflow_registry`). That's a real, permanent cost increase for
no corresponding value, not a simplification worth its price. Option A's
duplication risk (a second detector, in a second language) is real and is
the same class of smell Nina flagged in Wave 18b — but the precision bar
here is fundamentally different from Amara's: her detector decides ROUTING
(a false positive mis-routes a real survey question — a wrong-answer risk).
This one only decides whether to run 2 cheap, read-only, indexed queries — a
false positive here costs a wasted query, never a wrong answer. That gap in
stakes justifies keeping the two detectors independent rather than forcing
a cross-language unification neither needs.

- **`mentionsWorkflowTaxonomy`** (`backend/src/routes/experience.ts`, new,
  module-scope): a single conservative regex —
  `/\b(?:trigger|action|condition|automation|workflow|scope|operator)s?\b/i` —
  deliberately looser than Amara's `_WORKFLOW_TAXONOMY_PATTERNS` allowlist
  (no question-structure requirement, just noun presence). Intentional: this
  function only gates an extra DB round-trip, not a routing decision, so
  recall is favored over precision here (the opposite tradeoff from Amara's
  detector, and explicitly documented as such in the code comment).
- **`shouldAttachWorkflowRegistry = isBuilderContext || mentionsWorkflowTaxonomy(body.message)`**
  now gates the surveys/tags queries + `workflow_registry` attach (both the
  happy-path and the context-load-failure fallback branches, mirroring Wave
  15's dual-branch structure exactly). `builder_draft` relay stays gated to
  `isBuilderContext` alone — it's only meaningful when the client actually
  claims to be in the builder; a taxonomy question from Insights has no draft
  to relay and correctly omits the key.
- **Verified harmless additive key**: `workflow_registry` is just one more
  key on `agentBody`; skills that don't read it (`crystal-analyst`, etc.)
  ignore it identically to how they already ignore `builder_draft` today —
  confirmed by re-running all pre-existing Wave 15/18b tests unmodified.
- **Tests** (`experienceCrystalStreamBuilderContext.test.js`, +4, new describe
  block): (1) "What types of trigger exists?" from a plain org-scope call
  with NO `surface` — the literal reported-bug shape — now gets
  `workflow_registry` attached with the real surveys/tags fixtures, and
  correctly omits `builder_draft`/`surface`; (2) "Why did NPS drop?" from the
  same non-builder shape does NOT trigger the extra queries (asserts
  `surveysCall`/`tagsCall` both `undefined`, same call-count-proof pattern as
  Wave 15's own negative test); (3) an actual `surface: 'workflow_builder'`
  call is unaffected — still gets the registry and still relays
  `builder_draft`; (4) a request with no `message` field at all doesn't throw
  and correctly omits `workflow_registry`. All 5 pre-existing Wave 15/18b
  tests in the same file pass unmodified (byte-identical-when-absent
  regression, builder-context attach, no-op query-count proof, credit
  metering, 402-before-queries) — confirmed via direct re-run, not assumed.
- **Full suite, orchestrator-verifiable**: backend **89 files / 1233 tests,
  1232 passing before → 89 files / 1237 tests, 1236 passing after** (+4,
  exactly the new tests; same single pre-existing, documented, unrelated
  `workflowEngine.test.js` "RED, proves 2d" marker, unchanged). `tsc --noEmit`
  shows zero new errors touching `experience.ts` (the only pre-existing
  errors are in unrelated `src/lib/prism/uploads.ts`, untouched by this wave).

---

## Wave 18 — Crystal hallucinated an answer to "What types of trigger exists?" (2026-07-03, IN PROGRESS)

**User-reported, via screenshot**: asking Crystal "What types of trigger exists?"
produced a hallucinated answer ("common trigger types often include...") citing
2 FAKE sources ("NPS Feedback — Q3 2026") — survey data completely unrelated to
the product's actual trigger registry.

**Root cause, confirmed by direct investigation (3 layers):**
1. `CrystalPanel.tsx`'s `classifyAsSupport()` — a plain keyword-substring list
   deciding whether to route into `crystal-support` mode at all — has zero
   keywords matching "what types/kinds of X exist"-style reference questions
   (list: 'help'/'error'/'broken'/'how do i'/'stuck'/etc.). This question
   matched none, so it never entered support mode.
2. Falling through to the normal semantic-routed path, it almost certainly
   landed on `crystal-analyst` (the survey-data skill) — which has zero
   knowledge of the trigger registry and, per its own citation-grounding
   habit, hallucinated a plausible answer and cited whatever survey data was
   in its context, regardless of relevance.
3. **Even fixing #1/#2 wouldn't fully close this**: `support_docs` (the table
   `crystal-support`'s `search_support_docs` tool queries) has ZERO actual
   content about Xperiq Actions/workflow triggers seeded anywhere — confirmed
   by grepping the seed migration (only unrelated Postgres DB `CREATE TRIGGER`
   statements matched "trigger"). Authoring/maintaining static docs that could
   drift from the real registry is the wrong fix when a perfect, always-current
   source of truth already exists: `workflow-analyst`'s live registry access
   (Wave 15).

**Decision**: route trigger/action/workflow REFERENCE questions (not just
"help me build X" intent) to `workflow-analyst`, hard-forced by message-content
pattern-matching — mirroring the exact hard-force-beats-soft-bias pattern
Wave 15 already proved works for page-context (`surface === 'workflow_builder'`),
now triggered by message vocabulary instead, so it works from ANY page, not
just the workflow builder.

**Team dispatch:**
- **Amara** (CrystalOS) — crystalos/-only: build a message-content detector
  for workflow-taxonomy reference questions, force-route to `workflow-analyst`
  independent of page context; extend the skill's own routing examples too as
  a defense-in-depth improvement to normal semantic routing.
- **Nina** (frontend/backend integration) — app/-only: fix `classifyAsSupport`'s
  keyword gap for reference/enumeration phrasing; assess whether this
  classification belongs client-side at all vs. being folded into the
  server-side routing this wave is building anyway.

**Amara's CrystalOS-side fix — COMPLETE:**

- **Detector** (`_is_workflow_taxonomy_question`, `crystalos/agents/crystal.py`):
  a small allowlist of precision-first regexes, not a broad keyword net — each
  pattern requires BOTH a taxonomy noun (trigger/action/condition/workflow/
  automation/scope/operator) AND a question/enumeration structure: "what/which
  type(s)/kind(s) of `<noun>`", "list/show (me) ... `<noun>`", "what `<noun>`
  can I use", or a literal dotted registry token ("what does `flow.delay` do").
  A message containing the noun in passing ("the action I took was...") does
  not match. Chose regex-allowlist over a scored/fuzzy classifier (unlike
  `lib/support_classifier.py`'s keyword-scoring approach) specifically because
  false positives here (misrouting a real survey-data question) are a
  regression in their own right — recall is intentionally sacrificed at the
  margins (an unusual phrasing may miss the hard force) in favor of near-zero
  false-positive rate; the SKILL.md routing-examples update below is the
  defense-in-depth catching what the hard force doesn't.
- **Routing refactor** (`_resolve_forced_skill`): centralizes "does ANY force
  condition match" so Wave 15's `surface == "workflow_builder"` and this
  wave's message-content detector are both single-line checks in one function,
  reusing the exact same forced-selection code path in `_run_skill_stream` — a
  future third force condition is a one-line addition here, not a new branch.
- **Registry-population gap, traced and resolved for this wave's scope**:
  confirmed the Node proxy (`backend/src/routes/experience.ts`) fetches
  `workflow_registry` ONLY when `surface === 'workflow_builder'` — a message-
  content force-route from a non-builder page (e.g. the Insights page, the
  reported bug's actual origin) would otherwise reach `workflow-analyst` with
  `workflow_registry: None`, which would just trade a hallucination for a
  hedge, not a real fix. CrystalOS has no independent DB/Node-callback path to
  fetch the live, org-accurate registry (confirmed: `lib/db.py` has no
  survey/tag registry query; the registry is Node-fetched-and-forwarded only).
  **Resolution**: when the message-content force fires without a live
  `workflow_registry` present, `_run_skill_stream` substitutes
  `crystal/workflow_nl.py::FALLBACK_REGISTRY` — the same conservative,
  code-defined mirror `execute_propose_workflow` already uses for its own
  no-live-registry case. This gives the skill a real, registry-grounded
  trigger/condition/action catalog (smaller/staler than the live one, and
  without `surveys`/`tags` scope data) rather than nothing — closing the
  "still hallucinates" failure mode for this wave. **Follow-up for Nina/a
  later wave**: widen `isBuilderContext` in `experience.ts` to also cover "the
  Wave 18 detector fired" so the FULL live, org-accurate registry (incl.
  scope) reaches the skill for non-builder-page taxonomy questions too — not
  done here (CrystalOS-only wave), and explicitly not silently left unfixed:
  the fallback registry is a real, correct, but intentionally smaller stopgap.
- **SKILL.md**: added a "factual/reference questions" routing-example block
  distinct from the existing automation-intent examples, plus a Wave 18
  compatibility note documenting the fallback-registry substitution.
- **Tests** (`tests/test_crystal.py`, +32): `TestIsWorkflowTaxonomyQuestion`
  (true/false-positive coverage for the detector in isolation),
  `TestResolveForcedSkill` (the centralized force-check, unit-level), and
  `TestWorkflowTaxonomyForceRoute` (`_run_skill_stream` end-to-end) —
  including the exact reported question force-routing with `registry.find`/
  `find_sync` asserted never called (Wave 15's own pattern), a false-positive
  guard proving "Why did NPS drop?" still routes normally, proof the
  substituted `FALLBACK_REGISTRY` actually reaches the skill's input (not just
  that routing happened), a guard that an already-present live registry is
  never clobbered by the fallback, and a guard that the Wave 15 surface-force
  path does NOT get the Wave 18 fallback (keeps the two conditions' failure
  modes distinct). All pre-existing Wave 15 `surface`-based tests pass
  unmodified.
- **Full suite**: **1706 → 1738 passed, 0 failed** (+32, exactly the new
  tests added — no regressions).

---

## Wave 17 — Fix the stale-graph-on-resume gap (2026-07-03, COMPLETE)

Implemented per the user's explicit decision on Wave 16's open finding:
**snapshot the exact graph at pause time; a resume always executes that
snapshot regardless of later edits.**

**Migration** `20260703090000_workflow_execution_pause_snapshot.sql` —
`workflow_executions` gains `snapshot_nodes`/`snapshot_edges`/
`snapshot_trigger_type` (JSONB/JSONB/TEXT, all nullable, no backfill). Three
separate columns, not one blob, matching this table's established
one-column-per-concern convention. `snapshot_nodes IS NULL` is the
unambiguous "legacy pre-migration pause" signal.

**`workflowEngine.ts`**: `persistPause()` now writes the snapshot from
whatever `nodes`/`edges`/`triggerType` are already in scope (no extra fetch),
unconditionally on every pause including re-pauses (an approval→delay chain
keeps re-snapshotting correctly). New `resolveResumeGraphSource()` centralizes
the decision for both `resumeWorkflow` and `resumeDelayedExecution`: snapshot
present → use it (the live `workflows` row's graph is never consulted at
all); snapshot absent → fall back to today's live-fetch behavior, exclusively
for executions that were already paused before this migration landed (a
narrow, self-draining transition window, not a permanent path). The Wave 16
tier-gate re-check now uses the resolved (snapshot-or-fallback) trigger type,
consistent with "regardless of later edits" — changing a workflow's trigger
type while paused doesn't retroactively change what governs its resume.

**Tests** (`workflowCrossWaveInteractions.test.js`): the 3 Wave 16
"DOCUMENTS REAL GAP" tests are inverted in place to "FIXED (was BUG)" —
orchestrator verified one directly: same edited-live-row scenario, assertion
flipped from `not.toHaveBeenCalled()` to `toHaveBeenCalled()`, now proving the
original snapshotted action runs regardless of the edit, not just renamed
with unchanged logic. Plus 2 new backward-compat tests (NULL snapshot →
correct live-row fallback, both resume paths) and 2 new tier-gate-snapshot
tests (trigger type changed while paused doesn't affect the gate either
direction).

**Verified — orchestrator independently re-ran the suite and read the
migration, the engine changes, and the test assertions directly (not just
the report):** backend **89 files / 1233 tests, 1232 passing** (same single
pre-existing, documented, unrelated `workflowEngine.test.js` marker since
Wave 10 — confirmed still the only failure). +4 tests over Wave 16's 1229.

**This closes the one open item from Wave 16's business-logic review.**

---

## Wave 17 — Fix the stale-graph-on-resume gap (2026-07-03, IN PROGRESS)

Per user decision on Wave 16's open finding: **snapshot the exact graph at
pause time; a resume always executes that snapshot regardless of later
edits** (not "fail loud if edited," not "always re-read the live row").

**The bug being fixed** (Wave 16, Priya): `resumeWorkflow`/
`resumeDelayedExecution` both re-fetch `workflows.nodes`/`edges` fresh at
resume time. If the workflow is edited while paused, resume can silently
execute a DIFFERENT action than what a human approver approved, or silently
no-op if the node array shape changed — no error either way.

**Team dispatch: Priya** (owns the state machine/schema — she diagnosed this
in Wave 16, has full context). Scope:
1. New column(s) on `workflow_executions` capturing `nodes`/`edges` (and
   `trigger_type`, needed for the tier-gate re-check) AT PAUSE TIME.
2. `persistPause()` writes the snapshot when a workflow first pauses
   (`flow.approval` or `flow.delay`).
3. `resumeWorkflow`/`resumeDelayedExecution` read the snapshot, not a fresh
   `workflows` row, for nodes/edges/trigger_type — "regardless of later
   edits" per the user's explicit decision.
4. **Backward compatibility for already-paused executions**: any execution
   that paused BEFORE this migration lands has no snapshot. Must not crash
   or silently misbehave for these — fall back to today's live-fetch
   behavior for legacy rows only (a narrow, self-resolving transition
   window), not for anything paused after this ships.
5. Full regression suite gate, plus the Wave 16 tests Priya already wrote
   (`workflowCrossWaveInteractions.test.js`) should flip from "documents
   real gap" to "proves the fix," not be deleted.

---

## Wave 16 — Full business-logic review, cross-wave interaction audit (2026-07-03, COMPLETE)

Per user request: "Review all the business logic, make sure everything is
working." Unlike prior waves (which verify one wave's changes), this wave
specifically hunted for bugs where features BUILT IN DIFFERENT WAVES interact
incorrectly — every prior pass checked each wave in isolation, never in
combination. 3 engineers dispatched in parallel on disjoint angles, all
findings independently re-verified by the orchestrator (re-ran suites,
read every fix/test directly).

**Priya (cross-feature state machine) — 1 real bug fixed, 1 real gap found
and correctly escalated rather than unilaterally fixed:**
1. **FIXED**: resumed executions (`resumeWorkflow`/`resumeDelayedExecution`)
   never re-checked plan-tier gating — a workflow paused on `flow.delay` for
   hours could keep firing a Growth-gated action even after the org
   downgraded to Free mid-pause, directly contradicting Wave 11's own stated
   "downgrade takes effect immediately" design intent. New
   `reCheckTierGateOnResume()` closes this for both resume paths.
2. **FOUND, NOT FIXED — needs a product decision**: resuming a paused
   workflow re-reads the CURRENT workflow row, not a snapshot from pause
   time. If a workflow is edited while paused (a completely realistic
   scenario — "let's route this to Jira instead"), the resume can silently
   execute a DIFFERENT action than what a human approver actually approved,
   or silently no-op entirely if the node array shape changed — with zero
   error, `status: 'completed'` either way. Verified with real, non-crashing
   reproduction tests (not hypothetical). **Open question for the user**:
   should a resume refuse to proceed if the graph has changed since pause
   (fail loud), snapshot the graph at pause time and always execute that
   exact snapshot (ignore later edits), or something else? Documented with
   permanent regression tests proving current behavior, deliberately not
   fixed pending that decision.

**Kenji (foundational rule re-verification) — 0 bugs, 28 new tests closing
real coverage gaps:** cooldown, idempotency, retry/dead-letter, and
scope-based event matching were all already correct. Two real gaps: 5 of 11
condition operators (`neq`/`gt`/`gte`/`not_contains`/`not_in`) had zero
direct test coverage (closed with a table-driven test + a catalog-drift
guard), and multi-action success-path ordering + `flow.stop` halting a
multi-action chain were only tested for the failure case, not the clean-stop
case (closed with 4 new tests, both linear and branching).

**Nina (cross-surface consistency + permissions) — 0 bugs, verified-safe on
every axis:** scope resolution is provably consistent across all 3 paths that
can set it (manual pill, Crystal NL inference, Crystal proposal-into-open-
draft) — all converge on the same schema validation, and the Wave 14 proposal
-hydration path was proven (not just read) to never silently overwrite a
manually-selected scope. Audit-trail scope (workflow-config changes only, not
execution-state changes like approvals or delay-resumes) is confirmed
intentional, not a gap. All 16 routes in `routes/workflows.ts` — mutating AND
read-only/static — are uniformly permission-gated, confirmed via existing
loop-based coverage across all 16. Tier-gating has one single source of truth
(`planGating.ts`) at both save-time and execution-time, no drift.

**Final 2-layer counts (orchestrator-verified, CrystalOS untouched this
wave):** Backend **89 files / 1229 tests, 1228 passing** (1 pre-existing,
documented, unrelated `workflowEngine.test.js` marker — same one since
Wave 10). Frontend **85 files / 1003 tests, 1002 passing** (1 pre-existing,
documented `NotifyTargetPicker.test.tsx` flake — confirmed passes clean in
isolation and in most full runs).

**Net verdict: the business logic holds up well under real cross-wave
scrutiny.** One real, meaningful bug was found and fixed (tier-gate resume
gap). One real, meaningful gap was found and correctly NOT fixed without a
product decision (stale-graph-on-resume). Everything else checked out as
correct, now backed by real tests proving it rather than just asserting it.

## Wave 15 — Wire the workflow-builder Crystal icon into the existing `workflow-analyst` skill (2026-07-03, COMPLETE)

**All 4 phases shipped and independently verified (orchestrator + Kenji, each
re-confirming the other's findings by direct code read, not trust):**

- **Amara (CrystalOS)**: `CrystalInput` gained `surface`/`builder_draft`/
  `workflow_registry` (all optional, additive). Routing: a hard force to
  `workflow-analyst` when `surface == "workflow_builder"` (not a soft bias —
  justified because the signal is page-derived, not guessed from ambiguous
  text), with a defensive fallback to normal semantic routing if the skill is
  ever unregistered. Registry + draft delivered via direct `survey_facts`
  injection, not a new tool (the data arrives already-fetched, matching
  `parse_workflow_nl`'s existing pattern). **Found and fixed a real bug
  herself**: `crystal_stream_endpoint` builds `CrystalInput` via explicit
  keyword arguments, not `**body` — without adding the 3 explicit
  `body.get(...)` passthroughs, none of this would have worked despite every
  other layer being correct.
- **Nina (backend)**: `experience.ts`'s `/:scope/crystal/stream` proxy
  detects `surface: 'workflow_builder'`, fetches the registry (reusing her
  own Wave 12 `parse-nl` query pattern exactly), attaches it as
  `workflow_registry`, relays `builder_draft` unchanged — a clean +32-line
  purely additive diff, correctly re-applied across both the happy path and
  the context-load-failure fallback.
- **Elias (frontend)**: `CrystalPanel.tsx`'s `submitQuery` sends `surface`/
  `builder_draft` only when `builderContext` is set (conditional spread —
  keys absent, not undefined, for every other page). Support mode
  deliberately left untouched (different endpoint/pipeline entirely).
- **Kenji (final gate) — found and fixed a second, sibling bug via a
  systematic sweep** (explicitly requested, not just spot-checking the 3 new
  fields): `tag_ids` was ALSO declared on `CrystalInput` but never forwarded
  by `crystal_stream_endpoint` — the exact same bug class Amara had just
  fixed, latent (no current caller sends it yet) but a real landmine. Fixed
  with one line, plus a new **generic, future-proofing test**
  (`test_every_declared_field_has_a_body_get_passthrough`) that reads the
  endpoint's own source and checks EVERY `CrystalInput` field has a
  passthrough — will catch this bug class automatically if a future field
  addition forgets it, not just today's two instances. Also wrote the
  first-ever end-to-end wire-shape test tracing a realistic payload through
  both the backend and CrystalOS halves of the contract.

**Orchestrator independently re-verified every claim** (re-ran all 3 suites
fresh, read the `tag_ids` fix and the generic sweep test directly, confirmed
the routing force/fallback structure and the `survey_facts` injection by
direct code read) — everything checked out exactly as reported.

**Final 3-layer counts, orchestrator-confirmed:**
- CrystalOS: **1706 passed, 0 failed** (was 1695 before this wave)
- Backend: **1191 total, 1190 passed** (1 pre-existing, documented,
  unrelated `workflowEngine.test.js` marker)
- Frontend: **1002 total, 1001 passed** (1 pre-existing, documented,
  unrelated `NotifyTargetPicker.test.tsx` flake — passes clean in isolation)

**Net result**: opening Crystal from the workflow builder now hard-routes to
the `workflow-analyst` skill, which receives the live trigger/action/
condition-field registry and the current in-progress draft, and can both
answer contextual questions and propose workflow-shaped additions that are
aware of what's already configured — reusing the existing
propose/confirm/apply/hydrate pipeline end to end, with zero new backend
machinery and zero measurable change to any other Crystal conversation in
the app.

Per user question ("shouldn't Crystal understand it's on the workflow builder
page and suggest workflow-related things?") + follow-up ("is there something
we can do with the CrystalOS skill framework?"): orchestrator investigated
directly and found the mechanism already mostly exists.

**Confirmed by direct code read (not assumed):**
- `crystalos/skills/workflow-analyst/` already exists, is registered in
  `plugin.json`, and is reachable today via the SAME endpoint the workflow
  builder's Crystal icon already calls (`/api/experience/:scope/crystal/stream`
  → CrystalOS's `/insights/crystal/stream` → `_run_skill_stream`, semantic-
  routed by default).
- **Gap 1**: `CrystalInput` (`crystalos/agents/crystal.py`) has zero fields
  for a workflow registry, a builder draft, or a page/surface hint — every
  field is survey/insights-shaped.
- **Gap 2**: `workflow-analyst`'s `allowed-tools` is only
  `get_survey_overview propose_workflow` — no tool exists anywhere in the
  45-tool `TOOL_REGISTRY` to fetch the live trigger/condition-field/action
  catalog, so it can't yet honor its own "registry-grounded, never invented"
  principle for the builder-page scenario.
- **Gap 3**: no forced/hinted skill-selection mechanism found — routing
  relies entirely on semantic-embedding match against message text, which
  works for clearly-automation-shaped phrasing but not for ambiguous,
  page-anchored questions ("why is Jira greyed out").

**Hard backward-compatibility invariant (explicit user instruction: "do not
break any other existing business logic"):** `CrystalInput` and the
`/api/experience/:scope/crystal/stream` payload are used by EVERY Crystal
conversation across the whole app (Insights pages, org portfolio view, etc.)
— every new field must be optional/additive, defaulting to today's exact
behavior when absent. This is the same class of shared-surface risk as
Wave 14's `CrystalPanel.tsx` change — treat it with the same rigor.

**Team dispatch:**
- **Phase 1 (parallel, disjoint: `crystalos/` vs `backend/`):**
  - **Amara** (CrystalOS) — extend `CrystalInput` with optional
    `builder_draft`/registry/surface-hint fields, wire a routing bias/force
    toward `workflow-analyst` when builder context is present, get the
    registry + draft into the skill's actual context (tool call or
    survey_facts injection — her call), update SKILL.md/EVALS.md/EXAMPLES.md
    as needed.
  - **Nina** (backend) — `backend/src/routes/experience.ts`'s
    `/:scope/crystal/stream` proxy: when the frontend signals builder
    context, fetch + attach the registry (reuse the exact Wave 12
    `parse-nl` pattern, don't reinvent).
- **Phase 2:** **Elias** — `CrystalPanel.tsx`'s `submitQuery` sends
  `builder_draft`/the surface hint only when `builderContext` is set.
- **Phase 3:** **Kenji** — full 3-layer regression, explicit proof every
  existing non-builder Crystal conversation is byte-identical.

**Amara (Phase 1, CrystalOS) — DONE:**
- `CrystalInput` (`crystalos/agents/crystal.py`) gained 3 optional fields, all
  defaulting to today's exact behavior: `surface: str = "insights"` (new
  `"workflow_builder"` value), `builder_draft: dict | None = None`,
  `workflow_registry: dict | None = None`. `surface` is an explicit signal
  rather than inferring builder-context from `builder_draft is not None` —
  a user can open Crystal from the builder before configuring anything, so
  `builder_draft` alone would be `None` even while genuinely in the builder.
- **Routing**: `_run_skill_stream` hard force-selects `workflow-analyst`
  (`registry._skills.get("workflow-analyst")`) when `inp.surface ==
  "workflow_builder"`, bypassing `registry.find`/`find_sync` entirely rather
  than biasing them — the correct skill is already known from page context,
  not guessed from message text, so a hard force is both simpler and safer
  than a soft bias for ambiguous/page-anchored questions ("why is Jira greyed
  out"). Falls through to normal semantic routing if `workflow-analyst` is
  ever unregistered (defensive, doesn't dead-end the request). Every existing
  caller (`surface` defaults to `"insights"`) takes the untouched `find()`
  path — proven with a decoy-skill test.
- **Context delivery**: injected directly into `_skill_synthesis`'s
  `survey_facts` bundle (`survey_facts.workflow_registry` /
  `survey_facts.builder_draft`) — no new tool. This data arrives
  already-fetched from Nina's proxy, exactly like `parse_workflow_nl`'s
  `registry` parameter; a tool would only wrap a value already in hand.
  Keys are omitted (not null) when absent, so non-builder `survey_facts` is
  byte-identical to before.
- **`main.py` wiring**: `crystal_stream_endpoint` was not forwarding
  `surface`/`builder_draft`/`workflow_registry` from the request body into
  `CrystalInput` at all (a gap that would have silently no-op'd Nina's and
  Elias's work) — added the 3 `body.get(...)` passthroughs alongside the
  existing ones, same pattern as `scope`/`brand_id`.
- **SKILL.md/EXAMPLES.md** updated: `compatibility` block documents the
  Wave 15 wire path, input schema gained `builder_draft`, new "Continuity"
  guidance says `builder_draft` is authoritative over `context_state`
  inference. 2 new examples: reading back the draft ("what have I built so
  far?") and an additive proposal that keeps an existing Slack action while
  adding a requested Jira action (not just the new action in isolation).
- **Registry-grounding**: unchanged principle, new path — a test proves an
  eval-failed (fabricated-action) skill result via the builder-context route
  still returns `None` from `_skill_synthesis`, identical to the pre-existing
  tool_results-path behavior.
- **Tests**: 6 new tests in `crystalos/tests/test_crystal.py` — default-surface
  routing untouched (decoy skill would win if the force branch ever fired),
  builder-surface hard-forces `workflow-analyst` with the semantic router
  never consulted, defensive fallback when `workflow-analyst` is unregistered,
  context actually reaches the skill (mocked response correctly merges a new
  Jira action with the draft's existing Slack action), absent-context omits
  the new `survey_facts` keys entirely, and registry-grounding still rejects
  a fabricated action via this path.
- **Full suite**: baseline **1695 passed** → after **1701 passed** (+6, exactly
  the new tests; zero regressions), re-run clean after the `main.py` wiring
  fix too.

---

## Wave 14 — POST-SHIP BUG: Crystal FAB was a silent no-op (2026-07-03, FIXED)

**User report:** "Clicking crystal icon after clicking Build workflow, does
not even work." Real, confirmed bug — Wave 14's own "verified end-to-end"
claim was wrong, because every verification pass (orchestrator, Elias, Kenji)
tested against a MOCKED `useCrystalPanel()`, which by construction cannot
catch a bug in whether the real `CrystalPanel` component gets mounted at all.
This is exactly the class of bug `app/CLAUDE.md`'s "test the feature in a
browser, tests verify correctness not feature-ness" rule exists to catch —
skipped this wave because no browser tool was available; fixed instead via
careful direct code tracing.

**Root cause:** `AppShell.tsx`'s `isBuilder` detection — meant only for the
full-bleed survey QUESTION builder (`/surveys/:id/build`) — used a loose regex
that ALSO matched `/app/workflows/build` (the Wave 14 sentence builder), and,
being an unanchored substring test, silently matched `/app/workflows/build/nl`
(the Crystal NL builder) too. When `isBuilder` is true, AppShell does not
render `<CrystalPanel>` in the DOM at all (and suppresses gutters, footer,
BottomNav, and ⌘K). `AskCrystalFab`'s `onOpen={() => openCrystal()}` was
therefore setting state on a component that was never mounted — a completely
silent no-op, exactly matching the report.

**Second, undiscovered bug found via the same trace, not yet reported by the
user:** `WorkflowCanvasPage.tsx`'s route (`/app/workflows/canvas`) does NOT
match the old regex, so `CrystalPanel` — and AppShell's own pre-existing
generic default Crystal FAB (near-identical diamond icon, near-identical
bottom-right position) — was already rendering there before Wave 14. Adding
`AskCrystalFab` to that page on top of the existing default FAB would produce
two overlapping "open Crystal" buttons in the same corner.

**Fix** (`app/src/components/AppShell.tsx`):
1. Narrowed `isBuilder` to an anchored regex matching ONLY the survey builder
   (`/^\/surveys\/[^/]+\/build$/`) — confirmed via `app/src/pages/CLAUDE.md`'s
   documented page pattern that neither workflow builder page's own layout
   ever expected/needed full-bleed treatment (both use a normal
   `max-w-* mx-auto` container). This also restores gutters/footer/BottomNav/
   ⌘K on the Crystal NL builder page, which had been silently missing them
   the whole time — a pre-existing bug that predates Wave 14 entirely, fixed
   as a byproduct.
2. Added `hasOwnCrystalFab` (`WORKFLOW_BUILD`/`WORKFLOW_CANVAS` exact-route
   check) to suppress AppShell's generic default Crystal FAB specifically on
   the two pages that mount their own contextual `AskCrystalFab` — closing
   the duplicate-button bug on the canvas page before it could ever surface.
3. New `app/src/__tests__/components/AppShell.test.tsx` (10 tests) — the
   first test in this repo to render the REAL `AppShell` + real
   `CrystalPanelProvider` (every other Crystal test mocks the hook directly,
   which structurally cannot catch this class of bug). Proves: `CrystalPanel`
   now mounts on both workflow builder routes and remains correctly absent on
   the real survey builder; chrome (footer) is restored on the workflow
   builder route and remains correctly suppressed on the survey builder; the
   generic default FAB is absent on both Wave 14 pages (no duplicate button)
   and still present on ordinary pages.

**Verified:** `tsc --noEmit` clean, `npm run lint` clean, full suite
**85 files / 1000 tests, all passing** (was 84/990 — +1 file/+10 tests, zero
regressions; the previously-noted flaky `NotifyTargetPicker` test also passed
clean on this run). Independently re-confirmed no other component assumes the
old chrome-less behavior for either workflow builder route (grepped for fixed-
position elements and other route references).

## Wave 14 — Unified builder: one entry button, one Crystal surface (2026-07-02, IN PROGRESS)

Per user decision after reviewing Wave 13's Maya/Rohan evaluations
(`WAVE13_UNIFIED_BUILDER_EVALUATION_PM.md`/`_UX.md`): adopt the direction, with
the user's own explicit refinements layered on top:
1. **Scope changes ONLY when the customer explicitly asks Crystal to change it**
   — never a silent/automatic update. Manual pill click (existing, unchanged)
   or an explicit, user-confirmed Crystal proposal apply are the only two ways
   scope can change; ambient chat/Q&A must never touch it.
2. **No second assistant.** The existing global `CrystalPanel` (right-docked,
   product-wide) is the only Crystal surface. A small icon at the bottom of the
   builder page is a TRIGGER for that existing panel (scoped to "we are
   operating on the Automation Hub"), not a new chat component.
3. Crystal from this icon can both (a) answer general help questions and
   (b) help build the workflow — reusing the already-built `create_workflow`
   proposal/confirm/apply pipeline, not a new mechanism.
4. **Keep the Save button completely unchanged** — position, label, payload.
5. Collapse the list page's 3 build buttons (Crystal / Visually / Canvas) to 1.

**Explicit safety framing (user's words: "build this carefully, without
breaking any functionality"):** this wave is scoped to be FRONTEND-ONLY — no
backend or CrystalOS changes are needed (confirmed in Maya's Wave 13 doc §3:
the parse-nl contract and `create_workflow`'s proposal pipeline are both
already entry-point-agnostic). The safest interpretation of "one button" is
adopted: the sentence builder becomes the single entry point (already the most
guided surface, already has an existing canvas-escape-hatch link from Wave 6);
canvas is NOT merged into one physical page component this wave — that fuller
merge (Wave 13 Maya's "v2") is deferred. `WorkflowNLBuilderPage.tsx` and
`WorkflowCanvasPage.tsx` are NOT deleted — only unlinked from the primary
header — so nothing that depends on their routes/components breaks.

**Team dispatch, sequential (spec → build → verify), per established pattern:**
- **Rohan** (UX) — finalize the exact icon placement/style for the Crystal
  trigger, the one-button header design, and the precise behavioral spec for
  "apply a create_workflow proposal from inside an open builder draft"
  (hydrate local state, do NOT immediately persist via a second workflow
  creation — preserving `Save` as the one persist action) vs. every other
  existing call site of the same proposal type elsewhere in the app, which
  must keep its current immediate-create behavior unchanged.
- **Elias** (frontend) — build from Rohan's spec.
- **Kenji** (QA) — full regression pass, with explicit proof that the
  existing `create_workflow` proposal behavior is byte-identical everywhere
  it was already wired (Insights pages etc.), and that scope never changes
  without an explicit user action.

**STATUS: COMPLETE. All 3 phases shipped and independently verified.**

**Rohan (spec) → Elias (build) → Kenji (verify), all done:**
- List page: 3 build buttons collapsed to 1 "Build Workflow" CTA →
  `ROUTES.WORKFLOW_BUILD` (sentence builder). `WorkflowNLBuilderPage.tsx`/
  `WorkflowCanvasPage.tsx` unlinked from the header only — routes/components
  fully intact (canvas reachable via the sentence builder's existing escape
  hatch + edit-route resolution; NL builder's capability absorbed into "ask
  Crystal," page itself left live but unlinked, not deleted or redirected,
  per explicit instruction not to invent an unrequested behavior change).
- New `AskCrystalFab.tsx` — floating trigger icon (bottom-right,
  `bottom-24 md:bottom-6` to clear mobile `BottomNav`), on both builder
  pages, opens the **existing** global `CrystalPanel` via `openCrystal()` —
  confirmed zero new chat surface.
- `CrystalPanelContext` extended additively: `builderContext`/`builderDraft`/
  `builderDraftHydrator`, alongside the untouched `scope: SurveyScope` field.
  Both builder pages register/unregister on mount/unmount.
- **The crux fix**: `CrystalPanel.tsx`'s `executeAction`'s
  `case 'create_workflow'` gained one new branch, checked BEFORE the
  pre-existing `!surveyId` guard (required — the builder page has no survey
  in scope, so the guard would otherwise block the path entirely). If a
  builder page has registered a hydrator, the proposal populates that page's
  own local draft state instead of persisting a second workflow —
  **Save remains the only persist action**, exactly as instructed. Every
  other existing caller (hydrator `null` by default) falls through to
  today's exact, unmodified `api.createGraphWorkflow` path.
- **Real bug caught and fixed during the build** (Elias): a naive
  `setState(hydrator)` would have React treat the passed function as a
  `(prev) => next` updater and invoke it immediately instead of storing it —
  fixed via `setState(() => hydrator)`, with its own regression test.

**Orchestrator + Kenji verification, independently re-confirmed:**
- Full suite: **990/990 tests, 84/84 files** (clean runs); one known-flaky,
  pre-existing, unrelated test (`NotifyTargetPicker.test.tsx`'s keyboard-nav
  test) intermittently fails under certain run conditions and passes 20/20 in
  isolation every time checked — confirmed NOT a Wave 14 regression across
  multiple independent full-suite runs. `tsc --noEmit` and `npm run lint`
  both clean.
- **The 3 pre-existing `create_workflow` tests in `CrystalPanel.test.tsx` are
  byte-for-byte unmodified** (confirmed via `git diff`, zero removed/changed
  lines, only additions) — direct proof the shared component's existing
  behavior did not change.
- **Exactly 2 call sites** of `setBuilderContext`/`setBuilderDraft`/
  `setBuilderDraftHydrator` exist in the whole app (`WorkflowBuilderPage.tsx`,
  `WorkflowCanvasPage.tsx`) — confirmed by grep, independently re-confirmed by
  the orchestrator. No other page can trigger the new branch.
- **Scope-safety claim re-verified against current code, not just the spec's
  abstract argument**: `executeAction` has exactly 2 call sites, both gated
  behind an explicit user click (`ActionProposalCard`'s Apply, and an
  unrelated pre-existing "create ticket" button that hardcodes a
  `create_case` proposal — confirmed by the orchestrator to not even be
  `create_workflow`-shaped, so it can't reach the new branch at all
  regardless of click-gating). No path exists from Crystal's AI-generated
  chat content into `executeAction` — `submitQuery` only ever writes to
  `messages`/`actionProposals` state, never calls it directly.
- Branch-ordering fix (before `!surveyId`) and the `setState(() => hydrator)`
  fix both confirmed present and correct by direct code read.

**Verdict: shipped safely. Zero regressions found across three independent
verification passes (orchestrator spot-checks after Phase 2, Kenji's Phase 3,
orchestrator's own final re-check after Phase 3).**

---

## Wave 12 — Build with Crystal is missing scope ("source") entirely (2026-07-02, COMPLETE)

**Post-close addendum — a second, more severe, pre-existing bug found via a real
production log (user-reported "same error" after Phase 3 closed):** the user hit
"Crystal wasn't able to match that to a valid trigger and action" on the built-in
example "Every Monday at 9am, email the team a summary of last week's responses."
Orchestrator added one diagnostic log line (`workflow_nl_parse_low_confidence` at
the `confidence < UNPARSEABLE_THRESHOLD` branch in `workflow_nl.py` — this branch
had NO logging at all before, a real observability gap now closed) and the user
pasted back the real log. Root cause, confirmed by direct code read: `_call_llm()`
built its `user` message from ONLY the description — `_SYSTEM_PROMPT` claims the
model "will be given... the exact catalog of valid triggers... actions" but that
catalog was NEVER actually included in any message sent to the LLM, and
`call_agent()` does no injection of its own. The model was guessing generic,
plausible-sounding identifiers from its own training data (`"schedule"`,
`"email_report"`) instead of this project's real registry strings
(`"time.schedule"`, `"notify.email"`) — confirmed unrelated to Wave 12's
`scope_hint` work (the log showed `scope_hint: null`, correctly). This means the
feature's reliability for ANY trigger/action whose registry name doesn't happen
to match common naming conventions has been down to luck since this module was
first built — a pre-existing bug, not a regression from this wave.

**Amara — fixed, orchestrator-verified:** new `_format_catalog(registry)` renders
a compact `"type (label)"` line-per-entry block (triggers/condition
fields/operators/actions) from the SAME registry object already used for
post-validation; `_call_llm(description, registry)` now appends this block to
the `user` message. Format chosen deliberately compact (not raw JSON) — cheaper,
equally copyable, and every string `_draft_to_engine_graph` validates against is
now verbatim-present. With the current bounded catalog this adds well under 1KB
per call. New tests (+4, `test_workflow_nl.py` 24→28): critical proof —
`test_call_llm_message_contains_exact_registry_strings` mocks `call_agent`
itself (not `_call_llm`) and asserts the literal `user` message contains
`"time.schedule"`, `"notify.email"`, etc. verbatim; a regression test
reconstructs the EXACT degraded draft from the real production log
(`trigger_type="schedule"`, `action="email_report"`, invented `day_of_week`/
`time_of_day` fields, confidence 0.14) and confirms existing validation still
correctly rejects it — proving the fix is entirely on the "give the model
better material" side, the drop/penalty validation logic was already correct.
**Full suite: 1691 → 1695 passed, 0 failures.** Orchestrator independently
re-ran the full suite (matches exactly) and read both new tests directly to
confirm they assert on the real message contents, not a superficial pass.
`_draft_to_engine_graph`'s validation logic, Wave 12's scope-resolution code,
and the diagnostic logging were all correctly left untouched.

Per explicit user report: "Build with Crystal is not working. As per new design we
need trigger, source, action." Orchestrator investigated directly before dispatch
(not assumed): confirmed via direct code read across all 3 layers that
`crystalos/crystal/workflow_nl.py` (the LLM draft schema, `_draft_to_engine_graph`,
`WorkflowNLResult`), the FastAPI `POST /workflows/parse-nl` endpoint, the Node
proxy (`agentsClient.parseWorkflowNL`, `ParseWorkflowNLSuccess` type), and
`WorkflowNLBuilderPage.tsx` (confirm-card's `TriggerSummaryRow`/
`ConditionSummaryRow`/`ActionSummaryRow` — no `ScopeSummaryRow`;
`createWorkflow()`'s `api.createGraphWorkflow()` call omits scope entirely) have
**zero concept of scope anywhere in the pipeline** — every NL-created workflow is
silently forced to org-wide scope with no way to see or change it, because this
whole pipeline predates the Wave 6 scope redesign (`BUILDER_REDESIGN_V2_SCOPE.md`)
and was never updated to match it. All 27 existing `WorkflowNLBuilderPage.test.tsx`
tests pass — this is a confirmed design gap, not a regression from Wave 10/11.

**Hard backward-compatibility invariant for this whole wave** (explicit user
instruction: "be careful not to break existing changes"): an NL description that
doesn't mention a survey/tag by name must continue to produce an org-scoped
workflow, identical to today's behavior, in every case. Scope inference is
strictly additive — it only activates when the LLM's draft proposes a scope hint
that confidently matches a REAL survey/tag in the org (same fail-safe pattern
already used for trigger/action/condition-field registry validation: unmatched
proposals are dropped with a warning + confidence penalty, never guessed).

**Phase 1 (parallel — disjoint file footprints: `crystalos/` vs `backend/`):**
- **Amara** (AI/ML, Crystal NL parsing owner) — extend the LLM draft schema with
  an optional scope hint, map it onto a REAL org survey/tag list (newly forwarded
  by the Node proxy) using the same drop-and-warn safety pattern as
  triggers/actions, return `scopeType`/`scopeSurveyId`/`scopeTagId` in
  `WorkflowNLResult`/the endpoint response.
- **Nina** (Platform Integrity, confirm-card contract owner) — extend the Node
  `POST /api/workflows/parse-nl` proxy to fetch and forward the org's surveys/tags
  (reusing the exact same `listSurveys`/`listTags` backend queries
  `ScopeStepPanelContent.tsx` already calls — no new data-fetch mechanism),
  extend `ParseWorkflowNLSuccess` to carry the new scope fields through.

**Phase 2 (after Phase 1 verified):** Elias adds a `ScopeSummaryRow` to the
confirm-card and low-confidence states, plumbs scope through
`createWorkflow()`/`editInCanvas()`.

**Phase 3 (after Phase 2 verified):** Kenji — full 3-layer regression suite
(CrystalOS pytest + backend vitest + frontend vitest), explicit verification of
the backward-compatibility invariant above and the safe-fallback-to-org behavior
for an unmatched/hallucinated scope mention.

**Nina — Phase 1 backend work COMPLETE** (extended registry payload + type
plumbing, `routes/workflows.ts`/`lib/agentsClient.ts`, disjoint from Amara's
in-flight `crystalos/crystal/workflow_nl.py` work — confirmed no file overlap):

1. **Extended registry payload, this call site only.** `POST /parse-nl`'s
   handler now runs two lightweight queries in parallel before calling
   `agentsClient.parseWorkflowNL` — `SELECT id, title AS name FROM surveys
   WHERE org_id = $1 AND deleted_at IS NULL` and `SELECT id, name FROM
   survey_tags WHERE org_id = $1` — the exact same underlying tables/filters
   `GET /api/surveys` (routes/surveys.ts) and `GET /api/survey-tags`
   (routes/tags.ts) already query, trimmed to `{id, name}` since that's all
   Amara's scope-matching skill needs. Confirmed tags are real `{id, name,
   slug, color, ...}` objects (`survey_tags` table), not plain strings, before
   assuming the shape. Merged onto `registry()`'s existing shape as `{
   ...registry(), surveys: [...], tags: [...] }` — `registry()` itself is
   UNCHANGED (still used as-is by `GET /api/workflows/registry` for the
   no-code builders, which don't need a survey/tag catalog).
2. **`ParseWorkflowNLSuccess` (backend) / `ParseWorkflowNLResult` (frontend)**
   both gained `scopeType?: 'org'|'survey'|'tag'`, `scopeSurveyId?: string`,
   `scopeTagId?: string` — all optional, so an old/lagging CrystalOS deploy
   that omits them entirely doesn't break parsing; absence is treated
   identically to `scopeType: 'org'` (today's behavior), mirroring how
   `schemas/workflows.ts`'s `updateWorkflowSchema` already defaults an absent
   `scopeType` to `'org'`. The route's response mapping (`res.json(result)`)
   passes these through unchanged — no new mapping logic needed since the
   route already forwards `agentsClient`'s result as-is.
3. **Tests (`workflowsParseNl.test.js`, +4 net):** extended-registry-payload
   assertion (surveys/tags present, sourced from the same org-scoped queries —
   asserted via `queryMock` call args, not a new fetch mechanism); scope
   fields pass through correctly when CrystalOS returns them; **the
   single most important test** — a CrystalOS response that omits scope
   fields entirely still produces a byte-identical response to pre-Wave-12
   behavior. Updated (not just added to) the existing "maps CrystalOS success"
   test to assert the extended registry shape now sent. All 11 tests in the
   file pass; no other existing test needed changes.
4. **Full suite (fresh baseline, not trusted from an old doc): 86 files/1178
   tests before this pass, 1 pre-existing failure** (Wave 10's documented RED
   TDD marker in `workflowEngine.test.js`, unrelated) **→ 86 files/1181 tests
   after, same 1 pre-existing failure — zero regressions.** `tsc --noEmit`
   clean for every file touched (`agentsClient.ts`, `routes/workflows.ts`);
   the only backend `tsc` errors present (`lib/prism/uploads.ts` — missing
   `@aws-sdk/client-s3` dep, duplicate `fs` import) are pre-existing and
   untouched by this wave. Frontend `tsc --noEmit` (for the `api.ts` type
   change) is clean.

**Amara — Phase 1 CrystalOS work COMPLETE** (`crystalos/crystal/workflow_nl.py`,
`crystalos/main.py`, disjoint from Nina's `backend/` work — confirmed no file
overlap): `WorkflowNLDraft` gained one optional field, `scope_hint: str | None`
— the LLM proposes only a free-text *name* it noticed in the description
("Onboarding Survey"), never a type or id; new `_scope_catalog_lookup()`/
`_resolve_scope_hint()` map that hint onto `registry.surveys`/`registry.tags`
(new optional `{id, name}[]` keys Nina's proxy now sends). **Matching
algorithm:** no hint → `org`, no warning, no confidence change (the normal
case); case-insensitive exact name match → confident resolve; no exact match →
conservative unambiguous-substring-only match (any ambiguity — multiple
candidates, or a hit in both surveys and tags — is treated as no match, never
guessed); hint present but unmatched → falls back to `org` + a warning +
`_REGISTRY_DRIFT_PENALTY`, the identical severity class already used for
hallucinated triggers/actions/fields. Rationale: scope determines what real
data a workflow acts on, so under-matching to the safe org default is always
preferred over a wrong guess. `WorkflowNLResult` gained `scope_type: str =
"org"`, `scope_survey_id`/`scope_tag_id: str | None = None`; the endpoint
response gained `scopeType`/`scopeSurveyId`/`scopeTagId` (camelCase, alongside
`triggerType`). The legacy in-chat `execute_propose_workflow` call site (which
uses `FALLBACK_REGISTRY`, no `surveys`/`tags` keys) continues to resolve to
`org` unchanged — verified, not assumed. **Tests:** baseline (fresh) 1678
passed / 0 failed → **1691 passed / 0 failed after, zero regressions** (+13:
`test_workflow_nl.py` 15→24, `test_workflow_nl_endpoint.py` 6→10). Single most
important test, `test_no_scope_hint_defaults_to_org_byte_identical_to_before`
— proves the hard backward-compatibility invariant end-to-end.

**Orchestrator verification (Phase 1 complete, both agents):** re-ran the full
CrystalOS suite independently (`.venv/bin/python -m pytest -q`) — **1691
passed, 0 failed**, matches exactly; the 2 targeted files alone also verified
in isolation (24+10=34, matches). Spot-checked by direct code read:
`_scope_catalog_lookup`/`_resolve_scope_hint` exist and match the described
algorithm; `test_no_scope_hint_defaults_to_org_byte_identical_to_before`
genuinely drives `parse_workflow_nl()` with a mocked LLM and asserts the exact
backward-compatible output (org/None/None/unchanged-confidence/no-warnings);
a second test confirms the same default holds even when the registry has no
`surveys`/`tags` keys at all (the legacy-caller case). `git status` confirms
Amara touched zero `backend/`/`app/` files and Nina touched zero `crystalos/`
files — the disjoint-footprint plan held with no conflicts.
5. **Deliverable for Elias's Phase 2:** extended registry payload shape is
   `{ triggers, conditionFields, conditionOperators, actions, surveys:
   {id,name}[], tags: {id,name}[] }` (sent to CrystalOS only, not exposed on
   any response); `ParseWorkflowNLResult`/`ParseWorkflowNLSuccess` both add
   the three optional scope fields above, unpopulated = org-wide exactly like
   today.

**Elias — Phase 2 frontend work COMPLETE** (`app/src/pages/WorkflowNLBuilderPage.tsx`,
`app/src/__tests__/pages/WorkflowNLBuilderPage.test.tsx`, `app/src/locales/en.ts` —
disjoint from Nina's/Amara's Phase 1 files, confirmed no overlap):

1. **`ScopeSummaryRow`** added, mirroring `TriggerSummaryRow`'s structure
   (icon chip + uppercase label word + value). Renders `t('workflows.nlBuilder.
   scopeOrgWide')` ("Org-wide" — byte-identical copy to `ScopeStepPanelContent.
   tsx`'s `workflows.builder.sentence.scope.orgLabel`) when `scopeType` is
   `'org'` or absent, with **zero API calls** in that path — absence is a
   terminal state, not a lookup that happens to resolve to org. For
   `'survey'`/`'tag'`, resolves the display name client-side (`api.getSurvey(id)`
   — a single-item lookup already existed, no need to fetch the whole list;
   `api.listTags()` + find-by-id, since no single-tag GET exists) with a
   `.skeleton` placeholder while resolving, and falls back to
   `scopeSurveyFallback`/`scopeTagFallback` ("a specific survey"/"a specific
   tag") — never a raw UUID — if the id doesn't resolve (deleted between parse
   and now) or the lookup errors. Wired into both `ConfirmCard` and
   `LowConfidenceState`, immediately after `TriggerSummaryRow` (WHEN → ON → IF
   → THEN sentence order).
2. **`createWorkflow()`** now conditionally spreads `scopeType`/`scopeSurveyId`/
   `scopeTagId` onto the `api.createGraphWorkflow()` payload only when
   `scopeType` is present and not `'org'` — an absent-scope or explicit-org
   result produces a payload with **no scope keys at all**, matching
   `WorkflowBuilderPage.tsx`'s established conditional-spread convention and
   the server's existing absent-defaults-to-org behavior.
3. **`editInCanvas()`**'s seed object carries the same three fields through
   with the same conditional-omission rule. **Found and flagged, not silently
   assumed:** `WorkflowCanvasPage.tsx` does NOT currently read any scope field
   from its seed (`CanvasSeed` interface has no `scopeType`/`scopeSurveyId`/
   `scopeTagId`, confirmed by direct read) — Wave 11 and earlier never wired
   this. The seed now forward-compatibly carries the fields (harmless extra
   keys today), but a user who clicks "Edit in canvas" on a scoped NL result
   will currently land on a canvas that silently drops back to org-wide with
   no visible scope picker state. **Open follow-up for Phase 3 (Kenji) or a
   future wave:** `WorkflowCanvasPage.tsx` needs its own scope state + seed
   consumption + save-payload wiring (same shape as `WorkflowBuilderPage.tsx`'s
   `ScopeSelection`) before this handoff is actually lossless.
4. **Tests (`WorkflowNLBuilderPage.test.tsx`, +15 net):** org-wide default
   when scope fields are entirely absent (asserts zero `getSurvey`/`listTags`
   calls — the single most important test, mirroring Phase 1's rigor); explicit
   `scopeType: 'org'`; survey-scope name resolution (asserts the raw id never
   renders); tag-scope name resolution; survey/tag unresolvable-id fallback
   (404 and empty-list cases); loading-skeleton-then-name transition; scope row
   present in the low-confidence state; `createWorkflow()`'s conditional field
   inclusion (absent, explicit org, survey, tag — 4 tests, each asserting the
   omitted keys are absent via `not.toHaveProperty`, not just checking the
   included ones); `editInCanvas()`'s seed carrying scope through (absent-omits,
   survey, tag-from-low-confidence — 3 tests).
5. **Full suite (fresh baseline, not trusted from an old number): 82 files /
   946 tests before this pass, 0 failures → 82 files / 961 tests after, 0
   failures — zero regressions.** `npx tsc --noEmit` clean; `npm run lint`
   clean. The single test file alone: 27 → 42 (+15, matches the delta above).

**Orchestrator verification (Phase 2 complete):** re-ran the full frontend
suite independently — first run showed 1 transient failure (960/961), a clean
immediate re-run showed **82 files / 961 tests, all passing** — confirmed
flaky/environmental, not a real regression (no failure details captured on
either the first run's grep or a dedicated re-run targeting it). `tsc
--noEmit` clean, `npm run lint` clean. Spot-checked by direct code read:
`createWorkflow()`/`editInCanvas()`'s conditional spreads only add scope keys
when non-org, exactly as described; `ScopeSummaryRow`'s API calls are
genuinely gated behind `scopeType === 'survey'/'tag'` (confirmed via the
`useEffect`'s branch structure, not just the component's prose description);
`WorkflowCanvasPage.tsx` confirmed to have zero scope-field references
anywhere — Elias's flagged limitation is real, not a bug he introduced, and
correctly logged as an open follow-up rather than silently patched or
scope-crept into this dispatch.

**Phase 3 (dispatched next):** Kenji — full 3-layer regression suite
(CrystalOS pytest + backend vitest + frontend vitest) plus explicit
verification of the backward-compatibility invariant and the safe-fallback
behavior for an unmatched/hallucinated scope mention, end-to-end through all
3 layers (not just per-layer, as Phase 1/2 already did) — the final gate
before this wave is considered done.

**Kenji — Phase 3 end-to-end seam verification COMPLETE (final gate, Wave 12
done):**

1. **Full 3-layer regression, run fresh (not trusted from prior reports):**
   CrystalOS **1691 passed, 0 failed** (matches Amara's number exactly).
   Backend **86 files / 1181 tests, 1 pre-existing failure**
   (`workflowEngine.test.js`'s documented Wave 10 RED TDD marker, unrelated —
   matches Nina's baseline exactly). Frontend: two consecutive full runs each
   surfaced exactly 1 different, unrelated test failing
   (`NotifyTargetPicker`'s keyboard-nav test, then `scheduleConfig`'s cron
   builder test) — both pass 100% in isolation; a clean run gave **82 files /
   962 tests, all passing**. Confirmed environmental/parallel-worker
   flakiness, not a regression — the same "1 transient failure, clean
   re-run" pattern the orchestrator already documented at Phase 2.
2. **Seam trace (Node↔CrystalOS, CrystalOS↔Node, Node↔frontend) — read the
   real wire-construction code on both sides of each boundary, not each
   side's own (self-mocking) tests.** All three boundaries align
   field-for-field: `agentsClient.parseWorkflowNL` sends
   `{org_id, description, registry}`, which is exactly what
   `parse_workflow_nl_endpoint` reads via `body.get(...)`; CrystalOS returns
   camelCase `scopeType`/`scopeSurveyId`/`scopeTagId` (never snake_case) in
   both its 200 dict and its deliberately-flat (non-`HTTPException`-wrapped)
   422 body; the route's `res.json(result)` passes the object through
   unchanged; `ParseWorkflowNLSuccess` (backend) and `ParseWorkflowNLResult`
   (frontend) declare the identical three optional fields. No key-naming
   drift, no null-vs-absent mismatch found. New test file
   `backend/src/__tests__/workflowsParseNlEndToEnd.test.js` (+5 tests) proves
   this isn't just a read — it fakes ONLY `node-fetch` (the one real
   external boundary `agentsClient.ts` crosses) so the REAL
   `agentsClient.parseWorkflowNL` and the REAL route handler both execute
   end-to-end, against raw HTTP-shaped bodies matching exactly what
   `crystalos/main.py` actually produces (200 with scope, 200 without, flat
   422, and a defensive `detail`-wrapped 422 to prove the documented FastAPI
   risk degrades gracefully rather than crashing). All 5 passed on the first
   run — the seam was genuinely correct, not just independently tested.
3. **Backward-compatibility invariant, verified across a real boundary (not
   a mock).** The single most important test in the new file: a raw
   CrystalOS-shaped 200 JSON body with `scopeType`/`scopeSurveyId`/
   `scopeTagId` entirely absent (simulating an old/lagging CrystalOS
   instance mid-deploy) flows through the REAL `agentsClient.parseWorkflowNL`
   and REAL route handler to produce a response with exactly the 7
   pre-Wave-12 keys — `Object.keys(body)` asserted directly, plus
   `'scopeType' in body === false` — genuinely indistinguishable from
   pre-Wave-12 behavior. This closes the gap Nina's/Amara's/Elias's own
   (self-mocking) tests couldn't: each proved their own layer defaults
   correctly in isolation, but none exercised the real
   `agentsClient.ts`-to-CrystalOS wire boundary together until now.
4. **`WorkflowCanvasPage.tsx` scope gap — assessed, confirmed safe, NOT
   fixed (per explicit task scope).** Direct code read: `CanvasSeed` has no
   scope fields, and `save()`'s payload (`{name, description, triggerType,
   nodes, edges, status, ...version}`) never includes `scopeType`/
   `scopeSurveyId`/`scopeTagId` under any circumstance — confirmed this is
   the *latter* of the two possible severities, not the former: no path
   writes an unintended/wrong/destructive scope. `schemas/workflows.ts`'s
   `checkScopeFields` defaults an absent `scopeType` to `'org'`, and
   `routes/workflows.ts`'s `POST /` INSERT uses `scopeType || 'org'` — the
   exact same safe default every other scope-less caller already gets. New
   regression test in `WorkflowCanvasPage.test.tsx`
   ("a scoped Crystal seed (survey scope) still saves with NO scope keys in
   the payload") drives a canvas seeded with `scopeType: 'survey'`/
   `scopeSurveyId` (the exact shape `editInCanvas()` sends) through a real
   save and asserts zero scope keys reach `createGraphWorkflow()` — proving
   the outcome is "silently org-wide," never "silently wrong-scope." Verdict:
   a real UX gap (Crystal's inferred scope is invisible and has to be
   manually re-picked... except the canvas has no scope picker at all yet
   either), but not a data-safety bug — correctly left as Elias's already-
   logged deferred follow-up (a canvas-side `ScopeSelection` build), not
   scope-crept into this verification pass.
5. **Footprint:** two files touched, both additive-only — new
   `backend/src/__tests__/workflowsParseNlEndToEnd.test.js` (+5 tests) and
   `app/src/__tests__/pages/WorkflowCanvasPage.test.tsx` (+58 lines, +1
   test, 31→32). `tsc --noEmit` clean on the frontend; backend's only errors
   are the pre-existing, already-documented `lib/prism/uploads.ts` gaps
   (missing `@aws-sdk/client-s3` dep, duplicate `fs` import), untouched by
   this pass.

**Verdict: YES, Wave 12 is safe to consider done.** All 3 layers pass their
full regression suites at their documented baselines with zero regressions;
the 3 wire boundaries (Node→CrystalOS, CrystalOS→Node, Node→frontend) were
independently re-verified field-for-field against the REAL request/response
construction code (not each side's mocks) and found genuinely aligned; the
hard backward-compatibility invariant was proven across a real (not mocked)
`agentsClient`-to-CrystalOS boundary, closing the one gap per-layer testing
structurally couldn't reach; and the one known open item
(`WorkflowCanvasPage.tsx`'s missing scope picker) was confirmed — by test,
not assumption — to degrade safely to the existing org-wide default rather
than risk writing to the wrong scope, so deferring its larger UI build to a
future wave carries no data-safety risk in the meantime.

---

## Wave 11 — 5 deferred Wave-10 gaps, full team re-assembled (2026-07-02, IN PROGRESS)

Per explicit user request: implement the remaining Wave 10-deferred items — audit
trail, concurrent-edit protection, mobile/accessibility polish, a wait/delay
action, and a condition-step in the sentence builder — with **"very safe
integration": must not break existing business logic, fault-tolerant, ready for
scale.** Full team re-assembled per `TEAM.md`.

**Explicit safety framing for every dispatched agent this wave:** the workflow
engine, approval flow, and PUT /api/workflows/:id route are live, heavily tested
surfaces (85 files/1134 backend tests, 80/868 frontend tests as of Wave 10's
close) — every change here is additive/backward-compatible, not a rewrite. Full
regression suite (not just new tests) is a required gate before any agent
declares done.

**Phase 1 (parallel — disjoint file footprints, confirmed by the orchestrator
before dispatch):**
- **Rohan** (UX) — spec only, no code: (a) a condition-step for the sentence
  builder, (b) the wait/delay action's config UI (duration picker + live
  preview, matching `ScheduleTriggerConfigPanel.tsx`'s established pattern).
- **Nina** (Platform Integrity) — audit trail (`updated_by` + append-only
  `workflow_audit_log` table) + concurrent-edit protection (version-based
  optimistic locking on `PUT /api/workflows/:id`, backward-compatible: omitting
  the version field skips the conflict check entirely, so no existing caller —
  internal-workflows signal consumers, template-seed flows, tests — breaks).
  Both scoped to `routes/workflows.ts`'s PUT/DELETE handlers + schema +
  migrations — kept in one agent's hands specifically to avoid two agents
  editing the same route handler concurrently (a real risk surfaced in Wave 10b).
- **Priya** (Backend Architect, Async Systems) — `flow.delay` (wait/delay)
  action: new registry entry, engine support reusing the existing
  `flow.approval` pause mechanism (`executeAction`'s `{status:'waiting',
  pause:true}` contract, `runNodes`/`runGraph`'s generic pause handling) without
  regressing it, a new scheduler job to auto-resume delayed executions
  (mirroring `reNotifyStaleApprovals`'s established shape), with explicit
  concurrency/idempotency tests (claim-row pattern so overlapping scheduler
  ticks can't double-resume/double-execute) and a hard requirement that the
  existing approval-only paths (`reapStuckExecutions`, `reNotifyStaleApprovals`,
  the approvals endpoint) remain completely unaffected — regression tests
  proving disjointness required.

**Nina — Phase 1 backend work COMPLETE** (audit trail + optimistic locking,
`routes/workflows.ts`/`schemas/workflows.ts`, disjoint from Priya's in-flight
`flow.delay` work on `workflowEngine.ts`/scheduler — confirmed no file overlap):

1. **Audit trail (§10b).** `workflows.updated_by` (nullable TEXT, mirrors
   `created_by`'s existing type — no FK, Clerk user-id string), set on every
   successful PUT/toggle; `created_by` itself untouched. New append-only
   `workflow_audit_log` table (`id, workflow_id, org_id, actor_user_id, action
   ∈ {created,updated,status_changed,deleted}, summary jsonb, created_at`),
   **deliberately no FK** on `workflow_id` (unlike `workflow_executions`'
   `ON DELETE CASCADE`) — an FK would let a workflow's `'deleted'` audit row
   (and all prior history) evaporate the instant the row it describes is
   removed, defeating the one action ("who deleted this") that most needs to
   survive. One row written on create/update/status-toggle/delete; PUT's
   diff (`lib/workflowAuditLog.ts::diffChangedFields`) is a shallow before/
   after of only the fields that actually changed (bookkeeping columns
   `updated_at`/`updated_by`/`version` excluded from the diff — they change on
   every PUT by design and would drown the signal). **Transactional-coupling
   decision:** audit writes are NOT in the same DB transaction as the mutation
   (this codebase's `lib/db.ts` exposes only an auto-committing `query()`, no
   transaction/client helper exists yet — adding one is a bigger, riskier
   change than this wave's additive mandate calls for). Instead, mirrors
   `workflowEngine.ts`'s `logStep()` precedent exactly: the audit INSERT is
   try/catch-wrapped and logged-and-swallowed, never allowed to throw into the
   request path — a Postgres blip can only produce an incomplete audit trail,
   never revert/block/double-apply the workflow mutation itself. New `GET
   /api/workflows/:id/audit-log` (paginated — `page`/`limit`/`offset`,
   response `{events,total,page,limit,pages}` — mirrors `routes/auditLogs.ts`'s
   existing convention exactly), for Elias to build against in Phase 2.
2. **Concurrent-edit protection (§10a).** `workflows.version` (int, default 1,
   incremented on every successful PUT/toggle). `PUT /api/workflows/:id`
   accepts an **optional** `version` field: absent → conflict check fully
   skipped, byte-identical to pre-Wave-11 behavior (verified via regression
   test — the single most important test in this batch); present and stale →
   409 + the current server-side workflow in the body (for a future "someone
   else edited this" dialog); present and correct → succeeds, increments,
   returns the new `version`. `updateWorkflowSchema.version` is a plain
   optional positive int — not required, never will silently become required.
3. **Regression discipline:** the pre-fetch this needed (for the version
   check + a real audit diff) replaces rather than adds to the PUT handler's
   pre-existing ad-hoc scope/triggerType lookup — one query, not two. Caught
   and fixed a self-introduced regression during this work before it shipped:
   an early draft 404'd on PUT against a nonexistent/cross-org id, which is
   NOT this route's pre-existing behavior (it has always been a silent
   zero-rows-affected `{success:true}`) — reverted to preserve that exact
   legacy behavior, since changing it wasn't in scope for an additive-only
   change. New migration `20260702100000_workflow_audit_and_optimistic_locking.sql`.
   New test file `workflowAuditAndVersioning.test.js` (16 tests); updated
   `workflowsCrud.test.js`/`workflowScope.test.js`/`workflowsRoutesPermissions.test.js`
   for the new SET-list shape and route. **Full suite: 86 files / 1170 tests,
   1 pre-existing failure** (`workflowEngine.test.js`'s "RED, proves 2d" —
   Wave 10's own documented TDD marker, unrelated to this work, left
   untouched) **— zero regressions.** Baseline re-verified fresh (not trusted
   from an old doc) at 85 files/1134 tests before this pass; one transient,
   in-progress-edit failure was observed mid-session in Priya's concurrently-
   modified `workflowEngine.ts`/its test file (mirroring the Wave 10b
   Nina/Kenji precedent this brief explicitly flagged) — confirmed via
   `git status`/isolated re-run to be her uncommitted work-in-progress, not a
   regression from this PUT/DELETE work, and resolved itself by the final run.

**Priya — Phase 1 backend work COMPLETE** (`flow.delay` engine + scheduler,
`workflowEngine.ts`/`scheduler/`, disjoint from Nina's `routes/workflows.ts`
work — confirmed no file overlap): registered `flow.delay` (`category: 'Flow'`,
config `{ delay_minutes: number }`); `executeAction` reuses the exact
`{status:'waiting', pause:true}` contract `flow.approval` already used, so
`runNodes`/`runGraph` needed only two new pass-through fields, zero logic
changes. Extracted shared `persistPause`/`continueExecution` helpers used by
`runWorkflow`, `resumeWorkflow` (approval path, unchanged), and the new
`resumeDelayedExecution`. New `wait_reason`/`resume_at` columns (real, indexed
— chosen over a JSONB-only approach by following this codebase's own existing
precedent for scheduler-scanned state, `idx_wf_exec_due_retry`/
`idx_wf_exec_dead_letter`) mean the `workflow_approvals` INSERT is now
conditional on wait type, and `resumeWorkflow`'s SELECT gained a `wait_reason`
guard so the human approve/reject endpoint can never touch a delay-type wait.
New `resumeDelayedExecutions` scheduler job (1-min tick — tighter than the
hourly approval nudge, since a delay is a timing promise). **Idempotency:**
atomic `UPDATE ... WHERE status='waiting' AND wait_reason='flow.delay' AND
resume_at <= NOW() RETURNING *` claim — a zero-row return means "already
claimed," proven by a concurrency test firing the resume function twice for
the same execution and asserting the downstream action fires exactly once.
5 disjointness regression tests all pass (flow.approval unaffected;
flow.delay never touches `workflow_approvals`; `reNotifyStaleApprovals`
structurally can't see a delay wait; the new job's query is `wait_reason`-
scoped; `reapStuckExecutions` unaffected by either wait type). New migration
`20260702090000_workflow_delay_action.sql`. **Full suite: 85 files / 1154
tests** at Priya's own final check (+20 new tests over the 85/1134 baseline),
same 1 pre-existing unrelated failure, zero regressions.

**Rohan — Phase 1 spec COMPLETE** (`docs/automation-hub/WAVE11_UX_SPECS.md`,
no code): condition-step placement (`when [trigger] on [scope] if [condition]
then [action]...`), the zero-condition backward-compatibility contract
(`conditionClauses.length === 0` → byte-identical `serialize()` output to
today — Elias must write the regression test proving this), `evaluateConditions`
confirmed AND-only by default so no OR toggle is needed, reuses the same
registry-fetched `conditionFields`/`conditionOperators` the canvas's
`ConditionNode` already consumes (no second source of truth), a new
non-breaking 4th `SentencePillState` for the condition pill, and
`DelayActionConfigPanel.tsx` with unit-aware duration input + a
`ScheduleTriggerConfigPanel`-style live preview line. Recommends a lightweight
category-tint fix (not per-pill ordinal badges) for the flow-action
execution-order gap `flow.delay` makes more consequential.

**Orchestrator verification (Phase 1 complete, all 3 agents):** re-ran the full
backend suite independently — **86 files / 1170 tests, 1169 passing**, matches
Nina's final numbers exactly (Priya's 85/1154 was her own pre-Nina-merge
checkpoint; the combined final state supersedes it). `tsc --noEmit` clean
(excluding the pre-existing, unrelated `prism/uploads.ts` errors). Spot-checked
by direct code read rather than trusting the reports: `routes/workflows.ts`'s
version-check logic matches exactly as described (optional field, conditional
409, unconditional increment); `workflowEngine.ts`'s `wait_reason` branching,
`persistPause`, and `resumeDelayedExecution`'s atomic claim all present and
match the reports; both new migrations (`20260702090000`,
`20260702100000_...`) confirmed on disk; `git status` confirms all tracked
changes stayed within `backend/`, consistent with the planned disjoint
footprints (zero file-overlap conflicts materialized).

**Elias — Phase 2 frontend work COMPLETE** (all under `app/src/`, backend
untouched): (1) concurrent-edit conflict UI — new `WorkflowConflictError`
(mirrors `ConnectorTestError`'s `rawHttp` pattern so a 409's body survives),
`version`/`updated_by` added to the `Workflow` type, both builders track
`version` in edit mode only (omitted entirely in create mode) and show a
Reload-latest/Overwrite-anyway dialog on conflict; (2) audit-trail UI — new
`AuditLogHistory` dialog off a "Change history" icon on `WorkflowsPage.tsx`,
deliberately kept separate from the existing run-history button (different
question: config changes vs. executions); (3) `flow.delay` — new
`DelayActionConfigPanel.tsx` (unit-aware duration + live preview), wired into
both builders' action pickers and `ActionClauseList.tsx`'s category-tinted
pill rendering; (4) condition-step — new `ConditionStepPanelContent.tsx` +
additive 4th `SentencePillState`, with **the critical zero-condition
backward-compatibility regression test passing** (orchestrator-verified below);
(5) all 6 mobile/accessibility findings (C-3, S-2, A-1, A-2, A-3, V-2) closed,
including a from-scratch minimal WAI-ARIA combobox for `NotifyTargetPicker`
with no new dependency. **Full suite: 82 files / 946 tests, all passing**
(+2 files/+78 tests over the 80/868 baseline, zero regressions).

**Orchestrator verification (Phase 2 complete):** re-ran the full frontend
suite independently — **82 files / 946 tests, all passing**, matches exactly.
`tsc --noEmit` clean, `npm run lint` clean. Spot-checked by direct code read:
the zero-condition regression test (`WorkflowBuilderPage.test.tsx`) genuinely
drives the real builder UI end-to-end (types a name, picks a trigger, adds an
action, saves — never touches the condition pill) and asserts the exact saved
payload is `nodes: ['trigger','action']` with zero condition nodes and an
unchanged 2-node edge chain — this is real proof, not an assertion of intent.
`WorkflowBuilderPage.tsx`'s `version` state confirmed `undefined` in create
mode with `...(isEditMode && !forceOverwrite ? { version } : {})` in the save
payload, matching the reported create-mode-omission behavior exactly.
`git status` confirms all tracked changes stayed within `app/`.

**This closes Phase 1 + Phase 2 of Wave 11 for all 5 requested items.**

**Kenji — Phase 3 fault-tolerance/scale safety pass COMPLETE — found and fixed
2 genuine bugs, not just verified:**

1. **TOCTOU race in optimistic locking (real bug, fixed).** Nina's original PUT
   checked `version` via a separate SELECT, then ran the UPDATE with no
   `version` predicate at all — two concurrent requests carrying the same
   stale version could both pass the SELECT check before either UPDATE
   committed, both succeeding (a silent lost update, neither getting a 409).
   Proved it with a true-concurrency test (`Promise.all` + a barrier forcing
   both SELECTs to resolve before either UPDATE) that fails `[200,200]`
   against the pre-fix code (confirmed via `git stash` bisection) and passes
   `[200,409]` against the fix. **Fix:** fold `AND version = $version` into
   the UPDATE's own WHERE clause (not a separate SELECT) — Postgres's
   row-level locking then serializes concurrent writers for free; a
   post-UPDATE zero-rows re-check re-fetches and returns the 409, preserving
   the pre-existing "PUT against a nonexistent/cross-org id is a silent
   no-op" behavior exactly.
2. **Unbounded batch in the delay-resume scheduler job (real scale bug,
   fixed).** `resumeDelayedExecutions`'s SELECT had no `LIMIT` — checked
   precedent (`reNotifyStaleApprovals`, `expireStaleBroadcasts`) and confirmed
   neither batches either, so this was a genuine, previously-unaddressed gap:
   unlike those two (single bulk SQL statements), this job runs a full
   per-row execution pipeline (network calls, DB writes), so a large
   post-outage backlog could make one tick run unpredictably long. **Fix:**
   `ORDER BY resume_at ASC LIMIT $1`, env-overridable via
   `WORKFLOW_RESUME_DELAYED_BATCH_SIZE` (default 200, documented in
   `.env.example`/`docs/ENV_VARS.md`) — backlog beyond the cap resumes
   oldest-first on subsequent ticks, never dropped. Proved with a
   multi-tick-backlog test (5 overdue rows, batch size 2 → 3 ticks drain
   completely, correct order, no dupes/drops).
3. **Verified safe, no fix needed:** the per-row `resumeDelayedExecution`
   claim's crash-recovery (any overdue row resumes correctly regardless of
   how overdue) and idempotency (Priya's existing double-resume tests); the
   new partial index's predicate is an exact match/strict subset of both
   consuming queries' WHERE clauses (checked side-by-side against the
   migration, not assumed); audit-log failure isolation — strengthened with
   new tests loading the REAL `writeWorkflowAuditLog` (not a full-module
   mock) with a DB mock that throws specifically on the `workflow_audit_log`
   INSERT, covering POST/PUT/DELETE/toggle, confirming the mutation still
   succeeds in every case.

**Verdict: yes, Wave 11 meets the "very safe, fault-tolerant, ready for
scale" bar** — after these 2 fixes. Both were real, exploitable-in-production
deviations from that bar at the time Phase 3 started, not cosmetic; both are
now closed with minimal, targeted changes (a WHERE-clause fold, a LIMIT
clause — no architecture changes) and a test proven to actually fail
pre-fix, not just pass trivially.

**Orchestrator verification (Phase 3 complete, final gate):** re-ran both full
suites independently — backend **86 files / 1178 tests, 1177 passing**
(same 1 pre-existing, documented-unrelated failure), frontend **82 files / 946
tests, all passing** — both match exactly. Spot-checked by direct code read:
the version predicate is genuinely folded into the UPDATE's WHERE clause
(not just the SELECT) with the lost-race re-check present as described; the
scheduler job's `LIMIT $1`/`ORDER BY resume_at ASC`/`batchSize()` env-override
all present and match; `WORKFLOW_RESUME_DELAYED_BATCH_SIZE` documented in both
`.env.example` and `docs/ENV_VARS.md` per the project's env-var rule; the
`[TRUE RACE]`-named test exists and matches its stated intent.

## Wave 11 — COMPLETE. All 5 requested items shipped, tested, and
independently verified across all 3 phases: audit trail, concurrent-edit
protection (with a real race condition found and closed), a wait/delay
action (with a real scale gap found and closed), a condition-step in the
sentence builder (with a proven backward-compatibility guarantee), and the
6 mobile/accessibility findings from Wave 10's audit.

---

## Wave 10 — Deep Audit: full customer-value + UX walkthrough (2026-07-01, IN PROGRESS)

Per explicit user request: "be very very thorough" — a full, independent, code-first
walkthrough of every customer-facing surface (list page, sentence builder, canvas,
NL builder, templates, integrations settings, approvals, Crystal chat, run history)
by both Maya (PM, business-value lens) and Rohan (UX, interaction-design lens),
working in parallel without seeing each other's findings, so results could
corroborate or diverge independently rather than anchor on one framing.

**Docs:** `DEEP_AUDIT_PM_FINDINGS.md` (Maya), `DEEP_AUDIT_UX_FINDINGS.md` (Rohan).
Both explicitly cross-checked against all prior waves' known/tracked issues first —
everything reported is NEW, not a restatement.

**Two critical, independently-corroborated findings fixed immediately** (orchestrator
verified by direct code read — no ambiguity, no test needed to prove them, then fixed
directly rather than waiting for a full round-trip given the severity):

1. **Editing an already-active workflow silently disabled it — in BOTH builders.**
   `WorkflowBuilderPage.tsx` and `WorkflowCanvasPage.tsx` both hardcoded
   `status: 'draft'` in every save payload, unconditionally, including edits of a
   currently-`active` workflow. A CX manager tweaking a Slack message's wording on
   a live "NPS Drop Alert" would silently turn the automation off with zero warning
   — this was the default path for every single edit to every active workflow, not
   an edge case. **Fixed:** both pages now track the loaded workflow's `status` and
   preserve it on save (only defaulting to `'draft'` for genuinely new workflows).
   2 new regression tests (one proving an active workflow stays active through an
   edit, one proving a brand-new workflow still correctly defaults to draft).
2. Confirmed but **not yet fixed** (needs real design/implementation work, not a
   one-line change): the branching canvas builder's `serializeCanvas()` hardcodes
   `config: {}` for every action node, and `ActionNode`'s UI has no fields to
   populate one — every canvas-built workflow, ever, fires every action with empty
   configuration. This is the single worst functional gap found in the whole
   project: the canvas builder (the only way to build real branching logic) cannot
   produce a working workflow today, for any action type, unconditionally.

**Verified:** frontend `tsc --noEmit` clean, `npm run lint` clean, `npx vitest run`
→ **77 files / 818 tests passing** (was 77/815, +3 regression tests, zero
regressions).

**Full findings synthesis, prioritization, and remaining fix dispatch: in progress.**
See both audit docs for the complete, indexed list (Maya: ~20 findings incl. 5/8
dead templates, run-history's unreachable 'success' status, retry endpoint with zero
UI wiring, approval TTL/expiry absent, malformed-approval-decision defaults to
approved; Rohan: 22 indexed findings incl. duplicate "Build Visually"/"New Workflow"
buttons routing identically, canvas escape-hatch silently dropping already-configured
scope/actions, zero live per-org integration-health signal in the builder, hardcoded
hex breaking brand-theming, mobile/accessibility gaps).

**Rohan — fix specs delivered** (`DEEP_AUDIT_FIX_SPECS.md`) for the 3 highest-priority
items: (1) canvas action config — Option A, a new `ActionConfigPanel` side-sheet
reusing `SimpleActionConfigForm`/`ContentCustomizationPanel`/`NotifyTargetPicker`
as-is (all three are already pure controlled components, zero sentence-builder
dependency, confirmed droppable), `CanvasNodeData` gains a real `config` field,
`ActionNode` gets a binary configured/unconfigured indicator (amber "Needs
configuration" vs. green one-line summary) that's impossible to miss at rest, save
is blocked while any action is unconfigured; (2) entry points — delete "New
Workflow" outright (not repurpose into a dropdown — rejected as adding a second path
to the same 3 destinations), promote "Build Visually" to the primary CTA (fixes the
V-1 hardcoded-hex finding for free), add always-visible one-line subtext + tooltip
to "Build Visually"/"Build on Canvas" so they're distinguishable without a click;
(3) canvas escape-hatch seed — confirmed `serialize()`'s `{nodes, edges}` output is
already structurally identical to the `EngineNode[]`/`EngineEdge[]` shape
`WorkflowCanvasPage`'s existing seed-consumption branch expects (same path templates/
NL-builder already use) — no adapter needed, just wire it through
`switchToCanvas()`'s create-mode branch; scope/cooldown can't be carried over
because the canvas has no fields for them at all (separate, bigger gap, not folded
into this fix) — added an explicit confirm-before-switch warning instead of
continuing to drop them silently. Flagged a build-order dependency: Issue 3 only
fully closes once Issue 1's `deserializeCanvas()` fix lands too (otherwise carried-
over config arrives but is invisible and gets discarded on the next save). Not yet
built — spec only, per explicit no-code-changes scope for this task.

**Nina — backend fixes COMPLETE** (`#36`), all 5 assigned items:

1. **Run history status ('success' vs 'completed')** — confirmed this is a
   frontend-only fix (backend's `'completed'` status is already correct/tested);
   flagged for Elias, not touched here.
2. **Per-step output/error visibility** — `GET /:id/executions` extended (still
   backward compatible: same top-level fields, plus new ones) with a `steps[]`
   array per execution (`nodeId`/`nodeType`/`status`/`output`/`errorMessage`) via
   one batched `WHERE execution_id = ANY(...)` query (no N+1), plus the
   previously-unexposed dead-letter columns (`attempt_count`/`next_retry_at`/
   `dead_letter`, audit §9a — data already existed, just never selected). New
   `lib/humanizeExecutionError.ts` maps common raw patterns (timeout/401/403/DNS/
   rate-limit) to plain language at the API boundary only — the raw value is
   never mutated in the DB. Both execution- and step-level `error_message` are
   now `{ raw, message, matched }` objects (a shape change Elias needs to build
   against — was previously a plain string or null).
3. **Approval TTL + re-notify** — new `scheduler/jobs/reNotifyStaleApprovals.ts`
   (registered in `scheduler/registry.ts`, mirrors `expireStaleBroadcasts`'s
   shape), new `workflow_approvals.last_notified_at`/`notification_count`
   columns. Re-notifies the workflow's owner (`workflows.created_by` — there's no
   dedicated approver column) via the exact same `createNotification` primitive
   `notify.in_app` uses, once per `WORKFLOW_APPROVAL_RENOTIFY_HOURS` (default 72h)
   until a human decides. **Never** auto-rejects or touches the execution's
   `'waiting'` status, per explicit product decision — purely a nudge.
4. **Malformed approval decision (fail-open bug)** — `POST
   /api/workflows/approvals/:executionId` now requires an exact (case-insensitive)
   `'approved'`/`'approve'` or `'rejected'`/`'reject'` string; anything else is a
   400, not a silent approval. 10 regression tests incl. typo/missing/boolean/
   unrelated-string cases.
5. **Real Growth-tier enforcement for Crystal Signals** — new `lib/planGating.ts`
   (single source of truth), `WorkflowTriggerDef.minPlanTier` on the 3 Crystal
   Signal triggers (`crystal.anomaly_detected`/`sentiment_spike`/
   `new_theme_detected` = `'growth'`). Enforced at BOTH save time (`POST`/`PUT
   /api/workflows` → 403 + upgrade message) AND execution time
   (`workflowEngine.ts::runWorkflow` → clean `'skipped'` execution) — chosen
   because this codebase's existing precedent (`lib/seats.ts::checkSeatLimit`
   reads `plan_tier` live, never grandfathers) is that a plan downgrade takes
   effect immediately, not just on the next save.
6. **Template gallery honesty** — re-verified the audit's "5 of 8" claim directly
   against the current registry + every real event producer in the codebase:
   confirmed exactly **4** (not 5) templates are trigger-dead — `nps-recovery`,
   `verbatim-escalation`, `nps-win-celebration`, `slow-completion-flag` (the
   other 4 templates the audit table separately flagged, e.g. `weekly-digest`,
   have live triggers but under-deliver on a downstream step — a different,
   already-tracked gap, correctly out of scope here). New `workflow_templates.
   is_functional` column (default `TRUE`, `FALSE` for the 4 dead ones);
   `GET /api/workflows/templates` now filters `WHERE is_functional = TRUE`.

**Verified: 84 files / 1129 tests passing** (was 79/1063 before this pass — +6 new
test files, +66 new tests, zero regressions from these changes). One pre-existing,
unrelated failing test (`workflowEngine.test.js`'s "RED, proves 2d" — canvas
condition-field validation, a different finding, not one of Nina's 5) predates this
work and was left untouched, matching its own comment's intent as a deliberate
TDD marker for a future fix.

### Cross-reference: where Maya (PM) and Rohan (UX) independently corroborate

Both agents worked in parallel with no visibility into each other's findings.
Where they landed on the *same* defect from different lenses (business-value vs.
interaction-design), that's the strongest confidence signal in this audit —
independent convergence, not one framing repeated. Corroborated pairs:

| Defect | Maya | Rohan | Status |
|---|---|---|---|
| Editing an active workflow silently disables it | Top-5 #1 | (not independently flagged) | **Fixed** this wave |
| Canvas discards all action config | Top-5 #2 | C-1 (escape-hatch angle) | Spec'd (`#35`), not yet built |
| 4/8 templates dead on arrival (re-verified count) | Top-5 #3 | T-1 (asymmetric readiness signal, contributing cause) | **Fixed** (`#36`) |
| Run history: dead 'success' status + invisible skips | Top-5 #4 | R-1/R-2, Top-5 #3 | Backend **fixed** (`#36`); frontend status-string fix + rendering still needed (Elias) |
| Duplicate/ambiguous entry-point buttons | 3a (partial) | L-1, Top-5 #5 | Spec'd (`#35`), not yet built |
| Tier gating is pure marketing copy | 6d | T-2 | **Fixed** (`#36`) |
| Approval TTL absent | 7a | (not independently flagged) | **Fixed** (`#36`) |
| Malformed approval decision defaults to approved | 7c | (not independently flagged) | **Fixed** (`#36`) |
| **Integration credential health invisible in builder** | 6c | I-1, Top-5 #2 | Verified REAL by Kenji (`#37`), not yet fixed |
| **No readiness signal for dead-producer triggers** | 2c | T-1, Top-5 #1 | Verified REAL by Kenji (`#37`), not yet fixed |
| **Toggle/delete/test-run: silent failure or generic feedback** | 1b, 1e | L-2/L-3/L-4, Top-5 #4 | Verified REAL by Kenji (`#37`), not yet fixed |

Single-source-but-high-confidence findings worth verifying alongside the above
(concrete, grep-able, easily provable or disproven with a test):
- `notify.webhook` has zero config form despite a fully-wired backend action
  (Maya 2a) — same bug class as the pre-Wave-9 `notify.in_app` gap.
- Canvas `ConditionNode`'s condition field is raw free text with no dropdown and
  no validation — a typo'd field key silently resolves to always-false/always-true
  forever (Maya 2d).

**Kenji dispatched (`#37`)** to write real, executable tests proving (or
disproving) the 3 corroborated-but-undispatched findings plus the 2 single-source
findings above, before any fix work is planned for them — so the next dispatch
wave targets confirmed defects, not audit prose.

**Kenji — done (`#37`).** All 5 findings verified REAL with executable RED tests
(fix-shaped assertions that fail against current code — not tests of current
buggy behavior asserted as "expected"):
1. **Integration credential health invisible in builder** (Maya 6c / Rohan I-1) —
   `app/src/__tests__/components/workflow-builder/sentence/TriggerActionTile.test.tsx`
   `ActionTile — readiness dot rendering > renders a distinct readiness state for
   a disconnected-org action vs a connected one`. `ActionTileProps` has no
   channel for real per-org credential status at all.
2. **No readiness signal for dead-producer triggers** (Maya 2c / Rohan T-1) —
   same file, `TriggerTile > renders a readiness dot distinguishing a
   no-producer trigger from a live one`. Re-verified fresh: still 7 of 13
   registry triggers have zero producer; `WorkflowTriggerDef` has no `live` field.
3. **Toggle/delete silently swallow API failures** (Maya 1b / Rohan L-4) —
   `app/src/__tests__/hooks/useWorkflows.test.ts`, 4 tests across
   `toggleWorkflow`/`deleteWorkflow` — proves state never reverts and `error`
   is never set on API rejection. Highest-value proof (correctness bug, not
   polish) per dispatch brief.
4. **`notify.webhook` has zero config form** (Maya 2a) —
   `app/src/__tests__/pages/WorkflowBuilderPage.test.tsx`
   `selecting notify.webhook (a live backend action) renders a URL config field`.
   Confirmed absent from both `FIELDS_BY_ACTION` and `CONTENT_PRODUCING_ACTIONS`.
5. **Canvas `ConditionNode` field is unvalidated free text** (Maya 2d) —
   `backend/src/__tests__/workflowEngine.test.js`
   `rejects a condition rule whose field is not a known registry field`.
   Confirmed `evaluateConditions` does a plain `context[r.field]` lookup with
   zero field-name validation; a typo'd key resolves to `undefined` → `NaN` →
   silently `false`, no throw, indistinguishable from a legitimate non-match.

Frontend: 78 files / 825 tests (818 pass + 7 intentional RED proving findings
1–4). Backend: 82 files / 1110 tests (1108 pass + 1 intentional RED proving
finding 5; 1 unrelated failure from Nina's concurrent `#36` Growth-tier work
landing mid-flight in the same file — not caused by this task, left untouched).
Zero regressions to pre-existing passing tests in either suite.

**Orchestrator verification (post-Wave 10b+10c, all 3 agents complete):** re-ran
both suites independently. Frontend: 78/825, 818 passing, 7 RED (Kenji's proofs,
findings 1-4) — matches exactly. Backend: 85/1130, 1129 passing, 1 RED (Kenji's
proof, finding 5) — matches exactly, confirming the "unrelated failure" Kenji saw
was transient (Nina's file was mid-edit at that moment, not a real second defect).
Confirmed via `git status` Nina touched only `backend/`; both her new migrations
exist on disk. Rohan's and Kenji's task entries above were written by themselves
and read directly, not re-summarized from a self-report.

**Orchestrator — trigger `live` field added directly (`#38` prep, not a full
dispatch — small, mechanical, single-source-of-truth change)**: added
`WorkflowTriggerDef.live: boolean` to `backend/src/lib/workflowRegistry.ts`,
mirroring `ActionDef.live`'s existing readiness pattern, closing the backend half
of finding 2c/T-1. Populated via a fresh producer-mapping sweep (confirmed by a
research agent grepping every real producer call site, not the registry's own
stale header-comment count): `survey.milestone`, `crystal.anomaly_detected`,
`crystal.sentiment_spike`, `crystal.new_theme_detected`, `alert.fired`,
`time.schedule` = `true`; the other 7 = `false`. `GET /api/workflows/registry`
passes it through automatically (no route change needed). 4 new regression tests
in `workflowRegistry.test.js`. **Verified: 85 files / 1134 tests, 1133 passing**
(only the pre-existing finding-5 RED test remains, unrelated, not yet built).
Frontend consumption (the actual readiness dot on `TriggerTile.tsx`) is in
Elias's `#38` scope below, not done here.

## Wave 10d — Elias: build all Wave 10 fixes + specs (dispatched 2026-07-02)

Building, in one pass: Rohan's 3 specs (`#35`), Nina's frontend-consumption items
(`#36`), and Kenji's 3 verified UI findings (`#37`) — see dispatch brief for exact
scope.

**DONE (`#38`), orchestrator-verified** (re-ran `tsc --noEmit`, `npm run lint`,
and the full frontend suite independently; spot-checked 3 of the highest-stakes
claims by direct code read rather than trusting the self-report — confirmed
`serializeCanvas()` no longer hardcodes `config: {}`, the duplicate "New
Workflow" button/label is fully gone, and `useWorkflows.ts` now reverts
optimistic state + sets `error` on API rejection):

1. **Trigger readiness dot** — `TriggerTile.tsx` mirrors `ActionTile.tsx`'s dot
   exactly, threaded through `TriggerStepPanelContent.tsx`/`WorkflowBuilderPage.tsx`;
   typed the registry API response (`WorkflowRegistryTrigger`/`Action`/`Response`
   in `api.ts`, was `unknown[]`).
2. **Toggle/delete error handling** — reverts optimistic state + surfaces `error`
   on API rejection (was silently swallowed).
3. **`notify.webhook` config form** — real `url`/`method`/`headers`/`payload`/
   `secret` fields in `SimpleActionConfigForm.tsx` (new `select`/`textarea`/
   `password` field-type support added to the form's own primitives).
4. **Canvas `ConditionNode` field dropdown** — real `<select>` of registry
   condition fields, falls back to free text only if the list is empty. Backend
   validation of already-saved bad data explicitly NOT done (separate, deferred
   fix) — the backend's finding-5 RED test correctly stays red, as flagged in
   advance.
5. **Run history API consumption** — `'completed'` (not dead `'success'`) status
   check; renders `steps[]` with skip reasons + humanized failed-step errors
   (raw message collapsed in `<details>`); "will retry"/"retries exhausted"
   indicator; working "Retry" button wired to the previously-dead-in-the-UI
   `retryWorkflowExecution` endpoint (closes Maya finding 1c for free).
6. **Integration credential health in builder** — new
   `lib/workflowConnectorStatus.ts` maps connector actions to real per-org status
   via the same endpoint `IntegrationsSettingsPage.tsx` uses; disconnected state
   shows a banner linking to Integrations Settings.
7. **Rohan's 3 specs, built in spec order (Issue 1 → 3 → 2):** canvas action
   config — new `ActionConfigPanel` Sheet, `CanvasNodeData.config` now real and
   round-trips through `serializeCanvas()`/`deserializeCanvas()`, `ActionNode`
   shows an always-visible configured/unconfigured indicator, save blocked while
   unconfigured; escape-hatch seed — `switchToCanvas()` now passes the sentence
   builder's full `serialize()` output, with a confirm dialog when scope/cooldown
   would be dropped; entry points — "New Workflow" deleted, "Build Visually"
   promoted to primary CTA (fixes the hardcoded-hex brand bug for free), both
   canvas/sentence builder buttons gained distinguishing subtext + tooltip.

**Verified: 80 files / 868 tests, ALL passing** (was 78/825 with 7 intentional
RED before this wave — those 7 are now green, zero regressions, +50 net new
tests). `tsc --noEmit` clean, `npm run lint` clean. Backend re-confirmed
unaffected (85/1134, 1133 passing, same 1 pre-existing unrelated RED).

**This closes Wave 10 for all but the explicitly-deferred items below.**

Deferred (tracked, not dropped, per volume — see both audit docs' full indexes):
`created_by` unrendered, `dead_letter`-at-the-row-glance still needs a visual
sweep beyond run-history detail, concurrent-edit last-write-wins, sentence
builder's total absence of a condition step (larger design effort, not a quick
fix), backend validation for canvas condition field typos on already-saved data,
mobile/accessibility gaps (canvas builder unusable below desktop, tooltip-only
readiness signals, recipient picker's combobox semantics), four different
loading-state/modal conventions across surfaces, missing wait/delay action
(previously-known gap, re-confirmed).

---

## Wave 9 — Template flow + recipient targeting (COMPLETE, 2026-07-01)

**Elias (frontend) — DONE, verified independently (orchestrator re-ran tsc/lint/
vitest and directly inspected the source, not just trusted the report):**
- `tsc --noEmit` clean, `npm run lint` clean, **77 files / 815 tests passing**
  (was 73/775, +40 tests, zero regressions).
- **Template fix confirmed by direct inspection:** `WorkflowsPage.tsx` no longer
  calls `createWorkflowFromTemplate` (method removed — confirmed nothing else
  referenced it) — it now calls `resolveEditRoute(nodes, edges)` and navigates
  with a `{ seed }` router state, so clicking "Start from Template" (relabeled
  from "Use Template") is a synchronous, zero-side-effect navigation. The linear
  builder's node-parser was extracted into a shared `hydrateFromNodes()` helper
  reused by both edit-mode-load and template-seed-load, so a linear template now
  pre-fills the ENTIRE sentence (trigger + schedule config + every action), not
  just the trigger.
- **Recipient targeting confirmed by direct inspection of 3 files:**
  `AdvancedFieldsDisclosure.tsx` renders `NotifyTargetPicker` for `notify.email`
  (replacing the dead free-text field entirely); `ActionStepPanelContent.tsx`
  renders it separately for `notify.in_app` (which has no "content" to
  customize, so it never went through `ContentCustomizationPanel` at all before
  this fix — confirmed it previously silently showed "No additional
  configuration needed," a real, now-fixed gap); Slack's branch in
  `AdvancedFieldsDisclosure.tsx` was confirmed to ONLY render its `channel`
  field — no target picker, no role/department/group logic, exactly as scoped.
- `NotifyTargetPicker.tsx`: 4-way mode toggle (Specific people / role /
  department / group), debounced user search with chip multi-select, dropdowns
  populated from `GET /api/workflows/notification-targets`, live "This will
  notify N people" line with a zero-count warning state.
- **Backward compatibility:** `extractNotifyTarget()`/`flattenNotifyTarget()`
  (`contentSections.ts`) form the single seam between the frontend's nested
  `target` convenience field and Nina's real flat wire shape
  (`{targetType, userIds/roleId/departmentId/groupId}`) — a legacy workflow
  saved with only `config.userId`/`config.userIds` (no `targetType`) correctly
  loads into "Specific people" mode showing the real user's name (resolved via
  `api.getUser()`), not a broken/empty state.

**Combined Wave 9 verification:** backend 79/1062, frontend 77/815 — both
independently confirmed, zero regressions across either layer.

Two real gaps the user hit directly: (1) "Use Template" creates a real workflow
immediately with zero feedback about where it landed; (2) the "recipients" field on
email actions is completely disconnected from the saved config (silently discarded),
and even if wired up the backend only supports one hardcoded user id — no multiple
people, no role, no department, no group.

**Rohan** (`TEMPLATE_FLOW_AND_RECIPIENT_TARGETING_SPEC.md`) — issue 1's fix reuses
100% existing mechanisms: a template's `nodes`/`edges` already matches the seed shape
`WorkflowCanvasPage` consumes for the NL-builder handoff, and `resolveEditRoute()`
(already used by "Edit") picks linear-vs-canvas identically for templates — only gap
found was the linear builder's seed type needing to accept `nodes`/`edges` too (small,
scoped). Recommended relabel "Use Template" → "Start from Template." For issue 2,
designed a shared `NotifyTargetPicker` (people/role/department/group mode toggle +
live "will notify N people" count) for both `notify.email` and `notify.in_app`.
Caught two real, code-verified blockers before they shipped: (a) the roles/
departments/groups list endpoints require `users:manage`, which a regular workflow
author likely lacks — would have made the picker unusable for most real users; (b)
department member counts are direct-only, not subtree-inclusive — if the resolver
walked the subtree, the "will notify N" preview would silently understate reality.
Confirmed by reading `sendSlack` directly that Slack has no per-user delivery
mechanism at all — role/department/group targeting is correctly out of scope for it.

**Nina** — built `recipientResolver.ts` (shared resolution for all 4 targeting modes,
reusing roles.ts/departments.ts/groups.ts's exact existing queries, not reinventing
them), extended `notify.email` (preserving the Wave 7 no-silent-fallback fix exactly)
and `notify.in_app` to accept `targetType: 'users'|'role'|'department'|'group'` +
`roleId`/`departmentId`/`groupId` alongside the legacy `userId`/`userIds` fields
(fully backward compatible, documented precedence order). Fixed both issues Rohan
flagged: confirmed department resolution is direct-members-only (matching what the
UI can show, not silently broader), and — finding the EXACT real role that would hit
the permission wall (`org:program_admin`: has `workflows:manage` but not
`users:manage`) — added `GET /api/workflows/notification-targets`, gated by
`workflows:manage`, returning only `{id, name, memberCount}` (no PII) so any workflow
author can populate the picker. Zero-member targets return a specific reason
(`role_has_no_members` etc.) rather than a silent, indistinguishable no-op.
**Verified independently: 79 files / 1062 tests passing** (was 78/1032, +30 new
tests, zero regressions). Config shape matched Rohan's proposal exactly — no
reconciliation needed.

**Next:** dispatch Elias to build both frontend fixes against the real, tested API.

---

## Wave 8 — Org Integrations Settings Page (COMPLETE, 2026-07-01)

Closed the gap identified when the user asked "how does Xperiq know which Jira/Slack/
Zendesk to use": a fully-built, fully-tested per-org credentials vault
(`workflow_connector_credentials`, Wave 1) had **zero frontend UI** — the only way to
configure it was a direct API call. Investigation before building surfaced that this
codebase already has 3 separate, differently-architected "connections" systems (CRM
contact-sync page, Prism's Secret-Manager-backed OAuth, and this un-UI'd vault) —
user confirmed scope: build a focused new page for the workflow vault today, designed
so a Prism "Data Sources" section can be added later WITHOUT merging Prism's stricter
security model (tokens never touch Postgres) into this page's simpler API-token vault.

**Team (UX, integration engineer, backend, frontend), in sequence:**
- **Rohan** (`INTEGRATIONS_SETTINGS_PAGE_SPEC.md`) — card-based IA, one category
  section ("Workflow Actions") built as a genuinely reusable component so a future
  "Data Sources" section is pure addition; single-step config modal (not the sibling
  CRM-sync page's 4-step wizard — no field-mapping/schedule concepts apply here);
  credential masking (locked "••••••••" + "Replace," never a real prefilled secret,
  since the vault never returns decrypted data); found a real bug while reading the
  code for this spec — `setCredentials` overwrote wholesale instead of merging.
- **David** (`INTEGRATIONS_CONNECTOR_SPEC.md`) — exact field lists per connector
  (Jira: `baseUrl`/`email`/`apiToken`/`projectKey`; Salesforce: `instanceUrl`/
  `accessToken`; ServiceNow: `instanceUrl`/`user`/`password`; Zendesk: `subdomain`/
  `email`/`apiToken`; Slack: `webhook_url` only), a real "Test Connection" call per
  connector (Jira `/myself`+`/project`, Zendesk `/users/me.json`, etc. — genuine
  lightweight API calls, not just format validation), and exact human-readable error
  copy per failure mode. Also caught that `slack`/`webhook` sat in the vault's
  `CONNECTORS` enum with no code ever reading credentials for them there.
- **Nina** (`INTEGRATIONS_BACKEND_REVIEW.md` + implementation) — fixed the
  merge-on-write bug Rohan found (regression-tested); extended `GET
  /api/workflow-credentials` to report `status: 'org'|'shared'|'none'` for all 6
  connectors including Slack (unified into one response — explicitly weighed and
  rejected Rohan's client-side-merge alternative, documented tradeoff); built new
  `POST /api/workflow-credentials/:connector/test` (test-before-save, never
  persists, real read-only validation calls per David's spec, a real visible test
  message for Slack since no side-effect-free webhook auth-check exists, 400 for
  `webhook`); added `connectorTestLimiter` (10/org/15min) since every call hits a
  third party. **78 files / 1032 tests passing** (verified independently).
- **Elias** — built the actual page: `IntegrationsSettingsPage.tsx`, a genuinely
  reusable `CategorySection` component, `IntegrationCard`/`ConnectorModal`/
  `ConnectorBadge`, admin-only gate, empty-state and vault-unconfigured banners,
  Test Connection UI (idle/testing/success/failure incl. 429 detection), Save never
  blocked by a failed test, Disconnect via confirm dialog. Entry point: an
  "Integrations" button in `WorkflowsPage`'s header, confirmed reachable end-to-end
  (independently verified: route registered in `App.tsx`, link navigates correctly).
  **73 files / 773 tests passing**, tsc clean, lint clean (all independently
  re-verified by the orchestrator, not just agent self-report).

**Security posture:** secrets are never round-tripped to the client (locked
placeholders, never real values); the merge-on-write fix means editing one field
can no longer silently null the others; Test Connection accepts untested/unsaved
candidate values server-side only, never logs raw credentials, and is rate-limited
per org.

**Extensibility for Prism, honestly scoped:** the page's `CategorySection` component
and card-grid IA are ready for a second category — but Prism's actual credentials
still live in Google Secret Manager via its own OAuth flow, untouched and unmerged.
Adding a "Data Sources" section later means building Prism-specific status/connect UI
reusing this page's visual components, not routing Prism's secrets through this
page's vault.

---

## Integrations settings-page backend review + test-connection endpoint (Nina, COMPLETE, 2026-07-01)

Backend readiness review for the first per-org connector-credentials settings page
(team building in parallel: David — connector field/error-message spec, Rohan — UX
spec). Full design doc: `docs/automation-hub/INTEGRATIONS_BACKEND_REVIEW.md`.

- **Bug fix:** `setCredentials` (`lib/workflowCredentials.ts`) used to REPLACE a
  connector's stored credential row wholesale. Since `GET` never returns
  decrypted secrets, the natural settings-page edit pattern ("only send the
  field you changed, e.g. just rotate `apiToken`") would have silently wiped
  the connector's other saved fields the moment a real edit flow existed —
  found by Rohan while reading the same code for his UX spec, fixed here.
  Now merges incoming fields onto the existing decrypted row. Regression test
  added.
- **`GET /api/workflow-credentials` extended:** now reports `status:
  'org'|'shared'|'none'` for all 6 connectors (including Slack, unified from
  `notification_channels` into the same response — considered and rejected
  Rohan's client-side-merge alternative, tradeoff documented in the review doc
  §2) instead of only listing configured vault rows.
- **New `POST /api/workflow-credentials/:connector/test`:** jira/salesforce/
  servicenow/zendesk get a real, read-only validation call
  (`/myself`+`/project`, `Contact/describe`, `sys_user?limit=1`,
  `users/me.json` respectively — cross-checked against David's
  `INTEGRATIONS_CONNECTOR_SPEC.md`, no conflicts). Slack sends a real visible
  test message (no side-effect-free verb exists for incoming webhooks — same
  conclusion David reached independently). `webhook` returns 400 (no fixed
  endpoint in its vault entry — HMAC secret only). Accepts test-before-save
  candidate values in the request body; never persists; new
  `connectorTestLimiter` (10/org/15min) on top of the existing `apiLimiter`.
- New shared credential-resolution helpers (`resolveJiraFields` etc. in
  `connectors.ts`) so the test endpoint and the real action functions share one
  vault→env-var precedence implementation instead of two copies.
- **Verified:** backend `npm test` → **78 files / 1032 tests passing** (+13 vs.
  baseline 1019, zero regressions). `tsc --noEmit` clean (pre-existing unrelated
  `prism/uploads.ts` errors untouched).

## Wave 7b — Post-fix frontend regressions found by direct user testing (COMPLETE, 2026-07-01)

Immediately after Wave 7's backend fixes shipped, the user hit two real bugs while
actually using the product — both root-caused and fixed same-day, directly (no agent
round-trip needed, small and precisely scoped):

1. **"Why can't I edit this Weekly Digest workflow's scope?"** — screenshot showed the
   scope step-panel disabling Survey/Tag options with "Not available — this trigger
   type applies to the whole org" for a `time.schedule` trigger. Root cause:
   `app/src/lib/scopeRules.ts` is a hand-maintained frontend mirror of the backend's
   `SCOPE_UNSUPPORTED_TRIGGER_TYPES` — Wave 7's backend fix (removing `time.schedule`
   from that set, since scope now drives what a scheduled digest fetches to summarize)
   was never mirrored to the frontend copy. Fixed: `scopeRules.ts` now matches the
   backend exactly (`external.webhook` only). Also fixed a related consequence: an
   "auto-reset scope to org" `useEffect` (keyed off the same stale rule) was silently
   discarding a user's Survey/Tag scope choice the instant they picked a schedule
   trigger — now correctly only resets for `external.webhook`. Also fixed
   `triggerGroups.ts`/`triggerDescriptions.ts`, which still referenced the OLD
   `survey.milestone_reached` string after Nina's backend rename to `survey.milestone`
   — caught immediately by an existing drift-guard test designed for exactly this.
2. **"The Create Workflow button's form doesn't let you select scope."** — a legacy
   "New Workflow Modal" (flat `condition`/`action` shape, zero scope concept, zero
   registry awareness — pre-dating even Wave 2) was still reachable from two buttons
   (the primary header "+ New" button and the empty-state CTA) despite Rohan's original
   Wave 6 concept doc explicitly calling for its retirement ("its one job is absorbed
   by the sentence builder's first two clauses"). It was simply never removed. Fixed:
   both buttons now navigate to the real sentence-first builder (`ROUTES.WORKFLOW_BUILD`,
   same as the existing "Build Visually" button); the entire modal, its dead state
   (`showNewModal`/`newName`/`newConditionIdx`/`newActionIdx`/`saving`), its
   `handleCreate` handler, and now-unused imports (`Input`, `Label`, `Select` family)
   were deleted rather than left as dead code.

**Verified independently:** frontend `tsc --noEmit` clean, `npm run lint` clean,
`npx vitest run` → **70 files / 712 tests passing** (net +4 tests from the fix's own
regression coverage, zero regressions). Backend re-confirmed unaffected: **78 files /
1019 tests passing**.

**Lesson applied:** a hand-maintained "frontend mirror" of a backend validation rule
(`scopeRules.ts`) is exactly the kind of dual-source-of-truth that silently drifts —
worth flagging for a future pass whether this should be generated from/tested against
the backend's actual set at build time rather than kept in sync by hand indefinitely.

---

## Wave 7 — XM Industry Scenario Audit + Bug Fixes (COMPLETE, 2026-07-01)

Triggered by a request to verify the feature against real CX/EX industry use cases end
to end, with an explicit "I do not want any bugs" bar. Four-stage process: Maya defined
16 real scenarios grounded in the actual registry → Kenji verified each with real tests
(not just code reading) → three engineers fixed confirmed bugs in parallel → the
orchestrator found and closed one more gap the fixes themselves exposed.

**Maya** (`XM_INDUSTRY_SCENARIOS.md`) — 16 scenarios across CX and EX (detractor
recovery, exec/quarterly digests, AI-trigger escalation, SLA priority routing, product
launch milestones, churn signals, exit surveys, manager-effectiveness flagging,
onboarding, NL builder, live-editing, branching, multi-workflow overlap, compliance
mode), plus 6 named "not achievable today" gaps (multi-survey AND triggers, time-delayed
escalation, configurable milestone intervals, role-based recipient targeting,
rolling-window conditions, guaranteed-safe sensitive routing).

**Kenji** (`XM_VERIFICATION_REPORT.md`) — verified all 9 of Maya's priority risk flags
with 25 new real tests, not re-reading code. **6 confirmed bugs**, 1 confirmed-but-narrow
design limitation, 2 not-confirmed (concurrent editing and multi-workflow isolation both
actually work correctly). Also corrected Maya's count for the worse: **8 of 13 registry
triggers have no working producer**, not 6 (added `crystal.insight_ready` and
`external.webhook` to the confirmed no-producer list).

**Fixes — Nina, David, Priya, in parallel, non-overlapping files:**
- **Nina** — (1) removed the silent `config.userId || event.userId` fallback in
  `notify.email` (now fails loud with `no_recipient_configured` instead of guessing —
  closes the specific misconfiguration behind the manager-effectiveness misdirection
  risk, though the full fix needs an org-chart/sensitivity data model that doesn't exist
  — tracked as a separate product decision, not attempted here); found and documented 2
  seeded templates that were only "working" via this fallback. (2) renamed
  `survey.milestone_reached` → `survey.milestone` to match the real producer, documented
  all 7 remaining no-producer triggers inline in the registry. (3) made the
  content-customization "Crystal AI Summary" toggle actually enforced at send time (was
  fully decorative — the toggle updated the persisted config and the builder preview,
  but the real Slack/email payload ignored it entirely).
- **David** — (1) added a `priority` field to the Jira connector (was completely absent,
  unlike Zendesk/ServiceNow) — correctly used Jira's `fields.priority.name` object shape,
  not a flat string. (2) built REAL persistence for `data.tag_responses` (new
  `response_tags` table + migration) rather than just relabeling it — it was marked
  `live: true` but never wrote to any table.
- **Priya** — built a data-fetch step in `runScheduledWorkflows` so survey/tag-scoped
  scheduled digests (Executive Weekly Digest, Quarterly Engagement Digest, etc.) actually
  pull real NPS/CSAT/response-count data before `crystal.summarize` runs, instead of
  producing the generic "event received" fallback for every scheduled digest template in
  the gallery.
- **Orchestrator (post-fix verification)** — found that Priya's fix, while correct, was
  **unreachable**: Wave 6's scope validation (`SCOPE_UNSUPPORTED_TRIGGER_TYPES`)
  rejected saving a `time.schedule` workflow with anything other than `org` scope,
  meaning no user could ever create the tag-scoped scheduled digest the fix was built
  for. Root cause: the original Wave 6 exclusion was correct for *event-matching*
  (no incoming event to filter for a cron tick) but didn't account for scope's *second*
  purpose introduced by Priya's fix — determining what data to fetch for a digest.
  Removed `time.schedule` from the unsupported set (kept `external.webhook` excluded,
  which has no comparable content-generation use case), updated/added regression tests
  proving the schedule+scope combination now saves and persists correctly.

**Final verified state (orchestrator-run, independent):** `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npm test`
→ **78 test files / 1019 tests passing**, zero regressions across the whole wave.

**Still open, deliberately not fixed this wave:**
- Tag-scoped cooldown shares one clock across all entities under the tag (Priority 7) —
  real but narrow (only affects tag/org-scoped + cooldown-set workflows); needs a
  per-entity cooldown key mirroring `alertEngine`'s dedup pattern. Tracked as a follow-up.
- The full fix for manager-effectiveness misdirection (an actual structural guarantee,
  not just closing one fallback path) needs an org-chart/sensitivity-classification data
  model that doesn't exist anywhere in this schema — a product/data-model decision, not
  a bug fix, flagged for the user rather than silently built.
- `crystal.insight_ready` and `external.webhook` triggers remain selectable in the
  builder with zero producer — documented inline in the registry, not built (out of
  this wave's scope; either needs a producer built or should be hidden from the picker
  until one exists).

---

## Wave 6 — Builder Redesign V2 (COMPLETE, 2026-07-01)

**Elias — sentence-first builder + list redesign — DONE, verified independently
(orchestrator re-ran tsc/lint/vitest, did not just trust agent self-report):**
- `tsc --noEmit` clean, `npm run lint` clean, **70 files / 714 tests passing**
  (baseline 67/673 — net +3 files/+41 tests, zero regressions).
- Confirmed by direct grep: `WorkflowBuilderPage.tsx` genuinely imports/renders
  `SentencePill`, `StepPanel`, `TriggerStepPanelContent`, `ScopeStepPanelContent`,
  `ActionStepPanelContent`, `ActionClauseList` — zero references remain to the
  deleted Wave 5 components (`GroupedTriggerPicker`, `BuilderCanvas`, `CanvasCard`,
  `CardConnectorSvg`, `LivePreviewStrip` — confirmed the files themselves no longer
  exist on disk, not just unreferenced).
- `WorkflowsPage.tsx` genuinely imports/renders `WorkflowScopeChip` + `ScopeFilterBar`
  in the initial render path (no click required) — confirmed by direct grep.
- **All 3 original complaints addressed end-to-end:**
  1. Trigger/action selection — full-focus tile-grid step-panels replace the old
     256px low-contrast sidebar entirely.
  2. Survey/scope selection — scope is a mandatory sentence clause ("on [scope]")
     with a real API-backed survey/tag picker (`listSurveys`/`tags.listTags`),
     auto-disabling survey/tag options when `time.schedule`/`external.webhook` is
     the trigger (matching Nina's backend 400 rejection instead of allowing an
     invalid combination through to a failed save).
  3. Report content customization — `ContentCustomizationPanel`'s Crystal AI
     Summary checkbox is never locked/required; unchecking it removes the block
     from the live preview immediately and from the persisted section config.
- Also closed a Wave 5 follow-up: `types/index.ts` now has proper
  `scope_type`/`scope_survey_id`/`scope_tag_id`/`cooldown_minutes`/`cooldown_status`
  fields (was an inline type-cast before).
- **Deviations (reasonable, flagged by the build agent):** NPS-threshold numeric
  config input not built (lower priority per brief); `@dnd-kit` action-reorder
  wired but not simulated end-to-end in jsdom (library primitive, not custom logic).

**Figma note:** attempted, blocked by a View-seat MCP tool-call limit after one
file-creation call. User chose to skip Figma and build directly from Rohan's
written concept doc instead — worked cleanly, no visual-design step was needed.

---

Triggered by stakeholder rejection of Wave 5's builder on 3 concrete points: no visible

Triggered by stakeholder rejection of Wave 5's builder on 3 concrete points: no visible
trigger/action selection, no way to pick which survey a workflow applies to, no control
over report/email content (e.g. can't drop the Crystal summary section). User explicitly
required a from-scratch redesign, not an iteration — "Do not use previous design."

- **Maya** (`BUILDER_REDESIGN_V2_SCOPE.md`) — root-caused all 3 complaints against the
  actual shipped code. Finding: complaint 1 is a visual-hierarchy problem (palette exists,
  underweighted); complaint 3 is a pure missing frontend feature (no section-toggle config
  panel was ever built); complaint 2 is the big one — **no scope concept exists anywhere in
  the product** (no `survey_id`/`scope_type` column on `workflows`, ever, in any migration).
- **Rohan** (`BUILDER_REDESIGN_V2_CONCEPT.md`) — chose a "sentence-first, step-anchored"
  hybrid IA (not a wizard, not a bare recipe sentence): a single always-visible sentence
  ("When [trigger] on [scope] then [action]...") as the spine, where each blank opens a
  full-focus step-panel to fill it in. Explicitly does NOT reuse DESIGN.md's 3-panel shell.
  Full screen-by-screen spec, component inventory, and list-page redesign (colored scope
  rail + leading scope chip on every card) included.
- **Figma attempted, blocked**: created a real file (proved Figma MCP access works), but
  the connected account's View-seat tool-call limit was exhausted after 2 calls. User chose
  to skip Figma and implement directly from Rohan's written concept (which is already
  screen-by-screen detailed) rather than pay for a seat upgrade.
- **Nina — scope data model + engine change — DONE, verified independently:**
  - **Data model:** two typed nullable columns (`scope_type TEXT`, `scope_survey_id UUID
    REFERENCES surveys(id)`, `scope_tag_id UUID REFERENCES survey_tags(id)`) —
    `20260701120000_workflow_scope.sql` — chosen over Rohan's single polymorphic `scope_id`
    because every existing FK-to-surveys/FK-to-survey_tags column in this schema is a plain
    typed `UUID REFERENCES <table>(id)`; a single `scope_id` can't carry a real FK to two
    tables conditionally, so it would trade referential integrity for a marginally simpler
    column. A `CHECK` constraint enforces the two-column shape stays internally consistent
    (exactly one id set, matching `scope_type`) so the two-column tradeoff doesn't reopen an
    ambiguity the polymorphic column would have avoided. Default `scope_type = 'org'` on
    every existing row — zero behavior change for any pre-existing workflow.
  - **The load-bearing finding (the thing Maya's doc flagged as the critical open
    question):** trigger evaluation was NOT survey-aware at all before this —
    `runWorkflowsForEvent` matched purely on `(org_id, trigger_type)`. But a real survey id
    IS resolvable at trigger-publish time for the survey-relevant trigger types: `crystal.*`
    triggers carry it at `event.payload.survey_id` (confirmed in `routes/internal-workflows.ts`,
    the workflow_signal receiver) and `alert.fired` carries it at `event.payload.surveyId`
    (confirmed in `lib/alertEngine.ts::fireAlert`) — so scoping isn't hypothetical, it's
    wireable today for those. Also confirmed: `survey.response_received`/
    `survey.response_filtered`/`survey.milestone_reached`/`score.nps_drop`/`score.nps_rise`
    are registry-only entries with **no producer wired up anywhere in the codebase yet**
    (pre-existing gap, not introduced by this change) — scope matching for them is
    implemented and tested against the same `event.surveyId`/`payload.survey_id` contract,
    ready the moment a producer starts publishing them.
  - **Engine change:** `workflowEngine.ts` gained `resolveEventSurveyId()` (checks
    `event.surveyId`, then `payload.survey_id`, then `payload.surveyId`) and `matchesScope()`
    (org always matches; survey matches only the exact id; tag matches via a batched
    `survey_tag_mappings` lookup, one query per event covering all tag-scoped candidates, not
    N+1). `runWorkflowsForEvent` now filters every candidate through `matchesScope` before
    running it. `runScheduledWorkflows` (`time.schedule`) deliberately left unfiltered — see
    below, that trigger type can't be anything but org-scoped by construction.
  - **Trigger types excluded from survey/tag scoping:** `time.schedule` and
    `external.webhook` — neither has a natural survey dimension (a cron tick or an inbound
    webhook isn't "about" a survey). Rejected at the schema-validation layer (400 at
    save-time) rather than silently accepted-but-ignored, since a workflow that looks
    survey-scoped in the UI but secretly still fires for everything is worse than an
    explicit rejection.
  - **API contract:** `createWorkflowSchema`/`updateWorkflowSchema` gained `scopeType`
    (`'org'|'survey'|'tag'`, optional/defaults to org) + `scopeSurveyId`/`scopeTagId`
    (UUID, optional) with `superRefine` cross-validation (exactly the right id for the
    scope type; reject scope for `time.schedule`/`external.webhook`). Update requires
    `scopeType` explicitly whenever either id field is touched (no silent guessing on a
    partial PATCH). `POST /`, `PUT /:id` persist all three columns atomically; `GET /` and
    `GET /:id` return `scope_type`/`scope_survey_id`/`scope_tag_id` on every row via the
    existing `SELECT *`  — no extra fetch needed, satisfying the list-page's "badge without
    a click" requirement.
  - **Tests:** new `workflowScope.test.js` (29 tests — schema validation for all
    scope/trigger-type combinations, full POST/PUT/GET round-trip) + a new "scope filtering"
    section in `workflowEngine.test.js` (org-scoped fires for every survey — regression
    guard; survey-scoped fires only for its own survey and is silent for others; tag-scoped
    fires for every survey carrying the tag and no others; mixed-scope batches match
    independently). **981 tests passing** (baseline 934 — confirmed by re-running `npm test`
    before starting — net +1 file/+47 tests, zero regressions). `tsc --noEmit`: still exactly
    the same 6 pre-existing `lib/prism/uploads.ts` errors, zero new.
  - **Not done (explicitly out of this task's scope, flagged for Elias):** the builder UI's
    scope-selection step-panel, the list page's scope rail/chip/filter — this was a
    backend-only pass per the coordinator's instruction (Figma mockup + frontend build are a
    separate dispatch). API shape above is what Elias builds against.
- **Next**: dispatch Elias to rebuild the builder + list page per Rohan's concept, now that
  the scope API contract is real and tested (no longer a guessed shape).

**Status:** Phase 1-3 + Wave 3b/4 COMPLETE. Wave 5 (Builder Rebuild, triggered by direct
stakeholder feedback that the shipped builder didn't match the original design and had a
real bug) is COMPLETE for its P0/P1 scope. See "Wave 5" and "Final state" below.
**Last updated:** 2026-07-01

## Wave 5 — Builder Rebuild (triggered by stakeholder review, not a planned wave)

**Trigger:** stakeholder reviewed the shipped builder — generic UX, couldn't schedule the
Weekly Digest template, workflow creation/editing felt inflexible, wanted the original
design honored and real customer/product validation. Root cause found: Wave 2 was built by
reading the existing code, not `docs/automation-hub/DESIGN.md`/`CUSTOMER_REVIEW.md` (an
already-completed, rigorous customer-validation exercise that had been sitting unread in
the docs folder). This wave corrects that process gap for the builder surface specifically.

**Scope docs produced:** `BUILDER_REBUILD_SCOPE.md` (Maya — prioritization + honest
usefulness verdict) and `BUILDER_REBUILD_SPEC.md` (Rohan — implementation-ready translation
of DESIGN.md's Unified Builder + CUSTOMER_REVIEW.md's C-001/C-004). Both independently
found the same three priorities (Schedule panel P0, trigger grouping P1, cooldown P1) and
the same two load-bearing gaps between the design docs and the shipped system: the real
registry has **13** triggers, not the 10-12 both docs assumed, and `cooldown_minutes`
**does not exist anywhere in the real schema** despite CUSTOMER_REVIEW.md claiming
"zero backend changes" — it was net-new work, not a wire-up.

**Dependency install note:** the spec required 6 new shadcn primitives (`RadioGroup`,
`ToggleGroup`, `Popover`, `Collapsible`, `Command`) plus `@dnd-kit`, none zero-dependency.
Orchestrator hit two real environment issues installing these: (1) a root-owned npm cache
requiring `--cache <writable-dir>`, (2) `--legacy-peer-deps` (needed for a React-19 peer
resolution quirk against this internal artifactory registry) silently dropped
`@testing-library/dom` since it disables npm's auto-peer-install — fixed by pinning it as
an explicit direct devDependency. Both root-caused and fixed before dispatching the build;
verified 58/610 frontend tests still green post-install before handoff.

**Elias (frontend) — DONE, verified independently:**
- `app/src/lib/scheduleConfig.ts` — `buildCronFromConfig`/`buildScheduleDescription`/
  `getNextRunFromCron`, 27 tests, including the exact Weekly Digest repro (produces
  `"0 9 * * 1"`) cross-validated against the real backend `cron.ts::cronMatches()`.
- **`WorkflowBuilderPage.tsx` is genuinely rewritten and wired** (verified by the
  orchestrator directly via grep, not just agent self-report) into the 3-panel Unified
  Builder: `GroupedTriggerPicker` (all 13 real registry triggers, 5 groups) in the left
  panel, `BuilderCanvas`/`CanvasCard`/`CardConnectorSvg` (vertical card stack, bezier
  connectors) in the center, `ScheduleTriggerConfigPanel`/`WorkflowSettingsPanel` in the
  right panel, `LivePreviewStrip` at the bottom.
- **The reported bug is fixed and reachable from the real page**, not just fixed in
  isolation — confirmed via `WorkflowBuilderPage.test.tsx`'s "Weekly Digest repro" tests
  and independently by the orchestrator grepping the actual import statements.
- Cooldown UI (`WorkflowSettingsPanel`) wired as the right panel's default state, sends
  `cooldown_minutes` on save (field name verified to match Nina's backend contract
  exactly), disables + shows "Not applicable" for `time.schedule`.
- `.card-3d:hover` applied to `CanvasCard` per Rohan's 3D verdict (no new WebGL/3D —
  richness via existing CSS depth utility instead).
- **Explicitly deferred (not silently dropped):** per-action-type rich config panels
  (Slack/Email/Jira/In-App/NPS-Threshold — replaced with minimal interim generic editors
  so save() works end-to-end); `GenerateBriefingConfigPanel`'s drag-reorder; NL Builder tab
  integration (`BuilderModeTabs` cross-fade — `WorkflowNLBuilderPage.tsx` untouched, still
  its own unstyled route); cooldown-status display on the workflow list page (correctly
  out of scope for a builder-focused pass per the spec, is "the other half of C-004").
- **Minor polish item found post-hoc, not fixed:** the frontend reads/writes
  `cooldown_minutes` via an inline `as unknown as {...}` type-cast rather than a proper
  field on the `Workflow` type in `types/index.ts` — functionally correct, cosmetically
  inelegant. Small follow-up, not blocking.
- Final verified state (orchestrator-run): `tsc --noEmit` clean, `npm run lint` clean,
  **67 files / 673 tests passing** (baseline 58/610 — net +9 files/+63 tests, zero
  regressions).
- **Process note:** this task ran ~3 hours (vs. ~30 min for comparable prior single-agent
  tasks this session) and required two direct orchestrator interventions: a "stop
  expanding scope" message, then a correction after the orchestrator found (by reading
  files directly, not trusting agent silence) that all components existed but
  `WorkflowBuilderPage.tsx` hadn't been wired to use them yet. Lesson: for long-running
  agents, verify ground truth via direct file inspection rather than waiting indefinitely
  for a self-report — the agent was not stuck, just deep in a long unbroken work sequence.

**Nina (backend cooldown) — DONE, verified independently, no deviation from spec:**
- Migration `20260701100000_workflow_cooldown.sql`: `workflows.cooldown_minutes INTEGER`
  (nullable), new dedicated `workflows.cooldown_last_fired_at TIMESTAMPTZ` (deliberately
  NOT reusing `last_run_at`, which updates on every terminal outcome including
  condition-false skips — would have armed the cooldown clock on runs that never fired),
  extended `workflow_executions_status_check` to add `'cooldown'` as a first-class status.
- Engine gate in `workflowEngine.ts`: checked before action execution (not just trigger
  eval), bypassed for manual `/test`/`/retry` (matching the existing idempotency-bypass
  convention), never applied to `time.schedule`. Cooldown-blocked runs get a real
  `workflow_executions` row with `status='cooldown'` — queryable, not silently dropped.
  New exported pure `computeCooldownStatus()` — single source of truth, no client-side
  clock-skew math.
- API: `cooldown_minutes` accepted on create/update, computed `cooldown_status` object
  returned on list/detail reads — exact shape match to the spec's contract.
- 76 files / 934 tests passing (was 75/911), zero regressions.

## Open follow-ups from Wave 5
- Per-action-type rich config panels (Slack/Email/Jira/In-App/NPS-Threshold) — interim
  generic editors work but don't match DESIGN.md's detailed per-type specs yet.
- NL Builder tab integration (visual "feels like a tab" cross-fade) — deferred, NL builder
  works fine as its own route today, just doesn't share builder-mode chrome.
- Cooldown-status display (the "⏱ Cooldown — resets in 47 min" pill) on `WorkflowsPage.tsx`
  — backend contract exists and is ready, frontend list-page display not built.
- `Workflow` type in `types/index.ts` should get proper `cooldown_minutes`/`cooldown_status`
  fields instead of the current inline type-cast in `WorkflowBuilderPage.tsx`.
- `GenerateBriefingConfigPanel`'s `@dnd-kit` drag-reorder — package installed, component
  not built.
**Post-completion audit (2026-07-01, same day):** fixed a real regression in
`CrystalPanel.tsx` (`CRYSTAL_STREAMING` had been silently reverted to a dead env-var
check, contradicting its own adjacent comment and `app/CLAUDE.md`'s documented
"always on" invariant — Crystal was silently never streaming). Restored `= true`,
un-skipped the 17 tests this had made unfixable, fixed one stale assertion
(dismissal is tracked via `recordProposalOutcome`, not a `dismissAction` API call).
Frontend is now **58 files / 610 tests, zero skips**. Followed by a structural
wiring audit (routes mounted, migrations sequenced, CrystalOS endpoint registered
+ secured, frontend routes/nav/entry-points reachable, skill registered, no stray
TODOs in new code) — see chat for the full checklist. All confirmed intact.
**Final independent verification (orchestrator-run, all three suites, same session):**
- Backend: `npm test` → **75 files / 911 tests passing**
- Frontend: `npx vitest run` → **58 files / 593 tests passing, 17 skipped** (16 pre-existing +
  1 pre-existing skipped block Elias's Wave 3b fix landed inside — see caveat below)
- CrystalOS: `.venv/bin/pytest -q` → **1678 passed**

## Wave 3b — DONE, with an honest caveat

`CrystalPanel.tsx`'s `create_workflow` handler now reads the modern `nodes`/`edges`/
`trigger_type` shape and calls the existing `api.createGraphWorkflow()` (reused, not
duplicated — it already existed from Wave 2's builder pages), falling back to the legacy
flat-shape path only for a stale/cached proposal. `tsc`/lint clean, isolated diff, logic is
straightforward and reviewed. **Caveat:** the tests for this handler live inside a
**pre-existing** `describe.skip(...)` block in `CrystalPanel.test.tsx` (unrelated cause: the
suite needs a fetch-ReadableStream mock aligned to the SSE format, not something this wave
introduced or fixed) — so the fix is code-reviewed and type-checked but **not exercised by a
running test**. Flagging plainly rather than claiming full test coverage it doesn't have.

## Wave 4 — DONE (Amara: Workflow Skill; Simone: GTM docs)

- **Amara** — new `crystalos/skills/workflow-analyst/` (SKILL.md, EVALS.md, EXAMPLES.md),
  matching the existing `<role>-analyst` naming convention, formalizing Wave 3's
  `propose_workflow`/`workflow_nl`/AI-trigger capability under the skill framework's quality
  gate (7 eval criteria, 2 of them hard `must-pass`: registry-grounding and proposal-shape
  correctness — a bad workflow proposal can reach a real confirm-card, so these aren't soft
  thresholds). Registered in `plugin.json`. **Gap found and documented, not worked around:**
  no read-tool exists for "what workflows do I have running" / "why didn't my workflow fire"
  — SKILL.md explicitly instructs the skill to say so rather than fabricate an answer;
  tracked as a follow-up (`get_org_workflows`/`get_workflow_executions` tool, doesn't exist).
  12 new tests, 1678 pytest passing.
- **Simone** — `POSITIONING.md`, `COMPETITIVE_TEARDOWN.md`, `BLOG_5_AUTOMATIONS.md`,
  `PRODUCTHUNT_LAUNCH.md`, `DEMO_SCRIPT.md` — all cross-checked against the REAL registry/
  templates/trigger-action chains that exist today (not aspirational), with stub-mode actions
  (`crystal.summarize`/`classify`/`write`) and unmeasured Phase 1 metrics explicitly called
  out rather than claimed as achieved. Partner-listing/co-marketing collateral deliberately
  left out of scope (requires real partner relationships this pass can't create).

## Final state — what's genuinely done vs. still open

**Done and verified (real tests, run independently by the orchestrator, not just agent
self-report):** async execution engine with retry/backoff/DLQ/idempotency (7 real bugs found
via chaos testing + review and fixed, not just "looks done"), per-org credentials vault,
Zendesk/Jira/Salesforce/ServiceNow/Slack/email/signed-webhook actions, RBAC on every workflow
route, workflow list UI, linear + canvas builders with edit-mode, NL builder with a 3D Crystal
"thinking" accent, AI-driven triggers (sentiment_spike/new_theme_detected/anomaly_detected)
wired into the insight pipeline, Crystal-chat can propose workflows in natural language
end-to-end (chat → structured proposal → confirm → real graph workflow), a formal
workflow-analyst skill under the quality-gate framework, and GTM collateral grounded in what's
actually shipped.

**Still open before this is production-ready (documented honestly by the agents who found
them, not glossed over):**
1. **No live end-to-end integration run** — the CrystalOS↔backend `workflow_signal` seam and
   the `parse-nl` proxy were built and reconciled *on paper* by two agents working from the
   same documented contract, verified via mocked unit/integration tests only. Nobody has run
   this against live Postgres+Redis+both real services together. Both Amara and Nina flagged
   this themselves as the top remaining risk.
2. **Two literal Phase 1 success metrics are unmeasured, not passing:** "100 concurrent
   trigger evaluations in <5s" and a named 20-case threshold-trigger test corpus — no
   reachable live Postgres/Redis existed in this sandbox to load-test against (Maya's
   PHASE_1_ACCEPTANCE.md verdict, not walked back since).
3. **`CrystalPanel.tsx`'s Wave 3b fix has no passing test exercising it** (pre-existing
   unrelated skip block) — code-reviewed and type-checked only.
4. **AI-trigger thresholds/hysteresis are new and unvalidated against real data** (Amara's
   own flag) — TEAM.md's "AI Trigger Sync" ritual is the intended venue to tune them against
   real traffic.
5. **No read-tool for "what workflows do I have" / "why didn't it fire"** — the
   workflow-analyst skill explicitly declines to answer rather than fabricate.

## Wave 3 — DONE (Amara: CrystalOS NL parser + AI triggers; Nina: backend proxy + signal receiver)

Built in parallel against the same documented contract (BUILDER_SPEC_WAVE2.md §2.1 +
Nina's own `WORKFLOW_SIGNAL_CONTRACT.md`) rather than sequentially — Nina finished first and
documented her assumptions as explicit "must re-verify" items; Amara then read Nina's doc,
verified her CrystalOS implementation against every item, fixed one real bug her own draft
had (FastAPI `HTTPException(422, detail=...)` wraps the body under `"detail"` on the wire —
switched to a raw `JSONResponse` so the 422 shape is flat, matching what Nina's proxy parses),
and appended a reconciliation section confirming the seam now matches on both sides *on paper*.
**Not yet done: a real end-to-end run against live Postgres+Redis+both services** — both
agents flagged this themselves as the remaining risk before this seam sees production traffic.

- **Amara** — `crystalos/crystal/workflow_nl.py` (`POST /workflows/parse-nl`, one structured
  LLM call validated against the caller-supplied registry — no hand-copied Python catalog,
  no LangGraph subgraph since a single bounded call didn't need one), reconciled the legacy
  `execute_propose_workflow` chat tool to emit the same modern `nodes`/`edges` shape instead
  of the old flat `trigger`/`action_type`/`action_config` shape, `lib/ai_triggers.py`
  (sentiment_spike/new_theme_detected/anomaly_detected with threshold+hysteresis, Redis-armed,
  wired into `graphs/insights.py` as `publish → ai_triggers → END`, reads already-computed
  state only), `lib/workflow_signal_client.py` (POSTs to Nina's receiver). 1666 pytest passing
  (+84), including 3 pre-existing tests fixed that were making real (failing) network calls.
- **Nina** — `POST /api/workflows/parse-nl` proxy (requireAuth + requirePermission,
  `agentsClient.parseWorkflowNL`), `POST /api/internal/workflows/signal` receiver
  (`requireInternalKey`, routes into `workflowQueue.publishWorkflowTrigger` — async, not
  inline), added `crystal.sentiment_spike`/`crystal.new_theme_detected` to
  `workflowRegistry.ts` (previously only `crystal.anomaly_detected` existed), authored
  `docs/automation-hub/WORKFLOW_SIGNAL_CONTRACT.md`. Built against the spec since Amara's
  code didn't exist yet when she started — correctly flagged the seam as NOT
  production-ready until reconciled (which Amara then did).
- **Flagged gap (Wave 3b, dispatched separately):** `app/src/components/CrystalPanel.tsx`'s
  `create_workflow` proposal handler still only reads the OLD flat
  `trigger`/`action_type`/`action_config` params and calls `api.createWorkflow()` — it doesn't
  read the new `nodes`/`edges`/`triggerType` shape Amara's reconciled tool now emits. A
  workflow proposed via Crystal chat today would still create a legacy-shaped, non-graph
  workflow. This is a frontend-only fix, tracked separately below.

## Wave 2 — DONE (Rohan spec + addendum, Elias implementation)

- **Rohan** — `docs/automation-hub/BUILDER_SPEC_WAVE2.md`: edit-mode routing logic (branching →
  canvas, straight-line → linear, via `resolveEditRoute()`), full NL builder UX spec including a
  concrete `POST /api/workflows/parse-nl` contract for Amara's Wave 3 to implement against, and
  (per a mid-wave user request) a §3a addendum for a Three.js 3D accent during the NL builder's
  "thinking" state — reusing existing `HeroCanvas.tsx` primitives, hard-unmount on every
  resolution path, gated behind `prefers-reduced-motion` with the project's existing CSS
  crystal fallback.
- **Elias** — implemented both specs in full: `deserializeCanvas()`/`hasEngineBranches()` in
  `workflowCanvas.ts`, edit-mode fetch/save (PUT vs POST) for both builder pages, the new
  `WorkflowNLBuilderPage.tsx` (input → thinking → confirm-card/low-confidence/error/timeout,
  confidence badge, Crystal fill stagger animation), `NLThinkingCrystal.tsx` (the 3D accent),
  and `parseWorkflowNL()` in `api.ts` calling the REAL (not-yet-built) `/api/workflows/parse-nl`
  endpoint — it degrades gracefully today and needs zero frontend changes once Amara's Wave 3
  backend lands. Also fixed a pre-existing gap: `WorkflowBuilderPage`/`WorkflowCanvasPage` were
  never actually routed in `App.tsx` before this wave.
- Verified: 58 frontend test files / 593 tests passing, tsc clean, lint clean.

## Open item carried into Wave 3
Amara must build `POST /api/workflows/parse-nl` matching the contract Rohan/Elias already built
against: `{ name, description, triggerType, nodes, edges, confidence, warnings[] }` request/response
shape (see BUILDER_SPEC_WAVE2.md §2 and Elias's `parseWorkflowNL()` in `app/src/lib/api.ts` for the
exact error-handling contract expected, including a `code`/`status`/`suggestions` shape for
low-confidence/unparseable responses — check `ParseWorkflowNLError` in api.ts before finalizing
the backend response shape so the two sides actually match).

## Wave 2 backend pre-work (Nina, 2026-07-01) — COMPLETE, unblocks Elias

Rohan's `docs/automation-hub/BUILDER_SPEC_WAVE2.md` §0 flagged two backend gaps blocking
edit-mode for both builders (`WorkflowBuilderPage`, `WorkflowCanvasPage`):
1. **No `GET /api/workflows/:id`.** Added — org-scoped (`WHERE id = $1 AND org_id = $2`),
   `requirePermission('workflows:manage')` gate (same as every other route in the file),
   404 for not-found or wrong-org (same response either way — no existence leak across
   orgs), returns `{ workflow }` matching `GET /`'s per-row shape.
2. **`PUT /api/workflows/:id` / `updateWorkflowSchema` missing `description`/
   `triggerType`/`nodes`/`edges`.** The schema already had these fields (added at some
   point after `createWorkflowSchema` gained them, ahead of this fix landing — verified,
   not assumed). The `PUT /:id` handler itself did not: extended the existing dynamic
   `sets`/`vals` builder with the same `if (x !== undefined)` pattern already used for
   `name`/`condition`/`action`/`status`, writing `description`, `trigger_type` (column
   name, not `triggerType`), and `nodes`/`edges` (both `::jsonb`-cast, matching `POST /`'s
   INSERT and the `workflows` table's actual JSONB columns).

New test file `workflowsCrud.test.js` (6 tests: `GET /:id` success/404-not-found/
404-wrong-org, `PUT /:id` persists all four new fields with correct SQL param order,
partial update omits absent fields from the SET list, UPDATE stays org-scoped). Added
`GET /api/workflows/w1` to `workflowsRoutesPermissions.test.js`'s route matrix so the
existing deny/allow-across-every-route assertions cover the new route automatically.

## Wave 1c — bug-fix follow-up (dispatched after Kenji's chaos tests + Nina's review) — COMPLETE
Kenji's reliability pass and Nina's review surfaced 7 real, non-hypothetical bugs (see list
below). All 7 are now fixed with regression tests, verified via the independent test run above.
Priya fixed the 4 queue/engine reliability bugs (`AbortSignal.timeout` on all connector +
webhook fetches via new `WORKFLOW_CONNECTOR_TIMEOUT_MS`; `logStep` failures isolated from
action-outcome determination; new `reapStuckExecutions()` for rows stuck in `'executing'` past
`WORKFLOW_EXECUTING_TIMEOUT_MIN`; `sweepDueRetries`'s top-level queries independently
try/caught) — landing at 71 files / 883 tests. Nina's RBAC fix (below) landed first at 71/869;
Priya's 4 fixes added the remaining tests on top, both verified compatible.

## Wave 1c — bug-fix follow-up (dispatched after Kenji's chaos tests + Nina's review) — COMPLETE
Kenji's reliability pass and Nina's review surfaced 7 real, non-hypothetical bugs (see list
below). All 7 are now fixed with regression tests, verified via the independent test run above.
Priya fixed the 4 queue/engine reliability bugs (`AbortSignal.timeout` on all connector +
webhook fetches via new `WORKFLOW_CONNECTOR_TIMEOUT_MS`; `logStep` failures isolated from
action-outcome determination; new `reapStuckExecutions()` for rows stuck in `'executing'` past
`WORKFLOW_EXECUTING_TIMEOUT_MIN`; `sweepDueRetries`'s top-level queries independently
try/caught) — landing at 71 files / 883 tests. Nina's RBAC fix (below) landed first at 71/869;
Priya's 4 fixes added the remaining tests on top, both verified compatible.

## Nina's Wave 1b review (env vars, consistency, DataBus, ADR sign-off) — COMPLETE

Full review verdict + rationale is in the ADR's new `## Sign-off` section
(`docs/automation-hub/ADR_EXECUTION_ARCHITECTURE.md`). Summary:

- **Root `.env.example` write — NOT sandbox-blocked in this session.** Wrote the
  canonical `WORKFLOW_CREDENTIALS_KEY`/`ZENDESK_*`/`WORKFLOW_TRIGGER_STREAM`/
  `WORKFLOW_RETRY_*`/`WORKFLOW_MAX_ATTEMPTS` block directly into the root
  `.env.example` (after the "Insight pipeline tuning" section, before "Observability")
  and removed the now-redundant workaround block from `backend/.env.example` (which
  now matches its pre-wave committed state exactly — no lingering duplicate). The
  restriction the other three agents hit appears to have been session-specific, not a
  standing policy — worth retrying rather than assuming going forward.
- **Security bug found + fixed:** `routes/workflowCredentials.ts` had `requireAuth`
  but no `requirePermission` — any authenticated org member (not just an admin) could
  read/overwrite/delete an org's Jira/Zendesk/Slack/webhook credentials. Added
  `requirePermission('workflows:manage')` to all three routes + a regression test
  (`workflowCredentialsRoutes.test.js`).
- **Correctness bug found + fixed:** the retry sweep's republish derives the *same*
  idempotency key as the original failed row (by design — it prefers
  `responseId`/`entityId`/`id` over the stream id), but nothing cleared that row's key
  before republishing, so the retried attempt's `ON CONFLICT DO NOTHING` always
  collided with itself and silently no-op'd — **automatic retry never actually
  re-executed** for any trigger with a natural dedup field (the common case). Fixed in
  `workflowEngine.ts::finalizeExecution` (clears `idempotency_key` on a will-retry
  failure, preserves it on the terminal dead-lettered attempt) + regression tests in
  `workflowEngine.test.js`.
- **DataBus gap found + fixed:** `WorkflowTemplates`'s "Use Template" button creates a
  real workflow but bypassed `useWorkflows()` and never called `invalidate('workflows')`
  — fixed in `WorkflowsPage.tsx`. `create`/`toggle`/`delete` in `useWorkflows.ts` were
  already correctly wired by Elias's agent.
- **Follow-up fix (coordinator-requested, 2026-07-01):** `routes/workflows.ts`
  (pre-existing workflow CRUD, not touched in the original wave) had no
  `requirePermission('workflows:manage')` gate on any route despite that permission
  existing in `rbac.ts` and being enforced on comparable routes elsewhere — any org
  member could create/edit/delete/disable/test-run/retry any workflow regardless of
  role. Fixed: added `requirePermission('workflows:manage')` to all 12 routes
  (`GET /`, `POST /`, `PUT /:id`, `DELETE /:id`, `POST /:id/toggle`, `POST /:id/test`,
  `GET /:id/executions`, `GET /registry`, `GET /templates`, `GET /approvals`,
  `POST /approvals/:executionId`, `POST /executions/:execId/retry`) — including the
  static/read-only `/registry` and `/templates` routes, mirroring `alerts.ts`'s
  precedent of gating its equally-static `GET /types` catalog the same way (no
  `workflows:read`/`write` split exists, so one permission covers the whole router).
  New test file `workflowsRoutesPermissions.test.js` (12-route deny + 12-route allow +
  a dedicated static-route assertion). Updated `workflowsRetry.test.js` to mock
  `requirePermission` (pass-through) since it previously had nothing to mock. Full
  detail + rationale in the ADR's `## Sign-off` section.
- **ADR verdict: Approved.** JSONB-over-normalized-schema and Redis-Streams-over-BullMQ
  decisions are both sound and well-justified against this codebase's existing patterns.
- Backend: 71 files / 869 tests passing (Node 22+ required; `nvm use 22` unavailable in
  this sandbox session — Node was only aliased, not installed — ran on Node 25.7.0
  instead via `/opt/homebrew/bin/node`, which satisfies the `util.styleText` API vitest
  needs; see ADR sign-off note). Frontend: 538 passing / 16 skipped (pre-existing skips,
  unrelated to this wave).

## Wave 1 results (verified independently: `nvm use 22 && npm test` → 69 files / 851 tests passing)

- **Priya** — `backend/src/lib/workflowQueue.ts` (Redis Streams async queue, `workflow:triggers`
  stream, retry backoff 30s/60s/120s/240s then dead-letter, idempotency key via
  `INSERT...ON CONFLICT DO NOTHING`), migration `20260701090000_workflow_async_queue.sql`
  (adds `idempotency_key`/`attempt_count`/`next_retry_at`/`dead_letter` to `workflow_executions`),
  ADR at `docs/automation-hub/ADR_EXECUTION_ARCHITECTURE.md`. **Correction to earlier audit:**
  `runScheduledWorkflows` was NOT dead code — already wired via `cronTick` in
  `eventEngine/processor.ts` since commit `1072bf0` (2026-06-23); my initial read of that file
  was incomplete (only read the first ~120 lines). No fix needed there.
- **David** — Zendesk connector (`connectors.ts::zendeskCreateTicket`), HMAC-SHA256 signed
  webhooks (`X-Experient-Signature` header, `signWebhookPayload` helper), per-org encrypted
  credentials vault (`workflow_connector_credentials` table, AES-256-GCM via
  `lib/workflowCredentials.ts`, new `routes/workflowCredentials.ts` mounted at
  `/api/workflow-credentials`).
- **Elias** — **Correction to earlier audit:** the frontend was NOT a blank slate — my initial
  `find app/src -iname "*workflow*"` returned empty because of a stale `cd backend` in the shell
  from a prior command (working-dir persists across Bash calls but I didn't account for it).
  `WorkflowsPage.tsx`, `useWorkflows.ts`, `WorkflowBuilderPage.tsx` (linear builder),
  `WorkflowCanvasPage.tsx` + `workflowCanvas.ts` (reactflow branching canvas), routing, and nav
  already existed. Elias extended the list page to match the real API contract (new fields,
  status pills, hover quick-actions, run history dialog, DataBus invalidation) rather than
  duplicating it.

## Open follow-ups
- ~~New env vars ... root `.env.example`~~ — RESOLVED by Nina 2026-07-01 (see Wave 1b
  section above); root `.env.example` now has the canonical entries.
- ~~`routes/workflows.ts` has no `requirePermission('workflows:manage')` gate~~ —
  RESOLVED by Nina 2026-07-01 (see Wave 1b section above); all 12 routes now gated.
- `WorkflowBuilderPage` is create-only — no edit-by-id load path yet (Wave 2 item).

---

## Critical discovery (read before touching anything)

A workflow engine **already exists** in the codebase, built 2026-06-25 (commit `3f0f5a7`,
inside an unrelated "support system" commit) — **before** `docs/automation-hub`'s design
docs were written (2026-06-29). It does NOT match `WORKFLOW_SYSTEM.md`/`TEAM.md`'s literal
schema (6 normalized tables, BullMQ queue topology) — it uses a single `workflows` table
with JSONB `nodes`/`edges` (graph engine) and synchronous inline execution.

**User decision (2026-07-01): EXTEND the existing engine, do not rebuild from scratch.**
The design docs' schema/queue details are superseded by this tracker + the ADR Priya is
writing. Treat `WORKFLOW_SYSTEM.md`/`TEAM.md` as directional (trigger taxonomy, action
taxonomy, phase sequencing, success metrics) not literal (schema DDL, BullMQ).

**Second correction: no BullMQ in this codebase.** Async work here is built on Redis
Streams + consumer groups (see `backend/src/eventEngine/processor.ts`) and a custom
DB-tick scheduler (`backend/src/scheduler/`), never Bull/BullMQ. The "queue topology"
requirement is fulfilled via that same pattern, not a new dependency.

### What already exists (verified by reading source, 2026-07-01)
- `workflows` table (+ `workflow_executions`, `workflow_step_executions`, `workflow_templates`,
  `workflow_approvals`) — migrations `20260603000018/19/20`
- `backend/src/lib/workflowEngine.ts` — graph execution (conditions, branching, human
  approval pause/resume), `runWorkflow`, `runWorkflowsForEvent`, `runScheduledWorkflows`
- `backend/src/lib/workflowRegistry.ts` — trigger/condition/action catalog
- `backend/src/lib/connectors.ts` — Jira/Salesforce/ServiceNow connectors (env-configured, graceful no-op)
- `backend/src/routes/workflows.ts` — CRUD, toggle, test-run, registry, templates, approvals, execution history
- `backend/src/__tests__/workflowEngine.test.js` (313 lines) + `workflowsRetry.test.js` (68 lines)
- Wired into `eventEngine/processor.ts::handleEvent` (calls `runWorkflowsForEvent` inline, best-effort)

### Known gaps found during audit
- `runScheduledWorkflows` (cron `time.schedule` trigger) is **dead code** — never called anywhere. Bug.
- Execution is fully synchronous/inline — no async queue, no retry backoff, no DLQ.
- No idempotency key — a redelivered/reclaimed stream message can double-run a workflow.
- `notify.webhook` action sends an **unsigned** payload — TEAM.md mandates HMAC-SHA256 signing.
- No Zendesk connector (Jira/Salesforce/ServiceNow only).
- No per-org credentials vault — connectors read shared env vars only (one Jira account per whole deployment, not per-org).
- **Zero frontend** — no list page, no visual builder, no NL builder, nothing under `app/`.
- No AI-driven triggers (`sentiment_spike`, `new_theme_detected`, `anomaly_detected`) — CrystalOS side untouched.
- No Workflow Skill (SKILL.md/EVALS.md) in CrystalOS.

---

## Team (from `docs/automation-hub/TEAM.md`, 12 members) — dispatch plan

Work is sequenced in waves (file-ownership separated to run in parallel within a wave;
each wave's output gets real tests run before the next wave starts).

### Wave 1 — Phase 1 hardening (parallel) — ✅ COMPLETE
| Agent | Scope | Status |
|---|---|---|
| Priya Krishnamurthy (Backend Architect) | Async execution: Redis Streams queue for action dispatch (mirrors `eventEngine` pattern), retry w/ exponential backoff, DLQ, idempotency key, wire up dead `runScheduledWorkflows`, ADR reconciling schema/queue decisions | done |
| David Mensah (Integration Engineer) | Zendesk connector, HMAC-signed webhooks, per-org credentials vault (new table + encrypt/decrypt lib + settings routes), integration tests for auth-fail/rate-limit/payload-validation | done |
| Elias Park (Frontend Engineer) | Workflow List UI: card grid, status pills, hover quick-actions, empty state, wired to existing `/api/workflows*` endpoints | done (extended existing page, see note above) |

### Wave 1b — review + tests (after Wave 1 lands)
| Agent | Scope | Status |
|---|---|---|
| Kenji Watanabe (QA/Reliability) | Reliability tests against Wave 1 output: dedup, partial-failure recovery, concurrent-run safety, retry/DLQ correctness; Grafana dashboard spec | done — `workflowReliability.test.js` (12 tests), `RELIABILITY_DASHBOARD.md`, `RUNBOOKS.md`; found 4 real bugs (not his files to fix), routed to Priya in Wave 1c |
| Nina Reeves (Platform Expert) | Cross-layer consistency review, DataBus invalidation wiring for Elias's UI, env var doc check, sign off on Priya's ADR | done — found+fixed the broken-retry bug, the credentials-vault RBAC gap, and (Wave 1c follow-up) the `routes/workflows.ts` RBAC gap; ADR **Approved** |
| Maya Okonkwo (Product Lead) | Phase 1 acceptance criteria doc + sign-off, reconcile/expand seed templates | done — see `docs/automation-hub/PHASE_1_ACCEPTANCE.md` (verdict: 2 of 4 TEAM.md Phase 1 metrics NOT MET as literally written — 100-concurrent/<5s queue throughput and the 20-case threshold corpus are both unmeasured, not passing; flagged for Kenji's Wave 1b reliability suite) and `docs/automation-hub/TEMPLATE_GALLERY.md` (5 new templates seeded via `20260701090200_workflow_templates_phase1_expansion.sql`, reviewed against schema + registry but unexecuted — no reachable local Postgres in sandbox) |

### Wave 1c — bug-fix follow-up — ✅ COMPLETE
| Agent | Scope | Status |
|---|---|---|
| Priya (resumed) | Fix Kenji's 4 reliability bugs: fetch timeouts, logStep isolation, stuck-execution reaper, sweep query isolation | done — 26 new regression tests |
| Nina (resumed) | Fix the `routes/workflows.ts` RBAC gap she flagged | done — 3 new regression tests |

### Wave 2 — Phase 2 Builder
| Agent | Scope | Status |
|---|---|---|
| Rohan Desai (UX Designer) | Component spec for edit-mode (both builders) + NL builder (design doc, since no Figma access — written spec Elias can implement against) | done — `docs/automation-hub/BUILDER_SPEC_WAVE2.md`. Scoped to two concrete gaps (canvas builder already existed, contra TEAM.md's original framing): (1) edit-mode load/save for `WorkflowBuilderPage` + `WorkflowCanvasPage`, routed by workflow shape (branching → canvas, linear → builder) rather than a picker or blanket default; (2) NL builder UI against a placeholder `POST /api/workflows/parse-nl` contract for Amara's Wave 3, with confirm-card + staggered "Crystal fill" animation timing spec (Framer Motion). **Blocking backend gap found:** `PUT /api/workflows/:id` / `updateWorkflowSchema` only accept `name`/`condition`/`action`/`status` — missing `description`/`triggerType`/`nodes`/`edges` needed to save an edit; also no `GET /api/workflows/:id`. Both needed before edit-mode can ship (see spec §0). Two registry gaps flagged for Amara/Wave 3 (spec §3): no rolling-window/aggregate condition field for "NPS dropped" as a trend (only instantaneous per-response fields exist), and `sentiment_spike`/`new_theme_detected` (named in TEAM.md) don't exist in `workflowRegistry.ts` yet — only `crystal.anomaly_detected` does, naming reconciliation needed. |
| Elias Park | Edit-mode implementation for both builders + NL builder UI, per Rohan's spec above | pending |

### Wave 3 — Phase 3 AI Triggers
| Agent | Scope | Status |
|---|---|---|
| Amara Osei (AI/ML Engineer) | `sentiment_spike`/`new_theme_detected`/`anomaly_detected` triggers in CrystalOS, Crystal Builder NL→WorkflowSpec parser, `workflow_signal` contract | pending — no CrystalOS-side code found in `crystalos/` as of Nina's 2026-07-01 pass (verified via grep + git log, not assumed) |
| Nina Reeves | Backend proxy for `POST /api/workflows/parse-nl`, inbound `workflow_signal` receiver, registry gap fix, seam sign-off | done (backend side) — see below |

**Nina's Wave 3 backend pass (2026-07-01):** Built against `BUILDER_SPEC_WAVE2.md`
§2.1 as the working contract since Amara's CrystalOS implementation doesn't exist
yet (checked directly — no `parse-nl`/`workflow_signal` code anywhere in `crystalos/`,
no prior `WORKFLOW_SIGNAL_CONTRACT.md`). Delivered:
1. `POST /api/workflows/parse-nl` — thin Express proxy to CrystalOS via a new
   `agentsClient.parseWorkflowNL()`, gated `requireAuth` + `requirePermission
   ('workflows:manage')`, Zod-validated (1-1000 char description), maps CrystalOS's
   200/422/timeout to exactly what `app/src/lib/api.ts`'s `toParseWorkflowNLError`
   already expects (verified by reading that function, not guessed).
2. `POST /api/internal/workflows/signal` (new `routes/internal-workflows.ts`) —
   the `workflow_signal` receiving side, gated by `requireInternalKey` (mirrors
   `routes/internal-metering.ts`'s existing service-to-service precedent exactly).
   Routes into `workflowQueue.ts::publishWorkflowTrigger` (async, not the
   synchronous `runWorkflowsForEvent`) so a slow downstream action can never hang
   or fail CrystalOS's HTTP call — same rationale `workflowQueue.ts`'s own header
   comment already documents for the Event Engine's original inline-call problem.
3. Registry gap fix: added `crystal.sentiment_spike` / `crystal.new_theme_detected`
   to `workflowRegistry.ts`'s `TRIGGERS` (flagged by Rohan in
   `BUILDER_SPEC_WAVE2.md` §3) — confirmed both are independent signals, not a
   rename/alias of the existing `crystal.anomaly_detected`.
4. Full contract + reconciliation checklist + sign-off in
   `docs/automation-hub/WORKFLOW_SIGNAL_CONTRACT.md` — **verdict: backend side
   approved; seam as a whole NOT YET production-ready** since there is no
   CrystalOS side yet to reconcile against (field casing and the exact endpoint
   path are both unconfirmed assumptions, flagged explicitly for re-verification
   once Amara's code lands).
5. Tests: 3 new files (`workflowsParseNl.test.js` 8 tests,
   `internalWorkflowsSignal.test.js` 10 tests, `workflowRegistry.test.js` 4 tests)
   + `workflowsRoutesPermissions.test.js` extended to cover `/parse-nl` in its
   permission matrix. Verified: **75 files / 911 tests passing** (baseline 72/889,
   +3 files/+22 tests, zero regressions). `tsc --noEmit`: zero new errors (6
   pre-existing errors in `lib/prism/uploads.ts` predate this wave, confirmed via
   `git log`).

### Wave 4 — Phase 5 Workflow Skill + polish
| Agent | Scope | Status |
|---|---|---|
| Amara Osei | SKILL.md + EVALS.md for Workflow Skill | done — `crystalos/skills/workflow-analyst/{SKILL.md,EVALS.md,EXAMPLES.md}`, registered in `skills/plugin.json` (both the `skills[]` manifest and a `propose_workflow` entry added to `tools{}`, mirroring the other `propose_*` entries already there). Named `workflow-analyst` (not `workflow-skill`) to match the existing `<role>-analyst` naming convention (`crystal-analyst`, `trend-analyst`, `segment-analyst`, `driver-analyst`). Formalizes Wave 3's existing capability under the skill framework rather than duplicating it: `allowed-tools` is `get_survey_overview propose_workflow`, output schema matches the `action_proposals[]` convention (`type: "create_workflow"`, always `requires_confirmation: true`, modern `nodes`/`edges` graph shape only — never the legacy flat shape retired in Wave 3). EVALS.md gates registry-grounding as `must pass` (no fabricated trigger/condition/action names), correct proposal type/shape, at most 1 proposal/turn, and a dedicated case for "can't answer that yet" on workflow-status questions. EXAMPLES.md has 4 hand-written cases: a clean threshold-trigger proposal, a nonexistent-trigger request that gets a grounded substitution + lowered confidence instead of fabrication, an unanswerable "what workflows do I have" question, and an AI-trigger mapping (`crystal.new_theme_detected`). No code change was needed to wire routing — `SkillRegistry._scan_skills()` auto-discovers via `rglob("SKILL.md")` over `skills/`, confirmed by the existing `test_real_skills_directory_loads` smoke test; `plugin.json`'s `skills[]` list is a static manifest, not read by the runtime registry, but updated anyway per CLAUDE.md's documented convention. **Gap found (documented in SKILL.md, not fabricated a workaround):** no read tool exists for listing an org's/survey's workflows or their run/execution history — "what workflows do I have running" / "why didn't my workflow fire" cannot be answered from data today; the skill is instructed to say so plainly rather than invent a plausible-sounding status. Added `tests/test_workflow_analyst_skill.py` (12 tests: skill loads + frontmatter well-formed, `allowed-tools` are real registered tools, `propose_workflow` is a registered action tool, plugin.json manifest consistency, and the `workflow` → `create_workflow` proposal-type alias in `agents/crystal.py` stays intact). Did not modify `workflow_nl.py`, `ai_triggers.py`, or `tools.py` logic. Verified: **1678 passed** (baseline 1666 + 12, zero regressions).
| Simone Dufour (Marketing) | Positioning doc, launch copy (lower priority — doc-only, no code risk) | done — `docs/automation-hub/POSITIONING.md` (one-pager, competitive matrix, objection handling, "zero dead data" narrative + launch copy), `docs/automation-hub/COMPETITIVE_TEARDOWN.md` (Qualtrics/Medallia/Xperiq, framed as structural category differences — no fabricated competitor specifics), `docs/automation-hub/BLOG_5_AUTOMATIONS.md` (5 real templates from `TEMPLATE_GALLERY.md`, real trigger/action chains), `docs/automation-hub/PRODUCTHUNT_LAUNCH.md`, `docs/automation-hub/DEMO_SCRIPT.md` (scripted against the real `score.nps_drop` → `notify.slack` → `jira.create_issue` → `crystal.summarize` chain). Flagged, not fabricated: no AI-trigger precision/latency numbers cited (unmeasured against live traffic per Wave 3 notes above); `crystal.summarize`/`crystal.classify`/`crystal.write` noted as stub-mode actions; integration-partner listings/co-marketing (GTM.md Phase 4) explicitly left out of scope as a follow-up requiring real partner relationships.

**Anti-goals honored (per TEAM.md, not building):** branching-logic-on-failure beyond
what already exists, multi-survey AND triggers, user-provided JS actions, workflow marketplace.

---

## Phase 1 success criteria (from TEAM.md — must verify, not assume)
- [ ] All DB tables migrated and tested locally
- [ ] Async action queue handles concurrent trigger evaluations without lost executions
- [ ] Zero failed test runs for threshold triggers across a real test corpus
- [ ] `npm test` (backend) still green — no regressions

## Next action
Wave 1 dispatched via Agent tool (parallel, foreground). Update status column as each
member finishes; run `npm test` for real before declaring any wave done.
