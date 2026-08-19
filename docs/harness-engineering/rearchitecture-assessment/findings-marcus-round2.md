# Findings: Marcus — Round 2 (Extensibility Reframing + Code-Interpreter Design)

## 1. Revised recommendation on Reframing #1 (extensibility)

**Verdict: the Round 1 "no rearchitecture" conclusion still holds, but I found something in
this pass that changes the *shape* of my answer — CrystalOS already built the narrow,
in-house extension point the reframing asks for, and then didn't use it.** That's a more
useful and more specific finding than a generic "yes, extensibility differs from cleanup."

### The discovery: `lib/tool_dispatcher.py` is a second, unused, better-behaved tool dispatcher

Round 1 focused entirely on `crystal/tools.py`'s `dispatch_tool`/`TOOL_REGISTRY` because
that's what Crystal's chat path actually calls. Re-reading with the extensibility question in
mind, I found `lib/tool_dispatcher.py`'s `ToolDispatcher` — initialized at every startup
(`main.py:153-156`, `_dispatcher.initialize()`), backed by a manifest (`skills/plugin.json`'s
`"tools"` dict, name → `"module.path:function"` string, resolved via `importlib`), with:

- **An `allowed_tools` gate built in** (`dispatch(..., allowed_tools={"get_topics"})` raises
  `ToolNotAllowedError` if the tool isn't in the set) — this maps directly onto a skill's own
  `allowed-tools` frontmatter, which `skill_registry.py::_parse_skill_md` already parses today.
- **A structurally-guaranteed `{"error": str(exc), "tool": tool_name}` contract** — every call
  path through `dispatch()` is wrapped in try/except; there is no way to call a registered tool
  through this dispatcher and have an uncaught exception escape. This is *exactly* the fix I
  flagged as missing from `crystal/tools.py`'s `dispatch_tool` in Round 1 (§2 item 4) — already
  built, just in a different file.
- **Per-session memoization** (`tool_cache` dict, keyed on `tool_name + sorted(params)`).
- **An MCP-server stub** (`_dispatch_mcp` raises `NotImplementedError`) suggesting it was
  originally built for an external-tool-server abstraction (Jira/Slack), not for Crystal's own
  DB-query tools.

I confirmed via grep that **`ToolDispatcher.dispatch()` is never called anywhere in production
code** — only in its own test file (`tests/test_tool_dispatcher.py`). It's fully built, fully
tested, wired up at startup, and completely dormant. Meanwhile `plugin.json`'s `"tools"` dict
already duplicates several entries also present in `crystal/tools.py`'s `TOOL_EXECUTORS`
(`get_survey_overview`, `get_topic_details`, etc. — same function, registered in both places
under two different name-resolution mechanisms). **CrystalOS today has two parallel,
overlapping, redundant tool-dispatch systems, one live and one dormant, and nothing in the
codebase or CLAUDE.md flags this as a decision that was ever made on purpose.**

### Why this matters for the 12-month framing specifically

This is the concrete evidence for what the reframing is asking about. Round 1's "deliberately
reasoned-about code" verdict was about the *logic that's live and load-bearing today*
(routing, fallback, proposal-normalization) — and that verdict holds; I found nothing in this
pass that walks it back. But extensibility risk isn't about today's live code being messy —
it's about what happens when the *next* contributor needs to add a cross-cutting capability
and has to choose between two existing, unreconciled mechanisms with no documented guidance.
`ToolDispatcher` is proof this already happened once (someone built the "right" narrow
extension point, then a separate effort added the next batch of tools straight into
`crystal/tools.py` instead, likely because that's the pattern that was already live and visible
in the file a new contributor would naturally copy). Twelve months and a few more "add a
tool" PRs from now, without an explicit decision, this doesn't resolve itself — it either stays
two systems forever (permanent, silent duplication cost) or a *third* ad hoc pattern gets
invented by whoever adds the code-interpreter primitive or the `applied_filters` object,
because neither existing mechanism will obviously be "the" answer to a contributor who hasn't
read both files.

**Concrete, non-rearchitecture recommendation**: make one explicit, cheap decision now —
`lib/tool_dispatcher.py`'s `ToolDispatcher` becomes the forward-looking home for any *new*
tool-shaped capability (starting with the code-interpreter validators in §2 below);
`crystal/tools.py`'s `TOOL_REGISTRY`/`dispatch_tool` stays frozen as the stable surface for
Crystal's existing ~60 tools (not ripped out, not migrated — just not where new things land).
This is a documentation-and-convention change plus wiring one new capability through the
already-built path, not a rearchitecture.

### A second, narrower gap: no ordered extension point *inside* `SkillRuntime.execute()` itself

`ToolDispatcher` solves "a skill's *context-gathering* needs a new tool." It does not solve
"every skill's *output* should optionally pass through a new cross-cutting post-processing
step" (PII redaction, `applied_filters` normalization, a future compliance re-check). I looked
for whether CrystalOS already has ad hoc versions of this need and found **two independent,
non-unified PII-handling implementations**: `lib/pii_scrubber.py::scrub`/`scrub_dict` (used
only by `lib/tracer.py` to clean telemetry/trace output) and `lib/validators.py::scan_pii_patterns`
(a separate regex scanner used only pre-compliance-agent, in the survey-creation flow). Two
different regex-based PII detectors, in two different files, serving two different call sites,
neither reusable by the other. This is exactly the "cross-cutting concern added by
duplicating a small function in a new place" pattern the reframing is worried about, and it's
not hypothetical — it already happened, twice, for the same concern (PII), just not yet inside
`SkillRuntime.execute()` specifically.

**Concrete, non-framework proposal**: add one small, named, ordered list inside
`lib/skill_runtime.py` — e.g. `_POST_GENERATION_PROCESSORS: list[tuple[str, Callable]]` — that
`SkillRuntime.execute()` iterates once, after `_check_evals`'s retry loop resolves and before
the example-bank write. Each processor receives `(skill_name, skill_meta, input_data,
output_raw, eval_score)` and returns `None` (no-op) or a small dict merged into
`SkillResult.reasoning_trace`. This is **not** a `before_agent`/`wrap_tool_call` middleware
framework — it's the same "name → callable, resolved in-process" shape `TOOL_EXECUTORS` and
`ToolDispatcher._tools` already use elsewhere in this codebase, just applied to one more
already-uniform choke point. It sidesteps the exact objection I raised in Round 1 (and Priya
raised independently) against request-level middleware: that objection was about unifying
*three different context shapes* across Crystal-chat/orchestration-run/insight-pipeline entry
points, which genuinely doesn't have a clean seam. `SkillRuntime.execute()` has no such
problem — every skill call across all three surfaces already funnels through this one function
with one uniform `(skill_name, skill_meta, input_data, ctx)` shape today. This is where a
future `applied_filters` normalizer, a unified PII-redaction pass, or (per §2) an
on-every-call validator would plug in with a one-line registration, not another multi-file
refactor.

### Bottom line on Reframing #1

Same overall answer as Round 1 (no rearchitecture), but not for the same reason as before.
Round 1's reasoning ("this code is deliberate, not accidental") is still true and still a good
reason not to rip anything up. The *new* reason, specific to the 12-month framing: CrystalOS
doesn't need a framework to be more extensible — it needs to (a) pick a winner between its two
already-built tool-dispatch mechanisms, and (b) add one small ordered-processor list at the one
choke point (`SkillRuntime.execute()`) that's already common across every surface. Both are
small, in-house, additive changes; neither is "adopt a harness."

---

## 2. Full design answer to Reframing #2 (code interpreter / skill-runtime structures)

### 2.0 Where it inserts into `SkillRuntime.execute()`'s current sequence

Today's sequence (`lib/skill_runtime.py:88-272`): build system prompt → first `call_agent()` →
`_check_evals` → if failed, one retry `call_agent()` with injected `retry_context` →
`_check_evals` again → example-bank write (fire-and-forget) → return `SkillResult`.

I recommend **both** of the insertion points the brief asks about, because they serve two
different triggers:

1. **As a new tool, dispatched pre-emptively during context-gathering** (same shape as every
   other CrystalOS tool call today) — for the common case where a skill's *caller* already
   knows a deterministic check applies (e.g. `agents/creator.py` already knows every
   survey-creation output needs id-fix/skip-logic validation, `execute_analyze_key_drivers`
   already knows the quadrant math applies). This needs **no new architecture at all** — it's
   `ToolDispatcher.dispatch("run_validator", {"name": "quadrant_classify", "args": {...}},
   allowed_tools=skill_meta["allowed_tools"])`, exactly the existing mechanism from §1, just
   with one new manifest entry.

2. **As a stage inside `_check_evals`'s retry loop**, for the case the brief is actually most
   interested in — a *skill itself* declaring, via its own JSON output, that it wants a named
   validator run before its answer is accepted. Concretely: extend the skill output schema with
   one optional field, e.g. `"validator_request": {"name": "nps_math_check", "args": {...}}`
   (skills already emit open-ended JSON per `_SkillOutput`'s `extra="allow"` config, so this is
   additive, not a schema break). In `SkillRuntime.execute()`, right after the first
   `call_agent()` call and *before* `_check_evals`, check for `output_raw.get("validator_request")`;
   if present, look it up in a **fixed, pre-registered validator function table** (see §2.1),
   run it, and if it reports issues, feed them into the *same* `retry_context` shape the
   eval-failure retry already uses (`failed_criteria`, `previous_output`, `instruction`) —
   reusing the existing retry-with-injected-context mechanism rather than building a second one.
   If the validator passes, proceed to `_check_evals` as normal. This means: **one skill call
   can now trigger up to one validator-driven retry AND up to one eval-driven retry** — I'd cap
   total attempts at 2 total (not 2+2), i.e. the validator round consumes the *existing* single
   retry budget rather than adding a second one, to avoid quietly doubling every skill's
   worst-case latency/cost.

   Results surface **both** ways the brief asks about: the validator's issues feed back into the
   skill's own next-turn context (model can react, same as any retry), and the fact that a
   validator ran + its pass/fail result is recorded in `SkillResult.reasoning_trace` (which
   already carries `eval_score`/`eval_issues`/`retried` — one more field, `validator_ran`/
   `validator_passed`, is additive) so it's visible in telemetry without a schema break.

### 2.1 The isolation mechanism — and why I'd sit at the narrow end of the spectrum, not the middle

I recommend **the narrowest option on the spectrum: no general code execution at all — a
fixed, pre-registered library of named deterministic validator/compiler *functions*, called by
name with structured args, never arbitrary skill-authored code.** This is a stronger, more
specific recommendation than "start narrow and grow later" — I don't think CrystalOS's actual
infra and actual current needs justify building *toward* a sandbox at all right now. Reasoning,
grounded in what I actually found in this codebase (not an idealized deployment):

- **CrystalOS has already made this exact choice, explicitly, once already, and documented why.**
  `lib/tool_dispatcher.py`'s own docstring: "Internal tools... are called directly via
  importlib — sub-millisecond overhead, **no subprocess**." That's not a gap or an oversight —
  it's a stated design decision already living in the file that's the natural home for this new
  capability. I found **zero** subprocess/container/RestrictedPython usage anywhere in
  `lib/`, `crystal/`, `graphs/`, or `tools/` (confirmed by direct grep across the whole tree) —
  every "deterministic check" CrystalOS already has (`_cap_trust`, `_build_viz_for_citations`,
  `detect_quality_signal`, `fix_question_ids`, `scan_pii_patterns`) is a plain in-process Python
  function. Introducing subprocess/container isolation for this one new capability would be the
  first of its kind in this codebase, not a natural next step of an existing pattern.
- **Infra reality**: single FastAPI service on Fly.io (per the root CLAUDE.md), no container
  orchestration visible anywhere I read, no existing sandbox runtime, no vendored sandboxing
  library. A real subprocess-with-`resource`-limits mechanism is *buildable* with zero new
  dependencies (Python's stdlib `subprocess` + `resource.setrlimit` + `tempfile`), but it's
  genuinely new operational surface — timeout handling, zombie-process cleanup, resource-limit
  tuning per Fly.io's actual container constraints — that nothing in this codebase currently
  needs to reason about. That's real ongoing cost for a capability that, per §2.2 below, isn't
  actually required by any concrete skill I looked at.
- **Every concrete deterministic-check need I found in Round 1 and this pass is fully
  expressible as a parameterized call to a fixed function, not as skill-authored arbitrary
  code.** `compliance-scanner`'s rubric, `custom_analysis.py`'s trust cap, driver-analyst's
  quadrant math, tag-analyst's confidence-tier mapping (all in §2.2) — none of them need a
  skill to *write new code on the fly*; they need a skill to say "check my output against rule
  X with these arguments," where rule X is one of a small, engineer-authored, pre-tested set.
  The brief's own framing (`qualtrics-agent-skills`' `ie_validator.py`/`compile_logic.py`) is
  itself a **fixed pre-authored Python script per skill**, not a general sandbox that skills
  generate code into at runtime — so "adopt that pattern" doesn't actually require adopting
  general code execution either; it requires exactly the fixed-function-library end of the
  spectrum.
- **The security question answers itself at this end of the spectrum.** No secrets/model
  access, no network egress, no resource limits needed as a *new* concern — a plain Python
  function with a documented, narrow signature (takes only the specific fields it declares it
  needs, e.g. `nps_math_check(claimed_score: float, segment_data: list[dict]) -> dict`) has
  none of those attack surfaces by construction, the same way `_cap_trust` or
  `detect_quality_signal` don't today. This is a free security win, not a tradeoff.

**When would I revisit this and move toward real code execution?** Only if a specific skill
genuinely needs *per-request-generated* logic that can't be expressed as arguments to a
pre-authored function — e.g., a skill that needs to compile a bespoke boolean expression a user
typed in free text (survey skip-logic conditions are the closest CrystalOS analog I saw, and
today that's handled by structured LLM output + the existing `fix_question_ids`/skip-logic
destination Python guards, not code generation). If that trigger is ever hit, the next step up
the spectrum I'd recommend is **not** a container — it's a `subprocess.run()` of a
narrow, `ast`-whitelisted Python subset (arithmetic/comparison/boolean ops and literals only, no
imports, no attribute/dunder access, statically checked via `ast.parse` before ever executing),
run with `resource.setrlimit` CPU/memory caps, no network, in a fresh temp cwd, hard timeout via
`subprocess.run(..., timeout=...)` — all stdlib, zero new dependencies, genuinely buildable on
Fly.io's existing single-service deploy. I would not recommend a container-per-execution model
unless/until CrystalOS's deploy target itself changes to something with container orchestration
already available (it doesn't today).

### 2.2 Concrete pilot skills (beyond `compliance-scanner`, which Round 1 already flagged)

1. **`driver-analyst` (`analyze_key_drivers`)** — `crystal/tools.py::execute_analyze_key_drivers`
   already pre-computes `importance = round(min(1.0, abs(impact)/100.0), 3)` and
   `performance = round(impact/100.0, 3)` in Python before handing them to the skill, which is
   asked to place each driver into a fix-first/maintain/low-priority/monitor quadrant. This is a
   textbook "threshold→label mapping" case (the exact §3.1 pattern from Round 1's synthesis
   citation). A named validator (`quadrant_classify(importance, performance) -> label`) would
   deterministically re-derive the correct quadrant from the skill's own stated thresholds and
   flag any narrative/label mismatch — cheap, high-confidence, and the skill already receives
   exactly the two numbers the validator needs, so no new data plumbing required.

2. **`tag-analyst` (`get_tag_report`)** — Round 1 found this skill's EVALS.md gives its single
   highest-weighted criterion (weight 20, threshold 0.90) to "trust-layer fidelity" — never
   presenting a single-survey-sourced finding as a tag-wide claim — and today that criterion is
   graded entirely by an LLM judge reading prose output. A validator
   (`confidence_tier_check(n_surveys_contributing, claimed_tier) -> {ok, expected_tier}`)
   against a small fixed threshold table (e.g. n≥5→"high", 2-4→"medium", n==1→"low, single-survey
   disclosure required") would turn CrystalOS's single highest-stakes tag-report criterion from
   an LLM's best guess into a deterministic check — directly the kind of "provably-correct
   sub-check" Round 1's Tier 2 #8 was gesturing at, on the highest-value target I found for it.

3. **Survey-creation ID/skip-logic guards, consolidated** — `agents/creator.py`/`agents/copilot.py`
   already run `fix_question_ids` and skip-logic destination checks as ad hoc Python
   post-processing *after* the skill-vs-legacy branch merges (confirmed in Round 1's
   `skill_survey_adapter.py` research). These are already exactly the right kind of
   deterministic check — they're just wired as separate, hand-rolled post-processing in
   `creator.py`/`copilot.py` rather than as named validators any future survey-authoring skill
   could request through the same mechanism. Formalizing these two existing checks into the
   named-validator table (even without moving where they're called from) gives the team one
   registry to look at instead of two files' worth of scattered guard logic, and makes them
   available to skills beyond `survey-creator`/`copilot-analyst` for free.

(Bonus fourth, lower priority: `workflow-analyst`'s `propose_workflow` output — a
graph-well-formedness check, "every edge references an existing node id, no dangling edges" —
would catch a malformed automation graph before it ever reaches the user's confirm dialog,
rather than failing downstream in the frontend/engine after confirmation.)

### 2.3 Interaction with the `TOOL_PERMISSION_MAP` gap and the `dispatch_tool` error-contract fix

**This makes the `dispatch_tool` fix more urgent to route around, not necessarily more urgent
to fix in place.** A validator function is exactly the kind of new, unusual code most likely to
be written by someone unfamiliar with "every `crystal/tools.py` executor must remember its own
try/except" (it isn't a copy-paste of an existing DB-query executor — it's a new shape of tool
entirely). My concrete recommendation is to **not** add these validators to `crystal/tools.py`'s
`TOOL_REGISTRY`/`dispatch_tool` at all — register them in `lib/tool_dispatcher.py`'s
`ToolDispatcher` instead (§1's "pick a winner" recommendation), which already has the
guaranteed `{"error": ...}` contract built in. This sidesteps the Round 1 gap entirely for this
new capability without requiring the `dispatch_tool` fix to land first — but it does **not**
retroactively fix the other ~60 tools' shared risk, which the team should still close
independently, per Round 1's recommendation, exactly because this pass just found a second
reason that risk exists (a growing, not shrinking, set of tools that could hit it).

**This does not close the `TOOL_PERMISSION_MAP` gap, and I'd deliberately design around needing
to.** `ToolDispatcher.dispatch()`'s `allowed_tools` parameter is a *skill*-scoped allowlist (a
skill's own `allowed-tools` frontmatter), not a *role*-scoped one (`CrystalContext.effective_perms`/
`ROLE_PERMISSIONS`) — these are different axes, and `ToolDispatcher` doesn't take a
`CrystalContext` at all today (just a plain `ctx: dict`), so it has no way to consult
`effective_perms` even if asked to. Rather than extending `ToolDispatcher` to understand roles
(real new scope, and a second place permission logic would need to stay in sync with
`crystal/context.py`), I'd deliberately constrain every validator function's signature to
**pure-function, no-DB/no-network, operates only on data already present in `skill_input`/
`output_raw`** — the same shape `_cap_trust`/`detect_quality_signal` already have. A validator
that can't fetch anything new can't leak anything a role-based gate would have blocked, because
whatever data it sees already passed through a permission-respecting tool call upstream to get
into `skill_input` in the first place. This makes the `TOOL_PERMISSION_MAP` gap **irrelevant to
this specific new capability by construction**, not fixed — the underlying gap (4-of-60 tool
coverage, legacy-path-only enforcement) still stands exactly as Round 1 found it and still
needs its own decision, unrelated to code-interpreter work.

---

## 3. Anything from Round 1 I'd revise given this new thinking

1. **Add `lib/tool_dispatcher.py` to the Round 1 functionality checklist** — I didn't read this
   file in Round 1 at all, which in hindsight is a real gap in my own "authoritative map of
   every existing capability": it's initialized at every startup (`main.py:153-156`) and is
   fully tested, so a future reader could reasonably assume it's live production infrastructure
   for skill tool-calling. It isn't. This should have been in Round 1's §1 checklist as "exists,
   initialized, unused" — I'm correcting that omission here rather than waiting for a Round 3.
2. **Round 1 §2 item 4 (formalize the `dispatch_tool` error contract) gets a concrete
   "how," not just a "should."** I described it in Round 1 as a one-line wrapper inside
   `dispatch_tool` itself; having now found `ToolDispatcher` already does this, I'd revise the
   recommendation to: either (a) port `dispatch_tool`'s try/except-wrapping behavior to match
   `ToolDispatcher`'s exactly (cheapest, keeps two systems but at least consistent contracts), or
   (b) the bigger but more valuable move, migrate `crystal/tools.py`'s tools onto
   `ToolDispatcher` over time and retire `dispatch_tool`. I'd only recommend (b) as a deliberate,
   separately-scoped cleanup project — not bundled into the code-interpreter work — since it
   touches every one of Crystal's ~60 tools' call sites (`_react_plan_tools`, `_fetch_skill_context`),
   which is exactly the "riskiest area" I flagged in Round 1 §5.
3. **Round 1 §5 (riskiest area) is unchanged** — nothing in this pass touched
   `_run_skill_stream`/`_resolve_forced_skill`/`_normalize_proposal`, and I found no new reason
   to revise that assessment.
4. **Round 1 §6 (recommendation) stands, with one addition**: the two cheap, concrete,
   non-rearchitecture moves from this round (consolidate on `ToolDispatcher` for new tool-shaped
   capabilities; add the `_POST_GENERATION_PROCESSORS` list inside `SkillRuntime.execute()`)
   should be sequenced *alongside* Round 1's two Tier 1 recommendations (provenance-stamp
   `TurnEvent`; formalize the tool-error contract) as the same kind of small, independently
   valuable, low-risk first steps — not as a separate, later "extensibility project."
