# Findings — Priya, Round 2 (AI Agent / Harness Engineer)

**Lens:** implementation feasibility. Same constraints as Round 1: research only, no code
changes, no Qualtrics-specific references, no new library dependency (deepagents/LangChain
stay out of scope as things to adopt).

---

## 1. Revised recommendation on Reframing #1 (extensibility)

**Round 1's core reasoning still holds, but a narrower version of the idea survives the
sharper question — with an important boundary I did not draw clearly enough in Round 1.**

Re-reading all 670 lines of `skill_runtime.py` specifically for this: `SkillRuntime.execute()`
(lines 88-272) already has exactly two structurally different kinds of "insertion point" living
inside it, and the extensibility question has a different answer for each:

**Kind A — pure, best-effort, order-independent transforms of the model's output.**
Today there is exactly one candidate in this category that isn't built yet: PII redaction of
`output_raw` before it's logged/returned/written to `skill_examples`. Notably, `lib/pii_scrubber.py`
**already exists** and is already imported and used elsewhere (`agents/crystal.py`'s `_run_crystal`:
`from crystalos.lib.pii_scrubber import scrub as _scrub`, used to scrub the Langfuse trace input) —
it is simply not wired into `SkillRuntime.execute()`'s output path today. A second, more
speculative candidate: some future "normalize whitespace/units" or "truncate runaway fields"
transform. Both share an identical shape: `(output: dict) -> dict`, side-effect-free, must never
raise (fail-open), order mostly doesn't matter between them.

For this kind, I'd reverse my Round 1 position slightly: **a narrow, named, ordered list —
`_OUTPUT_TRANSFORMS: list[Callable[[dict], dict]]`, populated via a plain 5-line
`@register_output_transform` decorator, no framework, no new dependency — is worth building
once there are 2 real candidates, not 3.** The reason isn't the list mechanics themselves (a
bare list of function calls in sequence would work identically); it's that a registered-list
pattern lets each transform **live in its own module and self-register** (e.g.
`lib/pii_scrubber.py` calls `@register_output_transform` on its own `scrub_skill_output`
function), so wiring a new transform in requires **zero edits to `skill_runtime.py` itself** —
only a new import somewhere at startup (mirroring how `main.py`'s `lifespan` already imports
`skill_registry`/`tool_dispatcher` without those modules needing to be edited to add a new
skill). That is a real, if modest, difference from "just add another function call in the
sequence": the "just add a call" version requires every future PII-adjacent concern's author to
edit the shared `execute()` body directly, which is exactly the kind of shared-file-contention
Round 1 already flagged as a cost of the current 6-call-site `_build_ctx` duplication (different
problem, same shape of cost: N people editing 1 shared function).

Effort: **1–1.5 days** — the list + decorator + one insertion point in `execute()` (right after
the retry-resolved `output_raw` is finalized, before the `_write_example_async` call at line 213,
so PII never reaches the example bank) + wiring `pii_scrubber.scrub` in as the first real
transform + a test asserting (a) transforms run in registration order, (b) a raising transform is
caught and logged, never propagated (matching the existing `_fire_telemetry`/tracer fail-open
convention already used elsewhere in this same file). This is squarely a **Tier-1-sized** item,
not a rearchitecture — it just wasn't on Round 1's list because Round 1 was scoped to "fix
current pain," and there was no current pain here (PII redaction for skill outputs was never
asked for in Round 1). It shows up now because Round 2 is explicitly asking "what makes the
*next* addition cheaper," and this is a real, if small, answer.

**Kind B — deterministic pre-checks that must interact with the existing eval/retry control
flow.** This is the validator-paired-eval-gate idea (Round 1 Tier 2 #8) and Reframing #2's
code-interpreter question (see §2 below) — a validator's result has to become `eval_issues`,
has to potentially force the *existing* retry-with-failure-context loop (`skill_runtime.py`
lines 175-208), and has to respect `max_retries`. **I do not think this kind should go into the
same generic list as Kind A**, and I do not think a generic "post_processors" abstraction that
tries to cover both is worth building. The reason is concrete, not just aesthetic: Kind A
processors are `dict -> dict` and never affect control flow; Kind B needs to produce
`(score, passed, issues)`-shaped output that plugs into the *same* branch `_check_evals` already
computes at line 172, and if two different generic "processors" have different return shapes,
either (a) you force Kind A's simple transforms to also return a score/passed/issues tuple they
don't have (awkward, meaningless "always passed" boilerplate on every transform), or (b) you keep
two separate registries anyway — at which point you've built two small, purpose-fit
mechanisms, not one generalized "post-processor" framework, which is exactly the "adopt the
pattern, not the framework" position Round 1 already argued for. So: **one narrow list for Kind
A (worth it, ~1-1.5 days, pays for itself starting at the 2nd real transform), one narrow named
hook for Kind B — a `skill_meta["validator"]` lookup feeding directly into `_check_evals`'s
existing issue/retry machinery (see §2.2 below for the concrete design) — and no single unifying
abstraction over both.**

**Does Round 1's "no rearchitecture" conclusion still hold for the 12-month extensibility
framing?** Yes, with the above refinement stated explicitly rather than left implicit. The
"middle ground" Reframing #1 asks about — a purpose-built extension mechanism short of a full
middleware framework — **does exist and is worth building**, but it is two small, differently-shaped
mechanisms (a transform list + a named validator hook), not one generic hook-point vocabulary
modeled on `before_agent`/`wrap_tool_call`. Round 1's thin-evidence critique of the *borrowed*
middleware framing (no runtime underneath to make generic hook names load-bearing) still applies
in full to anything trying to generalize across Kind A and Kind B — it does not apply to either
kind built narrowly on its own terms, which is why I'm revising the specific scope of "adopt
selected patterns," not the overall "no framework" conclusion.

---

## 2. Full design answer to Reframing #2 (code interpreter / skill-runtime structures)

### 2.1 Is `SkillRuntime.execute()` one-shot or multi-turn with tool access? (checked against the actual code)

**One-shot, confirmed precisely.** Reading `skill_runtime.py:88-272` again with this exact
question in mind:

- The **first attempt** (lines 122-169) is exactly one `call_agent(...)` call with
  `output_schema=_SkillOutput` (an open `extra="allow"` Pydantic model, `skill_runtime.py:30-35`)
  — there is no loop, no `tool_calls` field parsed anywhere in this function, and no call to
  `dispatch_tool` (`crystal/tools.py:3799`) anywhere in `skill_runtime.py`. I grepped the whole
  file for `dispatch_tool`/`tool_call` to confirm — zero matches.
- The **retry** (lines 176-208) is exactly one more `call_agent(...)` call, gated on
  `eval_passed` being False and `max_retries > 0` (which is `1` for every skill I checked,
  including `compliance-scanner`'s `max_retries: 1` frontmatter field). So the absolute maximum
  is **two LLM calls per skill invocation, ever** — never more, and never with tool access
  mid-generation.
- Tool context a skill uses is **entirely pre-fetched, before `SkillRuntime.execute()` is even
  called** — `agents/crystal.py`'s `_fetch_skill_context` (line 1671) runs up to 3 deterministic,
  hard-coded tool calls (`dispatch_tool`, from the priority list at line 1708) *before* routing to
  `_skill_synthesis` → `runtime.execute(...)`. By the time the skill's system prompt is built
  (`_build_system`, `skill_runtime.py:276`), `tool_results` are already baked into
  `skill_input["tool_results"]` as static JSON the model reads — the model cannot request a new
  tool call, and there is no code path that would notice if it tried (its JSON output is parsed
  as `_SkillOutput`, whose only special-cased fields anywhere downstream are
  `answer`/`citations`/`suggestions`/`insight_refs`/`action_proposals`/`viz`-shaped keys consumed
  by `_normalize_skill_output`, `agents/crystal.py:1280`).

This is the load-bearing fact for the whole design: **a skill cannot "ask" for code execution
mid-generation the way `qualtrics-agent-skills`' agent calls its sandbox's `execute` tool**,
because there is no second model turn in which a tool result could be read and reacted to. Any
code-interpreter-style capability for skills has to be either (a) fully pre-fetched, like today's
tool context (run before the LLM call, results baked into the prompt), or (b) run as a
*deterministic post-check* after the LLM call, feeding into the *retry*, not into a fresh model
turn with tool access. This rules out "new `TOOL_REGISTRY` entry the model requests via the
ReAct-style JSON tool-call protocol" as the mechanism **for skills specifically** — that
protocol exists only in `crystal.py`'s `_react_plan_tools` loop (the legacy `?legacy=true` path
and, in a narrower deterministic form, `_fetch_skill_context`'s pre-fetch), not inside
`SkillRuntime.execute()` at all. A `TOOL_REGISTRY` entry would be reachable by the *legacy* ReAct
loop (any skill-agnostic Crystal conversation using `_run_react_loop_streaming`), but that path is
explicitly the admin-debug fallback per `crystal.py`'s own docstring ("legacy ReAct loop for admin
debug") — building a new capability that only the deprecated path can reach would be building it
in the wrong place.

**Conclusion: this has to be a new post-processing stage inside `SkillRuntime.execute()`
itself** (option (b) above), resolved by a name the skill declares in its own metadata — not a
tool the model calls mid-loop, and not a new `TOOL_REGISTRY` entry in the sense the ReAct loop
uses one.

### 2.2 Concrete mechanism

Mirror `crystal/tools.py`'s existing `TOOL_EXECUTORS`/`dispatch_tool` shape (`crystal/tools.py:3719,
3799`) — CrystalOS already has exactly this pattern built, just for a different call site. Add:

```
# lib/skill_validators.py  (new, small, in-house — no new dependency)
VALIDATOR_REGISTRY: dict[str, Callable[[dict, dict], dict]] = {
    # name -> fn(input_data, output) -> {"valid": bool, "issues": [str, ...]}
}

def register_validator(name):        # 5-line decorator, same shape as Kind A's transform registry
    def _wrap(fn):
        VALIDATOR_REGISTRY[name] = fn
        return fn
    return _wrap
```

- `skill_registry.py::_parse_skill_md` (`lib/skill_registry.py:126`) gains **one new optional
  frontmatter field**, `validator: <name>` (defaults to `None` — every existing skill is
  byte-identical in behavior with this field absent, matching the codebase's own convention for
  additive optional fields, e.g. `related-skills`/`compatibility` today).
- `SkillRuntime._check_evals` (`skill_runtime.py:359`) gains one new step, run before parsing
  `EVALS.md` criteria (or alongside — order doesn't matter, both contribute to the same
  `issues`/`weighted_sum` accumulation): if `skill_meta.get("validator")` names a registered
  function, call it synchronously with `(input_data, output)`, and if `valid` is False, treat it
  exactly like a **`must pass`-threshold EVALS.md criterion** — append its issues to the `issues`
  list and set `must_pass_failed = True` (reusing the exact branch at `skill_runtime.py:402-405`
  verbatim, just with a second source of must-pass failures).
- This means a validator failure **automatically drives the existing retry-with-failure-context
  loop** (`skill_runtime.py:176-208`) with zero new control-flow code — `eval_issues` already
  flows into `retry_ctx["failed_criteria"]` today; a validator's issues arrive in the same list,
  through the same variable, into the same retry prompt.
- **Where results surface: into the retry loop, not as a tool result.** Given §2.1's one-shot
  finding, "as a tool result feeding into a skill's context" isn't reachable for skills at all —
  there's no second turn to feed it into except the retry, which already exists and already has
  exactly this shape. Both of the brief's two options ("tool result" vs "`_check_evals` retry
  loop") collapse to the same answer here: it has to be the retry loop, because that's the only
  second-turn mechanism `SkillRuntime` has.
- **Is this "arbitrary code" at all?** No — and that's the point. The model never authors a
  script; it can, at most, be given influence over *which* pre-approved validator runs and with
  what structured args, by naming one in its own JSON output (mirroring
  `qualtrics-agent-skills`' `compile_logic.py` IR pattern: the model expresses *intent*, code
  handles *execution*) — but for the compliance-scanner MVP below, even that's unnecessary: the
  skill's `SKILL.md` frontmatter names one fixed validator, period. There is no code path by which
  a skill or a model input can cause a *new*, previously-unreviewed function to run — every
  callable in `VALIDATOR_REGISTRY` is written and merged by a CrystalOS engineer, exactly like
  every entry in `TOOL_EXECUTORS` today.

### 2.3 Isolation mechanism — where CrystalOS should sit on the spectrum, and why

**Recommendation: sit at the narrowest end — a fixed, pre-registered library of deterministic
Python functions, zero arbitrary code execution, zero sandbox.** Three options, sized:

| Option | Mechanism | Effort (days) | Security posture | Fits `SkillRuntime`'s one-shot structure? |
|---|---|---|---|---|
| **1. Fixed validator registry** (recommended) | `VALIDATOR_REGISTRY` dict + decorator (§2.2), skills declare a name in frontmatter, functions are ordinary reviewed/merged Python | **Infra: 1.5–2** (registry + wiring into `_check_evals`/frontmatter parsing + fail-open try/except + tests pinning "absent `validator` field ⇒ zero behavior change"). **+1–2 per validator function written** (depends on domain complexity — a regex/lookup-table check is ~0.5 day; something like a full logic-integrity pass modeled on `survey_pipeline.py`'s id/renumbering passes is 1.5–2 days). | Zero new attack surface — these are functions in the codebase already, code-reviewed like everything else. No secrets/model/network access inside them beyond whatever the function's own signature exposes (just `input_data`/`output` dicts). | **Yes, exactly** — matches the one-shot + at-most-one-retry structure with zero new control flow; reuses the existing `must pass` / retry machinery verbatim. |
| **2. Subprocess sandbox** (skill-authored or model-emitted small scripts, resource/time-limited, "no network" attempted) | `subprocess.run([sys.executable, script_path], timeout=N)` + POSIX `resource.setrlimit` (CPU/memory) + temp-dir-scoped filesystem + a stdout/JSON result convention | **6–10** — process isolation is cheap (~0.5 day) but genuine "no network egress" is *not* achievable from plain subprocess isolation on a shared host/kernel without OS-level network-namespace or firewall support (Fly.io's per-process model doesn't give CrystalOS's own code a lever to pull here); building + testing resource limits, temp-dir scoping, and escape-attempt test coverage is the bulk of the time, and even then the network-isolation guarantee is soft, not hard. | Meaningfully weaker than it sounds unless paired with real OS/network-level enforcement CrystalOS's own application code can't fully guarantee on typical PaaS deploys — this is the option's real cost, not the subprocess mechanics themselves. | **No** — this presumes a skill or model can author a *new* script per call, which requires either a second model turn (doesn't exist) or trusting model-emitted code as the "script" (a materially different, riskier design than dispatching a pre-approved function by name). |
| **3. Containerized sandbox** (self-hosted analog of AgentCore's Code Interpreter — a separate short-lived-container service) | New sidecar/service, container-per-call or warm pool, network policy enforced at the container runtime, JWT/internal-key auth from CrystalOS to it | **15–25+** — this is genuinely new deployable infrastructure (image build, orchestration, warm-pool latency management, auth, cost/monitoring), comparable in size to Round 1's T2-9 (offline eval harness) or larger, and explicitly the "heavy infra/vendor dependency" shape Round 2's brief says not to default to. | Strongest isolation of the three, but disproportionate to CrystalOS's actual need (§2.1 — skills don't have a mechanism to submit dynamic code in the first place without a bigger architecture change first). | **No, same reason as Option 2**, plus it solves a problem (arbitrary untrusted code) CrystalOS doesn't currently have. |

**Why Option 1 and not 2 or 3:** the entire point of Round 1's highest-confidence finding
(synthesis §3.1 — push provably-correct logic out of the LLM into deterministic code) is that
*CrystalOS engineers write the deterministic check*, not that the model authors code on the fly.
Every real example cited in the research (QAH's `trend_insights_analysis`, QAS's
`compile_logic.py`/`ie_validator.py`, CrystalOS's own `_build_viz_for_citations`) is a
**pre-written, reviewed, deterministic function** — none of them are a sandbox executing
model-authored scripts. Options 2 and 3 solve a different problem (untrusted/dynamic code
execution) that nothing in the Round 1 research, the compliance-scanner pilot, or any named
CrystalOS skill actually needs yet. Recommend Option 1 now; treat Option 2 as a real
reconsideration point only if a specific future skill needs the model to author genuinely novel
per-request logic (not just select among pre-approved checks) — and even then, revisit the
network-isolation gap honestly before treating "subprocess with limits" as sufficient. Option 3
is out of scope under this brief's own "zero new heavy infra" framing and I'd only bring it back
if CrystalOS decided, as a separate product decision, to support arbitrary user/model-authored
code execution as a first-class capability (a much bigger scope than "one deterministic
validator for compliance-scanner").

### 2.4 Minimum viable version to unblock the `compliance-scanner` pilot specifically

Confirmed against the actual skill: `skills/compliance-scanner/{SKILL.md,EVALS.md,EXAMPLES.md}`
exists today. Its `EVALS.md` has 5 criteria; the one most suited to a deterministic check rather
than an LLM judge is **E5 — "GDPR issues include regulation_reference" (weight 15, threshold
>= 0.80)**, currently scored by the generic `_eval_criterion` LLM-judge path (it isn't a
`STRUCTURAL_KEYWORDS` match per `skill_runtime.py:53-60` — "regulation_reference" doesn't hit
any of "valid json"/"required fields"/"count"/etc., so today an LLM call decides whether a
citation *looks* like a real regulation reference, which is exactly the kind of check a 5-line
regex/lookup-table function does more reliably and for free).

**MVP scope (no sandbox, no subprocess, nothing from §2.3 Options 2/3):**
1. `lib/skill_validators.py` — the `VALIDATOR_REGISTRY` + `register_validator` decorator (§2.2).
   **0.5 day.**
2. One real function, `compliance_citation_check(input_data, output) -> {"valid": bool,
   "issues": [...]}`: iterates `output.get("issues", [])`, for each issue whose `category`
   mentions GDPR/CCPA, checks `regulation_reference` against a small fixed set of known-valid
   citation patterns (e.g. `re.match(r"GDPR Art\.\s?\d+", ref)` for GDPR, an equivalent CCPA
   pattern) — flags any issue citing a regulation but failing the pattern match. **1 day**
   including its own standalone unit tests (no LLM call needed to test this function at all,
   which is itself a benefit over today's LLM-judge-only path).
3. Wire `skill_meta.get("validator")` into `_check_evals` (§2.2) + the new optional
   `validator:` frontmatter field in `skill_registry.py::_parse_skill_md`. **1 day**, including a
   regression test asserting every *other* existing skill (no `validator` field) is unaffected.
4. Add `validator: compliance_citation_check` to `compliance-scanner/SKILL.md`'s frontmatter.
   **Trivial** (content change).

**Total MVP: ~2.5–3 engineer-days**, entirely additive, zero new infrastructure, zero sandbox,
fully backward-compatible with every other skill (absent field ⇒ identical behavior to today).
This is strictly smaller than Round 1's original T2-8 sizing (2-4 days *per skill*, assuming the
generic mechanism already existed) because this MVP bundles the one-time infrastructure cost
(§2.2's registry + wiring, ~2.5 days total here) with the first validator — the *next* skill that
wants a validator (e.g., survey-creator's id/logic integrity, Round 1's other named candidate)
would then cost only the ~1–2 days for its own validator function, with zero repeated
infrastructure cost — which is exactly the "next three cheaper than the last one" property
Reframing #1 asked about, concretely demonstrated here rather than asserted in the abstract.

---

## 3. Revisions to Round 1 given this new thinking

1. **Round 1's Tier 2 #8 effort estimate (2-4 days/skill) should be split into a one-time
   infrastructure cost (~2.5 days, §2.4 steps 1+3 above) and a smaller per-skill marginal cost
   (~1-2 days, step 2) — I under-specified this in Round 1 by pricing each skill as if the
   registry/wiring had to be rebuilt every time.**
2. **Round 1 was right that a generic "named hook-point vocabulary for `SkillRuntime.execute()`"
   isn't worth it, but I'd now state the boundary more precisely**: it's not worth it as *one*
   generalized mechanism, but it *is* worth it as *two* narrow, purpose-fit mechanisms (Kind A
   output-transform list, Kind B validator-registry-into-retry-loop) that don't share an
   interface — because trying to make them share one would recreate the "generic hook, no
   runtime to attach it to" problem Round 1 correctly flagged.
3. **PII redaction for skill outputs (Kind A) wasn't on Round 1's radar at all** — it surfaced only
   because Reframing #1 asked "what makes the next 3 additions cheaper," and checking
   `skill_runtime.py`'s actual output path against what already exists elsewhere in the codebase
   (`lib/pii_scrubber.py`) revealed a real, currently-unwired gap worth closing regardless of the
   broader architecture question. Worth flagging to Marcus/Dana as a possibly-independent,
   smaller finding outside this round's main scope.
4. **Round 1's Recommendation stands**: adopt selected patterns incrementally, no structural
   middleware/hook framework — Round 2 sharpens *which* selected patterns (adds the Kind A
   transform list and the Kind B validator registry as two more concretely-scoped, small,
   in-house mechanisms) without changing the overall verdict.
