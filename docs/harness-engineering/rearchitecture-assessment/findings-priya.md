# Findings — Priya (AI Agent / Harness Engineer)

**Lens:** implementation feasibility — concrete migration path, effort/risk sizing, phased rollout plan, and provider-constraint compatibility.

**What I read in full:** `BRIEF.md`, `TEAM.md`, `docs/harness-engineering/external-repo-research/00-SYNTHESIS.md`, `03-qualtrics-agent-harness.md`; skimmed `01`, `02`, `04`. Then read CrystalOS's actual agent-loop code end to end: `agents/crystal.py` (2212 lines), `lib/skill_runtime.py` (670 lines), `lib/skill_registry.py` (409 lines), `crystal/context.py`, `crystal/registry.py` (tool-registry sections), `crystal/tools.py` (dispatch table + `dispatch_tool`), `lib/models.py`, `lib/turn_publisher.py`, `main.py` (imports, startup validation, `lifespan`, `crystal_stream_endpoint`), and `lib/security.py`. No code was written or modified.

---

## 1. Lifecycle mapping — CrystalOS's implicit stages vs QAH's 5 middlewares

| QAH middleware | Does CrystalOS already do this? | Where (file:function) | Naming it a hook: real simplification or just indirection? |
|---|---|---|---|
| **`RequestValidationMiddleware`** (fail-fast identity, before anything else) | Partially, split across two layers that don't compose. Layer 1: `require_internal_key` (`lib/security.py:28`) IS a real FastAPI-`Depends`-first gate — service-to-service auth. Layer 2: per-request `org_id`/`survey_id`/`user_role`/permission resolution is **not** a gate — `crystal_stream_endpoint` (`main.py:1719`) reads these straight from the untyped request body, validates `survey_id` ownership inline (`check_survey_access`, only if truthy), whitelists `user_role` inline, constructs `CrystalInput`, then hands off to one of 4 entry functions, each of which calls **`_build_ctx(inp)` again, independently** (`agents/crystal.py:1119, 1380, 1518, 1754, 1979, 2204` — 6 call sites). `_build_ctx` (`agents/crystal.py:890-928`) is where `BrandContext`/`_resolve_permissions`/`tag_ids` resolution actually happens — deep inside whichever loop function got picked, not before routing. | `lib/security.py:28`; `main.py:1719-1757`; `agents/crystal.py:890-928` (6 call sites) | **Real simplification, not just naming.** Building `ctx` once in `crystal_stream_endpoint`/`crystal_chat`, before dispatch, and threading it into whichever loop function runs removes 5 of 6 redundant reconstructions per turn. |
| **`ToolValidationErrorMiddleware`** | Yes, already structural — `dispatch_tool` (`crystal/tools.py:3799`) wraps every executor and returns `{"error": ...}` dicts; `_react_plan_tools` additionally catches raw exceptions from `dispatch_tool` itself (line ~1099). | `crystal/tools.py:3799-3811`; `agents/crystal.py:1096-1100` | **Naming only — no code to shrink.** There's no framework default (LangChain's) to work around; CrystalOS's hand-rolled dispatch never had the crash-on-bad-args failure mode to begin with. Worth a shared `assert_tool_ok()` test helper (synthesis Tier 1 #3), not a structural change. |
| **`InputContextMiddleware`** | Partially — no dual input/configurable bridge needed (CrystalOS has one calling convention, `CrystalInput`). The "read the clock/config fresh per request, never at import" half is already followed correctly — confirmed no date/config baked at module level in `crystal.py`, `skill_runtime.py`, `models.py`. | `agents/crystal.py:454-530, 757-867` | No simplification available; the audit itself (QAH's `current_date.py` pattern) came back clean. |
| **`AppliedFiltersMiddleware`** (per-turn "what did we query" audit, normalized, written every turn) | **No — the one real gap.** `tool_results` already carries every tool's `args` (`agents/crystal.py:1105`), but nothing normalizes/emits it; `CrystalOutput` has `citations`/`insight_refs`/`action_proposals`/`viz`, no `applied_filters`. `_fire_telemetry` even drops `args` when forwarding to `TurnEvent.tools_called` (`agents/crystal.py:1820`). | Gap | Genuine new capability (synthesis Tier 2 #7), not a refactor of something ad hoc. Ingredients already collected; work is a normalization function + a filter-shape design decision across heterogeneous tool arg shapes. |
| **`CodeInterpreterSandboxMiddleware`** | N/A — CrystalOS has no code-execution sandbox; skills are pure LLM calls with an eval gate. | N/A | Not applicable. |

**Bottom line:** 3 of 5 QAH middleware *behaviors* are already covered (tool-error contract, fresh-per-request prompts, fail-fast service auth). Two are genuinely missing: (a) a single pre-dispatch identity/permission gate — correct in aggregate today but duplicated 6 ways — and (b) an applied-filters audit object, which doesn't exist at all. Naming the other 3 as explicit "hooks" would add indirection with no offsetting simplification.

---

## 2. Simplification opportunities

1. **Collapse 6 independent `_build_ctx(inp)` call sites into 1** (`agents/crystal.py:1119, 1380, 1518, 1754, 1979, 2204`). Every one of `_run_react_loop`, `_run_react_loop_streaming`, `_run_skill_loop`, `_run_skill_stream`, and `CrystalAgent.run`'s fallback rebuilds an identical `CrystalContext`. This is the smallest, safest, most concrete win in this assessment.
2. **`_fire_telemetry`'s `tools_called` drops tool args** (`agents/crystal.py:1820`) even though `tool_results` carries them at the call site — the natural plug-in point for a future `applied_filters` field.
3. **`STRUCTURAL_KEYWORDS`/`_is_structural_criterion`** (`skill_runtime.py:53-66`) already informally implements the tool/eval-contract idea — no code shrinks, but pulling it into one shared test helper is worthwhile.

---

## 3. Improvement opportunities (tied to Crystal-harness research docs)

1. **A single pre-dispatch identity/permission gate** — QAH §3.7 `RequestValidationMiddleware` (doc `03`), synthesis Tier 1 #1. A `resolve_crystal_context(body) -> CrystalContext` called once, replacing the split main.py/`_build_ctx` resolution.
2. **`applied_filters`-equivalent audit object** — QAH §3.7 `AppliedFiltersMiddleware`, synthesis Tier 2 #7. A pure function mirroring `_build_viz_for_citations`'s existing shape (`agents/crystal.py:1212`) — same file already proves this pattern works.
3. **Provenance stamping** — CLS `_provenance.py` (doc `02`), synthesis Tier 1 #2. CrystalOS logs `skill_version` but never its own package version; trivial additive change.
4. **Formalize the tool-error contract with a shared test helper** — QAH's `assert_ok()` (doc `03` §7), synthesis Tier 1 #3. `dispatch_tool` is already correct; only the test-suite convention is missing.

---

## 4. Is CrystalOS's OpenRouter JSON-protocol ReAct loop compatible with the middleware model?

**Short answer: the *idea* of hook points ports; the *mechanism* (LangChain `AgentMiddleware`/deepagents hooks) does not, and shouldn't be adopted.**

QAH's middleware model hooks into deepagents/LangChain's native tool-calling loop — `wrap_tool_call`/`wrap_model_call` are literal callbacks *that runtime* invokes at specific points in its own execution (e.g. `ToolValidationErrorMiddleware` exists specifically to catch a `pydantic.ValidationError` that LangChain's default dispatch would otherwise let crash the run). CrystalOS has no such machinery: `_react_plan_tools` (`agents/crystal.py:1046`) is a hand-written async generator that calls `call_agent` with `output_schema=ReActStep` (a JSON-mode protocol per `lib/models.py`'s docstring: "OpenRouter has no native function-calling"), manually dispatches via `dispatch_tool`, and manually loops. There is no `AgentExecutor` instance for a `before_agent`/`wrap_tool_call` hook to attach to — naming these positions with hook vocabulary would be pure renaming of existing inline code, not adoption of new capability.

What **does** port (because it's a pattern, not a library mechanism): the ordering discipline ("validation first," enforceable with a plain test), the tool-error-as-data convention (already true), and the "read the finished tool-call list once, after the turn, no held state" timing of `AppliedFiltersMiddleware` — CrystalOS's loop is already structured that way (`tool_results` is fully populated before `_skill_synthesis`/`_run_crystal` run).

What does **not** port: literal `AgentMiddleware` classes, `wrap_model_call`/`wrap_tool_call` decorators, or any expectation that "hooks" give CrystalOS parallel-tool-call handling or LangGraph checkpointing for free — those come from a runtime CrystalOS's provider constraint explicitly rules out per BRIEF.md's scope.

---

## 5. Effort sizing — Tier 1 / Tier 2 items (synthesis §3), engineer-days

| # | Item | Effort (days) | Basis |
|---|---|---|---|
| T1-1 | Single fail-fast identity/permission gate | **1.5–2** | Code motion across 3 `main.py` endpoints + 6 call sites in `crystal.py` collapsed to 1; ~4 new order-pinning tests; most time is regression verification against the existing ~1400 tests, not new logic. |
| T1-2 | Provenance stamping | **0.25–0.5** | Additive field, trivial helper, no existing call-site shape changes. |
| T1-3 | Tool-error contract + shared test helper | **0.5–1** | No production code changes; pure test-suite refactor across scattered ad hoc checks. |
| T1-4 | Route verbose tool/test output to logs | **0.25** | Doc + CI config tweak only. |
| T1-5 | Negative examples in `EXAMPLES.md` | **content work, ~0.5/skill**, 9+ skills — a multi-day content project, not one engineering task. |
| T1-6 | "When can this be removed" living table | **0.5** | Pure documentation, needs recurring review discipline after. |
| T2-7 | `applied_filters` audit object | **3–5** | ~1 day design decision (canonical filter-tree shape across heterogeneous tool arg shapes) + wiring into 4 entry paths + `_fire_telemetry` + SSE shape; cross-layer dependency on whether frontend needs it (flagged as open question for Jordan). |
| T2-8 | Validator-paired-eval-gate, piloted on one skill | **2–4 per skill** | Runtime substrate (`skill_runtime.py:175-208`'s retry loop) already exists; per-skill work is identifying a provable sub-check, writing the validator + its own tests. |
| T2-9 | Offline eval-case + grader harness | **10–15+, own project** | Confirmed `skill_runtime.py` has zero multi-turn/trace-caching/grader-dispatch concept — genuinely new build, not a Tier-1-adjacent task. |
| T2-10 | Named hook-point vocabulary for `SkillRuntime.execute()` | **0 days recommended (don't do); 1–2 days if pursued as pure renaming** | See §4 — no runtime underneath to make hook names load-bearing; real risk against ~1400 tests for zero functional gain. |
| T2-11 | Structured fact/memory storage | **Not sized** — explicitly a trigger-condition item, no current code path needs it. |

**Headline: Tier 1 totals ~3–5 engineer-days** (T1-1 through T1-4; T1-5/T1-6 are content/doc work, not engineering in the same sense). **A full structural middleware refactor (T2-10 as genuine architecture change) is not sized because I don't recommend it** — if forced, a real hook-registration system plus full regression proof against ~1400 tests is a **3–4 week minimum**, for a payoff that's naming, not new capability, given the provider constraint.

---

## 6. Phased migration plan

**Phase 0 (ship first, fully reversible):** T1-2 + T1-3 + T1-4 + T1-6 — all additive, zero risk, don't touch `crystal.py`'s control flow.

**Phase 1 (the one real structural step, still small and reversible):** T1-1 — collapse `_build_ctx` to one call site. Add `resolve_crystal_context(body) -> CrystalContext` (or just relocate `_build_ctx(inp)`'s call) into the 3 Crystal-facing endpoints in `main.py`, before any loop function runs; change the 4 loop functions to accept `ctx` as a parameter; add order-pinning tests. Since `_build_ctx` is pure (no DB/LLM calls — confirmed reading `context.py`), this should produce a zero-diff result on every existing test's assertions.

**Phase 2 (design decision required first):** T2-7, `applied_filters`. Don't start code until the canonical filter-tree shape is agreed (I found at least 3 distinct tool arg shapes: single-survey, tag/group, multi-field) and Jordan confirms whether the frontend needs a UI surface for it.

**Phase 3 (pilot on exactly one skill):** T2-8, validator-paired-eval-gate — survey-creator is the natural pilot per BRIEF.md's own "Take" list (id/logic integrity). Coordinate with Dr. Reyes on measuring whether it actually improves pass rate before generalizing.

**Where a full "named hook points" refactor of `SkillRuntime.execute()` would land, and is it worth it:** Phase 4+, restructuring `skill_runtime.py:88-272`'s linear sequence into named methods. Given no underlying framework runtime makes hook names load-bearing (§4), and the ~1400-test regression surface any restructuring touches, **I don't think this is worth doing** as a dedicated project. Both concrete motivating additions (PII redaction, applied-filters) fit as ordinary function insertions into the existing sequence — which Phases 1–2 already do — without first renaming it into "hooks."

---

## 7. What NOT to migrate

**Leave `crystal.py`'s hand-rolled ReAct loop and `SkillRuntime.execute()`'s linear structure alone, structurally.** Adopt only the isolated patterns above without a "middleware" abstraction layer:

- There's no framework underneath to make "hooks" real (§4) — renaming ~600 lines of already-working, already-tested code for zero functional gain is a bad trade against a ~1400-test regression surface.
- The two things QAH's model buys for free (fail-fast-first ordering, a finished-turn audit object) are already achievable as ordinary function calls in the right place — Phases 1–2 prove this without any hook abstraction.
- CrystalOS is already ahead on the one axis the harness research flags as the qualtrics stack's weakness (in-request `EVALS.md` gate + retry + example-bank loop, per doc `03` §9/§11 and synthesis §4) — none of QAH's middlewares touch quality/eval at all, so a structural refactor risks disturbing CrystalOS's strongest system for a pattern that doesn't even address it.

---

## Recommendation

**Adopt selected patterns only — no structural "middleware" refactor.** Ship Phase 0 (~1 day) and Phase 1 (~1.5–2 days, low-risk since `_build_ctx` is pure) as concrete near-term work. Treat Phase 2 (`applied_filters`) and Phase 3 (validator-pilot) as separately-scoped follow-ups gated on a design decision and a pilot result respectively. Do not pursue named hook-point vocabulary for `SkillRuntime.execute()` as a dedicated structural project — CrystalOS's provider constraint (OpenRouter JSON-mode, no native tool-calling) means there's no agent-executor runtime for hook names to attach to, so the "refactor" would be pure renaming of correct, tested code against a large regression surface, for a legibility benefit that doesn't offset the risk.

---

## Open questions for the rest of the team

1. **Marcus** — does `_build_ctx` consolidation (Phase 1) interact with anything in the Insight Pipeline or Custom Analysis graph I didn't check (I scoped to Crystal's conversational entry points only)?
2. **Jordan** — is `applied_filters` (Phase 2) actually wanted by the frontend today, or backend-only with no consumer? Changes the T2-7 sizing materially.
3. **Dr. Reyes** — for T2-8, is there an existing empirical baseline for survey-creator's id/logic error rate to measure the pilot against?
4. **Dana** — does `agentsClient.js` or any Node-side code depend on the exact current timing/shape of `_build_ctx`'s output?
5. **All** — is the honest framing that "should CrystalOS rearchitect toward a harness shape" has a null answer from the implementation-feasibility lens specifically — there's no framework runtime being adopted, so there's no rearchitecture to size beyond the pattern-adoption items above, and the provider constraint isn't a "not yet," it's a standing design decision BRIEF.md itself takes off the table?
