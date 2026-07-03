# Wave 13 — Unified Builder Proposal: PM Evaluation (Maya)

**Status:** Discovery/evaluation only. No code changes. Companion doc: Rohan's
interaction-design evaluation (assistant placement/behavior, canvas-sentence
unification mechanics) — this doc does not re-litigate those questions.

**Trigger:** After Wave 12 fixed "Build with Crystal is missing scope entirely,"
the user proposed a structural rethink: collapse the list page's 3 entry
points, move scope selection before any builder, unify the sentence/canvas
builders into one surface with a view-mode switch, and add a persistent,
conversational Crystal assistant docked at the bottom of that surface.

**Bottom line up front:** Adopt the direction, but not as one wave. Scope-first
is the correct fix for a real, audited defect (Wave 10 L-1) and should ship
first, standalone. Collapsing 3 buttons into 1 is a natural consequence of
scope-first, not a separate risk. The persistent conversational assistant is
the highest-value, highest-risk piece and is a genuine build, not a UI
rearrangement — it should be v2/v3, sequenced behind scope-first, and scoped
down from "replaces the NL builder" to "augments the sentence builder." See
§4 for the phased plan.

---

## 1. Does collapsing 3 entry points + scope-first genuinely simplify things, or move complexity around?

**Verdict: net simplification, with one real regression to design around
(the 10-second path), which is fixable without abandoning scope-first.**

### The current state, precisely

`app/src/pages/WorkflowsPage.tsx`'s `PageHeader` `actions` slot renders 4
buttons today: an Integrations shortcut, "Build with Crystal" (→
`WorkflowNLBuilderPage`, `ROUTES.WORKFLOW_NL_BUILD`), "Build Visually" (→
`WorkflowBuilderPage`, `ROUTES.WORKFLOW_BUILD`, the sentence builder — despite
the confusingly generic name), and "Build on Canvas" (→ `WorkflowCanvasPage`,
`ROUTES.WORKFLOW_CANVAS`). Wave 10's UX audit (Rohan, finding L-1, corroborated
by Maya's own 3a) already flagged this as the single highest-confidence
usability defect in the whole surface: three destinations with overlapping
purpose and no way to tell which is right without a click into each one. The
Wave 10 fix (`DEEP_AUDIT_FIX_SPECS.md` Issue 2) only got as far as deleting a
redundant 4th button and adding subtext/tooltips — it explicitly did not
touch the deeper "3 destinations for what is conceptually 1 job" problem.
**The user's Wave 13 proposal is the fix Wave 10 deferred, not a new idea.**

Scope today is buried differently depending on entry point:
- **NL builder** (`WorkflowNLBuilderPage.tsx`): scope isn't chosen by the user
  at all — it's *inferred* from free text by Wave 12's `_resolve_scope_hint`,
  surfaced only after the fact in `ScopeSummaryRow` on the confirm card. There
  is no way to declare scope up front; you say "for the Onboarding Survey" and
  hope Crystal catches it.
- **Sentence builder** (`WorkflowBuilderPage.tsx`): scope is `StepId`'s second
  pill (`'trigger' | 'scope' | 'condition' | 'action'`), sitting mid-sentence,
  equal-weight with trigger/condition/action. It's discoverable but not
  privileged — a user has to know to click that specific pill.
- **Canvas** (`WorkflowCanvasPage.tsx`): scope doesn't exist at all. Confirmed
  directly in code — `CanvasSeed` has no scope fields, `save()`'s payload
  never includes `scopeType`/`scopeSurveyId`/`scopeTagId` under any
  circumstance (Wave 12 Kenji's Phase 3 finding, still open). Every
  canvas-built workflow is silently org-wide today, full stop.

So "scope is invisible/an afterthought" isn't a mild UX nit — it's structurally
three different (non-)treatments across three surfaces, one of which (canvas)
doesn't have the concept at all. Scope-first as a single, common, unavoidable
step *fixes the canvas gap for free* — instead of Elias's still-open follow-up
item ("`WorkflowCanvasPage.tsx` needs its own scope state + seed consumption +
save-payload wiring") being bolted onto the canvas as a fourth bespoke
implementation, canvas mode inherits scope from the shared pre-step along with
the sentence editor. That is a real complexity *reduction*, not a relocation —
today's plan was heading toward 3 independent scope UIs; scope-first collapses
that to 1.

### Where the proposal creates a real cost: the 10-second path

Today: a user with a clear, simple idea clicks "Build with Crystal," types
"Every Monday at 9am, email the team a summary of last week's responses,"
clicks Generate, reviews the confirm card, clicks Create. Scope is inferred
silently (defaults to org-wide when nothing is named) — genuinely near-zero
added friction for the common case where scope doesn't matter or is
implied by not being mentioned.

A literal reading of the proposal — a hard, blocking "pick org/survey/tag"
screen *before* any text can be typed — adds a mandatory click-through the
current NL flow doesn't have. For a large fraction of real usage (Wave 6's
own scope design assumes org-wide is the common/default case, not the
exception), that's a pure regression: one extra screen for a decision most
users would happily leave as "org-wide, obviously" if you just let them get
to the sentence.

The user's own proposal anticipates this tension in the discovery prompt:
*"build me something for the Onboarding Survey" already implies scope — does
forcing a pre-step conflict with that?* Yes, if the pre-step is a hard gate
with no way past it except an explicit click. The fix is not to abandon
scope-first, it's to make the pre-step **resolve, not just prompt**:

- Default selection is always **pre-highlighted to "Org-wide"** (matching
  today's silent default) with a single affordance to proceed immediately —
  the pre-step should cost one glance + one click (confirm the default) for
  the common case, not a mandatory decision tree.
- If the user's very first sentence in the subsequent editor names a
  survey/tag Crystal can confidently resolve (the exact `_resolve_scope_hint`
  logic Amara already built in Wave 12), the scope pill updates in place and
  the pre-selected org-wide choice is silently corrected — the pre-step
  is a *starting point*, not a lock. This is the one place scope-first and
  "scope decided mid-conversation" genuinely coexist: pre-step sets the
  default, conversation can override it, exactly the same drop-and-warn /
  confident-match asymmetry Wave 12 already established for safety
  (unmatched mentions never guess; confident matches always win).
- This means scope-first is **not** "always ask, always block" — it's
  "always show, default to safe, let the very next signal (a typed sentence)
  override it." That is genuinely less friction than today for the
  scope-matters case (scope is visible and correct from the first keystroke,
  not discovered after the fact on a confirm card) and roughly equal friction
  for the 10-second case (one glance at a pre-selected default vs. zero
  glances today) — an acceptable, deliberate trade for closing a Wave-10/12
  audited gap, not a free win either way.

### Does every workflow need scope decided up front?

No — and the proposal doesn't actually require that in spirit, even though
the literal wording ("scope selection happens FIRST... as an initial step")
reads that way. The honest answer: **scope needs to be *visible and
correct-by-default* before the user can lose track of it, not necessarily
*decided* before they can type anything.** Given the safe-default behavior
above, "shown first, overridable by the conversation" satisfies both the
proposal's intent (scope stops being an afterthought/pill-among-pills) and
the discovery prompt's concern (a first sentence that already implies scope
isn't fighting an earlier, contradicting decision — it's just confirming or
correcting a pre-set default).

**Recommendation: adopt scope-first, implemented as a pre-selected default
step (not a blocking modal), with confirmed NL scope-hints in the editor
able to override the pre-step's default in place.** This is a small but
load-bearing change from the literal proposal wording — call it out
explicitly to the user as the one place this evaluation refines rather than
accepts their proposal verbatim.

---

## 2. What should "surface history / already-configured workflows" actually mean?

**The literal phrase is ambiguous by the user's own framing. Recommendation:
this is a list-page enhancement, not a new page — specifically, promote a
condensed run-health + last-activity signal onto each card's always-visible
face, not just behind two clicks.**

### What already exists (don't rebuild it)

`WorkflowsPage.tsx` already has two separate history concepts, both
click-to-reveal, both dialogs:
1. **Run history** (`historyWorkflow` state, `RunHistory` component) —
   `GET /api/workflows/:id/executions`, shows individual execution
   timestamps/status/steps/retry, opened via a `history` icon button.
2. **Audit/change-log** (`auditLogWorkflow` state, `AuditLogHistory`
   component, Wave 11/Nina) — `GET /api/workflows/:id/audit-log`, shows
   who-changed-what-when, opened via a separate `manage_history` icon button.

Both are real, tested, and complete (Wave 11 Phase 3 closed this out). The
card face itself already surfaces *some* activity signal inline, without a
click: `formatLastRun()` ("Last run: ..."), `successRate()` (a %, only when
`run_count` is truthy), `wf.trigger_count` ("N triggers"), and the ephemeral
`lastResult` line right after a manual test. So "history is invisible" isn't
quite accurate today — it's **fragmented and inconsistently prioritized**:
last-run/success-rate/trigger-count are small, low-contrast, bottom-of-card
text (`text-xs text-on-surface-variant`, see lines 368–373), while the two
richer history views (run detail, audit trail) require a hover + a click
each, and there's no single glance that answers "is this workflow healthy
right now" without doing that math yourself from 3 separate numbers.

### What would actually be valuable — concrete recommendation

Do NOT build a third history surface. Instead:

1. **Promote a single computed health signal per card**, visible without
   hover or click, sitting where the status `Badge` already is (same visual
   weight, not buried in the small-text row below). Something like a
   traffic-light chip derived from data the list response *already returns*
   (`run_count`, `success_count`, `last_run_at` — all present in the
   `Workflow` type per `successRate()`/`formatLastRun()`'s existing usage):
   - **Healthy** — recent successful runs, no errors.
   - **Needs attention** — a run failed recently, or `dead_letter` executions
     exist (data Nina's Wave 10 work already added to the executions
     endpoint — `attempt_count`/`dead_letter` — but never surfaced on the
     list card, only inside the Run History dialog).
   - **Never run** / **Draft** — matches `formatLastRun`'s existing
     `neverRun` copy, just promoted to the same visual tier as the status
     badge instead of small print.
   This is the single highest-leverage move: it turns "click into 2 dialogs
   per workflow to know if something's broken" into "scan the list, the
   broken ones are visually obvious." It directly serves the audited gap
   Kenji verified in Wave 10 (`#37` finding 3: toggle/delete/test-run give
   generic or silent feedback) by giving ambient, always-on visibility
   instead of relying on the user to go looking after something already went
   wrong.
2. **Keep Run History and Audit Log as separate dialogs, unchanged** — Wave
   11 deliberately kept them distinct ("WHEN did this fire vs. WHO changed
   this") and that distinction is correct and should not be collapsed into
   one mega-panel. The card-level health chip is a *summary/teaser* for "go
   check Run History," not a replacement for it.
3. **Do not build this as a new page.** A dedicated "workflow health
   dashboard" page is a bigger, separable idea (cross-workflow aggregate
   view, e.g. "3 workflows have failing runs this week") that could be a
   genuinely good future feature, but it is not what the discovery prompt is
   asking about, and building it would be scope creep relative to the user's
   actual proposal (which frames this as something to see "more
   prominently... on the list view itself").
4. **Ordering/sorting is the other half of "surface history."** Right now
   `WorkflowsPage.tsx` renders `scopeFilteredWorkflows` in whatever order the
   API returns them (implicitly creation order, unverified but consistent
   with no explicit `ORDER BY` override visible in the list hook). A org with
   30 workflows has no way to see "which ones are broken" without scanning
   all 30 cards top to bottom. Pairing the health chip (item 1) with an
   optional "Needs attention first" sort — reusing the exact filter-bar
   pattern `ScopeFilterBar` already established — would make the
   "surface already-configured/problem workflows" goal work at scale, not
   just at a glance for a short list. This is a natural, low-risk extension
   of an existing, tested component (`ScopeFilterBar`), not a new
   subsystem.

**This interpretation is deliberately narrower than "redesign the list page"**
— it reuses the existing card structure, existing data already being
fetched, and existing dialogs, adding one derived visual signal and one
sort option. That is proportionate to what the discovery prompt is actually
asking for, and avoids inventing a scope the user didn't ask for.

---

## 3. Migration/rollout risk — does Wave 12's investment carry forward?

**Verdict: the core scope-resolution logic survives untouched. Only the
frontend call sites and their UI containers need rework. This is a
low-regression-risk migration if sequenced correctly.**

### What survives completely unchanged

- **`crystalos/crystal/workflow_nl.py`** — `_scope_catalog_lookup`,
  `_resolve_scope_hint`, `_format_catalog`, the entire `WorkflowNLDraft`/
  `WorkflowNLResult` schema, the drop-and-warn safety pattern. This module has
  zero knowledge of which page or button called it — it takes a description
  string + a registry object and returns a structured result. Nothing about
  "which page is calling this" is encoded anywhere in this layer.
- **`POST /api/workflows/parse-nl`** (`backend/src/routes/workflows.ts`
  lines 196–240+) — the extended-registry construction (parallel
  survey/tag queries), the `agentsClient.parseWorkflowNL` call, and the
  pass-through response mapping are all page-agnostic. This endpoint doesn't
  care whether the caller is a standalone NL page, a unified builder's
  sentence-editor, or a future assistant panel — it's a stateless
  description-in, structured-draft-out endpoint. **Zero backend work
  required by the unification itself.**
- **`ParseWorkflowNLResult`/`ParseWorkflowNLSuccess` contract** (frontend
  `lib/api.ts` / backend types) — the `scopeType`/`scopeSurveyId`/
  `scopeTagId` optional fields, and the whole backward-compatibility
  invariant Wave 12 proved end-to-end (Kenji's Phase 3 wire-boundary tests),
  are unaffected by which component renders the result.
- **The safety invariant itself** ("no scope hint → org, byte-identical to
  pre-Wave-12 behavior") is a property of the endpoint/CrystalOS pair, not of
  any page — it holds regardless of how many builder pages exist.

### What needs real rework

- **`WorkflowNLBuilderPage.tsx`'s `ConfirmCard`/`LowConfidenceState` UI**
  (the `TriggerSummaryRow`/`ScopeSummaryRow`/`ConditionSummaryRow`/
  `ActionSummaryRow` stack, `ThinkingState`, `UnparseableState`,
  `TimeoutState`) is currently a **self-contained one-shot page**: type text
  → thinking → terminal confirm/low-confidence/unparseable/timeout state. A
  unified builder with a persistent, multi-turn assistant is a different
  interaction shape — turn-by-turn, not one blocking request/response. This
  page's *view-state machine* (`ViewState` union) does not port over as-is;
  the assistant needs an incremental "propose a diff to the current
  sentence/canvas state" loop instead of "replace the whole draft." This is
  the single biggest structural rewrite implied by the proposal — not a
  relocation, a new interaction model (Rohan's remit, flagged here only
  because of its size/risk).
- **`editInCanvas()`/`createWorkflow()`'s conditional-scope-spread
  functions** (`WorkflowNLBuilderPage.tsx` lines 156–187) — these become
  redundant in their current form once scope is a pre-step property shared
  by the whole unified surface rather than something arriving *from* a parse
  result that then has to be conditionally spread onto a payload. The
  spreading logic itself (never send `scopeType: 'org'`/undefined explicitly)
  is sound and should be preserved as a pattern, just relocated to wherever
  the unified builder's single save function lives.
- **`WorkflowCanvasPage.tsx`'s missing scope state** — this was already a
  known, explicitly-logged gap (Elias's Wave 12 Phase 2 note, confirmed safe
  but unfixed by Kenji's Phase 3). Unifying the builders is actually the
  natural place to finally close this gap, since canvas-mode would consume
  the same pre-step scope state the sentence editor does, rather than
  needing its own bespoke `ScopeSelection` UI as previously planned. **This
  turns a standing to-do into a byproduct of the unification instead of a
  separate future task** — a genuine argument in favor of doing the
  unification, not just a neutral side effect.
- **Three routes collapse to one** (`ROUTES.WORKFLOW_BUILD`,
  `ROUTES.WORKFLOW_CANVAS`, `ROUTES.WORKFLOW_NL_BUILD` →
  effectively one route with a view-mode param/state). Every existing
  `navigate(ROUTES.WORKFLOW_CANVAS, { state: { seed } })` call site needs
  updating — confirmed call sites: `WorkflowsPage.tsx`'s `WorkflowTemplates`
  (template seeding), `WorkflowsPage.tsx`'s edit button
  (`resolveEditRoute`), `WorkflowNLBuilderPage.tsx`'s `editInCanvas`/
  `buildManually`. `resolveEditRoute` (`lib/workflowEditRoute.ts`) — which
  decides sentence vs. canvas based on node shape — becomes the "which
  view-mode does this unified page open in" decision instead of "which page
  do I navigate to," which is a small, mechanical change, not a redesign.

### Net verdict

Wave 12 was money well spent regardless of which way Wave 13 goes: the
scope-resolution *engine* (CrystalOS + the parse-nl endpoint + the
type contract) is entry-point-agnostic by construction and needs no rework.
The cost of unification lands entirely on the frontend page/component layer,
concentrated in exactly the two places already flagged as incomplete before
this proposal existed (canvas's missing scope UI, the NL builder's one-shot
interaction shape) — meaning the "cost" of adopting this direction is mostly
work that was already owed, not new risk introduced by the unification
itself.

---

## 4. Phased recommendation

**Adopt the direction. Sequence it in 3 waves so each ships independent,
provable value and de-risks the next.** Do not attempt all 5 elements of the
proposal in one wave — Wave 11/12's own history shows this team's safest
pattern is disjoint, independently-verified phases, and this proposal has a
much higher blast radius (3 route collapses + a new persistent-agent
interaction model) than anything shipped so far.

### v1 — Scope-first + entry-point collapse (highest confidence, ship first)

- Add a scope pre-step, defaulting to org-wide, in front of whichever
  builder surface the user picks — **without** requiring the sentence/canvas
  merge yet. This can land as: list page → pick scope (pre-selected
  org-wide, one click to accept or change) → single "Build workflow"
  button → today's *existing* sentence builder (`WorkflowBuilderPage.tsx`),
  now pre-seeded with the chosen scope instead of asking again via its
  `scope` `StepId` pill (that pill becomes a "change scope" affordance,
  pre-filled, not a cold-start prompt).
- Collapse the 3 header buttons to 1 "Build workflow" primary CTA. Keep the
  NL entry point alive as a *mode* inside that one flow (a toggle at the top
  of the resulting builder — "Describe it" vs. "Build it step by step" —
  rather than deleting Crystal-driven creation, since that's the exact
  10-second path worth preserving per §1).
- Canvas remains a separate mode/route for now (defer the full 3-way
  merge to v2) but **gains the scope pre-step for free** since it now enters
  through the same pre-step — closing the standing Wave 12 gap
  (`WorkflowCanvasPage.tsx` has zero scope fields) as a side effect, not a
  separate task.
- Backend/CrystalOS: **zero changes required** per §3 — this is a
  frontend-only wave, which is exactly the kind of low-blast-radius work this
  team should bank first before touching the harder assistant piece.
- This alone resolves Wave 10's L-1 finding and Wave 12's canvas-scope gap —
  two already-audited, already-tracked defects — for the cost of one
  frontend wave.

### v2 — Merge sentence + canvas into one surface with a view-mode switch

- Only after v1 is stable: build the actual "one editor, header toggle
  between sentence/canvas view" mechanic (Rohan's remit for the interaction
  mechanics; this doc's stake in it is sequencing only). This is where
  `resolveEditRoute`'s decision logic moves from "pick a page" to "pick a
  view mode within a page," and where canvas finally gets first-class scope
  state instead of inheriting it passively from the v1 pre-step.
- Do this before the assistant (v3), not concurrently — the assistant needs
  a single, stable "current draft state" to read/mutate, and that's
  incoherent to build against two still-separate sentence/canvas states.

### v3 — Persistent, conversational Crystal assistant in the builder

- Highest value, highest risk, correctly last. Two sub-observations worth
  being decisive about:
  1. **This is a natural extension of the existing `CrystalPanel` pattern,
     not a structural departure** — confirmed by direct code read of
     `app/src/components/CrystalPanel.tsx`: it already sends
     `conversation_history`/`conversationHistory` (both a REST and an SSE
     code path) on every turn, i.e., **multi-turn memory already exists** in
     production for the global panel. The "propose, don't mutate" contract
     (`action_proposals` → `ActionProposalCard` → explicit Apply →
     `recordProposalOutcome`) is exactly the right shape for "Crystal can
     add/edit nodes on the user's behalf" — each conversational turn should
     emit a proposal (e.g., "add a condition: NPS < 6") rendered as a
     confirm-card scoped to *this builder's current draft*, not a silent
     mutation of the sentence/canvas state.
  2. **What's genuinely new, not reused:** today's global `CrystalPanel` is
     org/survey-scoped background context (`setScope`, `setCrystalData`) — it
     is not aware of a specific in-progress, unsaved builder draft, and its
     proposals target already-saved resources. A builder-embedded assistant
     needs a new, narrower contract: proposals that patch an **unsaved,
     in-memory** draft (add a node, change a config field, adjust the
     condition) rather than call a persistence API directly. This is a new
     proposal *shape*, not a new architecture — it should still route through
     confirm-cards and still never mutate the draft without the explicit
     Apply click, matching root `CLAUDE.md`'s "Crystal proposes, the app
     executes" rule exactly, just applied to draft state instead of saved
     state.
  - **Recommendation: build this as a scoped variant of the existing
    proposal pattern, not a new one-shot NL parser replacement.** Concretely:
    keep `POST /api/workflows/parse-nl` for the "describe the whole thing at
    once" cold-start case (still valuable, still the fast path for a
    simple, complete idea), and add a new incremental
    endpoint/contract for "given the current draft + conversation history +
    a follow-up instruction, propose a delta" — a different shape from
    "given a description, produce a whole draft." Do not try to force the
    existing `parse-nl` endpoint to serve both jobs.
  - This is a genuine multi-week build (new contract, new proposal type,
    new confirm-card variant, conversation-state management scoped to a
    single unsaved draft) and should be scoped and estimated as its own
    wave with its own TEAM.md dispatch — not folded into v1/v2's frontend
    reshuffling.

### What I would NOT do

- Do not build the scope pre-step as a hard blocking modal with no
  pre-selected default — per §1, this measurably regresses the 10-second
  path for no offsetting gain.
  Do not delete the natural-language entry point in the name of
  "one button" — collapse it to a *mode toggle inside* the one remaining
  button's destination, not remove it; it is this product's fastest path to
  value for the majority of simple, real-world workflows and none of the
  three audits (Wave 10, 11, 12) ever flagged NL-first as the problem —
  they flagged the *ambiguity of 3 parallel doors*, which a mode toggle
  solves without sacrificing speed.
- Do not attempt the persistent assistant (v3) before v1/v2 are shipped and
  stable. Building a conversational, stateful, mutate-the-draft assistant
  against two still-separate sentence/canvas state models (today's reality)
  means building it twice, or building it against a moving target.
