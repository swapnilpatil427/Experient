# Frontend Migration Plan — Crystal → assistant-ui

> **Author:** Nadia Okonjo, Staff Frontend Engineer, Conversational Interfaces
> **Mandate:** `TEAM.md` §1 · **Charter:** `README.md` · **Date:** 2026-08-04
> **Status:** Plan. No production code written.
> **Supersedes:** the *verdict* in `ASSESSMENT_CRYSTAL_UI.md` §8. Its §1 component map, §3 runtime
> decision, §4 churn evidence, and §6 cost model are carried forward as facts and re-derived here
> under the styled-first default.
> **Library facts verified against:** `@assistant-ui/react@0.15.4` (npm registry, fetched 2026-08-04)
> and the doc pages cited inline.

---

## 0. Corrections I am absorbing, plus one of my own

**(a) Theo is right; my headless-only reason is retracted.** `ASSESSMENT_CRYSTAL_UI.md:312-314`
argued the styled set was unusable because registry components ship Tailwind brand utilities rather
than the `var(--color-primary)` cascade. Verified against the repo: `app/src/index.css:1-2` is

```css
@import "tailwindcss";
@import "./styles/theme.css";
```

`theme.css` is imported **unlayered**, after Tailwind. Tailwind's `@theme` block lands in
`@layer theme` (cascade depth 2); an unlayered `:root` wins (depth 1). So
`.bg-primary { background-color: var(--color-primary) }` resolves through
`--color-primary: var(--brand-primary)` and **does** respond to `applyBrandTheme()`.
`app/CLAUDE.md` ("Brand Theme System", the `❌ Wrong — static, ignores runtime brand` example) and
`app/src/lib/brandTheme.ts:9-10` are wrong and should be corrected in the same PR as G0.
**Styled components are the default attempt from here.** §1 states the joint answer with Theo.

**(b) My `t()` count was a substring false positive.** Verified with a word-boundary grep:
`CrystalPanel.tsx` has **12** `t()` calls, at `:939, 1198, 1204, 1255, 1391, 1409, 1421, 1424, 1429,
1437, 1442, 1488`. `CURRENT_STATE.md` §6 was right; `ASSESSMENT_CRYSTAL_UI.md:19` was wrong. My
`:233, 398, 653, 1037, 1108` entries were `ge|t('`, `spli|t('`, `setInpu|t('` and friends.

**(c) A third correction, mine, found while checking (b).** `ASSESSMENT_CRYSTAL_UI.md:128` and `:194`
say `react-textarea-autosize` "is already a lib dep." That is ambiguous and half-wrong.
It is **not** in `app/package.json` — verified, zero hits. It *is* a direct dependency of
`@assistant-ui/react@0.15.4` (`react-textarea-autosize@^8.5.9`, confirmed from the registry
manifest). So it arrives free **only on the migration path**; on the no-dependency path it is a new
install. This cuts in the library's favour and I had it recorded loosely.

**(d) A fourth, load-bearing correction to the shared evidence base.** `CURRENT_STATE.md` §7 and my
own §2e state that `crystal-spin` is defined at `:2303-2334` and consumed at `:2783`. It is consumed
at **three** sites: `:2345` (the orb rotation), `:2464` (the per-step spinner), and `:2783`
(`ActionProposalCard`'s Apply spinner). The first two are inside the component that defines the
keyframe; only `:2783` is cross-component. That makes the bug narrower and the fix cheaper than
described, but it also means **the two in-component consumers will keep working after a bad
refactor and mask the broken one**. See §6.2.

**(e) One deletion the evidence base treats as a port.** `submitQuery`'s legacy non-stream path
(`:584-640`, 57 LOC) is **statically dead**, not a third live transport. `CRYSTAL_STREAMING` is a
hardcoded `true` at `:29`, the branch is the `else` at `:602`, and Priya independently reached the
same conclusion (`ASSESSMENT_CRYSTALOS.md` §4.1 row 1). `ASSESSMENT_CRYSTAL_UI.md:52` classified it
`hand-build`. It is `delete`, in G2, −57 LOC.

---

## 1. Styled vs headless — the single answer, agreed with Theo

**Answer: styled-first, adopted per component, gated on one measurement. Headless only where the
measurement fails or the structure has no analogue.**

Theo's finding removes my objection entirely, and there is a *second* enabler neither of us costed:
`app/CLAUDE.md` ("shadcn Variable Bridge") says `theme.css` already maps `--color-*` onto shadcn's
`--primary` / `--border` / `--muted` / `--card`. assistant-ui's registry components are shadcn-shaped
and consume exactly those tokens. So a registry copy inherits Xperiq's brand through **two
independent paths** — the Tailwind-utility → `var(--color-primary)` cascade, and the shadcn bridge —
without a single edit. That is a stronger position than "themeable"; it is "themed by default."

### 1.1 What the reversal does *not* dissolve

Three residual objections survive, and they are about pixels and governance, not brandability:

| # | Residual objection | Status |
|---|---|---|
| 1 | Crystal's chrome uses `color-mix(in srgb, var(--color-primary) N%, transparent)` (`:1142, 1160, 1162, 1170, 1172, 1189, 1246, 1367, 1464-1465, 1600, 2367, 2378-2379`) and live two-stop gradients `var(--color-primary)`→`var(--color-tertiary)` (`:1178, 1506, 1646, 2088`). Tailwind's `bg-primary/10` compiles to a different mixing space. **Same brand, different pixels.** | **Measure it (G0 Leg D).** Not a blocker; a fidelity budget |
| 2 | Registry copies land in `src/components/assistant-ui/*`, which is **outside** `crystalIdentityTokens.test.ts:19-23`. They cannot fail the brand-token guard — which means they *escape* it. | **Governance regression. Fix in G0** by globbing the guard over `src/components/assistant-ui/**` and `src/components/crystal/**` (§6.2) |
| 3 | Registry copies ship hardcoded English. | Real, and *improvable*: they are our files, so `t()` applies. Crystal is at 12 `t()` calls today (§0b); the copies are the first chance in two years to add strings correctly rather than relocate debt |

### 1.2 The adoption rule (this is the thing Theo and I are jointly signing)

Adopt the **styled** registry component when all three hold, measured not asserted:

1. `applyBrandTheme({ primary: '#e63946' })` propagates into the component with **≤10 edited lines**
   in the copied file.
2. The screenshot diff against today's panel is confined to spacing/typography/radius — no brand
   colour, no gradient, no glass treatment regression.
3. The component's structure is a chat-generic structure (viewport, composer, user bubble, markdown,
   suggestion row), not a Crystal-specific one.

Drop to **headless primitives** otherwise, and record the failing CSS property in
`ASSESSMENT_XPERIQ_UI.md`'s cross-correction log. Five components fail rule 3 *a priori* and I am
not going to pretend otherwise:

- **the docked panel shell** (`:1123-1165`) — `AssistantModalPrimitive` is a popover; Crystal is a
  non-modal panel sized off `--sidebar-width`. No primitive, no styled component. Ours.
- **the scope/context strip** (`:1244-1310`) — `context-display` models *model* context, not survey
  scope.
- **`CrystalThinkingBubble`** (`:2218-2540`) — §2.3.
- **`CitedText` / `InlineCitation`** (`:1740-1870`) — `sources` models URL sources; Crystal's are
  `[uuid]` markers joined against an out-of-band map injected by a different service
  (`backend/src/routes/experience.ts:782`).
- **`ActionProposalCard`** (`:2642-2799`) — the confirm-card is a safety boundary with a bespoke
  "What will happen" preview. Styled `tool-fallback` is the wrong shell.

**Everything else attempts styled first.** That is 9 of the 14 non-`keep` UI regions.

---

## 2. Migration order — the component map re-derived, and the execution sequence

### 2.1 Destination legend (changed from `ASSESSMENT_CRYSTAL_UI.md` §1)

| Code | Meaning |
|---|---|
| `styled` | registry CLI copy into `src/components/assistant-ui/`, brand-pass + `t()`-pass applied |
| `primitive` | headless primitive, our styling survives via `asChild` |
| `part` | custom message-part component (`TextMessagePartComponent` or a `data-*` DataMessagePart) |
| `tool-ui` | `ToolCallMessagePartComponent` on a toolkit entry |
| `gen-ui` | registered in the generative-UI allowlist (§3) |
| `adapter` | logic relocates into the runtime layer; no UI |
| `port` | moves file; **styling hooks and/or part wiring change, render body byte-identical** |
| `keep` | byte-identical, moves file only |
| `delete` | removed |

### 2.2 The map — 41 regions, re-derived

**Module scope (1–165)**

| Region | Lines | LOC | Destination | Phase | What changes |
|---|---|---|---|---|---|
| Header + imports | 1–29 | 29 | `port` | G2 | Import list only. `CRYSTAL_STREAMING` const at `:29` deleted with §0e |
| Type block (`Message`, `CrystalVerbatim`, `CrystalCitation`, `CitationMap`, `StreamingPhase`, props) | 31–86 | 56 | `port` | G1/G2 | `Message.id` becomes server-minted (G1); `+synthetic?: true` for `note()` (§3 of adapter, 1 line). Citation types **byte-identical** — they become the store's payload type |
| `ENUMERATION_PATTERNS`, `DATA_OBJECT_EXCLUSIONS`, `classifyAsSupport` | 88–151 | 64 | `keep` | G2 | Nothing. Pure predicate |
| `SINGLE_PROMPTS`, `ALL_PROMPTS` | 153–165 | 13 | `styled` → `follow-up-suggestions` | G2 | Data survives byte-identical; consumption moves to the ExternalStore `suggestions` option |

**Inside `CrystalPanel()` (167–1540)**

| Region | Lines | LOC | Destination | Phase | What changes |
|---|---|---|---|---|---|
| State + derivations (`nps`, `responseCount`, `dynamicPrompts`, `isSupportMode`) | 167–270 | 104 | `port` | G2 | `useState<Message[]>` at **`:196` stays exactly as-is** — it is the ExternalStore. `isThinking` derives from runtime `isRunning`. ~15 lines touched |
| `submitQuery` — request body (15 non-OpenAI fields) | 271–385 | 115 | `keep` | G2 | **Byte-identical**, relocated inside `onNew` |
| `submitQuery` — SSE reader + 7-branch switch | 386–482 | 97 | `port` | G2 | `setStreamingState` (`:433, 435, 437`) → push onto a timeline accumulator. **`:419-431` citation retro-enrichment byte-identical** (§3.2). `:449` `documents` branch deleted when Priya emits gen-ui instead (§3.4) |
| `submitQuery` — REST fallback | 483–556 | 74 | `keep` | G2 | Byte-identical. `answerReceived` bookkeeping survives |
| `submitQuery` — error mapping (402/503/502) | 557–582 | 26 | `keep` | G2 | Byte-identical. Crystal's errors are chat *messages*, not runtime errors |
| `submitQuery` — legacy non-stream path | 584–640 | 57 | **`delete`** | G2 | §0e — statically dead |
| Auto-submit `initialQuery` | 646–656 | 11 | `keep` | G2 | Byte-identical. `openCrystal(query)` façade unchanged, all 50 call sites |
| Auto-scroll effect | 659–663 | 5 | **`delete`** | G2 | `ThreadPrimitive.Viewport` — and better: handles user-scrolled-up |
| Focus-on-open effect | 666–671 | 6 | **`delete`** | G2 | Composer autofocus |
| Reset-expanded effect | 674–676 | 3 | `keep` | G2 | Panel chrome |
| `handleMic` (Web Speech) | 678–703 | 26 | `primitive` → `adapters.dictation` | G3 | 26 → ~15 |
| `handlePin` | 705–707 | 3 | `keep` | G2 | Handler body byte-identical; `pinned` must reach `convertMessage` as metadata |
| `handleThumbsUp` / `handleThumbsDown` | 709–735 | 27 | `primitive` → `adapters.feedback` | G3 | UI state inherited; the per-citation `api.updateInsightFeedback(c.id)` fan-out (`:716, 730`) survives **byte-identical**. G1's `message_id` makes this a real per-message rating for the first time |
| Proposal state + `note()` | 737–752 | 16 | `port` | G2 | `note()` gains `synthetic: true` — **1 line** (§3.3) |
| **`executeAction`** — 18-branch dispatch, 12 REST calls, DataBus invalidation, funnel | 754–1021 | **268** | `keep` | G2 | **Byte-identical except two lines**: called from `addResult` not `onApply`; `setActionProposals(prev => prev.filter(...))` at `:1013` deleted. The largest block in the file is a pure move |
| `handleCreateTicket` | 1023–1089 | 67 | `port` | G1 | 1 line: `:1058`'s client-side "Crystal message ID" becomes the server `message_id` |
| `dismissAction` | 1091–1103 | 13 | `port` | G2 | ~3 lines: routes through `addResult({ dismissed: true })` |
| `handleSubmit` / `handleKeyDown` / `panelWidth` | 1105–1121 | 17 | `styled` → `composer` | G2 | Enter-vs-Shift+Enter is built in |
| Panel shell (`AnimatePresence`, left-edge shadow, fixed `motion.div`) | 1123–1165 | 43 | `keep` | G2 | Byte-identical. §1.2 — no analogue |
| Header (gem, title, badges, Clear, Expand, Close) | 1166–1242 | 77 | `port` | G2 | ~2 lines: Clear → runtime `setMessages([])` |
| Scope / context strip | 1244–1310 | 67 | `keep` | G2 | Byte-identical |
| Time-window quick-filter | 1312–1328 | 17 | `keep` | G2 | Byte-identical |
| Conversation container + message `.map()` + thinking/error/proposal slots | 1330–1381 | 52 | `styled` → `thread` | G2 | 52 → ~14. The four sibling slots at `:1360, 1363, 1368, 1383` become message parts |
| Support-mode escalation card | 1382–1412 | 31 | `keep` | G2 | Byte-identical |
| Support-mode thumbs (`api.submitDocFeedback`, keyed on `doc_key`) | 1414–1451 | 38 | `keep` | G2 | Byte-identical. `adapters.feedback` models **one** feedback path; this is a second, differently-keyed one and stays out of the adapter |
| Input bar (mic, autogrow textarea, Ask, hint) | 1456–1516 | 61 | `styled` → `composer` | G2 | 61 → ~12. Kills the manual `e.target.style.height`; `react-textarea-autosize` arrives with the library (§0c) |
| `ManualRunDialog` mount | 1518–1534 | 17 | `keep` | G2 | Byte-identical |
| JSX close | 1535–1540 | 6 | `port` | G2 | — |

**Sub-components (1543–2799)**

| Component | Lines | LOC | Destination | Phase | What changes |
|---|---|---|---|---|---|
| `EmptyState` | 1543–1583 | 41 | `styled` → `thread-welcome` + `follow-up-suggestions` | G2 | 41 → ~8 |
| `MiniCrystal` (conic gradients, keyframes) | 1586–1638 | 53 | `keep` | G2 | Byte-identical. Brand identity |
| `UserBubble` | 1641–1653 | 13 | `styled` → `user-message` | G2 | 13 → ~6 |
| `UUID_RE`, `FULL_UUID_RE`, `resolveId`, `enrichCitationsFromMap`, `buildCitationsFromAnswer`, `parseInlineCitations` | 1655–1728 | 74 | `adapter` | G2 | **Byte-identical**, moved into `convertMessage`'s module. Pure functions |
| `Link` import + `LAYER_COLORS` | 1730–1738 | 9 | `keep` | **G0** | Content byte-identical. **The test exclusion must be content-matched first** (§6.2) |
| `InlineCitation` (hover tooltip, layer badge, verbatim preview, nav) | 1740–1829 | 90 | `part` | G2 | Hand-rolled hover state (`:1746, 1769-1826`) *could* become shadcn `Tooltip` (already a dep) — **both-paths win, not migration-attributable.** Defer to G3 |
| `CitedText` (split-on-regex → superscripts) | 1831–1870 | 40 | `part` — custom `TextMessagePartComponent` | G2 | Must own text rendering; the built-in text part cannot see `[uuid]` markers. In G3 the same override runs over markdown text nodes |
| `SENTIMENT_DOT`, `insightNavPath`, `CitationStrategy`, `getCitationStrategy` | 1872–1904 | 33 | `keep` | G2 | Byte-identical |
| `VerbatimList` | 1906–1928 | 23 | `part` + `gen-ui` | G2/G3 | Byte-identical body; registered twice — as a citation sub-render and as an allowlisted gen-ui component (§3.3) |
| `SourcesFooter` (2 strategies, expand, per-source verbatim toggle) | 1930–2064 | 135 | `part` — `data-citations` | G2 | Body byte-identical; props arrive from a part instead of a parent |
| `CrystalBubble` | 2066–2189 | 124 | split: `styled` shell (`:2085-2102`, `:2121-2133`) + `keep` action row (`:2134-2185`) | G2 | Avatar/confidence/pinned chrome and the suggestion chip row go styled (~25 LOC out). `ActionBarPrimitive` gives Copy/Reload/Edit/Feedback; Crystal needs **Pin / Slack / Ticket**, which it does not model — those stay ours byte-identical |
| `TOOL_META` (13 tools) + `AccumulatedStep` | 2191–2217 | 27 | `port` | G3 | ~13 lines: `TOOL_META.label` → `t('crystal.tool.*')`, consuming the **already-dead locale keys at `en.ts:3947-3961`**. Requires Priya's machine-coded `thinking` frames (`ASSESSMENT_CRYSTALOS.md` §6.2) to be correct rather than cosmetic |
| **`CrystalThinkingBubble`** | 2218–2540 | **323** | `port` + `adapter` | G2 | The one real rewire — §2.3 |
| Removal comments | 2542–2546 | 5 | `delete` | G2 | — |
| `ReportProposalIntent` + `resolveReportProposalAction` | 2547–2582 | 36 | `keep` | G2 | Byte-identical. Already unit-tested |
| `ACTION_TYPE_ICONS`, `PRIORITY_COLORS`, `PARAM_LABELS`, `humanizeParams` | 2584–2640 | 57 | `keep` | G2 | Byte-identical. `humanizeParams` is the "nothing mutates unseen" preview — product-critical |
| **`ActionProposalCard`** | 2642–2799 | **158** | `tool-ui` | G2 | ~8 lines: prop trio `{isExecuting, onApply, onDismiss}` → `{status, addResult}` via the shim; `:2783`'s spinner reads `crystal-spin` from the stylesheet, not a sibling's inline `<style>`. **Render body byte-identical** |

**Tally under styled-first:** 6 `styled`, 2 `primitive`, 5 `part`, 1 `tool-ui`, 2 `adapter`,
14 `keep`, 10 `port`, 6 `delete`. Compare `ASSESSMENT_CRYSTAL_UI.md:112` — 8 / 4 / 1 / 2 / 26.
**The 26 "hand-build" entries resolve to 14 byte-identical `keep`, 10 `port` with a named line count,
and 2 `adapter` relocations.** Sum of touched lines across the 10 ports: ~60. That is the honest
size of "rewriting the differentiated surface" — it was never 1,450 LOC of rewrite, and I said it
loosely in `ASSESSMENT_CRYSTAL_UI.md:171`.

### 2.3 `CrystalThinkingBubble` — still not `ChainOfThought`, and here is exactly what moves

My three reasons from `ASSESSMENT_CRYSTAL_UI.md:104-106` stand and I am not softening them:
the grouping trigger does not fire (Crystal's `thinking`/`observation` have no args, no result, no
`toolCallId` — `crystal.py:1903-1947`); nothing in the 323 LOC is inherited; and it moves
architecturally from a **sibling** of the message list (`:1360-1362`) to **parts of an in-flight
assistant message**.

But "rewrite of the seam" was imprecise. Concretely:

| Sub-region | Lines | LOC | Fate |
|---|---|---|---|
| Step accumulation: same-tool coalescing (`:2256-2269`), duplicate-`synthesizing` guard (`:2279-2281`), `startedAt`/`completedAt` stamping (`:2214-2215`) | 2250–2295 | 46 | **Relocates into the adapter**, unchanged logic. It stops being a `useEffect` on a prop and becomes a reducer over SSE events |
| 100 ms elapsed ticker | 2243–2247 | 5 | Stays in the component (it is view state, not message state) |
| The 8 `@keyframes` | 2303–2334 | 32 | **Extracted to `crystal.keyframes.css` in G0** (§6.2) |
| Orb, aurora header (`:2373-2377`), per-step rows, shimmer text (`:2485-2491`), progress bar (`:2518-2535`) | 2336–2537 | ~200 | **Byte-identical** |

So: 46 LOC relocate, 32 extract, 5 stay, ~200 are untouched, and the props signature changes from
`{ state, isThinking }` to reading a `data-timeline` part. The `t()` pass on `TOOL_META` is G3, not
G2, because it depends on Priya's machine-coded frames.

### 2.4 Execution sequence

Read this as the build order. "Proof" is what Sam gates on.

**G0 — Spike + two permanent fixes (4 days)**

| # | Move | Depends on | Proof |
|---|---|---|---|
| 0.1 | Content-match `crystalIdentityTokens.test.ts:42-44`; glob `CRYSTAL_IDENTITY_FILES` over `src/components/crystal/**` + `src/components/assistant-ui/**` | — | Suite green; then artificially reflow `CrystalPanel.tsx` by +100 lines and confirm still green |
| 0.2 | Extract the 8 keyframes to `crystal.keyframes.css`, imported once from `index.css` | 0.1 | `ActionProposalCard`'s Apply spinner animates with **no** thinking bubble mounted this session — the assertion that does not exist today |
| 0.3 | Spike branch, all four legs (§7) | 0.1, 0.2 | §7 pass/fail |
| 0.4 | Correct `app/CLAUDE.md` "Brand Theme System" + `brandTheme.ts:9-10` | Theo's Leg D data | Doc PR merged |

**G1 — Contract adoption (3 FE days; blocked on Priya)**

| # | Move | Depends on | Proof |
|---|---|---|---|
| 1.1 | Adopt server `message_id`/`turn_id` at the five `crypto.randomUUID()` sites (`:453, 471, 537, 550, 566`), client uuid retained as fallback for locally-constructed messages | Priya §1 | Contract test: every assistant message in a recorded SSE fixture carries a server id |
| 1.2 | `handleCreateTicket:1058` uses the server id | 1.1 | Ticket payload contains a `turn_id` joinable to `crystal_turn_events` |
| 1.3 | `recordProposalOutcome` keys on server `proposal_id` not the title slug (`:762, 1096`) | Priya §5(a) | Emit two identical proposals for one org; two rows, not one overwrite |
| 1.4 | Wire `POST /api/crystal/feedback` from the thumbs handlers | 1.1 | The endpoint that has had zero callers since it shipped gets one |

**G2 — Parity on the new chassis, flag-off (15 days)**

Order matters; each row unblocks the next.

| # | Move | Depends on | Proof |
|---|---|---|---|
| 2.1 | `auiCompat.ts` — the isolation layer, written **first** (§5) | — | Guard test: zero `unstable_` matches in `app/src/**` outside `auiCompat.ts` |
| 2.2 | `convertMessage.ts` (pure) + citation helpers moved in | 2.1 | Unit tests, incl. the retro-enrichment identity assertion (§3.2) |
| 2.3 | `crystalRuntime.ts` — `useExternalStoreRuntime` config | 2.2 | `isRunning` / `onNew` / `setMessages` round-trip |
| 2.4 | `useCrystalStream.ts` — SSE reader moved out of the component, timeline accumulator added | 2.3 | Sam's pinned SSE characterisation tests pass unchanged |
| 2.5 | `AssistantRuntimeProvider` in `AppShell`, ordered outside `CrystalPanelProvider`; builder-route suppression preserved (`AppShell.tsx:43, 64-65, 101-103`) | 2.3 | Survey-builder route still shows `XperiqCopilot` and not Crystal |
| 2.6 | `CrystalThread.tsx` — `ThreadPrimitive` composition; delete `:659-663`, `:666-671` | 2.5 | Scroll-up-then-stream does not yank the viewport (a **new** behaviour) |
| 2.7 | Registry copies: `thread`, `user-message`, `composer`, `thread-welcome`, `follow-up-suggestions`; brand + `t()` pass | 2.6, Leg D | Per-component: ≤10 brand edits, screenshot diff within budget, guard test green |
| 2.8 | `CitedText` as `TextMessagePartComponent`; `SourcesFooter` as `data-citations` | 2.2 | Citation superscripts and both `getCitationStrategy` branches render identically |
| 2.9 | `ThinkingTimeline` reads `data-timeline`; 46 LOC of accumulation relocated | 2.4 | Phase-timeline characterisation test: identical step list, identical coalescing, identical elapsed |
| 2.10 | `ActionProposalCard` as `tool-ui` + the props shim; `executeAction` called from `addResult` | 2.2, 1.3 | **All ~30 existing execution tests pass with only their interaction line touched.** Funnel-integrity gate green |
| 2.11 | `onCancel` + `AbortController` (net-new — zero `abort` matches in the file today) | 2.3 | Cancel mid-stream leaves no orphan message and records no outcome |
| 2.12 | Delete the legacy non-stream path (§0e) and the `CRYSTAL_STREAMING` const | 2.4 | Suite green; −57 LOC |

**G3 — Gains, flag-on for internal orgs (12 days)**

| # | Move | Depends on | Proof |
|---|---|---|---|
| 3.1 | **Generative UI** — allowlist, Zod schemas, Recharts components, provenance gate, fallback (§3) | 2.8, Priya's `generative_ui` emit | One CrystalOS-emitted spec per allowlisted component renders; unknown name renders Fallback; ungrounded node dropped |
| 3.2 | Markdown — `markdown-text` registry copy, `CitedText` override over markdown text nodes | 2.8, 2.7 | `**bold**`, lists, tables render; `[uuid]` superscripts still land inside formatted prose |
| 3.3 | A11y — Theo owns the spec; I own the wiring. Primitives give composer/thread semantics; panel `role="region"`+`aria-label`, Escape, focus restore, `role="log" aria-live="polite"`, `role="status"` on the timeline, `prefers-reduced-motion` over `crystal.keyframes.css` remain ours | 2.6 | Theo's audit; axe clean; the 4 measured contrast failures (`:1494`, `:2498`, `:2506`, `:1465`) fixed |
| 3.4 | Persistence — `RemoteThreadListAdapter` over `crystal_threads` v2, thread switcher in the header | Priya §4 | Reload restores the thread; `AppShell.tsx:56-58`'s force-close is reconsidered (**product decision — flagged**) |
| 3.5 | `adapters.dictation` + `adapters.feedback` | 3.3 | Mic parity; thumbs hit `/api/crystal/feedback` |
| 3.6 | `TOOL_META` → `t()`, consuming `en.ts:3947-3961` | Priya §6.2 | Timeline announces localised tool names, not `"Fetching get survey overview…"` |

**G4 — Cutover (4 days)**

| # | Move | Depends on | Proof |
|---|---|---|---|
| 4.1 | Flag default-on, org by org | G3 gates | Funnel accept-rate unchanged across the switch (Sam's gate) |
| 4.2 | Delete the old panel path | 4.1, two weeks clean | −~120 LOC of dual-path code |
| 4.3 | Delete `IrisChat.tsx` (316) + `pages/insights/ConversationView.tsx` (363) | — (**doable today**, zero importers) | −679 LOC |
| 4.4 | `XperiqCopilot` convergence | **Theo's ruling** | Out of my scope; see §8.3 |

---

## 3. The adapter, concretely

Runtime pattern: **`ExternalStoreRuntime`.** Unchanged from `ASSESSMENT_CRYSTAL_UI.md` §3, and
`README.md:114` records it as settled. `LocalRuntime` is disqualified by two behaviours, and the
whole point of this section is to show they survive.

### 3.1 The shape

```ts
// app/src/components/crystal/runtime/parts.ts
import type { CrystalCitation, InsightDocument, ActionProposal } from '…';
import type { GenerativeUISpec } from './genui/types';

/** The union convertMessage may emit. Deliberately narrow. */
export type CrystalPart =
  | { type: 'text';            text: string }
  | { type: 'data-citations';  data: { citations: CrystalCitation[]; strategy: 'survey' | 'portfolio' } }
  | { type: 'data-timeline';   data: { steps: AccumulatedStep[]; phase: StreamingPhase['phase'] | null } }
  | { type: 'generative-ui';   spec: GenerativeUISpec }                       // §4 — native part
  | { type: 'tool-call';       toolCallId: string; toolName: 'propose_action';
                               args: ActionProposal; status: ToolStatus; result?: ProposalOutcome };

/** Metadata, not parts: values that decorate the message rather than occupy space in it. */
export interface CrystalMessageMeta {
  confidence?: number;          // → ConfidenceChip, :2101
  pinned?: boolean;             // :705-707
  thumbs?: 'up' | 'down' | null;// :709-735
  turnId?: string;              // G1
  origin?: 'stream' | 'note' | 'error' | 'fallback';
}
```

**Why `confidence` is metadata and `citations` is a part.** `confidence` renders as a chip in the
message *header* (`:2101`) and never affects layout order; `citations` renders as a footer block with
its own two display strategies (`getCitationStrategy`, `:1872-1904`) and must be orderable relative
to gen-ui nodes and the suggestion row. Parts are for things with a position; metadata is for things
that decorate. `documents` was going to be a `data-documents` part in
`ASSESSMENT_CRYSTAL_UI.md:151`; it is now a gen-ui node and that part is deleted (§3.4).

```ts
// app/src/components/crystal/runtime/convertMessage.ts
// PURE. No hooks, no refs, no closures over mutable state. This is load-bearing — see §3.2.
export function convertMessage(m: Message): CrystalThreadMessage {
  if (m.role === 'user') {
    return { role: 'user', id: m.id, createdAt: m.timestamp,
             content: [{ type: 'text', text: m.content }] };
  }

  const parts: CrystalPart[] = [];

  // 1. Timeline first — an in-flight message renders its reasoning above its prose.
  if (m.timeline?.steps.length) {
    parts.push({ type: 'data-timeline', data: { steps: m.timeline.steps, phase: m.timeline.phase } });
  }

  // 2. Prose. CitedText owns rendering; the [uuid] markers were already stripped at :447.
  if (m.content) parts.push({ type: 'text', text: m.content });

  // 3. Agent-specified rich content. Validated + provenance-gated here (§4.4),
  //    because assistant-ui explicitly does not constrain agent-supplied props.
  if (m.generativeUi) {
    const gated = gateSpec(m.generativeUi, m.citations ?? []);
    if (gated) parts.push({ type: 'generative-ui', spec: gated });
  }

  // 4. Citations footer.
  if (m.citations?.length) {
    parts.push({ type: 'data-citations',
                 data: { citations: m.citations, strategy: m.isAll ? 'portfolio' : 'survey' } });
  }

  // 5. Proposals as tool-call parts — one per proposal, server-minted ids (§8.2).
  for (const p of m.proposals ?? []) {
    parts.push({
      type: 'tool-call', toolCallId: p.id, toolName: 'propose_action', args: p,
      status: p.outcome ? 'complete' : 'requires-action',
      result: p.outcome,
    });
  }

  return {
    role: 'assistant',
    id: m.id,
    createdAt: m.timestamp,
    content: parts,
    ...compat.writeMeta({ confidence: m.confidence, pinned: m.pinned,
                          thumbs: m.thumbs, turnId: m.turnId, origin: m.origin ?? 'stream' }),
  };
}
```

```ts
// app/src/components/crystal/runtime/crystalRuntime.ts
const runtime = useExternalStoreRuntime({
  messages,                                        // the SAME useState array from :196
  setMessages,                                     // still ours
  isRunning,                                        // replaces the isThinking flag
  convertMessage: compat.makeConverter(convertMessage),
  onNew:            submitQuery,                    // :271-640, body byte-identical
  onCancel:         abortRef.current?.abort,        // net-new, :2.11
  onAddToolResult:  ({ toolCallId, result }) =>     // Apply / Dismiss land here
                      result.dismissed
                        ? dismissAction(toolCallId)
                        : executeAction(proposalById(toolCallId)),
  suggestions:      dynamicPrompts.map(prompt => ({ prompt })),
  adapters:       { feedback: crystalFeedbackAdapter,   // G3
                    dictation: crystalDictationAdapter } ,
  ...compat.capabilities({ edit: false, reload: false, copy: true, cancel: true, branch: false }),
});
```

Two notes on that config. **`branch: false` is deliberate and permanent** — Priya's
`ASSESSMENT_CRYSTALOS.md` §1.6 is right that every turn re-uploads its own grounding corpus
(`:344-351`, server-merged at `experience.ts:720-732`), so two branches of one question were grounded
differently and are not comparable alternatives. Suppressing the affordance is more honest than
building it. **`edit`/`reload` flip to `true` in G3, not G1** — G1 gives them the ids they need, but
the composer wiring is G3 work and Priya prices regenerate at ~1 FE day once ids exist.

### 3.2 Behaviour 1 — `citation_context` retro-enriching message N−1

This is the behaviour that disqualifies `LocalRuntime`, and it survives **because the store is still
ours**. The handler at `:419-431` does not change one character:

```ts
setMessages((prev) => {
  if (!prev.length) return prev;
  const last = prev[prev.length - 1];
  if (last.role !== 'crystal' || !last.citations?.length) return prev;
  return [...prev.slice(0, -1),
          { ...last, citations: enrichCitationsFromMap(last.citations, merged) }];
});
```

`convertMessage` is a pure projection, so on the next render the already-rendered message N−1 is
re-projected with enriched citations and the `data-citations` part updates in place. There is no
"reach into the library's store" problem because the library does not own the store.

**The one thing that can break it, and the permanent test that catches it.**
`unstable_createMessageConverter` memoises the projection **by message identity**. `:427-430` returns
a *new* object (`{ ...last, citations: … }`), so identity changes and the memo correctly invalidates.
If anyone ever "optimises" `:429` into an in-place mutation — `last.citations = enrich(...)` — the
array element identity is unchanged, the memo holds, and **retro-enrichment silently stops with no
error**. That is exactly the class of silent regression Sam was added for.

Required permanent assertions (G0 Leg B, then G2 regression):
1. Fire `answer` then `citation_context`; assert message N−1's `InlineCitation` gains
   `headline`/`layer`/`survey_title` from the map.
2. Spy on the converter; assert its call count **increments** after the `citation_context` frame.
3. Assert `Object.isFrozen`-style immutability at the seam, or equivalently that the pre-enrichment
   `Message` object is not `===` the post-enrichment one.

Assertion 2 is the one nobody writes and the one that matters.

### 3.3 Behaviour 2 — `note()` appending with no run in flight

`note()` at `:748-752` is called from seven sites inside `executeAction`
(`:824, 853, 869, 889, 897, 965, 1017`) — i.e. from a click handler, after the turn ended.
`LocalRuntime` has no sanctioned path for this. `ExternalStoreRuntime` does: it is an append to our
own array, and `isRunning` is a separate signal we control.

One line changes:

```ts
const note = useCallback((content: string) => {
  setMessages(prev => [...prev, {
    id: crypto.randomUUID(), role: 'crystal' as const, content,
    timestamp: new Date(), origin: 'note',          // ← the one added field
  }]);
}, []);
```

`origin: 'note'` matters because `convertMessage` must emit a **bare text part** for these — no
`data-timeline` part, no `tool-call` part. Without the marker, a note appended while a *subsequent*
turn is in flight can be grouped with the in-flight message's parts and render its reasoning
timeline. `origin` also gives the a11y layer what it needs in G3: a note is a `role="status"`
announcement (the user just did something), whereas a streamed answer is a `role="log"` entry.

Same mechanism covers the error branch at `:468-476` (`origin: 'error'`) and the REST-fallback
messages at `:537, 550, 566` (`origin: 'fallback'`). Three behaviours, one field.

### 3.4 Carrying `citations`, `suggestions`, `documents`, `confidence`

| Payload | Today | Under the adapter | Why |
|---|---|---|---|
| `citations` | `Message.citations` → `CitedText` (`:2105`) + `SourcesFooter` (`:2119`) | **two consumers, one source**: the `text` part's custom renderer reads them from the message via `useAuiState`, and the `data-citations` part renders the footer | The markers are *inside* prose; the footer is *after* it. Splitting them into two parts would duplicate the array |
| `suggestions` | `Message.suggestions` → chip row (`:2121-2133`) | ExternalStore `suggestions` option + the `follow-up-suggestions` registry component | Genuine styled win; `onFollowUp` still calls `submitQuery` |
| `documents` | `Message.documents` → `InsightDocumentCard` (`:2109-2114`) — **unreachable, no server emitter** | **deleted as a part.** Becomes a `ReportCard` node in the gen-ui allowlist (§4.5) | One channel instead of two. Kills `ASSESSMENT_CRYSTAL_UI.md:151`'s 15-LOC `data-documents` part |
| `confidence` | `Message.confidence` → `ConfidenceChip` (`:2101`) | **metadata**, via `compat.writeMeta` | Header decoration, no layout position (§3.1) |
| `pinned` / `thumbs` | `Message.pinned` / `.thumbs` (`:705-735`) | **metadata** | Same reason. `pinned` also drives the `:2095-2100` chip |

**`confidence`, `pinned`, and `thumbs` are the entire reason `auiCompat.ts` exists.** Message metadata
lives on `unstable_state` / `unstable_annotations` / `unstable_data` — three `unstable_` field names
for one concept, and the concept is "decorations on a message." §5 confines the choice to one file.

---

## 4. Generative UI — the primary goal

### 4.1 What assistant-ui actually ships (verified 2026-08-04)

From `/docs/tools/generative-ui.md`, verbatim: *"assistant-ui resolves each name against a
**consumer-provided allowlist** and renders the result"* and *"any name not in it throws a typed
`GenerativeUIRenderError` (no implicit fallback)."*

The spec shape, verbatim:

```ts
type GenerativeUINode =
  | string
  | { component: string; props?: Record<string, unknown>;
      children?: GenerativeUINode[]; key?: string };

type GenerativeUISpec = { root: GenerativeUINode | GenerativeUINode[] };
```

**The decisive finding, and it changes the plan's shape.** The same doc, under *"3. Have the agent
emit UI"*, states: ***"ExternalStore / manual messages** attach a native part"*, with this example:

```ts
{
  type: "generative-ui",
  spec: { root: { component: "Card", props: { title: "Welcome" },
                  children: [{ component: "Button", props: { label: "Get started" } }] } },
}
```

That is Crystal's exact runtime. **We do not need `JSONGenerativeUI`, `defineGenerativeComponents`,
the `"use generative"` compiler directive, `streamProperties`, or model-driven tool calling.**
Those belong to the *tool-driven* flavour, where the model calls a frontend `present` / `promptUser`
tool and emits flat `{ $type, ...props }` nodes resolved against a `GenerativeUILibrary`
(`/docs/api-reference/generative-ui/json-generative-ui.md`,
`/docs/api-reference/generative-ui/components.md`). Crystal is on the **manual-part flavour**:
`convertMessage` attaches the part, `MessagePrimitive.GenerativeUI` resolves it against our
allowlist. Zero build-tooling change, zero model-in-the-loop change, and it composes with Priya's
"no model-chosen tool calls" ruling (`ASSESSMENT_CRYSTALOS.md` §3.2) rather than fighting it.

`streamProperties` is therefore also moot for us — it partially renders props while a tool call's
arguments stream, and Crystal's spec arrives whole inside the terminal `answer` frame. Deliberate
non-goal.

**Wiring — Pattern 2, not Pattern 1.** The docs give three integration patterns. Pattern 1 is

```tsx
<MessagePrimitive.Parts components={{ generativeUI: { components: allowlist, Fallback } }} />
```

— which sits on the `components` **prop** that **v0.14 replaced with children render functions**
across `MessagePrimitive.Parts` (`ASSESSMENT_CRYSTAL_UI.md:276`). It still works, deprecated. We use
Pattern 2, the render-function form, because it is the direction of travel:

```tsx
case "generative-ui":
  return <MessagePrimitive.GenerativeUI components={allowlist} Fallback={GenUiFallback} />;
```

That is a concrete churn avoidance, decided from the migration history rather than guessed.

**And the honest gap:** *"assistant-ui ships no charting."* Confirmed — nothing in the 19 direct
dependencies of `@assistant-ui/react@0.15.4` is a charting library, and the tokens page
(`/docs/api-reference/generative-ui/tokens.md`) enumerates alert tones, alignments, button variants,
text sizes and font weights — layout vocabulary, not marks. **We supply every chart.** What
assistant-ui contributes is the resolver, the part type, the typed error, and the security boundary.
Call it ~80 LOC of value. The registry is ours.

### 4.2 The allowlist

Recharts `^3.8.1` is already in `app/package.json:59`, already chunked as `vendor-charts`
(`app/CLAUDE.md`, "Build Chunking"), and already used in-panel-adjacent at
`InvestigationDrawer.tsx:119-131` (`ResponsiveContainer` + `LineChart` + `Line`,
`isAnimationActive={false}`, `role="img"` + `aria-label` on the wrapper at `:115-116` — **that a11y
pattern is the template for every chart in this registry**).

```ts
// app/src/components/crystal/genui/registry.ts
export const CRYSTAL_GENUI_ALLOWLIST = {
  // ── Layout (assistant-ui token vocabulary) ────────────────────────────────
  Stack, Row, Callout,          // Callout tone: 'info' | 'success' | 'warning' | 'danger'

  // ── Charts (Recharts) ────────────────────────────────────────────────────
  NPSTrend,            // LineChart      — the MiniNPSChart replacement, done right (§4.6)
  Sparkline,           // LineChart      — compact; mirrors InvestigationDrawer.tsx:119-131
  MetricBar,           // BarChart       — CSAT/CES/NPS by segment
  TopicDistribution,   // BarChart (h)   — topic volume, LAYER_COLORS-aware
  SentimentSplit,      // stacked Bar    — positive/neutral/negative

  // ── Insight content (reuses shipped components) ───────────────────────────
  MetricTile,          // big number + delta; mirrors InvestigationDrawer.tsx:138-148
  InsightCard,         // headline + LayerBadge + ConfidenceChip, from insights/shared.tsx
  VerbatimList,        // EXISTING, CrystalPanel.tsx:1906-1928, byte-identical
  ReportCard,          // EXISTING InsightDocumentCard.tsx (130 LOC) — first live emitter (§4.5)
  ComparisonTable,     // ≤4 cols × ≤8 rows
} as const;
```

**11 components. Deliberately small, and deliberately not extensible by the model.** Every one either
wraps Recharts with `isAnimationActive={false}` and a `role="img"` + `aria-label`, or is a component
already shipping in the app. Nothing here is new visual design, which is what keeps the
G3 estimate credible.

Three things are **not** on the allowlist and I want the exclusions on the record:

- **No `Button` / `Input` / `Select` / form controls.** assistant-ui's actions API
  (`/docs/api-reference/generative-ui/actions.md`) supports `$action` payloads dispatched through an
  `ActionRegistry`, including human-in-the-loop actions that resume execution. That is a **second
  mutation path into the app, chosen by the model, bypassing the 18-branch `executeAction` switch
  and the `humanizeParams` "What will happen" preview.** Root `CLAUDE.md`: *"the frontend renders
  proposals as confirm-cards and only mutates on explicit user confirm."* Generative UI is for
  **display**; `ActionProposalCard` remains the sole mutation gate. We pass
  `emptyActionRegistry`-equivalent behaviour (no handlers) so a stray `$action` is a logged no-op,
  never a write.
- **No raw `Image` / `Link` with agent-supplied `href`/`src`.** The docs are explicit:
  *"It does not constrain the `props` supplied by agents… validate `href` and `src` values."*
  `InsightCard` and `ReportCard` build their own in-app links from ids via `insightNavPath`
  (`:1872-1904`) and `toPath(ROUTES.…)`. No agent-supplied URL is ever rendered as an href.
- **No `PieChart`.** A product/design call, not an engineering one, but I am making it: Crystal's
  answers are comparative and trend-shaped. Flagging it as reversible.

### 4.3 Zod property schemas

assistant-ui does not validate props. We do, at the `convertMessage` boundary (§3.1, `gateSpec`),
before a node ever reaches React. `zod@^4.4.3` arrives as a direct dependency of
`@assistant-ui/react@0.15.4` — no new install.

```ts
// app/src/components/crystal/genui/schemas.ts
import { z } from 'zod';

/** Every data-bearing node must declare its provenance. This field is ours, not assistant-ui's. */
const Provenance = z.object({
  source: z.array(z.string().uuid()).min(1),   // citation ids that already arrived in citation_context
});

const Point = z.object({ label: z.string().max(40), value: z.number().finite() });

export const GENUI_SCHEMAS = {
  NPSTrend: Provenance.extend({
    points: z.array(Point).min(2).max(24),
    title:  z.string().max(80).optional(),
    band:   z.enum(['none', 'target']).default('none'),
  }),
  Sparkline: Provenance.extend({ points: z.array(Point).min(2).max(60) }),
  MetricBar: Provenance.extend({
    series: z.array(Point).min(1).max(12),
    metric: z.enum(['nps', 'csat', 'ces', 'count']),
  }),
  TopicDistribution: Provenance.extend({
    topics: z.array(z.object({
      topic_id: z.string().uuid(), name: z.string().max(60), count: z.number().int().nonnegative(),
      layer: z.enum(['descriptive', 'diagnostic', 'predictive', 'prescriptive']).optional(),
    })).min(1).max(15),
  }),
  SentimentSplit: Provenance.extend({
    rows: z.array(z.object({ label: z.string().max(40),
      positive: z.number().int().nonnegative(),
      neutral:  z.number().int().nonnegative(),
      negative: z.number().int().nonnegative() })).min(1).max(10),
  }),
  MetricTile:  Provenance.extend({ label: z.string().max(40), value: z.number(),
                                   delta: z.number().optional(), unit: z.string().max(8).optional() }),
  InsightCard: Provenance.extend({ insight_id: z.string().uuid(), headline: z.string().max(160),
                                   layer: z.enum(['descriptive','diagnostic','predictive','prescriptive']),
                                   trust: z.number().min(0).max(100).optional() }),
  VerbatimList: Provenance.extend({ verbatims: z.array(z.object({
                                     quote: z.string().max(400),
                                     sentiment: z.enum(['positive','neutral','negative']).optional(),
                                   })).min(1).max(8) }),
  ReportCard:  Provenance.extend({ run_id: z.string().uuid() }),   // §4.5 — id only, we fetch
  ComparisonTable: Provenance.extend({
    columns: z.array(z.string().max(30)).min(2).max(4),
    rows:    z.array(z.array(z.union([z.string().max(60), z.number()]))).min(1).max(8),
  }),
  Callout: z.object({ tone: z.enum(['info','success','warning','danger']),
                      text: z.string().max(300) }),               // no Provenance — chrome, not data
  Stack:   z.object({ gap: z.enum(['sm','md','lg']).default('md') }),
  Row:     z.object({ align: z.enum(['start','center','end']).default('start'),
                      justify: z.enum(['start','center','end','between']).default('start') }),
} as const;
```

Note `Callout`, `Stack` and `Row` reuse assistant-ui's own token vocabulary verbatim
(`/docs/api-reference/generative-ui/tokens.md`: alert tones `info|success|warning|danger`, aligns
`start|center|end`, justifies `start|center|end|between`, gaps `sm|md|lg`). Matching their tokens
costs nothing and makes any future switch to the tool-driven flavour a no-op for those three.

### 4.4 The provenance gate — the design decision that makes this different from MiniNPSChart

Zod proves a node is *well-formed*. It cannot prove the numbers are real. So:

```ts
// gateSpec — runs inside convertMessage, before the part is emitted
function gateSpec(spec: GenerativeUISpec, citations: CrystalCitation[]): GenerativeUISpec | null {
  const known = new Set(citations.map(c => c.id));         // ids from citation_context
  return mapNodes(spec, node => {
    const schema = GENUI_SCHEMAS[node.component];
    if (!schema) return dropped(node, 'unknown_component');
    const parsed = schema.safeParse(node.props ?? {});
    if (!parsed.success) return dropped(node, 'schema', parsed.error.issues[0]?.path);
    if ('source' in parsed.data) {
      const orphans = parsed.data.source.filter(id => !known.has(id));
      if (orphans.length) return dropped(node, 'ungrounded', orphans);   // ← the gate
    }
    return { ...node, props: parsed.data };
  });
}
```

**Rule: a data-bearing node renders only if every id in its `source` array already arrived in this
turn's `citation_context` map** (`citationMapRef.current`, populated at `:419-422`). A chart Crystal
invented cannot render. A chart grounded in insights it actually cited can. `dropped()` replaces the
node with a `Callout tone="info"` carrying the reason, and emits
`crystal.genui.dropped{reason, component}` telemetry.

This costs one non-standard prop (`source`) on the wire and it is the only thing standing between
"generative UI" and "MiniNPSChart with a JSON schema."

### 4.5 Error-fallback strategy — three layers, no throw ever reaches the panel

| Layer | Trigger | Behaviour |
|---|---|---|
| 1. Allowlist miss | spec names a component we do not have | `Fallback` prop **always supplied**, so `GenerativeUIRenderError` never surfaces in production. Renders a muted chip; logs `crystal.genui.unknown_component{name}`. **In dev, rethrow** — a missing registry entry must be loud for the engineer and silent for the customer |
| 2. Schema / provenance fail | Zod fail, or an ungrounded `source` id | node replaced in `convertMessage` by a `Callout`. **Never render partial data** — a chart with 2 of 6 points is worse than no chart |
| 3. Render throw | Recharts blows up on a degenerate domain (single point, all-zero, NaN) | per-node `<GenUiBoundary>` inside the registry wrapper. One bad chart cannot blank the answer. `InvestigationDrawer.tsx:101-112` already models the single-point degenerate case with a text fallback — reuse that exact pattern |

The **unregistered-name failure mode is shared with the `tool-ui` registry**: a tool-renderer keyed by
name also fails silently on an unregistered name. Priya flagged this at
`ASSESSMENT_CRYSTALOS.md` §5(b) ("A migration makes this **worse** if unfixed"). Both registries get
the same Fallback + telemetry treatment, and both derive their key set from her `StrEnum`.

### 4.6 `MiniNPSChart` — what I think actually happened, and what changes

The comments at `:2542-2545`, verbatim:

```
// Removed: StreamingBubble, ThinkingBubble — replaced by CrystalThinkingBubble
// Removed: MiniNPSChart (was hardcoded fake data tied to buildDemoResponse)
// Removed: buildDemoResponse (was returning identical hardcoded text for any unrecognized query)
// Crystal now calls the real /api/insights/:surveyId/crystal endpoint.
```

**My read: `MiniNPSChart` was not removed because charts were unwanted, and not because Recharts was
unavailable. It was removed because it had no grounded data source, and deleting it was correct.**

The evidence is in the adjacent lines. `MiniNPSChart` was scaffolding for `buildDemoResponse`, which
returned *identical hardcoded text for any query*. All three were deleted in one pass, at the moment
Crystal was wired to the real endpoint (`:2545`). The chart was part of the mock, and the mock went.

The reason it never came back is the interesting part, and it is the same reason
`render_hint: 'document'` never shipped: **there was no channel on the wire by which the server could
send grounded, chart-shaped data.** The `answer` frame has four keys —
`answer`, `citations`, `insight_refs`, `suggestions` (`crystal.py:1968-1974`, `:1983-1989`,
`main.py:1804`). Rich content had no slot. So the only chart that could exist was a fake one, and
`documents[]` shipped its client half (`:416, 449, 459, 2109-2114`) against a server half that was
never written. **Two abandoned attempts, one root cause: a render path with no grounded emitter.**
`README.md:123-127` asks whether the cause was product judgment rather than engineering difficulty.
It was neither — it was a **missing contract**, which is the same diagnosis Priya reached about
identity from a different direction.

What the plan does differently, in three specifics:

1. **A contract slot exists.** `generative_ui` on the terminal `answer` frame (§8.2). Rich content
   stops being something the client hopes for.
2. **The provenance gate makes fake data unrenderable, structurally** (§4.4). `MiniNPSChart` could
   not have passed it — it had no `source`, because it had no source.
3. **`ReportCard` takes `run_id`, not content.** The `ReportCard` schema (§4.3) accepts a UUID and
   the component fetches; it does not accept an `executive_summary` string from the model. That
   subsumes `render_hint:'document'` / `InsightDocumentCard` into the one channel — Priya's §5(c)
   asked for a joint decision and this is my answer: **emit it, as a gen-ui node, not as
   `documents[]`.** It deletes the unreachable `Message.documents` branch, deletes the planned
   `data-documents` part (`ASSESSMENT_CRYSTAL_UI.md:151`, −15 LOC), and gives a 130-LOC shipped
   component its first live emitter.

**The honest residual risk.** If Crystal's answers are 2–5 sentences by skill design
(`skills/crystal-analyst/SKILL.md:32`, `max_tokens=1200` at `crystalos/lib/models.py:411`), the model
may rarely choose to emit a spec at all, and we will have built a registry nothing fills. **Mitigation
is a product decision, not mine to make** — but the cheap version is that `crystal-analyst`'s prompt
*requires* a `NPSTrend` or `MetricTile` node whenever the answer cites a metric insight, rather than
offering the channel optionally. **Flagged for the missing PM.** This is the single biggest threat to
G3.1's value and it is not a technical threat.

---

## 5. Churn isolation

### 5.1 The surface being confined

190 of the ~655 adapter lines in `ASSESSMENT_CRYSTAL_UI.md` §2b sat on `unstable_` APIs, which
`/docs/runtimes/concepts/stability.md` says *"may change in any release including patch releases."*
Under this plan the list is:

| `unstable_` API | Needed for | Confined behind |
|---|---|---|
| `unstable_createMessageConverter` / `unstable_convertExternalMessages` / `useExternalMessageConverter` | the whole conversion layer | `compat.makeConverter()` |
| `unstable_capabilities` | suppressing edit/reload/branch Crystal cannot honour | `compat.capabilities()` |
| `unstable_state` / `unstable_annotations` / `unstable_data` | `confidence`, `pinned`, `thumbs`, `turnId` (§3.4) | `compat.writeMeta()` / `compat.readMeta()` |
| `unstable_assistantMessageId` / `unstable_threadId` / `unstable_parentId` / `unstable_getMessage` | G1 ids, G3 persistence | `compat.runIds()` |
| `unstable_humanToolNames` | the `type: "human"` proposal mapping | `compat.humanToolNames()` |
| `unstable_onBranchChange` | **not used** — `branch: false` is permanent (§3.1) | — |

### 5.2 The layer

```ts
// app/src/components/crystal/runtime/auiCompat.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONLY FILE IN app/src ALLOWED TO IMPORT AN `unstable_` SYMBOL FROM
// @assistant-ui/react, OR TO NAME AN assistant-ui METADATA FIELD.
// A patch-release rename is a change to this file and nothing else.
// Enforced by: eslint no-restricted-imports zone + genUiCompat.guard.test.ts
// Upgrade owner: see MIGRATION_TEST_PLAN.md (Sam).
// ─────────────────────────────────────────────────────────────────────────────
export interface CrystalRuntimeCompat {
  /** Wrap a pure Message → CrystalThreadMessage projection. Return value is opaque. */
  makeConverter<M>(fn: (m: M) => CrystalThreadMessage): ConverterHandle<M>;
  /** Our capability names, not theirs. */
  capabilities(caps: CrystalCapabilities): Record<string, unknown>;
  /** Our metadata keys, not theirs. */
  writeMeta(meta: CrystalMessageMeta): Record<string, unknown>;
  readMeta<K extends keyof CrystalMessageMeta>(msg: unknown, key: K): CrystalMessageMeta[K];
  /** Normalised run identity, whatever they call it this month. */
  runIds(opts: unknown): { messageId?: string; threadId?: string; parentId?: string };
  humanToolNames(names: readonly string[]): Record<string, unknown>;
}
export const compat: CrystalRuntimeCompat = /* the only unstable_ call sites */;
```

Everything else in `app/src/components/crystal/**` imports `compat` and the **stable** primitives
(`ThreadPrimitive`, `MessagePrimitive`, `ComposerPrimitive`, `ActionBarPrimitive`,
`MessagePrimitive.GenerativeUI`). Estimated size: **~120 LOC**, and it is written **first** in G2
(step 2.1), before any component moves. Writing it last is how isolation layers fail to exist.

### 5.3 Enforcement — three mechanisms, all already precedented in this repo

1. **ESLint `no-restricted-imports` zone**: `@assistant-ui/react` importable only from
   `src/components/crystal/runtime/auiCompat.ts` and `src/components/assistant-ui/**` (registry
   copies legitimately import stable primitives).
2. **A grep guard test**, `src/__tests__/components/crystal/auiCompat.guard.test.ts`: walk
   `app/src/**/*.tsx?`, assert zero `/\bunstable_/` matches outside `auiCompat.ts`. This is
   *literally the same technique* as `crystalIdentityTokens.test.ts:48-70` — `readFileSync`, split
   lines, regex, collect offenders — so it is a proven pattern here, not a novel one. **And unlike
   that test, it must be content-matched from day one, never line-ranged** (§6.2).
3. **A pinned exact version** (`"@assistant-ui/react": "0.15.4"`, no caret) plus a
   `vendor-assistant-ui` manual chunk in the Vite config (`app/CLAUDE.md`, "Build Chunking" —
   `zod`, `zustand`, `nanoid`, `radix-ui`, `assistant-cloud` all arrive with it; without a chunk they
   land in `vendor-react`).

**What I owe Sam, and what I need from Sam.** I own the boundary and mechanisms 1–2. Sam owns the
runbook: cadence, who bumps, and how a breaking change is detected before production. Two things I
need in it, because they come from my §4b reading of the four migration guides:

- **The upgrade smoke set is 13 integration points**, not the whole suite: 5 `part`s, 1 `tool-ui`,
  the gen-ui allowlist wiring, and ~6 primitive compositions. Three of four past migrations
  rearchitected either the message-part rendering seam (v0.11, v0.14) or the state-access API (v0.12,
  v0.15) — the only two surfaces this plan is built on.
- **Codemods cover renames and not rearchitectures.** `npx assistant-ui@latest upgrade` handled the
  v0.14 `components`-prop deprecation and the v0.15 accessor→property change; it did **not** cover
  the `AuiProvider` `value`→`extends` restructure, the `ToolsState.tools`→`toolUIs` shape change, or
  the `useAui({parent})` removal. Budget **1–2 engineer-days per minor**, and assume the codemod
  clears the diff but not the review.

---

## 6. The monolith split

### 6.1 Target structure

2,799 lines → 24 files. Line counts are post-migration, so they include the additions from §9.

```
app/src/components/crystal/
  CrystalPanel.tsx                shell + header + scope strip + time filter          ~420
  crystal.keyframes.css           all 9 keyframes, incl. crystal-spin                  ~40   ← G0
  EmptyState.tsx   MiniCrystal.tsx                                                    ~100
  runtime/
    auiCompat.ts                  ONLY unstable_ importer (§5)                        ~120
    crystalRuntime.ts             useExternalStoreRuntime config                      ~110
    convertMessage.ts             pure projection + the 6 citation helpers            ~215
    useCrystalStream.ts           submitQuery + SSE reader + REST fallback            ~330
    parts.ts                      CrystalPart union + registration                     ~70
  thread/
    CrystalThread.tsx             ThreadPrimitive composition + GroupedParts cases     ~90
    ThinkingTimeline.tsx          CrystalThinkingBubble + TOOL_META                   ~300
    CrystalMessage.tsx            assistant shell + Pin/Slack/Ticket/thumbs row       ~150
  citations/
    CitedText.tsx  InlineCitation.tsx  SourcesFooter.tsx  VerbatimList.tsx
    citationStrategy.ts  LAYER_COLORS.ts                                              ~410
  proposals/
    ActionProposalCard.tsx  proposalLabels.ts  useProposalExecution.ts
    reportProposalIntent.ts                                                           ~570
  genui/
    registry.ts  schemas.ts  gateSpec.ts  GenUiFallback.tsx  GenUiBoundary.tsx        ~220
    charts/   NPSTrend Sparkline MetricBar TopicDistribution SentimentSplit           ~180
    cards/    MetricTile InsightCard ComparisonTable Callout Stack Row                ~140
  support/
    classifySupport.ts  SupportEscalation.tsx  SupportFeedback.tsx                    ~110
app/src/components/assistant-ui/  registry CLI copies — ours, brand- and t()-passed
  thread.tsx  markdown-text.tsx  user-message.tsx  follow-up-suggestions.tsx
  thread-welcome.tsx                                                                  ~430
```

The seams are already clean — every sub-component in `CrystalPanel.tsx` is a top-level function with
explicit props — so the split is mechanical, ~40 LOC of barrel/prop plumbing. **Two landmines make
it non-mechanical if done in the wrong order.**

### 6.2 Landmine 1 — `crystalIdentityTokens.test.ts:43`

```ts
const EXCLUDED_LINE_RANGES: Record<string, Array<[number, number]>> = {
  'src/components/CrystalPanel.tsx': [[1733, 1738]],
};
```

This false-positives on **any** reflow. The test's own comment says so (`:35-41`): the range was
already re-pointed once, from `[1668, 1673]` to `[1733, 1738]`, after the tag-report merge added
content above it. `LAYER_COLORS` legitimately keeps `#2a4bd9` at `:1737`.

Under this plan it fails **twice over**, and the second failure is the dangerous one:

1. The migration reflows `CrystalPanel.tsx`, `LAYER_COLORS` leaves `[1733, 1738]`, and the suite goes
   red on a line that is *supposed* to keep its hex. Noisy but obvious.
2. The split moves `LAYER_COLORS` to `citations/LAYER_COLORS.ts`, which is **not in
   `CRYSTAL_IDENTITY_FILES` (`:19-23`)**. The exclusion becomes dead, the suite goes green — and the
   entire new `crystal/` tree plus every registry copy in `assistant-ui/` is now **outside the brand
   guard**. The test passes and stops testing anything. **That is a silent loss of a governance
   control, and it happens by default.**

**Fix, in G0, before any file moves (~25 LOC):** replace `EXCLUDED_LINE_RANGES` with a content match
on the `LAYER_COLORS` declaration block (find the declaration, exclude to its closing brace), and
replace `CRYSTAL_IDENTITY_FILES` with a glob over `src/components/CrystalPanel.tsx` (while it exists),
`src/components/crystal/**/*.{ts,tsx}`, `src/components/assistant-ui/**/*.tsx`,
`src/components/workflow-builder/AskCrystalFab.tsx`, and
`src/components/dashboard/widgets/CrystalNarrativeWidget.tsx`.

Verification that the fix works: artificially insert 100 blank lines above `LAYER_COLORS` and confirm
the suite stays green. If it goes red, the content match is wrong.

### 6.3 Landmine 2 — the `crystal-spin` cross-dependency

`crystal-spin` is defined at `:2304`, inside `CrystalThinkingBubble`'s inline `<style>` block
(`:2303-2334`), and consumed at three sites:

| Site | Consumer | In the defining component? |
|---|---|---|
| `:2345` | the thinking orb rotation | yes |
| `:2464` | the per-step spinner | yes |
| **`:2783`** | **`ActionProposalCard`'s Apply spinner** | **no** |

So the Apply spinner only animates if a `CrystalThinkingBubble` has mounted at least once this
session. That is the shipped bug. **The refactor hazard is worse than the bug**: after any
restructuring of the thinking bubble, `:2345` and `:2464` keep working — they move with their
`<style>` — while `:2783` silently stops. Two working consumers mask the broken third, and
`CrystalPanel.test.tsx` has **zero** hits for `ThinkingBubble` (`CURRENT_STATE.md` §7), so nothing
catches it.

**Fix, in G0, step 0.2:** extract all 8 keyframes to `crystal.keyframes.css`, import once from
`index.css`, delete the inline `<style>` (−32 LOC). Do this **before** step 2.9 touches the timeline,
not as part of it.

**The assertion Sam needs, and it does not exist today:** render `ActionProposalCard` with
`isExecuting=true` and **no** thinking bubble mounted, and assert the spinner's computed
`animation-name` resolves to `crystal-spin`. That test fails on `main` right now. It should be written
as a **failing** test in G0 and turned green by 0.2 — which is also the cleanest possible proof that
0.2 fixed a real bug rather than moved code.

---

## 7. G0 spike specification

**Duration: 4 working days, one engineer.** Throwaway branch (`spike/aui-g0`), ~400 LOC discarded,
plus two permanent fixes (0.1, 0.2) that merge regardless of outcome. Acceptance criteria below are
mine; Sam owns turning them into the gate and owns any criterion I have left ambiguous.

### Leg A — unmodified `CrystalThinkingBubble` + `ActionProposalCard` inside `ThreadPrimitive`

**Do:** stand up `useExternalStoreRuntime` over a hand-written fixture array; render
`ThreadPrimitive.Viewport` + `ThreadPrimitive.Messages`; register `ActionProposalCard` as a
`ToolCallMessagePartComponent` behind the props shim; render `CrystalThinkingBubble` from a
`data-timeline` part.

**PASS** requires all of:
- `git diff --stat` shows **zero changed lines** inside `:2218-2540` and `:2642-2799`, other than the
  `<style>` removal from 0.2 and the props-signature line. Adaptation happens in the shim, not the
  component.
- All 8 keyframes animate, including `crystal-spin` at `:2783` **with no thinking bubble mounted**.
- Step coalescing (`:2256-2269`), the duplicate-`synthesizing` guard (`:2279-2281`), and the 100 ms
  elapsed ticker (`:2243-2247`) behave identically against a recorded SSE fixture.
- `humanizeParams`' "What will happen" toggle and the `create_case` chips render unchanged.

**FAIL** if either component's render body must change, or if the shim exceeds **60 LOC**.

### Leg B — citation retro-enrichment survives `convertMessage`

**Do:** replay a fixture stream that delivers `answer` **then** `citation_context` (the reverse of
production order, which is the harder case and the one `:423-431` exists for).

**PASS** requires all of:
1. Message N−1's `InlineCitation` gains `headline`, `layer`, and `survey_title` from the map.
2. The converter spy's call count **increments** after the `citation_context` frame — proving the
   memo invalidated, not that the DOM happened to be right.
3. `:419-431` is byte-identical to `main`.
4. The pre- and post-enrichment `Message` objects are not `===`.

**FAIL** if any of the four fails, or if making it work requires reaching into runtime-owned state.
Criterion 2 is the real test; 1 can pass accidentally.

### Leg C — one CrystalOS-emitted `generative-ui` spec renders an NPS chart

**Do:** Priya emits (or we fixture, if her side is not ready — Leg C must not block on G1) a terminal
`answer` frame carrying:

```json
{ "type": "answer", "answer": "NPS fell 8 points over the last six checkpoints [<uuid>].",
  "citations": [{ "id": "<uuid>" }],
  "generative_ui": { "root": {
      "component": "NPSTrend",
      "props": { "title": "NPS · last 6 checkpoints", "source": ["<uuid>"],
                 "points": [{"label":"#9","value":31},{"label":"#10","value":29},
                            {"label":"#11","value":27},{"label":"#12","value":25},
                            {"label":"#13","value":24},{"label":"#14","value":23}] } } } }
```

**PASS** requires all four:
1. A Recharts `LineChart` renders 6 points inside the assistant message, below the prose and above
   the sources footer, brand-coloured via `var(--color-primary)`, with `role="img"` and a populated
   `aria-label` (the `InvestigationDrawer.tsx:115-116` pattern).
2. Changing `"component"` to `"NpsTrend"` renders `GenUiFallback`, and **no
   `GenerativeUIRenderError` escapes to the panel** in production mode.
3. Changing `source` to an id absent from `citation_context` **drops the node** and renders the
   `Callout` — the provenance gate demonstrably works.
4. `applyBrandTheme({ primary: '#e63946' })` recolours the chart stroke live.

**FAIL** if the part must be routed through a synthesized tool call, or if the `components` prop form
(Pattern 1) is the only wiring that works — Pattern 2 must work, or the churn story in §4.1 is wrong.

### Leg D — the styled-vs-headless measurement

**Do:** CLI-copy `thread`, `markdown-text`, `user-message`, `follow-up-suggestions`, `thread-welcome`.
For each, record: (i) copied LOC; (ii) lines requiring a brand edit; (iii) a screenshot diff against
today's panel at three states — empty, one answer with citations and a gen-ui chart, mid-thinking —
each captured twice, at default brand and at `applyBrandTheme({ primary: '#e63946' })`.

**Deliverable: a per-component table, not a verdict.** Adopt where the §1.2 rule holds
(≤10 brand-edited lines, diff confined to spacing/typography/radius); drop to headless otherwise and
record the failing CSS property.

**PASS** = the measurement exists and is reproducible. Leg D cannot "fail" — it can only return
"headless for component X," which is a legitimate result and the whole reason it is a measurement.
**Theo co-signs this table** (§8.1); a split verdict here is a planning defect, not a finding.

### Leg E — the estimate gate (added; Sam should hold me to it)

`crystalRuntime.ts` + `convertMessage.ts` + `auiCompat.ts`, at spike quality, must total
**≤ 370 LOC**. My G2 estimate of 15 days rests on that number.

- ≤ 370 → G2 proceeds as planned.
- 371–500 → G2 re-estimated before G1 starts.
- **> 500 → the phase plan is re-cut, full stop.** My §9 numbers are wrong by ≥40% and shipping on
  them would be dishonest.

`ASSESSMENT_CRYSTALOS.md` §7 set Priya's mind-changing bar at "under 300 LOC with the citation layer
and confirm-cards intact." I am raising it to 370 because her 300 predated generative UI and the
isolation layer being in scope. That is a scope change, not a moved goalpost, and she should say so
if she disagrees.

---

## 8. Cross-checks

### 8.1 With Theo — one styled-vs-headless answer

**We land on: styled-first, per-component, gated on Leg D's measurement (§1.2). Headless for the
five structurally-Crystal components named in §1.2.** My prior headless-only position is withdrawn;
his Tailwind-v4 finding is correct and I verified it independently against `index.css:1-2`.

Three things I owe him, and one I need back:

- **I owe:** the correction to `app/CLAUDE.md` ("Brand Theme System") and `brandTheme.ts:9-10` in G0
  step 0.4. Those docs are why I was wrong, and leaving them wrong will make the next engineer wrong.
- **I owe:** the `crystalIdentityTokens.test.ts` glob (§6.2). Registry copies escaping the brand guard
  is a design-system regression created by *my* recommendation, and it is mine to close.
- **I owe:** `t()` on every registry copy at copy time, in the same PR as the copy. Not a follow-up.
  With 12 `t()` calls in 2,799 lines today (§0b), "we'll localise later" has a two-year track record.
- **I need:** his a11y line-by-line for G3.3. `ASSESSMENT_CRYSTAL_UI.md:316` said the primitives'
  only documented commitment is *"Error — Error display with accessible alert role"*; `README.md:118`
  now records his source-verification that `ThreadViewport.tsx` and `MessageRoot.tsx` carry no
  `role`/`aria-*`/live region and the registry `thread.tsx` has no `aria-live` and no
  `prefers-reduced-motion` guard. So **~165 LOC of a11y is ours either way** and the migration does
  not deliver it. I have budgeted +80 in §9 for the wiring, which assumes his ~165 is split between
  the panel shell (his) and the thread/parts (mine). If that split is wrong, G3 moves.

And the fact I flagged to him in `ASSESSMENT_CRYSTAL_UI.md:318`, which the reversal does not touch:
`ExperientCopilot.tsx` has Escape-to-close (`:152`) and 3 `aria-*` attributes (`:282, 360, 601`) while
`CrystalPanel.tsx` has 1 (`:1765`) and no Escape handler. Same repo, same team, no library. **A
framework relocates a discipline gap; it does not close one.** Which is precisely why 0.4, the glob,
and copy-time `t()` are non-negotiable rather than nice-to-have.

### 8.2 With Priya — the emit contract, and proposals as tool-call parts

**I am reversing my §7 position: yes, proposals should become tool-call message parts.** My prior
"no" was an argument against **model-chosen** tool calls, and her §3.2 declines those for stronger
reasons than mine (they emit before the eval gate; they restore an LLM tool-selection turn; they break
`novu_connect/message_processor.py:130-174`, which has no user who can click). Her §3.3
counter-proposal — server-minted `proposal_id = uuid4()` instead of the title slug
(`crystal.py:964-966`), `turn_id`, a validated enum, and an `emitted` row written before the frame
ships — hands me exactly `{ id, args, status }` with **no model in the loop**. That is the shape
`ToolCallMessagePartComponent` consumes, obtained without buying model-chosen tool calling. She is
right and I was answering a different question.

Her §6.1 asks whether a client-side adapter can synthesize that part without fighting the runtime.
**Answer: yes — conditional on her item 8.**

- **If `action_proposals` folds into the terminal `answer` frame** (her §3.3, §6.1 option 1, ~0.5 d):
  clean. The proposals are fields on the same `Message` object, `convertMessage` emits them as
  `tool-call` parts of that message, and ordering is guaranteed. **I want the fold, and I will say so
  at synthesis.**
- **If proposals keep arriving on a separate, possibly-earlier event** (`crystal.py:1961-1965` before
  `:1968`): I must buffer them client-side until `answer` arrives (~20 LOC) or attach them to a
  placeholder message. Both work. Both re-introduce the ordering fragility she wants removed, and the
  buffer has a real failure mode: a stream that emits `action_proposals` and then dies before
  `answer` (which `:483-556` exists to handle) either drops the proposals or renders them orphaned.

**So: her option 1, and I am the "pending Nadia" in her appendix item 8. Unblocked — do it.**

Four asks, in priority order:

1. **`generative_ui` on the terminal `answer` frame** — shape exactly assistant-ui's
   `{ root: GenerativeUINode | GenerativeUINode[] }` (§4.1), plus a **required `source: string[]`
   prop on every data-bearing node**, carrying citation ids that already appeared in
   `citation_context`. Since assistant-ui explicitly does not validate agent props, `source` rides as
   an ordinary prop and I strip and enforce it in `gateSpec` (§4.4). Cost to her: ~1 day on top of
   item 8, because it is the same frame edit. **This is the single change that makes G3.1 possible,
   and it is the fix for both abandoned rich-content attempts** (§4.6).
2. **`answer.documents[]` → a `ReportCard` gen-ui node** carrying `run_id` only, not content
   (her §5(c) asked for a joint decision; this is my half). **Emit, don't delete.** It deletes my
   planned `data-documents` part, gives `InsightDocumentCard.tsx` (130 LOC) its first live emitter,
   and collapses two rich-content contracts into one. Her cost: ~0.5 d, unchanged.
3. **`ActionProposalType` as a CrystalOS `StrEnum`** (her §5(b)) — I generate both the TS union and
   the tool-name allowlist from it. Note the migration makes this **worse** if unfixed, exactly as she
   said: a tool-renderer registry keyed by name fails silently on an unregistered name, which is the
   same failure mode as my gen-ui allowlist (§4.5). Both get the same Fallback + telemetry.
4. **Machine-coded `thinking`/`observation` frames + `locale` on `CrystalInput`** (her §6.2). Without
   the first, G3.6's `t()` pass on `TOOL_META` is cosmetic and the `aria-live` region announces
   *"Fetching get survey overview…"*, which is worse than silence. Without the second, gen-ui node
   labels are English-only forever. Both are cheap **now** because the contract is already open.

**Two things I am explicitly *not* asking for:** token deltas (her §2 ruling is correct — and the
`ChatModelAdapter` single-result form makes it a non-requirement), and branching (§3.1 — her
grounding-corpus argument is the right reason to decline a free library feature).

### 8.3 Dependency on Theo's `XperiqCopilot` ruling

`ExperientCopilot.tsx` (616 LOC, own `ChatMessage` type at `:53-60`, own message state at `:117-128`,
own ⌘K at `:146-156`, globally suppressed by `AppShell.tsx:43, 64-65, 101-103`) is Theo's call and it
**bounds my scope**. Converged into this chassis it is roughly +6 days on G4 and it deletes a second
chat surface. Left alone, it permanently diverges and Xperiq maintains two chat chassis instead of
halving to one — which is most of the argument for migrating, unspent. **It should be decided before
G2 starts, not after G4.** My §9 numbers exclude it.

---

## 9. Phased plan

### 9.1 Per phase

| Gate | Days (FE) | Prerequisites | LOC delta | Rollback | Carried risk |
|---|---|---|---|---|---|
| **G0** Spike | **4** | Sam's characterisation tests for SSE branches, `citation_context` retro-enrichment, and the thinking timeline pinned first — those surfaces have **zero** test coverage today (`CURRENT_STATE.md` §7) | **+35 permanent** (token-guard glob +25, keyframes extraction +40/−30); ~400 discarded | `git branch -D spike/aui-g0`. 0.1/0.2/0.4 merge regardless — they are bug fixes | **The spike answers a question we have already committed to.** If Leg E returns >500 LOC we re-cut §9 rather than re-open the decision. Leg D returning "headless for all five" would make §1 wrong and move G2 by ~+3 days |
| **G1** Contract | **3** | Priya items 1 (5.5 d), 2 (1.5 d), 8 (0.5 d) | **+15** | Server ids are additive; the five `crypto.randomUUID()` fallbacks stay in place for one release | Sequenced behind ~7.5 server-days that produce **zero user-visible change**. Priya's own strongest self-criticism (`ASSESSMENT_CRYSTALOS.md` §7) is that this is how UI work slips a quarter. The flag makes G1 and G2 concurrent after day 3, which is the mitigation |
| **G2** Parity | **15** | G0 Legs A/B/E pass; G1 items 1.1/1.3; **Theo's `XperiqCopilot` ruling** | **+1,386** (authored +700, adopted registry +430, deleted −214, tests +470) | Flag off → old panel, zero user impact. Both panels mounted; `CrystalPanelProvider` chassis-agnostic so `openCrystal()`'s 50 call sites across 22 files never learn which is live | **The whole cost, none of the benefit.** 15 days for pixel parity. Two silent-failure modes: the `convertMessage` memo (§3.2) and the `crystal-spin` masking (§6.3) — both now have named assertions. **Funnel integrity through step 2.10 is the gate that matters**; `crystal_action_proposals` is the metric that feeds skill quality and its denominators are already wrong (Priya §5a) |
| **G3** Gains | **12** | G2 green for 2 weeks on internal orgs; Priya asks 1, 2, 4 | **+1,090** (gen-ui 300+180t, a11y 80+70t, persistence 220+180t, markdown finish 60) | Per-capability flags, not one flag. Charts, markdown, persistence, and a11y ship and roll back independently | **Ordering is an engineering guess — `TEAM.md:128` records that there is no PM and no user research.** My order is charts → markdown → a11y → persistence, on the reasoning that charts are the migration's stated justification and a11y is the only WCAG-compliance item. A PM could legitimately invert the first and third. **The bigger G3 risk is not technical:** if `crystal-analyst` rarely emits a spec, the registry is built and unfilled (§4.6). That is a prompt/product decision |
| **G4** Cutover | **4** | G3 gates; funnel accept-rate unchanged across the switch | **−380** (old dual-path −120, legacy non-stream −57, dead chat files −679, +476 reconciliation/plumbing) | Per-org flag flip, reversible until 4.2 deletes the old path. **After 4.2 the rollback is a revert, not a flag** — that is the point of no return and it should be stated in the runbook | Deleting the old panel removes the kill switch. Sam should hold 4.2 for two clean weeks after 4.1. 4.3 (679 LOC of dead chat code, zero importers) is unrelated to the migration and shippable today |

**Total FE: 38 working days ≈ 7.6 weeks, one engineer.** Plus ~10 CrystalOS/backend days (Priya) and
Sam's characterisation + gate work. **Excludes `XperiqCopilot`** (§8.3, ~+6 days).

### 9.2 The net LOC, re-derived under styled-first

**Deletions — 214, up from 104** (`ASSESSMENT_CRYSTAL_UI.md` §2a). Styled-first is why: I can now
delete chrome that headless-only forced me to keep.

| # | What | Lines |
|---|---|---|
| 1 | Input bar 61 → 12 (`composer` registry) | 49 |
| 2 | `EmptyState` 41 → 8 (`thread-welcome` + `follow-up-suggestions`) | 33 |
| 3 | Inline `<style>` keyframes `:2303-2334` → one stylesheet | 30 |
| 4 | `isThinking` state → runtime `isRunning` + optimistic-message bookkeeping | 15 |
| 5 | Suggestion chip row `:2121-2133` | 13 |
| 6 | `CrystalBubble` avatar/confidence/pinned chrome `:2085-2102` | 12 |
| 7 | `handleMic` 26 → 15 (`adapters.dictation`) | 11 |
| 8 | `Message` interface + 5 `crypto.randomUUID()`/timestamp sites | 10 |
| 9 | Thumbs UI state (API fan-out kept) | 10 |
| 10 | Message-list map + branches `:1344-1359` 16 → 8 | 8 |
| 11 | `UserBubble` 13 → 6 | 7 |
| 12 | Focus-on-open `:666-671` | 6 |
| 13 | Manual scroll effect `:659-663` | 5 |
| 14 | Removal comments `:2542-2546` | 5 |
| | **Deleted** | **214** |

Excluded on purpose: the legacy non-stream path (−57, §0e) and the 679 LOC of dead chat files —
both deletable today with no migration, so crediting them here would flatter the migration.
Also excluded: replacing the hand-rolled `InlineCitation` tooltip (`:1746, 1769-1826`) with the
shadcn `Tooltip` that is already a dependency — a both-paths win, ~25 LOC, and not the library's
to claim.

**Additions.** Split by maintenance profile, because "code we wrote" and "code we adopted" are not the
same liability.

*Authored — 1,115:*

| # | What | LOC |
|---|---|---|
| 1 | `convertMessage` (6 part kinds + metadata) | 130 |
| 2 | `useExternalStoreRuntime` config, 10 handlers | 90 |
| 3 | `submitQuery` → `onNew` restructure; timeline accumulator; retro-enrichment across the conversion boundary | 80 |
| 4 | Part / tool / gen-ui registration | 70 |
| 5 | `CrystalThinkingBubble` rewire (46 LOC relocated, not deleted) | 60 |
| 6 | Brand + `t()` pass over the registry copies | 60 |
| 7 | `ToolCallMessagePartComponent` props shim + `useInlineRender` | 45 |
| 8 | `onCancel` + `AbortController` (net-new; zero `abort` matches today) | 40 |
| 9 | Custom `TextMessagePartComponent` wrapping `CitedText` | 30 |
| 10 | `data-citations` part wrapper around `SourcesFooter` | 25 |
| 11 | `AssistantRuntimeProvider` wiring, provider ordering, builder-route suppression | 25 |
| 12 | Primitive restyling / `asChild` plumbing (**60 → 25 under styled-first**) | 25 |
| 13 | `auiCompat.ts` isolation layer (§5) | 120 |
| 14 | **Generative UI**: allowlist, Zod schemas, `gateSpec`, 5 Recharts components, 6 cards, Fallback, Boundary (§4) | 300 |
| 15 | `crystalIdentityTokens.test.ts` glob + content match (§6.2) | 15 |
| | **Authored** | **1,115** |

`data-documents` part: **0**, deleted by §4.5 (was 15).

*Adopted — ~430:* registry copies of `thread`, `markdown-text`, `user-message`,
`follow-up-suggestions`, `thread-welcome`. **These are estimates, and G0 Leg D replaces them with
measurements.** They are files in our repo, in our diffs, that we brand-pass and `t()`-pass — so they
are honestly "added" — but they carry an upstream shape we can re-sync against, which authored code
does not.

*Tests — 660 migration-attributable:*

| # | What | LOC |
|---|---|---|
| 1 | `convertMessage` unit tests (pure function — genuinely easier to test than what it replaces) | 200 |
| 2 | Gen-ui: allowlist coverage, Zod rejection, provenance-gate drop, Fallback, one snapshot per chart | 180 |
| 3 | 5 custom parts + 1 tool-ui | 120 |
| 4 | ~30 execution tests: Apply goes through `addResult`, so each needs its interaction line touched even where the assertion holds | 90 |
| 5 | `renderPanel` harness (`:238-250`) rewrapped in `AssistantRuntimeProvider`; `triggerProposals` (`:253-273`) drives `ComposerPrimitive.Input`. You cannot `vi.mock('@assistant-ui/react')` — the real runtime is required | 60 |
| 6 | `auiCompat` guard test (§5.3) | 10 |
| | **Tests** | **660** |

Plus ~260 LOC of characterisation tests (SSE branches, retro-enrichment, thinking timeline) that Sam
must pin **before** G0. Both-paths work — they should exist regardless — but they are on the critical
path, so they are named, not hidden.

```
Migration alone, styled-first:
  authored              1,115
  adopted (registry)      430
  tests                   660
  deleted                −214
  ─────────────────────────────
  NET                  +1,991      (prior, headless-only: +1,015)
```

### 9.3 Did the number move? Up, ~2×. Here is exactly why, and why that is not the whole story.

**Absolute: +1,015 → +1,991.** Three causes, and only one of them is the styled-first reversal:

1. **+300 authored / +180 tests: generative UI.** My prior accounting excluded it entirely, because
   it was not a goal. It is now a primary goal (`README.md:89`), and assistant-ui ships **no
   charting** (§4.1) — we supply every mark. This is **48% of the increase** and it is new
   capability, not migration overhead.
2. **+430 adopted: registry copies.** Headless-only meant zero copied files. Styled-first means we
   own ~430 LOC of someone else's component code. This is the honest price of the reversal and it is
   **44% of the increase.**
3. **+120: the isolation layer.** Previously described as a *risk* (§4a); now a mandated planning
   constraint (`README.md:90`), so it is a line item instead of a caveat.

Against those, styled-first **doubled the deletions** (104 → 214) and cut primitive-restyling from 60
to 25. It paid for about 145 LOC of its own cost.

**Equal-deliverable: the gap halved.** `ASSESSMENT_CRYSTAL_UI.md` §2e compared ≈+2,065 (library) vs
≈+750 (no-dep) for the same visible outcome — the library at 275% of the alternative. Re-derived:

| Work item | With assistant-ui, styled-first | Without |
|---|---|---|
| Base restructure | **+1,991** (§9.2 — markdown and gen-ui already inside) | **0** |
| Markdown | included in the base (registry `markdown-text` + the `CitedText`-over-AST override, which costs the same either way) | `react-markdown` + `remark-gfm`, ~**+120** |
| Generative UI | included in the base | registry, Zod, gate, Recharts components, Fallback, tests are **near-identical** — assistant-ui contributes only the resolver, the part type, and the typed error: **+480** |
| A11y | primitives give composer/thread semantics; panel dialog semantics, Escape, focus restore, `role="log"`, reduced-motion remain ours: **+80** | **+110** |
| Persistence | `RemoteThreadListAdapter` + our endpoints + thread-list UI: **+220** | wire `GET /api/insights/:surveyId/crystal/history` (`backend/src/routes/insights.ts:1492`) and the two zero-caller client methods (`api.ts:2232-2245`): **+160 FE / +60 BE** |
| Monolith split | **+40** | **+40** |
| Tests for a11y + persistence | **+250** | **+250** |
| | **≈ +2,581** | **≈ +1,220** |

**Direction: the migration got more expensive in absolute terms and materially cheaper in relative
terms — from 275% of the no-dependency path to ~212%.** Two things moved it: styled-first deletes
twice the chrome headless-only could, and generative UI — which is now half the deliverable — is a
cost assistant-ui *shares* rather than one it saves, because the library ships no charting and the
Recharts components are ours either way.

**Both figures are real and neither is opposition.** The plan spends ~2,580 LOC and 38 FE days to buy
a chassis whose generic parts stop being ours to maintain, generative UI on a spec protocol we did not
design, and a churn-insulated boundary. A hand-built path reaches roughly the same screens for ~1,220
LOC and keeps every line of the chat chassis on our roadmap forever. The decision to pay the
difference was made above my pay grade and I am not re-arguing it (`TEAM.md` house rule 1) — but
`README.md`'s framing that the assessment "was never asked to value enabling what doesn't exist yet"
now has a number attached, and the number is **~1,360 LOC and ~4 engineer-weeks**. That is the price
of the option. It should be stated in those terms to whoever signs it.

### 9.4 Open items that genuinely need a product decision

`TEAM.md:128` asks members to flag these rather than resolve them by default. Four:

1. **G3 ordering.** charts / markdown / a11y / persistence. Mine is engineering-reasoned, not
   user-reasoned. A11y is the only one with a compliance argument (four measured WCAG AA contrast
   failures at `:1494` 2.24:1, `:2498` 3.01:1, `:2506` ~3.6:1, `:1465` 1.23:1, plus WCAG 4.1.3).
2. **Whether `crystal-analyst` is *required* to emit a `generative_ui` node when it cites a metric
   insight, or merely permitted to** (§4.6). This determines whether G3.1 has users. It is a prompt
   and product call, not an engineering one, and it is the biggest single threat to the migration's
   stated justification.
3. **`AppShell.tsx:56-58` force-closes the panel on every navigation.** Thread persistence is
   partly pointless while that holds. Changing it is a UX decision about whether Crystal is
   page-scoped or session-scoped.
4. **`XperiqCopilot`** (§8.3). Theo rules; it changes G4 by ~6 days and it changes whether this
   migration halves the chat surface under maintenance or doubles it.
