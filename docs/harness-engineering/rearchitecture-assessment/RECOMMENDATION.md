# RECOMMENDATION: CrystalOS Harness-Rearchitecture Assessment

> Synthesizes `findings-reyes.md` (Research Scientist), `findings-priya.md` (AI Agent
> Engineer), `findings-marcus.md` (CrystalOS Architect), `findings-dana.md` (Backend),
> `findings-jordan.md` (Frontend) — all five read in full before writing this. Read those
> for complete file/line citations; this is the decision layer.

## The verdict, stated once

**All five team members, working independently from five different vantage points,
converged on the same answer without coordinating: do not rearchitect CrystalOS into a
"harness" shape. Adopt a short list of isolated, cheap, well-evidenced patterns instead.**

This unanimity across genuinely different lenses (empirical rigor, implementation
feasibility, deep-codebase risk, backend-contract safety, frontend-UX value) is itself the
strongest finding of the whole assessment. Nobody found a case for restructuring
`agents/crystal.py`'s ReAct loop or `lib/skill_runtime.py`'s execution pipeline into named
middleware/hook points. Three independent reasons why, one per team member who looked at
it directly:

- **Priya**: there is no framework runtime underneath CrystalOS's agent loop for hook
  names to attach to. QAH's `AgentMiddleware`/`wrap_tool_call` hooks work because
  deepagents/LangChain's own execution engine calls them at defined points. CrystalOS's
  `_react_plan_tools` is a hand-written async generator (necessary because OpenRouter has
  no native tool-calling — JSON-mode only). Naming positions in that generator "hooks"
  would be pure renaming of already-correct code against a ~1400-test regression surface,
  for zero new capability.
- **Marcus**: CrystalOS's routing/fallback/proposal-normalization core is not accidental
  complexity — it's "almost everywhere I read, deliberately reasoned-about code with
  comments that name the specific prior bug or design tradeoff each piece of subtlety
  exists to address." That's the opposite of what a harness rearchitecture is usually
  justified by.
- **Dr. Reyes**: most of the benchmark numbers used to motivate structural change (OpenAI's
  73%→85%, LangChain's ≤12-skill ceiling) are vendor-reported, measured on an *in-context*
  routing mechanism CrystalOS doesn't use (CrystalOS's `skill_registry.find()` is
  embedding-retrieval, not in-context selection) — the evidence doesn't actually transfer to
  a claim about CrystalOS.

Every team member also independently arrived at some version of "adopt small, well-scoped,
reversible patterns" rather than "no change" or "full rewrite" — so the actionable outcome
isn't "do nothing," it's a short, concrete list below.

## A correction to my own earlier synthesis (00-SYNTHESIS.md)

Dr. Reyes's research surfaced the single most important correction of this whole
assessment, and it needs to be stated plainly rather than buried: **`00-SYNTHESIS.md`'s
Tier 1 #5 ("add negative examples to skill `EXAMPLES.md` files") targets a file that has no
runtime effect on CrystalOS's routing or model behavior.** `SkillRuntime._build_system()`
(`lib/skill_runtime.py:276-306`) never reads `EXAMPLES.md` from disk — few-shot examples
come exclusively from the `skill_examples` Postgres table. Routing (`skill_registry.find()`)
embeds only the `description` frontmatter field, never `EXAMPLES.md`. Marcus independently
confirmed the same fact from the codebase side: 4 of 5 sampled skills have empty
auto-generated `EXAMPLES.md` placeholders, and even `workflow-analyst`'s populated one
(468 lines of real authored content) never reaches the model or router.

**The corrected recommendation**: add negative/counter-phrasing to the `description`
frontmatter field (the only text actually embedded for routing), not `EXAMPLES.md`. And
separately, unrelated to routing: decide `EXAMPLES.md`'s fate — either wire
`_build_system()` to fall back to parsing its worked examples when the DB bank is empty
(salvages real authoring investment already sunk into 8 skills), or delete the convention
entirely. Leaving it as dead weight that looks load-bearing is the one option ruled out.

## Ranked action plan

### Phase 0 — ship now, no design decision needed, ~3-5 engineer-days total (Priya's sizing)

1. **Formalize the tool-error contract inside `dispatch_tool` itself**
   (`crystal/tools.py:3799`). Today the `{"error": str(exc)}` convention is real but
   enforced only by every individual `execute_*` function remembering its own
   try/except — Marcus spot-checked ~15 and all comply, but the contract isn't
   structurally guaranteed. Wrapping the dispatch call once, at the single existing choke
   point every tool call already passes through, converts a discipline-based convention
   into a structural guarantee. **Both Marcus and Priya independently flagged this as the
   single cheapest, highest-leverage change in the entire assessment.**
2. **Collapse `_build_ctx(inp)` from 6 independent call sites to 1** (Priya, confirmed by
   Marcus). Every one of `_run_react_loop`, `_run_react_loop_streaming`, `_run_skill_loop`,
   `_run_skill_stream`, and `CrystalAgent.run`'s fallback rebuilds an identical
   `CrystalContext` today. `_build_ctx` is pure (no DB/LLM calls), so this is a
   near-zero-risk, mechanically verifiable refactor — build it once in the entry
   function, thread it through. Note Marcus's caveat: this is genuinely three different
   resolution shapes across three surfaces (Crystal chat, survey creation/editing,
   orchestration runs) — don't force a single "universal identity gate" across all three;
   Crystal's own `_build_ctx` consolidation is the well-scoped piece of this worth doing
   now.
3. **Provenance-stamp `TurnEvent`** with CrystalOS's own package version
   (`importlib.metadata.version`), alongside the already-logged `skill_name`/`skill_version`.
   Trivial, additive, zero backend/frontend impact (Dana confirmed: invisible on the wire).
4. **Route verbose tool/test output to logs, not agent-visible context** — applies to
   CrystalOS's own dev-loop pytest output, per the awesome-harness-engineering finding.
5. **Add a "when can this be removed" living table** to `crystalos/CLAUDE.md` — one row
   per legacy fallback (`?legacy=true` ReAct path, the difflib `find_sync()` router
   fallback, the dual EXAMPLES.md convention pending the decision above), each with
   `Exists because | Can be removed when`.
6. **Decide `EXAMPLES.md`'s fate** (see correction above) — wire it in or delete it. Either
   answer is fine; leaving it ambiguous is not.

### Phase 1 — small, independent fixes surfaced by this assessment (not harness-motivated, just found along the way)

Marcus's deep read surfaced several concrete simplifications independent of the harness
question at all — worth doing regardless of the rest of this document:

7. Consolidate `node_verify`'s four different magic-number trust-score demotion caps
   (45/55/60/65 across three code paths, `graphs/insights.py:4092-4150`) into one named
   constant table.
8. Add a runtime guard for Custom Analysis's "no predictive layer" invariant
   (`graphs/custom_analysis.py`) — currently enforced only by omission (no forecasting tool
   imported), with no assertion that would catch a future accidental violation.
9. Decide whether `TOOL_PERMISSION_MAP`'s 4-of-~60-tool coverage
   (`crystal.py:681-686`, enforced only in the legacy ReAct path, not the skill-first
   dispatch path) is intentional or an incomplete migration — this is a security-adjacent
   ambiguity that predates this assessment and should be resolved as its own decision, not
   silently inherited by whatever else changes next to it.
10. Unify `custom_analysis.py`'s two inconsistent failure-result shapes
    (`{"error": ...}` vs `{"status": "failed", "error": ...}`) and add logging to its one
    silent `except Exception: pass` (currently the only unlogged except-block in that file).
11. **Backend-side** (Dana): dedupe `routes/insights.ts`'s hand-rolled `_agentsFetch` against
    `agentsClient.ts`'s equivalent helper; add one shared Express-side identity/scope
    validation gate (today `crystalHandler` silently coerces a missing `survey_id` to `''`
    rather than rejecting — a real, if narrow, version of the same fail-fast gap the harness
    research flags, already present on the Express side independent of anything CrystalOS
    does internally).

### Phase 2 — one real design decision, cross-layer coordination required

12. **Build the `applied_filters`-equivalent audit object** (00-SYNTHESIS.md Tier 2 #7) —
    this is the one pattern all three non-research team members (Priya, Marcus, Dana) and
    the frontend expert (Jordan) independently flagged as genuinely valuable, not just
    borrowed-because-it-sounds-good:
    - **Priya/Marcus**: `tool_results` already carries every tool's `args`
      (`agents/crystal.py:1105`) — the raw ingredients exist, just not normalized or emitted.
      Design work is real: CrystalOS's tools query genuinely different backend shapes
      (survey-scoped, tag/group-scoped, multi-field) with no shared "what was actually
      queried" vocabulary today.
    - **Dana**: additive on the wire (new optional field on `POST /insights/crystal`'s
      response and the SSE `answer` event) — but **`crystalHandler`'s explicit SSE-key
      allowlist in `backend/src/routes/experience.ts` will silently drop the new field
      unless updated in the same PR** (exactly as `viz` needed its own explicit addition
      previously). Concrete, named, easy-to-miss coordination point.
    - **Jordan**: real UI value here, unlike most other patterns — `CrystalThinkingBubble`'s
      live reasoning trace is ephemeral and vanishes once an answer lands; there's no
      persistent "what did Crystal actually search" record today. Frontend cost is small
      (reuse the existing `SourcesFooter` disclosure pattern).
    - **Sequencing**: agree the canonical filter-tree shape first (a real design decision,
      not busywork) before any code — and per Dana's open question, decide in the same pass
      whether to also fix the pre-existing asymmetry that the non-streaming
      `/insights/crystal` endpoint never returns `action_proposals` at all.

### Phase 3 — pilot on exactly one skill, gated on a measurable result

13. **Validator-paired-eval-gate pilot** (00-SYNTHESIS.md Tier 2 #8). Marcus identifies
    `compliance-scanner` as the best candidate — its scoring rubric is already fully
    specified as deterministic prose in SKILL.md ("start at 100, deduct -25/critical capped
    at -50...") but is currently graded by an LLM judge rather than cross-checked against
    the rubric's own arithmetic. Dr. Reyes's E4 experiment design (regex-check
    `csat`/`nps`/`ces-action-advisor`'s "quantified impact estimate" criterion, measured by
    agreement-with-human-label / Cohen's kappa against a 40-60 case hand-labeled set, not
    raw pass-rate comparison) is the right *method* to apply to whichever skill/criterion is
    chosen as the actual pilot — don't generalize past one skill until this measurement
    comes back positive.

### Explicitly deferred, not rejected

- **Offline eval-case + pluggable-grader harness** (Tier 2 #9) — Dr. Reyes confirmed
  CrystalOS already owns two of the three necessary pieces (`resolve_variant`'s A/B
  framework, `cdx.py`'s `_check_significance` two-proportion z-test, `/api/cdx/test`'s
  routing-debug endpoint); only a labeled `{query, expected_skill}` dataset + YAML-case
  format layer is genuinely new. Real value (catches routing regressions and multi-turn
  issues the synchronous `EVALS.md` gate structurally cannot see) but a standalone project
  (10-15+ days per Priya), not part of this pass.
- **Structured fact/memory storage over the current 7-day thread TTL** (Tier 2 #11) — no
  current code path needs this; Dana additionally flags that `crystal_threads` is currently
  **Express-owned**, not CrystalOS-owned (Express reads/writes it directly, threads history
  into the request body) — any future move here is a new cross-service contract, not an
  internal CrystalOS change, and should be scoped as such if it's ever revisited.
- **AIP-style typed skill-graphs** (Tier 3 #12) — the one-skill-pilot bar from Phase 3
  applies here even more strongly; no evidence yet that CrystalOS's skill shapes need this.

## Before anyone touches the riskiest area

Marcus's single clearest warning: **`agents/crystal.py`'s three-layer fallback chain
(`_run_skill_stream` → skill synthesis → `_run_crystal` → `main.py`'s outermost
double-fallback), its two hard-force routing bypasses for `workflow-analyst`
(`_resolve_forced_skill`, entirely outside the semantic router), and `_normalize_proposal`'s
turn-scoped id-minting are the highest-traffic surface every one of the above patterns would
eventually touch** — and it's also the one area where the reasoning is scattered across two
different feature "Waves" layered on an older design, rather than documented in one place
the way the Insight Pipeline's subtleties are. **Before any Phase 2/3 work reaches this
code, verify test density specifically on these three mechanisms** (the two force-routing
conditions, the outermost double-fallback, the proposal-id stability guarantee across
emit→confirm→execute) — not just "1400 tests exist somewhere in the suite." This is a
prerequisite check, not a blocker on Phase 0/1, none of which touch this area.

## What this means for "learning from qualtrics-agent-skills, nothing Qualtrics-specific"

Addressed directly, cross-checked against BRIEF.md's take/leave list: every concrete
recommendation above is a generic pattern (deterministic post-processing, validator-in-the-
loop, provenance stamping, tool-error contracts) with zero Qualtrics product surface
(Herodotus/DFS/LXH/MIG/AgentCore/brand-JWT specifics) referenced anywhere in any of the five
findings docs — confirmed during synthesis, not just assumed.

## One-paragraph answer if someone asks "so, did we hire an architecture expert and
rearchitect Crystal?"

We assembled five domain experts, and the deep-dive converged, independently and from five
different angles, on: **no rearchitecture — CrystalOS's current agent-loop and skill-runtime
design is deliberate, well-reasoned, and well-tested, not accidental complexity that a
harness pattern would clean up.** What the assessment *did* surface is a concrete, cheap,
low-risk punch list (Phase 0/1 above, ~1 week of engineering) plus one genuinely valuable
cross-layer feature (`applied_filters`, Phase 2) and one measurable pilot worth running
(Phase 3) — and, as a side effect of looking this closely, caught a dead-code convention
(`EXAMPLES.md`) that one of this session's own earlier recommendations had gotten wrong.
