# Round 2 Brief: Reframed Question + Code-Interpreter/Sandbox Investigation

> Addendum to `BRIEF.md`/`RECOMMENDATION.md`. Same team, same constraints (research only,
> no code changes, no Qualtrics-specific references, no new library dependencies —
> `qualtrics-agent-harness`/`qualtrics-agent-skills`/deepagents/LangChain-as-a-new-dep are
> explicitly NOT being imported; we're learning architecture *shape*, not adopting the
> packages).

## Reframing #1: the extensibility question, asked more sharply

Round 1 asked "should CrystalOS adopt harness patterns to fix current pain points" and the
team converged on "adopt isolated patterns, no rearchitecture." That conclusion still
stands for *today's* pain points. Round 2 asks a related but distinct question:

**Could CrystalOS be structured as a genuine harness architecture — built entirely
in-house, zero new library dependencies — specifically so that adding new capabilities
(new skill types, new post-processing steps, new cross-cutting concerns like PII redaction
or a code-execution step) gets *easier* as the product grows, not just cleaner today?**

This is a forward-looking/extensibility question, not a "fix what's ad hoc now" question.
Re-review your Round 1 recommendation with this reframing specifically in mind:
- Does "no rearchitecture" still hold if the goal is "friction-free to extend in 12
  months," rather than "fix today's duplication/gaps"?
- Is there a middle ground your Round 1 answer didn't consider — not a full
  middleware/hook framework (which Priya correctly noted has nothing to attach to given
  CrystalOS's OpenRouter JSON-protocol constraint), but a smaller, purpose-built extension
  mechanism (e.g., a named, ordered list of "post-skill-execution processors" that new
  capabilities register into, without any external framework)?
- Or does your Round 1 reasoning (deliberately-reasoned existing code, no framework to hang
  hooks on, thin evidence for the borrowed benchmark numbers) apply just as strongly to the
  forward-looking framing as it did to the retrospective one? Say so plainly if that's your
  answer — this reframing is a genuine re-ask, not a request to find a different answer.

## Reframing #2: a real new investigation — code interpreter + skill runtime structures

None of the Round 1 findings docs designed this in depth (it was mentioned only in passing
as "CrystalOS has no code-execution sandbox at all," a gap relative to
`qualtrics-agent-harness`'s AgentCore sandbox stack). Round 2 asks for a genuine deep dive:

**Should CrystalOS's skill runtime gain a code-interpreter-style capability — a sandboxed,
deterministic code-execution primitive skills can invoke — and if so, how would it be
architected, generically, with zero new heavy infra/vendor dependency assumed?**

This directly serves the highest-confidence finding from Round 1
(`00-SYNTHESIS.md` §3.1: push provably-correct logic out of the LLM into deterministic code
— independently reinvented by `qualtrics-agent-harness`'s driver-analysis tool,
`qualtrics-agent-skills`' `compile_logic.py`/`ie_validator.py`, and CrystalOS's own
`_build_viz_for_citations`) and the validator-paired-eval-gate pilot Round 1 already
recommended (Tier 2 #8, piloted on `compliance-scanner`). Today those deterministic checks
have to be hand-written Python functions wired directly into `SkillRuntime`'s eval loop.
A code-interpreter primitive would let a *skill itself* (via its own SKILL.md instructions)
author and run a small validation/compilation script on demand, the way
`qualtrics-agent-skills`' skills do via their `execute` tool — without CrystalOS needing to
pre-build a bespoke Python function for every future deterministic sub-check.

Design questions to work through, generically (no AWS Bedrock/AgentCore, no vendor-specific
sandbox service — think about what CrystalOS could build itself or with an
already-available primitive):
- What's the actual isolation mechanism? Options span a wide range of cost/security
  tradeoffs: a subprocess with resource/time limits and no network, a restricted Python
  execution mode, a real containerized sandbox, or (cheapest, narrowest) no general code
  execution at all — just a fixed, pre-registered library of deterministic
  validator/compiler *functions* skills can request by name (no arbitrary code, ever).
  Have an opinion on where CrystalOS should sit on this spectrum and why.
- How would a skill "call" this from CrystalOS's current architecture? CrystalOS has no
  native tool-calling (OpenRouter JSON-mode only, per `lib/models.py`) — so this isn't a
  deepagents-style `execute` tool the model calls mid-loop; it likely has to be a new entry
  in `TOOL_REGISTRY`/`crystal/tools.py` (structured JSON tool call, same as every other
  CrystalOS tool today) or a new post-processing stage inside `SkillRuntime.execute()`
  itself. Which shape fits better, and why?
  - Where would results surface — as a tool result feeding back into a skill's context
    (model can react to a validation failure), as part of the `_check_evals` retry loop
    (deterministic pre-check gates the LLM eval), or both?
- Security boundary: same questions QAH had to answer (no secrets/model access from inside
  the sandbox, resource caps, no network egress) — apply them to whatever mechanism you
  pick.
- Concrete pilot candidate(s): which 1-2 real CrystalOS skills would benefit first, and
  what would the sandboxed script actually check for each?

## Deliverable

Reply via SendMessage to this same thread (you're being resumed, not re-spawned — you have
full Round 1 context already). Structure your reply as:
1. Revised recommendation on Reframing #1 (extensibility) — same, or different, and why.
2. Full design answer to Reframing #2 (code interpreter / skill-runtime structures) from
   your role's specific angle (see your individual message for which angle).
3. Anything from Round 1 you'd revise given this new thinking.

If asked to persist a written findings update, write to
`docs/harness-engineering/rearchitecture-assessment/findings-<you>-round2.md` — if the
Write tool blocks it (as happened in Round 1), return the full content in your reply instead
and it will be persisted by the orchestrator.
