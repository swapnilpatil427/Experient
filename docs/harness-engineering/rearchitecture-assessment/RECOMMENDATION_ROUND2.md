# RECOMMENDATION — Round 2: Extensibility + Code-Interpreter/Skill-Runtime Structures

> Synthesizes `findings-*-round2.md` from all five team members (all read in full). Builds
> on `RECOMMENDATION.md` (Round 1) — read that first if you haven't. This round asked two
> new questions: (1) does "no rearchitecture" still hold under a forward-looking
> *extensibility* framing rather than a "fix today's mess" framing, and (2) should CrystalOS
> gain a code-interpreter-style capability, designed in-house with zero new library/vendor
> dependencies.

## The headline result

**Both questions converged across all five members even more tightly than Round 1 did.**

1. **Extensibility**: still no middleware/hook framework — but this round found *concrete,
   already-existing evidence* (not speculation) for exactly one narrow extension point, and
   uncovered a live decision CrystalOS has been silently avoiding.
2. **Code interpreter**: unanimous, independently-derived verdict — **no sandbox, no
   subprocess, no container, ever, for the need that actually exists today.** Just a fixed,
   pre-registered library of deterministic validator functions, dispatched by name. Dr.
   Reyes's from-scratch sweep of all 46 skills' `EVALS.md` files turned this from a
   plausible-sounding recommendation into a measured one: **13 of 46 skills (~28%)** share
   one deterministically-checkable criterion shape currently burning an LLM call on it, and
   she found a live, safety-relevant bug as a side effect.

## Part 1: Extensibility, reframed and re-answered

### The verdict, precisely

Round 1's conclusion ("CrystalOS's core is deliberately reasoned-about code, not accidental
complexity that a framework would clean up") still stands and nobody walked it back. But
Round 2 sharpens *why* "no framework" is still right, with real evidence instead of a
general principle:

- **Dr. Reyes counted it**: at least 8-9 genuinely separable cross-cutting concerns (eval
  gate, retry, baseline fallback, example-bank write, org-cap/dedup, tracing, A/B variant
  resolution, `BrandContext` permissions, telemetry) have already been layered onto
  `SkillRuntime`/`crystal.py` over the product's life, every one absorbed the same cheap way
  — appended as one more block, usually wrapped in `try/except: pass` (26 such blocks in
  `crystal.py`). No contorted rewrites, no fighting over one insertion point. **That's real
  evidence the ad hoc pattern isn't under strain** — the opposite of what would justify a
  framework.
- **Priya independently arrived at the same shape from the code side**: `SkillRuntime.
  execute()` has exactly two structurally different *kinds* of extension need, and trying to
  unify them into one generic mechanism would recreate the "no runtime to hang a hook on"
  problem Round 1 already flagged. She names them Kind A (pure, order-independent output
  transforms — e.g. PII redaction) and Kind B (deterministic pre-checks that must drive the
  existing eval/retry control flow) and recommends two small, purpose-fit, *separate*
  mechanisms, not one abstraction.
- **Marcus found the concrete cautionary tale**: `lib/tool_dispatcher.py`'s `ToolDispatcher`
  is a fully-built, fully-tested, better-behaved tool dispatcher (manifest-driven,
  structurally-guaranteed error contract, per-skill allowlist gating) — initialized at every
  startup, and **never called anywhere in production code**. CrystalOS already built one
  narrow, well-designed extension point once, and a separate effort added the next batch of
  tools straight into the older `crystal/tools.py` mechanism instead, with no documented
  decision between them. This is the actual 12-month extensibility risk made concrete: not
  "today's code is messy," but "the next contributor adding a capability has two
  unreconciled mechanisms to choose between and no guidance."
- **Dr. Reyes also found the one genuine trigger condition**: a deterministic pre-check that
  must run *before* `_check_evals`'s LLM judge and, on failure, substitute for it — needed by
  **13+ skills today, not hypothetically**. That's the bar she'd set for "build the
  mechanism" (3+ concerns needing shared ordering/state), and it's cleared for real, for the
  first time in either round.

### What to actually build (all five agree on the shape; sizing from Priya)

1. **Pick a winner between `ToolDispatcher` and `crystal/tools.py`'s `dispatch_tool`/
   `TOOL_REGISTRY` — a documentation-and-convention decision, not a migration.** Marcus's
   recommendation, and the cheapest possible fix to the clearest extensibility risk found in
   either round: `ToolDispatcher` becomes the home for any *new* tool-shaped capability
   (starting with the validator registry below); `crystal/tools.py` stays frozen as the
   stable surface for the existing ~60 tools. Not a rip-and-replace — a decision, recorded,
   so the next contributor doesn't have to guess.

2. **A narrow "pre-eval deterministic checker" stage inside `_check_evals`** (Dr. Reyes's
   size estimate: ~half a day for the mechanism itself, separate from writing individual
   checkers). This is the one extension point with real, current, multi-consumer demand —
   see Part 2, since it's the same mechanism the code-interpreter design needs.

3. **A small, separate `_OUTPUT_TRANSFORMS` list for Kind-A concerns** (Priya, 1-1.5 days) —
   justified independently of the code-interpreter question: `lib/pii_scrubber.py` already
   exists and is already used for trace output, but is **not wired into `SkillRuntime.
   execute()`'s own output path** — a real, live gap, found only because this round asked
   "what would make the next addition cheaper." Insert right before the example-bank write
   so PII never reaches `skill_examples`.

4. **Dana's one process discipline, regardless of what gets built**: any new mechanism that
   can add a field to the response object must come with an explicit checklist item —
   update `crystalHandler`'s SSE pluck-list in `backend/src/routes/experience.ts` in the same
   PR. This is not new work; it's making an already-necessary step impossible to forget.

5. **Jordan's proposal, worth doing now rather than after more event types accumulate**:
   formalize CrystalOS's SSE `event.type` vocabulary as a discriminated Pydantic union with a
   single `emit()` helper, mirrored by one frontend TypeScript type, with a lightweight CI
   check diffing the two. ~1 day. This is the same "pick a canonical, generated-not-hand-
   maintained shape" idea from Round 1's BRIEF (schema-generation-on-demand), applied to the
   one contract seam that's actually grown twice already (Dana's Round 1 finding that `viz`
   needed its own explicit pluck-list addition; this round's `applied_filters` and any future
   validator-progress narration would be a third and fourth).

**What NOT to build**: a generic `before_agent`/`wrap_tool_call`-style hook-point
vocabulary spanning both kinds. Every team member who looked at this specifically (Priya
explicitly, Marcus implicitly by proposing two separate small mechanisms instead) concluded
that forcing Kind A and Kind B into one shared interface would recreate exactly the "no
framework runtime to attach names to" problem Round 1 correctly rejected.

## Part 2: Code interpreter / skill-runtime structures

### The verdict, precisely

**No sandbox. No subprocess. No container. A fixed, pre-registered library of deterministic
Python functions, dispatched by name, is not a compromise position — it's the option every
team member arrived at independently as the *correct* one for the need that actually exists,
not merely the cheapest one that would do for now.**

### Why (converging from four independent angles)

- **Priya confirmed, by reading the code, that this is structurally the only shape that
  fits.** `SkillRuntime.execute()` is one-shot: at most two LLM calls ever (attempt + one
  retry), zero tool-dispatch capability inside it (grepped the whole file — zero
  `dispatch_tool`/`tool_call` matches). A skill cannot "ask" for code execution mid-generation
  the way `qualtrics-agent-skills`' agent calls its sandbox's `execute` tool, because there
  is no second model turn for a tool result to feed into except the existing retry. This
  rules out "new `TOOL_REGISTRY` entry the model requests mid-loop" for skills specifically —
  that native ReAct tool-calling protocol only exists in the legacy `?legacy=true` admin-debug
  path, and building a new capability only that deprecated path can reach would be building
  it in the wrong place.
- **Dr. Reyes measured the actual need, not the hypothetical one.** A full read of all 46
  `EVALS.md` files (not the 6 sampled in Round 1) found every single deterministically-
  checkable candidate — across the whole corpus — is one of five or six *known, finite,
  nameable* shapes: array-length-and-keys, enum membership, numeric range, set-membership-
  against-a-known-table, threshold-to-label, arithmetic recompute. Nothing in the current
  skill corpus asks for a skill to author *novel* code at request time — the actual thing a
  sandbox exists to make safe. QAH's `execute` tool and QAS's `compile_logic.py` earn their
  sandbox because their skills call arbitrary pre-uploaded scripts with real I/O inside a
  genuine VM; CrystalOS's real backlog is "run this specific, already-known check."
- **Marcus confirmed CrystalOS already made this exact choice once, explicitly, in writing.**
  `lib/tool_dispatcher.py`'s own docstring: "Internal tools... called directly via
  importlib — sub-millisecond overhead, **no subprocess**." Zero subprocess/container/
  RestrictedPython usage exists anywhere in `lib/`, `crystal/`, `graphs/`, or `tools/` today.
  Introducing process/container isolation for this one capability would be the *first* of
  its kind in the codebase, not a natural extension of an existing pattern.
- **Dana confirmed the infra reality makes anything heavier a real, non-trivial new
  investment, not a small increment.** CrystalOS runs 2 uvicorn async workers on a small Fly
  VM, non-root Docker image (deliberately dropped privileges), zero container orchestration
  anywhere in the tree. A subprocess-with-resource-limits approach can't actually deliver a
  hard "no network egress" guarantee without OS-level controls the current hardening
  explicitly removed — a materially weaker security story than it sounds, not a shortcut. A
  real container/microVM sandbox is reachable without a new vendor (Fly's own Machines API)
  but is genuinely new operational surface (provisioning, health/cleanup, cold-boot latency,
  cost) matching nothing CrystalOS's codebase manages today.

### The concrete design (Priya + Marcus + Dr. Reyes converge on the same shape)

**Two tiers, priced very differently, and the first is nearly free:**

**Tier 1 — broaden `_eval_structural`'s existing keyword/regex dispatch.** Dr. Reyes's
highest-leverage finding: adding a couple more phrasing patterns ("entries with", "is one
of") to `STRUCTURAL_KEYWORDS`/its regexes converts the 13-skill "N-M array entries with
named fields" cluster and a 3-skill enum cluster from LLM-judged to deterministic — **zero
new architecture, zero new skill-authoring convention, zero new call sites.** Estimated at
**~30 minutes.** Do this first, regardless of anything else in this document.

**Tier 2 — a small `VALIDATOR_REGISTRY`, for checks that need the skill's *input*, not just
its output** (set-membership against a known table, arithmetic recompute against input
values). Concrete mechanism, converged on by Priya and Marcus independently:

- A new, small, in-house module (`lib/skill_validators.py` or similar) — a plain `dict[str,
  Callable]` + a 5-line registration decorator, the same shape `TOOL_EXECUTORS` already uses
  elsewhere in this codebase.
- One new optional SKILL.md frontmatter field (`validator: <name>`, absent by default — every
  existing skill is byte-identical in behavior with the field absent).
- Wired into `_check_evals`: if a skill names a registered validator, run it before/alongside
  EVALS.md parsing; on failure, treat it exactly like a `must pass` criterion — feed its
  issues into the **existing** `retry_ctx["failed_criteria"]` mechanism verbatim. Zero new
  control-flow code; a validator failure automatically drives the retry loop that already
  exists.
- **A real, currently-blocking bug this tier must fix first**: `_eval_criterion` already
  receives `input_data` as a parameter, but the structural-check branch only calls
  `self._eval_structural(description, output)` — `input_data` is silently discarded before
  it gets there. Any set-membership-against-input check is impossible today without this
  small, mechanical fix.
- Register these new validators through `ToolDispatcher` (Part 1's decision), not
  `crystal/tools.py` — sidesteps Round 1's `dispatch_tool` error-contract gap for this new
  capability entirely, for free, without requiring that gap to be fixed first.
- **Deliberately constrain every validator to pure-function, no-DB/no-network, operating only
  on data already present in `input_data`/`output`.** Marcus's insight: this makes the
  `TOOL_PERMISSION_MAP` role-based gap (Round 1's finding — only 4 of ~60 tools have a
  permission mapping) *irrelevant to this new capability by construction*, not fixed — a
  validator that can't fetch anything new can't leak anything a role gate would have blocked,
  because whatever it sees already passed through a permission-respecting call upstream.

**Concrete pilots, in priority order (converged across Marcus, Dana, Dr. Reyes):**

1. **Tier 1's broadened regex — 13+ skills for free**, no pilot needed, just ship it.
2. **`workflow-analyst`'s registry-membership check (E2/E3/E6)** — Dr. Reyes's top Tier-2
   pick: the skill's own `EVALS.md` explicitly states this is the highest-stakes criterion in
   the entire 46-skill corpus ("a bad proposal here can reach a confirm-card and create a
   real automation"), and it's currently adjudicated by the same generic single-token LLM
   call as every softer criterion elsewhere. The natural forcing function for the
   `input_data`-plumbing fix.
3. **`compliance-scanner`** (Marcus/Priya's original candidate, Round 1) — Priya sized a full
   MVP against this specific skill: **~2.5-3 engineer-days total**, entirely additive, fully
   backward-compatible. Notably cheaper than Round 1's original per-skill estimate because it
   bundles the one-time infrastructure cost with the first validator — the *next* skill
   wanting one costs only ~1-2 days, the concrete "each addition cheaper than the last" proof
   Reframing #1 asked for.
4. **`driver-analyst`'s quadrant classification and `tag-analyst`'s confidence-tier check**
   (Marcus) — both already receive exactly the pre-computed numbers a validator needs, no new
   data plumbing required.
5. **Survey-creation's existing ID-fix/skip-logic guards and Custom Analysis's `trust_score`
   cap** (Dana) — not new logic at all, just extracting already-existing, already-correct
   inline Python into the named registry so it's reusable and visible in one place instead of
   scattered across `creator.py`/`copilot.py`/`custom_analysis.py`.

### Before any of this ships (Dana's ship-blocking requirement)

Even the cheapest option (pre-registered pure functions, no subprocess) needs **one
crash-isolation regression test before ship, not after**: fire a deliberately hanging or
memory-heavy call concurrently with a normal request on the same worker process, assert the
normal request still completes within its own SLA. This is the direct CrystalOS-specific
analogue of the lesson Round 1's research already cited from `cme-langgraph-service`'s
CLAUDE.md ("one bad graph construction hard-fails the entire pod") — applied to the request
layer instead of startup, and worth treating as non-negotiable because it's cheap to write
and it's the one test that actually proves the blast-radius question rather than assuming it
away. Pair it with a hard wall-clock timeout, input-size caps at the call boundary (mirroring
`security.py`'s existing `MAX_INTENT_LEN` discipline), and a small in-process concurrency
semaphore decoupled from Express's per-org rate limit.

### The bar for ever going further (all three technical members agree on this line)

Move past Tier 2 toward any real sandbox **only** when a skill needs to compose or generate
*novel* validation/compilation logic at request time that nobody anticipated and
pre-registered — the QAS `compile_logic.py` scenario, where the IR schema itself is rich
enough that hand-enumerating every check up front isn't tractable. **Nothing in the current
46-skill corpus asks for that today.** If that trigger is ever hit, Dana's ops-safety opinion
is to skip straight to a real container/microVM (via Fly's own Machines API, no new vendor
needed) rather than landing on a subprocess-with-limits as a false middle ground — that
option gives up real isolation guarantees for the appearance of cheapness without actually
being cheap to build correctly.

## A live, independent bug this investigation surfaced — separate from either question, more urgent than both

Dr. Reyes's full sweep of all 46 `EVALS.md` files found that **three skills' EVALS.md —
`gap-analyst`, `platform-gap-tracker`, `xm-market-researcher` — use a prose/bullet format
with zero markdown pipe-table rows.** `_parse_evals_md` only extracts lines starting with
`|`, so all three silently parse as empty and fall through to `_baseline_output_check` (any
non-empty output with one substantive field scores 0.70 and auto-passes). `platform-gap-
tracker`'s own EVALS.md contains a hand-written safety rule — "Marking GAP-001/002/003
[SOC2/HIPAA/FedRAMP] as CLOSED for any reason → fail (requires human + external audit)" —
that **is never actually checked by any code path today.** This has nothing to do with
either reframing question and should be treated as its own, higher-priority fix: either
support the prose format, or at minimum make a file-exists-but-yields-zero-criteria case log
distinguishably from "no EVALS.md file exists at all" (today both log the same
indistinguishable path).

## Combined ranked action list (Round 1 + Round 2, re-sorted by urgency)

1. **Fix the 3-skill EVALS.md parsing bug** (above) — safety-relevant, live, cheapest fix in
   either round, do this first regardless of anything else.
2. **Broaden `_eval_structural`'s regex dispatch** (Tier 1, ~30 min) — 13+ skills go
   deterministic for free.
3. Round 1's Phase 0 (provenance stamping, tool-error contract at `dispatch_tool`, log-routing
   discipline, the removal-tracking table) — unchanged, still cheap, still worth doing.
4. **Decide `ToolDispatcher` vs. `dispatch_tool`** (Marcus) — a documentation decision, do it
   now before a third mechanism gets invented for the next new capability.
5. Round 1's Phase 1 context-gate consolidation (`_build_ctx`, 6→1 call sites).
6. Fix the `input_data`-discarded-before-`_eval_structural` bug, build the `VALIDATOR_REGISTRY`
   mechanism (Tier 2, ~2 days infra), pilot on `workflow-analyst` and/or `compliance-scanner`
   (~1-3 days each thereafter).
7. Wire `pii_scrubber.scrub` into `SkillRuntime.execute()`'s own output path via the new
   `_OUTPUT_TRANSFORMS` list (~1-1.5 days) — closes a real, currently-live gap found this
   round.
8. Round 1's Phase 2 (`applied_filters`) — still gated on the canonical filter-shape design
   decision; consider bundling with Jordan's `provenance` object unification idea from her
   Round 2 findings (fold `applied_filters` and a new "verification" signal into one shared
   disclosure object rather than two one-off fields).
9. Formalize the SSE event-type vocabulary as a discriminated union (Jordan, ~1 day) — do
   before, not after, the validator work adds any progress-narration event types.
10. Everything Round 1 explicitly deferred (offline eval harness, structured memory, typed
    skill-graphs) — still deferred, no new evidence surfaced this round changes that.

**Explicitly, permanently out of scope unless the one named trigger condition is hit**: any
subprocess sandbox, restricted-Python interpreter, or containerized code-execution
environment. Every team member who examined this converged on the same conclusion from a
different angle — that's five independent confirmations, not one opinion repeated.
