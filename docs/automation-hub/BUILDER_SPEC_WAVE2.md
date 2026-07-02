# Xperiq Actions — Builder Wave 2 Spec: Edit Mode + NL Builder

**Author:** Rohan Desai (Principal UX Designer, Builder Experiences)
**Status:** Ready for engineering handoff (Elias Park)
**Scope:** Two gaps only — (1) edit-mode for the two existing builders, (2) a new NL builder UI against a placeholder backend contract. This is NOT a canvas rewrite; `WorkflowCanvasPage` (reactflow) and `WorkflowBuilderPage` (linear form) already exist and stay as-is except where noted.
**No Figma access this cycle** — specs below are written to engineering-handoff precision (component tree, state shape, exact copy, numbered interaction sequences, Framer Motion timing) in lieu of Figma frames.

---

## 0. Before you build: a backend gap that blocks Spec 1

Read this before touching `WorkflowBuilderPage.tsx` or `WorkflowCanvasPage.tsx`.

`PUT /api/workflows/:id` (`backend/src/routes/workflows.ts`) and `updateWorkflowSchema`
(`backend/src/schemas/workflows.ts`) currently only accept `name`, `condition`, `action`,
`status`. They do **not** accept `description`, `triggerType`, `nodes`, or `edges` — the
exact fields both builders need to save an edit. `createWorkflowSchema` (used by `POST /`)
already accepts all of these; `updateWorkflowSchema` is simply missing the graph fields
that were added to create but never mirrored to update.

There is also **no `GET /api/workflows/:id`** route — only `GET /` (list, all workflows for
the org) and `GET /:id/executions` (run history). Edit mode needs to fetch one workflow's
current `nodes`/`edges`/`name`/`description`/`trigger_type` to pre-populate a builder.

**This spec assumes both are added as part of Wave 2, owned by whoever picks up the
backend side of this wave (not written by Rohan — flagging so it's not missed):**
1. `GET /api/workflows/:id` → `{ workflow: Workflow }` (404 if not found or not in org), same
   `requirePermission('workflows:manage')` gate as the rest of the router.
2. `updateWorkflowSchema` extended to mirror `createWorkflowSchema`'s optional
   `description` / `triggerType` / `nodes` / `edges` fields; the `PUT /:id` handler's
   `sets`/`vals` builder extended to write them (same `if (x !== undefined)` pattern
   already used for `name`/`condition`/`action`/`status`).

Everything below assumes these two exist. If they slip, edit-mode cannot ship — the
frontend has functionally nothing to fetch or save against.

---

## 1. Edit mode for both builders

### 1.1 Decision: editing always reopens the builder that shape implies — no builder picker

A workflow's `nodes`/`edges` are either a straight line (trigger → optional single
condition block → ordered actions, no branches) or a real graph (any node with more
than one outgoing edge, i.e. a condition with both `true` and `false` handles wired,
or any node with >1 incoming edge). `hasBranches()` in `app/src/lib/workflowCanvas.ts`
already computes exactly this signal from `edges`.

**Rule:** on Edit, inspect the fetched workflow's `edges`. If `hasBranches(edges)` is
true, or the node list contains more than one `condition` node, route to
`WorkflowCanvasPage`. Otherwise route to `WorkflowBuilderPage`.

Why this and not a picker or a "always canvas" default:
- A picker adds a decision the user didn't ask to make — they clicked "Edit," not
  "choose an editor." Every extra click in an edit path is a tax on the most frequent
  action a returning user takes.
- Defaulting everything to canvas is simpler to state but actively regresses the
  common case: most workflows created via the linear builder or a template are
  straight lines, and reactflow's pan/zoom/minimap chrome is worse for editing a
  4-node line than the linear form's vertical scroll. Zapier made this exact mistake
  early in the branching-canvas rewrite — funneling simple single-path Zaps into the
  branching editor measurably hurt edit-completion time for the 80% case that had no
  branches. Route by shape, not by blanket policy.
- The shape check is cheap (pure function, already exists) and deterministic — the
  user always lands somewhere consistent for a given workflow, so "which editor did
  this open in last time" is never a surprise.
- A workflow created in the canvas but left branch-free (e.g. one trigger, one
  condition with only its `true` edge wired, two actions) is indistinguishable in
  shape from a linear-builder workflow — and should be. It opens in the linear
  builder. If the user adds a second branch there, saving is still safe (see 1.4);
  they simply can't add the branch itself until they open the canvas. To make that
  path discoverable, the linear builder's `NodeCard` for conditions gets a persistent
  footer link (not a modal, not a redirect-on-click) — see 1.5.

**Where this routes from:** `WorkflowsPage.tsx`'s existing Edit button
(`navigate(ROUTES.WORKFLOW_BUILD, { state: { workflowId: wf.id } })`, line ~358)
already passes `workflowId` in router state but always targets `WORKFLOW_BUILD`
(the linear builder). This must change to a shared resolver:

```ts
// app/src/lib/workflowEditRoute.ts (new, pure, unit-testable — mirrors workflowCanvas.ts's style)
import { ROUTES } from '../constants/routes';
import { hasBranches } from './workflowCanvas';
import type { EngineEdge, EngineNode } from './workflowCanvas';

export function resolveEditRoute(nodes: EngineNode[], edges: EngineEdge[]): string {
  const conditionCount = nodes.filter((n) => n.type === 'condition').length;
  if (hasBranches(edges as any) || conditionCount > 1) return ROUTES.WORKFLOW_CANVAS;
  return ROUTES.WORKFLOW_BUILD;
}
```

`WorkflowsPage`'s Edit button becomes async: fetch `GET /api/workflows/:id` (or reuse
the already-loaded row from the list — the list response already includes
`nodes`/`edges`, so **no extra fetch is needed on the list page**; only the builder
itself needs to (re-)fetch, since the user may land on `/app/workflows/build` or
`/app/workflows/canvas` directly via a bookmarked/shared URL where no list data is in
memory). So: `WorkflowsPage` computes the target route from data it already has and
navigates with `{ state: { workflowId: wf.id } }` to whichever route
`resolveEditRoute` returns.

### 1.2 What changes on arrival in edit mode — `WorkflowBuilderPage`

**New state:**
```ts
const location = useLocation();
const workflowId = (location.state as { workflowId?: string } | null)?.workflowId;
const isEditMode = Boolean(workflowId);

const [loadingWorkflow, setLoadingWorkflow] = useState(isEditMode);
const [loadError, setLoadError] = useState<string | null>(null);
const [description, setDescription] = useState(''); // new field, not in current builder — see 1.4 note
```

**Fetch-on-mount effect** (separate from the existing registry-fetch effect — do not
conflate loading states, since registry can succeed while the workflow fetch 404s):
```ts
useEffect(() => {
  if (!workflowId) return;
  setLoadingWorkflow(true);
  api.getWorkflow(workflowId) // new client method → GET /api/workflows/:id
    .then(({ workflow }) => {
      setName(workflow.name);
      setDescription(workflow.description ?? '');
      setTriggerType(workflow.trigger_type ?? '');
      // Decompose nodes/edges back into the linear builder's flat shape.
      const condNode = workflow.nodes?.find((n) => n.type === 'condition');
      setRules(condNode?.conditions?.rules?.map((r) => ({ field: r.field ?? '', op: r.op ?? '', value: String(r.value ?? '') })) ?? []);
      setActions(workflow.nodes?.filter((n) => n.type === 'action').map((n) => ({ action: n.action ?? '' })) ?? []);
    })
    .catch(() => setLoadError(t('workflows.builder.loadError')))
    .finally(() => setLoadingWorkflow(false));
}, [workflowId, api]);
```

**Pre-filled fields:** `name` input, `triggerType` select, `rules` list, `actions`
list — all pre-populated from the effect above, using the exact same `NodeCard`
components already in the file. No new visual components needed for the form itself.

**New field this wave adds — description.** Neither builder currently exposes a
description input even though the schema and `WorkflowsPage` card both support/render
`workflow.description`. Add a single-line `Input` under the name field in both
builders (`workflows.builder.descriptionLabel` / `descriptionPlaceholder`), optional,
max 2000 chars per the Zod schema. This is a small, low-risk scope addition — flagging
it explicitly rather than silently slipping it in, since it's not literally "edit
mode" but edit mode is what surfaces the gap (you can't edit a description field that
was never collectable at create time).

**Loading state:** while `loadingWorkflow` is true, replace the entire card stack
(everything inside the `motion.div` at line 80 of `WorkflowBuilderPage.tsx`) with a
skeleton: three `Card` shells at the same heights as the trigger/condition/action
`NodeCard`s, each containing a `div` with the existing `skeleton` CSS class (already
used elsewhere per `app/CLAUDE.md`'s "CSS Keyframe Animations" section — no new
skeleton primitive needed). The page header, breadcrumb, and Save button render
immediately (Save is `disabled` while loading) — do not blank the whole page, since
the breadcrumb trail is how the user confirms which workflow they navigated to.

**Error state (workflow not found / fetch failed):** replace the card stack with a
single centered `Card`: an `error_outline` `Icon`, the string
`workflows.builder.notFoundHeading` ("Workflow not found"), body copy
`workflows.builder.notFoundBody` ("It may have been deleted, or you may not have
access to it."), and a `Button` labeled `workflows.builder.backToList` ("Back to
Workflows") that navigates to `ROUTES.WORKFLOWS`. Distinguish 404 from a network/500
error only in the body copy (`workflows.builder.notFoundBody` vs
`workflows.builder.loadErrorBody`, "Something went wrong loading this workflow. Try
again.") — the visual treatment is identical; do not build two different empty-state
components for this.

**Save action differs:**
```ts
async function save() {
  // ...existing validation...
  const payload = { name, description, triggerType, nodes, edges, status: 'draft' };
  try {
    if (isEditMode) {
      await api.updateWorkflow(workflowId!, payload); // PUT /api/workflows/:id
    } else {
      await api.createGraphWorkflow(payload); // POST /api/workflows
    }
    invalidate('workflows'); // NEW — see note below
    navigate(ROUTES.WORKFLOWS);
  } catch (err) { /* unchanged */ }
}
```

**DataBus note:** neither builder currently calls `invalidate('workflows')` after
save — they rely on `WorkflowsPage` re-mounting on navigation back to `/app/workflows`
to pick up fresh data (which works today only because navigation always leaves the
builder page entirely and remounts the list). This is fragile the moment any other
open surface (e.g. a Crystal panel showing workflow state, or a second browser tab)
needs to reflect the edit — add the `invalidate('workflows')` call to both builders'
save paths now while touching this code, per `app/CLAUDE.md`'s DataBus rule ("any
new... mutation... must invalidate").

**Save button copy changes in edit mode:** `workflows.builder.save` ("Save workflow")
→ `workflows.builder.saveChanges` ("Save changes") when `isEditMode`. Page title and
subtitle also change: `workflows.builder.editTitle` ("Edit Workflow") /
`workflows.builder.editSubtitle` ("Update the trigger, conditions, and actions for
{name}") vs the existing create-mode strings. Breadcrumb's second crumb label follows
the same title.

### 1.3 What changes on arrival in edit mode — `WorkflowCanvasPage`

Same `workflowId`/`isEditMode`/`loadingWorkflow`/`loadError` state shape as 1.2.

**Fetch-on-mount effect** replaces the "seed a trigger node so the canvas isn't
empty" branch in the existing registry-loading effect (`WorkflowCanvasPage.tsx` lines
44–57) — in edit mode, seed from the fetched workflow instead of a blank trigger:

```ts
useEffect(() => {
  api.getWorkflowRegistry().then((r) => {
    setTriggers(r.triggers as Trigger[]);
    setActionDefs(r.actions as ActionDef[]);
    setOperators(r.conditionOperators);

    if (workflowId) {
      setLoadingWorkflow(true);
      api.getWorkflow(workflowId).then(({ workflow }) => {
        setName(workflow.name);
        setDescription(workflow.description ?? '');
        const { nodes: rfNodes, edges: rfEdges } = deserializeCanvas(workflow.nodes ?? [], workflow.edges ?? [], {
          triggers: r.triggers, actionDefs: r.actions, operators: r.conditionOperators, patch: patchNode,
        });
        setNodes(rfNodes);
        setEdges(rfEdges);
      }).catch(() => setLoadError(t('workflows.canvas.loadError')))
        .finally(() => setLoadingWorkflow(false));
    } else {
      setNodes([{ id: 'trigger', type: 'wfTrigger', position: { x: 80, y: 160 },
        data: { kind: 'trigger', triggerType: (r.triggers as Trigger[])[0]?.type, options: r.triggers, patch: patchNode } } as Node<CanvasNodeData>]);
    }
  }).catch(() => {});
}, [api, workflowId]);
```

**New pure helper — `deserializeCanvas`** (add to `app/src/lib/workflowCanvas.ts`,
the inverse of the existing `serializeCanvas`, same unit-testable style, no reactflow
rendering required to test it):

```ts
// Inverse of serializeCanvas. Positions are not persisted by the engine (EngineNode
// has no x/y) so this lays nodes out left-to-right by graph depth (BFS from the
// trigger), 280px column spacing / 120px row spacing — matches the manual spacing
// already used by addCondition/addAction's x offsets (360/660) in WorkflowCanvasPage.
export function deserializeCanvas(
  nodes: EngineNode[], edges: EngineEdge[],
  ctx: { triggers: unknown[]; actionDefs: unknown[]; operators: string[]; patch: (id: string, p: Partial<CanvasNodeData>) => void }
): { nodes: Node<CanvasNodeData>[]; edges: Edge[] } { /* ... */ }
```

Elias: the exact BFS/layout algorithm is an implementation detail I'm leaving to you
— the contract that matters is (a) it's a pure function taking engine shape + options
+ patch callback and returning reactflow-ready `nodes`/`edges`, (b) it never throws on
malformed input (missing node, dangling edge) — worst case, drop the unresolvable
edge and log, don't crash the canvas on load, since a manually-edited-in-Postgres or
future-schema-version workflow should degrade to "some nodes render, no crash" not a
blank error page.

**Loading state:** while `loadingWorkflow`, render the same 70vh canvas container but
with a centered spinner (`workflows.canvas.loadingWorkflow`, "Loading workflow…") in
place of `<ReactFlow>` — do not mount `ReactFlow` with empty nodes and then pop content
in, since reactflow's `fitView` runs on mount and will zoom to a single default node
before snapping to the real graph a moment later, which reads as a glitch.

**Error state:** identical treatment to 1.2 (same copy keys, `workflows.canvas.`
namespace instead of `workflows.builder.`), rendered in place of the canvas container.

**Save action:** same `isEditMode` branch as 1.2 — `api.updateWorkflow(workflowId, {...})`
vs `api.createGraphWorkflow({...})`, same `invalidate('workflows')` addition, same
button-copy swap (`workflows.builder.save` → `workflows.builder.saveChanges`, reused
across both builders since it's the same action).

### 1.4 Save-shape safety (why 1.1's routing choice doesn't create data loss)

Because a straight-line workflow can be edited in the linear builder and a
branching workflow can only be edited in the canvas, there's no path where the
linear builder is asked to save a graph it can't represent — it only ever loads
workflows `resolveEditRoute` already determined were representable as a line, and it
only ever constructs linear node/edge arrays on save (unchanged from today's create
behavior). No merge/reconciliation logic is needed. This is the second reason 1.1's
per-shape routing beats a single default: a "canvas-only" default would still need
the linear builder to keep existing for create-time simplicity, and now you'd need
logic to detect "is this still safe to hand to the simple builder" anyway — shape
routing does that check once, on entry, instead of defensively on every save.

### 1.5 Cross-link from linear builder to canvas (discoverability for the branching case)

Add a persistent, non-modal footer line under the condition `NodeCard` in
`WorkflowBuilderPage`:

> Need to branch into different actions depending on the result?
> **Switch to canvas builder →**

Copy key `workflows.builder.needBranching` /
`workflows.builder.switchToCanvas`. Clicking navigates to `ROUTES.WORKFLOW_CANVAS`
with `{ state: { workflowId } }` if in edit mode (re-running `resolveEditRoute`'s
logic isn't needed here — the user explicitly asked for canvas), or with no state in
create mode, in which case the canvas page's existing "seed a blank trigger" behavior
applies but should additionally carry over whatever `name`/`triggerType`/`rules` the
user had already entered in the linear builder — pass `{ state: { seed: { name,
triggerType, rules } } }` and have `WorkflowCanvasPage` consume `seed` the same way it
will consume a fetched workflow (reuse `deserializeCanvas`-adjacent logic, or simpler:
build one trigger node + one condition node from `seed` directly, since `seed` never
has actions or branches to lay out). This avoids the single worst failure mode of a
"switch builder" link — losing what the user already typed.

---

## 2. NL Builder

### 2.1 Placeholder API contract (for Amara — Wave 3)

This is the target Amara's CrystalOS-side NL parser should implement. Proposing a
concrete shape now so Wave 3 doesn't invent one independently and so this UI has
something real to code against with a mock in the interim.

```
POST /api/workflows/parse-nl
Request:  { description: string }               // raw user text, 1–1000 chars
Response 200:
{
  name: string,                                  // Crystal-suggested workflow name
  description: string,                           // Crystal's own restatement (may differ from name)
  triggerType: string,                            // must be one of workflowRegistry's TRIGGERS[].type
  nodes: EngineNode[],                            // same shape serializeCanvas() already produces
  edges: EngineEdge[],
  confidence: number,                             // 0–1
  warnings: string[],                             // human-readable, e.g. "Assumed Slack as the notification channel"
}
Response 422 (unparseable):
{ error: 'unparseable', message: string, suggestions: string[] }  // suggestions = example prompts to try instead
Response 504 (LLM timeout): standard error envelope, no special shape
```

Design rationale for the shape: `nodes`/`edges` reuse the exact `EngineNode`/
`EngineEdge` types already defined in `app/src/lib/workflowCanvas.ts` — this is the
one contract both the backend (Amara + whoever owns the Express route) and frontend
need to agree on, and it already exists and is already tested (`serializeCanvas`).
Do not invent a parallel "WorkflowSpec" shape distinct from what the canvas already
serializes to — that would mean writing and maintaining a second converter with no
benefit. `confidence` and `warnings` are the two fields the frontend's confirm-card
and low-confidence state (2.5) depend on; both are required, not optional, because
"Crystal proposes, the app executes" (root `CLAUDE.md`) means the UI must always be
able to render a confidence signal, never silently assume high confidence.

**Backend routing note (not Rohan's to build, flagging for whoever wires the Express
route):** per root `CLAUDE.md`'s architecture pattern, this Express endpoint is a thin
proxy to CrystalOS via `agentsClient.ts` (a new typed function, e.g.
`agentsClient.parseWorkflowNL(description)`), not a direct CrystalOS call from the
frontend. The frontend never talks to CrystalOS directly.

### 2.2 Component breakdown

```
WorkflowNLBuilderPage (new file: app/src/pages/WorkflowNLBuilderPage.tsx)
├── PageHeader (title: "Describe Your Workflow", subtitle per 2.3)
├── NLInputPanel
│   ├── Textarea (the description input)
│   ├── ExamplePromptChips (3–4 clickable example strings, fill the textarea on click)
│   └── Button "Generate Workflow" (disabled while empty or while thinking)
├── ThinkingState (shown while POST is in-flight — replaces NLInputPanel's result area, input stays visible/disabled)
├── NLConfirmCard (shown on 200 response — see 2.4)
│   ├── TriggerSummaryRow
│   ├── ConditionSummaryRow[] (0..n)
│   ├── ActionSummaryRow[] (1..n)
│   ├── WarningsList (if warnings.length > 0)
│   ├── ConfidenceBadge
│   └── Footer: [Edit in canvas] [Discard] [Create Workflow]
└── LowConfidenceOrErrorState (shown on 422, or 200 with confidence < threshold — see 2.5)
```

Route: add `WORKFLOW_NL_BUILD: '/app/workflows/build/nl'` to `app/src/constants/routes.ts`.
Entry point: `WorkflowsPage`'s header action row gets a third button, matching the
existing `Build Visually` / `Build on Canvas` pair:
`<Button variant="outline" onClick={() => navigate(ROUTES.WORKFLOW_NL_BUILD)}><Icon name="auto_awesome" .../>{t('workflows.buildWithCrystal')}</Button>`
— placed first (leftmost) of the three, since it's the lowest-effort path and should
be the path most users try first, matching the "propose, then let the user refine"
philosophy: NL → confirm-card → (optional) canvas escape hatch is a strict superset
of what the canvas button offers cold.

### 2.3 Input UI

**Copy (add to `workflows` namespace in `app/src/locales/en.ts`):**
```
nlBuilder: {
  title: 'Describe Your Workflow',
  subtitle: 'Tell Crystal what you want to happen, in plain English',
  placeholder: 'e.g. "When NPS drops below 30, notify the support team on Slack and create a Jira ticket"',
  examplesLabel: 'Try an example',
  examples: [
    'When a response mentions "cancel" or "refund", create a Zendesk ticket',
    'Every Monday at 9am, email the team a summary of last week\'s responses',
    'When NPS drops below 30, send a Slack message to #customer-success',
  ],
  generateButton: 'Generate Workflow',
  thinkingLabel: 'Crystal is building your workflow…',
  thinkingSubtext: 'Reading your description and matching it to triggers and actions',
}
```

**Layout:** a single centered `Card` (max-w-2xl, matching the linear builder's
max-w-3xl page shell but narrower for a single-focus task), containing:
1. `Textarea` (shadcn primitive — `textarea` is already listed in `app/CLAUDE.md`'s
   "Available shadcn Primitives," so this is a normal `@/components/ui/textarea`
   import, no new primitive needed), 4 rows, autofocus on page load.
2. Below it, `ExamplePromptChips`: 3 small `Badge`-styled buttons (not real `Badge`
   components — clickable, so plain `button` elements styled with the same visual
   language: `rounded-full border border-border px-3 py-1.5 text-xs
   text-on-surface-variant hover:border-primary hover:text-primary transition-colors`),
   each containing one truncated example string (max ~50 chars visible, full string in
   a `title` attribute). Clicking one sets the textarea's value to that full example
   string and focuses the textarea — it does not auto-submit, since the user should be
   able to tweak the example before generating (a common real usage pattern: start
   from an example, change one number).
3. `Button` "Generate Workflow", `disabled={!description.trim() || thinking}`.

### 2.4 Interaction sequence (numbered)

1. User arrives at `/app/workflows/build/nl`. Textarea is empty and focused. Three
   example chips are visible below it.
2. User either types a description or clicks an example chip (which fills the
   textarea, per 2.3.2).
3. User clicks "Generate Workflow" (or presses `Cmd/Ctrl+Enter` in the textarea — a
   keyboard shortcut worth supporting since this is a single-purpose page with one
   primary action).
4. UI enters **thinking state** (2.4a below). The textarea and example chips become
   `disabled` (not hidden — the user should still see what they asked for while
   waiting) and the Generate button shows a spinner + `thinkingLabel` text in place of
   its normal label.
5. On success (200, `confidence >= 0.6` — see 2.5 for the threshold rationale): the
   thinking state cross-fades out and the **confirm-card** (2.4b) animates in using
   the Crystal fill animation (2.6).
6. On success with low confidence (200, `confidence < 0.6`), or on 422: show the
   **low-confidence/error state** (2.5) instead of the confirm-card.
7. From the confirm-card, the user has three explicit choices — **no implicit
   confirm**, per root `CLAUDE.md`'s "only mutates on explicit user confirm":
   - **Discard** — clears the result, returns to step 1 with the textarea still
     containing the original description (not cleared — the user may want to tweak
     wording and retry rather than retype from scratch).
   - **Edit in canvas** — navigates to `ROUTES.WORKFLOW_CANVAS` with
     `{ state: { seed: { name, description, triggerType, nodes, edges } } }`,
     reusing the exact same `seed`-consumption path described in 1.5, extended to
     accept full node/edge arrays (not just the partial trigger+condition seed from
     1.5 — `WorkflowCanvasPage` should treat a `seed` with `nodes`/`edges` present as
     equivalent to an edit-mode fetch result and run it through the same
     `deserializeCanvas` path from 1.3). This is the "edit before creating" escape
     hatch called for in the brief — it hands off to the real canvas builder rather
     than trying to build editing affordances into the confirm-card itself.
   - **Create Workflow** — calls `api.createGraphWorkflow({ name, description,
     triggerType, nodes, edges, status: 'draft' })` (the same existing method both
     other builders already use — no new create endpoint needed), then
     `invalidate('workflows')`, then navigates to `ROUTES.WORKFLOWS`. Workflows
     created via NL always land in `draft` status, same as both other builders —
     Crystal proposing a workflow is not the same as the user having verified and
     activated it; requiring an explicit "Resume" toggle on the list page afterward
     is one more deliberate confirmation before anything can actually fire.

**2.4a — Thinking state, precise treatment:**
Not a generic spinner. Show a vertically-stacked skeleton of the three row types the
confirm-card will eventually show (one `TriggerSummaryRow`-shaped skeleton bar, 0–1
`ConditionSummaryRow`-shaped bars at 60% opacity to signal "maybe," 1–2
`ActionSummaryRow`-shaped bars), each using the existing `skeleton` CSS keyframe
class. This previews the shape of what's coming rather than showing an
undifferentiated spinner, so the wait feels purposeful. Cap the thinking state's
displayed duration expectation with `thinkingSubtext` — if the request is still
pending past 8 seconds, swap `thinkingSubtext` to
`workflows.nlBuilder.thinkingSlow` ("Still working — complex requests can take a
little longer").

**2.4b — Confirm-card structure (human-readable, not raw JSON):**

```
┌─────────────────────────────────────────────────────┐
│  ✨ Here's what Crystal understood                    │  ← icon + workflows.nlBuilder.confirmHeading
│                                                       │
│  [name, editable inline as a text input, not static] │
│                                                       │
│  ⚡ WHEN   Score dropped: NPS                          │  TriggerSummaryRow
│  🔶 IF     nps  <  30                                 │  ConditionSummaryRow (repeat per rule)
│  ✅ THEN   1. Send Slack message to #customer-success │  ActionSummaryRow (numbered, repeat per action)
│            2. Create Jira issue                       │
│                                                       │
│  ⚠ Crystal assumed:                                   │  WarningsList (only if warnings.length > 0)
│    • Slack channel #customer-success (not specified)  │
│                                                       │
│  Confidence: ●●●●○ High                               │  ConfidenceBadge
│                                                       │
│  [Edit in canvas]      [Discard]   [Create Workflow]  │
└─────────────────────────────────────────────────────┘
```

This deliberately mirrors the visual grammar `WorkflowBuilderPage`'s `NodeCard`
already established (colored icon chip + step label + title, `#2a4bd9` trigger /
`#d97706` condition / `#059669` action) so a user who has seen either existing
builder immediately recognizes the row types — no new color language to learn.
`TriggerSummaryRow`/`ConditionSummaryRow`/`ActionSummaryRow` render the *label* text
from the registry (`triggers.find(t => t.type === triggerType)?.label`, same pattern
`WorkflowsPage`'s `triggerLabel()` helper already uses), never the raw `type` string
or raw JSON — this is the "human-readable, not raw JSON" requirement from the brief.

The workflow name is the **one editable field on the card** (a plain inline text
input, not a modal) — Crystal's suggested name is a starting point, not a
commitment, and renaming shouldn't require dropping into the canvas.

**ConfidenceBadge treatment:** three tiers, not a raw percentage (a bare "73%" means
nothing to a non-technical user evaluating whether to trust it):
- `>= 0.85` → `workflows.nlBuilder.confidenceHigh` ("High"), 4-5 filled dots, success-green dot color
- `0.6–0.84` → `workflows.nlBuilder.confidenceMedium` ("Medium — review before enabling"), 2-3 filled dots, warning-amber
- `< 0.6` → never reaches the confirm-card (routed to 2.5 instead)

### 2.5 Error / low-confidence state

Two triggers, one shared component (`LowConfidenceOrErrorState`), because both are
fundamentally "Crystal couldn't give you something trustworthy enough to confirm" —
differentiated only by copy and whether a partial result exists underneath:

**A. Low confidence (200 response, `confidence < 0.6`):**
The parse *did* produce a structure, but it's not shown as a confirm-card — showing a
low-confidence result as if it were ready-to-confirm risks the user clicking
"Create" on something wrong just because it's presented in the same trusted format
as a high-confidence result. Instead:
```
⚠ Crystal wasn't fully sure about this one
Here's a rough idea of what it understood, but double-check it in the canvas builder
before creating it.

[the same TriggerSummaryRow/ConditionSummaryRow/ActionSummaryRow rows, rendered
 at reduced opacity (0.7) with a dashed card border instead of solid, to visually
 signal "tentative" without a second component]

[Edit in canvas]   [Try rewording instead]
```
Note: **no "Create Workflow" button in the low-confidence state.** The only paths
forward are refining in canvas (with the tentative result seeded, same `seed`
mechanism as 2.4/1.5) or rewording the prompt (clears state, returns to input with
text preserved, same as Discard). This is a deliberate guardrail, not an oversight —
a structured-but-wrong workflow that's one click from going live is a worse failure
mode than making the user take one more step.

**B. Unparseable (422 response):**
```
✕ Crystal couldn't turn that into a workflow
{message from the API response}

Try being more specific about:
• What should trigger it (a survey response, a score, a schedule)
• What should happen (send a message, create a ticket, tag something)

Or try one of these:
[example chip] [example chip] [example chip]
```
The example chips here are the same `ExamplePromptChips` component from 2.3, re-shown
inline so the user doesn't have to scroll back up — clicking one clears the error
state, fills the textarea, and returns to the input-ready state (does not
auto-submit, same rationale as 2.3).

**C. Timeout (504, or client-side timeout — recommend a 20s client-side abort via
`AbortSignal.timeout(20000)` on the fetch, matching the pattern already established
in `WORKFLOW_CONNECTOR_TIMEOUT_MS` per the TRACKER's Wave 1c notes, so the NL builder
doesn't hang indefinitely if CrystalOS is slow/down):**
```
⏱ This is taking too long
Crystal didn't respond in time. You can try again, or build this workflow manually.

[Try again]   [Build manually →]  (navigates to ROUTES.WORKFLOW_CANVAS, no seed —
                                     nothing to seed, the request never returned)
```

### 2.6 Micro-interaction spec: Crystal fill animation

This is the animation named explicitly in Rohan's TEAM.md mandate ("Crystal fill
animation") and the brief's callout. It plays exactly once, on the transition from
thinking-state to confirm-card (step 5 of 2.4), using Framer Motion (already a
dependency, per `app/CLAUDE.md`'s animation conventions — house ease curve
`[0.22, 1, 0.36, 1]` reused below for consistency with the rest of the app).

**What animates:** each row of the confirm-card (trigger row, each condition row,
each action row, in that top-to-bottom order — trigger always first since it's
causally first) animates in individually, staggered, rather than the whole card
fading in as one block. This is the "cards animating in one-by-one" behavior called
for in the brief.

**Implementation — parent container:**
```tsx
const confirmCardStagger: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.09, delayChildren: 0.05 } },
};

<motion.div variants={confirmCardStagger} initial="hidden" animate="visible">
  <TriggerSummaryRow ... />          {/* each of these is a motion.div, see below */}
  {conditions.map((c) => <ConditionSummaryRow key={c.id} ... />)}
  {actions.map((a, i) => <ActionSummaryRow key={a.id} index={i + 1} ... />)}
  {warnings.length > 0 && <WarningsList ... />}
  <ConfidenceBadge ... />
</motion.div>
```

**Implementation — each row (`TriggerSummaryRow` / `ConditionSummaryRow` /
`ActionSummaryRow`):**
```tsx
const rowVariant: Variants = {
  hidden:  { opacity: 0, y: 12, scale: 0.97 },
  visible: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.38, ease: [0.22, 1, 0.36, 1] } },
};

<motion.div variants={rowVariant} className="flex items-center gap-2 ...">
  {/* row content */}
</motion.div>
```

**Exact timing:** with `staggerChildren: 0.09` and `delayChildren: 0.05`, a workflow
with 1 trigger + 2 conditions + 2 actions (5 rows) completes its full stagger
sequence at `0.05 + 4 * 0.09 + 0.38 = 0.79s` from the moment the confirm-card mounts.
This is intentionally quick — this is a confirmation UI the user needs to *read and
evaluate*, not a hero moment to linger on; the animation should communicate "these
pieces were assembled for you" within under a second, then get out of the way so
reading can start. Compare to the page-transition stagger pattern already in
`app/CLAUDE.md` (`staggerChildren: 0.06` for card grids) — `0.09` here is
deliberately a touch slower per-row than a grid stagger because there are fewer,
denser, more information-bearing rows; each one deserves a beat of individual
attention that a small grid card doesn't need.

**Confidence badge and warnings list animate in last**, after all rows, using the
same `rowVariant` — they're supporting metadata, not part of the "what Crystal
built" narrative, so they shouldn't compete with the row reveal for attention.

**Footer buttons (`Edit in canvas` / `Discard` / `Create Workflow`) do not
stagger-animate** — they fade/slide in as a single unit immediately after the last
row completes (`delay: 0.79s` computed above, `duration: 0.2s`, simple opacity+y like
the rest), because staggering individual buttons reads as sluggish/gimmicky for
something the user needs to act on, not admire.

**Respect `prefers-reduced-motion`:** per the existing project convention for
decorative animation (see `app/CLAUDE.md`'s 3D section), wrap the stagger variants —
if `window.matchMedia('(prefers-reduced-motion: reduce)').matches`, use
`transition: { duration: 0 }` for both the container and row variants so everything
appears at once with no motion, rather than skipping Framer Motion's `initial`/
`animate` props entirely (which would cause a flash-of-hidden-content since `hidden`
sets `opacity: 0`).

### 2.7 Edge cases

| Case | Behavior |
|---|---|
| Empty description, user clicks Generate | Button is `disabled` when `!description.trim()` — this state is unreachable via click; if reached via the `Cmd+Enter` shortcut with empty text, no-op (do not submit, do not show an error — there's nothing wrong to explain, the affordance is simply inactive) |
| User navigates away mid-thinking (browser back, or clicks a nav link) | The in-flight `fetch` should be aborted via the same `AbortSignal` used for the timeout (2.5C) — cancel on unmount via a `useEffect` cleanup, so a stale response can't resolve after the user has left and (worst case) trigger a state update on an unmounted component |
| User clicks Generate twice quickly (double-click) | Button becomes `disabled` the instant `thinking` is set to `true` (synchronous state update before the async call starts), so a second request is structurally impossible, not just discouraged |
| Confirm-card is showing, user edits the description textarea again (if it were still visible) | Not applicable — per 2.4, textarea is `disabled` during thinking and the confirm-card replaces the input area entirely rather than showing alongside it; to change the description the user must Discard first (returns to step 1 with text preserved) |
| `nodes`/`edges` from the API reference a triggerType or action not present in the current registry (registry drift, e.g. Crystal proposes an action added to CrystalOS's model before the frontend's registry catalog is updated) | Render the row with the raw `type`/`action` string as a fallback label (same defensive pattern `WorkflowsPage`'s `triggerLabel()` already uses: `match?.label ?? wf.trigger_type`) rather than crashing or omitting the row — and add a `warnings` entry client-side if the API didn't already flag it, e.g. `"{type}" isn't recognized — you can still create this workflow, but review it in canvas first` |
| Workflow created from NL, then immediately edited | Falls under Spec 1's routing (1.1) like any other workflow — an NL-created workflow with no branches opens in the linear builder, one with branches opens in canvas. NL origin isn't tracked as a distinct "mode" past creation; there is no third edit surface for NL-originated workflows |

---

## 3. Registry gaps flagged for Amara / Wave 3 (not designed around — flagging instead)

While writing believable NL example prompts (2.3) and confirm-card content (2.4b), I
deliberately chose examples that map cleanly onto what `workflowRegistry.ts` already
supports (`score.nps_drop` trigger, `nps` condition field, `notify.slack` /
`jira.create_issue` actions all exist and are `live: true` or `live: 'env'`). Two
gaps surfaced that I did not design around — flagging for Wave 3 rather than
inventing fictional registry entries in this spec:

1. **No rolling-window / aggregate condition field.** `CONDITION_FIELDS` only exposes
   per-event fields (`nps`, `csat`, `sentiment`, `text`, `topic`, `severity`,
   `completion_time`, `channel`) — all resolved from a single trigger event's
   context. A very natural NL prompt like Maya's canonical HubSpot-style example
   ("when NPS drops below 30" as a *trend*, not "this one response scored below 30")
   implies a rolling-average or windowed-aggregate field distinct from the
   instantaneous `nps` field on a single response. The `score.nps_drop` trigger type
   exists in `TRIGGERS`, which suggests the *trigger* already intends to represent a
   drop-over-time signal — but there's no documented condition field (e.g.
   `nps_rolling_avg_7d`) for a workflow to threshold against once that trigger fires,
   and no visibility into how `score.nps_drop`'s payload shape differs from
   `survey.response_received`'s. Recommend Amara/Nina clarify: does `score.nps_drop`
   already carry a computed drop-magnitude in its event payload (in which case the
   condition field list just needs a new entry pointing at it), or does this trigger
   not exist as working code yet either? Either way, the NL parser's test corpus
   (Maya's 50 cases) will hit this immediately since "NPS dropped" is the single most
   obvious CX automation prompt.
2. **No trigger for "new negative theme detected" independent of `crystal.anomaly_detected`.**
   TEAM.md's Amara section and the TRACKER's Wave 3 scope both name three AI trigger
   types: `sentiment_spike`, `new_theme_detected`, `anomaly_detected`. Only a
   differently-named `crystal.anomaly_detected` exists in the current registry
   (`TRIGGERS`) — there's no `sentiment_spike` or `new_theme_detected` entry at all
   yet. This is expected (TRACKER already lists "No AI-driven triggers... CrystalOS
   side untouched" as a known Phase 1 gap, and it's literally Wave 3's job to add
   them) — flagging only so the naming lands consistently: when Amara adds these,
   confirm whether `crystal.anomaly_detected` is meant to be renamed/aliased to one of
   the three named triggers or is a fourth, separate signal, so the NL builder's
   example-prompt corpus and the registry's `category: 'Crystal'` grouping don't end
   up with overlapping/ambiguous entries.

Neither of these blocks Wave 2 — the NL builder's UI, confirm-card, and example
prompts in this spec are written entirely against triggers/actions that already
exist and are already `live`. They're flagged so Wave 3 doesn't have to reverse-engineer
"why does Rohan's spec assume a field that isn't in the registry" later.

---

## 3a. Addendum: a 3D moment for the NL builder's thinking state

**Placement — augments the existing thinking state, does not touch anything else.**
This builder is enterprise B2B chrome: dense trigger/condition/action rows, seven
conditions readable at a glance, no wasted motion. A 3D scene has no business sitting
next to the confirm-card's rows, the edit-mode forms, or the canvas — any of those
would trade density for spectacle. The one place a 3D moment earns its cost is the
thinking state (2.4a): it's the single moment in this whole spec where there is
*nothing to read yet* — the skeleton rows are there to preview shape, not convey
information, so this is the one beat where an ambient, non-informational visual isn't
competing with content. Treat it as **augmenting** the skeleton-row thinking state
from 2.4a, not replacing it: the skeleton rows stay (they still communicate "this many
rows are coming"), and the 3D scene sits as a small ambient accent beside/above them —
never full-bleed, never behind the confirm-card once it starts appearing.

**Scene:** reuse `CentralCrystal` and `Particles` from `app/src/components/three/HeroCanvas.tsx`
directly (same components, imported, not reinvented) at a much smaller scale — this is
the project's existing "Crystal is thinking" visual language, so reusing it here is
consistent rather than a new motif. Concretely: a single small `Canvas` (`~96px`
square, inline in the thinking-state card next to `thinkingLabel`, not a full-bleed
background) containing:
- One `CentralCrystal` instance (the distorted icosahedron + wireframe), no changes to its geometry/material.
- `Particles` at a reduced `count` (40, not 320 — this is a 96px inline accent, not a hero canvas; 320 points at that size is wasted fill-rate and indistinguishable specks).
- No `Stars`, no `OrbitRing`, no `FloatingGem` — those exist to fill a full viewport; at thumbnail scale they'd just add draw calls with no visible payoff.
- No `OrbitControls` — this is `pointerEvents: 'none'`, exactly like `HeroCanvas`, purely decorative, never interactive.

**Lifecycle — tied exactly to the parse request, per the existing `AbortSignal.timeout(20000)` from §2.5C:**
- **Pending:** `Canvas` mounts the instant `thinking` becomes `true` (same moment the textarea/chips disable, step 4 of §2.4).
- **Success (200):** `Canvas` **unmounts immediately**, not fades — the instant the response resolves and the confirm-card begins its stagger-in (§2.6), before the first `TriggerSummaryRow`'s `rowVariant` animation starts. This is a hard cutover, not a cross-fade, for two reasons: (1) it guarantees the WebGL context and its `useFrame` render loop are gone before Framer Motion's stagger begins, so there is zero chance of the two animation systems competing for the same frame budget during the part of this flow that most needs to read as crisp (see performance guardrail below); (2) a lingering 3D element while the "real" result is animating in would read as visual clutter competing with the thing the user actually needs to evaluate.
- **Low-confidence (200, confidence < 0.6) or error (422/504):** same immediate unmount as success — the 3D scene's only job is to occupy the "Crystal is working" beat; every state that follows (confirm-card, low-confidence card, error card) is content the user must read, so none of them get a 3D accompaniment. This keeps the rule simple to implement: exactly one boolean (`thinking`) controls Canvas mount, no separate teardown branches per outcome.
- **Client-side abort** (user navigates away, or the 20s timeout fires): same unmount, driven by the same `thinking → false` transition already firing in the cleanup path from §2.7's abort-on-unmount edge case — no separate wiring needed.

**Performance guardrails:**
- Lazy-load exactly like `HeroCanvas` today — `lazy(() => import('../../components/three/NLThinkingCrystal'))` behind `<Suspense fallback={null}>`, never a direct top-level import in `WorkflowNLBuilderPage.tsx`. (New file `app/src/components/three/NLThinkingCrystal.tsx` — a thin wrapper composing the reused `CentralCrystal`/`Particles`, not new geometry.)
- `dpr={[1, 2]}` cap, same as `HeroCanvas` — do not go higher for a 96px accent.
- Because the Canvas fully unmounts on every non-pending state (see lifecycle above), there is no steady-state cost outside the thinking window — nothing to throttle or pause once the confirm-card is showing, since nothing is still running.
- The 96px scene is inline chrome, not a background layer behind the skeleton rows — it never overlaps the DOM region the Framer Motion stagger animates, so there's no shared paint layer or z-index interaction to reason about between the two animation systems even during the brief moment they could theoretically coexist (they don't, per the hard-cutover rule above, but the layout guarantees it'd be harmless if timing ever slipped by a frame).
- If a request resolves in under ~300ms (unlikely for an LLM call, but possible against a mocked/stubbed backend during development), do not skip mounting the Canvas just to avoid a flash — a fixed minimum-display heuristic adds state for a case that doesn't matter in production against a real LLM; if it proves visually noisy in practice against the dev mock, that's a one-line follow-up (`Math.max(elapsed, 300)` before allowing the unmount), not a v1 requirement.

**Reduced-motion / low-end fallback — mirrors §2.6's `prefers-reduced-motion` handling exactly:**
Per `app/CLAUDE.md`'s existing rule ("Always check `prefers-reduced-motion` before
mounting a Canvas"), gate the entire Canvas mount — not just its internal animation —
behind the same check already used for `HeroCanvas`:
```tsx
const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
{!prefersReducedMotion && (
  <Suspense fallback={null}>
    <NLThinkingCrystal />
  </Suspense>
)}
```
When reduced motion is set (or the `Suspense` fallback is showing during the lazy
chunk's download), fall back to the project's existing **CSS Crystal alternative**
(`app/CLAUDE.md`'s "CSS Crystal Alternative" section) at the same ~96px size — the
`exp-hub-spin` conic-gradient hex + `pulse-glow` core, zero WebGL, already implemented
elsewhere in the app (`ExperienceHubPage`, `SurveyIntelligencePage`). This is a better
fallback than a static icon because it preserves the same "Crystal is alive and
working" signal at zero GPU cost, and it means the thinking state never has an empty
gap where the 3D accent would have been. No new fallback component needs designing —
copy the existing CSS block verbatim at reduced scale.

**Tailwind/shadcn boundary — unaffected:** the Canvas (or its CSS fallback) sits
inside the existing `Card`-based thinking-state layout from §2.4a as a small inline
element beside the skeleton rows; the card shell, spacing, `thinkingLabel`/
`thinkingSubtext` typography, and all surrounding chrome remain plain Tailwind +
shadcn `Card`, exactly as specified in the base doc. Nothing in this addendum
introduces a new layout primitive or touches the confirm-card, edit-mode forms, or
canvas builder.

---

## 4. New locale keys summary (for `app/src/locales/en.ts`, `workflows` namespace)

Additive only — nothing below renames or removes an existing key.

```
workflows.buildWithCrystal: 'Build with Crystal'
workflows.builder.descriptionLabel: 'Description'
workflows.builder.descriptionPlaceholder: 'What does this workflow do? (optional)'
workflows.builder.editTitle: 'Edit Workflow'
workflows.builder.editSubtitle: 'Update the trigger, conditions, and actions for {name}'
workflows.builder.saveChanges: 'Save changes'
workflows.builder.loadError: 'Could not load this workflow.'
workflows.builder.notFoundHeading: 'Workflow not found'
workflows.builder.notFoundBody: 'It may have been deleted, or you may not have access to it.'
workflows.builder.loadErrorBody: 'Something went wrong loading this workflow. Try again.'
workflows.builder.backToList: 'Back to Workflows'
workflows.builder.needBranching: 'Need to branch into different actions depending on the result?'
workflows.builder.switchToCanvas: 'Switch to canvas builder'
workflows.canvas.loadError: 'Could not load this workflow.'
workflows.canvas.loadingWorkflow: 'Loading workflow…'
workflows.nlBuilder.title: 'Describe Your Workflow'
workflows.nlBuilder.subtitle: 'Tell Crystal what you want to happen, in plain English'
workflows.nlBuilder.placeholder: 'e.g. "When NPS drops below 30, notify the support team on Slack and create a Jira ticket"'
workflows.nlBuilder.examplesLabel: 'Try an example'
workflows.nlBuilder.examples: [3 example strings, see 2.3]
workflows.nlBuilder.generateButton: 'Generate Workflow'
workflows.nlBuilder.thinkingLabel: 'Crystal is building your workflow…'
workflows.nlBuilder.thinkingSubtext: 'Reading your description and matching it to triggers and actions'
workflows.nlBuilder.thinkingSlow: 'Still working — complex requests can take a little longer'
workflows.nlBuilder.confirmHeading: "Here's what Crystal understood"
workflows.nlBuilder.confidenceHigh: 'High'
workflows.nlBuilder.confidenceMedium: 'Medium — review before enabling'
workflows.nlBuilder.assumedHeading: 'Crystal assumed:'
workflows.nlBuilder.editInCanvas: 'Edit in canvas'
workflows.nlBuilder.discard: 'Discard'
workflows.nlBuilder.createWorkflow: 'Create Workflow'
workflows.nlBuilder.lowConfidenceHeading: "Crystal wasn't fully sure about this one"
workflows.nlBuilder.lowConfidenceBody: "Here's a rough idea of what it understood, but double-check it in the canvas builder before creating it."
workflows.nlBuilder.tryRewording: 'Try rewording instead'
workflows.nlBuilder.unparseableHeading: "Crystal couldn't turn that into a workflow"
workflows.nlBuilder.unparseableHint: 'Try being more specific about:'
workflows.nlBuilder.unparseableHintTrigger: 'What should trigger it (a survey response, a score, a schedule)'
workflows.nlBuilder.unparseableHintAction: 'What should happen (send a message, create a ticket, tag something)'
workflows.nlBuilder.timeoutHeading: 'This is taking too long'
workflows.nlBuilder.timeoutBody: "Crystal didn't respond in time. You can try again, or build this workflow manually."
workflows.nlBuilder.tryAgain: 'Try again'
workflows.nlBuilder.buildManually: 'Build manually'
workflows.nlBuilder.registryDriftWarning: '"{type}" isn\'t recognized — you can still create this workflow, but review it in canvas first'
```

---

## 5. Summary of new/changed files (for Elias's implementation pass)

**New:**
- `app/src/pages/WorkflowNLBuilderPage.tsx`
- `app/src/lib/workflowEditRoute.ts` (`resolveEditRoute`)
- `app/src/components/three/NLThinkingCrystal.tsx` (§3a — thin wrapper reusing `CentralCrystal`/`Particles` from `HeroCanvas.tsx` at thumbnail scale, lazy-loaded)
- ~~`app/src/components/ui/textarea.tsx`~~ — correction: `textarea` is already a listed shadcn primitive per `app/CLAUDE.md`; no new primitive needed, disregard the earlier flag in §2.3

**Changed:**
- `app/src/pages/WorkflowBuilderPage.tsx` — edit-mode fetch/loading/error states, description field, save-shape branch (PUT vs POST), `invalidate('workflows')`, canvas cross-link footer
- `app/src/pages/WorkflowCanvasPage.tsx` — same edit-mode additions, `seed` consumption (both from 1.5's cross-link and 2.4's "Edit in canvas" handoff)
- `app/src/lib/workflowCanvas.ts` — new `deserializeCanvas` helper
- `app/src/pages/WorkflowsPage.tsx` — Edit button routes via `resolveEditRoute` instead of hardcoded `ROUTES.WORKFLOW_BUILD`; header gets third `Build with Crystal` button
- `app/src/lib/api.ts` — new `getWorkflow(id)` method (`GET /api/workflows/:id`), new `parseWorkflowNL(description)` method (`POST /api/workflows/parse-nl`)
- `app/src/constants/routes.ts` — new `WORKFLOW_NL_BUILD` route
- `app/src/locales/en.ts` — additive keys per §4

**Backend (not this doc's scope to implement, but blocking — see §0):**
- `backend/src/routes/workflows.ts` — new `GET /:id`, extended `PUT /:id` handler
- `backend/src/schemas/workflows.ts` — `updateWorkflowSchema` extended to match `createWorkflowSchema`
- New route + `agentsClient.ts` function for `POST /api/workflows/parse-nl` (Wave 3, Amara + backend owner)

**Tests (per both `app/CLAUDE.md` and `backend/CLAUDE.md`'s testing rules — every
change needs a corresponding test change):**
- `resolveEditRoute` — pure function, straightforward unit tests (linear shape → build route, branching shape → canvas route, single-condition-no-branch → build route)
- `deserializeCanvas` — round-trip test against `serializeCanvas` (serialize → deserialize → re-serialize should be structurally equivalent, modulo position data which has no inverse)
- `WorkflowBuilderPage` / `WorkflowCanvasPage` edit-mode — mount with `location.state.workflowId` set, mock `api.getWorkflow` success/404/error, assert pre-filled fields and correct save-method call (PUT vs POST)
- `WorkflowNLBuilderPage` — mock `api.parseWorkflowNL` for the 200/422/504/low-confidence cases, assert correct state rendered for each; assert `Cmd+Enter` submits; assert abort-on-unmount cancels the in-flight request
