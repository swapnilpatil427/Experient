# Crystal → assistant-ui Migration Assessment

> **Status:** **DECIDED — migrating.** Planning phase. No production code written yet.
> **Created:** 2026-08-04 · **Decision recorded:** 2026-08-04
> **Decision owner:** Swapnil Patil
> **Dependency:** [`@assistant-ui/react`](https://www.assistant-ui.com/) — MIT, ~11.4k GitHub stars, YC-backed

---

## The decision

**Crystal's chat UI will be migrated to `assistant-ui`.** Decided by the product owner on 2026-08-04.

**Stated rationale:** keep the platform on current, industry-standard conversational-UI infrastructure going forward, rather than maintaining a bespoke chat chassis that only improves when we fund it. Generative UI (agent-specified rich content, including charts) is a first-class goal, not a side effect.

**Directive:** use assistant-ui's own UI components where possible; preserve Crystal's look and feel.

### ⚠️ Read this before the assessment documents

An assessment pod ran first and returned three verdicts against migrating now (`FINDINGS.md`). **That recommendation has been overridden by the decision above, and the override is legitimate** — the pod was chartered to cost *replacing what exists* and was never asked to value *enabling what doesn't exist yet*. It also had no PM, no designer, and no user research, so it could not weigh strategic platform positioning at all. Both dissents inside `FINDINGS.md` §7 predicted this exact inversion.

**The assessment's methodology was also flawed, by my own hand:** the briefs carried a provisional anti-migration recommendation that all three agents read before forming their own views. The *checkable facts* in those documents remain valid and load-bearing. The *verdicts* are anchored and should be treated as superseded.

`FINDINGS.md` is retained as institutional memory — it records the real risks the plan must now mitigate, not a live objection.

---

## The question now

**Not "should we." "How, in what order, and what does it actually cost?"**

Three sub-questions the plan must answer:
1. Can we use assistant-ui's **styled** components and still keep Crystal's identity? *(See the key reversal below — this is now genuinely open.)*
2. What contract changes does CrystalOS owe for the migration to be worth having — specifically message identity and a `generative-ui` spec channel?
3. How does this ship incrementally, behind a flag, reversibly, without a big-bang cutover of the primary AI surface?

---

## Why this came up

Crystal's chat surface has accumulated real gaps that a mature chat library solves as table stakes. Before we hand-build fixes for each one, it is worth asking whether we should stop hand-building the generic parts of a chat UI at all.

## Scope of the assessment

**In scope**
- `app/src/components/CrystalPanel.tsx` and everything it renders
- The SSE contract from CrystalOS through the Express bridge to the browser
- `ExperientCopilot.tsx` (`XperiqCopilot`) — the second, independent chat implementation
- Thread persistence, a11y, markdown, i18n, and the action-proposal confirm-card loop

**Out of scope**
- Crystal's reasoning quality, prompts, skills, or eval harness
- Non-chat Crystal surfaces (weekly brief cards, provenance panels, narrative widgets) except where they share the grounding contract
- Any change to CrystalOS's LangGraph internals

---

## Documents

| File | What it holds |
|---|---|
| `README.md` | This charter, the decision framework, and the current recommendation |
| `CURRENT_STATE.md` | Evidence-backed audit of Crystal's chat UI as it exists today |
| `ASSISTANT_UI.md` | What `assistant-ui` actually provides, verified against its own docs |
| `TEAM.md` | The assessment team and each member's mandate |
| `FINDINGS.md` | *(pending)* Synthesized team verdict and the recommendation that follows from it |

---

## The key reversal — why "use their UI" is now genuinely open

The assessment's headless-only conclusion rested on a claim that **turned out to be false**, and it was Theo who disproved it (`ASSESSMENT_XPERIQ_UI.md`, cross-correction #1):

> `app/CLAUDE.md:73` and `app/src/lib/brandTheme.ts:9-10` assert that Tailwind v4 utilities are not live-brandable. **They are.** Proven from the shipped bundle: `.bg-primary{background-color:var(--color-primary)}`, with `--color-primary:#2a4bd9` inside `@layer theme` (depth 2) and `--color-primary:var(--brand-primary)` in an **unlayered** `:root` (depth 1) — unlayered wins.

Both frontend experts recommended headless-only, and **Nadia's stated reason for it is retracted by Theo's finding.** Her objection was that the styled components use Tailwind brand utilities rather than the `var(--color-primary)` cascade. If those utilities *are* live-brandable, that objection dissolves.

Which means: **assistant-ui's registry components may inherit Crystal's brand automatically.** Nobody has tested this. It is the single highest-leverage unknown in the plan, and it maps directly onto the "try to use their UI" directive.

Second enabler: registry components are **CLI-copied into our repo** (the shadcn model). They become our files — themeable, `t()`-able, and editable. That removes both the theming objection and the i18n objection in one stroke.

## Planning constraints

Non-negotiable properties of the plan, in priority order:

1. **Incremental and flag-gated.** No big-bang cutover of the primary AI surface. A kill-switch back to the current panel must exist at every phase.
2. **The differentiated loop cannot regress.** The tool-aware reasoning timeline, citation/provenance rendering, and the 20-type propose → confirm → execute → record-outcome loop are the product. Preserved or improved, never degraded.
3. **Styled-first, headless-fallback.** Attempt assistant-ui's own components. Drop to headless primitives only where measurably necessary, and record why.
4. **Generative UI is in scope, not deferred.** Agent-specified rich content — starting with charts via Recharts, already in `app/package.json` — is a goal of the migration, not a follow-on.
5. **Churn managed explicitly.** Pinned version, an isolation layer around every `unstable_` API, and a named owner for version bumps.
6. **Contract debt fixed on the way through, not around.** Message identity is a migration prerequisite, not a nice-to-have (see `FINDINGS.md` §5).

## Phase gates

Each phase ships behind a flag and must pass its gate before the next begins:

| Gate | Must be true |
|---|---|
| **G0 — Spike** | Unmodified `CrystalThinkingBubble` + `ActionProposalCard` render inside `ThreadPrimitive`; citation retro-enrichment survives `convertMessage`; one CrystalOS-emitted `generative-ui` spec renders an NPS chart. **Styled-vs-headless answered with a measurement.** |
| **G1 — Contract** | `message_id`/`turn_id` on the wire; proposal IDs server-minted; `emitted` row written; funnel denominators correct |
| **G2 — Parity** | Every current Crystal capability works on the new chassis behind the flag. Zero regression in the proposal outcome funnel |
| **G3 — Gains** | Markdown, `aria-live` announcements, thread persistence, and generative-UI charts live |
| **G4 — Cutover** | Flag defaulted on; old panel deleted; `XperiqCopilot` converged |

---

## Facts the plan must build on

Carried forward from the assessment. These are the **checkable** findings, not the superseded verdicts.

**Compatible as-is — no change needed:**
- `ChatModelAdapter.run()` accepts a **single complete result**; the generator form is optional and yields cumulative state, not deltas. Crystal's one-shot `answer` frame is legal. **Token streaming is not required.** (And per `ASSESSMENT_CRYSTALOS.md`, streaming prose would be actively wrong — the answer text isn't final at generation time; three code paths discard already-generated prose.)
- `openCrystal(query?, ctx?)` is a good imperative façade. All 50 call sites across 22 files are unchanged by the migration.
- `ExternalStoreRuntime` fits; `LocalRuntime` does not — `citation_context` retro-enriches the already-rendered message N−1 (`CrystalPanel.tsx:423-431`) and `note()` appends assistant messages with no run in flight (`:748-752`). `LocalRuntime` owns the array and permits neither.

**Blockers the plan must clear:**
- **No message/turn/run IDs on the wire.** Edit, regenerate, and per-message feedback are not inheritable from the library — they need a contract change first. The ID already exists (`crystal_turn_events.id`) but is minted in a fire-and-forget task *after* the answer frame ships.
- **assistant-ui's primitives have no ARIA.** Source-verified: `ThreadViewport.tsx` and `MessageRoot.tsx` carry no `role`/`aria-*`/live region; the registry `thread.tsx` has no `aria-live` and no `prefers-reduced-motion` guards. Primitives are *"inspired by Radix,"* not built on it. **Accessibility remains ours to build (~165 LOC) — the migration does not deliver it.**
- **No built-in charting.** Generative UI is a JSON-spec protocol resolved against a **developer-supplied** component registry; unknown names throw `GenerativeUIRenderError`. We supply the chart components (Recharts, already present). CrystalOS must emit the spec.
- **190 of ~655 adapter lines sit on `unstable_` APIs** that may change in a patch release: `unstable_createMessageConverter`, `unstable_capabilities`, message metadata, `unstable_threadId`/`parentId`.
- **Branching should not be built.** Every turn re-uploads its own grounding corpus, so branches of one question were grounded differently and aren't comparable alternatives.

**Two abandoned precedents that need explaining before generative UI is funded:**
- `MiniNPSChart` was **deliberately removed** (`CrystalPanel.tsx:2543`) while Recharts was already available — so the blocker was never technical.
- `render_hint: 'document'` exists in CrystalOS tool results and `InsightDocumentCard` is wired to render it, but **no server emitter ever ships it.**

Two abandoned attempts at rich content in Crystal messages is a pattern. If the cause was product judgment rather than engineering difficulty, a library won't change the outcome.

---

## Non-goals

- Rewriting CrystalOS's LangGraph internals or reasoning quality.
- Emitting token deltas (see above — actively counter-indicated).
- Building message branching.
- Migrating non-chat Crystal surfaces (brief cards, provenance panels, narrative widgets).
