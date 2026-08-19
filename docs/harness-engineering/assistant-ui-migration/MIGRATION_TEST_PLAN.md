# Crystal → assistant-ui: Migration Test & Release Plan

> **Owner:** Sam Okafor — Staff Engineer, Test Strategy & Progressive Delivery
> **Layer:** qa / infra · **Mandate:** `TEAM.md` §4 (member 4)
> **Date:** 2026-08-04 · **Status:** Plan. No production code, no test files written.
> **Charter:** `README.md` (gates G0–G4). **The migration is decided; this document makes it safe.**

---

## 0. Executive summary

Nine findings, each independently verified against source. The five in bold change the plan.

1. **The coverage-gap claim is correct but the numbers are wrong in both directions.** Crystal's app-side test surface is **1,776 LOC across 6 files**, not 1,958 across 7 (§1.1). And the pod **missed 960 LOC of backend tests entirely** (`backend/src/__tests__/*.test.js`), which *do* cover the Express SSE bridge — its request body, tag scoping, credit gating, and the 402 path (§1.2). Real total: **~2,736 LOC**. This is good news: it means the bridge contract is already pinned and survives the migration untouched.
2. **Every zero-hit claim in the assessments is confirmed.** `citation_context`, `CitedText`, `SourcesFooter`, `CrystalThinkingBubble`, `EmptyState`, `SpeechRecognition`, `crystal-spin`, `observation`, `synthesizing` — zero hits across all 111 app test files and all 93 backend test files (§1.3).
3. **assistant-ui's cadence is resolved, and it is the fast answer.** v0.11 → v0.15 spanned **323 days, not years**. 433 published versions in 27 months; **31 releases in the last 90 days** (one every ~2.9 days). Breaking-minor intervals are **accelerating**: 138 → 103 → 82 days. Current version `0.15.4` shipped **2026-08-03 — one day before the migration decision**. Projected next breaking minor: **mid-October 2026**, i.e. *inside* the G1–G3 window (§6.1). The runbook assumes one breaking upgrade lands mid-migration, because it will.
4. **The funnel is worse than `FINDINGS.md` §5 reports, in a way that makes the stated gate impossible as written.** Beyond the title-slug `proposal_key`: the unique index is `(org_id, proposal_key)` and **omits `survey_id`**, so the same proposal title on two different surveys in one org collapses to one row; `DO UPDATE SET` never updates `survey_id`/`type`/`params`, so they are frozen at first insert; `emitted_at DEFAULT NOW()` is never refreshed, so the time series is wrong. And **`track('accepted')` and the terminal `track()` are both un-awaited fire-and-forget POSTs with zero `await` between them on 11 of 18 dispatcher branches** — a same-tick race. **The baseline is non-deterministic, so "prove non-regression by comparing to baseline" cannot be done by equality.** §4 replaces it with invariant assertions plus a fixed key.
5. **The one existing funnel test pins the defect as correct behaviour.** `backend/src/__tests__/crystalProposals.test.js:70` asserts `expect(sql).toContain('ON CONFLICT (org_id, proposal_key)')` and that a second POST's status overwrites the first. Fixing the bug turns this test red; the naive reaction to a red test is to revert the fix. It must be rewritten *in the same commit* as the fix, deliberately (§4.4).
6. **`CRYSTAL_STREAMING` is not a feature-flag precedent — it is an anti-precedent, and it has already rotted three ways.** `CrystalPanel.tsx:29` is `const CRYSTAL_STREAMING = true`, a compile-time constant. Its dead branch left **57 LOC of unreachable legacy transport** (`:584-640`), and `app/vitest.config.ts` **still injects `VITE_CRYSTAL_STREAMING: 'true'`** for an env var `app/CLAUDE.md` states no longer exists. My flag design is explicitly shaped to not repeat this (§3).
7. **`scripts/check-i18n.mjs` has two defects, not one.** It is absent from `ci.yml` — *and it never sets an exit code* (`:49-50` are `console.log` only). Wiring it in as both assessments recommend would add a step that **can never fail the build**. Also `app/vitest.config.ts` has **no coverage `thresholds` block**, so `npm run test:coverage` in CI cannot fail on a coverage drop — during a migration that deletes a 2,799-line file, that is the exact gate we need (§9).
8. **The styled-first directive rests on an untested CSS-cascade invariant.** Theo's Tailwind-v4 proof is correct, but it depends on `theme.css` being imported **unlayered** at `app/src/index.css:2`. Nothing in the repo tests this. **G0's styled-vs-headless measurement is invalid until that invariant is pinned** (§7.4), because a false "styled components inherit our brand" result would be indistinguishable from a true one.
9. **The `citation_context` retro-enrichment test must be two-turn or it proves nothing.** `experience.ts:781-782` emits the event only when the map is non-empty, *before* the upstream call — so on turn 1 `prev.length === 0` and `CrystalPanel.tsx:424` returns early. A single-turn test passes trivially against both the working and the broken implementation (§2.3).

**My cost, honestly: ~30 working days of QA/release engineering across P0–G4** (§10), of which **11 land before G0 opens**. That front-loading is the whole argument: characterisation tests written after a component moves are not characterisation tests, they are documentation of the new behaviour.

**Product decisions I cannot make** are collected in §10.4. The largest is the one `TEAM.md:128` predicted: **G3's internal ordering cannot be sequenced by user value because there is no PM.** I refuse to resolve it by engineering default and instead specify G3 as four independently flag-gated slices in any order (§5.4).

---

## 1. The coverage gap map

Method: `grep`/`wc` over all 111 `app/src/**/*.test.{ts,tsx}` and all 93 `backend/src/__tests__/*.test.js` files. Every count below is re-derived, not quoted.

### 1.1 What the app-side Crystal test surface actually is

| File | LOC | What it covers |
|---|---|---|
| `app/src/__tests__/components/CrystalPanel.test.tsx` | 1,326 | Proposal execution (18 branches), request-body shape, brand tokens, 2 pure functions |
| `app/src/__tests__/components/CrystalPanelReportProposals.test.tsx` | 75 | Report-proposal dispatch |
| `app/src/__tests__/contexts/crystalPanel.test.tsx` | 113 | `openCrystal`/`setScope`/`setCrystalData` façade |
| `app/src/__tests__/lib/crystalIdentityTokens.test.ts` | 72 | 7 banned hex strings in 3 files |
| `app/src/__tests__/components/workflow-builder/AskCrystalFab.test.tsx` | 120 | The builder FAB (not the panel) |
| `app/src/__tests__/components/three/NLThinkingCrystal.test.tsx` | 70 | 3D accent colour resolution |
| **Total** | **1,776** | |

**Correction:** `TEAM.md:103`, `FINDINGS.md:188`, `ASSESSMENT_CRYSTAL_UI.md:287` and `:474` all cite **"~1,958 LOC across 7 files."** The four files named in `TEAM.md` sum to **1,586**; all six Crystal-touching files sum to **1,776**. The 1,958 figure is not derivable from any grouping of files in the repo. Use 1,776.

### 1.2 The 960 LOC of backend tests nobody counted

| File | LOC | What it covers |
|---|---|---|
| `backend/src/__tests__/experience.test.js` | 410 | `POST /api/experience/:scope/crystal/stream` — scope validation, tag org-scoping (fails closed), credit metering, **402 before headers** |
| `backend/src/__tests__/experienceCrystalStreamBuilderContext.test.js` | 330 | Byte-identical request-body regression, `workflow_registry` attach, builder-draft relay, 402 ordering |
| `backend/src/__tests__/crystalProposals.test.js` | 220 | The proposal-outcome upsert endpoint — **and it pins the defect (§4.4)** |
| **Total** | **960** | |

These exist because backend tests are `.test.js`, not `.test.ts` (`backend/CLAUDE.md`, "Testing"), and a `*.test.ts` glob misses all 93 of them.

**Why this matters to the plan:** the migration swaps the *frontend chassis*. It does not touch `backend/src/routes/experience.ts`. So **960 of the ~2,736 LOC (35%) survive the migration completely untouched and continue to guard the wire contract on the server side.** That is real, already-paid-for safety, and it removes the need to re-characterise the request body from the client — `experienceCrystalStreamBuilderContext.test.js:112` already asserts byte-identical `agentBody`.

What they do **not** cover: the *response* side. No backend test asserts that `citation_context` is injected, that it precedes the upstream fetch, or that it is suppressed when the map is empty.

### 1.3 Confirmed zero-coverage surfaces

Searched across all 111 app test files **and** all 93 backend test files:

| Symbol / behaviour | Test files with a hit | Verdict |
|---|---|---|
| `citation_context` | **0** | confirmed (source + `coverage/` HTML artefacts only) |
| `CitedText` | **0** | confirmed |
| `SourcesFooter` | **0** | confirmed |
| `CrystalThinkingBubble` / `ThinkingBubble` | **0** | confirmed |
| `EmptyState` | **0** | confirmed |
| `SpeechRecognition` / `webkitSpeechRecognition` | **0** | confirmed |
| `observation` (SSE type) | **0** | confirmed |
| `synthesizing` (SSE type) | **0** | confirmed |
| `crystal-spin` | **0** | confirmed — the landmine in §8.1 is entirely unguarded |
| `verbatim` | 5 files, **0 Crystal** | `MetricHeadlineCard`, `triggerGroups`, `builderCanvas`, `SurveyReportPage`, `WorkflowBuilderPage` — none is the Crystal citation path |
| `thinking` | 1 file, **0 Crystal** | `WorkflowNLBuilderPage.test.tsx` only |
| `402` | 3 files, **0 Crystal panel** | `ManualRunDialog`, `CustomAnalysisPage`, `InsightDocumentCard` (a length assertion) |
| `ReadableStream` / `[DONE]` | 1 file | `CrystalPanel.test.tsx:162-174` — the harness exists but is used **only** to deliver `answer` + `action_proposals` |

### 1.4 The definitive list of production behaviours that will fail silently

Ranked by (blast radius × silence). "Silent" means: no test fails, no type error, no runtime exception — the feature just stops working and looks plausible.

| # | Behaviour | Source | Silent failure mode |
|---|---|---|---|
| **1** | `citation_context` retro-enrichment of message N−1 | `CrystalPanel.tsx:419-431` | Sources footer on the *previous* answer silently loses headlines/verbatims. Looks like "Crystal didn't cite anything this time." |
| **2** | Inline `[uuid]` parse + strip | `:441-447`, `parseInlineCitations:1719`, `buildCitationsFromAnswer:1680`, `resolveId:1663` | Raw UUIDs appear in prose, or citations vanish. Two sub-modes: single-`[uuid]` left in text for `CitedText`, multi-UUID blocks stripped into `extraIds`. |
| **3** | Two citation display strategies | `getCitationStrategy:1902`, `SourcesFooter:1934` | `responses-only` (survey scope) vs `attributed` (org scope) silently swap. Org answers stop naming their source survey — a trust regression, not a crash. |
| **4** | `CrystalThinkingBubble` phase timeline | `:2219-2540`; steps `:2250-2295`; ticker `:2243-2247`; coalescing `:2256-2269`; dup-`synthesizing` guard `:2279-2281` | Steps duplicate, never complete, or the elapsed timer freezes. Users read it as "Crystal is slow." |
| **5** | REST fallback when stream closes with no `answer` | `:486-556` (`answerReceived` bookkeeping at `:391`, `:439`, `:465`) | Empty turn. No error, no message, no log. The single most invisible failure in the file. |
| **6** | Five error surfaces (not three — see below) | `:464-477`, `:557-575`, `:545-554` | Wrong copy, or the generic fallback masking a 402. Users are told "something went wrong" when they are actually out of credits. |
| **7** | `crystal-spin` cross-component keyframe | defined `:2303-2334`, consumed `:2783` | Apply spinner is a static ring. Already broken today when no thinking bubble has mounted (§8.1). |
| **8** | Voice input | `:678-703` (`:679` ctor, `:694` `onresult`) | Mic button does nothing on browsers without the API, or transcript never lands in the composer. |
| **9** | `EmptyState` + dynamic prompts | `:1543-1583`, `SINGLE_PROMPTS`/`ALL_PROMPTS` `:153-165`, mount `:1337` | Wrong prompt set for scope, or a blank panel on open. |
| **10** | `documents[]` → `InsightDocumentCard` | `:416`, `:449`, `:459`, `:2109` | Unreachable today (no server emitter). If it is ever emitted, nothing proves it renders. |
| **11** | Support-mode classification + transport switch | `classifyAsSupport:88-151`, escalation `:1382-1412`, doc thumbs `:1414-1451` | *Partially* covered — `CrystalPanel.test.tsx:1250-1299` tests `classifyAsSupport` as a pure function, but nothing tests the transport switch or the escalation card. |
| **12** | Thumbs fan-out to `api.updateInsightFeedback` per citation | `:709-735` | Feedback silently stops being recorded. Feeds nothing user-visible, so nobody notices for months. |

**Correction to the brief:** there are **five** reachable error surfaces, not three. Enumerated precisely, because §2.6 has to cover all of them:

| # | Surface | Reached by | Copy |
|---|---|---|---|
| E1 | SSE `error` frame | `experience.ts:800` (`!agentRes.ok`) or `:828` (stream throw), or CrystalOS `crystal.py:1808/1812/1992`, `main.py:1806` → handled at `CrystalPanel.tsx:464-477` | server text, rendered verbatim, untranslated |
| E2 | catch → out of credits | `response.ok === false` with 402 → `throw new Error('HTTP 402')` at `:383` → `includes('402')` at `:558` | "You're out of AI credits…" |
| E3 | catch → service down | `fetch()` rejects (`includes('fetch')`) or `HTTP 503`/`HTTP 502` at `:383` → `:559-561` | "The agents service isn't reachable…" |
| E4 | catch → generic | anything else, e.g. `throw new Error('No response stream')` at `:388` | "Something went wrong…" |
| E5 | REST-fallback catch | `api.crystalChat2` rejects inside the `!answerReceived` block → `:545-554` | "Crystal is unavailable right now. Make sure the agents service is running." |

E1 and E5 are structurally invisible to a test that only exercises the `catch` block. Note E1 arrives on an **HTTP 200** stream and sets `answerReceived = true` at `:465` specifically to suppress E5 — that interaction is untested and is exactly the kind of thing a chassis swap breaks.

---

## 2. Characterisation tests to write BEFORE anything moves

**Gate rule: G0 does not open until §2 is green on `main`.** These tests pin *current* behaviour, including behaviour we consider wrong. Where behaviour is wrong, the test asserts the wrong thing and carries a `// CHARACTERISATION:` comment naming the defect and the gate that fixes it. That is deliberate: a characterisation suite that quietly "fixes" behaviour while pinning it cannot detect a regression.

All new files live at `app/src/__tests__/components/crystal/`. Total: **~700 LOC new**, 6 working days.

### 2.1 The SSE test-harness approach (specified, because this is the load-bearing decision)

The panel uses raw `fetch` + manual `ReadableStream` parsing (`CrystalPanel.tsx:336-380` request, `:386-482` reader loop), **not `EventSource`**. Consequences for the harness:

**Decision: extend the existing `makeSseStream` helper (`CrystalPanel.test.tsx:162-174`). Do not introduce MSW.**

Rationale: MSW would add a dependency and a second mocking paradigm for zero gain — the panel reads `response.body.getReader()` directly, so a `vi.fn()` returning `{ ok, body }` is a complete and honest fake of everything the code under test touches. `jsdom ^29.1.1` provides `ReadableStream` and `TextEncoder` natively (already relied on at `:168`, `:170`). MSW earns its keep for request *matching* across many endpoints; here there is exactly one endpoint and one consumer (`CURRENT_STATE.md` §8: "the SSE contract has exactly **one** consumer").

The existing helper is insufficient in five ways. The replacement, `app/src/__tests__/components/crystal/sseHarness.ts` (~120 LOC):

| Capability | Why the current helper can't | Shape |
|---|---|---|
| **Chunk-boundary control** | `:168-172` enqueues the whole payload in one chunk and closes. The reader's `buffer`/`lines.pop()` logic at `:390`, `:398-399` — which reassembles a `data:` line split across chunks — is therefore **never exercised**. | `makeSseStream(frames, { splitAt: number[] })` — enqueue byte ranges, including a split mid-JSON and mid-`[DONE]` |
| **Ordered async delivery** | Everything arrives before the first `read()`, so ordering assertions are vacuous | `enqueueSequence(frames)` with a controllable release step, so a test can assert state *between* frames (required for the thinking timeline and for §2.3) |
| **Stream end without `[DONE]`** | `trailingDone = false` exists but no test uses it | required for §2.5 — and note `experience.ts:800`/`:828` genuinely never write `[DONE]` |
| **Malformed frames** | untested | `:478-480` swallows JSON parse errors silently. A frame of `data: {not json` must be proven harmless, and a frame with a `type` the client doesn't know must be proven inert |
| **Non-OK and rejecting fetch** | untested | `mockFetch({ ok: false, status: 402 })` and `mockFetch(Promise.reject(new TypeError('Failed to fetch')))` for E2/E3 |

Two harness invariants worth stating, because they are easy to get wrong and will produce false-green tests:

- **Frames are `data: `-prefixed with a single `\n` join in the existing helper (`:166`), but the real servers write `\n\n`** (`experience.ts:782`, `main.py:1797`). The reader splits on `'\n'` (`:398`) and skips non-`data:` lines (`:401`), so both work — but the harness must emit `\n\n` to match production, or a future reader that requires blank-line framing will pass in test and fail in prod.
- **`[DONE]` is a raw string, not JSON** (`:403`, checked *before* `JSON.parse`). A harness that JSON-encodes it produces `data: "[DONE]"`, which fails the `=== '[DONE]'` check and silently falls through to the parse branch. Assert the raw form.

Additional stubs the suite needs, none currently in `app/src/test/setup.ts`:

- `crypto.randomUUID` — used at `:453`, `:471`, `:537`, `:550`, `:566`. Stub with a deterministic counter so message-identity assertions are stable. (This also becomes the seam that proves G1's server-minted IDs are adopted.)
- `window.SpeechRecognition` / `window.webkitSpeechRecognition` — a fake ctor exposing `onresult`/`start`/`stop`, for §2.7. `setup.ts` currently stubs only `ResizeObserver`.
- Fake timers for the 100 ms elapsed ticker at `:2243-2247`.

### 2.2 All 8 SSE event types

`app/src/__tests__/components/crystal/sseEvents.test.tsx` — ~180 LOC, 22 cases.

| Event | Source | Assertions to pin |
|---|---|---|
`citation_context` | `experience.ts:782` | map merges into `citationMapRef` (`:420-422`); merge is `{...prev, ...new}` so a second event **adds without clearing**; retro-enrichment → §2.3 |
`thinking` | `crystal.py:1931` | `streamingState.phase === 'thinking'`, `tool` and `message` both carried (`:432-433`); a `thinking` with no `tool` must not crash `TOOL_META[step.tool]` (`:2423`) |
`observation` | `crystal.py:1941`, `:1947` | `phase === 'observation'`, `summary` carried (`:434-435`); a 200-char truncated summary renders without overflow (`:2504-2507`) |
`synthesizing` | `crystal.py:1952` | `phase === 'synthesizing'`, **no `tool`, no `message` consumed** (`:436-437` ignores `event.message` — pin this; `main.py:1802` omits `message` entirely while `crystal.py:1952` includes it, and the client reads neither) |
`action_proposals` | `crystal.py:1962-1965` | `setActionProposals` (`:462-463`); **empty `proposals: []` is a no-op** (guarded by `event.proposals?.length`) — pin it, because it means a server that clears proposals cannot; and **arrival BEFORE `answer` must still render** (ordering per `crystal.py:1962` before `:1968`) |
`answer` | `crystal.py:1968-1974` | `answerReceived = true` (`:439`), `streamingState` cleared (`:440`), message appended with `citations`/`suggestions`/`documents` (`:450-461`); `documents: []` → `undefined` not `[]` (`:459`); **3-key vs 4-key answer frames both work** (`main.py:1804` omits `insight_refs`) |
`error` | 4 sites (§1.4 E1) | `answerReceived = true` (`:465`) — **which suppresses the REST fallback**; `streamError` set (`:467`); message appended with the server's text verbatim (`:473`); missing `message` → `'An error occurred'` for `streamError` but `'Something went wrong. Please try again.'` for the bubble (two *different* defaults — pin both) |
`[DONE]` | `main.py:1807` | sets `streamDone`, `break`s the inner loop (`:403`); **frames after `[DONE]` in the same chunk are dropped** — pin it; and `[DONE]` with no prior `answer` triggers §2.5 |

Plus 3 negative cases: malformed JSON is swallowed (`:478-480`); an unknown `type` is inert; a non-`data:` line is skipped (`:401`).

### 2.3 `citation_context` retro-enrichment — the two-turn test

`app/src/__tests__/components/crystal/citationRetroEnrichment.test.tsx` — ~120 LOC.

**This is the highest-value test in the plan and the easiest to write wrong.**

`experience.ts:781-782` emits `citation_context` **before** the upstream fetch (`:789`) and **only when the map is non-empty**. So it is always the first frame of turn *N*, and its consumer at `CrystalPanel.tsx:423-431` rewrites the last *already-rendered* crystal message — which is the answer from turn *N−1*.

On turn 1, `prev.length === 0`, so `:424` returns `prev` unchanged. **A single-turn test therefore passes identically against a working implementation and against one where `:423-431` has been deleted.** It proves nothing.

Required shape:

1. Turn 1: stream `[answer{ answer: 'NPS fell. [<uuid-a>]', citations: ['<uuid-a>'] }]` with **no** preceding `citation_context`. Assert the rendered message has a citation with `id: '<uuid-a>'` and **no `headline`** — i.e. bare.
2. Turn 2: stream `[citation_context{ map: { '<uuid-a>': { headline: 'Onboarding friction', survey_title: 'Q3 NPS', verbatims: [...] } } }, answer{...}]`.
3. **Assert message N−1 (turn 1's answer) now renders `'Onboarding friction'`.** This is the behaviour that dies silently.
4. Assert `enrichCitationsFromMap` (`:1671`) ran through `resolveId` (`:1663`), i.e. an 8-char short id in the message resolves against a full-UUID map key.

Four guard cases that pin the early-return conditions at `:424-426` — each is a live branch and each must stay a no-op:

- `prev.length === 0` → no-op (turn 1)
- last message `role === 'user'` → no-op (proposal accepted between turns, `note()` not yet fired)
- last crystal message has `citations: []` or undefined → no-op
- second `citation_context` in a later turn **merges** rather than replaces (`:420`) and re-enriches with the union

**Then the one that is currently a defect** — pin it as-is, with a comment:

- `citation_context` retro-enriches **only** message N−1, not N−2 or earlier. A three-turn conversation where the map for turn 1's citation arrives on turn 3 leaves turn 1 permanently bare. `// CHARACTERISATION: only the last message is enriched (CrystalPanel.tsx:425). Fixing this is out of scope; G2 must preserve it exactly.`

### 2.4 Inline citation parsing and the two display strategies

`app/src/__tests__/components/crystal/citationRendering.test.tsx` — ~140 LOC.

Pure-function layer first (cheap, high value, and these move into `convertMessage` unchanged per `ASSESSMENT_CRYSTAL_UI.md:83`):

- `parseInlineCitations` (`:1719`): single `[uuid]` **left in text** for `CitedText` to render inline; single `[8-char]` also left; multi-UUID blocks **stripped** and returned as `extraIds`. Assert both the returned `text` and `extraIds` for: zero markers, one full UUID, one 8-char, a 3-UUID block, a mixed case, a malformed `[not-a-uuid]` (must be left alone), and a marker at string start/end.
- `resolveId` (`:1663`): 8-char → full UUID via map; unknown id → returned unchanged, lowercased.
- `buildCitationsFromAnswer` (`:1680`): dedupe by resolved id; ordering; `insight_refs` ∪ `citations` ∪ `extraIds` ∪ in-text markers (the four-source union at `:506-533` in the REST path, and its narrower SSE cousin).
- `enrichCitationsFromMap` (`:1671`): merge semantics, missing keys.

Rendering layer:

- `CitedText` (`:1836`) emits plain `<span>`s and `InlineCitation` nodes. **Pin that markdown does not render** — `**bold**` appears literally. This is the behaviour G3 deliberately changes; without a pinned "before", nobody can prove the "after" is the only thing that changed.
- `InlineCitation` (`:1745`) tooltip: hover *and* focus both open it (`:1761-1764`); the single `aria-*` in the file is at `:1765`; **Escape does not dismiss** — pin as characterisation.
- `SourcesFooter` (`:1934`) × `getCitationStrategy` (`:1902`): `isAll === false` → `'responses-only'`, verbatims shown directly via `VerbatimList` (`:1907`); `isAll === true` → `'attributed'`, survey title shown per citation. Assert the *strategy-visible difference*, not just that something rendered — a chassis swap that hardcodes one strategy passes any weaker assertion.
- `withData` filter at `:1939`: a citation with neither `headline` nor `verbatims` is excluded from the footer.

### 2.5 REST fallback when the stream closes with no `answer`

`app/src/__tests__/components/crystal/restFallback.test.tsx` — ~90 LOC.

The `!answerReceived` guard at `:486` and the block at `:487-556`.

| Case | Setup | Assert |
|---|---|---|
| Fallback fires | stream = `[thinking, observation]` then close, **no `[DONE]`** | `api.crystalChat2` called once with `(query, { surveyId, focusedTopic, conversationHistory })` (`:492-496`) |
| Fallback fires after `[DONE]` | stream = `[[DONE]]` only | same — `[DONE]` alone does not count as an answer |
| Fallback suppressed by `answer` | stream = `[answer]` | `crystalChat2` **not** called |
| **Fallback suppressed by `error`** | stream = `[error]` | `crystalChat2` **not** called — `:465` sets `answerReceived = true`. This is the E1↔E5 interaction from §1.4 |
| REST `citation_map` merges | `crystalChat2` returns `citation_map` | merged into state *before* citations are built (`:497-503`) |
| Four-source ID union | `crystalChat2` returns `insight_refs` + string `citations` + a multi-UUID block + an in-text `[uuid]` | all four reach `citations[]`, deduped (`:506-533`); note `citations` entries that are **not strings** are filtered out at `:524` |
| E5 | `crystalChat2` rejects | exactly the copy at `:551` |

Also pin: the fallback runs `messages.map(...)` at `:488` over the **closure-captured** `messages`, not the post-user-message array — so the user's own turn is absent from the history it sends. `// CHARACTERISATION: stale closure at CrystalPanel.tsx:488.`

### 2.6 The five error surfaces

`app/src/__tests__/components/crystal/errorStates.test.tsx` — ~80 LOC. One case per surface E1–E5 from §1.4, asserting the **exact user-visible string**, plus:

- `streamingState` is cleared on every path (`:466`, `:562`)
- `isThinking` is cleared in `finally` (`:577`)
- **`invalidate('credits')` fires in `finally` on every path including errors** (`:579`) — a real behaviour with a cross-feature consequence (the credits pill), and a plausible casualty of moving `onNew` into a runtime adapter
- E1 and E4 produce *different* copy for the same underlying failure, which is why E1 must be distinguished

### 2.7 The `CrystalThinkingBubble` phase timeline

`app/src/__tests__/components/crystal/thinkingTimeline.test.tsx` — ~110 LOC. Fake timers required.

The bubble is a **sibling** of the message list, mounted on `isThinking` at `:1361` and fed a `streamingState` prop. Its internal step accumulation (`:2250-2295`) is the part `ASSESSMENT_CRYSTAL_UI.md:106` says "moves into `convertMessage` — that's a rewrite of the seam, not a port." So this suite is the only thing that will catch the rewrite going wrong.

| Behaviour | Source | Assertion |
|---|---|---|
| One step per `thinking` | `:2250-2295` | 3 distinct tools → 3 steps, in arrival order |
| Same-tool coalescing | `:2256-2269` | `thinking(get_x)` → `observation(get_x)` → `thinking(get_x)` produces **one** step, not two |
| Duplicate `synthesizing` guard | `:2279-2281` | two `synthesizing` frames → one step |
| `completedAt` set on `observation` | `:2214-2215` | step shows a duration; `doneSteps` (`:2299`) increments |
| Elapsed ticker | `:2243-2247` | advance 300 ms → label updates; **unmounting clears the interval** (leak check) |
| `TOOL_META` label fallback chain | `:2423`, `:2433-2436` | known tool → `TOOL_META.label`; unknown tool → `step.message`; no message → `'Reasoning'`; `phase==='observation'` → `'Processing results'`; `phase==='synthesizing'` → `'Synthesising answer'` |
| Progress bar | `:2518-2535` | `doneSteps / totalSteps` |
| Orb animation switches | `:2343-2345` | `crystal-pulse` while synthesizing, `crystal-spin` otherwise |
| **Keyframes are present in the DOM** | `:2303-2334` | see §8.1 — this assertion is the landmine guard |
| Unmount on `answer` | `:1361` (`isThinking`) | bubble gone once the answer renders |

### 2.8 Voice input and empty state

`app/src/__tests__/components/crystal/voiceAndEmpty.test.tsx` — ~60 LOC.

- `handleMic` (`:678-703`): missing ctor → early return, **no crash** (`:679-680`); `onresult` transcript lands in the composer (`:694`); a second click stops; `recognitionRef` (`:215`) cleanup on unmount.
- `EmptyState` (`:1543`): renders on `messages.length === 0` at `:1337`; `SINGLE_PROMPTS` vs `ALL_PROMPTS` selected by scope (`:153-165`); clicking a prompt calls `submitQuery`.

---

## 3. Feature-flag and rollback design

### 3.1 Why `CRYSTAL_STREAMING` is the wrong precedent

The brief names `CrystalPanel.tsx:29` as precedent. It is precedent for **how not to do this**:

```ts
// CrystalPanel.tsx:27-29
// Streaming is always enabled — no env flag needed.
// Falls back to REST only when the streaming endpoint is unreachable.
const CRYSTAL_STREAMING = true;
```

It is a compile-time constant, so `if (CRYSTAL_STREAMING)` at `:316` always takes the true branch and `return`s at `:581`. Everything from `:584` to `:640` — the entire legacy non-stream transport, 57 LOC — is **statically unreachable**. Downstream: `crystal_threads` v1 is written only from that dead branch (`insights.ts:1463-1475`), which is why `ASSESSMENT_CRYSTALOS.md:187` calls it "statically dead." And `app/vitest.config.ts` still sets `VITE_CRYSTAL_STREAMING: 'true'` for an env var `app/CLAUDE.md` says no longer exists.

Three separate rot artefacts from one flag. **The lesson is not "don't flag" — it is "a flag needs an owner, an expiry, and a test that runs both branches."**

The *good* precedent is the one the brief also names: `AppShell.tsx:43` + `:119-121`. Route-conditional mounting of two mutually exclusive chat surfaces already ships and works.

### 3.2 The flag

**Name:** `crystal_chassis` · **Values:** `'legacy' | 'assistant_ui'` · **Default:** `'legacy'` until G4.

Not a boolean. A boolean named `use_assistant_ui` invites `!useAssistantUi` scattered across the tree; a two-valued enum forces every consumer through one resolver and makes a third value (e.g. `'assistant_ui_headless'`) additive rather than a refactor.

**Mechanism — recommendation: per-org, server-resolved, with an env override.**

Rejected alternatives, with reasons:

| Option | Verdict |
|---|---|
| Build-time const (`CRYSTAL_STREAMING` style) | **No.** Cannot roll back without a deploy. Rots (§3.1). |
| `import.meta.env.VITE_CRYSTAL_CHASSIS` | **No as the only mechanism.** Same deploy-to-roll-back problem, and it cannot express "one org on the new panel." Keep it as a *local-dev override only*. |
| Per-user | **No.** Crystal's grounding corpus is per-org (`insights[]`, `topics[]` uploaded per turn, `CrystalPanel.tsx:347-348`) and the funnel is keyed `(org_id, proposal_key)` (`insights.ts:2317`). A per-user split puts two chassis' outcomes in **one org's funnel rows under one key** — it would corrupt the very metric §4 exists to protect. |
| **Per-org, server-resolved** | **Yes.** Matches the funnel's grain exactly, so a cohort comparison is clean. Rollback is a DB update, no deploy. Xperiq already has org-level config precedent (`org_insight_defaults`, plan tiers). |

**Wire:** extend the existing org-profile response the frontend already fetches on boot (`BrandProvider` → org profile). Add `crystal_chassis TEXT NOT NULL DEFAULT 'legacy'` to `org_profiles` **with a CHECK constraint** — unlike `crystal_action_proposals.status`, which has none (`20260623000010:17`) and is the subject of §4. Read it through one resolver:

```
app/src/lib/crystalChassis.ts        // resolve(): 'legacy' | 'assistant_ui'
                                     // precedence: VITE override (dev only) > org profile > 'legacy'
```

Exactly one consumer, mirroring the existing pattern at `AppShell.tsx:119-121`:

```tsx
{/* AppShell.tsx ~:119-121 */}
{!isBuilder && (
  chassis === 'assistant_ui'
    ? <CrystalPanelAUI scope={scope} surveys={surveys} insights={null} />
    : <CrystalPanel    scope={scope} surveys={surveys} insights={null} />
)}
```

Both components take **the identical prop signature** and both sit inside the same `CrystalPanelProvider` (`AppShell.tsx:159`). This is what makes the flag cheap: `openCrystal(query?, ctx?)` is the contract, all 50 call sites across 22 files are unchanged in both branches (`CURRENT_STATE.md` §7), and the 20-member context is untouched.

**Provider-ordering constraint** (Theo's finding, `ASSESSMENT_XPERIQ_UI.md:330`): `AssistantRuntimeProvider` must nest **inside** `CrystalPanelProvider` and **outside** `CrystalPanelAUI`. It must therefore live inside `CrystalPanelAUI`, not in `AppShell` — otherwise the legacy branch pays for a runtime it never uses, and `isBuilder` suppression has to be duplicated. **Put the provider in the new component. Do not touch `AppShell` beyond the three-line ternary above.**

### 3.3 What is lost on a flip

Honest inventory. Live conversation state is one `useState` array (`CrystalPanel.tsx:196`) and nothing persists (`CURRENT_STATE.md` §4).

| State | Lost on flip? | Notes |
|---|---|---|
| Message thread | **Yes, entirely** | Already lost on every navigation — `AppShell.tsx:56-58` force-closes the panel. So a flip is no worse than clicking a link. **This is why per-org flag flips are safe and why we should not fix `:56-58` before G4.** |
| `citationMap` | Yes | Rebuilt on the next turn's `citation_context` |
| `actionProposals` | Yes | **Consequence:** a proposal on screen at flip time is never `dismissed` and never `accepted` → no row, or a row stuck at whatever it last was. At G3+ scale this is a real funnel artefact; §4.5 accounts for it |
| In-flight SSE request | Yes, and **not aborted** | There is **no `AbortController` in `CrystalPanel.tsx`** (verified: 0 matches). Unmount leaves the reader loop running against a dead component → React state-update-on-unmounted warnings, and the backend keeps streaming (its own abort at `experience.ts:785-786` only fires on socket close). **`onCancel` is net-new work in both paths** (`ASSESSMENT_CRYSTAL_UI.md:157`) |
| Panel open/closed, scope, `crystalCtx` | **No** | Held in `CrystalPanelProvider`, above the flag boundary |
| Credits pill freshness | No | `invalidate('credits')` at `:579` |

**Flip is safe by construction because nothing durable exists.** Do not add persistence before G4 — persistence is what would make a flip destructive. If G3 ships persistence (§5.4), a chassis flip must clear the thread rather than attempt to read the other chassis' rows; specify that in the persistence slice.

### 3.4 Kill-switch path per gate

| Gate | Who is on `assistant_ui` | Kill switch | Time to restore | Blast radius while broken |
|---|---|---|---|---|
| **G0** | nobody — spike on a branch, never merged to `main` behind a flag | delete the branch | n/a | zero |
| **G1** | nobody — contract work only; both chassis consume the new fields | revert the contract PR; **`turn_start`/`turn_id` must be additive so the legacy panel ignores unknown fields** | one deploy | zero if additive. The test that proves additivity is §5.2 |
| **G2** | internal orgs only (dev-org + 1 staff org) | `UPDATE org_profiles SET crystal_chassis='legacy'` | **< 1 min, no deploy** | staff only |
| **G3** | opt-in pilot orgs (target 3–5) | same UPDATE, per-org | < 1 min | pilot orgs, one turn |
| **G4** | default `'assistant_ui'`; column retained | flip the **default** back (`ALTER COLUMN ... SET DEFAULT 'legacy'`) + bulk UPDATE | < 5 min while the old panel still exists | all orgs, one turn |
| **post-G4** | old panel deleted | **none — this is the point of no return** | n/a | n/a |

**Two hard rules.**

1. **The old panel is not deleted at G4. It is deleted at G4+30 days**, after the flag has been default-on with zero rollbacks for 30 consecutive days. `README.md` G4 says "old panel deleted"; I am amending that to a two-step (§5.5). Deleting the fallback at the moment of cutover is the definition of a rewrite with extra steps.
2. **The flag gets a removal ticket at creation**, with the G4+30 date, assigned to the churn owner (§6.4). `CRYSTAL_STREAMING` is what happens without this.

### 3.5 The flag must be tested on both branches

`app/src/__tests__/components/crystalChassisFlag.test.tsx` — ~60 LOC, and this is non-negotiable:

- `resolve()` precedence: VITE override > org profile > `'legacy'`
- unknown/null value → `'legacy'` (fail closed)
- `AppShell` mounts exactly one panel, never both, never neither, for each value
- `isBuilder` suppression holds for **both** values (`AppShell.tsx:43`)
- **the entire §2 characterisation suite runs against both chassis from G2 onward** via a parameterised describe (`describe.each(['legacy','assistant_ui'])`). This is the mechanism that makes G2's "zero regression" claim checkable rather than aspirational.

That last point is the single highest-leverage line in this document. It costs ~20 LOC of harness and converts every one of §2's ~700 LOC into a migration gate for free.

---

## 4. The funnel-integrity gate

Highest severity. This is the metric that feeds skill quality (`FINDINGS.md:99`: root `CLAUDE.md`'s claim that each turn emits telemetry the next tier learns from is, for the chat path, **currently false**).

### 4.1 The baseline is not merely broken — it is non-deterministic

`FINDINGS.md:101-105` lists five defects. I verified all five and found three more. The three new ones are what break the stated gate.

**Verified, as reported:**

| # | Defect | Evidence |
|---|---|---|
| a | `proposal_key` is a title slug | `crystal.py:964-966` — `_re.sub(r"[^a-z0-9]+", "-", (title or type).lower()).strip("-")[:48]`; client sends it as `proposalKey: proposal.id` (`CrystalPanel.tsx:762`, `:1096`) |
| b | Repeat emissions collapse; `dismissed` can overwrite `succeeded` | `insights.ts:2317-2322` — `ON CONFLICT (org_id, proposal_key) ... DO UPDATE SET status = EXCLUDED.status` with no ordering guard |
| c | `emitted` never written | DB default is `'emitted'` (`20260623000010:17`) but the only writer is the client, which posts only `accepted`/`succeeded`/`failed` (`:759-771`) or `dismissed` (`:1095-1101`) |
| d | No CHECK on `status` | `20260623000010_crystal_action_proposals.sql` — the five values appear only in comments at `:17` and `:36`. The API layer also doesn't validate: `insights.ts:2305-2308` checks only that `status` is a non-empty string |

**New — found while verifying:**

| # | Defect | Evidence | Why it matters |
|---|---|---|---|
| e | **The unique index omits `survey_id`** | `20260623000010:29-31` — `UNIQUE (org_id, proposal_key) WHERE proposal_key IS NOT NULL` | "Improve onboarding survey" proposed on survey A and survey B in one org → **one row**. Cross-survey contamination, not just cross-turn |
| f | **`DO UPDATE SET` freezes 6 columns at first insert** | `insights.ts:2318-2322` updates only `status`, `outcome_ref`, `error_detail`, `updated_at` | `survey_id`, `type`, `params`, `priority`, `business_rationale`, `confidence` are permanently whatever the first emission said. Per-type accept rates are wrong, not just imprecise |
| g | **`emitted_at` is never refreshed on conflict** | `emitted_at TIMESTAMPTZ DEFAULT NOW()` (`:20`), absent from `DO UPDATE SET` | Any time-series or cohort analysis dates a collapsed row to its **first ever** emission. Trend lines are fiction |
| h | **`accepted` races its own terminal status** | `track('accepted')` at `CrystalPanel.tsx:774`; terminal `track(...)` at `:782`–`:1010`. `track` is **not awaited** (`:761` `api.recordProposalOutcome(...).catch(() => {})`) | **13 terminal `track()` call sites are reached with zero `await` after `:774`** — `:790`, `:804`, `:805`, `:893`, `:901`, `:909`, `:910`, `:916`, `:988`, `:998`, `:1001`, `:1004`, `:1010` — spanning 9 `case` groups (`edit_survey`, `distribute`, `schedule_rerun`, `view_template`, `view_tag_report`, `generate_tag_report`, `send_slack_alert`, the three report types, and `default`). Two POSTs fire in the same tick with no ordering guarantee, both hitting `DO UPDATE SET status = EXCLUDED.status`. **The terminal status can be overwritten by `accepted`.** |

**(h) is the finding that changes the plan.** Replay the identical user journey twice against the identical code and the funnel row can differ. So:

> **"Prove non-regression across cutover by comparing new-chassis funnel output to baseline" is impossible by equality. The baseline does not equal itself.**

### 4.2 The gate, restated so it is achievable

Three properties, in order. Property 1 must land **before** G2 opens.

**Property 1 — make the baseline deterministic (G1, prerequisite).** Coordinate with Priya; this is her §5(a) work (`ASSESSMENT_CRYSTALOS.md:242`, 1.5 d) plus one client fix I own:

- Server-mint `proposal_id = uuid4()` per emission (Priya, `ASSESSMENT_CRYSTALOS.md:168-175`). Fixes (a), (b), (e), (f), (g) at once — a unique key per emission means `ON CONFLICT` only ever fires for genuine retries of the same emission, which is what the comment at `:27-28` always claimed.
- Add `turn_id` column + `CHECK (status IN ('emitted','accepted','dismissed','succeeded','failed'))` (Priya). Fixes (d).
- Write the `emitted` row server-side at emission time (Priya). Fixes (c).
- **Serialise the client's outcome writes** — `await track('accepted')` before dispatching, or better: make the terminal call carry both transitions. Fixes (h). **This is mine, and it is the one item on the list that is not in anybody's plan.** ~0.5 d.
- Add `ON CONFLICT ... DO UPDATE SET` a **monotonic status guard** so a terminal status cannot regress: `WHERE crystal_action_proposals.status NOT IN ('succeeded','failed','dismissed')` — belt and braces for (b) and (h). ~0.5 d.

**Property 2 — dual-write shadow comparison (G2).** Decision, stated plainly:

> **Dual-write, not shadow-read. Both chassis write to the same table, distinguished by a new `chassis` column. No second table, no diffing pipeline.**

Why not shadow comparison (running both chassis and diffing)? Because to diff you must render both panels simultaneously, which means the same proposal is emitted twice, executed at most once, and recorded twice under two keys — you would be measuring the harness. And per §3.2 the flag is per-org precisely so the two cohorts don't share funnel rows.

Concretely: add `chassis TEXT NOT NULL DEFAULT 'legacy'` to `crystal_action_proposals`, set from a new request field. Then non-regression is a **cohort comparison of invariants**, not a row diff:

| Invariant | Assertion | Catches |
|---|---|---|
| I1 | every `accepted` row has a terminal status within 60 s | a chassis that renders Apply but never reports the outcome |
| I2 | `count(emitted) ≥ count(accepted) ≥ count(succeeded) + count(failed)` per `(chassis, type)` | funnel inversion — the classic silent telemetry break |
| I3 | no row ever transitions out of `succeeded`/`failed`/`dismissed` | (b), (h) regressions |
| I4 | `count(distinct type)` on `assistant_ui` ≥ on `legacy` for the same window | a chassis that silently drops proposal types — the exact failure mode of a tool-renderer registry that throws on an unregistered name (`ASSISTANT_UI.md:119` — unknown names throw `GenerativeUIRenderError`) |
| I5 | `accept_rate` per type within **±5 percentage points** across cohorts, on ≥ 200 emissions per type | behavioural drift in the confirm-card (e.g. a Details toggle that no longer previews `humanizeParams`, so users stop trusting Apply) |
| I6 | every row's `turn_id` joins to a `crystal_turn_events` row | Priya's `crystal.py:1645` `thread_id=None` problem recurring on the new chassis |

I1–I4 and I6 are **hard gates** — any violation blocks G2 sign-off and triggers the kill switch. I5 is a **soft gate**: a breach opens an investigation, not an automatic rollback, because 200 emissions per type is a thin sample and the pilot cohort is self-selected.

Implemented as **one SQL-assertion test file** run against a seeded local Postgres, plus the same six queries as a Grafana panel (the stack already exists — `docker/` runs Prometheus/Grafana/Loki).

**Property 3 — client-side funnel contract tests (G2, in the app suite).** For each of the 18 dispatcher branches: exactly one `accepted`, exactly one terminal, correct `outcomeRef`, correct `errorDetail`, and — new — **the two calls are ordered**. `CrystalPanel.test.tsx:495` already does this for one branch (`create_alert`); extend the pattern to all 18 and add the ordering assertion. Cost: ~120 LOC, and it runs under `describe.each` on both chassis per §3.5.

### 4.3 The metrics discontinuity when `proposal_key` changes

This is unavoidable and must be declared, not engineered around.

Before Property 1, one row can represent N emissions across M surveys and T turns. After, one row is one emission. **So `count(*)` jumps, `accept_rate` falls, and neither change is a regression.** Anyone reading a dashboard across the boundary will conclude the product got worse.

Handling:

1. **Cut, don't backfill.** Backfilling is impossible — the information (which emission, which survey, which turn) was never recorded. Pretending otherwise with a heuristic would put a fabricated number into the input of skill quality.
2. **Mark the boundary in data.** `chassis` (§4.2) plus a `funnel_schema_version` marker row. Every query and dashboard filters on it explicitly.
3. **Declare pre-Property-1 numbers void for accept-rate purposes.** Say it in the doc that ships with the migration. They remain valid for "was this proposal type ever acted on at all," which is a weaker but still useful claim.
4. **Establish the new baseline on `legacy` first.** Property 1 is chassis-independent, so land it, then run **legacy-only for ≥ 2 weeks** to get a trustworthy baseline. G2's cohort comparison then compares new-chassis to a *real* baseline rather than to the old broken one. **This is why Property 1 gates G2 and not G4 — it needs runway.**

### 4.4 The existing test pins the defect — rewrite it in the same commit

`backend/src/__tests__/crystalProposals.test.js:70-127` is titled *"inserts a new proposal then updates the same proposalKey (upsert path)"* and asserts:

```js
expect(sql).toContain('ON CONFLICT (org_id, proposal_key)');   // :80
...
expect(upserts[1][9]).toBe('succeeded');                        // :125  status overwritten
```

It is a **regression lock on defects (b), (e), (f), (g)**. Property 1 turns it red. The failure mode I have seen kill this exact fix before: an engineer sees a red test named "upsert path," assumes the fix broke idempotency, and reverts.

Three requirements:

1. Rewrite it **in the same commit** as Property 1, retitled to describe the *new* contract (retry of the same server-minted `proposal_id` is idempotent; a *different* emission of the same title is a distinct row).
2. Add a comment at the old assertion site recording that the old behaviour was intentional-looking and wrong, with a pointer to `FINDINGS.md` §5.
3. Note that it uses a `vi.fn()` DB mock (`:76`) and never touches Postgres, so **the unique index, the CHECK, and the status-regression behaviour are all unobservable in it by construction.** Property 2's SQL-assertion suite must run against real Postgres. This is the second-largest gap in the existing suite after §1.3.

### 4.5 The in-flight-proposal artefact

Per §3.3, a proposal on screen at flip time yields no terminal status. At pilot scale (3–5 orgs) this is a handful of rows; it would corrupt I1. Mitigation: I1 excludes rows whose `emitted_at` falls within 5 minutes of a recorded `crystal_chassis` change for that org. Requires an audit row on flag flips — ~10 LOC, and it also gives us the rollback log G4 needs (§5.5).

---

## 5. Per-gate regression suites

Notation: **HARD** = must be green, no exceptions. **SOFT** = breach opens an investigation.

### 5.0 P0 — before G0 opens (new gate; `README.md` has no pre-G0 gate and needs one)

| Suite | Status |
|---|---|
| §2 characterisation suite, ~700 LOC, green on `main` | **HARD** |
| §8.1 `crystal-spin` extracted + guarded | **HARD** |
| §8.2 `crystalIdentityTokens.test.ts` content-matches `LAYER_COLORS` | **HARD** |
| §7.4 brand-cascade invariant test | **HARD** — G0's central measurement is meaningless without it |
| §9 CI gaps closed (i18n exit code + wired; coverage thresholds; stale env var removed) | **HARD** |
| §3.5 flag scaffolding + both-branch mount test (legacy-only ternary, new component is a stub) | **HARD** |
| Existing 2,736 LOC still green | **HARD** |

**Done means:** a `git revert` of any single migration commit from here on returns Crystal to a state that ~700 LOC of behavioural tests certify. **Rollback trigger:** n/a — nothing has shipped.

### 5.1 G0 — Spike

`README.md`: unmodified `CrystalThinkingBubble` + `ActionProposalCard` render inside `ThreadPrimitive`; citation retro-enrichment survives `convertMessage`; one `generative-ui` spec renders an NPS chart; styled-vs-headless answered with a measurement.

| Suite | Status |
|---|---|
| Spike acceptance criteria §7, all four sub-goals pass/fail recorded | **HARD** |
| Spike branch is **never merged**; `main` untouched | **HARD** |
| §2 suite still green on `main` (proves the spike didn't leak) | **HARD** |

**Done means:** a written §7 result sheet with four pass/fail marks, a measured adapter LOC count, and a styled-vs-headless verdict with the measurement attached. **Rollback trigger:** any sub-goal fails → the plan re-enters at §7.6 (re-scope, don't proceed to G1 on hope). Deleting the branch costs nothing.

### 5.2 G1 — Contract

`README.md`: `message_id`/`turn_id` on the wire; server-minted proposal IDs; `emitted` row written; funnel denominators correct.

| Suite | Status |
|---|---|
| **Additivity: the legacy panel is byte-identically unaffected.** `experienceCrystalStreamBuilderContext.test.js:112`'s byte-identical pattern, extended to prove the legacy client ignores `turn_start`, `turn_id`, and unknown frames | **HARD** |
| §2.2's "unknown SSE `type` is inert" case, now load-bearing | **HARD** |
| §4.2 Property 1: uuid `proposal_id`, `turn_id`, `emitted` row, `CHECK`, monotonic status guard, serialised client writes | **HARD** |
| §4.4 `crystalProposals.test.js` rewritten in the same commit | **HARD** |
| Property 2's I1–I4, I6 green against seeded Postgres, **legacy-only** | **HARD** |
| Message-identity adoption at the 5 `crypto.randomUUID()` sites (`:453`, `:471`, `:537`, `:550`, `:566`) with client-uuid fallback for locally-constructed messages | **HARD** |
| CrystalOS/TS `ActionProposalType` parity test (Priya §5(b), 1 d) | **HARD** — note the assessments disagree on the member count (21 vs 25); I count **21** at `types/index.ts:782-807`. The parity test is what settles it |
| Contract test over `/openapi.json` (Priya, 1 d) | SOFT at G1, HARD at G2 |

**Done means:** ≥ 2 weeks of legacy-only traffic on the fixed funnel, with I1–I6 green, establishing the real baseline (§4.3 item 4). **Rollback trigger:** any I1–I4/I6 violation, or the legacy panel changing behaviour at all → revert the contract PR (one deploy, zero user impact, since nobody is on the new chassis).

### 5.3 G2 — Parity

`README.md`: every current capability works on the new chassis behind the flag; zero regression in the outcome funnel.

| Suite | Status |
|---|---|
| **§2 suite green under `describe.each(['legacy','assistant_ui'])`** — all ~700 LOC, both chassis | **HARD.** This *is* the parity gate |
| §4.2 Property 3: all 18 dispatcher branches, both chassis, with ordering | **HARD** |
| §4.2 Property 2 I1–I4, I6 on the `assistant_ui` cohort | **HARD** |
| I5 (±5 pp accept rate per type, n ≥ 200) | **SOFT** |
| Rewritten proposal-execution tests (~1,150 LOC of the 1,326 need a new interaction layer — §5.6) | **HARD** |
| `convertMessage` unit tests (new, pure function) | **HARD** |
| Custom message-part + ToolUI unit tests | **HARD** |
| `crystalIdentityTokens.test.ts` extended to the new component tree | **HARD** |
| axe scan on both chassis, **no new violations** vs legacy | **HARD** — see §9.3. Note `ASSESSMENT_XPERIQ_UI.md:219` finds adoption *introduces* 2 defects (unguarded `animate-pulse`/`animate-in`/`animate-out`; a second low-contrast surface). This gate is what stops that shipping |
| Coverage thresholds hold (§9.2) | **HARD** |
| Internal orgs only | **HARD** |

**Done means:** 14 consecutive days on internal orgs with zero HARD breaches and zero manual kill-switch uses. **Rollback trigger:** any HARD breach, or any I1–I4/I6 violation → `UPDATE org_profiles SET crystal_chassis='legacy'`, < 1 min.

### 5.4 G3 — Gains

`README.md`: markdown, `aria-live`, thread persistence, generative-UI charts live.

**I will not sequence these four.** `TEAM.md:128` names the reason: no PM, no user research. `ASSESSMENT_CRYSTALOS.md:340` says the same ("Evidence that users are actually blocked today by markdown / a11y / persistence. This pod has no user research and no PM"). Ordering four user-facing features by engineering convenience is exactly the judgment that produced the two abandoned rich-content precedents in `README.md:124-125`.

**Structural answer: four independently flag-gated sub-slices, shippable in any order, each with its own gate.** This costs ~4 × 15 LOC of extra flag plumbing and buys the product owner a free choice.

| Slice | Flag | Suite | Status |
|---|---|---|---|
| G3a Markdown | `crystal_markdown` | §2.4's pinned "markdown does not render" assertions **inverted deliberately, in the same commit**; XSS test (untrusted model prose → no raw HTML, no `javascript:` href); **citation markers survive the markdown AST** — a `[uuid]` inside a list item or table cell must still become an `InlineCitation`. This is the interaction both markdown estimates gloss over | **HARD** |
| G3b a11y | `crystal_a11y` | axe zero-new-violations; `role="log" aria-live="polite"` announces on new answer; the 4 measured contrast failures fixed (`:1494` 2.24:1, `:2498` 3.01:1, `:2506` ~3.6:1, `:1465` 1.23:1); reduced-motion gate over the 8 keyframes; focus restored to opener on close. **Explicitly NOT: focus trap, `aria-modal`, `role="dialog"`** — Theo ruled these are defects to add (`ASSESSMENT_XPERIQ_UI.md:81-89`); a test asserting their **absence** prevents a well-meaning re-introduction | **HARD** |
| G3c Persistence | `crystal_persistence` | thread survives reload; **thread does NOT leak across users** — v1's `thread_key = crystal:${orgId}:${surveyId}` has no user component (`insights.ts:1493`), a privacy defect if re-enabled (`ASSESSMENT_CRYSTALOS.md:200`), so the test asserts the v2 4-tuple key; `storage_expires_at` sweep actually deletes; **chassis flip clears rather than cross-reads** (§3.3) | **HARD** |
| G3d Generative UI | `crystal_charts` | **unknown component name must degrade, not throw** — `ASSISTANT_UI.md:119`: unknown names throw `GenerativeUIRenderError`. An unbounded server-controlled string reaching a client registry that throws is a **server-triggerable client crash**. Non-negotiable: an error boundary + a test that an unknown name renders a fallback and records telemetry; malformed spec (missing/NaN/wrong-typed data) renders a fallback; the chart is `aria-hidden` with a text alternative (§9.3); spec is schema-validated client-side before it reaches the registry | **HARD** |

**Done means:** each slice green independently, and the §2 suite still green with all four on and all four off (16 combinations is too many to run exhaustively — run all-off, all-on, and each-alone: 6 configurations). **Rollback trigger:** per-slice flag off, < 1 min, independent of the chassis flag.

### 5.5 G4 — Cutover (amended to two steps)

`README.md`: flag defaulted on; old panel deleted; `XperiqCopilot` converged.

**G4a — default on, keep both.**

| Suite | Status |
|---|---|
| Everything from G2 + G3, all orgs | **HARD** |
| Flag-flip rehearsal: flip to `assistant_ui`, flip back, flip forward, on a real org, timed | **HARD** — an untested kill switch is not a kill switch |
| Flag-flip audit rows written (§4.5) | **HARD** |
| I1–I4, I6 green for 30 consecutive days at full traffic | **HARD** |

**G4b — delete, at G4a + 30 days, zero rollbacks.**

| Suite | Status |
|---|---|
| Delete `CrystalPanel.tsx` legacy path, the `crystal_chassis` ternary, the flag column, and the flag-removal ticket | **HARD** |
| **Deletion audit: no test only passed because the legacy component existed.** Mechanically: delete, then confirm the failure count equals the count of tests explicitly targeting `legacy`. Any *other* failure means a supposedly-migrated behaviour was still being served by the old component | **HARD** |
| Coverage thresholds hold after deleting ~2,800 source lines and ~1,150 test lines (§9.2 — recompute the floor **in the same PR**, don't lower it silently) | **HARD** |
| 679 LOC of dead chat code deleted (`IrisChat.tsx` 316, `pages/insights/ConversationView.tsx` 363 — zero importers incl. tests) | **HARD** — free, no decision needed |
| `XperiqCopilot` converged | **See §10.4-D** — Theo rules convergence must happen **before** the migration (`ASSESSMENT_XPERIQ_UI.md:397`), not at G4. `README.md` puts it at G4. **These conflict.** I side with Theo: leaving it doubles the scope of every gate above, because `describe.each` would need a third arm |

**Rollback trigger at G4a:** any HARD breach → flip default back + bulk UPDATE, < 5 min. **After G4b there is no rollback.** That is why the 30 days exist.

### 5.6 Which of the existing 2,736 LOC survive

| Group | LOC | Verdict | Cost |
|---|---|---|---|
| Backend: `experience.test.js`, `experienceCrystalStreamBuilderContext.test.js` | 740 | **Survive untouched.** Test the Express bridge, which the migration does not touch | 0 |
| Backend: `crystalProposals.test.js` | 220 | **Rewrite at G1** — it pins the defect (§4.4) | ~60 LOC edit |
| `contexts/crystalPanel.test.tsx` | 113 | **Survives untouched.** `openCrystal` façade preserved in both chassis (`README.md:113`) | 0 |
| `three/NLThinkingCrystal.test.tsx` | 70 | **Survives untouched.** Not the panel | 0 |
| `workflow-builder/AskCrystalFab.test.tsx` | 120 | **Survives untouched.** The FAB, not the panel | 0 |
| `lib/crystalIdentityTokens.test.ts` | 72 | **Rewrite at P0** (§8.2) + **extend at G2** to the new tree | ~10 + ~15 LOC |
| `CrystalPanel.test.tsx` — pure-function describes (`resolveReportProposalAction` `:1200-1248`, `classifyAsSupport` `:1250-1299`) | ~99 | **Survive untouched.** Pure exports, unchanged | 0 |
| `CrystalPanel.test.tsx` — brand-token describe (`:1301+`) | ~40 | **Survives**, may need a selector update | ~5 LOC |
| `CrystalPanel.test.tsx` — harness (`:1-274`) + 30 proposal-execution tests | ~1,187 | **Assertions survive; the interaction layer does not.** `renderPanel` must wrap in `AssistantRuntimeProvider`; composer typing goes through `ComposerPrimitive.Input`; Apply goes through `addResult` rather than `onApply`. Note `ASSESSMENT_CRYSTAL_UI.md:166`: you **cannot** `vi.mock('@assistant-ui/react')` — the real runtime is required, which makes these tests slower and more brittle than they are today | ~150 LOC edit (Nadia's estimate: 60 harness + 90 across 30 tests). **I concur** |
| `CrystalPanelReportProposals.test.tsx` | 75 | Likely survives (report-proposal dispatch is pure-ish); assume ~15 LOC edit | ~15 LOC |

**Totals.** Survive untouched: **1,182 LOC (43%)**. Edited: **~255 LOC of changes** across ~1,600 LOC of tests. New: **~700 LOC (§2, at P0) + ~440 LOC (§4/§5 gates, G1–G3) + ~320 LOC (`convertMessage`, parts, ToolUI — Nadia's items 3–4)**.

**Test LOC delta: ~+1,460.** Nadia's +480 covers only the rewrite-and-new-unit-tests portion and explicitly excludes characterisation (`ASSESSMENT_CRYSTAL_UI.md:474` concedes the suite is proposal-focused and the untested surfaces are what the migration touches most). **Her number is not wrong; it is scoped to a plan with no characterisation phase.** With one, the honest figure is roughly triple. I am not going to hide that: ~700 of those lines are the reason a regression is detectable at all, and they are worth more than the migration.

---

## 6. The dependency-churn runbook

### 6.1 Resolved: assistant-ui's actual release cadence

The assessment could not fetch this (`ASSISTANT_UI.md` marks the churn signal as unquantified). Resolved via `npm view @assistant-ui/react time --json`.

| Fact | Value |
|---|---|
| Current version | **`0.15.4`**, published **2026-08-03** — the day before the migration decision |
| Total published versions | **433**, since `0.0.1` on 2024-05-07 (27 months → **~16 releases/month**) |
| Releases in the last 90 days | **31** — one every **~2.9 days** |
| `0.11.0` | 2025-09-08 (57 patches, over 135 days) |
| `0.12.0` | 2026-01-24 (25 patches) |
| `0.13` | **never published — skipped entirely** |
| `0.14.0` | 2026-05-07 (26 patches) |
| `0.15.0` | 2026-07-28 — **7 days old**; `.1` next day, `.2/.3/.4` all on 2026-08-03 |
| **v0.11.0 → v0.15.0** | **323 days (~10.6 months)** |
| Breaking-minor intervals | **138 → 103 → 82 days — accelerating** |

**The answer to the brief's question: 10.6 months, not 3 years. Four breaking rearchitectures in under eleven months, at an accelerating rate.**

Two consequences that change the runbook:

1. **A breaking minor will land mid-migration.** Extrapolating 82 days from 2026-07-28 gives **~2026-10-18**. G1–G3 will not be complete by then on any honest schedule (§10). Plan for the upgrade as a scheduled work item, not an incident.
2. **We would adopt `0.15.x` at 7 days old.** `0.15.0` shipped 2026-07-28 and has already needed four patches, three of them on one day. The v0.15 migration guide is the one `ASSESSMENT_CRYSTAL_UI.md:279` reports has **no codemod** for its two hardest changes (`AuiProvider` restructure from `value` to `extends`+`config` where "raw object literals are a type error"; `useAui({parent})` removal). We would be early adopters of the least-settled release in the project's history.

Supporting facts on what upgrades cost us (from `ASSESSMENT_CRYSTAL_UI.md:283`, verified as internally consistent): three of four breaking migrations rearchitected either the **message-part rendering seam** (v0.11 `MessagePrimitive.Content` → `.Parts` with a new render-callback signature; v0.14 `components` prop → children render functions) or the **state-access API** (v0.12 removed ~14 context hooks for `useAuiState(selector)`; v0.15 removed 17 more, *including the unified API v0.12 had just introduced* — **a three-minor lifetime for the primary way to read state**). Those are precisely the seams our 4 custom message parts, 1 ToolUI, and ~8 primitive compositions live on. And the deprecation policy makes **no commitment about breaking changes before 1.0**.

### 6.2 Pinning strategy

**Exact version. No caret, no tilde. `"@assistant-ui/react": "0.15.4"`.**

Non-negotiable given the data: `^0.15.4` would have moved three times on 2026-08-03 alone, and `unstable_` APIs "may change in **any release including patch releases**." A caret range on a package where the load-bearing surface is patch-unstable is an unpinned dependency wearing a range's clothes.

Also required:

- **Commit `app/package-lock.json`.** Blocked today: `.github/workflows/ci.yml:35` runs `rm -f package-lock.json && npm install` on **both** jobs, so **CI resolves transitive dependencies fresh on every run**. With `assistant-ui` this becomes acute — 19 direct dependencies including `radix-ui@^1.6.7` (the monolithic package, alongside the 12 individual `@radix-ui/react-*` already installed), `zustand@^5`, `zod@^4`, `nanoid@^6`, `assistant-stream`, and **`assistant-cloud@^0.1.38`** — the commercial cloud client, a hard dependency of core, not opt-in. Every one of those is caret-ranged upstream. **Today a green CI run does not mean the same tree a developer has.** Fix the lockfile handling before adding a 2.4 MB / 19-dep package, or the pin is decorative. (The `rm -f` exists to work around platform-specific optional binaries; the correct fix is `npm ci` with a lockfile generated on a Linux runner, or `--include=optional` handling — not deleting the lockfile.)
- **A `vendor-assistant-ui` manual chunk** in `vite.config.ts`, matching the existing `vendor-charts`/`vendor-motion` pattern (`app/CLAUDE.md`, "Build Chunking"), so a bundle-size regression is visible.
- **A renovate/dependabot rule that opens PRs but never auto-merges** this package.

### 6.3 The CI check that detects a breaking change before production

Four layers. The first three are new; all four run in `ci.yml`.

**Layer 1 — the pin is honoured (cheap, catches accidental drift).**
Assert the installed version equals the pinned version exactly, and fail on any transitive `@assistant-ui/*` or `assistant-cloud` version change vs a committed manifest. ~20 LOC. Catches a lockfile-free `npm install` pulling a new patch — which, per §6.2, is today's default behaviour.

**Layer 2 — the isolation layer's surface is type-asserted (the real gate).**
See §6.5. A dedicated type-level test file asserts every `unstable_` symbol we consume still has the shape we expect. Because the frontend CI already runs `npx tsc --noEmit` (`ci.yml:41`), **a renamed or reshaped `unstable_` API becomes a type error at exactly one file.** This converts "may change in a patch release" from a runtime mystery into a compile-time failure with a single blast site. ~80 LOC, and it is the highest-value item in this section.

**Layer 3 — a scheduled canary, so we learn from CI and not from users.**
A weekly workflow that installs `@assistant-ui/react@latest` (ignoring the pin), runs `tsc --noEmit` + the §2 suite under `describe.each`, and **opens an issue on failure without blocking any PR**. On a 2.9-day release cadence, weekly is the right frequency. This is what gives us ≥ 1 week of warning before an upgrade we choose to take, and it costs nothing when it passes.

**Layer 4 — the §2 characterisation suite, which already exists by then.**
The 700 LOC from §2 is the behavioural backstop for every upgrade. `ASSESSMENT_CRYSTAL_UI.md:287` estimates 1–2 engineer-days per minor for the 13 integration points, and says "the ~1,958 LOC of Crystal tests would gate every one of those upgrades." That is only true for the proposal loop — those tests do not touch streaming, citations, or the timeline (§1.3), which are the seams that actually rearchitected. **§2 is what makes that sentence true.**

### 6.4 Upgrade cadence and owner

- **Owner: one named engineer, recorded in `app/CLAUDE.md` next to the pin.** Not "the team." `CRYSTAL_STREAMING` had no owner and rotted three ways (§3.1).
- **Patch releases:** batch monthly. Take the canary's word for it; if Layer 3 was green for a version, upgrading to it is routine.
- **Minor releases:** never in the same sprint as they ship. Wait for `.3`+ — `0.15` needed four patches in seven days, and `0.11` needed 57.
- **Breaking minors:** a scheduled, estimated work item. **1–2 engineer-days plus a full §2 re-run**, budgeted every ~82 days (§6.1). Say this out loud in the roadmap: on current cadence that is **~4.5 breaking upgrades per year, or ~9 engineer-days/year of pure churn tax** on the platform's most important UI surface, indefinitely, until 1.0.
- **Freeze windows:** no upgrade between a gate's start and its sign-off. If the ~2026-10-18 minor lands mid-G2, it waits for G2 sign-off. The canary tells us it is coming; the freeze stops it derailing a gate.
- **Exit criterion:** when `unstable_createMessageConverter`, `unstable_capabilities`, message metadata, and `unstable_threadId`/`parentId` are de-`unstable_`'d, drop the pin to a tilde range and downgrade the canary to monthly.

### 6.5 How Nadia's isolation layer gets tested

**Finding first: there is no isolation layer design in any assessment document.** I checked `ASSESSMENT_CRYSTAL_UI.md` specifically — it costs the `unstable_` surface (190 of 655 lines, across `unstable_capabilities`, `unstable_createMessageConverter`/`unstable_convertExternalMessages`, `unstable_state`/`annotations`/`data`, `unstable_assistantMessageId`/`threadId`/`parentId`/`getMessage`, `unstable_onBranchChange`, `unstable_humanToolNames`) but proposes **no wrapper, facade, or boundary module**. The mitigation it asks for is upstream (a 1.0), not local. `README.md:90` nonetheless makes "an isolation layer around every `unstable_` API" a non-negotiable planning constraint.

So the constraint exists and the design does not. Testing it requires specifying it. **Coordinate with Nadia; I propose the shape, she owns the implementation.**

```
app/src/lib/assistantUi/
  index.ts        // THE ONLY file in the repo that imports from '@assistant-ui/react'
  unstable.ts     // every unstable_ symbol, re-exported under a stable local name
  types.ts        // our own type aliases for every library type we name
```

Three rules, each mechanically enforceable:

| Rule | Enforcement |
|---|---|
| **R1** — no file outside `app/src/lib/assistantUi/` may import `@assistant-ui/react` | ESLint `no-restricted-imports` with a path exception. `ci.yml:38` already runs `npm run lint`, so this is **free** |
| **R2** — every `unstable_` symbol is re-exported under a stable local name | grep assertion in the Layer-1 check: no `unstable_` identifier appears outside `unstable.ts` |
| **R3** — every re-export has a type-level assertion pinning its shape | the Layer-2 file below |

Layer 2, concretely (`app/src/__tests__/lib/assistantUiSurface.test-d.ts`, ~80 LOC):

```ts
// Fails `tsc --noEmit` the moment the library changes any of these shapes.
import type { ExternalStoreAdapter } from '@assistant-ui/react';
type Assert<T extends true> = T;
// 1. The symbol still exists under the expected name.
type _1 = Assert<typeof import('@assistant-ui/react')['unstable_createMessageConverter'] extends
  (...a: never[]) => unknown ? true : false>;
// 2. The capability flags we set still exist and are still booleans.
type _2 = Assert<NonNullable<ExternalStoreAdapter['unstable_capabilities']> extends
  { copy?: boolean; edit?: boolean; reload?: boolean } ? true : false>;
// 3. run() still receives the identity options we depend on.
// 4. ToolCallMessagePartProps still exposes { args, status, result, addResult }.
```

**Why type assertions and not runtime tests:** the failure mode of a patch-level `unstable_` change is a *renamed or reshaped* export. That is invisible to a runtime test that mocks the library and invisible to a test that only exercises our own code — but it is a hard `tsc` failure at one file. Given `ci.yml:41` already runs `tsc --noEmit`, R3 costs one file and zero new CI infrastructure.

**What R1 buys at upgrade time:** the diff surface of a breaking upgrade is `app/src/lib/assistantUi/` plus whatever `tsc` flags. Without R1, it is every file that touched a primitive — the 13 integration points, found by hand. **R1 is the difference between a 1-day upgrade and a 2-day upgrade, every 82 days.**

**Test for the isolation layer itself:** a lint-rule test asserting R1 fires on a violation, and a Layer-1 grep asserting R2. ~30 LOC.

---

## 7. G0 spike acceptance criteria

Timebox: **≤ 3 days** (Nadia's, `ASSESSMENT_CRYSTAL_UI.md:481` — I concur). Output: a result sheet with four unambiguous pass/fail marks and two measurements. **Coordinate with Nadia: she runs it, I own the criteria and countersign the result.**

Preconditions: §5.0 P0 green (in particular §7.4's cascade test, without which sub-goal 4 is unmeasurable).

### 7.1 Sub-goal 1 — component render

**PASS iff all five hold:**

1. `CrystalThinkingBubble` (`CrystalPanel.tsx:2219-2540`) and `ActionProposalCard` (`:2642-2799`) render inside `ThreadPrimitive` with **zero edits to either component's source**. Verified by `git diff --stat` on the spike branch showing 0 changed lines in those ranges.
2. Both render **with their brand identity intact** — `var(--color-primary)`, `--color-tertiary`, and `color-mix()` all resolve. Verified by `getComputedStyle`, not by inspection.
3. **The `crystal-spin` spinner in `ActionProposalCard` animates** (`:2783`). Pointed, because §8.1 says it depends on `CrystalThinkingBubble` having mounted. If the spike renders the card without the bubble, this fails today too — which is the point: the spike must surface it, not accidentally satisfy it.
4. `humanizeParams` Details preview renders (`:2624`). It is the "nothing mutates unseen" guarantee.
5. Apply reaches `executeAction` and fires exactly one `accepted` + one terminal outcome, in order.

**FAIL if any component required a source edit.** "Rendered after small changes" is a fail — the whole question is whether the differentiated UI ports unmodified.

### 7.2 Sub-goal 2 — citation retro-enrichment survives `convertMessage`

**PASS iff the §2.3 two-turn test passes verbatim against the spike**, with only the render wrapper changed.

Explicitly: turn 1 renders a bare citation; turn 2's `citation_context` retro-enriches **turn 1's already-rendered message**; the rendered DOM shows the headline. Plus the four no-op guards (`prev.length === 0`; last is `user`; no citations; merge-not-replace).

**FAIL if** the enrichment requires mutating library-owned message state, requires a full re-conversion of the message array on every `citation_context`, or works only for the current turn. Any of those is a rearchitecture of the seam, not an adapter.

**Note:** this is the sub-goal `ASSESSMENT_CRYSTAL_UI.md:225` calls "the disqualifier." It is the one most likely to fail, so run it **first** — a fail here saves two days.

### 7.3 Sub-goal 3 — generative-UI chart

**PASS iff all five hold:**

1. A **CrystalOS-emitted** spec (real frame from a real service, not a hand-written fixture) renders an NPS chart via Recharts (`recharts ^3.8.1`, already a dependency).
2. The spec is **schema-validated client-side before reaching the registry.**
3. **An unknown component name renders a fallback and does not throw.** `ASSISTANT_UI.md:119`: unknown names throw `GenerativeUIRenderError`. The name comes from an LLM. **An unbounded model-controlled string reaching a registry that throws is a server-triggerable client crash, and it must be proven impossible at G0, not at G3.**
4. A malformed spec (missing series, `NaN`, wrong-typed data) renders a fallback.
5. The chart carries a text alternative and is `aria-hidden`, or is otherwise announced (§9.3).

**FAIL if** the chart only renders from a fixture, or if (3) throws.

**Additional required output, not pass/fail:** a written answer to `README.md:124-125` — `MiniNPSChart` was deliberately removed (`CrystalPanel.tsx:2543`) while Recharts was available, and `render_hint:'document'` has a wired client (`:416`, `:449`, `:459`) and no server emitter. Two abandoned rich-content attempts. If the cause was product judgment rather than engineering difficulty, G3d will be abandoned a third time and the spike is the cheapest place to learn it. **This is a product question (§10.4-B), and G0 is where it gets asked.**

### 7.4 Sub-goal 4 — styled-vs-headless, answered with a measurement

**This sub-goal is invalid until the brand-cascade invariant is pinned.** Theo's proof is correct (`ASSESSMENT_XPERIQ_UI.md:40-52`: `.bg-primary{background-color:var(--color-primary)}`, with `#2a4bd9` at depth 2 inside `@layer theme` and `var(--brand-primary)` at depth 1 in an unlayered `:root`; unlayered wins). But it depends on `theme.css` being imported **unlayered** at `app/src/index.css:2` — verified: `@import "tailwindcss";` then `@import "./styles/theme.css";`, no `@layer` wrapper anywhere in the file.

**Nothing in the repo tests this.** `crystalIdentityTokens.test.ts` greps source text for hex strings; it never evaluates a cascade. So if a future Tailwind or Vite change hoists that import into a layer, every brand override in the product silently reverts to Xperiq blue and no test notices.

**Required at P0, before the spike (§5.0): `app/src/__tests__/lib/brandCascade.test.ts`, ~30 LOC.** Apply a brand via `applyBrandTheme({ primary: '#ff0000' })`, render an element with `className="bg-primary"`, assert `getComputedStyle().backgroundColor` is the new value and **not** `#2a4bd9`. Reason it is a hard prerequisite: **a false "styled components inherit our brand" result and a true one are indistinguishable without it.** If the cascade were broken, every styled component would render Xperiq blue and appear to inherit correctly.

**Then, PASS iff:**

1. An assistant-ui **registry-copied styled component** (CLI-installed into `src/components/assistant-ui/`, per the shadcn model) renders with `--brand-primary` overridden and **visibly picks up the override**, proven by `getComputedStyle`.
2. The measurement is recorded as a table: for each of ~8 primitive compositions, **LOC to style it via the registry component vs LOC via a headless primitive + our own classes.**
3. A verdict per composition — `styled` / `headless` — **with the measurement, not a preference**, per house rule 3.
4. Any `headless` verdict carries a one-line reason naming the specific CSS property or structural constraint that forced it (Theo's mandate: he is "usually right about the specific CSS property").

**FAIL if** the answer is "we chose headless because it felt safer." That is the anchored conclusion the re-charter exists to reopen.

**Two facts to record while measuring, both cheap and both load-bearing:**
- Registry components land in `src/components/assistant-ui/*`, which is **not** in `CRYSTAL_IDENTITY_FILES` (`crystalIdentityTokens.test.ts:19-23`), so they **cannot fail** the token guard. If we go styled, **G2 must add that directory to the guard** or the brand-hex regression net has a hole exactly where the new code lives.
- Registry `thread.tsx` hardcodes ≥ 14 English strings. Copied into our repo they become `t()`-able — but only if someone does it. That is a G2 line item, not a freebie.

### 7.5 What the spike must NOT do

- **Must not merge to `main`.** Not behind a flag, not as dead code. Spike code is disposable by definition; merged spike code is technical debt with a good story.
- **Must not modify** `CrystalPanel.tsx`, `contexts/crystalPanel.tsx`, or `AppShell.tsx` on `main`.
- **Must not skip §7.4's precondition** to save half a day.

### 7.6 If the spike fails

| Failed sub-goal | Consequence |
|---|---|
| 1 (render) | The differentiated UI does not port unmodified → the LOC estimate is wrong. Re-cost before G1. |
| 2 (retro-enrichment) | **Stop.** This is the disqualifier. Either the contract changes so `citation_context` arrives before its answer (Priya, and it is arguably right anyway), or the citation layer is rebuilt. Both are new scope requiring a decision. |
| 3 (chart) | G3d is deferred and `README.md:89`'s "generative UI is in scope, not deferred" needs an explicit product amendment. |
| 4 (styled) | Headless-only, which is what both frontend experts originally recommended. Not fatal — but it must be recorded as *measured*, because §7.4's whole purpose is that the previous headless conclusion was anchored, not measured. |

---

## 8. The two named landmines

### 8.1 `crystal-spin` — a cross-component keyframe dependency

**Verified.** `@keyframes crystal-spin` is defined at `CrystalPanel.tsx:2304-2307`, inside a `<style>` block at `:2303-2334` that lives in **`CrystalThinkingBubble`'s** return (`:2301-2334`). Consumers:

- `:2345` — the orb, inside the same component (fine)
- `:2464` — a step indicator, inside the same component (fine)
- **`:2783` — `ActionProposalCard`'s Apply spinner, a different component** (`ActionProposalCard` is defined at `:2642`)

`CrystalThinkingBubble` mounts only while `isThinking` (`:1361`). So **the Apply spinner animates only if a thinking bubble has mounted at least once in this session** — and since the `<style>` unmounts with the bubble, it only animates while a bubble is *also* mounted, which is never simultaneous with an enabled Apply button.

**Also affected, and not previously noted:** the same `<style>` block defines seven more keyframes (`crystal-pulse` `:2308`, `aurora-flow` `:2312`, `step-in` `:2317`, `check-pop` `:2321`, `dot-pulse` `:2326`, `shimmer-text` `:2330`). Any future consumer outside the bubble inherits the same latent bug. This is a class of defect, not one instance.

**Zero test coverage:** `crystal-spin` has 0 hits across all 204 test files.

**The test that catches it** — `app/src/__tests__/components/crystal/keyframeContract.test.tsx`, ~40 LOC, at **P0**:

1. Render `ActionProposalCard` **in isolation**, with `CrystalThinkingBubble` never mounted, `isExecuting = true`. Assert the `crystal-spin` keyframe rule is present in the document. **This test fails on `main` today.** It is a bug-first test.
2. Assert all 8 keyframe names are reachable with no Crystal component mounted.
3. Assert `CrystalThinkingBubble` **no longer contains an inline `<style>`** — the structural guard that stops the coupling being reintroduced.

**The fix (P0, −30 LOC net):** extract all 8 keyframes to a module-level stylesheet or a `crystal-keyframes.css` imported once, per Nadia's monolith-split plan (`ASSESSMENT_CRYSTAL_UI.md:392`). Do it at P0, not during the split: the migration will refactor the thinking bubble, and the current arrangement guarantees the spinner breaks silently when it does.

### 8.2 `crystalIdentityTokens.test.ts`'s hardcoded line range

**Verified, and the margin is far tighter than reported.**

`app/src/__tests__/lib/crystalIdentityTokens.test.ts:42-44`:

```ts
const EXCLUDED_LINE_RANGES: Record<string, Array<[number, number]>> = {
  'src/components/CrystalPanel.tsx': [[1733, 1738]],
};
```

The exclusion protects the `LAYER_COLORS` block, which legitimately keeps `#2a4bd9`. Measured on `main`:

- `LAYER_COLORS` is declared at `CrystalPanel.tsx:1733`
- **the only banned-hex hit in the entire 2,799-line file is at `:1737`** (`descriptive: '#2a4bd9',`)
- excluded range is `[1733, 1738]`

**Therefore the tolerance is +1 line / −4 lines.** Insert **two** lines anywhere above line 1733 and `:1737` becomes `:1739`, outside the range, and the suite goes red — on a line that is *supposed* to keep its hex. The test's own comment (`:35-41`) admits the mechanism: *"a hardcoded line range is inherently this fragile across any merge that adds content above it."* It has already been re-pointed once, from `[1668, 1673]` on 2026-07-03.

**Two lines.** The monolith split, the `AssistantRuntimeProvider` wiring, the keyframe extraction in §8.1, and any of the ~11 `unstable_` import lines each blow through that on their own.

**A second failure mode neither assessment names: the exclusion is positional, so it is also a false-*negative* hole.** If a reflow shifts *other* content into lines 1733–1738, that content is silently exempt from the brand-hex guard. A migration that reorders the file could park real brand hex in the blind spot and the test would stay green. Content-matching fixes both directions; a re-pointed range fixes neither.

**The test that catches it** — fix at **P0**, ~10 LOC:

1. Replace the line range with **content-matching**: locate the `LAYER_COLORS` declaration by regex, walk to its closing brace, exempt that span. No line numbers.
2. Add a self-test: **assert the exemption resolves to a non-empty span containing exactly one banned hex.** If `LAYER_COLORS` is renamed, moved, or deleted, this fails loudly instead of silently exempting nothing (false red) or the wrong six lines (false green).
3. **Add `src/components/ExperientCopilot.tsx`** to `CRYSTAL_IDENTITY_FILES`. It is a live Crystal-branded surface (616 LOC, 29 hex literals) and is not in the guard. Theo verified it passes today, so this is free — and if it is converged before the migration (§10.4-D), the guard must already cover it.
4. **At G2, add `src/components/assistant-ui/`** if the styled path is chosen (§7.4).

**Do not defer either landmine to the split.** Both are ~10 LOC, both are pure test-hygiene, and both false-alarm during the exact work that most needs a trustworthy signal. A red suite during a migration teaches the team to ignore the suite.

---

## 9. CI gaps to close

Current `ci.yml`: frontend = `npm run lint` (`:38`), `npx tsc --noEmit` (`:41`), `npm run test:coverage` (`:44`), `npm run build:app` (`:47`); backend = install, `find src -name "*.js" | xargs node --check` (`:72`), `npm test` (`:75`).

### 9.1 `check:i18n` — two defects, not one

`app/package.json:16` defines `"check:i18n": "tsx scripts/check-i18n.mjs"`. It is **not** in `ci.yml` — confirmed.

**Defect 1 — it never sets an exit code.** `app/scripts/check-i18n.mjs` is 50 lines and its only output is:

```js
console.log(`Used: ${usedKeys.size}, Defined: ${enKeys.size}, Missing: ${missing.length}`);  // :49
for (const k of missing) console.log(k);                                                      // :50
```

No `process.exit`, no `process.exitCode`. **Wiring it into `ci.yml` as both assessments recommend ("one line") would add a step that can never fail the build.** Fix first: `process.exit(missing.length ? 1 : 0)`.

**Defect 2 — it checks the wrong direction.** It collects `t('key')` uses (regex at `:37`) and reports uses with no definition. It therefore **cannot** detect the actual violation: a hardcoded string. A file with **zero `t()` calls is its cleanest possible pass** — `CrystalPanel.tsx` (12 `t()` in 2,799 lines) and `ExperientCopilot.tsx` (0 in 616) both pass today. It also cannot see dead keys: the 13 `crystal.tool.*` keys at `en.ts:3947-3961` are duplicated as hardcoded English in `TOOL_META` (`:2192-2205`) with *different wording* — locale says "Loading survey overview," component says "Reading survey overview" — and the checker is blind to it.

**Recommendation, and where it gates:**

| Fix | Cost | Gate |
|---|---|---|
| Add `process.exit(missing.length ? 1 : 0)` | 1 line | **P0**, before wiring |
| Add a `Lint i18n` step to `ci.yml` frontend job, after Lint | 3 lines | **P0**, blocking on PRs |
| Add the reverse direction (defined-but-unused), **warn-only** | ~15 LOC | P0, non-blocking. Surfaces the 13 dead keys |
| Hardcoded-string heuristic — flag JSX text nodes and `placeholder=`/`title=`/`aria-label=` literals over ~3 chars, **warn-only with a ratchet**, allowlisted per-directory | ~60 LOC | **G2 blocking for `src/components/crystal*` and `src/components/assistant-ui/` only** |

That last one is the one that matters here. The migration will **copy registry components containing ≥ 14 hardcoded English strings** into our repo. Without a directory-scoped hardcoded-string gate at G2, the migration adds a fresh layer of i18n debt on top of the existing 95% and `check:i18n` reports a clean pass while it happens. Scope the gate to the new directories so it blocks new debt without demanding a repo-wide cleanup.

### 9.2 Coverage is measured but never enforced

`app/vitest.config.ts` sets `coverage.provider: 'v8'` with `reporter: ['text','html','lcov']` and **no `thresholds` block**. So `npm run test:coverage` (`ci.yml:44`) reports coverage and cannot fail on a drop.

This is the wrong gate to be missing during a migration that deletes ~2,800 source lines and ~1,150 test lines. Deleting a well-tested file *raises* line coverage percentage while lowering absolute safety — precisely the number that must not be the gate.

**Recommendation, at P0:**

1. Add a `thresholds` block set to **current measured coverage minus 1 point**, as a ratchet.
2. Add a **per-file threshold for `src/components/CrystalPanel.tsx` and its successors**, so the migration cannot dilute Crystal coverage behind a healthy repo-wide average.
3. At **G4b**, recompute the floor **in the same PR as the deletion**, with the new number justified in the PR body. Never lower a threshold in a separate commit — that is how ratchets silently unwind.

### 9.3 There is no a11y check anywhere in the repo

Confirmed. No axe, no jest-axe, no lighthouse, no a11y assertion in any of 204 test files.

`README.md:118` states plainly that assistant-ui's primitives carry no ARIA and that **accessibility remains ours to build (~165 LOC) — the migration does not deliver it.** And `ASSESSMENT_XPERIQ_UI.md:219` finds adoption *introduces* two new defects (unguarded `animate-pulse`/`animate-in`/`animate-out` against the house `prefers-reduced-motion` rule at `app/CLAUDE.md`; a second low-contrast surface).

**Recommendation:**

| Fix | Cost | Gate |
|---|---|---|
| Add `vitest-axe`; scan the Crystal panel in both open and streaming states | ~40 LOC | **P0** — establishes the baseline violation count |
| **Zero-new-violations gate** vs the recorded legacy baseline | included | **G2 blocking** — the only thing that stops adoption's two new defects shipping |
| The 4 measured contrast failures + `role="log" aria-live="polite"` at the thread container (`:1331`) | ~35 LOC | G3b |

Recording the baseline at P0 rather than G2 matters: a baseline captured *after* the new chassis exists cannot distinguish pre-existing defects from imported ones.

### 9.4 Two smaller gaps

- **Lockfiles are deleted in CI** on both jobs (`ci.yml:35`, `:68`). Transitive dependencies resolve fresh on every run. With 19 new caret-ranged transitive deps (§6.2) this makes CI non-reproducible exactly when reproducibility matters most. **Fix before adding the dependency.** P0.
- **`app/vitest.config.ts` injects `VITE_CRYSTAL_STREAMING: 'true'`** for an env var `app/CLAUDE.md` states no longer exists. Delete it at P0 — 1 line, and it is the fossil of the last flag we failed to retire (§3.1). Leaving it while introducing a new flag is the wrong signal to send.

---

## 10. Phased plan

### 10.1 Phases, days, prerequisites, rollback

Working days are **QA/release engineering only** — my scope. They do not include Nadia's adapter, Theo's a11y/design-system work, or Priya's contract work, each of which is costed in their own documents. One engineer, no parallelism assumed within a phase.

| Phase | Work | Days | Prerequisites | Rollback path |
|---|---|---|---|---|
| **P0** | §8.1 keyframe extraction + guard (0.5) · §8.2 token-test content-match + `ExperientCopilot` (0.5) · §9 CI gaps: i18n exit code + wire, coverage thresholds, axe baseline, lockfile, stale env (1.5) · §7.4 brand-cascade test (0.5) · §2 characterisation suite, ~700 LOC (6) · §3 flag scaffolding + both-branch mount test (1.5) · §4 funnel invariant queries + Grafana panel (0.5) | **11** | none | n/a — nothing user-visible ships |
| **G0** | Spike acceptance harness + countersign §7 result sheet | **1** | P0 green | delete branch |
| **G1** | Additivity regression suite (1) · §4.2 Property 1 client half: serialised writes + monotonic guard (1) · §4.4 rewrite `crystalProposals.test.js` (0.5) · Property 2 SQL-assertion suite vs real Postgres (1.5) | **4** | G0 pass; Priya's contract work | revert contract PR, one deploy, zero user impact |
| **G2** | `describe.each` both-chassis parameterisation (0.5) · 18-branch funnel contract tests + ordering (1.5) · rewrite ~1,150 LOC interaction layer (2.5) · axe zero-new-violations gate (0.5) · i18n hardcoded-string gate for new dirs (1) | **6** | G1 + **≥ 2 weeks legacy-only baseline** | per-org flag UPDATE, < 1 min |
| **G3** | 4 slice gates: markdown/XSS/citation-in-AST (1.5) · a11y incl. negative assertions on focus-trap (1) · persistence cross-user + flip-clears (1) · charts: unknown-name, malformed-spec, a11y (1.5) | **5** | G2 sign-off | per-slice flag off, < 1 min |
| **G4a** | Flag-flip rehearsal + audit rows (1) · 30-day monitoring runbook (0.5) | **1.5** | G3 slices green | default flip back + bulk UPDATE, < 5 min |
| **G4b** | Deletion audit (1) · coverage-floor recompute (0.5) | **1.5** | **G4a + 30 days, zero rollbacks** | **none — point of no return** |
| | **Total** | **30** | | |

**Calendar, not effort:** ~6 working weeks of QA effort, but G1→G2 has a hard **≥ 2-week** wait for the funnel baseline (§4.3 item 4) and G4a→G4b a hard **30-day** wait. **Minimum calendar time from P0 start to G4b is ~14 weeks.** Compressing either wait forfeits the thing it buys: a trustworthy baseline, and evidence the kill switch was never needed.

### 10.2 Costs stated honestly

- **~700 LOC of characterisation tests are written for code we intend to delete.** That is the deal. Without them, "zero regression" at G2 is an assertion, not a measurement — and §1.3 shows the current suite cannot detect a single one of the twelve behaviours in §1.4.
- **Test LOC delta is ~+1,460**, roughly triple Nadia's +480. Her figure is correct for a plan without a characterisation phase; this plan has one.
- **11 of 30 days land before G0** — before anyone knows whether the spike passes. If sub-goal 2 fails (§7.6), those 11 days are still fully banked: **every P0 item is verdict-independent**, and three of them (the token-test range, `check:i18n`, and the brand-cascade invariant) are already on `FINDINGS.md`'s own Tier-0 list. The other five — characterisation suite, keyframe extraction, coverage thresholds, axe baseline, lockfile handling — are new, and all five are worth doing whether or not Crystal ever moves chassis.
- **~9 engineer-days/year of permanent churn tax** at the observed cadence (§6.4), indefinitely, until 1.0. That is a new recurring line item on the platform's most important UI surface.
- **The 2-week and 30-day waits are not padding.** Removing them removes the gate.

### 10.3 The one thing I would change about `README.md`

`README.md:103` puts "old panel deleted" inside G4. **Split it (§5.5): G4a defaults the flag on and keeps both panels; G4b deletes after 30 clean days.** Deleting the fallback at the moment of cutover means the kill switch's own existence is untested at exactly the moment it is most needed. Cost of the amendment: ~30 days of a dead code path. Value: an actual kill switch at full traffic.

### 10.4 Needs a product decision — I will not resolve these by default

**A. G3's internal ordering. (The one `TEAM.md:128` predicted.)** Markdown, a11y, persistence, and charts are four user-facing features. Nobody on this pod can rank them by user value: no PM, no user research, and `FINDINGS.md:188` states plainly that "nobody can say whether users are actually complaining." My structural answer is four independent flag-gated slices shippable in any order (§5.4), which costs ~60 LOC of extra plumbing and hands the choice to whoever should be making it. **I am not choosing.** Note one asymmetry the decider should have: **a11y (G3b) is the only slice with an external compliance dimension**, and `README.md:118` confirms the migration delivers none of it.

**B. Generative UI's two abandoned precedents.** `MiniNPSChart` was deliberately removed (`CrystalPanel.tsx:2543`) while Recharts was already available, and `render_hint:'document'` has a live client half (`:416`, `:449`, `:459`) with no server emitter. Two abandoned attempts at rich content is a pattern, and `README.md:127` says so. **If the cause was product judgment, G3d will be abandoned a third time.** §7.3 asks the question at G0, where it costs three days instead of three weeks. It needs an answer from a product owner, not an engineer.

**C. The funnel discontinuity is a declared, unrecoverable metrics break.** Accept rates before and after Property 1 are not comparable, and backfilling is impossible because the information was never recorded (§4.3). Somebody who owns the metric must sign off that pre-fix numbers are void for accept-rate purposes. Engineering cannot make that call, and a heuristic backfill would inject a fabricated number into the input of skill quality.

**D. `XperiqCopilot` sequencing — `README.md` and Theo conflict, and it changes my numbers.** `README.md:103` puts convergence at G4. `ASSESSMENT_XPERIQ_UI.md:397` rules it must happen **before** the migration, because leaving it in place roughly doubles the migration's scope. **I side with Theo, on test-specific grounds:** every gate from G2 onward runs under `describe.each(['legacy','assistant_ui'])`, and an unconverged `XperiqCopilot` makes that a **third arm** — a second `ExternalStoreRuntime` over a different message type (`ExperientCopilot.tsx:53-60`) and a non-streaming transport. That is not a doubling of the *migration*; it is a doubling of **every gate in this document**. Theo costs step 1 at ~1 day. **Deciding it late costs ~6 extra QA days across G2–G4.** This is the cheapest decision on the list and the most expensive to defer.

**E. Do we adopt `0.15.x` at seven days old?** `0.15.0` shipped 2026-07-28 and has already needed four patches, three of them on 2026-08-03. Its migration guide has **no codemod** for its two hardest changes. Options: pin `0.15.4` and accept early-adopter risk (my recommendation, given the isolation layer in §6.5 and the canary in §6.3 contain it); or pin `0.14.29` (2026-07-28, 26 patches of settling) and take the v0.15 upgrade as a scheduled item during G2. The second is more conservative and costs one upgrade cycle. **It is a risk-appetite decision, not a technical one.**

---

## 11. Cross-checks (per `TEAM.md:120-124`)

**Sam ↔ Priya — funnel integrity and message-identity ordering.** Agreed: her §5(a) work is a **hard prerequisite for G2, not G4**, because the fixed funnel needs ≥ 2 weeks of legacy-only runway to produce a trustworthy baseline (§4.3 item 4). Her ordering (§1 identity → §5(a) funnel) is correct and I adopt it as G1's internal sequence. **Three additions to her scope:** (i) defects (e), (f), (g) in §4.1 — the unique index omits `survey_id`, `DO UPDATE SET` freezes six columns, `emitted_at` is never refreshed; her uuid `proposal_id` fixes all three, so this is confirmation, not new work; (ii) defect (h), the same-tick `accepted`-vs-terminal race on 11 of 18 branches, which is **client-side and in nobody's plan** — I own it, ~0.5 d, and it is what makes her baseline reproducible; (iii) `crystalProposals.test.js:70` pins the old semantics and must be rewritten in her commit (§4.4). One correction for her parity test: I count **21** members in `ActionProposalType` at `types/index.ts:782-807`, not 25.

**Sam ↔ Nadia — G0 criteria and the isolation layer.** §7 is written to be countersignable: four pass/fail marks, two measurements, run sub-goal 2 first because it is the disqualifier. **Two things she needs from me:** the isolation-layer design (§6.5) does not exist in her assessment, and `README.md:90` requires one — I have specified the shape (one import boundary, ESLint-enforced, type-asserted) and she owns the implementation. And §7.4 has a **hard precondition she did not have**: the brand-cascade invariant is untested, so a false positive on "styled components inherit our brand" is indistinguishable from a true one. **One agreement:** her "you cannot `vi.mock('@assistant-ui/react')` — you need the real runtime" (`ASSESSMENT_CRYSTAL_UI.md:166`) is correct and is why the ~1,150 LOC interaction-layer rewrite is 2.5 days rather than 1.

**Sam ↔ Theo — CI gates and landmines.** I adopt his 10-item platform sequence into P0 wholesale and extend it in three places: **`check:i18n` needs an exit code before it is wired**, or the CI step can never fail (his recommendation and `FINDINGS.md:149` both say "one line," and as written it would be a no-op step); **coverage has no thresholds**, which he did not cover and which is the specific gate a deletion-heavy migration needs; and the token-test range has a **+1/−4 line margin** and is also a false-*negative* hole, not only a false positive. His axe-in-CI proposal becomes the G2 zero-new-violations gate, with the baseline recorded at **P0** so imported defects are distinguishable from pre-existing ones. I back his non-modal ruling and have encoded it as a **negative assertion** in G3b: a test that asserts focus-trap/`aria-modal`/`role="dialog"` are **absent**, so a well-meaning future PR cannot reintroduce them.

**Sam ↔ everyone — which gate each member's work lands behind.** Priya's identity + funnel → **G1**. Priya's thread persistence → **G3c**. Priya's machine-coded frames + `locale` → **G3b** (Theo needs the codes for the live region to be worth hearing). Theo's Tier-0 platform hygiene → **P0**. Theo's a11y pass → **G3b**. Nadia's adapter + custom parts + ToolUI → **G2**. Nadia's monolith split → **P0 if it happens before the flag lands, otherwise G2** (either way, §8.2 must be fixed first or the split turns the suite red on a line that is supposed to keep its hex).
