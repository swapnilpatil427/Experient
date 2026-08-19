# Findings: Frontend (React/UI) — Jordan

## 1. Vantage-point summary

I read `BRIEF.md`, `TEAM.md`, `Crystal-harness/00-SYNTHESIS.md` in full, and `02-cme-langgraph-service.md` §4 (the six "skills app" graphs, `ToolStatusCallbackHandler`). Then I read the actual frontend code that consumes Crystal's stream, end to end:

- `app/src/components/CrystalPanel.tsx` (full file, ~2038 lines) — the panel shell, `CrystalBubble`, `CrystalThinkingBubble`, `ActionProposalCard`, `SourcesFooter`, `InlineCitation`, `CitedText`.
- `app/src/components/crystal/runtime/useCrystalConversation.ts` (790 lines) — this is where the real SSE-reading loop and `executeAction` dispatch now live (extracted from `CrystalPanel.tsx` per `docs/harness-engineering/assistant-ui-migration/TRACKER.md`; `CrystalPanel.tsx` and the in-progress assistant-ui shell, `CrystalThreadShell.tsx`, both call into it). This is the file that actually parses every SSE event type.
- `app/src/components/crystal/runtime/parts.ts` — the shared `CrystalMessage`/`CrystalCitation`/`CrystalStreamingPhase` types.
- `crystalos/CLAUDE.md` — the CrystalOS-side view of the same contract (skill-first streaming, action-proposal boundary, tool registry, `debug_routing`/`debug_timing`).
- `app/src/lib/api.ts` and `backend/src/routes/experience.ts` (grepped around the `/:scope/crystal/stream` handler) to confirm the Express layer is a near-pure SSE proxy, not a transform layer.

**Scoping note**: `CrystalPanel.tsx` is mid-migration to an assistant-ui-based shell (`docs/harness-engineering/assistant-ui-migration/`). The SSE-parsing logic already lives in one shared hook (`useCrystalConversation.ts`), not duplicated — good news for this assessment: whatever CrystalOS changes, there is exactly **one** frontend call site that needs to track it.

## 2. The exact current SSE event contract (baseline)

`useCrystalConversation.ts`'s `submitQuery` POSTs to `/api/experience/{streamScope}/crystal/stream` (Express proxy → CrystalOS `/insights/crystal/stream`, confirmed a near-raw `res.write(chunk as Buffer)` passthrough at `experience.ts:828`, with one exception noted below), reads SSE (`data: {...}\n\n`, sentinel `data: [DONE]`), and switches on `event.type` with a plain `if/else if` chain (lines 242–309):

| `event.type` | Fields read | Effect |
|---|---:|---|
| `citation_context` | `map` | Merges into `citationMapRef`; **scans backward for the most recent `role: 'crystal'` message and enriches its `.citations`** (see Risk §5) |
| `thinking` | `tool?`, `message?` | `setStreamingState({ phase: 'thinking', tool, message })` |
| `observation` | `tool?`, `summary?` | `setStreamingState({ phase: 'observation', tool, summary })` |
| `synthesizing` | — | `setStreamingState({ phase: 'synthesizing' })` |
| `answer` | `answer`, `citations[]`, `insight_refs?`, `suggestions?`, `documents?`, `viz?` | Sets `answerReceived = true`; builds a `CrystalMessage` (cleaned text, normalized citations, `documents` — where `render_hint==='document'` lands as `InsightDocumentCard`, `viz`) |
| `action_proposals` | `proposals[]` | `onProposalsReceived(proposals)` — stored in a flat tray, **not attached to the message** |
| `error` | `message?` | Also sets `answerReceived = true` (prevents double-fallback); pushes an error-origin message |
| anything else / parse failure | — | Silently ignored — no default branch, `try/catch` swallows malformed lines |

Notable: **unknown event types are a no-op, not an error** (good forward-compatibility — already saved a proposal-type drift once, per `executeAction`'s documented `default:` case). **`debug_routing`/`debug_timing`** (legacy `?legacy=true`/`?debug=true` only, confirmed in `agents/crystal.py`) are **not parsed anywhere in the frontend** — zero UI dependency today. The **REST-fallback guard**: if the stream ends without `answerReceived` ever being set, the frontend re-asks via `api.crystalChat2()` — `action_proposals` alone does not set that flag (see Risk §5.3).

## 3. Simplification opportunities

Being honest: most harness patterns are backend-internal and don't touch frontend code, so there's little to claim here. One candidate: **`CrystalThinkingBubble`'s `AccumulatedStep` state machine** (`CrystalPanel.tsx` lines 1473–1561) hand-reconstructs step timing client-side (wall-clock `Date.now()` deltas, skewed by network jitter) from a best-effort `thinking`/`observation` cadence. If CrystalOS ever emitted explicit `{tool_start, started_at}`/`{tool_end, ended_at}` pairs (closer to what `ToolStatusCallbackHandler` produces), this component could use server timestamps instead — a nice-to-have, not a blocker.

I did **not** find frontend code that would get measurably simpler from `RequestValidationMiddleware`, provenance stamping, the tool-error-contract formalization, the living-legacy table, or named hook-point vocabulary in `SkillRuntime.execute()`. All operate entirely behind the SSE boundary in §2.

## 4. Improvement opportunities (tied to specific synthesis-doc patterns)

### 4a. `applied_filters`-equivalent (synthesis Tier 2 #7) — genuinely worth building

This is the one pattern designed to be user-facing, and there's a real gap it fills. **The gap**: `CrystalThinkingBubble` shows a live per-tool reasoning trace (`TOOL_META`, lines 1457–1471) *while the turn is in flight*, but its state is ephemeral (reset every mount) — once `answer` lands and `isThinking` flips false, the trace is gone. There's no persistent record on the `CrystalMessage` of "what window/segments/survey scope/tools Crystal actually queried." Today's transparency (`SourcesFooter`/`InlineCitation`) answers "what evidence backs this sentence" — a different question from "what did Crystal actually search."

**What CrystalOS would need to ship**: per the synthesis doc, `tool_results` already carries the raw args — "mostly a normalization function away." An `applied_filters` object on the `answer` event (or its own event, always present even if empty): `{ window, surveys, segments, tools_called }`.

**What the frontend would need**: a small disclosure — "What Crystal searched" — sibling to the existing `SourcesFooter` toggle (lines 1196–1246). Since the exact UI pattern already exists, this is a half-day-to-a-day task: one new `CrystalMessage` field, one more parsed SSE field, one more collapsible panel.

**Worth it?** Yes, conditionally — the scope/tag-focus chips already in the panel header reflect what was *requested*, not necessarily what a skill actually pulled (a skill could silently narrow scope internally); this closes that gap. Real, if modest, value — not solving a problem the UI doesn't have.

### 4b. `ToolStatusCallbackHandler` pattern vs. current streaming UX — mostly redundant, one real risk

**CrystalOS already has this — independently built, arguably better.** The harness's handler is a **two-state** model (`tool_running`/`thinking`, static status strings). CrystalOS's current stream is a **three-phase** model (`thinking` with a live message, `observation` with a found-summary, `synthesizing`) rendered with per-tool icons, elapsed timers, and animated step transitions. From a "genuine UX improvement" standpoint: **no** — CrystalOS's UI already exceeds this pattern.

Where it *would* help is backend code organization only: decoupling "what text shows for tool X" from "the loop that runs tools" (currently hand-written `yield (...)` calls). **Zero required frontend work, provided the refactor preserves the existing wire vocabulary** (`thinking`/`observation`/`synthesizing` as `type`, `tool`/`message`/`summary` as fields).

**The risk, stated plainly**: if the implementer reaches for the harness's own naming (`tool_running`) while porting the pattern, it silently breaks `useCrystalConversation.ts`'s `if/else` chain — not via a flagged "contract change," but via a naming choice. I'd want this called out explicitly: keep the existing vocabulary verbatim.

## 5. Risks / what could break (frontend-specific)

1. **Event-type/field renaming during the callback-handler refactor** — highest-probability accidental break. No schema validation; an unrecognized `type` is silently dropped, so a rename wouldn't throw anywhere — the thinking UI would just go blank with no console error. Regression test: feed the exact current SSE sequence (`thinking → thinking → observation → synthesizing → answer`) through the hook and assert message/state transitions (there's already a new `__tests__/hooks/useCrystalConversation.test.ts` in git status — hand that fixture to whoever owns the refactor as the literal contract to preserve).

2. **Implicit ordering: `citation_context` assumed to arrive *after* the `answer` it enriches.** The handler scans backward for the most recent crystal message. I confirmed one source of `citation_context` is injected by the Express proxy *before* it even calls CrystalOS (`experience.ts:788`, before the `fetch` at line 795) — safe by construction today. But if CrystalOS's own synthesis path is refactored to also emit `citation_context` (e.g. as a side effect of the `applied_filters` addition), the ordering guarantee becomes CrystalOS's responsibility. Should be an explicit regression-test invariant.

3. **`action_proposals`-only turns don't set `answerReceived`.** If a hook-point refactor ever short-circuits synthesis when a proposal alone is deemed sufficient (no `answer`/`error` for that turn), the frontend fires a redundant `crystalChat2` REST fallback after the stream closes, potentially appending an unrelated second answer bubble. Pre-existing latent bug, not harness-caused, but a refactor that changes "when is a turn done" is exactly what could newly trigger it.

4. **Tier 1 items touch nothing in the SSE contract** — traced each one; all operate strictly upstream of where `answer`/`action_proposals`/`error` get emitted. Zero frontend risk, provided (per BRIEF.md) `_run_skill_stream`'s existing fallback chain and emission points are preserved — Marcus's/Priya's territory to confirm.

## 6. Recommendation

**Adopt selected patterns only — push for the `applied_filters` UI disclosure (§4a); no opinion on, and no objection to, the rest, provided the SSE event vocabulary is treated as a versioned contract during any refactor.**

The overwhelming majority of this rearchitecture (Tier 1 in full, most of Tier 2, all of Tier 3) is invisible to the frontend — it improves reliability/observability/code organization without changing a byte the frontend parses, and I have no UI-value basis to weigh in on those. The one item worth actively championing is `applied_filters`, because it's the one pattern explicitly designed to be user-facing and there's a concrete, demonstrable gap (the ephemeral reasoning trace vanishing once an answer lands) at genuinely small frontend cost. `ToolStatusCallbackHandler` is not worth pursuing for UI reasons — CrystalOS's current stream already beats it — only for backend reasons outside my lane, conditioned on the wire vocabulary not silently drifting.

## 7. Open questions for the rest of the team

1. **Priya/Marcus**: if the callback-handler-style refactor (naming hook points, Tier 2 #10) goes ahead, will `thinking`/`observation`/`synthesizing` + `tool`/`message`/`summary` be pinned as an explicit, tested contract (mirroring the harness's own `test_tool_status_callback.py`), or is a wire-format change on the table?
2. **Whoever owns `applied_filters`**: is it in scope for this pass, or a separate future decision? I've sized the frontend half assuming it might be bundled in.
3. **Dana**: since `experience.ts`'s proxy injects its own `citation_context` before calling CrystalOS — if CrystalOS ever emits its own `citation_context`/`applied_filters`, do the two sources need reconciling to avoid duplicate citation-map sources per turn?
