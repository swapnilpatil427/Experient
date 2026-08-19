# Crystal Harness Research — Synthesis

> Reads across all four deep-dives in this folder and distills one cross-referenced,
> ranked adoption plan for CrystalOS (`/Users/spatil/Documents/Projects/Experient/crystalos`).
> Source docs: `01-awesome-harness-engineering.md`, `02-cme-langgraph-service.md`,
> `03-qualtrics-agent-harness.md`, `04-qualtrics-agent-skills.md`. Read those for full
> detail, quoted code, and file-level citations — this document is the "so what."

---

## 1. What these four repos actually are, and how they fit together

Three of the four repos are one production stack (an internal Qualtrics agent platform);
the fourth is a curated knowledge base that the other three independently reinvent parts of.

```
awesome-harness-engineering        ─── knowledge base (no code) — the "why", cited throughout
        │  (independently validates many of the patterns below)
        ▼
qualtrics-agent-skills  (QAS)  ──content──▶  qualtrics-agent-harness (QAH)  ──factory──▶  cme-langgraph-service (CLS)
   "what the agent knows"           "how the agent runs"                      "where it's served"
   AGENTS.md + deepagents.toml      build_harness_graph() factory:            thin async-context-manager
   + skills/<name>/SKILL.md         deepagents/LangGraph DeepAgent +          wrappers registering 8 graphs
   (markdown, no code)              5 middlewares (identity, tool-errors,     with the LangGraph Platform
                                     input-context, applied-filters,         base image (SLGP); owns auth,
                                     sandbox) + native tools (Herodotus/      tracing, codegen/drift-gating,
                                     DFS/LXH/driver-analysis) + MIG model     deploy pipeline
                                     client + code-interpreter sandbox
   independently versioned          independently versioned                  imports both as pinned wheels
   Artifactory wheel                Artifactory wheel
```

**The single most important structural fact**: this org splits an agent product into
**three independently-versioned packages glued together only by pinned dependency
versions and a codegen step**. CrystalOS, by contrast, is **one repo, one deploy, one
version** — skills, runtime, and serving all live and ship together. That's not a gap to
fix; it's a different point on a real tradeoff curve (see §4). Everything below should be
read through that lens: most of what's genuinely portable is *engineering discipline*
(import-safety, fail-fast validation, error contracts, provenance stamping), not the
three-repo split itself.

**Second structural fact**: none of the three production repos has anything resembling
CrystalOS's `EVALS.md` synchronous quality gate or example-bank feedback loop. QAS has an
*offline*, repo-external eval harness (YAML cases + LLM/deterministic graders) for exactly
one of six apps; QAH has zero eval/quality code; CLS has zero eval code. **CrystalOS's
in-request eval-gate-with-retry-and-example-bank is more sophisticated than anything in
this stack** — this is flagged independently in docs 03 and 04's comparison tables. Don't
let "these are big companies' internal repos" imply they're ahead on every axis.

---

## 2. Cross-cutting themes (patterns validated by 2+ independent sources)

These recur across multiple repos/sources independently, which is a stronger signal than
any single doc's opinion:

1. **Import-safety discipline: no model/secret/network access at module import time.**
   Stated explicitly as a load-bearing invariant in QAH (`build_harness_graph` docstring +
   a dedicated test), practiced in CLS (Galileo-before-LangChain, tiktoken lazy shim), and
   generalized in awesome-harness-engineering's "harness co-evolution" framing. One
   platform failure mode (eager graph collection at startup — CLS's CLAUDE.md notes that
   since `langgraph-api` 0.9.0 one bad graph construction hard-fails the *entire pod*) makes
   this concrete, not theoretical.

2. **Tool errors are strings/structured results, never raised exceptions.** QAH's
   `Error: ...`-prefixed string convention + `assert_ok()` test helper; CLS's tools return
   `{"success": False, "error": ...}` dicts; awesome-harness-engineering's tool-design
   section (Anthropic's "Writing Effective Tools") makes the same point as a named
   principle. CrystalOS already does this (`dispatch_tool` returns `{"error": ...}` dicts)
   but doesn't have it as a named, tested convention.

3. **Fail-fast identity/context validation, run first, before any tool or sandbox work.**
   QAH's `RequestValidationMiddleware` (explicit "first in the middleware list" contract,
   pinned by a test); CLS's JWT-bound-to-`(method,urlHash)` auth; awesome-harness-
   engineering's permissions section ("structured authorization > prompt-level trust").
   CrystalOS resolves `org_id`/`user_id`/`survey_id` ad hoc, deep in handlers — no single
   early gate.

4. **Provenance/version stamping on every trace and log line.** CLS's `_provenance.py`
   (`importlib.metadata.version()` → `harness_version`/`skills_version` on every trace);
   QAH's `version.py` (deliberately delegates the *stamping* to the host but still exposes
   `get_graph_version()`); awesome-harness-engineering's Harness-Bench finding that
   "capability should be reported at the model-harness-configuration level, not the model
   alone." CrystalOS logs `skill_version` from skill metadata but not the CrystalOS
   package's own version.

5. **Deterministic post-processing/compute must never be re-derived by the LLM each
   call.** QAH's `trend_insights_analysis` (pandas/sklearn regression, "raw records never
   hit model context"); QAS's `compile_logic.py`/`survey_pipeline.py`/`ie_validator.py`
   (NL→IR→deterministic-compile, validator-script-in-the-loop); CrystalOS's own
   `_build_viz_for_citations` ("Tier-0 deterministic chart selection... never model-
   chosen") independently arrived at the same idea. Awesome-harness-engineering's AIP
   entry (typed skill-graphs, 53%→67% pass-rate jump) is the generalized version of this.
   **This is the strongest, most independently-corroborated pattern in the whole research
   pass** — see §3.1.

6. **Skills are versioned, curated artifacts with negative/counter-examples improving
   routing — but skill *authoring* conventions are prose-enforced almost everywhere, not
   code-enforced.** Only CrystalOS's `action_proposals`/propose-confirm-execute boundary
   and duplicate-skill-name detection are structurally enforced; QAS's "propose → approve"
   and "retrieval/analysis/formatting separation" rules are pure prose conventions with "no
   code-level enforcement" (doc 04 flags this as QAS's known weakness, and flags CrystalOS
   as already ahead here — don't regress this).

7. **Fail-open on observability, fail-loud on auth/validation**, as an explicit written
   rule rather than an implicit convention. Present in CLS's CLAUDE.md, implicit in QAH's
   middleware design, generalized in awesome-harness-engineering's HITL/permissions
   sections. CrystalOS's `_fire_telemetry` already does this in practice but doesn't state
   it as policy.

8. **Progressive disclosure at multiple levels — keep the system prompt tiny, load detail
   only on demand.** deepagents' `SkillsMiddleware` (name+description only, full body read
   on demand) mirrored in QAS's `references/`/`meta/` sub-loading; CrystalOS's
   `skill_registry.find` + lazy SKILL.md body loading is the same idea, independently
   built. Awesome-harness-engineering's `Pi` demo harness (sub-1,000-token system prompt)
   is a useful lower-bound benchmark to check CrystalOS against.

---

## 3. Ranked adoption plan for CrystalOS

Merged, deduped, and re-ranked across all four docs' individual recommendation lists.
Tier 1 = do soon, cheap, high confidence. Tier 2 = valuable, needs a design decision first.
Tier 3 = interesting, defer until a concrete trigger condition is hit.

### Tier 1 — cheap, concrete, do directly

1. **A `RequestValidationMiddleware`-equivalent: one early, fail-fast gate for
   `org_id`/`user_id`/`survey_id`/permission resolution**, run before skill routing or any
   tool call, replacing today's ad hoc deep-in-handler resolution. Source: QAH §3.7 (`03`),
   cross-validated by CLS's auth model and awesome-harness-engineering's permissions
   section. *Effort: small — mostly relocating existing resolution logic to one call site
   plus a test pinning "runs first."*

2. **Provenance stamping**: add CrystalOS's own package version (via
   `importlib.metadata.version`) to every turn-event/trace, alongside the already-logged
   `skill_version`. Source: CLS `_provenance.py` (`02`), reinforced by awesome-harness-
   engineering's Harness-Bench finding. *Effort: trivial.*

3. **Formalize the tool-error contract**: codify "every tool result is `{"error": str}` on
   failure, never raised" as a named, tested convention (a shared `assert_ok()`-style test
   helper used everywhere), rather than the current ad hoc pattern. Source: QAH §3.5 (`03`)
   + CLS + awesome-harness-engineering tool-design section. *Effort: small.*

4. **Route verbose tool/test output to logs, keep agent/dev-loop-visible context to
   summary lines.** Source: awesome-harness-engineering's 16-parallel-Claude experiment
   (`01`). *Effort: trivial, applies to CrystalOS's own dev workflows (pytest output) as
   much as to any agent-facing surface.*

5. **Add explicit negative/counter-examples to skill `EXAMPLES.md` files** — OpenAI's
   73%→85% routing-accuracy result. Audit whether existing EXAMPLES.md files include
   queries that should route *elsewhere*. Source: awesome-harness-engineering (`01`),
   reinforced by QAS's dense trigger-phrase-rich `description` fields being the entire
   routing signal in that stack. *Effort: content work, not code — one skill at a time.*

6. **Add a "when can this be removed" living table** to CrystalOS's harness docs — one row
   per legacy fallback / guardrail / shim, with `Component | Exists because | Can be
   removed when`. Source: awesome-harness-engineering's `HARNESS_CHECKLIST.md` closing
   section (`01`) — flagged there as the single most reusable idea in that repo. *Effort:
   trivial, pure documentation, but needs periodic review discipline to stay honest.*

### Tier 2 — valuable, needs a design decision

7. **An `applied_filters`-equivalent: a per-turn, machine-readable "what did we actually
   query" audit object**, normalized across CrystalOS's different data backends, emitted on
   `CrystalOutput` even when empty. Source: QAH's `AppliedFiltersMiddleware` (`03`) — a
   genuinely subtle, high-value UI-transparency pattern CrystalOS has no analog of today
   (its `tool_results` already carry the raw args needed; this is mostly a normalization
   function away). *Design decision needed: canonical filter-tree shape across CrystalOS's
   own data sources.*

8. **A validator-script-paired-with-eval-gate pattern for skills with a provably-correct
   sub-check** (e.g. survey-creator's id/logic integrity, a report's prevalence-label-
   matches-percentage rule) — write the draft, run a small deterministic Python validator,
   feed specific issues back for a repair turn, re-validate. Source: QAS's `ie_validator.py`
   (`04`), directly composable with CrystalOS's existing retry-with-failure-context loop in
   `skill_runtime.py`. *Design decision: which skills actually have a checkable-in-code
   quality bar (not all do).*

9. **An offline eval-case + pluggable-grader harness, orthogonal to `EVALS.md`'s
   synchronous in-request gate** — YAML test cases, a grader-dispatch table mixing LLM
   judges and deterministic checkers (routing/reliability/efficiency via a tool-trace
   analyzer, "was the right skill actually consulted" via a skill-read-detector), with
   trace caching so grading-logic iteration doesn't re-run the expensive live agent. Source:
   QAS's `evals/` framework (`04`) — this is the clearest capability gap CrystalOS has
   relative to this stack; it catches routing regressions and multi-turn issues a
   single-call `EVALS.md` structurally cannot see. *Effort: a real build, but high value —
   candidate for its own small project.*

10. **Named, explicit hook-point vocabulary for `SkillRuntime.execute()`**, modeled on
    deepagents/LangChain's `before_agent`/`wrap_model_call`/`wrap_tool_call`/`after_agent`
    or QAH's five single-purpose middlewares. CrystalOS's runtime already has an implicit
    pre/post shape (permission resolution → eval gate → retry → example-bank write) —
    naming these as first-class extension points would make future cross-cutting additions
    (PII redaction, the `applied_filters` idea above) land without threading new params
    through every call site. Source: `01` + `03`. *Design decision: how much to refactor
    the existing runtime vs. layer hooks on top.*

11. **Structured, addressable fact/memory storage over prompt-accumulated context**, if
    Crystal's memory needs ever grow past the current 7-day thread TTL — store as explicit
    Postgres rows with an invalidation/decay policy, not accumulated prose. Source:
    awesome-harness-engineering's "Facts as First Class Objects" + MemArchitect's "zombie
    memory" critique (`01`). *Trigger condition: only relevant if/when long-term
    cross-session memory becomes a real requirement — not urgent today.*

### Tier 3 — interesting, defer until triggered

12. **AIP-style typed sub-graphs for skills with a fixed deterministic sequence** (e.g.
    "score → classify → recommend" expressed as a mini-flow instead of re-derived prose
    every call). Source: `01`. *Pilot on exactly one skill first if pursued — bigger
    structural change than anything in Tier 1/2.*

13. **A `SerializingMigLLM`-style compatibility-shim mixin pattern**, if CrystalOS ever
    needs to isolate a provider-specific wire-protocol quirk (parallel-tool-call
    serialization, content-shape normalization) into one small, independently-tested
    transform rather than scattering `if provider == X` branches. Source: `03`. *Trigger
    condition: only needed if/when a new model provider surfaces a protocol mismatch.*

14. **Adversarial red-teaming as a separate, non-CI-gating, worst-case-scored process**
    (a `BEHAVIOR.md` format: frontmatter scenario count + tactic list + prose failure-mode
    description, judged by an external auditor LLM, aggregated worst-case not average).
    Source: QAS's `evals/red_team/` (`04`) — directly relevant to CrystalOS's own
    tenant-isolation (`BrandContext`) and prompt-injection-via-survey-verbatims exposure.
    *Bigger lift: needs an auditor-LLM harness CrystalOS doesn't have yet.*

15. **CI drift-gating for any future generated/templated code** (skill scaffolding, tool-
    registry entries, `TEAM.md` boilerplate) — CLS's `--write`/`--check` dual-mode script +
    "never hand-edit, marker-gated prune" discipline. Source: `02`. *Trigger condition:
    only relevant once CrystalOS actually generates code from a template somewhere — it
    doesn't today.*

16. **Explicit separate-package boundary for skills/runtime**, if CrystalOS's skill runtime
    is ever reused by a second product/service outside Xperiq's backend. Source: `02`, `03`.
    *Explicitly NOT recommended now — would trade away CrystalOS's current single-repo,
    single-deploy advantage for an independent-release-cadence benefit it doesn't need
    yet.*

---

## 3.1 The one idea worth calling out on its own

Pattern **#5** in §2 (deterministic post-processing over LLM re-derivation) is the
strongest single finding of this whole research pass because it was **independently
reinvented in four unrelated places**: QAH's driver-analysis tool, QAS's survey-logic
compiler, awesome-harness-engineering's AIP paper, and CrystalOS's own `_build_viz_for_
citations`. When four independent engineering teams (three of them without knowledge of
each other's work, all without knowledge of CrystalOS) converge on the same shape, that's
the highest-confidence signal in this entire research exercise. The actionable version for
CrystalOS: **whenever a skill's job includes a step with a provably-correct answer (id
assignment, boolean-logic compilation, threshold-to-label mapping, chart-type selection),
push that step into a small deterministic Python function the skill's output is validated
or post-processed through — never let the LLM redo arithmetic/logic it can get subtly
wrong differently every call.** Tier 2 item #8 (validator-paired-eval-gate) is the
concrete mechanism for wiring this into CrystalOS's existing skill-runtime retry loop.

---

## 4. What NOT to copy — deliberate non-adoptions

- **The three-repo (skills/harness/serving) package split.** Real benefit (independent
  release cadence, mechanically-enforced version bumps via CI) but real cost (a caller
  onboarding onto a new graph has to read stale docs or go find an upstream package not
  even in the checkout — doc `02` explicitly hit this limitation researching CLS itself).
  CrystalOS's single-repo model trades that release independence for velocity and
  discoverability it currently values more. Revisit only if a second product ever needs to
  consume CrystalOS's skill runtime.

- **QAH's total absence of a quality-eval loop.** Doc `03` calls this out explicitly:
  "NOT recommended to adopt wholesale... this is explicitly the one area where CrystalOS is
  already ahead and should keep investing, not regress toward the harness's leaner model."

- **QAS's prose-only enforcement of propose→approve and skill-boundary rules.** CrystalOS's
  structural enforcement (action-proposal architecture, code-level Crystal-read/Copilot-
  write split) is already stronger; doc `04` explicitly flags this as a place CrystalOS
  should not imitate the weaker prose-based pattern.

- **Building on LangGraph+deepagents wholesale in place of the hand-rolled ReAct loop.**
  Doc `03`'s comparison table is neutral on this, not a recommendation — CrystalOS's
  OpenRouter-based provider path has no native tool-calling (JSON-mode only), which is a
  real, different constraint deepagents doesn't have to solve for. Framework-level
  migration isn't one of the ranked recommendations above; it's out of scope as "adopt this
  pattern" and would be its own architecture decision if ever considered.

---

## 5. Open threads for follow-up research

- **The actual node/state graph internals for `cx_agent_qa_graph`/`ex_agent_qa_graph`
  and QAH's own DeepAgent construction are not in any of these four checkouts** — they live
  in separately-versioned upstream packages (`cx-agent-qa-graphs`, `ex-agent-qa-graphs`)
  not cloned here. If deeper LangGraph node/routing detail is ever needed, those specific
  repos would need to be pulled.
- **QAS's `evals/` framework (Tier 2 #9) exists for only one of six apps** — `project_assist`
  and `unified_aipc` (the two most code-heavy, highest-blast-radius skills) have zero eval
  coverage in that stack either. Don't treat "QAS has evals" as "QAS has evals everywhere."
- **Whether CrystalOS's example-bank has any staleness/invalidation policy** was flagged in
  doc `01` as unverified — worth a follow-up read of `skill_runtime.py` specifically if
  Tier 2 item #11 (structured memory) is ever pursued.
- Each source doc's own "Open Questions/Gaps" section has additional narrower items not
  repeated here — worth a re-read of `02`, `03`, `04` directly before acting on any single
  Tier 2/3 item.

---

*Read order for a newcomer to this research: this synthesis first, then `01` (fastest,
mostly-links context), then `03` (the densest/most novel one — the harness factory), then
`04` (the skill-authoring convention — the most directly comparable to CrystalOS's own
SKILL.md model), then `02` last (thinnest payload, mostly deployment/ops plumbing).*
