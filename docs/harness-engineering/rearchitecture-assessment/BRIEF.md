# Assessment Brief: CrystalOS → Harness-Style Architecture

## Mission

CrystalOS is Xperiq's Python agent service. We've just completed a deep research pass on
four external "harness engineering" repos (a curated knowledge base plus a real internal
three-repo agent stack: a skills-content package, a LangGraph/deepagents factory harness,
and a thin deployment shell). That research lives at
`docs/harness-engineering/external-repo-research/` (`00-SYNTHESIS.md` + `01`–`04` deep-dives) —
**read `00-SYNTHESIS.md` first**, it's the entry point and links to the rest.

This is a **research and assessment task, not an implementation task**. Nobody on this
team writes or modifies CrystalOS code. The deliverable is a written findings report.

## The question

**Should CrystalOS be rearchitected toward a "harness" shape — an explicit middleware/hook
pipeline (fail-fast validation → tool dispatch → post-processing, named extension points
like `before_agent`/`wrap_tool_call`/`after_agent`), provenance stamping, a formalized
tool-error contract, deterministic guardrail scripts, etc. — while preserving every piece
of CrystalOS's existing functionality and product behavior?**

Sub-questions each team member should weigh in on from their vantage point:
1. Where does CrystalOS's current design already have harness-like structure, and where is
   it genuinely ad hoc / hand-rolled in a way a harness pattern would clean up?
2. What's the concrete migration path (if any) — big-bang rewrite, incremental adoption
   inside the existing `SkillRuntime`/`crystal.py`, or "don't rearchitect, just adopt named
   patterns"?
3. What's the simplification opportunity — is there code/complexity that would shrink, not
   just move, if we adopted these patterns?
4. What's the risk to existing functionality, and what's the concrete regression-test plan
   to prove nothing breaks?

## Constraint: what to take from `qualtrics-agent-skills`, and what to leave behind

`qualtrics-agent-skills` (deep-dive `04` in the research folder) is a Qualtrics-internal
skills package. **We want the generic skill-authoring and harness patterns it demonstrates
— never anything Qualtrics-specific.**

**Take (patterns, generalized, no Qualtrics naming/business logic):**
- The deterministic-guardrail-script pattern: push any step with a provably-correct answer
  (id assignment, boolean-logic compilation, threshold→label mapping) out of the LLM into a
  small, testable function the skill's own flow invokes/validates against.
- The validator-in-the-loop pattern (`ie_validator.py`): draft → deterministic validator →
  structured issue list → targeted repair turn → re-validate.
- Progressive disclosure within a skill (phase-specific `references/`-style docs loaded on
  demand, not all up front).
- The offline eval-case + pluggable-grader harness idea (YAML cases, LLM-judge +
  deterministic graders, trace caching) — as a *design* to consider, not the code.
- Schema-generation-on-demand from Pydantic models instead of hand-maintained schema docs.
- Explicit routing description conventions (dense trigger-phrase descriptions, negative/
  counter-examples) for whatever routing mechanism CrystalOS uses.

**Leave behind — do not reference, port, or let leak into the assessment's
recommendations:**
- Any Qualtrics product/business domain: Herodotus, DFS, LXH, MIG, AgentCore, Bedrock,
  brand_id/JWT specifics, the `unified_qa_assist`/`project_assist`/etc. app names, survey
  QSF-format specifics.
- The three-package (skills/harness/serving) split as an organizational requirement —
  CrystalOS is one repo, one deploy; that's staying (see `00-SYNTHESIS.md` §4, "What NOT to
  copy").
- deepagents/LangGraph's `SkillsMiddleware` as a literal dependency to adopt — CrystalOS
  has its own semantic router (`skill_registry.find`) already; the *idea* of progressive
  disclosure is portable, the specific library is not a recommendation here.

## What must keep working (read `crystalos/CLAUDE.md` in full for the authoritative version)

Any recommendation must explicitly state how it preserves each of these — CrystalOS
already has ~1400 passing tests covering this behavior, and none of it is negotiable:

- Skill-first Crystal streaming with its fallback chain (`_run_skill_stream` → skill
  synthesis → `_run_crystal` single-shot → legacy `?legacy=true` ReAct loop for admin debug)
- `SkillRuntime`'s EVALS.md hybrid (structural + LLM-judge) quality gate, retry-once-with-
  failure-context, baseline gate for skills with no EVALS.md, and the example-bank write-back
- The action-proposal boundary: "Crystal proposes, Copilot/endpoints execute" —
  `_normalize_proposal`, `_PROPOSAL_TYPE_ALIASES`, the two emitters (skill path + tool path)
- `BrandContext`/`ROLE_PERMISSIONS`/`_resolve_permissions` tool-gating
- The semantic skill router (`skill_registry.find`, embedding similarity + `top_k`,
  `warm_router()` at startup, difflib `find_sync()` fallback)
- `turn_publisher`'s `TurnEvent` telemetry + quality-signal detection + capability-gap logging
- The Insight Pipeline (`graphs/insights.py`, 17-node LangGraph, run profiles, checkpoint
  chain/lineage, credit preflight) and the isolated Custom Analysis graph (with its hard
  invariants — never writes `insights`, no predictive layer, capped `trust_score`)
- Thread continuity (`crystal_threads`, 7-day TTL, 100-message cap), rate limiting
- Tag Report tools, retention/compaction job, Progressive Tier System

## Deliverable format

Each team member writes their findings to
`docs/harness-engineering/rearchitecture-assessment/findings-<your-handle>.md`,
structured as:

1. **Vantage-point summary** — what you looked at, from your role's perspective.
2. **Simplification opportunities** — concrete, named (file/function level where possible).
3. **Improvement opportunities** — concrete, named, tied back to a specific pattern from
   the Crystal-harness research docs (cite which doc/section).
4. **Risks / what could break** — specific to your layer.
5. **Your recommendation** — rearchitect fully / adopt incrementally / adopt selected
   patterns only / no change — with a one-paragraph justification.
6. **Open questions for the rest of the team.**

Read `docs/harness-engineering/external-repo-research/00-SYNTHESIS.md` and the specific deep-dive
docs it cites before forming an opinion — don't re-derive the harness research from
scratch, build on it.
