# Crystal Chat UI — Current State Audit

> **Method:** Two independent parallel audits (frontend inventory; CrystalOS + backend contract), each required to cite `file:line` for every claim. Findings below were cross-checked where the two overlapped — notably the streaming protocol, which both traced independently and agreed on.
> **Date:** 2026-08-04
> **Nothing in this document is a recommendation.** It is the evidence base.

---

## 1. Size and shape

| Subsystem | Location | LOC | Coupling to Crystal domain |
|---|---|---|---|
| Panel shell (header, scope strip, composer, thread area) | `CrystalPanel.tsx:167-1540` | ~1,373 | medium |
| Message bubbles + citation rendering | `CrystalPanel.tsx:1641-2189` + helpers `:1663-1728` | ~475 | **high** |
| Streaming reasoning timeline | `CrystalPanel.tsx:2192-2540` | ~337 | **high** |
| Action proposals / confirm-cards / execute | `CrystalPanel.tsx:737-1103`, `:2547-2798`, `types/index.ts:782-822` | ~640 | **high** |
| Empty state + brand orb | `CrystalPanel.tsx:1543-1638` | 94 | low |
| Panel state/context | `contexts/crystalPanel.tsx` | 140 | **high** |
| Transport | `lib/api.ts:2076-2092`, `:2184-2245`, `:3285-3288` + inline `fetch` at `CrystalPanel.tsx:336-380` | ~140 | **high** |
| In-message insight doc card | `components/insights/InsightDocumentCard.tsx` | 130 | **high** |

**`CrystalPanel.tsx` is a single 2,799-line file.** The chat experience proper is ~3,700 LOC across 5 files. Adding the second chat implementation and dead code brings the total chat-shaped surface to ~5,000 LOC.

### Duplicate and dead chat surfaces

| File | LOC | Status |
|---|---|---|
| `components/ExperientCopilot.tsx` (exported as `XperiqCopilot`) | 616 | **Live** — survey builder only. Own `ChatMessage` type `:53-60`, own message state `:117-128`, own ⌘K `:146-156`. AppShell suppresses the global panel on that route (`AppShell.tsx:43,64-65,101-103`) |
| `components/IrisChat.tsx` | 316 | **Dead** — zero importers |
| `pages/insights/ConversationView.tsx` | 363 | **Dead** — zero importers; hardcoded design mock (fake NPS answer `:118-136`, hand-rolled bar chart `:139-164`) |

679 LOC of dead chat code is deletable today with no migration decision required.

---

## 2. The streaming contract

**There is no token streaming.** CrystalOS makes a non-streaming JSON-mode LLM call (`crystalos/lib/openrouter.py:214-227`) and emits one atomic `answer` event (`crystalos/agents/crystal.py:1968`). The frontend appends a whole new message (`CrystalPanel.tsx:450-461`). The only stream-shaped state is a 3-phase reasoning timeline, not text deltas.

Transport is SSE over `fetch` + manual `ReadableStream` parsing (`CrystalPanel.tsx:386-482`) — not `EventSource`, though `EventSource` is used elsewhere in the app (`hooks/useOrgDashboardLive.ts:72`).

| Event | Payload | Consumer | Notes |
|---|---|---|---|
| `citation_context` | `{ map: Record<id, {headline, survey_title, survey_id, layer, category, verbatims[], topic_name}> }` | `:419-431` | **Injected by Express, not CrystalOS** (`backend/src/routes/experience.ts:782`). Always arrives first — before the message reaches the model. Retro-enriches already-rendered messages |
| `thinking` | `{ tool, message }` | `:432-433` | Pre-fetch context tool, **not** a model-chosen tool call |
| `observation` | `{ tool, summary }` (≤200 chars) | `:434-435` | |
| `synthesizing` | `{ message? }` | `:436-437` | |
| `action_proposals` | `{ proposals: ActionProposal[] }` | `:462-463` | May arrive **before** `answer` |
| `answer` | `{ answer, citations[], insight_refs[], suggestions[] }` | `:438-461` | Terminal content event, one shot |
| `error` | `{ message }` | `:464-477` | Rendered as a chat message |
| `[DONE]` | raw string, not JSON | `:403` | |
| `debug_routing`, `debug_timing` | — | **none** | Unreachable: the proxy drops query params (`experience.ts:789`) |

**Two defects found in passing:**
- `answer.documents[]` is consumed by the frontend (`:449,459,2109` → `InsightDocumentCard`) but **no server emitter exists.** `render_hint:'document'` appears only inside tool-result dicts (`crystalos/crystal/tools.py:2892,2942,3509,3570`). The in-message document card is unreachable code.
- Errors arrive as HTTP-200 SSE `error` events, not HTTP errors (`crystal.py:1808,1811-1813,1992`). Only credit exhaustion is a real 402, checked pre-headers (`experience.ts:640-648`).

---

## 3. Fifteen ways the contract is not OpenAI-shaped

This is the crux of the migration question. Any chat library assumes a message-completion contract; Crystal's differs on fifteen counts.

| # | Divergence | Evidence |
|---|---|---|
| 1 | No token/delta streaming — one atomic `answer` | `crystal.py:1968`; `openrouter.py:214-227` |
| 2 | SSE frames carry no `event:` name and no `id:` — unnamed `data:` with an inner `type` discriminator | `main.py:1797` |
| 3 | `[DONE]` has non-OpenAI semantics; stream may end with no `answer`, requiring a client REST refetch | `main.py:1807`; `CrystalPanel.tsx:486-556` |
| 4 | **Client uploads its own grounding corpus every turn** (`insights[]`, `topics[]`, `metrics{}`, `survey_title`, `survey_response_count`), server-merged "client wins if non-empty" | `CrystalPanel.tsx:344-351`; `experience.ts:720-732` |
| 5 | Conversation history is a per-request body field, not server state — no `thread_id` on the wire | `CrystalPanel.tsx:352-354` |
| 6 | **No message IDs, turn IDs, or run IDs anywhere on the wire** | `crystalos/routers/feedback.py:22` wants a `turn_event_id` that is never emitted |
| 7 | Out-of-band structured side-channels (`citation_context` from a different service; `action_proposals` may precede the answer) | `experience.ts:782`; `crystal.py:1962-1965` |
| 8 | Citations encoded as inline `[uuid]` markers inside prose, stripped client-side and joined against the earlier map | `CrystalPanel.tsx:441-447` |
| 9 | `thinking`/`observation` are pre-fetch context tools — no args, no results, no tool-call IDs, no `tool_result` messages | `crystal.py:1903-1947` |
| 10 | Action proposals are a confirm-then-execute client contract — 18-branch switch, 12 REST endpoints, bespoke DataBus invalidation, fired *after* the assistant finished | `CrystalPanel.tsx:754-1021`; `lib/dataBus.ts` |
| 11 | A 3-status outcome funnel is a required side-effect of rendering a proposal | `CrystalPanel.tsx:774,1094-1102`; `backend/src/routes/insights.ts:2286` |
| 12 | Errors are 200-OK SSE events, not HTTP errors | `crystal.py:1808,1811-1813,1992` |
| 13 | Two adjacent SSE channels with different framing conventions | `backend/src/services/org-realtime.service.ts:13-20` |
| 14 | Non-chat body fields with routing semantics — `surface`, `builder_draft`, `workflow_registry`, `brief_id`, `tag_id`, `window`, `focused_topic`, `scope`. **`surface` hard-forces skill routing** | `CrystalPanel.tsx:355-377`; `crystal.py:1776` |
| 15 | Non-model progress vocabulary (`thinking`/`observation`/`synthesizing`) drives a bespoke timeline + 3D orb | `CrystalPanel.tsx:2210-2440` |

**#6 is the one that bites hardest.** The features a chat library gives away free — edit, regenerate, branch-picker — all require stable message identity. Crystal's wire format has none. Those features cannot be "inherited"; they require a contract change across all three layers first.

---

## 4. State and persistence

**Live conversation state is one `useState` array**: `CrystalPanel.tsx:196`. No store, no query cache. `contexts/crystalPanel.tsx` holds open/close + grounding only, not messages.

**Nothing persists.** A reload wipes the thread; AppShell force-closes the panel on every navigation (`AppShell.tsx:56-58`). There is no thread list, no titles, no switching.

Meanwhile, **three thread implementations exist and two are dead**:

| Schema | DDL | Status |
|---|---|---|
| `crystal_threads` v1 — `thread_key UNIQUE, messages JSONB, context_snapshot` | `supabase/migrations/20240518000000_insights_v2.sql:42-55` | Written only by the **unary** path (`insights.ts:1463-1475`), which is gated off behind `CRYSTAL_STREAMING = true` (`CrystalPanel.tsx:29,602`) |
| `crystal_threads` v2 — adds `user_id, scope, last_active_at, storage_expires_at, message_count, context_state, turn_count` | `20240521000002_crystal_threads_v2.sql:3-18`; `20260603000003_crystal_threads_context_state.sql:7-20` | `get_or_create_thread` / `append_to_thread` (`crystal.py:219-307`) called from **nowhere in production**. `storage_expires_at` written, never swept |
| React state | `CrystalPanel.tsx:196` | The live reality |

`GET /api/insights/:surveyId/crystal/history` is **real and functional** (`insights.ts:1492`) — over a table fed by a dead code path, read by nobody. `api.getCrystalHistory` / `clearCrystalHistory` exist (`lib/api.ts:2232-2245`) with zero callers. The SSE path writes to no thread table at all. The two schemas disagree on identity key (`thread_key` vs `(org_id, user_id, survey_id, scope)`).

**Implication:** thread persistence is *closer than it looks* and *more confused than it looks*. Any migration inherits this mess; so does any hand-built fix.

---

## 5. Action proposals — the differentiated asset

The propose → confirm → execute → record-outcome loop is what the root `CLAUDE.md` calls "the unlock." It is also the least generic thing in the codebase.

| Layer | Location | Contents |
|---|---|---|
| CrystalOS model | `crystal.py:157-173` | `ActionProposal`: `id, type, title, description, cta_label, params, priority, estimated_time, business_rationale, requires_confirmation=True` |
| Normalisation authority | `crystal.py:933-949` `_PROPOSAL_TYPE_ALIASES` + `_normalize_proposal:952-969` | Maps emitted `proposal_type` → frontend handler name |
| Raw emitted values | `crystalos/crystal/tools.py` (16 sites) | 16 distinct strings |
| **The only enumerated union** | `app/src/types/index.ts:782-822` | `ActionProposalType` — 25 members |

**Source-of-truth problem:** the only enum lives in TypeScript. CrystalOS validates `type` as a free string. Drift already exists — TS declares `workflow`, `template`, `export_insights` (`types/index.ts:786,787,789`) with no dispatcher case, so they silently fall through to `default` (`CrystalPanel.tsx:1009-1011`).

**Outcome funnel:** table `crystal_action_proposals` (`20260623000010_crystal_action_proposals.sql:6-31`). Status values are documented only by comment — **no CHECK constraint** (`:17,36`). Client emits `accepted` (`CrystalPanel.tsx:774`) → `succeeded`/`failed`, or `dismissed` (`:1094-1102`). **`emitted` is never written by any code**, so emit→accept conversion is unmeasurable — the top of the AI-quality funnel is missing. `GET .../crystal/proposals` (`insights.ts:2348`) has no caller.

---

## 6. What's missing that users notice

| Gap | Evidence |
|---|---|
| **No markdown rendering** | `CrystalBubble` renders content through `CitedText`, which emits plain `<span>`s (`:2104-2106,1851-1869`). No `react-markdown`/`remark`/`marked` in `app/package.json:19-62`. `**bold**`, lists, tables, and headings render literally |
| **No code blocks / syntax highlighting** | no `shiki`/`prismjs` dependency |
| **No thread persistence or history** | §4 |
| **No copy / edit / regenerate / branch** | blocked by wire-format finding #6 |
| **No attachments** | no `type="file"`, no `FormData` in the panel |
| **Voice input only, no TTS** | Web Speech API mic `:678-703`; no speech output |
| **Accessibility is effectively absent** | **One** aria attribute in 2,799 lines (`:1765`). No `aria-live` / `role="log"` / `role="status"` — streaming answers and the reasoning timeline are **never announced** (WCAG 4.1.3). **No Escape-to-close.** Closing does not restore focus. Header controls use `title` only. No `prefers-reduced-motion` guard on 9 inline keyframes. Four measured WCAG AA contrast failures: `:1494` placeholder **2.24:1**, `:2498` **3.01:1**, `:2506` ~3.6:1 (all vs 4.5:1), `:1465` composer border **1.23:1** vs 3:1.<br>**CORRECTED 2026-08-04 (Theo, `ASSESSMENT_XPERIQ_UI.md`):** an earlier version of this row listed "no focus trap, no `aria-modal`, no `role=\"dialog\"`" as gaps. **They are not owed work** — Crystal is *non-modal* (no overlay; the page stays interactive), so two of the three would be defects to *add*. Focus-in already exists at `:666-671`. |
| **i18n rule not followed** | Root `CLAUDE.md` mandates all strings via `t()`. `CrystalPanel.tsx` has **12** `t()` calls in 2,799 lines (`:939,1198,1204,1255,1391,1409,1421,1424,1429,1437,1442,1488`). Everything else is hardcoded English. 6 `crystal:` namespaces exist in `locales/en.ts` (~93 keys); **10 are used**. `TOOL_META.label` values `:2193-2205` duplicate dead locale keys at `en.ts:3947-3961` |

The app demonstrably knows the a11y patterns it isn't applying: `aria-live` appears in `insights/TopicChangeBar.tsx:77`, `tag-report/PipelineVisualization.tsx:113`, `prism/FileDropzone.tsx:301`; `InvestigationDrawer.tsx:349-352` uses a Radix `Sheet` with proper labelling. The Crystal panel is a bare `motion.div` (`:1154`) and gets none of it.

---

## 7. Styling, tests, entry points

**Styling is overwhelmingly bespoke.** The only shadcn primitive in `CrystalPanel.tsx` is `Button` (`:15`). No `Dialog`, `Sheet`, `ScrollArea`, `Tooltip`, or `Popover` — the panel is hand-positioned (`:1148-1165`), the tooltip is hand-rolled hover state (`:1746,1769-1826`), the scroll container is a plain div with a manual `scrollTop` effect (`:1331-1335`).

Brand tokens are **test-enforced**: `app/src/__tests__/lib/crystalIdentityTokens.test.ts:20+` asserts no literal brand hex may appear in Crystal-identity files. Crystal reads `var(--color-primary)` / `--color-tertiary` and heavy `color-mix()` live.

**Latent bug:** `crystal-spin` is defined in `CrystalThinkingBubble`'s inline `<style>` (`:2303-2334`) but consumed by `ActionProposalCard`'s spinner (`:2783`). The Apply spinner only animates if a thinking bubble has mounted at least once this session.

**Tests: ~1,958 LOC across 7 files**, dominated by `CrystalPanel.test.tsx` (1,326). Coverage is almost entirely proposal execution and request-body correctness. Grepping the CrystalPanel test files for `citation_context`, `CitedText`, `SourcesFooter`, `ThinkingBubble`, `EmptyState`, `SpeechRecognition`, `verbatim` returns **zero hits** — the SSE timeline, citation parsing/rendering, error states, and voice are untested.

**Entry points: 50 `openCrystal()` call sites across 22 files.** Only 3 pages feed `setCrystalData`. *(Counts corrected 2026-08-04 by Theo — an earlier version said 52/26 and 4.)* This is the nominal blast radius of any change to the panel's public interface — but it proved **not** to be a differentiator between migration and no-migration: 50 openers, 69 scopers, and 3 producers are unchanged in both paths, because `openCrystal(query?, ctx?)` is a genuinely good imperative façade.

---

## 8. Peripheral defects (not blockers, but they travel with any refactor)

Eight Crystal endpoints are mismatched or orphaned, all in the admin/support periphery rather than the core chat contract:

- `/api/admin/crystal-support` is broken → breaks **both** the panel's support mode and `SupportCommandPalette.tsx:460-473`
- `adminApi.ts:304,309` → `/api/admin/dlq` but the route is `/api/admin/crystal/dlq` (`main.py:1926,1941`) → `AdminCrystalDlqPage.tsx` non-functional
- `adminApi.ts:281` → `.../signals/{sid}` but the route is `.../signals/{signal_id}/status` (`brand_admin.py:158`) → `AdminCrystalSignalsPage.tsx:90` fails
- `POST /api/group-insights/crystal` (`survey-groups.ts:627`) raw-fetches `${AGENTS_URL}/groups/crystal`, **which does not exist** in CrystalOS. No frontend caller either
- 7 of 30 `agentsClient` exports have zero callers

**One additional consumer of `CrystalOutput` exists outside the chat UI:** `crystalos/novu_connect/message_processor.py:130-174` calls `crystal_agent.run()` in-process and returns `output.answer` as a bare string for Slack/Teams/WhatsApp/email delivery. It is also the only caller anywhere that populates `user_role` (`:158-159`); the browser bridge never does, so the chat path is permanently `"viewer"`.

**Net:** the SSE contract has exactly **one** consumer (`CrystalPanel.tsx`). Reshaping the stream has a much narrower blast radius than the endpoint count suggests.
