# Wave 13 — Unified Builder + Conversational Crystal: UX Evaluation

**Author:** Rohan Desai (Principal Product Designer, Builder Experiences)
**Date:** 2026-07-02
**Scope:** Discovery/evaluation only — no code, no component specs at build fidelity.
This doc evaluates the user's raw proposal (unify the 3 builder pages behind a
canvas-mode toggle, with a persistent bottom-docked Crystal co-editor) against
this product's actual, tested architecture, and makes a decisive phased
recommendation. Maya (PM) is covering the IA/entry-point/sequencing half of
this same proposal in parallel — this doc is scoped strictly to interaction
design and the Crystal-architecture question.

**Method:** Read `docs/automation-hub/TRACKER.md`'s Wave 10/11/12 sections in
full (including my own `DEEP_AUDIT_UX_FINDINGS.md` L-1 finding and
`DEEP_AUDIT_FIX_SPECS.md`/`WAVE11_UX_SPECS.md`, which this doc explicitly
builds on rather than re-litigates); `app/src/pages/WorkflowNLBuilderPage.tsx`,
`WorkflowBuilderPage.tsx`, `WorkflowCanvasPage.tsx` directly; `app/CLAUDE.md`'s
Crystal AI Panel section and `app/src/contexts/crystalPanel.tsx`/
`app/src/components/CrystalPanel.tsx` directly (not from memory); the
`ActionProposal`/`ActionProposalType` union and the `create_workflow` proposal
handler in `CrystalPanel.tsx` (`executeAction`'s `case 'create_workflow'`).

---

## 0. Where I land, up front

1. **Do not build a second, bottom-docked "Crystal surface."** Scope the
   existing global `CrystalPanel` to the builder page instead. Building a
   parallel chat mechanism when a working, tested, product-wide one already
   exists is the exact architectural smell the brief asked me to flag — and it
   is what the literal proposal implies. Section 1 below is the decision, not
   a pros/cons list.
2. **Conversational, turn-by-turn node editing is a materially different,
   materially harder system than today's one-shot NL parser — not an
   incremental extension of it.** It requires an ongoing structured-edit-proposal
   loop that doesn't exist anywhere in this codebase today (confirmed: every
   existing Crystal action proposal, including `create_workflow`, is a
   full-replace write, never a diff/patch). Section 2 sizes this gap concretely.
3. **The user's actual stated pain — no clarifying questions on ambiguous/missing
   data — has a materially smaller fix that ships inside the existing
   confirm-card/low-confidence-state framework**, with zero new Crystal
   architecture. Section 3 specs it.
4. **Recommended sequencing:** ship the clarifying-question fix (3) first, ship
   CrystalPanel-scoped-to-builder with read-only awareness + "build the rest for
   me" whole-graph regeneration second, and treat true turn-by-turn conversational
   node editing as a distinct, later initiative that needs its own design and
   backend work — not a checkbox in this wave. Section 4 lays out the phasing
   and what I'd actively veto.

---

## 1. Placement: bottom-docked builder assistant vs. the existing right-docked `CrystalPanel`

### What already exists (confirmed by direct read, not assumed)

`CrystalPanel` is not a per-page component — it is mounted **exactly once**,
inside `AppShell`, and is available on every authenticated route via
`useCrystalPanel()` (`app/src/contexts/crystalPanel.tsx`). Its contract, as
documented in `app/CLAUDE.md` and verified in the actual provider/component
code:

- **State lives in one global context** (`CrystalPanelContext`): `isOpen`,
  `scope` (`SurveyScope`), `crystalCtx` (`{ window?, focused_topic? }`),
  `agenticInsights`/`topics` (page-injected data). A page calls `setScope(...)`
  on mount and resets it on unmount (`app/CLAUDE.md`'s documented pattern).
- **It renders on the right, is expandable, and is the single "ask Crystal
  anything" surface in the product** — SideNav's Crystal item, the ⌘K
  shortcut, and Insights hero ask bars all open the *same* panel instance,
  not page-local copies.
- **It already has a fully-built, tested action-proposal pipeline** —
  `action_proposals` → `ActionProposalCard` (title/description/rationale/
  confidence/Details toggle) → user clicks **Apply** → `executeAction`
  dispatches by `proposal.type`, mutates via the real API, then
  `invalidate(...)`s the DataBus → `api.recordProposalOutcome(...)` records
  the funnel. `create_workflow` is already one of the wired proposal types
  (`CrystalPanel.tsx`'s `executeAction`, `case 'create_workflow'`), and it
  already builds a *graph* workflow (`nodes`/`edges`) via
  `api.createGraphWorkflow(...)` — the same payload shape the sentence/canvas/
  NL builders all produce.

This is a real, live, cross-surface precedent for "Crystal, scoped to what
you're looking at, can propose a workflow" — it already exists, on a
different page, today.

### The proposal as literally stated would create a second Crystal surface

The user's proposal — "a persistent Crystal assistant docked at the bottom of
[the builder] page" — describes a **second, page-local chat mechanism**, sitting
alongside (not replacing) the right-docked global panel. Nothing in the
proposal says "and retire the right panel on this page." Taken literally, a
customer who opens the unified builder would see two different places Crystal
could appear: the existing right-side panel (still globally mounted by
`AppShell`, still reachable via ⌘K/SideNav on this route, since neither of
those triggers is builder-aware) and a new bottom-docked assistant. That is
the exact "two parallel systems fighting to be the Crystal surface" failure
mode the brief asked me to name if the literal proposal implies it. **It
does.** Concretely, this would produce:

- Two independent conversation histories for "the same AI" on the same page
  (global panel's `messages` state vs. a new bottom assistant's own state) —
  a customer who asks the right panel "why is this trigger unavailable" and
  then asks the bottom assistant to "add a Slack step" has just split one
  mental model of "Crystal" into two amnesiac halves.
- Two different mutation pipelines to keep in sync (the existing
  `action_proposals`/`executeAction`/`invalidate` loop vs. whatever new
  ad-hoc mechanism a bottom assistant would need to poke live sentence/canvas
  state) — meaning every future Crystal capability has to decide which of the
  two surfaces to ship in, forever.
- A layout fight: the sentence builder's step-panels already open as a
  `Sheet`/inline panel; the canvas already uses the full viewport width for
  ReactFlow. A bottom dock competes for vertical space with exactly the
  canvas surface that most needs it (branching graphs need height), while the
  right panel already reserves horizontal space the sentence builder's
  step-panels don't currently have to share.

### Decision: scope the existing `CrystalPanel` to builder context. Do not build a bottom dock.

Concretely, this is the same extension pattern this product has used every
other time a page needed Crystal to be "aware" of local state — `setScope`/
`setCrystalData` already exist for exactly this purpose (Insights pages call
them to inject `agenticInsights`/`topics`; nothing about the mechanism is
insights-specific, it's just that no builder page has called it yet):

1. **The unified builder page calls `setScope`/a new builder-aware
   equivalent on mount**, the same way `SurveyReportPage`/`InsightsDashboardPage`
   already do, and resets on unmount. This requires widening
   `CrystalCtx`/`scope`'s types (today `SurveyScope`-shaped) to also carry a
   `workflow_builder` context — an additive union member, not a breaking
   change to the survey-scoped callers.
2. **The builder injects its live draft state into context** via a
   builder-equivalent of `setCrystalData` (e.g. `setBuilderDraft({ triggerType,
   scopeSelection, conditionClauses, actions, mode: 'sentence' | 'canvas' })`) —
   every keystroke/pill-edit updates this, so Crystal's system prompt on this
   page always has the current partial graph, not just the initial state at
   panel-open time. This is the mechanism that answers the user's "know what's
   already in the sentence/canvas" requirement, without inventing a new
   panel.
3. **The panel opens automatically-suggested but not auto-opened** on
   builder pages via the exact same `openCrystal()` call sites the rest of the
   product uses (e.g. a "Ask Crystal" affordance inside the empty-condition
   pill's context, or a persistent small "Ask Crystal to help" chip near the
   sentence — NOT a second chat surface, just a trigger for the *existing* one)
   — consistent with how every other page invites Crystal in without forcing
   it open.
4. **The right-docked panel is unambiguously "the Crystal surface" everywhere,
   including here.** No competing chrome, no second conversation history, no
   second outcome-telemetry path. The builder becomes one more scope Crystal
   can operate in, exactly like a survey or the org-wide Insights view is
   today.

### Why this isn't just "avoid building two things" — it's actually the better UX

The user's own proposal already half-endorses this: "know the currently
selected scope" and "know what's already in the sentence/canvas" are
literally what `setScope`/`setCrystalData` were built to do. Reusing the
panel means:

- A customer building a workflow can ask Crystal a *portfolio* question
  ("what other workflows already notify #cx-escalations?") from the same
  panel, in the same conversation, without switching mental context to a
  second assistant that only knows about the current page — the global panel
  already has this reach; a bottom dock would not, unless it re-implemented
  the whole panel's data access, which is exactly the duplication to avoid.
- Outcome telemetry (`recordProposalOutcome`) stays unified — product
  analytics on "how often does Crystal-proposed vs. manually-built end up
  active" doesn't fork into two measurement paths depending on which surface
  built it.
- Zero new global chrome/state-management surface for engineering to
  maintain long-term (a second persistent panel is not a small addition — it
  needs its own streaming, its own message history, its own mobile/collapse
  behavior, per `app/CLAUDE.md`'s existing responsive rules for the panel).

**One legitimate concern worth naming, not dismissing:** the right panel's
current default width (55%, expandable to 100%) was designed for
insight-reading (prose + citations), not for a customer who wants to glance at
both "my sentence so far" and "Crystal's answer" simultaneously without one
covering the other. That's a real layout question — but it's a **sizing/
responsive-behavior tweak to the existing panel** (e.g. a narrower default
width when `scope` is `workflow_builder`, or a "compact mode" that trades the
citation-rich Insights layout for a leaner conversational strip), not a
justification for a structurally separate second surface. I'd spec that
narrower "builder mode" panel treatment as part of Phase 2 below, not invent
new chrome to solve it.

---

## 2. Conversational node-editing vs. one-shot generation — sizing the real gap

### What exists today, confirmed by direct read

Every AI-authored workflow path in this codebase today is **one-shot,
full-replace**:

- `WorkflowNLBuilderPage.tsx`: `description` string in → `parse_workflow_nl` →
  a complete `{ nodes, edges, triggerType, scopeType, confidence, warnings }`
  result out → user clicks **Create Workflow** → `api.createGraphWorkflow(...)`
  with the *entire* graph. There is no concept of "the workflow that already
  existed before this call" anywhere in this flow — `ParseWorkflowNLResult` is
  not a diff against prior state, it's the whole thing.
- `CrystalPanel.tsx`'s `create_workflow` action proposal: identical shape —
  `proposal.params.nodes`/`edges`/`trigger_type` is a complete graph, applied
  via the same `api.createGraphWorkflow(...)` call. Confirmed by direct read
  of `executeAction`'s `case 'create_workflow'` — there is no
  "edit_workflow_node" or "patch_workflow" proposal type in the
  `ActionProposalType` union at all.
- The sentence builder's own local edit model (`WorkflowBuilderPage.tsx`) is
  the only place "targeted edits" exist today, and it's **entirely
  human-driven, form-based, and local-only** — `hydrateFromNodes()` /
  `serialize()` round-trip the whole local state to/from the engine's
  `nodes`/`edges` shape on load/save, but nothing calls an LLM mid-edit to
  decide what changes. A user clicking the action pill and picking "Jira" is
  not the same operation as an assistant inferring "add a Jira step" from a
  sentence and knowing *where* in the existing pill sequence to insert it,
  *without* clobbering the trigger/scope/other actions already configured.

### What "now add a Jira ticket step" actually requires that doesn't exist yet

The proposal's example turns are deceptively simple-sounding but each implies
a capability this system does not have:

| User turn | What has to happen, mechanically | Exists today? |
|---|---|---|
| "Now add a Jira ticket step" | LLM must read the *current* partial graph (not just a fresh description), decide this is an **insert**, not a replace, choose a position (end of the action chain? before a Flow pause?), and emit *only* the new node + its edge insertion | No — `parse_workflow_nl` has no concept of "existing nodes," it drafts an entire graph from a text description every time |
| "Change the Slack channel to #cx" | LLM must identify *which existing node* is the target (if there are 2 Slack actions, which one?), and emit a **field-level patch** to that node's `config`, leaving every other node byte-identical | No — nothing in the schema represents "modify node N's config.channel field"; the nearest analog (`_draft_to_engine_graph`) always constructs a fresh node set from scratch |
| "Build the rest for me" (full delegation) | This one — generating a complete graph from a description — **is** what exists today. The gap is specifically the *partial, targeted, turn-by-turn* mode, not full generation. | Yes, this part already works |

The size of this gap is not "extend the prompt to also mention existing
nodes." It requires:

1. **A new request shape**: instead of `{ description }` → `{ full graph }`,
   the backend needs `{ description (this turn), current_graph, conversation_history
   }` → `{ edit_operations: [...] }`, where an edit operation is something
   like `{ op: 'insert_action', after_node_id, action, config }` or
   `{ op: 'patch_node', node_id, config_patch }` or `{ op: 'replace_all', nodes,
   edges }` (for the "build the whole thing" case, which degrades gracefully
   to today's behavior).
2. **A new confirm-card shape**: today's confirm-card renders "here is the
   whole workflow, confirm or discard." A turn-by-turn editor needs to render
   "here is what changes" — a diff view (this node added, this field changed
   on that node) — which is a materially different UI component, not a
   relabeled `ConfirmCard`. None of `TriggerSummaryRow`/`ScopeSummaryRow`/
   `ActionSummaryRow` (the existing summary-row components) were built to show
   a *delta*; they render an absolute state.
3. **Ambiguity resolution against a graph that's mid-edit**, which is a
   strictly harder version of the scope-hint matching Wave 12 already built
   (matching a free-text mention against a *catalog* of real surveys/tags) —
   here the model has to match a free-text mention ("the Slack channel")
   against the *current draft's own nodes*, which is a moving target that
   changes every turn, and doesn't have Wave 12's safety net of "if ambiguous,
   fall back to a fixed safe default" (there's no safe default for "which
   node did you mean," it has to ask — which is section 3's problem, now
   compounded by needing per-node context, not just per-workflow context).
4. **Conversation memory that's structurally different from chat history.**
   "Remember conversation history across turns" for a Q&A assistant (what
   `CrystalPanel` already does — `messages: Message[]`) is a solved problem
   here. Remembering *edit* history — so "undo that" or "actually make it
   #cx-escalations not #cx" resolves correctly — needs the state machine to
   track *graph versions*, not just message turns. This is closer to
   `WorkflowBuilderPage.tsx`'s own local undo-less edit model than to
   `CrystalPanel`'s chat transcript.

### Verdict: this is not an incremental evolution of `parse_workflow_nl`. It's a new backend shape.

`parse_workflow_nl`'s job — description text in, complete inferred graph out
— is a good, narrow, testable one-shot function, and Wave 12's fix (giving it
the real registry catalog) made it meaningfully more reliable at that job.
Turning it into an ongoing structured-edit-proposal loop is not "add a
parameter" — it changes the fundamental contract from *generation* to
*editing*, which needs:
- a different request/response schema (delta-shaped, not graph-shaped),
- a different confirm-card UI (diff-shaped, not summary-shaped),
- a different backend validation story (validating a *patch* against an
  existing graph is a different problem than validating a freshly generated
  graph against the registry — Wave 12's drop-and-warn safety pattern doesn't
  translate directly to "drop this one field of this one patch and warn," it
  needs to be rethought per-operation),
- and genuinely new engineering surface area comparable in size to Wave 12
  itself (which took 3 phases, 3 engineers, and 2 full regression passes for
  "add scope, one optional field" — turning generation into editing is a
  bigger lift than that, not a smaller one).

This is worth being blunt about because the user's proposal describes it in
one sentence ("be able to add/edit specific nodes on the user's behalf via
conversation") as if it's a small ask alongside "remember conversation
history" — it is not the same size of problem, and packaging it into the same
wave as a UI reorganization would badly under-scope the backend work.

---

## 3. The clarifying-question gap — a smaller, faster win inside the existing framework

### The user's actual complaint, restated precisely

Today, when `parse_workflow_nl` can't confidently resolve something (most
concretely: scope — "which survey does this apply to"), the system has
exactly two behaviors, both terminal:
- **Silently default** (no scope mention → `org`, always, per Wave 12's
  backward-compat contract) — correct when the customer genuinely meant
  org-wide, silently wrong when they just didn't think to name the survey.
- **Warn, in the `low-confidence` state** (`LowConfidenceState` renders
  `warnings[]` as a static bulleted list, with only "Edit in canvas" or "Try
  rewording" as next actions) — the customer sees *that* something was
  ambiguous but the system never asks *which* of the plausible resolutions
  they meant. They either accept the guess (if the confidence bar was cleared)
  or go start over.

There is no third path — "Crystal asks, the customer answers, we resume" —
anywhere in this pipeline. That's the real, precise gap, and it's narrower
than "give Crystal a persistent bottom-docked chat."

### Minimal spec: a clarifying-question state, inside the existing state machine

`WorkflowNLBuilderPage.tsx`'s `ViewState` union today is:

```ts
type ViewState =
  | { kind: 'input' }
  | { kind: 'thinking' }
  | { kind: 'confirm'; result: ParseWorkflowNLResult; warnings: string[] }
  | { kind: 'low-confidence'; result: ParseWorkflowNLResult; warnings: string[] }
  | { kind: 'unparseable'; message: string; suggestions: string[] }
  | { kind: 'timeout' };
```

This is a good, closed, well-tested state machine (Wave 10 called it
"genuinely good UX" for a one-shot generator, correctly). The minimal fix is
**one additive member**, not a rearchitecture:

```ts
| { kind: 'clarifying'; result: ParseWorkflowNLResult; question: ClarifyingQuestion }
```

```ts
interface ClarifyingQuestion {
  field: 'scopeSurveyId' | 'scopeTagId';        // start with exactly one field — scope, the user's own named example
  prompt: string;                                // "Which survey should this apply to?"
  options: { id: string; name: string }[];       // real surveys/tags from the SAME registry catalog Wave 12 already forwards — never invented
}
```

**Backend shape change is additive and small, not a rearchitecture of
`parse_workflow_nl`:** today, an unmatched scope hint falls back to `org` +
warning + confidence penalty (Wave 12's `_resolve_scope_hint`). The minimal
extension is: when the hint is present but **ambiguous** (matches multiple
candidates, or matches in both surveys and tags — the exact case Wave 12's
`_scope_catalog_lookup` already detects and currently treats as "no match,
fall back to org") — instead of silently falling back, return a
`needsClarification: { field: 'scopeSurveyId', prompt, options }` block
alongside the rest of the (otherwise complete) draft result. This is
reusing Wave 12's own ambiguity detection, which already exists and already
distinguishes "no hint" from "hint with no match" from "hint with multiple
matches" — it just currently collapses the last two cases into the same
silent-fallback behavior. Splitting "ambiguous, multiple real candidates" out
into a clarifying question is a **narrower, more precise use of information
the system already computes**, not new inference.

**Frontend rendering** — a new small component, `ClarifyingQuestionCard`,
visually a sibling of `LowConfidenceState` (same "here's the draft so far,
dimmed" treatment already established) with the question + option chips
instead of a static warning list:

```tsx
<div className="mt-6" data-testid="nl-clarifying-state">
  <p className="text-sm font-semibold text-on-surface mb-1 flex items-center gap-1.5">
    <Icon name="help" size={16} className="text-primary" />{question.prompt}
  </p>
  {/* dimmed draft-so-far, same treatment as LowConfidenceState's opacity-0.7 block */}
  <div className="p-3 rounded-xl border border-dashed border-border" style={{ opacity: 0.7 }}>
    <TriggerSummaryRow ... /><ActionSummaryRow ... />
    {/* scope row deliberately omitted/replaced by the question below — it's the thing being resolved */}
  </div>
  <div className="flex flex-wrap gap-2 mt-3">
    {question.options.map((opt) => (
      <button key={opt.id} onClick={() => resolveAndReparse(opt.id)}
        className="rounded-full border border-border px-3 py-1.5 text-sm hover:border-primary hover:text-primary">
        {opt.name}
      </button>
    ))}
    <button onClick={() => resolveAndReparse('org')}
      className="rounded-full border border-border px-3 py-1.5 text-sm text-on-surface-variant">
      {t('workflows.nlBuilder.clarifyOrgWideInstead')}
    </button>
  </div>
</div>
```

`resolveAndReparse(id)` does **not** need a new endpoint or a conversational
backend — it can literally re-call the *same* `parse_workflow_nl` with the
original description plus the resolved field pre-filled (e.g.
`scope_override: id`), landing back in `confirm`/`low-confidence` exactly as
today. This is one clarifying round-trip, not an open-ended conversation —
the state machine gains exactly one new terminal-ish state that resolves back
into the existing ones, matching the existing "closed, small state machine"
quality bar instead of opening it into free-form chat.

**Explicitly scoped small for v1:** start with scope only (the user's own
example, and the one field Wave 12 already has full ambiguity-detection
plumbing for). Trigger/action ambiguity clarification is a plausible future
extension of the exact same pattern but is not needed to ship this — Wave
12's catalog-matching work for triggers/actions is drop-and-warn only today
(no "multiple candidates" case currently exists for them the way it does for
scope, since trigger/action come from a fixed enum, not an open org-specific
catalog), so there's nothing to clarify yet on that axis.

### This is the actual fast win

Compared to Section 2's gap, this is: one new `ViewState` member, one new
small presentational component reusing existing summary-row pieces, one
additive backend field on an already-additive-friendly result shape, and a
re-call of an endpoint that already exists. It requires **zero** new Crystal
architecture, **zero** conversational memory, and **zero** diff/patch
confirm-card work — and it directly answers the literal complaint ("no
ability to ask clarifying questions when data is missing or ambiguous, e.g.
which survey a workflow should apply to").

---

## 4. Phased recommendation

### Phase 1 (ship first — low-risk, high-value, ready now)
**The clarifying-question state (Section 3), scope field only.** Additive to
`WorkflowNLBuilderPage.tsx`'s existing state machine and Wave 12's existing
ambiguity detection. No new Crystal surface, no new backend architecture. This
is the smallest change that most directly answers the user's stated
complaint. Ship this regardless of what happens with the rest of the
proposal — it stands alone.

### Phase 2 (next — moderate effort, real value, no new architecture)
**Scope the existing `CrystalPanel` to the unified builder** (Section 1):
widen `CrystalCtx`/`scope` to a builder context, wire `setBuilderDraft(...)`
so Crystal's context always reflects the live partial graph, add a
builder-mode narrower/compact panel width. Ship this **alongside whatever
entry-point/canvas-toggle unification Maya's IA track recommends** — this
doc doesn't re-litigate that half, but notes the dependency: scoping the
panel to "the builder" is far more valuable if "the builder" is genuinely one
page (per the user's canvas-toggle idea) than if Crystal has to guess which
of 3 separate pages it's scoped to.

**Within Phase 2, ship "build the rest for me" (whole-graph regeneration) as
an action proposal, not a new mechanism.** This is the one piece of the
user's ask that's *already mostly built*: `create_workflow`'s existing
full-replace proposal type, surfaced from the builder-scoped panel instead of
only from Insights pages, with the confirm/apply pipeline unchanged. A
customer who says "just build the whole thing for me: when NPS drops below
30, notify #cx and create a Jira ticket" gets exactly today's one-shot
generation, rendered through the existing `ActionProposalCard`, applied via
the existing `executeAction`. No diff UI needed for this path, because it's a
full replace, same as today's NL builder — the only thing that's new is
*which page* it's reachable from.

### Phase 3 (separate, later initiative — do not fold into this wave)
**True turn-by-turn conversational node editing** (Section 2's "add a Jira
step," "change the Slack channel"). This needs its own design pass (a
diff-shaped confirm-card is a new component family, not a variant of the
existing summary rows) and its own backend initiative (edit-operation schema,
per-operation validation, draft-graph-aware ambiguity resolution) comparable
in scope to Wave 12. Recommend treating it as a distinct future wave with its
own TEAM.md dispatch, not a line item inside the unified-builder UI work.

### What I'd actively recommend AGAINST, as literally described

**A bottom-docked, page-local, persistent Crystal assistant, built as a new
component alongside the existing right-docked global panel.** Not "risky" or
"needs more thought" — actively wrong, for the reasons in Section 1: it
duplicates a working, tested, product-wide mechanism; it splits one AI
identity into two amnesiac surfaces on the same page; and it creates a
permanent fork in where every future Crystal capability has to be built. If,
after reading this, there's still a strong product reason to want a
*docked-in-the-builder-flow* feel rather than a right-side panel, the correct
version of that idea is "make the existing panel dock differently (or default
to a different width/position) when its scope is the builder" — a
configuration of the one existing surface, not a second surface. I'd want an
explicit product conversation before anyone builds a second chat mechanism
here.

**Bundling Phase 3-sized backend work into the same wave as the UI
unification.** The proposal reads as one ask; it's actually two asks of very
different sizes (a page/IA reorganization + a new AI editing paradigm). Wave
12's own history is the cautionary example already in this tracker: "add one
optional scope field" took 3 phases and surfaced a pre-existing, unrelated,
production-affecting bug along the way. Turning generation into editing is a
strictly bigger change than that — it should get its own dedicated wave,
scoped and staffed like one, not be assumed as a subtask of a UI redesign.

---

## Summary table

| Question | Answer |
|---|---|
| Bottom-docked assistant vs. existing right panel? | Scope the existing `CrystalPanel` to the builder. Do not build a second surface. |
| Is conversational node-editing an incremental extension of `parse_workflow_nl`? | No — it requires a new delta-shaped request/response contract, a new diff-shaped confirm-card, and per-operation validation. Comparable in size to a full new wave, not a parameter add. |
| Is there a smaller win for the clarifying-question complaint? | Yes — one additive `ViewState` member (`'clarifying'`), reusing Wave 12's existing ambiguity detection and the existing summary-row components. Ships independently, first. |
| What ships first? | The clarifying-question state (scope field only). |
| What ships next? | `CrystalPanel` scoped to the (ideally now-unified) builder page, plus surfacing the already-built `create_workflow` full-replace proposal from it. |
| What's a separate later initiative? | True turn-by-turn conversational node editing (add/edit specific nodes by conversation). |
| What should NOT be built as described? | A new bottom-docked, page-local, persistent Crystal chat mechanism running alongside the existing global panel. |
