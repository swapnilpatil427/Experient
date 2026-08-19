# Findings Round 2: Frontend (React/UI) — Jordan

## 0. Scope note

Round 2 asked me for two things: a revised view on Reframing #1 (extensibility) informed by
what I already found about the SSE contract, and a UI-specific deep dive into Reframing #2
(code interpreter / sandbox). I stayed in my lane on #2 — isolation mechanism, tool-registry
shape, and the security boundary are Priya's/Marcus's design surface, not mine; I address
only the three UI-facing sub-questions I was actually asked, plus one cross-cutting
implication for whichever shape they land on.

## 1. Revised recommendation on Reframing #1 (extensibility)

**My view shifts, but narrowly and only for the one seam I actually own: the SSE
event-type vocabulary itself should become a small, formally-tracked source of truth now,
before more event types accumulate. This does not change my Round-1 "no rearchitecture"
conclusion for anything else.**

Round 1 found that the entire harness rearchitecture is invisible to the frontend except at
one seam: the `event.type` string vocabulary (`thinking`/`observation`/`synthesizing`/
`answer`/`action_proposals`/`error`/`citation_context`) that `useCrystalConversation.ts`
parses with a plain `if/else` chain, no runtime schema validation. I flagged a specific,
concrete risk there: a well-intentioned refactor (e.g. porting the `ToolStatusCallbackHandler`
pattern) could rename `thinking`/`observation` to the harness's own `tool_running` vocabulary
without anyone treating that as "changing a contract" — because today there is no artifact
that *says* this is a contract. It's institutional knowledge (this findings doc, a few code
comments) and one new test file (`useCrystalConversation.test.ts`), not a schema either side
is required to consult before adding or renaming a `type`.

Reframing #2 sharpens why this matters *now* rather than being a someday-nice-to-have: it's
independently asking whether sandbox-execution results need a new event shape, and the
"verified" trust-signal question below (§2a) also wants a new field. That's two more
opportunities, arriving in the same design cycle, for the exact accidental-drift failure
mode I flagged in Round 1. Waiting until there are twelve ad hoc event types with no shared
source of truth is strictly worse than formalizing now, while there are still only seven.

**Concrete, zero-new-dependency mechanism** (this is the "smaller, purpose-built extension
mechanism" the reframing asks about, scoped specifically to the frontend-facing contract,
not a general skill-runtime hook framework):

1. CrystalOS already uses Pydantic everywhere (`CrystalOutput`, `ActionProposal`, etc.) — so
   defining every SSE event as a **discriminated Pydantic union** (`ThinkingEvent`,
   `ObservationEvent`, `SynthesizingEvent`, `AnswerEvent`, `ActionProposalsEvent`,
   `ErrorEvent`, `CitationContextEvent`, each with `type: Literal["..."]`, unioned into one
   `CrystalStreamEvent` type) is not a new dependency — it's using an existing one more
   deliberately, exactly the "schema-generation-on-demand from Pydantic models" pattern
   BRIEF.md's constraint section explicitly names as portable from the harness research.
2. Route every `yield json.dumps({...})` in the streaming generators through one small
   `emit(event: CrystalStreamEvent) -> str` helper that validates against that union before
   serializing. This turns "someone typos/renames a `type` string" into an immediate,
   loud Pydantic validation error caught by CrystalOS's own test suite — not a silent
   frontend regression discovered days later by a support ticket.
3. On the frontend side, the existing `CrystalStreamEvent` TS interface
   (`useCrystalConversation.ts` lines 76-90) becomes the canonical mirror, pinned by the
   fixture test I already flagged in Round 1 (`__tests__/hooks/useCrystalConversation.test.ts`).
4. The two sides don't need to be codegen-linked (a JSON-schema→TS pipeline would be a real
   build-time tool, arguably in tension with "no new dependencies," and is overkill for
   ~7-10 event types) — a **lightweight literal-set diff check** is enough: a short script
   that extracts the `Literal[...]` values from the Python union and the string-literal
   `type` values from the TS union and fails if they diverge, run in CI. That closes the
   loop without a code-generation dependency, and is small enough to write once and forget.

**Does this change "no rearchitecture" more broadly?** No — I want to be as plain about this
as the brief asks. This is a single, bounded, ~1-day formalization of a contract that already
exists informally; it is not a middleware/hook framework, doesn't touch `SkillRuntime.execute()`'s
internals, and doesn't require CrystalOS to restructure how skills or tools are authored. My
Round 1 reasoning (thin evidence for borrowed benchmark numbers, no framework to hang generic
hooks on given the JSON-mode-only model client) still applies in full to Priya's/Marcus's
broader "named hook-point vocabulary" question (Tier 2 #10) — I have no new argument for or
against that. I'm narrowly revising one thing: the SSE vocabulary specifically is cheap
enough, and now demonstrably about to grow, that formalizing it stops being "nice to have
someday" and becomes "worth doing in this cycle."

## 2. Design answer to Reframing #2 (code interpreter) — frontend/UI angle

### 2a. Does this need a new `render_hint`, beyond `document`?

**Not a new full render-hint tier for every verified answer — but yes, one new lightweight
trust signal, and conditionally one new `render_hint` for the specific pilot skill(s) that
produce a real structured artifact.**

Today's trust-signal vocabulary is deliberately layered and already distinguishes several
different kinds of "why should I believe this": `ConfidenceChip` (`message.confidence`) is
the LLM's own probabilistic self-assessment; `SourcesFooter`/`InlineCitation`/`CitedText`
show *evidentiary* provenance ("this claim traces to real survey responses"); `render_hint
==='document'` → `InsightDocumentCard` surfaces a whole generated report artifact. A
deterministic-validator result is a **fourth, distinct** kind of trust signal — "a script,
not the model, checked this specific number/structure and it passed" — and conflating it
with `confidence` (a probability) would undersell it, since a validated calculation is
categorically more trustworthy than a high-confidence LLM guess.

Concretely, I'd add a small `verification` field to the `answer` SSE event /
`CrystalMessage` (e.g. `{ checked: true, checks: ['id_assignment', 'logic_compile'] }` or
simply `{ checked: boolean }` if per-check detail isn't needed), and render it as a small
badge next to `ConfidenceChip` in `CrystalBubble`'s header (`CrystalPanel.tsx` line ~1363) —
a "Verified" chip with a `verified`/`check_circle` icon, reusing the exact chip visual
language `ConfidenceChip` already establishes rather than inventing new chrome.

Whether it needs a **full new `render_hint`** (i.e. its own card component, the way
`document` got `InsightDocumentCard`) depends on what's being validated:
- **Inline numeric/logic checks** (e.g. "this NPS delta was computed by a deterministic
  script, not re-derived by the LLM") → the badge above is sufficient; no new card.
- **A whole structured artifact with its own pass/fail issue list** (e.g. a compliance-scan
  result, a compiled survey-logic tree with per-branch validity) → this deserves its own
  `render_hint='validated_result'` + a small `ValidationResultCard`, mirroring exactly how
  `document` was scoped to Insight Pipeline v2's actual report artifact rather than applied
  to every answer. I'd reserve this for the specific pilot skill(s) Priya/Marcus choose
  (e.g. `compliance-scanner`, if that's the Tier 2 #8 pilot), not build it speculatively for
  every skill.

### 2b. Should the validation-failure-then-retry cycle be visible to the user?

**Keep the repair loop server-side by default. Surface only the end state (verified /
not), via the badge in §2a — not the mechanics of catching and fixing an issue.** I'd
actively push back on building a visible "Crystal checked its own math and caught an issue"
self-correction moment for this specific product.

Two reasons, both grounded in what's already in the codebase:

1. **There's already a precedent, and it points toward hiding this.** `SkillRuntime.execute()`'s
   existing EVALS.md retry-once-with-failure-context loop (per `crystalos/CLAUDE.md`) is
   *already* entirely invisible to the user today — a turn that required one internal retry
   looks identical, from the panel's point of view, to one that didn't. Nothing in the
   product has ever surfaced "I got it wrong on the first try." Introducing visibility for
   exactly one new kind of internal retry (a deterministic validator's repair loop) while
   every other retry stays silent would be an inconsistent, one-off exception to justify,
   not a natural extension of an existing pattern.
2. **The audience and framing argue against it.** Crystal's existing trust-building
   mechanism is retrospective and evidentiary — "every answer cites real responses,"
   "numbers come from analytics, not the LLM" (the panel's own empty-state copy,
   `CrystalPanel.tsx` line 896) — not procedural ("watch me iterate"). A visible
   self-correction UI is a good fit for coding tools where the user is debugging
   side-by-side with the assistant and wants to see iteration; it's a worse fit for a
   business/survey-analytics audience asking "why did NPS drop," where "I was wrong, then I
   fixed it" reads as noise or, worse, erodes confidence rather than building it — the
   opposite of the intended trust signal.

The one case I'd treat differently: if a skill exhausts its retry and validation **still**
fails, and the skill's existing baseline-gate/fallback logic decides to answer anyway rather
than error out — that residual uncertainty should reach the user, but through the *existing*
lower-trust vocabulary (a lower `confidence` value, and simply omitting the "Verified" badge)
rather than a new "I tried and failed to verify this" UI moment. That's consistent with how
`ConfidenceChip` already communicates "less sure than usual" today, so it composes with the
existing mental model instead of adding a new one.

### 2c. Does sandbox latency need a fourth streaming-phase state?

**No — map it onto the existing `observation` phase (or `thinking`, if framed as "let me
verify this"), don't add a fourth phase.** The current three-phase model
(`thinking`/`observation`/`synthesizing`) is already generic over "a named tool is running"
(`thinking`, with a `tool` + live `message`) and "a named tool finished, here's what it
found" (`observation`, with a `tool` + `summary`) — a sandboxed validator run is, from the
UI's point of view, just another tool call with a name and a result summary
(`{type: 'observation', tool: 'validate_survey_logic', summary: 'Checked ID assignment and
logic branches — all valid'}`), no different in kind from `get_driver_analysis` or any of
the other entries already in `TOOL_META` (`CrystalPanel.tsx` lines 1457-1471). Adding its
name to `TOOL_META` + the `crystal.tool.<name>` i18n key gets it a sensible icon and label
("Verifying calculations…") for free, inside the existing model — no new phase, no new
branch in `CrystalThinkingBubble`'s already-nontrivial `AccumulatedStep` state machine
(which I flagged in Round 1 §3 as intricate enough without adding a phase to it). A "few
hundred ms to a couple seconds" is squarely within the latency range the existing model
already absorbs for ordinary tool calls; there's no UX reason sandbox execution needs to
look categorically different in the trace.

**One sequencing caveat worth flagging to whoever wires the emission points**, tying back
to §2b: if the validate→repair loop runs *after* the LLM has produced a draft (i.e., between
what would otherwise be the final `synthesizing`→`answer` transition), make sure it resolves
— and, per §2b, stays silent or emits its `observation` — **before** `synthesizing` fires,
not overlapping it. `synthesizing` currently drives a specific, prominent UI state (the aurora
gradient header, "Crystal · Writing your answer," per `CrystalPanel.tsx` lines 1636-1664) that
visually promises "almost done." If a hidden repair cycle runs *during* that state, the panel
will appear to hang mid-"writing," which reads as a bug, not expected latency. Concretely:
validate-then-repair should either happen entirely before `synthesizing` is emitted, or be
folded into one more `observation` step emitted just before it — never silently overlap the
`synthesizing`→`answer` window.

### One cross-cutting implication, whichever shape Priya/Marcus choose

The brief notes the sandbox call likely lands either as a new `TOOL_REGISTRY` entry (a
structured JSON tool call like every other CrystalOS tool today) or as a new post-processing
stage inside `SkillRuntime.execute()`. From the frontend's side, **both are free** given
§2c's answer: a new `TOOL_REGISTRY` entry needs nothing beyond a new `tool` name flowing
through the existing `thinking`/`observation` events (already handled generically); a new
post-processing stage inside `SkillRuntime.execute()` that only affects the final answer's
`confidence`/`verification` field needs zero new streaming events at all, only the one new
`answer`-event field from §2a. I have no UI-driven preference between the two shapes —
that choice should be made entirely on Priya's/Marcus's implementation-feasibility and
architecture grounds.

## 3. What I'd revise from Round 1 given this new thinking

**Fold `applied_filters` (Round 1 §4a) and this round's `verification` signal (§2a) into one
small, extensible `provenance` object on `CrystalMessage`, rather than shipping two
independent one-off fields.** Both are the same underlying UI pattern — a disclosure that
surfaces normally-invisible pipeline machinery as a user-facing trust signal — and Round 2
just demonstrated that a second, independent need for exactly this pattern (validator
provenance) arrived within the same design cycle as the first (query-scope provenance). That's
a concrete instance of Reframing #1's "extensibility" question, applied to my own Round 1
recommendation: instead of `{ applied_filters?: {...} }` as a bespoke one-off field, I'd
now recommend a single `{ provenance?: { appliedFilters?: {...}, verification?: {...} } }`
shape from the start, rendered through one shared disclosure-toggle component (reusing
`SourcesFooter`'s existing expand/collapse affordance) that can grow a third fact type later
without a new component each time. This is a small change to how I'd scope the Round 1
recommendation, not a reversal of it.

Separately, Round 1's abstract plea ("keep the vocabulary verbatim") now has a concrete
mechanism behind it — the Pydantic-discriminated-union-plus-contract-test proposal in §1
above is the specific thing I was gesturing at without naming in Round 1 §4b/§5.1.
