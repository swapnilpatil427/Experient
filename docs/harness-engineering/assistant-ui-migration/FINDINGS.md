# Findings & Recommendation

> **Date:** 2026-08-04
> **Inputs:** three independent assessments, run concurrently with no visibility into each other — `ASSESSMENT_CRYSTAL_UI.md` (Nadia Okonjo), `ASSESSMENT_XPERIQ_UI.md` (Theo Bergmann), `ASSESSMENT_CRYSTALOS.md` (Priya Raghunathan)
> **Status:** Recommendation. Not a commitment. No production code has been written.

---

## 1. Verdict

| Member | Verdict | Confidence | One-line position |
|---|---|---|---|
| Nadia Okonjo (Crystal UI) | **`DON'T`** | ~75% | Net LOC is positive and large; only 104 of 2,799 lines are honestly deletable |
| Theo Bergmann (Xperiq UI) | **`PARTIAL`** | ~85% | Adopt nothing now; do the platform hygiene. **Would not approve the dependency in a design-system review** |
| Priya Raghunathan (CrystalOS) | **`PARTIAL`** | ~80% | Don't migrate the runtime; do the contract work, then re-ask |

**Unanimous: do not adopt `assistant-ui` now.** Three specialists, three vantage points, no cross-contamination, same answer. The two `PARTIAL` verdicts are "partial" only in that both prescribe substantial work — none of which is the migration.

### Against the five decision tests in `README.md`

| # | Test | Result |
|---|---|---|
| 1 | Closes a gap we actually have? | **FAIL.** The a11y case — the strongest argument for adoption — collapsed under source verification (§3). Migration-alone delivers **zero** of the three user-visible gaps |
| 2 | Replaces more code than it adds? | **FAIL.** +1,015 LOC for migration alone; ~+2,065 vs ~+750 for equal outcome |
| 3 | Differentiated 40% survives? | **FAIL.** 26 of 41 components are "hand-build regardless." The proposal loop's 268-LOC `executeAction` is untouched by the tool-UI mapping |
| 4 | Churn tax acceptable? | **FAIL.** Three of four migrations rearchitected the exact seams a Crystal migration is built on; 190 of 655 added lines sit on `unstable_` surface |
| 5 | Incremental and reversible? | **PASS** — more cleanly than credited. `openCrystal(query?, ctx?)` is a genuinely good façade and is unchanged in both paths |

One pass, four fails.

---

## 2. The thesis

> **This is a discipline gap, not a library gap.** — Theo

The evidence for that sentence is `XperiqCopilot`. It is the *secondary*, less-maintained chat surface, and it has **better accessibility than the flagship** — 3 `aria-*` attributes plus Escape-to-close, versus Crystal's 1 and none. Same codebase, same conventions, no library in either. Crystal also sits surrounded by six correct `aria-live` precedents elsewhere in the app (`insights/TopicChangeBar.tsx:77`, `tag-report/PipelineVisualization.tsx:113`, `prism/FileDropzone.tsx:301`, and three more) that it ignores.

A dependency does not fix a discipline gap. It relocates it, and adds a version-upgrade obligation on top.

---

## 3. The a11y case collapsed — this is the most important finding

Accessibility was the strongest user-facing argument for adoption, so it got the most rigour. Theo verified `assistant-ui` **against its own source**, not its prose:

| Claim | Reality |
|---|---|
| "Accessible Radix-style primitives" | Primitives are **"inspired by Radix," not built on it** (`/docs/primitives.md`). Only `AssistantModal` uses Radix — and it uses **Popover** with `modal={false}`, the wrong shape for a docked panel |
| `ThreadViewport` | `packages/react/src/primitives/thread/ThreadViewport.tsx` — **no `role`, no `aria-*`, no live region** |
| `MessageRoot` | **No ARIA at all**; only `data-message-id`, `data-aui-top-anchor-*` |
| Registry `thread.tsx` | 6 `aria-label`s + `aria-busy`, but **zero** `aria-live` / `role="log"` / `role="status"` / sr-only announcer; **zero** `prefers-reduced-motion` guards while using `animate-pulse` / `animate-in` |
| i18n | **No localization doc page exists.** `/docs/rtl.md` is direction-only |

**Scorecard: adoption closes ~1.5 of 14 enumerated a11y defects (~10%), introduces 2 new ones, and closes 0% of WCAG 4.1.3** — the streaming answer is silent to a screen reader in both worlds.

Post-adoption a11y cost: **~165 LOC. With no dependency: ~171 LOC.** The delta is noise.

### Four previously-unnamed WCAG AA failures, computed

None of these is fixed by any library:

| Location | Measured | Required |
|---|---|---|
| `CrystalPanel.tsx:1494` composer placeholder | **2.24:1** | 4.5:1 |
| `:2498` | **3.01:1** | 4.5:1 |
| `:2506` | ~3.6:1 | 4.5:1 |
| `:1465` composer border | **1.23:1** | 3:1 |

---

## 4. Cross-corrections between members

The pod caught four errors in our own shared evidence base and three in each other's work. All are folded back into the source documents.

**Corrections to the shared docs:**

1. **`ASSISTANT_UI.md` §6 #5 was wrong** (Nadia). Styled components are CLI registry-copied into the repo (shadcn model), landing outside the three paths `crystalIdentityTokens.test.ts:19-23` scans — they *cannot* fail that test. → corrected in place.
2. **`app/CLAUDE.md:73` and `app/src/lib/brandTheme.ts:9-10` are factually wrong** (Theo). Tailwind v4 utilities **are** live-brandable, proven from the shipped bundle: `.bg-primary{background-color:var(--color-primary)}`, with `--color-primary:#2a4bd9` inside `@layer theme` (depth 2) and `--color-primary:var(--brand-primary)` in an **unlayered** `:root` (depth 1) — unlayered wins. **This retracts Nadia's core styled-set objection** (`ASSESSMENT_CRYSTAL_UI.md:312-314`). ⚠️ *These two files are outside this folder and have not been edited — see §7.*
3. **`CURRENT_STATE.md` counts were off** (Theo): `setCrystalData` is **3** pages not 4; `openCrystal` is **50 call sites / 22 files** not 52/26. → corrected.
4. **"No focus trap / no `aria-modal` / no `role="dialog"`" is not owed work** (Theo). Crystal is **non-modal** — no overlay, the page stays interactive. Two of the three would be *defects to add*. Focus-in already exists at `CrystalPanel.tsx:666-671`. → corrected; this also overrules Priya's §6.2 item 3.

**Between members:**

5. Theo → Nadia: her "17 `t()` calls" is wrong; `CURRENT_STATE.md`'s **12** is right. The extra five are substring false positives (`ge|t('`, `spli|t('`, `setInpu|t('`).
6. Theo → Priya: the reasoning timeline is **not** unfixable client-side. `CrystalPanel.tsx:2423,2433` already keys on the machine code `tool`; `step.message` is only the third fallback. The genuine contract slice is just `observation.summary` (`:2504-2507`) plus 6 error strings. Theo backs Priya's `locale`-on-`CrystalInput` proposal as the one true prerequisite for a second locale.
7. Nadia + Priya independently converged, without seeing each other's work, on **the same alternative**: put `message_id`/`turn_id` on the wire instead of adopting the library.

---

## 5. What the assessment found instead

The migration question turned out to be a stalking horse for a set of real defects. Ranked by severity.

### The record-outcome step is broken in five places

Priya's mandate answer: three of the four closed-loop steps — propose, confirm, execute — are healthy. **`record outcome` is broken, and it is the step that feeds skill quality.** A migration rewrites the three healthy steps and leaves the broken one untouched.

Root `CLAUDE.md` claims "each turn emits telemetry the next tier learns from." **For the chat path that is currently false.**

- **`proposal_key` is a title-derived slug** (`crystal.py:964-966`; the skill schema has no `id`), so repeat emissions collapse onto one row via `ON CONFLICT` — and a `dismissed` can overwrite a `succeeded`. Denominators are structurally wrong, in the direction that flatters the product.
- **`emitted` is never written**, so emit→accept conversion is unmeasurable.
- No CHECK constraint on `status`.
- **`POST /api/crystal/feedback` is uncallable by construction** (`feedback.py:58`) — complete, tested, shipped inert.
- `crystal_debug_traces` is unjoinable.

**Root cause of all five: one missing ID.** `crystal_turn_events.id` is a Postgres-generated UUID created in a fire-and-forget task (`turn_publisher.py:112`, scheduled at `crystal.py:1659`) *after* the answer frame is already on the wire. Migration `20260623000009:14-15` made `thread_id` nullable **to accommodate the bug** — its own comment says "GAP 7: telemetry fires before thread is created."

### Live permissions defect

**`user_role` never reaches CrystalOS**, so `main.py:1744` pins it to `viewer` — **the entire browser chat path runs on viewer permissions**, gating which tools Crystal may use. The only caller in the repo that sets it is the Novu notification path.

### The brand system rests on an undocumented, untested import

The whole live-brandability mechanism depends on `theme.css` being imported **unlayered** at `index.css:2`. Nothing documents this and nothing tests it. The specific failure mode is not a CSS property — it's a **cascade layer**. Someone adding `@layer` around that import breaks brand theming platform-wide.

Relatedly, the "test-enforced token cascade" **enforces 7 strings in a file containing 66 hex literals**, and `ExperientCopilot.tsx` — a live Crystal-branded surface — isn't in the guard list at all.

### `check:i18n` cannot detect the problem it exists for

`scripts/check-i18n.mjs` only reports **used-but-undefined** keys. A file with zero `t()` calls is therefore its *cleanest possible pass* — so `CrystalPanel` (95% hardcoded) and `ExperientCopilot` (100%) both pass cleanly. **And it never runs anyway: it appears only in `app/package.json:16`, not in `ci.yml`.**

### Branching should never be built

Priya: every turn re-uploads its own grounding corpus (`CurrentState` finding #4), so two branches of one question were grounded differently and are **not comparable alternatives**. This removes one of the headline reasons to want a chat library.

### Token deltas: no — and not for plumbing reasons

The answer text **isn't final at generation time.** Three places already-generated prose is discarded: JSON-validation retry (`openrouter.py:445-457`), EVALS retry that replaces the output entirely (`skill_runtime.py:181`), and eval-fail → `return None` → a *different* LLM call (`crystal.py:1352-1359`, `:1978-1989`). Streaming prose would stream text we then throw away.

Also, the latency isn't in generation. `crystal-analyst` is capped at 1200 tokens and told to write 2-5 sentences. The real cost is **3 sequential DB tool calls** (`crystal.py:1912` — a `for` loop, not a `gather`) and **three sequential LLM-judge calls**. We already stream the slow part. *The `for`-loop → `gather` change is likely the single cheapest latency win available.*

---

## 6. Recommendation

**Do not adopt `assistant-ui` now.** Do the following instead, in tiers.

### Tier 0 — verdict-independent hygiene (~4 days, do now)

Every item here is worth doing whether or not we ever revisit the library.

| Item | Cost | Why |
|---|---|---|
| Delete `IrisChat.tsx` + `pages/insights/ConversationView.tsx` (679 LOC, zero importers incl. tests) | hours | Confirmed dead by two members |
| Fix `crystalIdentityTokens.test.ts` hardcoded range `[[1733, 1738]]` | ~10 LOC | False-positives on **any** reflow of `CrystalPanel.tsx`, including the monolith split we want |
| Add `ExperientCopilot.tsx` to the token guard list | small | Live Crystal-branded surface, currently unguarded |
| Document + test the unlayered `theme.css` import | small | Platform-wide brand theming depends on it silently |
| Wire `check:i18n` into `ci.yml`; extend it to flag hardcoded JSX strings | ~1 day | Today it structurally cannot catch this class of bug |
| `TOOL_META` → `t('crystal.tool.' + tool)` | one expression | Keys already exist at `en.ts:3947-3961`, currently dead |
| Fix the 4 computed WCAG AA contrast failures | small | §3 |
| `for` loop → `gather` at `crystal.py:1912` | small | Probably the cheapest latency win we have |

### Tier 1 — the contract work (~10 days; this is the actual fix)

| Item | Cost |
|---|---|
| **`message_id` / `turn_id` on the wire** — emit `crystal_turn_events.id` *before* the answer frame | ~5.5 days |
| Server-mint proposal `uuid4` + `turn_id` + validate `type` server-side in `_normalize_proposal` | ~3 days |
| Fix `proposal_key` collapse; write the `emitted` row; add a CHECK on `status` | ~1 day |
| Fix `user_role` plumbing through the Express bridge | ~0.5 day |

Tier 1 makes the closed loop **measurable for the first time**, and it un-bricks two shipped-but-inert features (`/api/crystal/feedback`, `crystal_debug_traces`). It is independent of any rendering decision.

### Tier 2 — the UI work, no dependency (~+750 LOC vs ~+2,065 with the library)

Markdown via `react-markdown`; an `aria-live` announcer for streaming; split the 2,799-line monolith; **converge `XperiqCopilot`** (step 1 ≈1 day, using the `surface`/`builderContext` mechanism that already ships — do this *before* any other UI work, since leaving it doubles the scope of everything else); thread persistence UI on `crystal_threads` **v2**, keyed `(org_id, user_id, survey_id, scope)`, retiring v1 and the `MemoryManager` L2 confusion. Note v1's `thread_key` has no user component — every user in an org would share one thread. Latent today (that path is gated off), a privacy defect if re-enabled.

### Tier 3 — the conditions under which we re-ask

Revisit if **either** holds:

1. **A 1.0 ships** that de-`unstable_`s `createMessageConverter`, `capabilities`, message metadata, and `threadId`/`parentId`.
2. **The roadmap commits to ≥3 of** {attachments, branch/edit/regenerate, thread-list UI, TTS, virtualization} within two quarters. This is the arithmetic inverter — see §7.

**The falsification test, if we want to pre-empt it:** Nadia's ≤3-day spike — render the *unmodified* `CrystalThinkingBubble` + `ActionProposalCard` inside `ThreadPrimitive`, with citation retro-enrichment surviving `convertMessage`. Under 200 LOC of adapter and her estimate is wrong. Cheap, and it settles the question with evidence rather than argument.

---

## 7. Where this recommendation is weakest

Stated plainly, because both dissents are good.

**Theo:** *"I scored a snapshot; a11y posture is a rate."* Ours on this surface is approximately zero — 2,799 lines, one aria attribute, surrounded by six correct precedents it ignores. Theirs is positive and unasked-for. On a three-year horizon a positive rate beats 1.5/14. **If the failure here is organisational rather than technical, this verdict is wrong** — because Tier 0 and Tier 2 assume we will do work we have so far not done.

**Nadia:** she costed against *today's* gaps, which structurally undervalues optionality. If ≥3 of the Tier 3 features land within two quarters, +1,015 LOC is a one-time payment against 2,000–3,000 lines we'd hand-build worse. **The arithmetic inverts.** That is a product-roadmap question this pod cannot answer.

**Structural gap:** the pod had **no QA and no user research** (`TEAM.md` records this as deliberate). So nobody owns the test-migration plan — Crystal's ~1,958 LOC of tests are proposal-focused, while the untested surfaces (streaming, citations, thinking timeline) are exactly what a migration touches most. And critically, **nobody can say whether users are actually complaining** about markdown, a11y, or persistence. The defects in §5 are real regardless. "Is this the right quarter to fix them" is not a question this team was staffed to answer.

**Two files need owner sign-off before correction** (both outside this folder, both left untouched): `app/CLAUDE.md:73` and `app/src/lib/brandTheme.ts:9-10` contain a factual error about Tailwind v4 brandability that Theo disproved from the shipped bundle. Since `app/CLAUDE.md` is an instruction file that shapes future agent behaviour, correcting it is a decision, not a cleanup.
