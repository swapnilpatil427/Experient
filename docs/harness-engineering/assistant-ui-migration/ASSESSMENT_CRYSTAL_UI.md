# Assessment — Crystal Chat Surface (Frontend)

> **Author:** Nadia Okonjo, Staff Frontend Engineer, Conversational Interfaces
> **Date:** 2026-08-04
> **Mandate:** `TEAM.md` §1
> **Evidence base:** `CURRENT_STATE.md`, `ASSISTANT_UI.md`, plus a full read of `app/src/components/CrystalPanel.tsx` (2,799 lines), `app/src/contexts/crystalPanel.tsx` (140), `app/src/components/ExperientCopilot.tsx` (616), `app/src/__tests__/components/CrystalPanel.test.tsx` (1,326), and `app/src/__tests__/lib/crystalIdentityTokens.test.ts` (72)
> **Library facts verified against:** `@assistant-ui/react@0.15.4` (npm registry metadata) and the doc pages cited inline

**Verdict up front: `DON'T`.** The full argument is in §8. Sections 1–7 are the work.

---

## 0. Two corrections to the shared evidence base

Before the analysis, two claims in the pod's shared docs need fixing. Both cut *in favour* of the library, and I'd rather correct them myself than have someone else find them.

**(a) `ASSISTANT_UI.md` §6, "arguments against" #5 — "the styled component set collides with a test-enforced brand token cascade" — is wrong as stated.** The styled components are not an imported component library. They are delivered by CLI registry copy into your own repo, shadcn-style. From `/docs/ui/markdown.md`, verbatim: *"This adds a `/components/assistant-ui/markdown-text.tsx` file to your project, which you can adjust as needed."* Copied files land outside the three paths that `crystalIdentityTokens.test.ts:19-23` scans, so they cannot fail that test. The real objection to the styled set is different and I make it properly in §5.

**(b) `CURRENT_STATE.md` §6 says CrystalPanel has 12 `t()` calls.** It has 17 (`:233,398,653,939,1037,1108,1198,1204,1255,1391,1409,1421,1424,1429,1437,1442,1488`). Directionally identical — ~99.4% of the file's user-visible strings are still hardcoded English — but the number should be right.

---

## 1. Component mapping table

Every named region of `CrystalPanel.tsx`, with its real line range and LOC, mapped to exactly one destination. LOC = `end − start + 1`.

### Legend
- **`primitive`** — replaced by a named assistant-ui headless primitive; our styling survives via `asChild`
- **`MessagePart`** — must be rebuilt as a custom message-part component (`TextMessagePartComponent` or a `data-*` DataMessagePart)
- **`ToolUI`** — must be rebuilt as a `ToolCallMessagePartComponent` registered on a toolkit entry
- **`hand-build`** — no library analogue; the code survives essentially as-is or must be written from scratch either way
- **`delete`** — genuinely removable, replaced by library behaviour

### 1a. Module scope

| Region | Lines | LOC | Destination | Note |
|---|---|---|---|---|
| Header comment + imports | 1–29 | 29 | `hand-build` | Import list churns; count unchanged |
| `Message`, `CrystalVerbatim`, `CrystalCitation`, `CitationMap`, `StreamingPhase`, `CrystalPanelProps` | 31–86 | 56 | `hand-build` | `Message` (31–42) → `delete`; the citation types survive verbatim as the store's payload type |
| `ENUMERATION_PATTERNS`, `DATA_OBJECT_EXCLUSIONS`, `classifyAsSupport` | 88–151 | 64 | `hand-build` | Pure routing predicate. Zero library surface |
| `SINGLE_PROMPTS`, `ALL_PROMPTS` | 153–165 | 13 | `primitive` — `ThreadPrimitive.Suggestion` / ExternalStore `suggestions` option | Data survives; consumption changes |

### 1b. Inside `CrystalPanel()` — 167–1540, 1,374 LOC

| Region | Lines | LOC | Destination | Note |
|---|---|---|---|---|
| Context destructure, state, derivations (`nps`, `responseCount`, `dynamicPrompts`, `isSupportMode`) | 167–270 | 104 | `hand-build` | `useState<Message[]>` at **:196** is the state the runtime decision turns on (§3) |
| `submitQuery` — request-body construction | 271–385 | 115 | `hand-build` | 15 non-OpenAI body fields (`CURRENT_STATE.md` §3). Survives verbatim inside `onNew` |
| `submitQuery` — SSE reader + 7-branch event switch | 386–482 | 97 | `hand-build` | Every branch still needed. Must additionally emit cumulative message state instead of `setMessages` |
| `submitQuery` — REST fallback when stream ends with no `answer` | 483–556 | 74 | `hand-build` | No analogue. `answerReceived` bookkeeping survives |
| `submitQuery` — error mapping (402/503/502 → prose) | 557–582 | 26 | `hand-build` | `ErrorPrimitive` exists but Crystal's errors are chat *messages* (`CURRENT_STATE.md` #12), not runtime errors |
| `submitQuery` — legacy non-stream path | 584–640 | 57 | `hand-build` | Third transport. See §3 |
| Auto-submit `initialQuery` effect | 646–656 | 11 | `hand-build` | Driven by `openCrystal(query)`, 52 call sites |
| Auto-scroll effect (`scrollTop = scrollHeight`) | 659–663 | 5 | **`delete`** | `ThreadPrimitive.Viewport` — and it's *better*: handles user-scrolled-up |
| Focus-on-open effect | 666–671 | 6 | **`delete`** | Composer autofocus |
| Reset-expanded effect | 674–676 | 3 | `hand-build` | Panel chrome, not chat |
| `handleMic` (Web Speech API) | 678–703 | 26 | `primitive` — `adapters.dictation` | ~26 → ~15 LOC adapter. Marginal win |
| `handlePin` | 705–707 | 3 | `hand-build` | No analogue |
| `handleThumbsUp` / `handleThumbsDown` | 709–735 | 27 | `primitive` — `adapters.feedback` | UI state inherited; the fan-out to `api.updateInsightFeedback(citation.id)` per citation survives |
| Proposal state + `note()` | 737–752 | 16 | `hand-build` | |
| **`executeAction`** — 18-branch dispatch, 12 REST calls, DataBus invalidation, 3-status funnel | 754–1021 | **268** | `hand-build` | The single largest differentiated block. Called from `addResult` instead of `onApply`. Unchanged otherwise |
| `handleCreateTicket` (diagnostic provenance → `create_case`) | 1023–1089 | 67 | `hand-build` | |
| `dismissAction` | 1091–1103 | 13 | `hand-build` | |
| `handleSubmit` / `handleKeyDown` / `panelWidth` | 1105–1121 | 17 | `primitive` — `ComposerPrimitive.Send` | Enter-vs-Shift+Enter is built in |
| Panel shell — `AnimatePresence`, left-edge shadow, fixed `motion.div` | 1123–1165 | 43 | `hand-build` | `AssistantModalPrimitive` is a popover. Crystal is a non-modal docked panel sized off `--sidebar-width`. Not a match |
| Header — gem, title, badges, Clear, Expand, Close | 1166–1242 | 77 | `hand-build` | `Clear` = `setMessages([])`, which the ExternalStore already owns |
| Scope / context strip (tag chip, topic chip, window chip, Portfolio, clear) | 1244–1310 | 67 | `hand-build` | `context-display` styled component exists; it models model context, not survey scope |
| Time-window quick-filter | 1312–1328 | 17 | `hand-build` | |
| Conversation container + message `.map()` + thinking/error slots | 1330–1381 | 52 | `primitive` — `ThreadPrimitive.Viewport` + `ThreadPrimitive.Messages` | ~52 → ~28 |
| Support-mode escalation card | 1382–1412 | 31 | `hand-build` | |
| Support-mode thumbs (`api.submitDocFeedback`) | 1414–1451 | 38 | `hand-build` | A *second*, different feedback path keyed on `doc_key`. The feedback adapter models one |
| Input bar — mic button, autogrow textarea, Ask button, hint line | 1456–1516 | 61 | `primitive` — `ComposerPrimitive.Root/Input/Send` | Real win: `react-textarea-autosize` is already a lib dep; kills the manual `e.target.style.height` |
| `ManualRunDialog` mount | 1518–1534 | 17 | `hand-build` | |
| JSX close | 1535–1540 | 6 | `hand-build` | |

### 1c. Sub-components — 1543–2799

| Component | Lines | LOC | Destination | Note |
|---|---|---|---|---|
| `EmptyState` | 1543–1583 | 41 | `primitive` — `ThreadPrimitive.Empty` + `ThreadPrimitive.Suggestion` | ~41 → ~30 |
| `MiniCrystal` (brand orb, conic gradients, keyframes) | 1586–1638 | 53 | `hand-build` | Brand identity. Untouchable |
| `UserBubble` | 1641–1653 | 13 | `primitive` — `MessagePrimitive.Root` + `MessagePartPrimitive.Text` | ~13 → ~11 |
| `UUID_RE`, `FULL_UUID_RE`, `resolveId`, `enrichCitationsFromMap`, `buildCitationsFromAnswer`, `parseInlineCitations` | 1655–1728 | 74 | `hand-build` | Pure functions. Move into `convertMessage` / the SSE reader. Zero delta |
| `Link` import + `LAYER_COLORS` | 1730–1738 | 9 | `hand-build` | **:1733–1738 is the exact range hardcoded in `crystalIdentityTokens.test.ts:43`.** See §5 |
| `InlineCitation` (hover tooltip, layer badge, verbatim preview, nav link) | 1740–1829 | 90 | **`MessagePart`** | `sources` styled component is for URL sources. Crystal's are `[uuid]` markers joined against an out-of-band map from a *different service* (`backend/src/routes/experience.ts:782`) |
| `CitedText` (split-on-regex → superscripts) | 1831–1870 | 40 | **`MessagePart`** — custom `TextMessagePartComponent` | Cannot use built-in text part; must own text rendering |
| `SENTIMENT_DOT`, `insightNavPath`, `CitationStrategy`, `getCitationStrategy` | 1872–1904 | 33 | `hand-build` | Two display strategies selected by scope. No analogue |
| `VerbatimList` | 1906–1928 | 23 | **`MessagePart`** | |
| `SourcesFooter` (both strategies, expand, per-source verbatim toggle) | 1930–2064 | 135 | **`MessagePart`** — `data-sources` DataMessagePart | |
| `CrystalBubble` (avatar, confidence chip, text, documents, sources, suggestions, Pin/Slack/Ticket/thumbs row) | 2066–2189 | 124 | split: `MessagePrimitive.Root` + `ActionBarPrimitive.Root` (`primitive`) hosting `hand-build` buttons | `ActionBarPrimitive` gives Copy/Reload/Edit/Feedback. Crystal needs Pin/Slack/Ticket, which it doesn't model |
| `TOOL_META` (13 tools → label/icon/colour) + `AccumulatedStep` | 2191–2217 | 27 | `hand-build` | Duplicates dead locale keys at `en.ts:3947-3961` |
| **`CrystalThinkingBubble`** (8 `@keyframes`, orb, per-step timing, elapsed counter, shimmer, progress bar) | 2218–2540 | **323** | `hand-build` | See the note below — this is the load-bearing entry in the table |
| Removal comments | 2542–2546 | 5 | `delete` | |
| `ReportProposalIntent` + `resolveReportProposalAction` | 2547–2582 | 36 | `hand-build` | Pure, already unit-tested |
| `ACTION_TYPE_ICONS`, `PRIORITY_COLORS`, `PARAM_LABELS`, `humanizeParams` | 2584–2640 | 57 | `hand-build` | `humanizeParams` is the "nothing mutates unseen" preview. Product-critical |
| **`ActionProposalCard`** | 2642–2799 | **158** | **`ToolUI`** | The one genuine structural match. See the note below |

**Sum check:** 29+56+64+13 (module) + 1,374 (component) + 41+53+13+74+9+90+40+33+23+135+124+27+323+5+36+57+158 (sub-components) = **2,777**, plus 22 blank separator lines between top-level declarations = **2,799**. ✅

### Note on `CrystalThinkingBubble` → `hand-build`, not `ChainOfThought`

This is the entry a "MIGRATE" case most wants to be `primitive`, and it isn't. Three independent reasons:

1. **The grouping trigger doesn't fire.** `/docs/guides/chain-of-thought.md`: grouping is driven by `MessagePrimitive.GroupedParts` over consecutive **reasoning parts and tool-call parts**, and it warns that *"LangGraph does not emit reasoning tokens in that format, so reasoning grouping will not activate automatically."* Crystal's `thinking`/`observation` events have no args, no result, and no tool-call ID (`crystal.py:1903-1947`). We would synthesize fake reasoning/tool parts with fabricated `toolCallId`s purely to trip a grouping heuristic.
2. **Nothing in the 323 LOC is inherited.** Per-step `startedAt`/`completedAt` (`:2214-2215`), the 100 ms elapsed ticker (`:2243-2247`), the same-tool-coalescing rule (`:2256-2269`), the duplicate-`synthesizing` guard (`:2279-2281`), per-tool colours from `TOOL_META`, the shimmer-text gradient (`:2485-2491`), the aurora header (`:2373-2377`), and the completion progress bar (`:2518-2535`) have no analogue. `message-timing` is per-message, not per-step.
3. **It moves architecturally.** Today it renders as a **sibling** of the message list when `isThinking` (`:1360-1362`), fed by a `streamingState` prop. Under any assistant-ui runtime it must become parts of an in-flight assistant message, which means the step-accumulation logic (`:2250-2295`, ~46 LOC) relocates out of the component into `convertMessage`/the adapter, and the component is rewired to read from parts. That's a rewrite of the seam, not a port.

### Note on `ActionProposalCard` → `ToolUI`

`{ args, status: 'requires-action', result, addResult }` plus `type: "human"` is genuinely the same human-in-the-loop shape as propose → confirm → execute → record-outcome. `ASSISTANT_UI.md` §4 is right about that. But be precise about what it buys: **the plumbing, not the card.** The 158 LOC of render (priority badge, `create_case` chips, "What will happen" toggle) and the 57 LOC of label maps are unaffected; the 268 LOC of `executeAction` is unaffected. What `addResult` replaces is roughly the `isExecuting` / `onApply` / `onDismiss` prop trio and the `setActionProposals(prev => prev.filter(...))` line at `:1013` — call it 25 LOC. And it costs a props-adaptation shim (§2) plus, per `/docs/tools/tool-ui.md`, the docs *do not document* rendering client-synthesized tool-call parts at all: the guide is written entirely for model-driven and backend-driven calls. We would be building on undocumented behaviour. See §7.

**Nothing in the table is blank. Tally: 8 `primitive`, 4 `MessagePart`, 1 `ToolUI`, 2 `delete`, 26 `hand-build`.**

---

## 2. Net LOC accounting

Two accountings, because only the second answers the actual question.

### 2a. Migration alone — lines deleted

Every line I can honestly claim the library removes:

| # | What | Lines | Justification |
|---|---|---|---|
| 1 | Manual scroll effect `:659-663` | **5** | `ThreadPrimitive.Viewport` |
| 2 | Focus-on-open effect `:666-671` | **6** | Composer autofocus |
| 3 | Input bar: 61 → 38 | **23** | `ComposerPrimitive` + `react-textarea-autosize` (already a lib dep) |
| 4 | Message list map + branch `:1344-1359`: 16 → 10 | **6** | `ThreadPrimitive.Messages` children fn |
| 5 | `EmptyState`: 41 → 30 | **11** | `ThreadPrimitive.Empty` + `Suggestion` |
| 6 | `handleMic`: 26 → 15 | **11** | `adapters.dictation` |
| 7 | `Message` interface + `crypto.randomUUID()`/`timestamp` bookkeeping at 8 sites | **10** | `ThreadMessageLike` supplies id/createdAt |
| 8 | `UserBubble`: 13 → 11 | **2** | |
| 9 | Removal comments `:2542-2546` | **5** | |
| 10 | `isThinking` state → `isRunning` + optimistic-message bookkeeping | **15** | ExternalStore `isRunning` renders the optimistic assistant message |
| 11 | Thumbs UI state (keep the API fan-out) | **10** | `adapters.feedback` |
| | **Deleted total** | **104** | |

I'll round up to **120** to be generous about small wins I haven't enumerated. That is the honest ceiling. `CrystalPanel.tsx` goes from 2,799 to about 2,680 lines — before anything is added.

### 2b. Migration alone — lines added

| # | What | LOC | Basis |
|---|---|---|---|
| 1 | `useExternalStoreRuntime` config: `messages`, `onNew`, `isRunning`, `setMessages`, `onCancel`, `onAddToolResult`, `suggestions`, `adapters.{feedback,dictation}`, `unstable_capabilities`, `extras` | 90 | 10 handlers from `/docs/runtimes/custom/external-store.md`, each with a body |
| 2 | `convertMessage`: `Message` → `ThreadMessageLike` with a parts array — text part, `data-sources` part, `data-documents` part, synthesized tool-call parts for proposals, synthesized reasoning parts for the timeline, metadata for `confidence`/`pinned`/`thumbs` | 130 | The most load-bearing new file; 6 part kinds to emit |
| 3 | Part/tool registration: `defineToolkit` entry with `render`, `makeAssistantDataUI` for two data parts, TS types for each part payload | 55 | |
| 4 | `AssistantRuntimeProvider` wiring in `AppShell`, provider ordering vs `CrystalPanelProvider`, builder-route suppression (`AppShell.tsx:43,64-65,101-103`) | 25 | |
| 5 | Custom `TextMessagePartComponent` wrapping `CitedText` | 30 | |
| 6 | `data-sources` part wrapper around `SourcesFooter` | 25 | |
| 7 | `data-documents` part wrapper around `InsightDocumentCard` | 15 | |
| 8 | `ToolCallMessagePartComponent` shim: `{args,status,result,addResult}` → `{proposal,isExecuting,onApply,onDismiss}`, plus `useInlineRender` to reach `executeAction` | 45 | |
| 9 | `CrystalThinkingBubble` rewire: read from parts not `streamingState`; step accumulation relocated into the adapter | 60 | Relocation of `:2250-2295`, not deletion |
| 10 | `submitQuery` → `onNew` restructure: all 7 SSE branches must build cumulative message objects instead of calling `setMessages`; `citation_context` retro-enrichment of message N−1 (`:423-431`) must survive the conversion boundary | 80 | |
| 11 | Primitive restyling: `asChild` + className/style plumbing across ~8 primitive compositions to reproduce current pixels | 60 | |
| 12 | `onCancel` — Crystal has **no** `AbortController` today (verified: zero `abort` matches in the file). The cancel handler and its plumbing are net-new | 40 | Also net-new on the no-dep path |
| | **Added subtotal** | **655** | |

### 2c. Test rewrites

`CrystalPanel.test.tsx` is 1,326 LOC; `CrystalPanelReportProposals.test.tsx` 75; `contexts/crystalPanel.test.tsx` 113.

The good news: coverage is concentrated on `executeAction` branches and request-body correctness, and those assertions (`expect(mockApi.createGraphWorkflow).toHaveBeenCalledWith(...)`, `JSON.parse(fetch.mock.calls[0][1].body)`) survive unchanged. The bad news:

| # | What | LOC | Basis |
|---|---|---|---|
| 1 | `renderPanel` harness (`:238-250`) must wrap in `AssistantRuntimeProvider`; `triggerProposals` (`:253-273`) drives the composer, which becomes `ComposerPrimitive.Input` | 60 | You cannot `vi.mock('@assistant-ui/react')` — you need the real runtime |
| 2 | ~30 execution tests: the Apply click goes through `addResult`, so each needs its interaction touched even where the assertion holds | 90 | ~3 LOC each |
| 3 | New tests for `convertMessage` | 200 | Genuinely good news: it's a pure function, easier to test than what it replaces |
| 4 | New tests for 4 custom parts + 1 ToolUI | 120 | |
| 5 | `crystalIdentityTokens.test.ts:43` line range breaks the moment the file reflows (§5) | 10 | |
| | **Test subtotal** | **480** | |

### 2d. The numbers

```
Migration alone:
  added        655
  tests       +480
  deleted     −120
  ────────────────
  NET        +1,015 LOC
```

**The migration is net positive. It adds roughly a thousand lines of code and delivers zero of the three user-visible gaps** — no markdown, no a11y, no persistence. Those cost extra, in either path.

### 2e. The comparison that matters — equal user-visible outcome

Same deliverable both ways: markdown rendering, a11y parity, thread persistence, monolith split.

| Work item | With assistant-ui | Without |
|---|---|---|
| Base restructure | **+1,015** (§2d) | **0** |
| Markdown | `@assistant-ui/react-markdown` + `remark-gfm`; registry-copy `markdown-text.tsx` into our repo (~180 LOC we now own) + brand-token pass + citation-marker integration into the markdown AST: **+270** | `react-markdown` + `remark-gfm`; one `<CrystalMarkdown>` with a `components` override that runs `CitedText`'s split over text nodes: **+120** |
| Code blocks | included in the copied component: **0** | lazy `shiki`: **+40** |
| A11y | primitives give Composer/Thread semantics. Their own `/docs/primitives.md` commits to exactly one thing: *"Error — Error display with accessible alert role."* No `aria-live`/`role=log` guarantee is documented. `AssistantModalPrimitive` is a popover, so the docked panel's dialog semantics, Escape, and focus restore are ours anyway: **+80** | `role="region"` + `aria-label` on the panel (correct for a *non-modal* docked panel — `role="dialog"` would be wrong), Escape handler, `role="log" aria-live="polite"` on the thread, `role="status"` on the thinking bubble, `aria-live` on `streamError`, focus restore, `prefers-reduced-motion` guard on the 8 in-file `@keyframes`: **+110** |
| Persistence | `RemoteThreadListAdapter` + our own Postgres endpoints + thread-list UI: **+220** | wire up the endpoint that **already exists and works** — `GET /api/insights/:surveyId/crystal/history` (`backend/src/routes/insights.ts:1492`) and `api.getCrystalHistory`/`clearCrystalHistory` (`lib/api.ts:2232-2245`, zero callers), plus make the SSE path write `crystal_threads` v2: **+160 FE / +60 BE** |
| Monolith split | mechanical, both paths: **+40** | **+40** |
| `crystal-spin` keyframe bug (`:2303-2334` defines it, `:2783` consumes it — the Apply spinner only animates if a thinking bubble has mounted this session) | **−30** | **−30** |
| Tests for the above | **+250** | **+250** |
| | **≈ +2,065** | **≈ +750** |

**Same user-visible outcome. The no-dependency path costs roughly 36% of the lines.** I could be 30% wrong on either estimate and the ordering would not flip.

Plus 679 LOC of dead chat code (`IrisChat.tsx` 316, `pages/insights/ConversationView.tsx` 363 — both verified at those line counts, both zero importers) is deletable today, in both paths, with no decision required.

**Answer to decision test #2: no. It adds substantially more code than it replaces, and the gap is not marginal.**

---

## 3. Runtime pattern decision

**`ExternalStoreRuntime`, if anything at all. Never `LocalRuntime`. Not `DataStream` or `AssistantTransport`.**

**Why not `LocalRuntime`:** `ChatModelAdapter.run()` owns the message array. Crystal has five mutation paths that are not "append an assistant turn," and three of them reach backwards into already-rendered messages:

| Mutation | Site | Shape |
|---|---|---|
| Retro-enrich message N−1's citations when `citation_context` arrives | `:423-431` | rewrites a *past* message's payload |
| Toggle `pinned` on any message | `:705-707` | |
| Toggle `thumbs` on any message + fan out to `api.updateInsightFeedback(c.id)` per citation | `:709-735` | |
| `note()` — inject a synthetic assistant message from `executeAction`, *after* the turn ended | `:748-752`, called at `:824,853,869,889,897,965,1017` | writes outside any run |
| Clear all | `:1216` | |

`citation_context` is the disqualifier. It "always arrives first — before the message reaches the model" (`CURRENT_STATE.md` §2) but its *consumer* rewrites the last already-rendered assistant message. With `LocalRuntime` that message is inside the library's store, mid-`run()`, and you have no sanctioned way to patch it. `note()` is the second disqualifier: it appends assistant messages from a click handler with no run in flight.

**Why `ExternalStoreRuntime` fits mechanically:** we keep `useState<Message[]>` at **`:196`** exactly as it is, `setMessages` stays ours, and `convertMessage` is a pure projection. `ASSISTANT_UI.md` §3 is right that Crystal's array "could be adapted without being rewritten." The `data-*` part support (`/docs/runtimes/custom/external-store.md`: *"Supports `data-*` prefixed types (e.g. `{ type: 'data-workflow', data: {...} }`) which are automatically converted to `DataMessagePart`"*) is the mechanism for citations/sources/documents. Three transports per turn — support REST (`:285-310`), SSE (`:316-582`), legacy REST (`:584-640`) — branch naturally inside `onNew`, which a single `run()` would have to fake.

**Why that fit is worth almost nothing.** Run the capability-gating table from `ASSISTANT_UI.md` §3 against Crystal honestly:

| Handler | Unlocks | Crystal today |
|---|---|---|
| `onNew` | sending | **required, and we already have it** |
| `setMessages` | branch switching | **dead capability** — no branches exist, and creating them needs `parentId`, which needs server message identity |
| `onEdit` | edit button | **unimplementable** — `CURRENT_STATE.md` #6: no message/turn/run IDs on the wire |
| `onReload` | regenerate button | **unimplementable** — same reason |
| `onCancel` | cancel button | implementable, but Crystal has **no `AbortController`** (zero matches in the file) — we build it either way |
| `onAddToolResult` | tool results | only if proposals become tool-call parts (§7) |

**The gating table returns nothing we don't already have or can't already build.** That is the crux, and it is a contract problem, not a UI-library problem. Adopting `ExternalStoreRuntime` does not unblock edit/regenerate/branch; it just relocates where they're blocked.

`DataStream` and `AssistantTransport` are rejected outright: both require the *server* to emit their protocol, and `CURRENT_STATE.md` §3 enumerates 15 ways the CrystalOS/Express stream isn't shaped that way — unnamed SSE frames with an inner `type` discriminator (`main.py:1797`), non-OpenAI `[DONE]` semantics, out-of-band `citation_context` injected by a *different service*, per-turn client-uploaded grounding corpora, and `surface`-based hard skill routing.

---

## 4. Churn tax, evidenced

### 4a. The `unstable_` surface we would depend on

From `/docs/runtimes/concepts/stability.md`, verbatim: an `unstable_` prefix means *"the surface (signature, naming, semantics, return shape) may change in **any release including patch releases**."*

Cross-referencing that page's unstable-export table against §2b's addition list:

| API | Why we need it | §2b item |
|---|---|---|
| `unstable_capabilities` (ExternalStoreRuntime) | to *suppress* copy/edit/reload affordances Crystal cannot honour. Without it the UI advertises buttons that do nothing | 1 |
| `unstable_createMessageConverter` / `unstable_convertExternalMessages` / `useExternalMessageConverter` | the entire message-conversion layer — the single most load-bearing new file | 2 |
| `unstable_state`, `unstable_annotations`, `unstable_data` (message metadata) | where `confidence`, `pinned`, `thumbs` live if not modelled as data parts | 2 |
| `unstable_assistantMessageId`, `unstable_threadId`, `unstable_parentId`, `unstable_getMessage` (`ChatModelRunOptions`) | required the moment we want persistence or identity — i.e. the moment the migration pays off | persistence, §2e |
| `unstable_onBranchChange` | required to persist a branch head | future |
| `unstable_humanToolNames` | relevant to the `type: "human"` proposal mapping | 8 |

**Every load-bearing piece of the adapter sits on patch-release-unstable surface.** Not the periphery — items 1, 2, and 8 of the addition list, which together are 190 of the 655 added lines.

### 4b. What the four migrations actually required

I read all four guides. Summary per release, with the rename/rearchitecture split kept honest:

**v0.11 — mostly mechanical, one rearchitecture on our seam.**
~30 symbol renames (`ContentPart*` → `MessagePart*` across types, hooks, components, providers, primitives), fully codemodded (`npx assistant-ui@latest codemod v0-11/content-part-to-message-part .`). **But:** `MessagePrimitive.Content` → `MessagePrimitive.Parts` with a new render-callback signature. That is a rearchitecture of the exact primitive every custom message part composes against.

**v0.12 — rename layer plus a real rearchitecture.**
`useAssistantApi`→`useAui`, `useAssistantState`→`useAuiState`, `AssistantIf`→`AuiIf`, plus kebab→camel event names (`thread.run-start`→`thread.runStart`) — codemodded. **But:** roughly 14 context hooks were *removed* in favour of a unified `useAuiState(selector)` API: `useThread`/`useThreadRuntime`, `useMessage`/`useMessageRuntime`, `useComposer`/`useComposerRuntime`, `useMessagePart`/`useMessagePartRuntime`, `useToolUIs`, `useEditComposer`, `useAttachment*`, `useThreadList*`, `useThreadModelConfig`. Codemod "partially available." Anything reading state inside a custom part had to be rewritten, not renamed.

**v0.14 — mostly renames, one rearchitecture, handled gracefully.**
Alias removals (`useAssistantApi`→`useAui` again) and runtime-surface renames (`runtime.threadList`→`runtime.threads`, `thread.startRun(parentId)`→`thread.startRun({parentId})`, `thread.unstable_loadExternalState`→`thread.importExternalState`, `getExternalStoreMessage`→`getExternalStoreMessages`), all covered by `npx assistant-ui@latest upgrade`. **But:** the `components` prop was replaced by children render functions across `ThreadPrimitive.Messages`, `MessagePrimitive.Parts`, `ThreadPrimitive.Suggestions`, `ThreadListPrimitive.Items`, `ComposerPrimitive.Attachments` — again, precisely the seam our custom parts live on. Credit where due: the old prop still works, deprecated. This one was gradual.

**v0.15 — renames plus two hard rearchitectures, no codemod for them.**
Accessor calls→properties (`aui.thread()`→`aui.thread`, codemod `v0-15/aui-accessor-calls-to-properties`), 17 legacy context hooks removed in favour of `useAui`/`useAuiState`, `ToolsState.tools`→`toolUIs` with a shape change (`s.tools.tools[name]?.[0]` → `s.tools.toolUIs[name]?.[0]?.render`), `"mcp-app"`→`"standalone-tool-call"` in `groupPartByType`. **And:** `useAui({parent})` removed in favour of `AuiProvider extends`, and `AuiProvider`'s API restructured from `value` to `extends` + `config` where *"raw object literals are a type error."* No codemod noted for either.

### 4c. The finding

Three of four migrations rearchitected either the **message-part rendering seam** (v0.11, v0.14) or the **state-access API** (v0.12, v0.15) — and those are the only two surfaces a Crystal migration is built on. The unified hook API introduced in v0.12 was *removed* in v0.15: a three-minor lifetime for the primary way to read state. Codemods reliably cover renames; they did not cover the `AuiProvider` restructure, the `ToolsState` shape change, or the `useAui({parent})` removal.

`/docs/migrations/deprecation-policy.md` promises *"a long (>3 month) deprecation notice period"* for stable features and *"a short (<1 month)"* one for beta, and makes **no commitment about breaking changes before 1.0** and no release-cadence commitment. Everything in §4a is explicitly outside that promise.

**Concrete recurring cost:** with 4 custom message parts, 1 ToolUI, and ~8 primitive compositions, each minor release means one automated rename pass plus a hand review of every one of those 13 integration points. On the observed cadence that is roughly 1–2 engineer-days per minor, on Xperiq's most important UI surface, with no LTS branch to sit on. And the ~1,958 LOC of Crystal tests would gate every one of those upgrades.

**Answer to decision test #4: the churn tax is not acceptable at the current price.** It is not "just renames" — that framing is what the codemod list makes it look like, and it doesn't survive reading the guides.

### 4d. Dependency footprint (for completeness)

`@assistant-ui/react@0.15.4`, 2,413,243 bytes unpacked, 19 direct dependencies including `radix-ui@^1.6.7` (the monolithic package — the app currently installs 12 individual `@radix-ui/react-*` packages instead), `zustand@^5`, `zod@^4`, `nanoid@^6`, `assistant-stream`, `safe-content-frame`, `@assistant-ui/{core,store,tap}`, and **`assistant-cloud@^0.1.38`** — the commercial cloud client is a dependency of the core package, not an opt-in. `zustand` and `zod` are not currently frontend dependencies. Vite's manual chunking (`app/CLAUDE.md`, "Build Chunking") would need a new `vendor-assistant-ui` chunk.

---

## 5. Styled vs headless verdict

**Headless primitives only. Never the styled set.** But not for the reason `ASSISTANT_UI.md` §6 gives — that reason is wrong (§0a), and I want the record straight because a skeptical reader will check it.

### What the token test actually does

`app/src/__tests__/lib/crystalIdentityTokens.test.ts` reads three files by path (`:19-23` — `CrystalPanel.tsx`, `workflow-builder/AskCrystalFab.tsx`, `dashboard/widgets/CrystalNarrativeWidget.tsx`), scans each line for literal brand hex or its rgba decomposition (`:26-27`), and skips a hardcoded line range per file (`:42-44`).

Consequences:

1. **Registry-copied styled components could not fail this test.** They land at `src/components/assistant-ui/*`, which is not in `CRYSTAL_IDENTITY_FILES`. The test wouldn't scan them. The stated collision does not exist.
2. **But the migration breaks the test anyway, via a false positive.** The exclusion is `'src/components/CrystalPanel.tsx': [[1733, 1738]]` — a hardcoded line range pointing at the `LAYER_COLORS` block, which legitimately keeps `#2a4bd9` (`:1737`). The test's own comment (`:34-41`) says it out loud: *"a hardcoded line range is inherently this fragile across any merge that adds content above it."* Any reflow of `CrystalPanel.tsx` — the migration, or the monolith split, or both — shifts `LAYER_COLORS` off `[1733,1738]` and the suite goes red on a line that is *supposed* to keep its hex. Cost: ~10 LOC to content-match the block instead. **This is worth fixing now, independent of the decision** — it will bite the monolith split too.

### The real objection to the styled set

`app/CLAUDE.md` (Brand Theme System) is explicit: *"Tailwind utilities like `bg-primary` are baked at build time and will NOT update at runtime"* — anything that must respond to `applyBrandTheme()` has to use `var(--color-primary)` or an inline `style`. Crystal complies aggressively: `color-mix(in srgb, var(--color-primary) N%, transparent)` appears throughout (`:1142,1160,1162,1170,1172,1189,1246,1367,1464-1465,1600,2367,2378-2379`), and the gradients use `var(--color-primary)`→`var(--color-tertiary)` live (`:1178,1506,1646,2088`).

The registry components ship Tailwind utility classes. So every copied file needs a hand pass converting brand utilities to CSS-var inline styles — on arrival, and again on every registry update, with no upstream benefit because the file is ours now. We'd be taking on maintenance of someone else's component with none of the upgrade path. The one file I'd consider is `markdown-text.tsx`, and §2e already shows plain `react-markdown` is cheaper (120 vs 270 LOC) for exactly the same rendered output.

**Headless-only.** Which also means the a11y argument shrinks: `/docs/primitives.md` calls the primitives *"unstyled, accessible Radix-style building blocks"* but the only concrete commitment on the page is *"Error — Error display with accessible alert role and automatic error text."* No documented `aria-live`/`role="log"` on the thread viewport; no documented dialog semantics for a docked panel (`AssistantModalPrimitive` is a popover). Theo should verify this against the rendered DOM rather than the prose — my read of the docs is that we would still owe most of the a11y work.

**Cross-check with Theo (headless-vs-styled):** we agree on headless-only. I'd flag two things to him specifically: (1) the `ASSISTANT_UI.md` §6 #5 claim needs retracting, because a design-system review that rejects the dependency on a false premise is a review that gets overturned; (2) the strongest a11y fact in this whole assessment is not about assistant-ui at all — it's that `ExperientCopilot.tsx`, the 616-LOC "lesser" chat implementation, has **Escape-to-close** (`:152`) and **3** `aria-*` attributes (`:282,360,601`) while `CrystalPanel.tsx` has **1** (`:1765`) and no Escape handler at all. Same repo, same team, no library. That is a discipline gap, and a framework does not fix discipline gaps — it relocates them.

---

## 6. The cheaper path, costed

This is the section that decides the question. Four work items, no new UI framework.

### 6.1 Markdown — ~120 LOC, 2 deps

`react-markdown` + `remark-gfm` (~60 KB gzipped combined). One component:

```
CrystalMarkdown({ content, citations })
  → <ReactMarkdown remarkPlugins={[remarkGfm]} components={{...}}>
```

The only non-trivial part is that citations are inline `[uuid]` markers *inside* prose, so `CitedText`'s split (`:1836-1870`) has to run over markdown **text nodes** rather than the raw string. That is ~40 LOC of a `text` renderer override.

Critically: **this cost is identical in both paths.** A custom `TextMessagePartComponent` under assistant-ui has exactly the same problem, and §2b item 5 already budgets 30 LOC for it. Markdown is not a reason to adopt the library, because the library's markdown component does not know about `[uuid]` markers either.

Code blocks: `shiki` behind `React.lazy()` (the repo already does this for Three.js — `app/CLAUDE.md`, "Lazy-load always"), ~40 LOC. Or defer entirely: Crystal answers survey questions; there is no evidence anyone is pasting code into it.

### 6.2 A11y — ~110 LOC, 0 deps

The pieces, each with an in-repo precedent:

| Fix | Cost | Precedent in repo |
|---|---|---|
| `role="region"` + `aria-label` on the panel container `:1154`. **Not `role="dialog"`** — Crystal is non-modal by design (the page behind stays readable and interactive), so dialog semantics would be a lie and a focus trap would be actively wrong | 5 | — |
| Escape-to-close | 8 | `ExperientCopilot.tsx:152` |
| `role="log" aria-live="polite"` on the thread container `:1331` — this alone fixes "streaming answers are never announced" | 3 | `insights/TopicChangeBar.tsx:77`, `tag-report/PipelineVisualization.tsx:113`, `prism/FileDropzone.tsx:301` |
| `role="status"` + `aria-live` on `CrystalThinkingBubble` | 5 | same |
| `aria-live` on `streamError` `:1363-1365` | 3 | same |
| `aria-label` on the 4 header controls (currently `title` only: `:1218,1229,1238`) and the mic (`:1471`) | 10 | `ExperientCopilot.tsx:360,601` |
| Focus restore to the opener on close | 25 | store the trigger element in `crystalPanel.tsx` context |
| `prefers-reduced-motion` guard for the 8 in-file `@keyframes` (`:1590`, `:2304-2333`) | 30 | `app/CLAUDE.md`, "Always check `prefers-reduced-motion`" |
| Keyboard-reachable `InlineCitation` tooltip (currently hover + focus at `:1761-1764`, but the panel has no visible focus order) | 20 | — |
| **Total** | **~110** | |

If a focus trap is wanted for the expanded (55%) state specifically, `@radix-ui/react-dialog` is **already a dependency** and `Sheet` is already used correctly with `aria-labelledby` at `insights/InvestigationDrawer.tsx:348-352`. `<Dialog modal={false}>` gives Escape + focus management without trapping. Zero new dependencies.

**This is a two-day task, not a framework decision.** And per §5, assistant-ui's own docs don't commit to most of it.

### 6.3 Thread persistence — ~160 FE / ~60 BE

This is the item where the library looks strongest and is in fact weakest, because **most of the server side already exists and works**:

- `GET /api/insights/:surveyId/crystal/history` — real and functional (`backend/src/routes/insights.ts:1492`)
- `api.getCrystalHistory` / `api.clearCrystalHistory` — exist, **zero callers** (`app/src/lib/api.ts:2232-2245`)
- `crystal_threads` v2 schema with `user_id, scope, last_active_at, message_count, context_state, turn_count` (`20240521000002`, `20260603000003`)
- `get_or_create_thread` / `append_to_thread` in CrystalOS (`crystal.py:219-307`) — called from nowhere

What's missing: (1) the SSE path writes to no thread table (the unary path that *does* write is gated off behind `CRYSTAL_STREAMING = true` at `CrystalPanel.tsx:29`), (2) two schemas disagree on identity key (`thread_key` vs `(org_id, user_id, survey_id, scope)`), (3) no frontend caller, (4) `AppShell.tsx:56-58` force-closes the panel on navigation so nothing survives a route change anyway.

Frontend: load-on-open + a thread switcher in the header ≈ 160 LOC. Backend: make the SSE handler append ≈ 60. **Priya owns picking the schema, and that decision has to be made identically in both paths.** `RemoteThreadListAdapter` does not resolve a schema disagreement; it just means the adapter, not our code, calls whichever endpoint we settle on — and it costs +220 instead of +160 because we'd write the adapter *and* the endpoints.

### 6.4 Split the monolith — 0 net LOC

`CrystalPanel.tsx` at 2,799 lines is the actual complaint under most of the others. The seams are already clean — every sub-component is a top-level function with explicit props. Mechanical:

```
components/crystal/
  CrystalPanel.tsx           shell + header + strips + composer     (~600)
  useCrystalStream.ts        submitQuery + SSE reader + fallbacks   (~380)
  useProposalExecution.ts    executeAction + dismiss + ticket       (~350)
  ThinkingTimeline.tsx       CrystalThinkingBubble + TOOL_META      (~350)
  ActionProposalCard.tsx     card + icon/label maps + humanize      (~220)
  CrystalBubble.tsx          bubble + action row                    (~140)
  citations/                 CitedText, InlineCitation, SourcesFooter, VerbatimList, helpers (~410)
  EmptyState.tsx             empty state + MiniCrystal              (~100)
  support.tsx                classifyAsSupport + escalation UI      (~110)
```

Cost: ~40 LOC of barrel/prop plumbing, one keyframes stylesheet (which **fixes the `crystal-spin` bug** at `:2303/:2783` — the Apply spinner currently only animates if a thinking bubble has mounted this session, −30 LOC of inline `<style>`), and the `crystalIdentityTokens.test.ts:43` line-range fix from §5. Existing tests import from a barrel and mostly don't notice.

This is where the "2,799 lines is unmaintainable" pain actually goes away — and it goes away without a dependency, without touching the wire format, and without a 0.x upgrade treadmill.

### 6.5 Verdict on the cheaper path

**~750 LOC, 2 new dependencies (`react-markdown`, `remark-gfm`, both boring and stable), reversible file-by-file, and it closes every gap in `CURRENT_STATE.md` §6 that a user can actually hit today.**

Against ~2,065 LOC, 19 new transitive dependencies including a commercial cloud client, a rewrite of the primary AI surface, and a recurring upgrade tax on patch-release-unstable APIs — for the same visible result.

**The no-dependency path wins. Not narrowly.**

And note what the cheaper path does *not* deliver: edit, regenerate, branch, attachments, virtualization, TTS. Neither does the migration — `CURRENT_STATE.md` #6 blocks the first three regardless of library, §3 shows the gating table returns nothing, and the last three are unbuilt features in both worlds. There is no gap where the library wins on capability today.

---

## 7. Cross-check with Priya — should proposals become model-chosen tool calls?

**My position: no. Not for the `ToolCallMessagePartComponent` mapping, anyway — and I want to be clear that I'm arguing against the finding that most favours my own migration case.**

### Why the mapping isn't worth the reshape

`ASSISTANT_UI.md` §4 is right that `{args, status: 'requires-action', result, addResult}` + `type: "human"` is structurally the propose→confirm→execute→record loop. It's a real observation. But price it:

- **What we'd inherit:** the status plumbing. `isExecuting`/`onApply`/`onDismiss` and the `setActionProposals(prev => prev.filter(...))` line at `:1013`. ~25 LOC.
- **What we'd still own:** `ActionProposalCard`'s 158 LOC of render, `humanizeParams` + the three label maps (57), and all 268 LOC of `executeAction`'s 18-branch dispatch across 12 REST endpoints with bespoke DataBus invalidation.
- **What we'd add:** a 45-LOC props shim (§2b item 8) plus a `defineToolkit` registration. Net **negative** on LOC before counting the CrystalOS change.
- **What we'd be building on:** `/docs/tools/tool-ui.md` documents model-driven and backend-driven tool calls only. It does not document rendering a tool-call part that the *client* synthesized. Either CrystalOS emits real tool calls (a three-layer change) or we build the whole thing on undocumented behaviour.

### The architectural objection, which matters more than the LOC

The confirm-card is a **safety boundary**, not a widget. Root `CLAUDE.md`: *"CrystalOS never mutates app state… The frontend renders proposals as confirm-cards and only mutates on explicit user confirm."* Today that boundary is structural: proposals arrive as a typed side-channel (`crystal.py:1962-1965`), get normalised by a server-side authority (`_normalize_proposal`, `crystal.py:952-969`), and are dispatched through a closed 18-branch switch that fails loudly on anything unrecognised (`:1009-1011`).

Making them model-chosen tool calls moves type selection into the model's output distribution. The gate still renders, but the guarantee weakens: the model now influences *whether and how* the gate appears. And the drift surface widens on a seam that has **already drifted** — `ActionProposalType` (`app/src/types/index.ts:782-822`, 25 members) is the only enum anywhere, CrystalOS validates a free string, and `workflow`, `template`, `export_insights` (`:786,787,789`) are declared with no dispatcher case, silently falling to `default`. I do not want the model picking from a set that TypeScript alone enumerates.

### What I'd lose by keeping them out-of-band — stated honestly

1. **No interleaving.** Proposals will always render as a block after the answer (`:1368-1380`), never mid-prose next to the sentence that motivated them. That is a genuine UX ceiling and I accept it.
2. **No `toolCallId`.** So the outcome funnel stays keyed on `proposal.id`, and the missing `emitted` status (`CURRENT_STATE.md` §5 — `emitted` is never written, so emit→accept conversion is unmeasurable) remains a client-side synthesis rather than falling out of the protocol.
3. **`ChainOfThought` grouping will never include proposals.** Given §1's finding that grouping won't activate for Crystal's phases either, this costs nothing incremental.

### What I want from Priya instead — and it's cheaper than the tool-call reshape

**`message_id` and `turn_id` on the wire.** `CURRENT_STATE.md` #6, and `crystalos/routers/feedback.py:22` already wants a `turn_event_id` that is never emitted. One additive field per SSE frame unlocks, in order of value:

1. `emitted` becomes writable — the top of the AI-quality funnel stops being missing
2. Per-message feedback stops being fanned out across every cited insight ID (`:709-735` currently writes `api.updateInsightFeedback` once per citation, which is not the same thing as rating the answer)
3. Thread persistence keys on something real, which also resolves the `thread_key` vs `(org_id, user_id, survey_id, scope)` disagreement by making it moot
4. `handleCreateTicket`'s "Crystal message ID" diagnostic (`:1058`) stops being a client-side UUID with no server counterpart
5. Edit / regenerate / branch become *possible* later, framework or not

It is additive, backward-compatible, has one SSE consumer (`CURRENT_STATE.md` §8: *"the SSE contract has exactly one consumer"*), and is worth doing on its own merits with or without assistant-ui. **If Priya has budget for one contract change, spend it here, not on tool-call semantics.** I'd also note our positions likely converge: her mandate frames this as "the frontend's problem is actually a contract problem," and on this specific point she's right — §3 shows the library's marquee features are gated on identity we don't emit, which is exactly her finding, not mine.

---

## 8. Verdict

```
┌──────────────────────────────────────────────────────────────────┐
│  VERDICT:      DON'T                                             │
│  CONFIDENCE:   Moderate-high (~75%)                              │
│  SCOPE:        The chat surface — panel shell, composer, message  │
│                rendering, streaming timeline, empty/error states  │
└──────────────────────────────────────────────────────────────────┘
```

Against the five tests in `README.md`:

| # | Test | Result |
|---|---|---|
| 1 | Closes a gap a user hits today? | **No.** The three real gaps (markdown, a11y, persistence) are closed by §6, not by the library. The library's own gap-closers are either registry-copied code we'd own anyway, or a11y it doesn't document. |
| 2 | Replaces more code than it adds? | **No.** +1,015 LOC for the restructure alone; ~+2,065 vs ~+750 for equal outcome (§2). |
| 3 | Does the differentiated 40% survive? | **Degraded.** `CrystalThinkingBubble` (323) and the citation layer (325) become custom parts against a seam that rearchitected in v0.11 and v0.14. `executeAction` (268) is untouched — because the library models none of it. |
| 4 | Churn tax acceptable? | **No.** Three of four migrations rearchitected our two seams; the v0.12 hook API lived three minors; the load-bearing adapter sits on patch-release-`unstable_` surface (§4). |
| 5 | Incremental and reversible? | **Partly** — `ExternalStoreRuntime` genuinely allows a staged adoption. This is the one test it passes, and it isn't enough on its own. |

### The single strongest argument against my own verdict

**I costed the migration against today's gaps, and that framing systematically undervalues optionality.**

If Xperiq commits within two quarters to attachments, branch/edit/regenerate, a multi-thread history UI, TTS, and virtualization, then my +1,015 is a **one-time** payment against five features I'd otherwise hand-build at 400–600 LOC each — call it 2,000–3,000 LOC I'd be writing myself, worse, with no upstream fixes. On that roadmap the arithmetic inverts and `DON'T` becomes the expensive answer. `README.md`'s test #1 explicitly excludes "a gap we might have at 10x scale," and I followed it — but a chat chassis is exactly the kind of decision where the 3-year cost dominates the 3-month cost, and my analysis is structurally biased toward the near term.

Two secondary arguments against me: (a) the ~1,958 LOC of Crystal tests are proposal-focused and would largely survive, so my +480 test estimate may be pessimistic; (b) `convertMessage` is a pure function and therefore *more* testable than the `useState`-plus-effects tangle it replaces — the migration would probably improve testability of the one part of Crystal that is currently untested (streaming, citations, error states, per `CURRENT_STATE.md` §7).

### What would change my mind — specifically

1. **A 1.0 with the seam stabilised.** `createMessageConverter`, `capabilities`, and message metadata de-`unstable_`'d, plus a stated support window for the part-rendering API. That single change removes the whole of §4a.
2. **A written roadmap commitment** in `docs/PRODUCT_PLAN.md` to ≥3 of {attachments, branch/edit/regenerate, multi-thread history UI, TTS, virtualization} within two quarters. This is my own strongest counter-argument, made checkable.
3. **Priya lands `message_id`/`turn_id` first.** With server message identity, the §3 capability-gating table stops returning nothing, `onEdit`/`onReload` become implementable, and the honest LOC delta drops materially. I would re-run §2 from scratch. *This is the highest-value experiment on the list and it is worth doing regardless of the verdict.*
4. **A timeboxed spike, ≤3 days.** Render the **existing, unmodified** `CrystalThinkingBubble` and `ActionProposalCard` inside `ThreadPrimitive` + a `ToolCallMessagePartComponent`, and demonstrate the `citation_context` retro-enrichment path (`CrystalPanel.tsx:423-431`) surviving `convertMessage`. If the adapter comes in under 200 LOC and doesn't fight the runtime, my 655 estimate is wrong and so is my verdict. I would rather be proven wrong by a spike than argued with.

### What to do instead, in order

1. **Delete 679 LOC of dead chat code** — `IrisChat.tsx` (316), `pages/insights/ConversationView.tsx` (363). Zero importers. No decision required. Today.
2. **Fix `crystalIdentityTokens.test.ts:42-44`** to content-match `LAYER_COLORS` instead of the hardcoded `[[1733, 1738]]`. ~10 LOC. It will otherwise false-positive on step 4, and its own comment says so.
3. **A11y pass** — §6.2, ~110 LOC, ~2 days. The highest user-visible value per line in this entire assessment.
4. **Split the monolith** — §6.4, ~0 net LOC. This is what actually makes Crystal maintainable, and it fixes the `crystal-spin` bug in passing.
5. **Markdown** — §6.1, `react-markdown` + `remark-gfm`, ~120 LOC.
6. **Ask Priya for `message_id`/`turn_id`** (§7), then wire persistence onto the endpoint that already exists (§6.3).
7. **Revisit this decision when items 1–6 are done.** By then Crystal is nine small files with a clean a11y baseline, markdown, and real message identity — and adopting `ExternalStoreRuntime` at that point is a genuinely incremental, one-file experiment instead of a rewrite. That ordering costs nothing and preserves the option; the reverse ordering does not.

**A separate note for Theo:** `XperiqCopilot` (`ExperientCopilot.tsx`, 616 LOC, its own `ChatMessage` type at `:53-60`, its own message state at `:117-128`, its own ⌘K at `:146-156`, suppressed globally by `AppShell.tsx:43,64-65,101-103`) is his call, but it bounds mine. Any migration that leaves it in place **doubles** the chat surface under maintenance instead of halving it, and it would have to be migrated too or permanently diverge. That roughly doubles §2's numbers. It should be decided before, not after.
