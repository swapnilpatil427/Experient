# Xperiq Actions — Deep Audit Fix Specs

**Author:** Rohan Desai, Principal Product Designer, Builder Experiences
**Date:** 2026-07-01
**Scope:** Implementation-ready specs for the three issues assigned off Wave 10's
`DEEP_AUDIT_PM_FINDINGS.md` (Maya's Top-5 #2) and `DEEP_AUDIT_UX_FINDINGS.md` (my own
prior findings L-1, C-1). No code in this doc — Elias builds from this.

**Read alongside:** `app/src/lib/workflowCanvas.ts`, `app/src/pages/WorkflowCanvasPage.tsx`,
`app/src/pages/WorkflowBuilderPage.tsx`, `app/src/pages/WorkflowsPage.tsx`, and the
`app/src/components/workflow-builder/sentence/` tree (`SimpleActionConfigForm.tsx`,
`ContentCustomizationPanel.tsx`, `NotifyTargetPicker.tsx`, `ActionStepPanelContent.tsx`,
`StepPanel.tsx`).

---

## Summary of decisions

1. **Issue 1 (canvas config):** Option A. Canvas `ActionNode`s stay small and get a
   binary "Configured / Needs configuration" visual state plus a "Configure" click
   target. Clicking opens a new lightweight side panel (`ActionConfigPanel`, a sibling
   of `StepPanel`, not a re-skin of it) that renders the exact same config forms the
   sentence builder uses — `SimpleActionConfigForm`, `ContentCustomizationPanel`, or
   `NotifyTargetPicker`, chosen by the same dispatch rule `ActionStepPanelContent.tsx`
   already encodes. `CanvasNodeData` gains a real `config: Record<string, unknown>`
   field; `serializeCanvas()` reads `d.config ?? {}` instead of hardcoding `{}`.
2. **Issue 2 (entry points):** Remove "New Workflow" entirely. "Build Visually" becomes
   the sole solid/primary CTA. Add one-line subtext under "Build Visually" and "Build on
   Canvas" so the sentence-vs-branching distinction is legible without a click.
3. **Issue 3 (canvas escape hatch):** Extend `switchToCanvas()`'s create-mode branch to
   call the sentence builder's own `serialize()` and pass its full `{ nodes, edges }`
   output as the seed — the exact same shape already accepted by
   `WorkflowCanvasPage`'s `seed?.nodes || seed?.edges` branch (used today by the NL
   builder and templates). No adapter needed; `serialize()`'s output is already
   `deserializeCanvas()`-compatible as-is, confirmed by inspection (see Issue 3 detail).

---

## Issue 1 — Canvas builder action config

### Problem restated

`serializeCanvas()` (`workflowCanvas.ts:54`) hardcodes `config: {}` for every action
node. `ActionNode` (`WorkflowCanvasPage.tsx:289-302`) renders one `<select>` for action
type and nothing else. There is no data path from a canvas node to a populated config
object at all.

### What already exists to reuse (confirmed by direct read, not assumed)

| Config need | Existing component | Notes |
|---|---|---|
| Simple key/value fields (Jira project key, Salesforce field, ServiceNow category, Zendesk priority, `flow.approval`'s approver email, `data.tag_responses`'s tag) | `SimpleActionConfigForm.tsx` | Pure `{ action, config, onChange }` props — zero dependency on sentence-builder state. Drops in unmodified. |
| Content-producing actions (`notify.email`, `notify.slack`, `crystal.summarize`) — section checklist + live preview + advanced fields | `ContentCustomizationPanel.tsx` | Pure `{ actionType, value: ActionContentConfig, onChange }` props. Drops in unmodified. |
| Recipient targeting for `notify.in_app` (and `notify.email`'s target sub-field, reached inside `ContentCustomizationPanel` via `AdvancedFieldsDisclosure`) | `NotifyTargetPicker.tsx` | Pure `{ value: NotifyTarget | undefined, onChange }` props. Drops in unmodified. |
| Dispatch rule: which of the above to render for a given action | `ActionStepPanelContent.tsx` lines 43-44, 66-83 | `CONTENT_PRODUCING_ACTIONS.has(action)` → `ContentCustomizationPanel`; `action === 'notify.in_app'` → `NotifyTargetPicker`; else → `SimpleActionConfigForm`. This exact three-way branch is what the new canvas panel reuses — not reinvented. |

None of these three form components read from `WorkflowBuilderPage`'s local state
directly — they're already pure, controlled components keyed on `action`/`config`/
`value` props. That's what makes them droppable into a completely different host
(the canvas) with no sentence-builder dependency. This was the deciding factor for
Option A over building a canvas-native config UI from scratch.

### Data model change — `CanvasNodeData`

`workflowCanvas.ts`'s `CanvasNodeData` interface gains one field:

```ts
export interface CanvasNodeData {
  kind: 'trigger' | 'condition' | 'action';
  triggerType?: string;
  action?: string;
  config?: Record<string, unknown>;   // NEW — real per-action config, action nodes only
  field?: string;
  op?: string;
  value?: string;
  [k: string]: unknown;
}
```

`config` is `undefined`/`{}` until the user opens the panel and enters at least one
field — this is the state the "Needs configuration" indicator keys off (see below).
It is only ever meaningful on `kind: 'action'` nodes; trigger/condition nodes ignore it.

### `serializeCanvas()` change

```ts
// Before:
return { id: n.id, type: 'action', action: d.action, config: {} };

// After:
return { id: n.id, type: 'action', action: d.action, config: d.config ?? {} };
```

One-line change, but only correct once the node actually carries `config` — hence
everything else in this spec. No change needed to `EngineNode`'s type (`config?:
Record<string, unknown>` already exists there).

### `deserializeCanvas()` change

Currently (`workflowCanvas.ts:172-176`) the action-node branch drops `n.config`
entirely when building `Node<CanvasNodeData>`:

```ts
return {
  id: n.id, type: 'wfAction', position,
  data: { kind: 'action', action: n.action ?? '', options: ctx.actionDefs, patch: ctx.patch },
} as Node<CanvasNodeData>;
```

Must be extended to carry the loaded config forward, so editing an existing
canvas-built (or now-fixed) workflow round-trips its config instead of blanking it
on every load:

```ts
return {
  id: n.id, type: 'wfAction', position,
  data: { kind: 'action', action: n.action ?? '', config: n.config ?? {}, options: ctx.actionDefs, patch: ctx.patch },
} as Node<CanvasNodeData>;
```

### Node appearance at rest — the "impossible to miss" requirement

`ActionNode` needs a rest-state visual signal distinguishing "has real config" from
"empty config," since silently-empty config is exactly the bug being fixed. Binary,
not fuzzy: this is not a partial-completion progress bar, it's "would this action
actually do anything if it fired right now."

**Definition of "configured" per action type** (mirrors what "no configuration needed"
already means in `SimpleActionConfigForm`, so the same logic is reusable, not
reinvented):
- `flow.stop`: always configured (has zero fields — `FIELDS_BY_ACTION['flow.stop'] = []`).
- Actions with `SimpleActionConfigForm` fields (Jira, Salesforce, ServiceNow, Zendesk,
  `flow.approval`, `data.tag_responses`): configured once every field in
  `FIELDS_BY_ACTION[action]` has a non-empty value in `config`.
- `notify.in_app`: configured once `config.targetType` is set and, for `targetType:
  'users'`, `config.userIds` is non-empty (or `roleId`/`departmentId`/`groupId` is set
  for the other three modes).
- `CONTENT_PRODUCING_ACTIONS` (`notify.email`, `notify.slack`, `crystal.summarize`):
  configured once the action's minimum required field is present — `notify.email`
  requires a resolved target (same rule as `notify.in_app`, read off the flattened
  `targetType`/`userIds` etc. once `flattenNotifyTarget()` has run); `notify.slack`
  requires `channel`; `crystal.summarize` has no required field beyond selecting the
  action itself, so it's always configured once selected (matches the sentence
  builder's own treatment — `AdvancedFieldsDisclosure` only requires `channel` for
  Slack).
- `notify.webhook` and `crystal.classify`: out of scope for this fix per PM findings
  #2a/#2b — both currently fall through to "no configuration needed" even in the
  sentence builder. Once Nina wires `FIELDS_BY_ACTION['notify.webhook']` (tracked
  separately, PM audit "fix immediately" item #2), the canvas panel picks it up for
  free since it reuses `SimpleActionConfigForm`'s own field-completeness check —
  no canvas-side change needed when that lands.

This completeness check is a small new pure helper — `isActionConfigured(action:
string, config: Record<string, unknown>): boolean` — living in `workflowCanvas.ts`
next to `serializeCanvas()`/`deserializeCanvas()` (same file, same "pure and
unit-testable without rendering reactflow" rationale the file's own header comment
already states). `ActionStepPanelContent`'s existing dispatch constants
(`CONTENT_PRODUCING_ACTIONS`, the `notify.in_app` check) are imported and reused
inside it, not duplicated.

**Visual spec for `ActionNode`:**

```
┌─────────────────────────────────┐
│ ▶ Action                         │   ← existing header row, unchanged
│ [Slack: Notify            ▾]     │   ← existing action-type select, unchanged
│ ─────────────────────────────    │
│ ⚠ Needs configuration       [›]  │   ← NEW row, only when NOT configured
└─────────────────────────────────┘
```
vs.
```
┌─────────────────────────────────┐
│ ▶ Action                         │
│ [Slack: Notify            ▾]     │
│ ─────────────────────────────    │
│ ✓ #cx-alerts                [›]  │   ← NEW row, when configured — shows a
└─────────────────────────────────┘      short human summary, not just "Configured"
```

- **Unconfigured state**: amber/warning-colored row (`text-warning`, matching
  `SentencePill`'s existing `'invalid'` dashed-amber convention so the same "this
  needs attention" language is used across both builders), `warning` icon, label
  `t('workflows.canvas.action.needsConfig')` = **"Needs configuration"**. The node's
  outer border also switches from the current static `border-top: 3px solid #059669`
  (green) to `#d97706` (amber, matching `ConditionNode`'s existing amber) while
  unconfigured — reuse the existing warning color token, don't invent a new one.
- **Configured state**: `text-success`/`check_circle` icon, green top border restored,
  and a **one-line human summary** instead of a generic "Configured" label — e.g.
  "#cx-alerts" for Slack, "3 people" / "Support role (12 people)" for notify targets,
  "PROJ-123" for Jira project key, "jane@co.com" for an approver email. This directly
  answers PM Finding audit's adjacent ask (Rohan's own §6 finding, S-1/"per-action
  status glyph") for free, and prevents the new indicator from being just as opaque
  as the bug it replaces. Falls back to `t('workflows.canvas.action.configured')` =
  **"Configured"** only for actions with no single obviously-summarizable field
  (`flow.stop`, `crystal.summarize`).
- Both rows are themselves a `<button type="button">` (not a bare `<div>`, per the
  codebase's existing a11y bar set by `SentencePill`/`ActionTile`/`TriggerTile|`) with
  `aria-label` = `t('workflows.canvas.action.configureAria', { action: label })` =
  "Configure {action label}", so the click target and its accessible name are
  unambiguous — this closes the same tooltip-only-signal gap Rohan's own audit flagged
  as A-1 for readiness dots, rather than reproducing it on the new indicator.
- The row is present immediately on node creation (`addAction()`'s new node data
  defaults to `config: {}`, which `isActionConfigured` correctly evaluates as false
  for every non-`flow.stop` action) — a freshly dropped action node shows "Needs
  configuration" from the first render, not just after a failed save. This is the
  core of "impossible to miss": there is no silent/neutral resting state.

### What opens on click — `ActionConfigPanel`

**New component**, not a reuse of `StepPanel` — `StepPanel` is purpose-built for the
sentence builder's step-sequencing UX (Cancel/Done footer wired to that page's
step-navigation state machine, `AnimatePresence key={testId ?? label}` tuned for
switching between trigger/scope/action steps in one linear flow). The canvas has a
different interaction shape: N action nodes, each independently editable, no
"steps" — so a **right-side `Sheet`** (already an available shadcn primitive per
`app/CLAUDE.md`'s "Available shadcn Primitives" list, used elsewhere in the app,
zero new dependency) is the right container, not a competing bespoke slide-down.

`ActionConfigPanel` (new file:
`app/src/components/workflow-builder/canvas/ActionConfigPanel.tsx`):

```tsx
export interface ActionConfigPanelProps {
  open: boolean;
  action: string;                          // e.g. 'notify.slack'
  actionLabel: string;                     // e.g. 'Slack: Notify' — for the Sheet title
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
  onClose: () => void;
}
```

Body dispatch (identical three-way branch to `ActionStepPanelContent.tsx`, imported
constants reused, not re-declared):

- `CONTENT_PRODUCING_ACTIONS.has(action)` → `<ContentCustomizationPanel actionType={action} value={toActionContentConfig(config)} onChange={...} />`
- `action === 'notify.in_app'` → `<NotifyTargetPicker value={toNotifyTarget(config)} onChange={...} />` (label above it, same as `ActionStepPanelContent`'s in-app branch)
- else → `<SimpleActionConfigForm action={action} config={config} onChange={onChange} />`

**Config shape adapter note:** `ContentCustomizationPanel` operates on
`ActionContentConfig` (a richer shape with `sections`/`preset`/`target`/`channel`/
`subject`) while the canvas node's `config` is the same flat
`Record<string, unknown>` the engine persists. The sentence builder already solves
exactly this impedance mismatch in `serialize()` (lines 366-374 of
`WorkflowBuilderPage.tsx`: flattens `ActionContentConfig` → engine config via
`flattenNotifyTarget()`, and the inverse happens in `hydrateFromNodes()` on load).
`ActionConfigPanel` needs the same pair of small adapter functions
(`toActionContentConfig(engineConfig)` / `flattenNotifyTarget(...)` — the latter
already exported from `contentSections.ts`, reused not duplicated) so
`ContentCustomizationPanel` gets its expected shape and the panel flattens back to
the engine's flat config on every `onChange`. This is the one piece of genuinely new
glue code in this spec — everything else is direct reuse.

Sheet chrome:
- Title: the action's label (e.g. "Slack: Notify") + a small readiness-dot rendered
  next to it (reuse `ActionTile`'s existing dot component/logic — `live: true/'stub'/
  'env'` — so the panel also answers "will this actually work for my org" using the
  signal that already exists elsewhere, not a new one).
- Footer: single "Done" button (`variant="default"`) — no separate Cancel, because
  unlike `StepPanel`'s all-or-nothing step flow, canvas config edits are live-patched
  into the node's data on every keystroke (via the existing `patchNode`/`ctx.patch`
  callback plumbing already wired through every canvas node) so there's nothing to
  discard. Closing via the Sheet's own `X` or an outside click is equivalent to "Done."
- No "delete this action" control here — that already exists on the node itself via
  ReactFlow's native node deletion; out of scope for this panel.

### Full data flow, end to end

1. User drops an action node (`addAction()`) → node data is
   `{ kind: 'action', action: 'notify.in_app', config: {}, options, patch }`.
2. Node renders with the "Needs configuration" warning row (via `isActionConfigured`
   returning `false` for empty `config`).
3. User clicks the row → `ActionNode` calls a new `onConfigure` handler (passed down
   the same way `patch` already is, via node `data`) → page-level state opens
   `ActionConfigPanel` with `action`, `actionLabel`, and `config` sourced from that
   node's current `data`.
4. Inside the panel, `onChange(nextConfig)` calls `patchNode(nodeId, { config:
   nextConfig })` — the exact same `patch` callback every other canvas control
   already uses (`TriggerNode`'s trigger-type select, `ConditionNode`'s field/op/value
   inputs) — so this introduces no new state-management pattern.
5. `ActionNode` re-renders on every patch (already true today, since `patchNode`
   triggers `setNodes`), re-evaluating `isActionConfigured` live — the indicator
   flips from amber to green the moment the required field is filled, without
   needing to close the panel first.
6. On Save, `serializeCanvas()` reads `d.config ?? {}` per node — real config for
   every action node, for the first time.
7. On load (edit mode or seed-based), `deserializeCanvas()` now carries `n.config`
   into each `wfAction` node's data — reopening a saved canvas workflow shows the
   correct configured/unconfigured state per action immediately, not a false
   "needs configuration" for already-configured legacy... except: **legacy
   canvas-built workflows saved before this fix have `config: {}` for every action,
   permanently** (that's the whole bug). Reopening one of those in the fixed canvas
   will — correctly — show every action as "Needs configuration," which is accurate,
   not a regression: those workflows are and always were unconfigured. No migration
   needed; this is the fix surfacing the truth.

### Save-time guard (defensible minimum, not scope creep)

`save()`'s existing incomplete-check (`WorkflowCanvasPage.tsx:172-176`) already blocks
save when there's no trigger or no action node at all. Extend it one step further:
block save (same `setError(t('workflows.builder.incomplete'))` path, or a more
specific string — see below) when **any** action node is unconfigured per
`isActionConfigured`. This is the difference between "the UI makes it visible" and
"the UI makes it impossible to ship silently broken" — given Maya's framing that this
is the single worst functional gap in the project, a visual-only fix that still lets
a user save straight through the warning doesn't fully close it.

New locale string: `workflows.canvas.saveBlockedUnconfigured` = **"{n} action{s} still
need configuration before this workflow can be saved."** (interpolated count,
pluralized per the existing `t()` interpolation convention used elsewhere, e.g.
`workflows.card.triggerCount`). Rendered in the same error-line slot `error` already
occupies (`WorkflowCanvasPage.tsx:215`).

### Locale additions (`en.ts`, new keys under the existing `workflows.canvas.*` block)

```
workflows.canvas.action.needsConfig: "Needs configuration"
workflows.canvas.action.configured: "Configured"
workflows.canvas.action.configureAria: "Configure {action}"
workflows.canvas.saveBlockedUnconfigured: "{count} action{s} still need configuration before this workflow can be saved."
```
(Plus whatever short summary strings the per-action-type "configured" label needs —
these are mostly just formatted values, not new copy, e.g. the Slack channel name is
rendered as-is, not wrapped in a new translated sentence.)

### Component breakdown (for Elias)

| File | Change |
|---|---|
| `app/src/lib/workflowCanvas.ts` | Add `config?: Record<string, unknown>` to `CanvasNodeData`. Fix `serializeCanvas()`'s hardcoded `config: {}`. Fix `deserializeCanvas()`'s action-node branch to carry `n.config` forward. Add exported `isActionConfigured(action, config): boolean` helper. |
| `app/src/pages/WorkflowCanvasPage.tsx` | `ActionNode`: add the configured/unconfigured row + click handler. Add panel-open state (`configuringNodeId: string | null`) at the page level. Render `<ActionConfigPanel>` conditionally. Extend `save()`'s pre-save validation to check `isActionConfigured` across all action nodes. `addAction()`'s new-node data literal gains `config: {}`. |
| `app/src/components/workflow-builder/canvas/ActionConfigPanel.tsx` (new) | Sheet-based panel, three-way dispatch reusing `SimpleActionConfigForm`/`ContentCustomizationPanel`/`NotifyTargetPicker` + the two small shape-adapter functions described above. |
| `app/src/locales/en.ts` | New keys listed above. |
| Tests | New: `workflowCanvas.test.ts` cases for `isActionConfigured` (one per action-type branch) and the `serializeCanvas`/`deserializeCanvas` round-trip now carrying `config`. New: `ActionConfigPanel.test.tsx` (dispatch to the right form per action type). Updated: `WorkflowCanvasPage.test.tsx` for the new indicator states and the save-blocked-when-unconfigured path. |

---

## Issue 2 — Entry-point buttons

### Problem restated

`WorkflowsPage.tsx` lines 183-202: five header buttons. "Build Visually" (line 187)
and "New Workflow" (line 196) both call `navigate(ROUTES.WORKFLOW_BUILD)` — identical
route, identical behavior, different visual weight (outline vs. solid) and different
labels, with nothing distinguishing them. Separately, "Build Visually" vs. "Build on
Canvas" use near-identical abstract node-graph icons (`account_tree` / `schema`) and
near-identical "Build ___" copy with no supporting text.

### Decision: remove "New Workflow," not repurpose it

Considered both options from the brief:
- **Repurpose "New Workflow" into a dropdown offering all 3 build paths** — rejected.
  This would produce two different ways to reach the same three destinations
  (the dropdown, and the three already-visible individual buttons directly to its
  left), which is a worse IA than what exists today, not better — it doesn't resolve
  ambiguity, it adds a second route to the same three choices. A dropdown-of-3-things
  standing directly next to the same 3 things as individual buttons has no clear
  reason to exist.
- **Remove "New Workflow," keep "Build Visually" as the primary CTA** — adopted.
  "Build Visually" already does exactly what "New Workflow" did (same route, same
  outcome). The fix is: stop pretending they're two features. One button, promoted to
  the primary/solid visual treatment "New Workflow" currently holds, does the job of
  both.

This also directly resolves Finding V-1 (hardcoded hex on the primary CTA) as a
side effect: "New Workflow"'s `style={{ background: '#2a4bd9' }}` literal is deleted
along with the button, and "Build Visually" is restyled using the codebase's real
`Button` `variant="default"` (which correctly uses `var(--color-primary)` per
`app/CLAUDE.md`'s Brand Theme System) instead of being a second hand-rolled hex block.
Not the primary goal of this spec, but worth calling out since it's a one-line-shaped
bonus fix riding along on the same edit.

### New header button set (5 → 4)

| Button | Variant | Icon | Route | Subtext (NEW) |
|---|---|---|---|---|
| Integrations | outline (tinted, unchanged) | `cable` | `ROUTES.SETTINGS_INTEGRATIONS` | — |
| Build with Crystal | outline | `auto_awesome` | `ROUTES.WORKFLOW_NL_BUILD` | — (already unambiguous per audit) |
| **Build Visually** | **default (solid/primary)** — promoted | `account_tree` | `ROUTES.WORKFLOW_BUILD` | "Step-by-step sentence builder" |
| Build on Canvas | outline | `schema` | `ROUTES.WORKFLOW_CANVAS` | "Drag-and-drop, branching logic" |
| ~~New Workflow~~ | — removed — | — | — | — |

### Exact copy

Subtext is a small caption under each button's label, not a tooltip — the brief
requires the distinction be legible "without requiring the user to click both to find
out" or hover, so a tooltip alone is insufficient (tooltips are also already flagged
elsewhere in the audit — A-1 — as a keyboard/screen-reader gap; don't reproduce that
pattern for the one distinction that most needs to be unmissable). Render as an
11-12px `text-on-surface-variant` line directly beneath the button label, inside the
same button (two-line button label), matching the existing button's padding:

```
┌─────────────────────────────┐   ┌─────────────────────────────┐
│  🌳 Build Visually            │   │  🗺 Build on Canvas           │
│  Step-by-step sentence builder│   │  Drag-and-drop, branching logic│
└─────────────────────────────┘   └─────────────────────────────┘
```

New locale keys (`en.ts`, under the existing `workflows.*` block near
`buildVisually`/`buildOnCanvas`):

```
workflows.buildVisuallySubtext: "Step-by-step sentence builder"
workflows.buildOnCanvasSubtext: "Drag-and-drop, branching logic"
```

Also add a `title` attribute (native tooltip, zero-cost, additive not load-bearing
since the subtext is already always-visible) mirroring the subtext, so the
distinction survives even if a future redesign compresses the button to icon-only on
a narrower viewport:

```
workflows.buildVisuallyTooltip: "Build Visually — a guided, step-by-step sentence builder for simple automations"
workflows.buildOnCanvasTooltip: "Build on Canvas — a free-form drag-and-drop canvas for branching logic and conditions"
```

### Responsive note

This header row already has a known, separate mobile/tablet gap (audit's implicit
context — no explicit finding number here, but the row is dense at 4 buttons even
before this change). Two-line button labels make each button taller/wider — at the
`flex-wrap` breakpoint where these already wrap today, they'll wrap the same way, just
as slightly larger targets. Removing "New Workflow" nets one fewer button, which
partially offsets the added height. No new responsive work is being scoped here beyond
"don't make the existing wrap behavior worse" — full mobile treatment of this header
is tracked separately per the UX audit's §7 findings.

### Component breakdown (for Elias)

| File | Change |
|---|---|
| `app/src/pages/WorkflowsPage.tsx` | Delete the "New Workflow" `Button` (lines 195-202). Change "Build Visually" `Button`'s `variant` from `outline` to `default` (or omit `variant` — `default` is the `Button` component's own default per `app/CLAUDE.md`'s variant table). Add subtext `<span>`/second line + `title` to both "Build Visually" and "Build on Canvas" buttons. |
| `app/src/locales/en.ts` | Add the 4 new keys above. Leave `workflows.newWorkflowButton` — either delete it or leave it orphaned; recommend deleting since nothing else references it (confirm via grep before removal). |
| Tests | Update `WorkflowsPage.test.tsx`: remove any assertion on a "New Workflow" button/route; add assertions that only one button navigates to `ROUTES.WORKFLOW_BUILD` and that both "Build Visually"/"Build on Canvas" render their new subtext text. |

---

## Issue 3 — Canvas escape hatch drops scope/actions

### Problem restated

`WorkflowBuilderPage.tsx`'s `switchToCanvas()` (lines 411-417):

```ts
function switchToCanvas() {
  if (isEditMode) {
    navigate(ROUTES.WORKFLOW_CANVAS, { state: { workflowId } });
  } else {
    navigate(ROUTES.WORKFLOW_CANVAS, { state: { seed: { name, triggerType } } });
  }
}
```

The `isEditMode` branch is actually fine — it passes `workflowId`, and
`WorkflowCanvasPage` re-fetches the full workflow from the server on that path
(`api.getWorkflow(workflowId)`, lines 97-107), so an in-progress edit that's already
been saved once loses nothing. **The bug is specifically the create-mode branch**: a
user who has never yet saved, and has configured scope + multiple actions purely in
local sentence-builder state, loses all of it — only `name`/`triggerType` survive the
handoff.

### Confirming `serialize()`'s output is already sufficient

`WorkflowBuilderPage.tsx`'s own `serialize()` (lines 346-379) already builds:

```ts
{ nodes: Array<{ id, type: 'trigger'|'action', trigger?, action?, config }>,
  edges: Array<{ from, to }> }
```

This is exactly the `EngineNode[]`/`EngineEdge[]` shape (`workflowCanvas.ts`'s own
`EngineNode`/`EngineEdge` interfaces) that `WorkflowCanvasPage`'s
`seed?.nodes || seed?.edges` branch (lines 113-122) already consumes today, via
`deserializeCanvas(seed.nodes ?? [], seed.edges ?? [], ctx)` — this is the exact code
path Wave 9's template flow and the NL-builder-to-canvas handoff both already exercise
(confirmed live in the same file, same branch, no separate code path exists for
"seed with full nodes/edges" vs. "template seed" vs. "NL-builder seed" — they're
already unified). **No adapter is needed** — `serialize()`'s output type already
matches `CanvasSeed`'s `nodes?: EngineNode[]; edges?: EngineEdge[]` fields exactly
(confirmed: `WorkflowBuilderPage.tsx` already imports `EngineNode`/`EngineEdge` from
`../lib/workflowCanvas` at line 30, and `serialize()`'s local node/edge builder
produces object literals structurally compatible with those interfaces — the only
gap is `serialize()`'s return type isn't explicitly typed as `{ nodes: EngineNode[];
edges: EngineEdge[] }`, which is a one-line type-annotation fix, not new logic).

**One real gap, not a blocker:** `serialize()` does not include **scope**
(`scopeType`/`scopeSurveyId`/`scopeTagId`) or **cooldown** (`cooldownMinutes`) — those
are sibling fields on the `save()` payload (lines 393-396), not part of
`serialize()`'s `{ nodes, edges }` return. `CanvasSeed` (`WorkflowCanvasPage.tsx`
lines 31-38) also has no scope/cooldown fields today, and `WorkflowCanvasPage` itself
has no scope or cooldown UI/state at all (confirmed by reading the full file above —
`WorkflowCanvasPage` only tracks `name`/`description`/`triggerType`/`nodes`/`edges`/
`status`; scope and cooldown do not exist anywhere in that page's state or its save
payload).

This means **scope and cooldown cannot be round-tripped into the canvas today
regardless of the seed fix**, because the canvas builder has no field to receive them
into. This is a real, separate gap from the one this issue is scoped to fix (which is
specifically "actions are dropped" — Maya's framing and the audit's own C-1 evidence
citation both center on actions; scope is mentioned in the finding's prose but the
canvas has no scope concept at all, so "carrying scope over" isn't a seed-shape
problem, it's a missing-feature problem in the destination page).

**Recommendation, scoped honestly:**
- **Fix now (this spec):** carry `nodes`/`edges` (i.e., trigger + all actions +
  their configs) fully into the canvas seed — this is the "full seed pattern" the
  brief asks for, and it's the part that's a pure plumbing fix with an already-proven
  pattern.
- **Do not silently drop scope/cooldown with no signal:** since the canvas has nowhere
  to put them, `switchToCanvas()` should warn before navigating if the user has
  configured a non-default scope (`scope.scopeType !== 'org'`) or a non-default
  cooldown, rather than silently discarding them as today. A native `window.confirm`-
  style guard is beneath this codebase's bar (no other flow in this feature uses
  browser-native confirms) — instead, reuse the existing pattern for "this action has
  a consequence, confirm before proceeding": a small inline warning line rendered next
  to the "Advanced: Branching Canvas" link itself, plus a same-page confirm (a tiny
  `Dialog`, already an available shadcn primitive) that fires only when scope !== org
  or cooldown is non-default. Copy: **"Switching to the canvas builder will carry over
  your trigger and actions, but scope and cooldown settings aren't supported there yet
  and won't be carried over. Continue?"** This is a narrower, honest fix — it doesn't
  pretend to solve the scope/cooldown gap, it just stops the product from lying about
  what's being preserved (the current behavior's real sin isn't losing scope, it's
  losing it *silently*).
- **Track separately, not in this spec's build scope:** adding scope/cooldown fields
  to the canvas builder itself (a materially bigger scope than this fix — new UI,
  new save-payload fields, new engine-side consideration for whether graph-mode
  workflows even support cooldown the same way linear ones do) — flag for a future
  wave, don't fold into Elias's build here.

### Exact fix to `switchToCanvas()`

```ts
function switchToCanvas() {
  if (isEditMode) {
    navigate(ROUTES.WORKFLOW_CANVAS, { state: { workflowId } });
    return;
  }
  const hasNonDefaultScope = scope.scopeType !== 'org';
  // 60 is the useState initializer's own default (WorkflowBuilderPage.tsx:143,
  // `useState<number | null>(60)`) — no named constant exists today; either
  // reuse that literal or, cleaner, hoist it into a small shared constant while
  // touching this code, since it'd otherwise be a second unnamed "60" nearby.
  const hasNonDefaultCooldown = cooldownMinutes !== 60;
  if (hasNonDefaultScope || hasNonDefaultCooldown) {
    setShowCanvasSwitchWarning(true); // opens the small confirm Dialog described above
    return;
  }
  proceedToCanvas();
}

function proceedToCanvas() {
  const { nodes, edges } = serialize();
  navigate(ROUTES.WORKFLOW_CANVAS, {
    state: { seed: { name, description, triggerType, nodes, edges } },
  });
}
```

The confirm `Dialog`'s "Continue" button calls `proceedToCanvas()`; "Cancel" just
closes the dialog with no navigation — matching the existing Delete-confirmation
`Dialog` pattern already used elsewhere on `WorkflowsPage.tsx`, so no new modal
interaction pattern is introduced.

**Why `description` is added to the seed too, not just `nodes`/`edges`:** `CanvasSeed`
already has an (unused-by-this-branch) `description?: string` field, and
`WorkflowBuilderPage` already tracks a `description` state value that today's buggy
`switchToCanvas()` also drops. Since we're touching this function anyway and the field
already exists on both ends, carrying it over is a zero-cost extension of the same
fix, not scope creep — leaving it behind would be reintroducing a smaller version of
the exact bug this issue is about.

### Full data flow, end to end

1. User is in the sentence builder, create mode, has picked a trigger, added 2
   actions (say `notify.slack` with a channel configured, and `jira.create_issue`
   with a project key), and left scope at the default (`org`).
2. User clicks "Advanced: Branching Canvas."
3. `switchToCanvas()` checks scope/cooldown — both default, no warning needed — and
   calls `proceedToCanvas()` directly.
4. `serialize()` produces `{ nodes: [trigger, action_0 (slack, configured), action_1
   (jira, configured)], edges: [...] }` — the same object `save()` would have sent to
   the API had the user saved instead of switching.
5. `navigate(ROUTES.WORKFLOW_CANVAS, { state: { seed: { name, description,
   triggerType, nodes, edges } } })`.
6. `WorkflowCanvasPage`'s existing `seed?.nodes || seed?.edges` branch (already
   built, no change needed there) calls `deserializeCanvas(seed.nodes, seed.edges,
   ctx)` — with Issue 1's fix in place, this now also correctly carries each action's
   `config` into its node's data, so the two actions arrive in the canvas already
   showing the **green "Configured"** state from Issue 1, not "Needs configuration."
   (Without Issue 1's fix landing first/alongside, they'd still arrive with the
   right trigger/action-type selection but `config` would still be dropped by the
   *old* `deserializeCanvas()` — this is why Issue 1 and Issue 3 should ship together,
   or Issue 1 first: Issue 3's fix is only fully honest once Issue 1 makes config
   survive the round-trip.)
7. User is now in the canvas with their full sentence-builder state intact, free to
   add a condition node and branch — the actual reason they clicked through in the
   first place.

### Sequencing dependency (flag for Elias/orchestrator)

**Issue 3 depends on Issue 1 for full correctness.** Fixing only Issue 3 (seed
carries `config` in `nodes`) without Issue 1 means the config arrives in
`WorkflowCanvasPage`'s local seed data correctly, but `deserializeCanvas()` (today)
still drops `n.config` when building each `wfAction` node's `data`, and
`serializeCanvas()` (today) still hardcodes `config: {}` on the next save — so the
carried-over config would be visible nowhere and would still be discarded the moment
the user saves from the canvas. **Recommend building Issue 1 first, or both in the
same PR** — Issue 3 in isolation would look fixed (the crash/data-loss at
navigation-time is gone) but silently regress right back to Issue 1's bug one save
later.

### Component breakdown (for Elias)

| File | Change |
|---|---|
| `app/src/pages/WorkflowBuilderPage.tsx` | Rewrite `switchToCanvas()`'s create-mode branch per above. Add `showCanvasSwitchWarning` state + a small confirm `Dialog` (reuse the existing Delete-confirmation dialog's structure/copy pattern). Give `serialize()` an explicit return type of `{ nodes: EngineNode[]; edges: EngineEdge[] }` (already structurally compatible, just formalize it). |
| `app/src/pages/WorkflowCanvasPage.tsx` | No change needed for the seed-consumption path itself (already handles `seed.nodes`/`seed.edges` generically) — only benefits from Issue 1's `deserializeCanvas()` fix landing alongside. |
| `app/src/locales/en.ts` | New keys: `workflows.builder.sentence.canvasSwitchWarning.title`, `...body` (copy above), `...continue`, `...cancel` (or reuse `workflows.builder.sentence.stepPanel.cancel`-style generic Cancel string if one already fits — check before adding a duplicate). |
| Tests | Update `WorkflowBuilderPage.test.tsx`: `switchToCanvas` create-mode test should assert the seed now contains `nodes`/`edges` matching `serialize()`'s output, not just `name`/`triggerType`. New test: non-default scope triggers the warning dialog and blocks immediate navigation; confirming it navigates with the same full seed. |

---

## Cross-issue notes

- **Build order recommendation:** Issue 1 first (it's the load-bearing fix — nothing
  else matters if config still can't survive a save), then Issue 3 (depends on
  Issue 1's `deserializeCanvas()` fix for full correctness), then Issue 2 (fully
  independent, can land in parallel with either).
- **Issue 1 and Issue 3 together close the loop this audit was most worried about:**
  today, the canvas is both (a) the only way to build branching logic and (b)
  unconditionally broken for every action. After this spec, it's also (c) reachable
  with a full, already-configured sentence-builder workflow instead of a blank
  restart, which materially changes how often users hit the canvas at all — most
  users who only need branching for one condition, having already configured
  everything else in the sentence builder, will land in a canvas that already has
  real, visibly-configured actions waiting for one condition node, not an empty
  canvas requiring them to redo everything from scratch AND re-discover that the
  action fields don't exist yet (today's compounding failure).
