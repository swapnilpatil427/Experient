# Findings: Dr. Reyes (AI/ML Research Scientist) — Round 2

## 1. Revised recommendation on Reframing #1 (extensibility)

**Still "no formal middleware/hook framework" — but Round 2's own investigation surfaces
the first concretely-motivated (not speculative) case for one narrow, purpose-built
extension point, which I now recommend as an addition to the Round 1 answer, not a reversal
of it.**

I looked at how many distinct cross-cutting concerns are actually baked into
`SkillRuntime.execute()` / `agents/crystal.py` today, and how each one is wired, since git
history here is squashed into a handful of large feature commits (`git log --oneline --
lib/skill_runtime.py` returns only 2 commits total) and doesn't give a real incremental
timeline. The evidence has to come from the code's current shape instead — which is still
informative: it shows what the codebase's *de facto* extension pattern already is, and
whether that pattern is under visible strain.

Counting the distinct concerns actually present: (1) model resolution, (2) system-prompt
assembly, (3) the EVALS.md eval gate, (4) retry-once-with-failure-context, (5) the
baseline-output fallback for skills with no EVALS.md (its own docstring says it "replaces
the old blind 0.85 auto-pass" — direct evidence this was a *later* amendment, not designed
in from day one), (6) the example-bank write-back, (7) the org-cap + embedding-dedup checks
nested inside that writer, (8) Langfuse tracer logging, (9) A/B variant resolution
(`SkillVariant`/`resolve_variant`, entirely in `skill_registry.py`), (10) `BrandContext`/
`_resolve_permissions`, and (11) `_fire_telemetry`'s turn-event + product-signal detection
(both upstream/downstream of `SkillRuntime` entirely, in `agents/crystal.py`). That's at
least 8-9 genuinely separable concerns layered onto this pipeline over the product's life.

**Every single one was absorbed the same cheap way**: either appended as one more block at
a natural point in an existing linear `async def`, usually wrapped in `try/except
Exception: pass` (`crystal.py` has 26 such blocks — a strong proxy for "the established
low-friction extension idiom here is defensive appending, not registration"), or written as
a fully separate function called before/after the core execute() call with no threading
back into it (#9-11 above never touch `SkillRuntime.execute()`'s internals at all). I found
**no evidence in the current code shape of any addition requiring a rewrite of existing
logic to accommodate a new concern** — no contorted special-casing, no duplicated
eval-gate-adjacent logic fighting for the same insertion point. That is a real, if
indirect, data point *against* needing a formal extension mechanism: the ad hoc pattern has
already absorbed roughly 8-9 concerns without visible strain.

**What would flip this**: all 8-9 existing concerns are *independent* — none needs to run
conditionally on another's result, and the one true ordering dependency (retry must finish
before the example-bank write) is already hard-coded correctly in five lines. A formal
"named, ordered list of post-skill-execution processors" becomes worth its design cost only
when 3+ concerns need to (a) run in a specific relative order, (b) share intermediate
state, or (c) be individually enabled/disabled per skill. Reframing #2 below hands me
exactly that trigger condition for the first time: a deterministic pre-check that should
run *before* `_check_evals`'s LLM-judge call and, on failure, *replace* that call rather
than run alongside it, for **13 of 46 skills sharing an identical criterion shape** (see
§2). That is a concrete, non-speculative, already-multi-consumer case for one narrow
extension point — a short ordered list of "pre-eval deterministic checkers" tried before
the LLM judge, not a general `before_agent`/`wrap_tool_call`-style framework. I'd size this
as roughly a half-day change to `_check_evals`/`_eval_criterion`, not an architecture
project, and it is the one piece of "build the extension point now" I'd actually endorse —
narrowly, for this one insertion point, motivated by real current consumers rather than a
guess about what CrystalOS might need in 12 months.

So: Round 1's "adopt selected patterns only, no rearchitecture" still holds as the overall
posture, *and* it now comes with one specific, evidence-backed exception carved out, rather
than a blanket "no" to any extension point ever.

## 2. Full design answer to Reframing #2 (code interpreter / skill-runtime structures)

### The actual inventory (this is the primary deliverable — a real pass over all 46 `EVALS.md` files, not the 6 sampled in Round 1)

I read every `skills/*/EVALS.md` in full (dumped to one file, ~2,300 lines, read end to
end) looking specifically for criteria matching the BRIEF's named "Take" shapes (numeric
thresholds, format/schema checks, cross-referencing a known table, arithmetic,
threshold→label mapping) that currently fall through to `_eval_criterion`'s LLM judge
because they don't match `_is_structural_criterion`'s keyword list. Grouped by family, with
skill counts:

- **"N-M array entries with these named fields" (must-pass, currently LLM-judged).**
  12 skills share this **exact phrase** verbatim (`grep -rl "entries with id, type,
  priority, title, description, params" skills/*/EVALS.md`): `ces-action-advisor`,
  `close-the-loop-advisor`, `benchmark-strategist`, `distribution-strategist`,
  `enps-action-advisor`, `csat-action-advisor`, `journey-advisor`, `nps-action-advisor`,
  `predictive-action-advisor`, `segment-action-advisor`, `survey-improvement-advisor`,
  `voc-program-advisor` — plus `action-recommender`, which splits the same check into two
  criteria (count-only, fields-only). **13 skills, ~28% of the corpus**, gate a must-pass
  criterion on a single noisy LLM call for something that is `len(arr) in range` +
  `set(required_keys) <= dict.keys()` — zero ambiguity, zero judgment involved.
- **Enum / one-of membership (must-pass, currently LLM-judged).** `specialist-ces` E3
  ("effort_level is one of: low, moderate, high, critical"), `specialist-csat` E3,
  `specialist-enps` E3 — 3 skills, trivial `in` checks.
  `gap-analyst` E5 has the same shape but see the parsing bug below.
- **Integer/boolean/float type-and-range checks (must-pass, currently LLM-judged).**
  `compliance-scanner` E2/E3 (Marcus already flagged this one in Round 1),
  `survey-qc` E2 (identical shape, independently — "qc_score is integer 0-100, passed is
  boolean" — nobody seems to have noticed these two skills duplicate the same checker
  need), `specialist-custom` E5 ("confidence is float between 0.0 and 1.0").
- **Cross-referencing a known table / set-membership — the BRIEF's explicitly named "Take"
  pattern, and the richest family found.** `copilot-analyst` E4 (changes reference valid
  input `question_id`s, `>=0.90`), `schema-mapper` E2 + E4 (both **must-pass** — every
  input field accounted for; no hallucinated target ids), `taxonomy-mapper` E2 + E3 (both
  **must-pass** — every label placed exactly once; merge targets must exist in the
  registry), and — the standout candidate — **`workflow-analyst` E2, E3, E6, all
  must-pass**: every `trigger_type`/condition `field`/`action` in a proposal must exist in
  `tool_results.workflow_registry` (E2), every proposal must carry
  `requires_confirmation: true` (E3), at most one `create_workflow` proposal per turn (E6).
  `workflow-analyst`'s own EVALS.md explicitly states its overall pass bar is set higher
  than `crystal-analyst`'s specifically *because* "a bad proposal here can reach a
  confirm-card and create a real automation" — the skill's own authors identified this as
  the highest-stakes check in the file, and it is currently adjudicated by the same
  single-token, `max_tokens=5`, temperature-0 LLM call as every softer criterion elsewhere.
- **Threshold→label mapping (the BRIEF's `compile_logic.py`-style pattern).**
  `xo-fusion-advisor` E3 (`convergence_score` → `urgency_level`, thresholds given
  explicitly in the criterion text itself — `>=0.8` critical, `0.5-0.8` high, `0.3-0.5`
  medium), `case-advisor` E3 (NPS/CSAT band → severity, partially fuzzy because "churn
  language" detection needs a keyword list), `crystal-support` E6 (confidence calibrated
  vs. `resolved` flag).
- **Arithmetic recomputation.** `segment-analyst` E2 (`vs_overall = segment.score -
  overall.score`, must-pass) and E4 (`biggest_gap` math), `survey-refiner` E4
  (`after_score > before_score`, trivial numeric comparison), `metric-parity` E5 (six named
  fields present in `parity_ledger`).
- **Already working correctly, as a useful counter-example.** `executive-briefing` E2
  ("trend_findings count is 3-3") *does* route to the deterministic path today, because
  `_eval_structural` already has a `count is (\d+)-(\d+)` regex and the phrasing happens to
  match it. This is good confirmation the mechanism works fine when authors phrase things
  the way the parser expects — the gap is coverage/phrasing-brittleness, not a fundamental
  limitation of doing this deterministically.
- **A deliberate, not accidental, non-adoption worth respecting.** Conditional-presence
  criteria (e.g. `crystal-support` E5 — "`escalation_package` present iff `resolved=false`")
  are excluded from `STRUCTURAL_KEYWORDS` by a code comment that explains why: bare
  "present" was deliberately kept on the LLM-judge path because it's conditional logic, not
  a flat presence check. I want to be fair to the existing code here — not every miss in
  this inventory is an oversight; this one was a conscious tradeoff, and several of the
  criteria above (`xo-fusion-advisor` E4: "`case_proposal` present iff `urgency_level` in
  {critical, high}") have the identical conditional shape and would need the same
  eyes-open decision, not a blind sweep.

**A more urgent, independent bug this sweep surfaced**: three skills'
`EVALS.md` — `gap-analyst`, `platform-gap-tracker`, `xm-market-researcher` — use prose/bullet
formats ("`## E1: ...`" headers or "`### Accuracy`" bullet sections) with **zero markdown
pipe-table rows**. I confirmed by direct grep
(`grep -c "^|.*E[0-9]" skills/{gap-analyst,platform-gap-tracker,xm-market-researcher}/EVALS.md`
→ 0 for all three) that `_parse_evals_md` — which only extracts lines starting with `|` —
returns an empty criteria list for all three, which means `_check_evals` silently falls
through to `_baseline_output_check` (any non-empty output with one substantive field scores
0.70 and passes). `platform-gap-tracker`'s own EVALS.md contains a hand-written, clearly
serious safety rule — "Marking GAP-001/002/003 [SOC2/HIPAA/FedRAMP] as CLOSED for any reason
→ fail (requires human + external audit)" — that is **never actually checked by any code
path today**. This is not a code-interpreter question at all; it's a pure parsing-robustness
bug (support prose-format EVALS.md, or at minimum log a loud warning distinguishable from
"no EVALS.md file exists" when a file exists but yields zero parseable criteria — today both
cases log the same `skill_empty_evals`/`evals_parse_error` path indistinguishably from "this
skill genuinely has no evals"). I'm flagging it here because it directly informs the
priority ordering below: fixing this is cheaper and more urgent than anything in the
code-interpreter discussion, and it should happen regardless of whatever this assessment
concludes about sandboxes.

### Where CrystalOS should sit on the isolation spectrum

**At the cheapest end: no general code execution, a fixed pre-registered library of
deterministic validator functions, invoked from inside `_check_evals`.** The inventory above
is the direct evidence for this: every single candidate I found — across all 46 skills — is
expressible as one of five or six *known, finite, nameable* check shapes (array-length-and-
keys, enum membership, numeric range, set-membership-against-input, threshold-to-label,
arithmetic recompute). Nothing in the current skill corpus asks for the thing a real
sandbox exists to provide — a skill authoring and running *novel* code at request time that
nobody pre-wrote or reviewed. QAH's `execute` tool and QAS's `compile_logic.py`/
`ie_validator.py` earn their sandbox because their skills are allowed to call arbitrary
pre-uploaded scripts with real I/O (reading/writing survey JSON, running a 936-line
boolean-logic compiler) inside a genuine code-interpreter VM. CrystalOS's actual backlog,
by contrast, is entirely "run this specific, already-known check" — a subprocess sandbox,
resource caps, or a containerized execution environment would all be solving for a
capability nothing in the current 46-skill corpus demonstrably needs yet. Building one now
would be infrastructure in search of a requirement.

**How a skill would "call" this, concretely — two tiers, not one:**

1. **Tier 1 (do this first, ~30 minutes of work, fixes the majority of the inventory
   above):** broaden `_eval_structural`'s existing keyword/regex dispatch. Add "entries
   with", "is one of", and a couple more phrasing patterns to `STRUCTURAL_KEYWORDS`/its
   regexes. This alone converts the 13-skill Pattern-A cluster and the 3-skill enum cluster
   from LLM-judged to deterministic with **zero new architecture, zero new skill-authoring
   convention, and zero new call sites** — it's a bigger regex table, nothing else.
2. **Tier 2 (a small, separate concern — this is the actual "code interpreter" question):**
   for checks that need the *input*, not just the output (set-membership against a
   registry, arithmetic recompute against input values) — a small **named-function
   registry** (`skill_name -> checker_fn(input_data, output) -> (score, issues)`), looked up
   by skill name from inside `_check_evals` before the LLM-judge path runs for that skill's
   criteria. This is not a `TOOL_REGISTRY` entry — CrystalOS has no native tool-calling
   (OpenRouter JSON-mode only), so there's no live "the model calls a tool mid-reasoning and
   sees the result" moment analogous to QAH's `execute` tool; `SkillRuntime.execute()` is a
   single call → check → retry-once shape, not a ReAct loop. The right integration point is
   squarely a **pre-check stage inside `_check_evals`**, run before the LLM judge, not a
   tool result fed back into live model context.
   - **A concrete, currently-real gap this tier would need to fix first**: `_eval_criterion`
     already receives `input_data` as a parameter, but the structural branch only calls
     `self._eval_structural(description, output)` — `input_data` is silently discarded
     before reaching it (`lib/skill_runtime.py:459` vs. the method signature at line 495).
     Any set-membership-against-input check is impossible today without first threading
     `input_data` through this one call. That's a small, mechanical fix, but it's real and
     currently blocking, and worth calling out precisely rather than hand-waving "just check
     against the input."

**Where results surface**: both existing mechanisms, unchanged, no new one needed. (a) A
deterministic pre-check failing a must-pass criterion should short-circuit straight into
the existing `_check_evals` → `must_pass_failed` → the existing retry-with-failure-context
path (`retry_ctx["failed_criteria"]`) — the model already has a mechanism to react to a
specific, named failure; a deterministic check just makes the failure signal cheaper and
more reliable to produce. (b) It should **not** become a new tool result inside a live
conversational turn — there's no turn for it to feed back into; the retry-once call already
*is* CrystalOS's "let the model see the problem and fix it" mechanism, and doubling that
with a mid-loop tool call doesn't fit the architecture QAH built has (a ReAct/DeepAgent loop
CrystalOS's OpenRouter JSON-mode client doesn't have).

**Security boundary**: mostly moot by construction, once the "fixed, pre-registered,
in-process pure functions, no arbitrary code" line is held. These functions run at the same
trust level as the rest of `skill_runtime.py` — no secrets/model access to withhold because
they never had any to begin with, no resource caps needed because they're `O(n)` over an
already-parsed JSON dict, no network egress to block because a code-review convention
("these functions must be pure — no DB writes, no HTTP calls, no imports beyond stdlib/
already-vetted internal modules") can enforce that at merge time rather than runtime. If
CrystalOS ever has a genuine, evidenced need for skill-authored *novel* code at request time
— nothing in the current corpus asks for this — QAH's full security question set (no
secrets/model access inside the sandbox, resource/time caps, no network egress) becomes
live and should be revisited then, not pre-built now.

**Concrete pilot candidates, in priority order:**

1. **The Pattern-A checker, piloted once, reused across all 13 skills.** One function
   (`_check_array_entries(output, field, lo, hi, required_keys)`), wired into `_eval_
   structural` via a broadened regex — the single highest-leverage fix in this entire
   assessment by skill-count affected, and it needs Tier 1 only (no `input_data`, no new
   registry).
2. **`workflow-analyst`'s E2 (registry-membership).** Highest stakes in the corpus by the
   skill's own authors' admission (real automations get created off this proposal), fully
   mechanical (`trigger_type in {t["type"] for t in registry["triggers"]}`, same for fields/
   actions), and the concrete forcing function for the `input_data`-plumbing fix under Tier
   2. A good first (and possibly only, for a while) Tier-2 registry entry.

### The measurement plan for justifying further investment

What's already established by the inventory above, without any further experiment: **N=13
skills** share one deterministic-check family, **N=20+ of 46 (~43%)** have at least one
plausibly-deterministic currently-LLM-judged criterion across all families. That already
clears whatever bar "3+ concrete things needing it" was meant to set — it justifies Tier 1
(broaden `_eval_structural`) outright, on inspection, no experiment required, because the
correctness of "is this array length in the stated range" isn't a question needing
empirical validation the way a fuzzy quality judgment is.

What genuinely does need measurement, and should gate anything past Tier 1/2 (i.e., should
gate ever building a general sandbox): **the LLM judge's actual disagreement rate against
the deterministic answer on real or synthetic cases**, run once per criterion-*family*
(2-3 families, not 20+ individual skills — the shapes cluster tightly) — same design as the
Round 1 `csat-action-advisor` E4 experiment: ~30-50 labeled cases per family, agreement rate
+ Cohen's kappa (not just marginal pass-rate comparison, for the same reason Round 1 flagged
— two graders can share a pass rate while disagreeing on which items pass), plus the free
latency/cost delta (one fewer LLM round-trip per must-pass criterion, and no more
API-failure exposure on a safety gate). Do this for the Pattern-A family and the
`workflow-analyst`-style registry-membership family specifically, since those are the two
highest-stakes/highest-skill-count clusters.

**The bar for ever going past Tier 2 into a real sandbox/general code-interpreter**: a
demonstrated check that cannot be expressed as (a) a small addition to `_eval_structural`'s
existing dispatch shape, or (b) a hand-written, code-reviewed, named function in a small
registry — i.e., a skill needing to compose or generate *novel* validation/compilation logic
at request time that nobody anticipated and pre-registered (the QAS `compile_logic.py`
scenario: a user-facing NL→IR→compile step where the "IR" schema itself is rich enough that
hand-enumerating every check up front isn't tractable). **Nothing in the current 46-skill
corpus asks for that.** `segment-analyst`'s arithmetic recompute and `schema-mapper`'s
set-membership checks are the closest things to "this wants real computation," and both are
still small, fully-specified, single-purpose functions — exactly QAS's own
`survey_pipeline.py`-style deterministic pass, not an interpreter. My answer to the
brief's framing question is unambiguous: **2-3 (really, 1 broadened regex dispatcher + 1-2
bespoke functions) covers the entire currently-evidenced backlog at a small fraction of the
cost of any sandbox investment; a general code-interpreter capability would be building
infrastructure for a requirement CrystalOS doesn't have yet, not one it does.**

## 3. Revisions to Round 1

- The Round 1 finding on `csat-action-advisor`'s E4 ("quantified impact estimate") was
  correct but under-scoped — I'd said it recurred in "at least 3 skills." The full sweep
  puts it (and its sibling E2 "N-M entries with fields" criterion, which is must-pass and a
  better pilot target since E4 is only `>=0.75`) at **13 skills**, and surfaces a
  higher-stakes, more concrete pilot candidate I hadn't found yet in Round 1
  (`workflow-analyst`'s registry-membership check, explicitly flagged by its own authors as
  the highest-stakes criterion in the corpus).
- New finding, independent of code-interpreter/sandbox questions but surfaced by the same
  full sweep: **three skills' `EVALS.md` files are silently never parsed at all**
  (`gap-analyst`, `platform-gap-tracker`, `xm-market-researcher` — prose/bullet format, zero
  pipe-table rows, confirmed by direct grep). This is a live, currently-shipping gap more
  urgent than anything in this round's design discussion, and independent of whether
  CrystalOS ever builds anything code-interpreter-shaped.
- Reframing #1 sharpens rather than reverses the Round 1 "no rearchitecture" recommendation:
  I'd now state the exception explicitly — one narrow, ordered "pre-eval deterministic
  checkers" insertion point inside `_check_evals` is concretely motivated (13+ consumers
  today), and is a fundamentally smaller and more evidence-backed ask than the
  middleware/hook-point framework Round 1 (and Priya, more directly) correctly declined to
  recommend.
