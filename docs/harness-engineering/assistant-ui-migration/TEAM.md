# Team: Crystal → assistant-ui Migration Assessment

# Team: Crystal → assistant-ui Migration

> **Document owner:** Swapnil Patil
> **Created:** 2026-08-04 · **Re-chartered:** 2026-08-04 (assessment → migration planning)
> **Status:** Active — migration pod, chartered to produce a complete executable plan
> **Charter:** `README.md` in this folder

---

## Mission

**The migration is decided.** Produce a complete, phased, flag-gated plan to move Crystal's chat UI onto `assistant-ui` — using assistant-ui's own UI components where possible, preserving Crystal's look and feel, and treating generative UI (agent-specified charts and rich content) as a first-class goal.

This pod is **not** authorized to write production code. Its deliverable is a plan precise enough that an engineer could execute it without re-deriving any decision.

### House rules

1. **The decision is not under review.** Do not re-argue whether to migrate. If you believe a specific *step* is wrong, propose a better step — not a smaller scope.
2. **Costs must stay honest.** Reporting a real cost is not opposition; it is the job. A plan that hides its cost fails. If a phase is expensive, say so and sequence it accordingly.
3. **Styled-first.** Attempt assistant-ui's own components. Fall back to headless primitives only where you have *measured* a blocker, and record the measurement.
4. **Preserve the loop.** The reasoning timeline, citation/provenance layer, and the propose → confirm → execute → record-outcome loop are the product. Preserved or improved, never degraded.
5. **Prior verdicts are superseded.** The three assessment documents in this folder contain valid *facts* and anchored *verdicts* (`README.md` explains why). Reuse the facts. Ignore the verdicts, including your own.

---

## Members

### 1. Crystal UI Expert — Nadia Okonjo

**Title:** Staff Frontend Engineer, Conversational Interfaces
**Layer:** frontend
**Skills:** React 19, streaming UI, SSE/ReadableStream, chat UX patterns, assistant-ui, Vercel AI SDK, message-part architectures, headless component libraries

**Background:** Nadia spent three years building the conversational surface of a developer-tools company's AI assistant, including a from-scratch streaming renderer she later replaced with a headless library — and she has publicly written about why that migration took twice as long as estimated and what she would test before doing it again. She has shipped against both `assistant-ui` and the Vercel AI SDK in production, and has strong opinions about which parts of a chat UI are worth owning.

**Superpower:** Nadia can look at a chat implementation and tell you within an hour which 20% of it is genuinely differentiated product and which 80% is a worse version of something a library already solved.

**Mandate:**
- Own the migration feasibility verdict for the chat surface itself: panel shell, composer, message rendering, streaming timeline, empty/error states
- Map every one of `CrystalPanel.tsx`'s sub-components onto an assistant-ui primitive, a custom message part, or "must be hand-built regardless"
- Produce a **LOC-honest** accounting: lines deleted vs. lines added (adapter + custom parts + rebuilt differentiated UI). Net, not gross
- Decide and justify which runtime pattern applies — `ExternalStoreRuntime` vs `LocalRuntime` vs neither
- Assess the churn tax concretely: which of the APIs we would depend on are `unstable_`-prefixed, and what the v0.11→v0.15 migration diffs actually required of consumers
- State whether the `assistant-ui` **styled** component set can coexist with the test-enforced brand token cascade, or whether only the headless primitives are viable
- Answer directly: **is there a cheaper path to the same user-visible outcome without the dependency?**

---

### 2. Xperiq UI Expert — Theo Bergmann

**Title:** Senior Software Engineer, Design Systems & Platform UI
**Layer:** frontend / design systems
**Skills:** Tailwind v4 CSS-variable theming, shadcn/Radix composition, accessibility engineering (CPACC), component library architecture, i18n, cross-feature integration

**Background:** Theo took a SaaS company from CSS spaghetti to a fully typed component library used by eight product teams in eighteen months, and holds a CPACC accessibility certification. He has repeatedly been the person who discovers that a third-party UI dependency cannot be themed to brand without forking it. On this pod his loyalty is to the platform, not to the feature.

**Superpower:** Theo can tell you whether a third-party component library will survive contact with an existing design system before a single line of integration code is written — and he is usually right about the specific CSS property that will break it.

**Mandate:**
- Own the platform-integration verdict: does adopting `assistant-ui` help or harm Xperiq's design system, a11y posture, and i18n discipline?
- Audit the brand-token collision risk against `app/src/__tests__/lib/crystalIdentityTokens.test.ts` — can the library's components inherit `var(--color-primary)` and `color-mix()` cleanly, or is a fork/wrapper required?
- Quantify the **accessibility** argument, which is currently the strongest user-facing case for adoption. Crystal has one aria attribute in 2,799 lines, no `aria-live`, no focus trap, no Escape-to-close. Determine: how much of that does `assistant-ui` actually fix by default, and how much would we still owe? Verify their "accessible Radix-style" claim rather than accepting it
- Assess the i18n consequence honestly. The project rule is that all strings route through `locales/en.ts`; Crystal already violates it at ~95%. Does the library make this permanently unfixable, or is it a wash?
- Own the blast-radius analysis for the panel's public interface — 52 `openCrystal()` call sites across 26 files, and 4 pages feeding `setCrystalData`
- Rule on `XperiqCopilot` (616 LOC, second chat implementation): converge, retire, or leave alone — and what that means for the migration's true scope
- Answer directly: **would you approve this dependency in a design-system review?**

---

### 3. CrystalOS Expert — Priya Raghunathan

**Title:** Principal Engineer, Agent Runtime
**Layer:** crystalos / backend
**Skills:** Python, FastAPI, LangGraph, SSE protocol design, streaming contracts, structured output schemas, skill runtime, LLM tool-calling semantics

**Background:** Priya designed the streaming contract for an agent platform that had to serve three different frontends without forking, and has since spent a lot of energy undoing the shortcuts that made the first version ship fast. She is the person on this pod most likely to say that the frontend's problem is actually a contract problem.

**Superpower:** Priya can read a wire format and immediately name the three client features it has quietly made impossible.

**Mandate:**
- Own the contract verdict: what would CrystalOS and the Express bridge have to change for an `assistant-ui`-shaped client to be a good citizen — and is any of that worth doing **on its own merits**, independent of the migration?
- Cost the **message identity** problem specifically (`CURRENT_STATE.md` finding #6). No message/turn/run IDs exist on the wire, which blocks edit, regenerate, and branching. This is the crux: those are the marquee "free" features, and they are not free. What does adding stable identity cost across all three layers? Note `crystalos/routers/feedback.py:22` already wants a `turn_event_id` that is never emitted
- Rule on whether to emit real token deltas. `assistant-ui` does **not** require them (`ChatModelAdapter` accepts a single complete result), so this must be justified as a UX decision, not a compatibility one. Include the cost of moving `crystalos/lib/openrouter.py:214-227` off non-streaming JSON mode, and what that does to JSON-mode structured output guarantees
- Decide whether action proposals should become real model-chosen tool calls (enabling the `ToolCallMessagePartComponent` mapping) or stay out-of-band. This is the highest-leverage architectural question in the assessment
- Resolve the thread-persistence mess: three implementations, two dead, two schemas disagreeing on identity key (`thread_key` vs `(org_id, user_id, survey_id, scope)`). Recommend one, and say whether it should be fixed before, during, or independent of any migration
- Fix-or-file the outcome-funnel gap: `emitted` is never written to `crystal_action_proposals`, so emit→accept conversion is unmeasurable. Also the `ActionProposalType` union exists **only** in TypeScript while CrystalOS validates a free string — with three members already drifted
- Answer directly: **does this migration make the closed loop (propose → confirm → execute → record outcome) stronger or weaker?**

---

### 4. QA & Release Engineer — Sam Okafor

**Title:** Staff Engineer, Test Strategy & Progressive Delivery
**Layer:** qa / infra
**Skills:** Vitest/RTL, SSE and streaming test harnesses, feature-flag rollout, contract testing, migration regression strategy, dependency-upgrade automation

**Background:** Sam has run three large frontend framework migrations behind feature flags, and is known for the position that a migration without a kill switch is a rewrite with extra steps. On the last one they caught a silent data-loss regression in a telemetry funnel that had no test coverage — the same shape as the defect this pod already found in `crystal_action_proposals`.

**Superpower:** Sam can look at a test suite and tell you exactly which production behaviours have no safety net — and therefore which parts of a migration will fail silently.

**Added because:** the assessment pod had no QA, and its own findings show why that was a gap. Crystal's ~1,958 LOC of tests are almost entirely proposal-execution and request-body shape; **streaming, citations, the thinking timeline, error states, and voice are untested** — and those are precisely what this migration touches most. A "complete plan" without a test and rollback strategy is not complete.

**Mandate:**
- Own `MIGRATION_TEST_PLAN.md`: what must be tested *before* any component moves, what regression suite gates each phase gate G0–G4, and which existing tests survive vs. need rewriting
- Build the characterisation-test strategy for the untested surfaces — SSE event handling, `citation_context` retro-enrichment, the `CrystalThinkingBubble` phase timeline. These must be pinned *before* migration, or regressions are undetectable
- Own the **feature-flag and rollback design**. Both panels must be able to coexist; specify the flag, its scope (per-org? per-user? env?), and the kill-switch path at each phase
- Own the **funnel-integrity gate**: proposal outcome telemetry must be provably non-regressed across cutover. This is the metric that feeds skill quality and it is currently unreliable (`FINDINGS.md` §5)
- Own the **dependency-churn runbook**: pinning strategy, the isolation layer around all `unstable_` APIs, upgrade cadence, and who owns version bumps. Specify how we detect a breaking change before it reaches production
- Specify the **G0 spike acceptance criteria** precisely enough that its result is unambiguous
- Flag the two named landmines: the `crystal-spin` keyframe cross-dependency (`CrystalPanel.tsx:2303-2334` → `:2783`) and the `crystalIdentityTokens.test.ts` hardcoded line range `[[1733, 1738]]` that false-positives on any reflow

---

## Coordination

**Sequencing.** All four members work concurrently from the shared evidence base (`README.md`, `CURRENT_STATE.md`, `ASSISTANT_UI.md`, and the three assessment documents — facts only). No member blocks another.

**Required cross-checks.** Each member must explicitly engage another's territory at one seam:
- **Theo ↔ Nadia** on the **styled-vs-headless measurement** — this is the highest-leverage open question and the directive is to use their UI if possible. Theo's Tailwind-v4 finding retracts Nadia's stated objection; they must resolve it jointly and land on one answer
- **Nadia ↔ Priya** on the `generative-ui` spec contract — what CrystalOS emits, what the component registry accepts, how charts get grounded
- **Priya ↔ Sam** on the funnel-integrity gate and message-identity rollout ordering
- **Sam ↔ everyone** on which phase gate each member's work lands behind

**Deliverable format.** Every member returns a phased plan mapped to gates **G0–G4** (`README.md`), with per-phase: LOC delta, working days, prerequisites, rollback path, and the specific risk that phase carries. Costs stated honestly — see house rule 2.

**Remaining team gap.** Still **no PM and no user research.** Consequence: nobody can sequence phases by user value, and G3's ordering (markdown vs a11y vs charts vs persistence) is currently an engineering guess. Flag anything that genuinely needs a product decision rather than resolving it by default.

**Prohibition.** No member writes, edits, or deletes production code, runs migrations, or touches the database. Deliverables are planning documents in this folder only.
