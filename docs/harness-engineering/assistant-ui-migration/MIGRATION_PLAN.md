# Crystal → assistant-ui: Consolidated Migration Plan

> **Date:** 2026-08-04
> **Status:** Plan complete. Awaiting cost sign-off and 6 product decisions.
> **Inputs:** `PLAN_FRONTEND.md` (Nadia), `PLAN_DESIGN_SYSTEM.md` (Theo), `PLAN_CONTRACT.md` (Priya), `MIGRATION_TEST_PLAN.md` (Sam)
> **Decision:** migration committed 2026-08-04 (`README.md`). This document plans it; it does not revisit it.

---

## 1. Cost and calendar

| Lane | Owner | Days | LOC delta (own lane) |
|---|---|---|---|
| Frontend components + adapter + generative UI | Nadia | 38 | +1,991 |
| Design system, a11y, i18n, `XperiqCopilot` | Theo | 21 | −1,823 |
| CrystalOS + Express contract | Priya | 26.75 | not stated in LOC |
| QA, flags, funnel integrity, churn runbook | Sam | 30 | +1,460 (tests) |
| **Total** | | **≈115.75 engineer-days ≈ 23 engineer-weeks** | |

**Calendar floor: ~14 weeks.** Driven by two hard waits, not effort — a ≥2-week legacy-only funnel baseline (after the funnel fix) and a 30-day post-cutover retention of the fallback panel. 11 of Sam's 30 days land *before* G0 opens.

> ⚠️ **Do not sum the LOC columns.** Nadia's +1,991 is "migration alone" scoped to her lane; Theo's −1,823 is his lane only and includes deletions Nadia also counts. The lanes overlap and were costed independently. A true consolidated net LOC requires one reconciliation pass that has not been done. **Treat days as the reliable figure and LOC as directional.**

**Reconciling to the earlier number:** the assessment's +1,015 LOC covered replacing today's UI only. The plan is larger because it now includes generative UI (new capability, ~48% of Nadia's increase), the registry code styled-first makes us own, the `unstable_` isolation layer, the contract work, and a characterisation-test phase that did not previously exist. Nadia's framing is the one to sign against: **the price of the option is roughly 1,360 LOC and 4 engineer-weeks in her lane** — the rest is work that was already owed.

**~8 of Theo's 21 days and most of Priya's G1 work survive any rollback** — they are owed regardless. The sequence front-loads what cannot be wasted.

---

## 2. Your directive was achievable — measured, not asserted

**"Use their UI, keep Crystal's look and feel" is confirmed by measurement.** Both frontend experts independently retracted their own load-bearing objections, and neither retraction was to please anyone — each was disproved by evidence the other produced or by their own re-measurement.

Theo fetched **12 live registry payloads** and cross-resolved every token against the shipped bundle (`app/dist/assets/index-YOCsYUQe.css`):

| Result | Count |
|---|---|
| Themes with **zero** token edits | 5 (`follow-up-suggestions`, `markdown-text`, `tool-group`, `tool-fallback`, `thread`/ActionBar after shim) |
| Needs ≤4 lines | 4 |
| Hand-built | 4 |
| **Fails on brand tokens** | **0 of 11** |

The four hand-built cases are **layout or data-model** mismatches, never theming — e.g. `thread`'s Root/Viewport models a 44rem centred chat *page* rather than a docked panel; `sources` renders `{url,title,favicon}` against Crystal's `[uuid]`→verbatims map.

**Retractions on record:** Nadia's headless-only recommendation rested on Tailwind brand utilities not being live-brandable — false (`index.css:2` imports `theme.css` unlayered; unlayered `:root` beats `@layer theme`). Theo's rested on `--color-tertiary` having no place in the token vocabulary — false; it's not in *shadcn's* vocabulary but it is in *ours*, declared at `index.css:65` and `theme.css:78`, with `.text-tertiary` / `.from-primary` / `.to-tertiary` already in the bundle. Crystal's two-hue gradient identity is **~14 `className` edits**. Theo assesses he had overcosted the styled path by ~4×.

Nadia additionally found a second inheritance path nobody costed: `app/CLAUDE.md`'s shadcn variable bridge maps `--color-*` onto shadcn tokens, so registry copies inherit brand through **two** independent mechanisms.

**Adoption strategy:** edit registry copies **in place**, on top of a one-time 6-line token shim. No wrappers — they cannot reach leaf elements and lose to `tailwind-merge` silently. No fork — there is nothing to fork, since the CLI copies files into our repo. Enforced by a ~40-LOC registry-hygiene guard test.

*Minor unreconciled discrepancy: Nadia counts 5 components staying headless, Theo counts 4 hand-built. Same reasoning, different boundary on one component. Resolve during G0.*

---

## 3. The single biggest risk: upgrade cadence

Sam resolved the open question via `npm view @assistant-ui/react time --json`:

- **v0.11.0 → v0.15.0 = 323 days.** Four breaking rearchitectures in under eleven months.
- Intervals are **accelerating: 138 → 103 → 82 days.** Projected next breaking minor: **~2026-10-18 — inside the G1–G3 window.**
- 433 versions in 27 months; **31 in the last 90 days** (~one every 2.9 days). `0.13` skipped entirely.
- `0.15.4` shipped **2026-08-03**, one day before the decision. `0.15.0` is seven days old and has taken four patches, three on a single day. Its migration guide ships **no codemod for its two hardest changes**.

**Plan on one breaking upgrade landing mid-migration.** Mitigations, all mandatory:

1. **Exact version pin, no caret.**
2. **All `unstable_` APIs confined to one module** behind our own stable interface (Nadia) — ~190 of ~655 adapter lines. A patch-release rename becomes a one-file fix.
3. **Weekly canary** upgrade run against the full characterisation suite.
4. **Type-assertion CI layer** to catch signature drift before production.
5. **Contract insulation** (Priya): CrystalOS emits a *neutral versioned `viz` payload*, not assistant-ui's spec shape; the frontend adapter translates. `kind` is a closed server `Literal` mapped to a total frontend map — so `GenerativeUIRenderError` is unreachable by construction.
6. **Wiring choice** (Nadia): GroupedParts render-functions, *not* the `components` prop — that prop is the exact seam v0.14 deprecated.

---

## 4. Blockers that must clear before anything else

Four items are hard prerequisites. Each is cheap; each invalidates downstream work if skipped.

| # | Blocker | Owner | Cost | Why it blocks |
|---|---|---|---|---|
| 1 | **EVALS `non_empty` scorer** — `_eval_structural` (`skill_runtime.py:484-487`) scores `non_empty / len(output)` across **every** key, ignoring the criterion's named fields. `crystal-analyst` E2 is `must pass`, which fails on `score < 1.0` (`:384-388`) | Priya | 0.5 d | Adding a `viz` field guarantees a must-pass failure on every chart-free turn. **Generative UI is dead on arrival without this.** Ships alone and first |
| 2 | **CSS-cascade invariant untested** — styled-first rests on `index.css:2`'s unlayered import, and a false "inherits our brand" result is indistinguishable from a true one | Theo/Sam | ~30 LOC | G0's central measurement — the one your directive depends on — is invalid until this is pinned |
| 3 | **Token-guard fragility** — `crystalIdentityTokens.test.ts`'s only hex hit is at `:1737`, inside exclusion range `[1733,1738]`. **Two inserted lines above it turns it red.** It also goes *green and stops testing* once `LAYER_COLORS` moves outside `CRYSTAL_IDENTITY_FILES:19-23` | Theo | small | Silent loss of the brand guard, by default, during the monolith split |
| 4 | **The existing funnel test pins the bug as correct** — `crystalProposals.test.js:70` asserts `ON CONFLICT (org_id, proposal_key)` and that the second status overwrites | Sam | small | Fixing the defect turns it red; must be rewritten in the same commit or someone reverts the fix |

---

## 5. Gate sequence

Conflicts resolved rather than averaged; resolutions marked ✔.

| Gate | Contents | Exit criteria |
|---|---|---|
| **P0** | Blockers §4. Characterisation tests for all untested surfaces (11 of Sam's 30 days). Registry-hygiene guard. Token shim | Every behaviour listed in §6 has a failing-then-passing test |
| **G0** | Spike: unmodified `CrystalThinkingBubble` + `ActionProposalCard` inside `ThreadPrimitive`; citation retro-enrichment surviving `convertMessage` (**two-turn** test — see §6); one CrystalOS `viz` payload rendering an NPS chart; styled-vs-headless measurement | Adapter ≤500 LOC (**Leg E estimate gate** — above that, re-cut the phase plan) |
| **G1** | `message_id`/`turn_id` additively on the wire; server-minted proposal IDs; funnel repair; `XperiqCopilot` step 1 ✔ | `turn_id` verified **in production with the old panel still default** — unknown SSE types fall through `CrystalPanel.tsx:419-477` silently. ≥2-week funnel baseline begins |
| **G2** | Full parity behind `crystal_chassis` flag ✔ (per-org, server-resolved) | Six funnel invariants hold; `describe.each` suite green on both branches. **Blocked by `XperiqCopilot` convergence** ✔ |
| **G3** | Four independently flag-gated slices, shippable in any order ✔: markdown · a11y · thread persistence · generative-UI charts | Per-slice gates; ordering deferred to product (§7) |
| **G4a** | Flag defaulted on; **both panels retained** ✔ | 30 clean days |
| **G4b** | Old panel deleted ✔ | — |

**Resolutions:**
- ✔ **`XperiqCopilot` converges at G1 and blocks G2** — my original `README.md` put it at G4. Theo and Sam both overruled me, correctly: an unconverged copilot makes the dual-branch test matrix a *third* arm and doubles every gate. ~1 day now vs ~6 QA days later. Its Escape-to-close and 3 `aria-label`s get ported **up** to the flagship first.
- ✔ **G4 splits into G4a/G4b** — deleting the fallback at cutover leaves the kill switch untested exactly when it is needed.
- ✔ **Flag is `crystal_chassis`, per-org, server-resolved.** Per-user would corrupt the funnel metric the gate exists to protect. `CRYSTAL_STREAMING` is an **anti**-precedent, not a precedent — a compile-time const that left 57 LOC of unreachable transport plus a stale `VITE_CRYSTAL_STREAMING` in `vitest.config.ts`.
- ✔ **A11y fixes land on the *current* panel first, behind no flag** (Theo) — so a kill-switch rollback can never revert a WCAG fix.
- ✔ **Theo's escalation about the abandoned rich-content precedents is closed, not escalated.** Nadia and Priya independently read the same code and both concluded mechanical cause: `MiniNPSChart` was demo scaffolding for `buildDemoResponse` removed with the mock path (`CrystalPanel.tsx:2543`), and `render_hint:'document'` never shipped because **the `answer` frame has four keys and rich content had no slot.** A missing contract — which this migration supplies. `README.md:127`'s concern is retired.

---

## 6. Test strategy essentials

**The funnel baseline does not equal itself.** Beyond the title-slug `proposal_key`: the unique index **omits `survey_id`** (cross-survey collapse); `DO UPDATE SET` freezes six columns at first insert and has **no lifecycle guard** (`insights.ts:2319`); `emitted_at` is never refreshed; **13 terminal `track()` sites fire with zero `await`** after `track('accepted')`; and the type-drift `default` branch actively writes **false `failed` rows** (`CrystalPanel.tsx:1009-1011`). `survey_id` is the literal `'global'` for every org-scope turn.

→ Equality-to-baseline is unachievable. Replaced with **six invariant assertions plus a dual-write `chassis` column**, gated on a ≥2-week legacy-only baseline *after* the fix.

**Two tests that would pass against a deleted implementation** — both must be written as specified:
- `citation_context` is conditional and pre-fetch (`experience.ts:781-782`), so retro-enrichment is **only observable on turn ≥2**. Single-turn tests are vacuous.
- If anyone "optimises" `CrystalPanel.tsx:429` into an in-place mutation, the converter memo holds and retro-enrichment stops **with no error**. Assert the converter spy's call count *increments*, not just the DOM.

**Coverage corrections:** app-side Crystal tests are **1,776 LOC across 6 files** (not the ~1,958/7 cited earlier in this folder — that figure isn't derivable from any grouping). A further **960 LOC of backend `.test.js`** was missed by a `*.test.ts` glob; real total ≈2,736, of which ~35% survives untouched.

**CI gaps:** `ci.yml` runs lint, `test:coverage`, and `build:app` — nothing else. `check:i18n` is absent from it **and** never sets an exit code (`:49-50` are `console.log` only), so wiring it in as-is adds a step that can never fail. `vitest.config.ts` has no coverage `thresholds`, so CI cannot fail on a coverage drop during a migration that deletes ~2,800 source lines.

**Landmine:** `crystal-spin` has **three** consumers (`CrystalPanel.tsx:2345`, `:2464`, `:2783`), not one. The two in-component consumers keep working after a bad refactor and **mask** the broken third.

---

## 7. Decisions needed from product

24 items were flagged across the four plans; deduplicated to six that actually gate work. The pod has no PM and declined to default these.

| # | Decision | Consequence | Gate |
|---|---|---|---|
| 1 | **Is `crystal-analyst` *required* to emit a `viz` spec when it cites a metric insight, or merely permitted?** | If merely permitted, the model may rarely do it, the chart registry has no users, and **the migration's stated justification does not materialise.** Highest-stakes item in this document | G3 |
| 2 | **Tier-0 (deterministic server-side charts, zero model risk) or Tier-1 (model-chosen)?** | Δ 2.5 days. Pairs with #1 | G3 |
| 3 | **G3 slice ordering** — markdown / a11y / persistence / charts | Cannot be sequenced by user value without a PM. Sam made all four independently flag-gated so any order works, but someone must pick | G3 |
| 4 | **Advance sign-off that reported proposal accept rate will visibly drop at cutover** | The denominator becomes correct for the first time. Better agreed now than explained after | G1 |
| 5 | **Copilot PII policy** — `admin` role unlocks real contact PII (`tools.py:2039`) | Blocks the `user_role` remediation design | G1 |
| 6 | **Three cosmetic/platform choices** — composer-border fix (one option is a visible change); installing `tw-animate-css` (makes six shared components animate for the first time); the `text-[10px]` type scale (root cause of 3 of 4 Crystal contrast failures) | Visual changes outside Crystal | G3 |

---

## 8. Findings that are separate from this migration

Discovered during planning. None is caused by the migration; several are fixed on the way through.

### Security — `user_role` self-assignment (live, currently inert)

`agentBody = { ...body, … }` (`experience.ts:706,733`) spreads the **raw client body**, and `main.py:1743-1745` whitelist-accepts `user_role`. **Any authenticated user can send `user_role: "admin"`.**

Inert today only because the permission system is entirely non-functional: `TOOL_PERMISSION_MAP` (`crystal.py:659-664`) names **four tools that exist nowhere in CrystalOS**, so `_build_filtered_tool_list` has never filtered anything for any role. `editor` unlocks nothing; `admin` unlocks exactly one thing (real contact PII, `tools.py:2039`), currently unreachable. Three role vocabularies disagree: `editor` missing from the whitelist; `analyst` present there but absent from `ROLE_PERMISSIONS`, yielding an **empty** permission set — worse than `viewer`.

⚠️ **The obvious fix activates the vulnerability.** Repairing the permission map without simultaneously fixing the body spread turns an inert defect into a live escalation. Priya's plan therefore stages the capability audit *in front of* the plumbing change, and **explicitly forbids** flipping role passthrough and re-enabling the legacy path in the same release — together they reactivate ReAct against a filter that has never filtered.

### Two live bugs in every turn

- `crystal.py:1659` wraps a **synchronous** `def` (`turn_publisher.py:112`) in `asyncio.create_task` → `TypeError` on **every turn**, swallowed by a bare `except Exception: pass`. Telemetry works by accident.
- The EVALS scorer defect (§4 #1) is live now: `SKILL.md:82-84` tells the model to use `[]` for `action_proposals`, which fails a must-pass gate → retry → possible discard of the whole turn. **Priya's best explanation for why skill-path proposals are rare.** A hypothesis, but cheap to verify and high-value if true.

### Platform-wide, outside Crystal

- **`ui/dropdown-menu.tsx:45` has no background.** `bg-popover` / `text-popover-foreground` are **absent from the shipped bundle despite being used** — `--color-popover` is undefined, so Tailwind v4 never generates the utility. `:62` already hardcodes `bg-white` as a workaround.
- **`<Button variant="secondary">` is at 2.00:1** (needs 4.5:1) — `bg-secondary` resolves to brand teal `#00647c` while `text-secondary-foreground` doesn't exist, so the label inherits `#2c2f31`. A **fifth** measured WCAG failure, platform-wide.
- Both are fixed by the same 6-line token shim this migration needs anyway.
- `animate-in` / `fade-in-0` / `zoom-in-95` don't exist in this app (no `tw-animate-css`) yet are used in **6 shipped `ui/` files**.
- `dark:` compiles to the OS media query with `.dark` count = 0 — registry `dark:*` classes would fire for OS-dark users on a light-only app. 1-line fix.
- `--color-ring: #2a4bd9` is brand blue **frozen at build time**.
- `components.json:5` is `"tsx": false` and would emit `.jsx` into a strict-TS app.
- `MemoryManager`'s entire L2/org-memory half has **zero production callers** (9 methods verified); `crystalos/docs/GAPS_STATUS.md:47` admits the integration sprint never happened.
- `feedback.py` has a **second** reason it is uncallable: no Express proxy route, and upstream requires `X-Internal-Key`.
- `ActionProposalType` is **21** members, not 25 (corrected twice during planning).

---

## 9. One genuinely lucky finding

**Crystal's lack of token streaming is a WCAG *asset*.** A single atomic `answer` frame is the ideal shape for `aria-live="polite"` — an incrementally streaming answer is notoriously hard to announce without either spamming or truncating. It makes the WCAG 4.1.3 fix **45 LOC**.

Which also retires the last reason anyone might want token deltas. Priya's independent conclusion stands: streaming prose would be actively wrong, because the answer text isn't final at generation time — three separate code paths discard already-generated prose (`openrouter.py:445-457`, `skill_runtime.py:181`, `crystal.py:1352-1359`).

---

## 10. Provenance and confidence

Everything here is **static analysis**. No test suite was run, no database queried, no browser opened. Two exceptions where measurement did occur, and they are the most trustworthy findings in the plan: Sam's `npm view` cadence data, and Theo's cross-resolution of 12 live registry payloads against the shipped CSS bundle.

The pod corrected itself **~30 times** across two rounds — including four errors in my own evidence documents, two load-bearing objections retracted by their own authors, and three of my reported figures (test LOC, `ActionProposalType` count, `CRYSTAL_STREAMING` as precedent). That rate is a reliability signal: **confident-and-wrong is the failure mode here.** Verify any single finding before acting on it alone.

Schema claims derive from migration *files*, not observed database state. Per project history, migrations have not always been run against the live DB — real schema may differ.
