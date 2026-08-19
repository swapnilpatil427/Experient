# Team: CrystalOS Harness-Rearchitecture Assessment

## Mission
Assess whether CrystalOS should adopt "harness engineering" architectural patterns
(researched at `docs/harness-engineering/external-repo-research/`) while preserving 100% of its
existing functionality — and find concrete simplification/improvement opportunities along
the way. This is a research/assessment mission: the deliverable is findings reports, not
code changes.

## Members

### AI/ML Research Scientist — Dr. Reyes
**Owns:** `findings-reyes.md` — an empirical/rigor lens: which harness patterns are backed
by real evidence (cited benchmarks/results in the research docs) vs. plausible-sounding but
unvalidated, whether adopting them would measurably improve CrystalOS's skill quality/eval
scores, and how to design an experiment to prove it before committing to a rearchitecture.
**Layer:** cross-layer (methodology)
**Skills:** LLM evaluation design, statistics, agent benchmarking, prompt/skill quality
measurement

### AI Agent / Harness Engineer — Priya
**Owns:** `findings-priya.md` — the implementation-feasibility lens: what a concrete
migration path looks like (incremental middleware/hook points inside `SkillRuntime`/
`crystal.py` vs. a bigger rewrite), effort/risk sizing per pattern, and a phased rollout
plan if any pattern is worth adopting.
**Layer:** crystalos
**Skills:** Python, LangGraph, agent-loop design, middleware/hook architectures, skill
runtimes

### CrystalOS Architecture Expert — Marcus
**Owns:** `findings-marcus.md` — the deep-codebase lens: the authoritative map of every
existing CrystalOS capability that must be preserved (per BRIEF.md's "what must keep
working" list, verified against actual source), exactly where a harness-style refactor
would touch each one, and the landmines/regression risks specific to CrystalOS's current
implementation (`agents/crystal.py`, `lib/skill_runtime.py`, `lib/skill_registry.py`,
`lib/turn_publisher.py`, `crystal/context.py`, `crystal/registry.py`+`tools.py`,
`graphs/insights.py`, `graphs/custom_analysis.py`).
**Layer:** crystalos
**Skills:** CrystalOS internals, LangGraph pipelines, skill runtime/EVALS system, insight
pipeline lineage/checkpointing

### Xperiq Backend Expert — Dana
**Owns:** `findings-dana.md` — the Express/Node integration lens: how `agentsClient.js`,
the action-proposal execution endpoints, and any `X-Internal-Key`-gated contracts between
the backend and CrystalOS would be affected by internal CrystalOS rearchitecture (they
shouldn't be, if the external contract is preserved — confirm this explicitly and flag any
place it's actually load-bearing on CrystalOS's internals).
**Layer:** backend
**Skills:** Express/TypeScript, REST contracts, Postgres, service-to-service auth

### Xperiq Frontend Expert — Jordan
**Owns:** `findings-jordan.md` — the React/UI lens: how `CrystalPanel.tsx`'s SSE
consumption, action-proposal card rendering, and any streaming-event shape assumptions
would be affected; whether any harness pattern (e.g. a per-turn "applied filters" audit
object, or a `tool_running`/`thinking` progress-callback pattern) would newly need UI to
be useful, vs. being purely a backend-internal improvement invisible to the frontend.
**Layer:** frontend
**Skills:** React 19, TypeScript, SSE/streaming UI, DataBus invalidation

## Coordination
All five members read `BRIEF.md` and `docs/harness-engineering/external-repo-research/
00-SYNTHESIS.md` first. They work concurrently — no sequencing dependency between them.
After all five findings docs land, the orchestrating session synthesizes them into
`RECOMMENDATION.md` in this same folder.
