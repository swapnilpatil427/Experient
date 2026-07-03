# Wave 14 — Unified Builder: Implementation-Ready Spec

**Author:** Rohan Desai (Principal Product Designer, Builder Experiences)
**Date:** 2026-07-02
**Status:** Final — implementation-ready. Elias builds from this directly.
**Scope:** Frontend-only, per `docs/automation-hub/TRACKER.md`'s Wave 14 section
(the user's decision record — read that first, it is not repeated here except
where a decision needs to be pinned to an exact line of code). This doc does
not relitigate Wave 13 (`WAVE13_UNIFIED_BUILDER_EVALUATION_UX.md`) — it
finalizes the five open items Wave 13 explicitly deferred to this wave.

**Hard constraint carried through every section below:** every existing call
site of `CrystalPanel.tsx`'s `executeAction`'s `case 'create_workflow'` must be
byte-identical in behavior after this wave. Nothing in this spec changes what
happens today from Insights pages or any other non-builder surface.

---

## 0. Summary of decisions (for Elias's checklist)

| # | Item | Decision |
|---|---|---|
| 1 | List page header | Collapse 3 buttons → 1: **"Build Workflow"**, `variant="default"`, navigates to `ROUTES.WORKFLOW_BUILD`. "Build with Crystal" and "Build on Canvas" buttons removed from the header. Routes/pages NOT deleted. |
| 2 | Crystal trigger icon | New floating action button, bottom-right, on both `WorkflowBuilderPage.tsx` and `WorkflowCanvasPage.tsx`. Opens the existing global `CrystalPanel` via `openCrystal()`. No new component. |
| 3 | Scope-context wiring | Additive `workflow_builder` scope variant + new `setBuilderDraft()` / `builderDraftHydrator` context members on `CrystalPanelContext`. |
| 4 | `create_workflow` branching | `executeAction`'s `case 'create_workflow'` gains one additional conditional branch, checked first: if a `builderDraftHydrator` is registered, route the proposal through it instead of `api.createGraphWorkflow`. Every other path is untouched. |
| 5 | Scope-change safety | Enforced by construction — no new guard logic needed. See §5. |

---

## 1. The "Build Workflow" single button — `WorkflowsPage.tsx`

### 1.1 Exact change

Replace the two `Button`s currently rendered for "Build with Crystal"
(`WorkflowsPage.tsx:188-191`) and "Build Visually" (`WorkflowsPage.tsx:202-213`)
with **one** button. The "Build on Canvas" button (`WorkflowsPage.tsx:214-225`)
is deleted from this header entirely. The "Integrations" button
(`WorkflowsPage.tsx:179-187`) is untouched — it isn't a builder-entry button
and Wave 14's scope doesn't touch it.

```tsx
<Button
  variant="default"
  onClick={() => navigate(ROUTES.WORKFLOW_BUILD)}
  title={t('workflows.buildWorkflowTooltip')}
>
  <Icon name="add" size={16} className="mr-1.5" />
  {t('workflows.buildWorkflow')}
</Button>
```

- **Label:** "Build Workflow" (new locale key `workflows.buildWorkflow`).
  Not "Build Visually" (that name only made sense when it was disambiguating
  itself from two sibling buttons) and not "New Workflow" (Wave 10 killed that
  label deliberately per `DEEP_AUDIT_FIX_SPECS.md` Issue 2 — don't resurrect
  it, the button doing something different now doesn't revive the old name).
- **Variant:** `default` (solid/primary), continuing the Wave 10 precedent
  already on this exact button (`WorkflowsPage.tsx:202`'s comment block) — real
  `Button` variant, no hardcoded hex. This is the only builder-entry CTA in the
  header now, so it should read as unambiguously primary.
- **Icon:** `add` (not `account_tree`, which was disambiguating "visual" from
  "canvas" — no longer needed with one button). Matches the icon already used
  on the empty-state CTA (`WorkflowsPage.tsx:484-490`, `ROUTES.WORKFLOW_BUILD`)
  which this button is now functionally identical to.
- **New locale keys** (add to `src/locales/en.ts`, `workflows.*` namespace):
  - `workflows.buildWorkflow`: `"Build Workflow"`
  - `workflows.buildWorkflowTooltip`: `"Build Workflow — a guided sentence builder; ask Crystal for help or switch to Advanced canvas from inside it"`
- **Remove (dead after this change, safe to delete since nothing else
  references them):** `workflows.buildWithCrystal`, `workflows.buildVisually`,
  `workflows.buildVisuallySubtext`, `workflows.buildVisuallyTooltip`,
  `workflows.buildOnCanvas`, `workflows.buildOnCanvasSubtext`,
  `workflows.buildOnCanvasTooltip`. Confirm no other call site uses these keys
  before deleting (grep first — the empty-state CTA at line 489 uses
  `workflows.empty.cta`, a different key, so it's unaffected).

### 1.2 Where it navigates — confirmed default

Always `ROUTES.WORKFLOW_BUILD` (the sentence builder, `WorkflowBuilderPage.tsx`).
This is correct per the Wave 14 tracker note ("already the most guided
surface") and because it's the only builder page that has the Crystal trigger
icon (§2) AND the canvas escape hatch (`switchToCanvas()`,
`WorkflowBuilderPage.tsx:688-707`) — landing here means every other surface
(canvas, NL builder capability) is still one click/one Crystal-question away.
No conditional routing logic — one button, one destination, always.

### 1.3 Fate of the two removed buttons' underlying pages — decisive answer

- **`WorkflowCanvasPage.tsx` / `ROUTES.WORKFLOW_CANVAS`:** stays fully wired,
  reachable via the sentence builder's existing "Advanced: Branching Canvas"
  link (`WorkflowBuilderPage.tsx:752-754`, `switchToCanvas()`). Also reachable
  today via `resolveEditRoute()` when editing an existing graph-shaped workflow
  from the list page's card "Edit" button (`WorkflowsPage.tsx:437-446`) — that
  call site is untouched. Nothing about this page's route or component
  changes. It is not orphaned — it has two live, working entry points, neither
  of which is the header.
- **`WorkflowNLBuilderPage.tsx` / `ROUTES.WORKFLOW_NL_BUILD`:** **no remaining
  direct entry point in the app's navigable UI.** This is the decisive call:
  its capability (describe a workflow in a sentence, get a full graph back) is
  fully absorbed into "ask Crystal from the icon" (§2, §3) — a customer typing
  "when NPS drops below 30, notify #cx" into the builder-scoped `CrystalPanel`
  gets the same `create_workflow` proposal pipeline this page already used
  (Wave 13 §1 confirmed `create_workflow` is entry-point-agnostic). Per the
  tracker's explicit instruction, **the route and component are NOT deleted**
  — the page keeps working if hit directly (a bookmarked URL, a stale link
  from an old notification, a future revival) — it is unlinked, not removed.
  Do not add a redirect from `ROUTES.WORKFLOW_NL_BUILD` to
  `ROUTES.WORKFLOW_BUILD`; that's an unrequested behavior change and risks
  breaking anything that currently depends on that route resolving to that
  specific page (e.g. deep-linked support docs, e2e tests, the Wave 12
  clarifying-question fix if it ships against this page). Just remove the
  header link. Confirm via grep that no OTHER in-app link
  (empty states, templates, onboarding tours) points at
  `ROUTES.WORKFLOW_NL_BUILD` before shipping — if one exists, flag it to me,
  don't silently unlink it too since that wasn't asked for.

---

## 2. The Crystal trigger icon — placement, treatment, behavior

### 2.1 Component

New component: `app/src/components/workflow-builder/AskCrystalFab.tsx`. A
single small floating action button, not a new chat surface — it exists only
to call `openCrystal()` on the existing global panel.

```tsx
interface AskCrystalFabProps {
  onOpen: () => void;  // wired to openCrystal() by the parent page
}

export function AskCrystalFab({ onOpen }: AskCrystalFabProps) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={t('workflows.builder.askCrystal.aria')}
      title={t('workflows.builder.askCrystal.aria')}
      data-testid="ask-crystal-fab"
      className="fixed bottom-24 md:bottom-6 right-4 md:right-6 z-40 w-14 h-14 rounded-2xl flex items-center justify-center shadow-lg transition-transform hover:scale-105 active:scale-95"
      style={{
        background: 'linear-gradient(135deg, #2a4bd9, #8329c8)',
        boxShadow: '0 8px 24px rgba(42,75,217,0.35)',
      }}
    >
      <Icon name="diamond" size={22} style={{ color: 'white' }} />
    </button>
  );
}
```

### 2.2 Why this exact treatment

- **Icon + gradient:** `diamond` at `linear-gradient(135deg, #2a4bd9, #8329c8)`
  is the literal established Crystal-identity language — this is the exact
  icon/gradient pair `CrystalPanel.tsx`'s own header gem uses
  (`CrystalPanel.tsx:1024-1030`) and its "Ask" submit button
  (`CrystalPanel.tsx:1334-1348`). `TriggerTile.tsx`'s "Crystal" badge
  (`bg-violet-50 text-violet-700` flat text pill, no icon) is a *different*,
  lighter-weight "Crystal suggested this" inline annotation — not a trigger
  affordance, and not brand-forward enough for a standalone FAB. The panel's
  own gradient gem is the right precedent to copy here because this button's
  entire job is "this opens Crystal," so it should look like Crystal's own
  chrome, not a generic AI sparkle.
- **Position — `fixed bottom-24 md:bottom-6 right-4 md:right-6 z-40`:**
  matches the codebase's own established FAB convention, confirmed by direct
  read of the currently-mounted `XperiqCopilot`/`ExperientCopilot` component
  (`app/src/components/ExperientCopilot.tsx:256`,
  `className="fixed bottom-4 right-4 sm:bottom-6 sm:right-6 z-50"`, live —
  mounted in `SurveyBuilderPage.tsx`) — this is not an invented pattern, it's
  the second live instance of it in this codebase. The mobile offset
  (`bottom-24` instead of `bottom-6`) is the one deliberate deviation, and it's
  required: `BottomNav.tsx:27` is `fixed bottom-0 left-0 w-full z-50`, full
  width, roughly 4.5–5rem tall including its `safe-area-inset-bottom` padding
  and FAB — a `bottom-6` position on mobile would sit on top of it. `bottom-24`
  (6rem) clears that with margin. `z-40` (one below BottomNav's `z-50` and
  below the panel's own `z-50`) so if a user is on mobile and BottomNav is
  visible, BottomNav stays on top — no fixed-element stacking fight, and
  `CrystalPanel` (`z-50`) always draws over this FAB once opened.
- **`right-4 md:right-6`:** matches `ExperientCopilot`'s own responsive
  right-inset exactly (tighter margin on small screens, more breathing room at
  `sm:`/`md:`+).
- **Size (`w-14 h-14`, 22px icon):** deliberately smaller/quieter than
  `ExperientCopilot`'s bubble (which has a persistent expandable label chip) —
  this is a pure trigger for an existing surface, not a second assistant
  presence competing for attention, matching the "not a new chat component"
  instruction literally in its visual weight too.

### 2.3 Discoverability copy — first-view label

On first render only (not every mount — respect the user, don't nag), show a
small dismissible label bubble to the upper-left of the FAB, matching the
exact interaction pattern `ExperientCopilot.tsx:254-267` already uses (a
`bg-white` rounded chip, gradient text, appears after a short delay, dismisses
on interaction/timeout). Reuse that pattern's mechanics — same `AnimatePresence`
+ delayed-motion entrance, same one-time-only guard (localStorage key, e.g.
`askCrystalFabSeen`, mirroring however `ExperientCopilot` gates its own
first-view chip) — do not build a second onboarding-tooltip mechanism.

Copy: `t('workflows.builder.askCrystal.label')` = **"Ask Crystal"** — short,
matches Wave 13's own spec sketch (§1 of `WAVE13_UNIFIED_BUILDER_EVALUATION_UX.md`
literally used "Ask Crystal to help" as the illustrative chip copy). The
`aria-label`/`title` on the button itself (`workflows.builder.askCrystal.aria`)
can be slightly fuller: **"Ask Crystal — get help or build with AI"** — this
is what a screen reader announces and what a hover title shows after the
first-view chip has already been dismissed, so it can carry a bit more
context than the one-time label.

### 2.4 Click behavior

```tsx
const { openCrystal } = useCrystalPanel();
// ...
<AskCrystalFab onOpen={() => openCrystal()} />
```

No pre-filled query (`openCrystal()` with no args, matching the
`openCrystal(query?: string, ctx?: CrystalCtx)` signature's optional-args
contract) — this is a general entry, not a canned prompt. It opens the *same*
global panel instance every other entry point opens (SideNav, ⌘K, Insights
hero bar) — same conversation history, same `isOpen` state. Do not call
`setScope`/`setBuilderDraft` from inside this click handler — that wiring is
lifecycle-based (§3), not click-based, so the panel is *already* aware it's in
builder context by the time this FAB is clicked (registered on page mount,
per §3's `useEffect`).

### 2.5 Both builder pages, confirmed non-obstruction

- **`WorkflowBuilderPage.tsx`:** the sentence + step-panels layout
  (`max-w-4xl`/`max-w-7xl` centered columns, `WorkflowBuilderPage.tsx:734-849`)
  never uses the far bottom-right corner of the viewport for interactive
  content — the FAB floats clear of it at every breakpoint.
- **`WorkflowCanvasPage.tsx`:** confirmed by direct read
  (`WorkflowCanvasPage.tsx:305-364`) that the ReactFlow surface is **not**
  full-viewport — it's a `height: 70vh` bordered box inside the normal
  `max-w-7xl mx-auto` page column, itself inside AppShell's normal scrolling
  page body (not a builder-mode full-bleed page like `SurveyBuilderPage.tsx`).
  ReactFlow's own `<Controls />` (zoom/fit buttons) render bottom-LEFT inside
  that box by the library's default, and `<MiniMap />` renders bottom-RIGHT
  *inside the box*, not viewport-fixed. Because `AskCrystalFab` is
  `position: fixed` (viewport-relative, floating above the whole page,
  scrolling included) rather than being placed inside the `70vh` canvas
  container, it sits fully outside ReactFlow's own DOM subtree — it will
  visually float over whatever is scrolled to the bottom-right of the
  *viewport* at any given moment, the same common "map/canvas + floating
  corner button" pattern used elsewhere (e.g. Google Maps' report/feedback FAB
  over a MiniMap). There is a narrow edge case worth naming, not silently
  ignoring: if the ReactFlow canvas box happens to be scrolled such that its
  own MiniMap sits directly under the fixed FAB's screen position, the FAB
  will visually overlap the MiniMap corner. This is a minor, non-blocking
  cosmetic overlap (MiniMap is a passive read-only thumbnail, not an
  interactive control users click precisely) — acceptable for this wave, not
  worth a canvas-specific FAB position override. If it reads as visually
  cluttered once built, the cheapest fix is `bottom-24 md:bottom-8` on the
  canvas page specifically (a few more pixels of clearance) — not a redesign.

---

## 3. Scope-context wiring — `CrystalPanelContext` additive changes

### 3.1 New type — additive union member

`app/src/contexts/crystalPanel.tsx` currently types `scope` as `SurveyScope`
(imported from `SurveyScopePicker`, effectively `'all' | <surveyId>`). Per
Wave 13 §1's own plan, widen this **additively** — every existing caller that
only ever passes/reads a `SurveyScope` value continues to compile and behave
identically, since `SurveyScope` remains a valid member of the new union.

```ts
// app/src/contexts/crystalPanel.tsx

export interface BuilderDraftSummary {
  mode: 'sentence' | 'canvas';
  triggerType?: string;
  scopeSelection: { scopeType: 'org' | 'survey' | 'tag'; scopeSurveyId?: string; scopeTagId?: string; surveyName?: string; tagName?: string };
  conditionClauses: Array<{ field: string; op: string; value: string }>;
  actions: Array<{ action: string; label: string }>;
  workflowName: string;
  isEditMode: boolean;
}

export type PanelScope = SurveyScope | { kind: 'workflow_builder' };
```

`PanelScope` is additive — it is a **new exported type**, distinct from the
existing `scope: SurveyScope` field's declared type today. Do not change the
declared type of the existing `scope` field in place (that would be a
breaking signature change to every survey-scoped caller); instead:

- The context keeps its existing `scope: SurveyScope` field **byte-identical**
  (Insights pages, `setScope('all')`/`setScope(surveyId)` calls — zero
  changes).
- Add a **new, separate** field: `builderContext: { kind: 'workflow_builder' } | null`,
  defaulting to `null`. This is the additive union member the tracker/Wave 13
  describe — implemented as a sibling flag rather than folding it into the
  existing `scope` field's type, which is a smaller, more surgical diff and
  avoids touching every existing `scope === 'all'`/`scope !== 'all'` comparison
  already sprinkled through `CrystalPanel.tsx` (e.g. `isAll = scope === 'all'`,
  `CrystalPanel.tsx:174`) — none of that code needs to learn about builder
  context; it can keep comparing `scope` exactly as today, since builder
  context isn't a *survey* scope, it's an orthogonal "what kind of page is
  this" flag Crystal's prompt-construction layer can check independently.

### 3.2 New context members

```ts
interface CrystalPanelContextValue {
  // ...existing fields, unchanged...
  builderContext:      { kind: 'workflow_builder' } | null;
  builderDraft:         BuilderDraftSummary | null;
  builderDraftHydrator: ((proposal: ActionProposal) => boolean) | null;
  setBuilderContext:    (ctx: { kind: 'workflow_builder' } | null) => void;
  setBuilderDraft:      (draft: BuilderDraftSummary | null) => void;
  setBuilderDraftHydrator: (hydrator: ((proposal: ActionProposal) => boolean) | null) => void;
}
```

- `setBuilderContext(ctx)` / `setBuilderDraft(draft)` mirror the existing
  `setScope`/`setCrystalData` lifecycle pattern exactly (`app/CLAUDE.md`'s
  documented "Crystal AI Panel" pattern) — plain `useState` setters exposed
  through the context, no new state-management mechanism.
- `setBuilderDraftHydrator` is the mechanism item 4 depends on — see §4 for
  why it's a separate setter from `setBuilderDraft` (draft is data Crystal
  reads; the hydrator is a callback `CrystalPanel.tsx` calls, a materially
  different kind of thing, kept as its own field for clarity rather than
  overloading one prop with two jobs).

### 3.3 What the builder page calls, and when

`WorkflowBuilderPage.tsx` (and `WorkflowCanvasPage.tsx`, once it also gets the
FAB per §2) call this on mount/update/unmount, the same shape as every other
page's `setScope`/`setCrystalData` `useEffect`:

```tsx
const { setBuilderContext, setBuilderDraft, setBuilderDraftHydrator } = useCrystalPanel();

// Mount / unmount — announce "we're in the Automation Hub builder."
useEffect(() => {
  setBuilderContext({ kind: 'workflow_builder' });
  return () => {
    setBuilderContext(null);
    setBuilderDraft(null);
    setBuilderDraftHydrator(null);
  };
}, [setBuilderContext, setBuilderDraft, setBuilderDraftHydrator]);

// Every relevant state change — keep Crystal's view of the draft current.
useEffect(() => {
  setBuilderDraft({
    mode: 'sentence',
    triggerType,
    scopeSelection: scope,
    conditionClauses: conditionClauses.map((c) => ({ field: c.field, op: c.op, value: c.value })),
    actions: actionClauses.map((a) => ({ action: a.action, label: a.label })),
    workflowName: name,
    isEditMode,
  });
}, [triggerType, scope, conditionClauses, actionClauses, name, isEditMode, setBuilderDraft]);

// Register the hydration callback once (see §4) — identity can be stable via useCallback.
useEffect(() => {
  setBuilderDraftHydrator(hydrateFromProposal);
  return () => setBuilderDraftHydrator(null);
}, [hydrateFromProposal, setBuilderDraftHydrator]);
```

### 3.4 What data Crystal needs, concretely (frontend contract only)

Per the task's own scoping note, this is the data contract, not prompt
engineering. `BuilderDraftSummary` (§3.1) is deliberately a flat, already-
human-readable summary — not the raw `EngineNode[]`/`EngineEdge[]` graph —
because it mirrors the same "give the model compact, labeled material" lesson
Wave 12 already learned the hard way (`_format_catalog`, TRACKER.md Wave 12):
`triggerType`/`actions[].label`/`scopeSelection` are the same display strings
already computed for the sentence's own pills (`triggerPillLabel`,
`actionLabel()`, `scopePillLabel` — `WorkflowBuilderPage.tsx:426-443`), reused
here rather than re-derived. This is enough for Crystal to answer "what have I
built so far" and "what's missing" without needing the wire-format graph at
all; if a future wave wants Crystal to reason over exact node IDs/edges for
true patch-editing (Wave 13 §2's deferred Phase 3), that's an additive
extension of this same struct, not a redesign.

---

## 4. `create_workflow` branching — the crux

### 4.1 Today's exact behavior (confirmed, must not change for non-builder callers)

`CrystalPanel.tsx:721-761`, `case 'create_workflow'`:

```ts
case 'create_workflow': {
  if (!surveyId) { track('failed', undefined, 'no survey in scope'); break; }
  const nodes = proposal.params.nodes as unknown[] | undefined;
  const edges = proposal.params.edges as unknown[] | undefined;
  if (Array.isArray(nodes) && Array.isArray(edges)) {
    const created = await api.createGraphWorkflow({ /* ... */ });
    invalidate('workflows');
    track('succeeded', ...);
    note(`Workflow created: "${proposal.title}". Open Workflows to manage it.`);
    break;
  }
  // legacy fallback ...
}
```

**Important existing detail, worth flagging explicitly:** this handler
currently requires `surveyId` (`focusSurvey?.id`, derived from the panel's
survey `scope`) to be truthy or it fails immediately
(`if (!surveyId) { track('failed', ...); break; }`) — it never even reaches
the `createGraphWorkflow` call otherwise. This means, today, `create_workflow`
proposals only actually execute when the panel is scoped to a specific survey.
This is exactly why the builder-context branch below must be checked
**before** this guard, not after — the builder page's `scope` is
`workflow_builder`, not a survey ID, and `focusSurvey` will correctly be
`undefined` there. If the new branch were inserted after the `!surveyId`
check, it would never run from the builder page at all (same bug the guard
already produces for portfolio/org-scoped Insights views today — out of scope
to fix here, but the ordering below avoids inheriting it for the new path).

### 4.2 The new branch — exact conditional, exact placement

Insert a new branch **at the very top of `case 'create_workflow'`, before the
existing `!surveyId` check**:

```ts
case 'create_workflow': {
  const { builderDraftHydrator } = /* already destructured from useCrystalPanel() at top of component */;

  // Wave 14 — if a builder page has registered a hydration callback, this
  // proposal is being applied from INSIDE an open builder draft. Route it
  // through the callback (which only updates the page's own local state)
  // instead of persisting a second workflow. The existing Save button on
  // that page remains the one and only persist action — unchanged.
  if (builderDraftHydrator) {
    const handled = builderDraftHydrator(proposal);
    if (handled) {
      track('succeeded');  // no outcomeRef — nothing persisted yet, correctly
      note(`Applied "${proposal.title}" to the current draft below. Review, then click Save when you're ready.`);
      break;
    }
    // Registered but declined (e.g. proposal shape it doesn't recognize) —
    // fall through to today's exact existing behavior below as a safety net,
    // rather than silently dropping the proposal.
  }

  if (!surveyId) { track('failed', undefined, 'no survey in scope'); break; }
  // ...rest of the existing case body, completely unchanged...
}
```

- **Why `builderDraftHydrator` (existence check) and not
  `builderContext?.kind === 'workflow_builder'`:** the hydrator callback is
  the thing that actually knows how to apply the proposal to a specific page's
  local state shape (sentence builder state vs. canvas ReactFlow node/edge
  state are different shapes — see §4.3). Checking for the callback's
  *existence* rather than a scope *label* means the branch is self-describing
  and impossible to trigger accidentally: it only ever fires when a real
  builder page has actually mounted and registered it (§3.3's `useEffect`).
  If a future page sets `builderContext` for some other reason without
  registering a hydrator, `create_workflow` proposals there correctly fall
  through to today's unchanged behavior instead of silently no-op'ing.
- **`handled` return value, not `void`:** `hydrateFromProposal` (§4.3) returns
  `boolean` so the panel can safely fall back to the persist path for any
  proposal shape the builder doesn't recognize (e.g. the legacy flat
  `trigger`/`action_type` shape from §4.1's fallback branch) — this makes the
  new branch strictly additive/non-lossy: worst case, an unrecognized proposal
  behaves exactly as it does today.
- **Outcome telemetry:** still calls `track('succeeded')` — the outcome funnel
  (`recordProposalOutcome`) stays unified per Wave 13 §1's own reasoning, it
  just has no `outcomeRef` (no workflow ID exists yet, correctly, since
  nothing was persisted). This preserves "outcome telemetry stays unified"
  without inventing a "hydrated, not yet saved" telemetry status that nothing
  downstream currently consumes.
- **User-facing copy on apply:** explicitly says "Review, then click Save" —
  reinforcing to the customer that this action populated the draft, not a
  finished, persisted workflow. This is the UX signal that keeps "Save stays
  the one persist action" legible, not just true in code.

### 4.3 `hydrateFromProposal` — what it does, on which page

Each builder page implements its own `hydrateFromProposal(proposal): boolean`,
passed into `setBuilderDraftHydrator` (§3.3). It is NOT part of
`CrystalPanel.tsx` — it lives in the page, because only the page knows its own
local state setters.

**`WorkflowBuilderPage.tsx` (sentence builder) implementation shape:**

```tsx
const hydrateFromProposal = useCallback((proposal: ActionProposal): boolean => {
  const nodes = proposal.params.nodes as EngineNode[] | undefined;
  const edges = proposal.params.edges as EngineEdge[] | undefined;
  if (!Array.isArray(nodes) || !Array.isArray(edges)) return false;  // unrecognized shape — let the panel fall back

  const { triggerType: tType, scheduleConfig: sched, actions: newActions, conditionClauses: newConditions } =
    hydrateFromNodes(nodes, proposal.params.trigger_type as string | undefined);
  if (tType) { setTriggerType(tType); if (sched) setScheduleConfig(sched); }
  setActions(newActions);
  setConditionClauses(newConditions);
  if (!name.trim() && (proposal.params.name || proposal.title)) {
    setName((proposal.params.name as string) || proposal.title);
  }
  return true;
}, [name, hydrateFromNodes /* + setters, stable */]);
```

This reuses `hydrateFromNodes()` — the **exact same** parser
`WorkflowBuilderPage.tsx` already uses for edit-mode fetch and template
hand-off (`WorkflowBuilderPage.tsx:112-176`) — no new graph-parsing logic.
Applying a Crystal proposal into an open draft is architecturally identical to
applying a template, which this page already does safely today.

**Scope note:** `hydrateFromProposal` deliberately does **not** touch `scope`
(the sentence's scope pill state) unless the proposal explicitly carries a
scope hint AND the customer applies it — see §5, this is the one case where
"apply" is allowed to set scope, and it's still gated by the same explicit
Apply click, not automatic.

**`WorkflowCanvasPage.tsx` (canvas) implementation shape:** analogous, using
that page's own existing `deserializeCanvas()` (already used for its own
edit-mode fetch and seed hydration, same precedent as
`hydrateFromNodes` above) to convert `proposal.params.nodes`/`edges` into
ReactFlow's `nodes`/`edges` state via `setNodes`/`setEdges`. Same `boolean`
return contract, same "reuse the page's own existing hydration path" principle
— do not write a second graph-to-canvas converter.

### 4.4 Confirming zero impact elsewhere

Every existing call site of `create_workflow` (Insights pages, wherever else
this proposal type currently fires) never calls `setBuilderContext`/
`setBuilderDraftHydrator` — those setters are new, unused by any code that
exists today. `builderDraftHydrator` is therefore `null` by default
(`useState<... | null>(null)` in the provider) everywhere except the two
builder pages, while they're mounted. The new branch's `if (builderDraftHydrator)`
guard is consequently `false` in 100% of today's scenarios, and execution
falls through to the completely unchanged existing code path. This is a
default-off additive branch, not a refactor of the existing one.

---

## 5. Scope-change safety — confirmed, no extra guarding needed

### 5.1 The mechanism, restated precisely

Per §4.3, when `hydrateFromProposal` runs, it MAY set the sentence's `scope`
state (via `setScope(...)`, the sentence builder's own existing local
setter — the same one the manual scope-pill click already calls,
`WorkflowBuilderPage.tsx:874`, `<ScopeStepPanelContent value={scope} onChange={setScope} .../>`)
if-and-only-if the applied proposal's params carry a scope hint. This is
identical in kind to what a template hand-off already does today
(`WorkflowTemplates`'s `useTemplate()`, `WorkflowsPage.tsx:909-924`, seeds
`nodes`/`edges` into a fresh draft without the user separately re-confirming
each field) — templates aren't gated behind extra confirmation dialogs beyond
the initial "Use template" click, and a Crystal proposal apply shouldn't need
more ceremony than a template does, since both are the same category of event
(an explicit user click that says "start my draft from this").

### 5.2 Why this is safe by construction, not by convention

The task asks whether ambient Q&A could ever touch scope through this same
path. It cannot, for a structural reason, not a policy one:

- `hydrateFromProposal` (and therefore any code path that can call
  `setScope`) is **only ever invoked from one call site**: `executeAction`'s
  `case 'create_workflow'`, and **only** on the branch reached when
  `builderDraftHydrator` exists (§4.2). `executeAction` itself is **only**
  ever called from one place in the whole codebase:
  `onApply={() => executeAction(p)}` on `ActionProposalCard`
  (`CrystalPanel.tsx:1212`) — which is the **Apply button** on a rendered
  proposal card. There is no code path from `submitQuery`
  (`CrystalPanel.tsx:206`, the function that handles a user typing/asking a
  question) to `executeAction` — a question-and-answer turn only ever
  populates `messages`/`actionProposals` state; it never calls `executeAction`
  itself. A proposal sits inert as a card until a human clicks Apply.
- Therefore: "Crystal answers an unrelated question in the same conversation"
  and "a proposal gets applied" are already two structurally disjoint code
  paths in the existing, unmodified `CrystalPanel.tsx` — this wave doesn't
  need to add a guard to keep them separate, because Wave 3's original
  action-proposal architecture (predating this wave entirely) already
  requires an explicit Apply click to reach any mutation, including this new
  one. The manual pill click (`ScopeStepPanelContent`'s `onChange`) and the
  hydrator's conditional `setScope` inside an Apply-triggered callback are the
  *only* two call sites of `setScope` in the sentence builder after this
  change, and both require a discrete, intentional user click to fire.

**Conclusion: no additional guard logic is needed.** The existing
propose/confirm/apply architecture (`app/CLAUDE.md`'s documented "Crystal
proposes, the app executes" boundary) already enforces the exact invariant
the user asked for, as a byproduct of how `executeAction` is wired, not as
something this spec has to newly bolt on. Flagging this explicitly rather than
silently assuming it, per the task's own instruction — Elias should not add
a redundant "are we sure this wasn't ambient" check; it would be dead code
checking a condition that's already structurally impossible.

---

## 6. Test coverage Elias/Kenji should plan for (not exhaustive — QA owns the full pass)

- `WorkflowsPage.test.tsx`: header renders exactly one build button labeled
  "Build Workflow", `variant="default"`; clicking navigates to
  `ROUTES.WORKFLOW_BUILD`; "Build with Crystal"/"Build on Canvas" buttons are
  absent from the DOM.
- `WorkflowBuilderPage.test.tsx` (new cases): `AskCrystalFab` renders;
  clicking it calls `openCrystal()` (mock `useCrystalPanel`); `setBuilderContext`/
  `setBuilderDraft` are called on mount with the expected shape and reset
  (`null`) on unmount; `setBuilderDraftHydrator` registers a function on mount
  and `null` on unmount.
- `CrystalPanel.test.tsx` (new cases): with `builderDraftHydrator` mocked to a
  jest fn returning `true`, applying a `create_workflow` proposal calls the
  hydrator and does **not** call `api.createGraphWorkflow`; with
  `builderDraftHydrator` `null` (today's default), applying the same proposal
  calls `api.createGraphWorkflow` exactly as before (regression proof of
  byte-identical behavior everywhere else); with the hydrator returning
  `false` (unrecognized shape), falls through to `api.createGraphWorkflow`.
- Regression: every existing `create_workflow`-related test in
  `CrystalPanel.test.tsx` continues to pass unmodified (proof of the hard
  backward-compatibility requirement).
