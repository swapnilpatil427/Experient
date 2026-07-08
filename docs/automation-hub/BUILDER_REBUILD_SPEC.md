# Xperiq Actions — Builder Rebuild Spec

**Author:** Rohan Desai, Principal Product Designer, Builder Experiences
**Audience:** Elias Park (frontend implementer), Nina Reeves (backend contract owner), Kenji Watanabe (QA)
**Status:** Implementation-ready. Spec-only — no code included.
**Supersedes for build purposes:** the currently-shipped `WorkflowBuilderPage.tsx` linear form. Does NOT delete `WorkflowCanvasPage.tsx`.

**Inputs this spec translates:**
- `docs/automation-hub/DESIGN.md` §"Surface 2: Unified Builder" (lines 553–1154) — full visual/interaction spec
- `docs/automation-hub/CUSTOMER_REVIEW.md` C-001 (trigger grouping) and C-004 (cooldown UI) — both in scope per orchestrator decision
- `docs/automation-hub/TEAM.md` Anti-Goals — no branching logic in Phases 1–5

**Reconciled against the actual codebase** (not the aspirational `ARCHITECTURE.md`):
- `app/src/pages/WorkflowBuilderPage.tsx`, `WorkflowCanvasPage.tsx`, `WorkflowNLBuilderPage.tsx`
- `app/src/lib/workflowCanvas.ts`
- `backend/src/lib/workflowRegistry.ts`, `backend/src/lib/workflowEngine.ts`, `backend/src/lib/cron.ts`
- `supabase/migrations/20260603000018_workflows_v2.sql` (the real `workflows` table shape)
- `app/src/components/ui/*`, `app/package.json`

---

## 0. Two load-bearing facts that change scope

Before anything else, two things in DESIGN.md and CUSTOMER_REVIEW.md do not match the shipped system, and this spec builds against the shipped system, not the aspirational docs.

### 0.1 The registry is not what DESIGN.md/CUSTOMER_REVIEW.md assume

DESIGN.md's palette and CUSTOMER_REVIEW.md's C-001 grouping both use a **canonical trigger vocabulary** (`nps_threshold`, `response_count`, `response_rate_drop`, `sentiment_spike`, `anomaly_detected`, `new_theme_detected`, `schedule`, `response_submitted`, `survey_lifecycle`, `manual`) that reads as a clean 10-item product taxonomy. The actual registry shipped in `backend/src/lib/workflowRegistry.ts` (`TRIGGERS` array, lines 24–44) has **13 triggers** with different, more implementation-flavored names:

```
survey.response_received      survey.response_filtered      survey.milestone_reached
score.nps_drop                score.nps_rise
crystal.insight_ready         crystal.anomaly_detected      crystal.verbatim_escalation
crystal.sentiment_spike       crystal.new_theme_detected
alert.fired
time.schedule
external.webhook
```

There is no `response_rate_drop`, no `manual` trigger, no `survey_lifecycle` (closest analog: `survey.milestone_reached`), and `response_submitted` is `survey.response_received`. The action catalog (`ACTIONS`, lines 62–77) similarly uses `notify.slack` / `notify.email` / `jira.create_issue` / `zendesk.create_ticket` naming, not DESIGN.md's `slack_notification` / `send_email` / `create_jira_ticket`.

**Rule for this spec and for Elias:** every trigger/action referenced below maps to a **real registry entry by its actual `type`/`action` string**. Section 4 (Grouped Trigger Picker) gives the exact mapping table. Do not invent `response_rate_drop` or `manual` — they don't exist yet. If Maya's product scope wants them, that's a `workflowRegistry.ts` change owned by Priya/Nina, not a builder UI problem, and it's out of scope for this spec.

### 0.2 `cooldown_minutes` does not exist anywhere in the real schema

CUSTOMER_REVIEW.md's C-004 write-up says "the architecture defines `cooldown_minutes` with a default of 60 minutes" and "zero backend changes — the API already accepts `cooldown_minutes`." That is true of `docs/automation-hub/ARCHITECTURE.md` (the aspirational design doc) but **false of the shipped schema**. I checked `supabase/migrations/20260603000018_workflows_v2.sql` (the actual `workflows` table DDL) — there is no `cooldown_minutes`, `cooldown_until`, or `status = 'cooldown'` anywhere in the real migrations, and `workflowEngine.ts` has no cooldown-check logic in `runWorkflow`/`runWorkflowsForEvent`.

This means Section 5 of this spec is a **net-new backend contract**, not a "wire up the existing field" task. I've flagged this explicitly for Nina in Section 5.2 — she needs to actually build the column and the enforcement check, not just expose an existing one.

---

## 1. Architecture Decision

### 1.1 `WorkflowBuilderPage.tsx` becomes the Unified Builder

The current simple linear-form `WorkflowBuilderPage.tsx` (trigger Select → condition rows → action rows, `NodeCard` components, `max-w-3xl`) is replaced in place by the new 3-panel Unified Builder described in DESIGN.md §2. Route stays `ROUTES.WORKFLOW_BUILD` (`/app/workflows/build`), same query params (`?type=`, `?mode=`, `?q=`, `?template=`). This is a full rewrite of the page component, not an incremental patch — the current page's `NodeCard` linear-stack-of-Selects pattern shares nothing structurally with the card-stack + connector + side-panel layout DESIGN.md specifies.

**Reasoning:** The current page is the thing the user is unhappy with. It doesn't use the palette/canvas/config-panel split, has no schedule config beyond nothing, and its "switch to canvas" escape hatch exists precisely because it can't express branching — which the new unified builder also won't do (Anti-Goals), but will do everything else the linear form couldn't (rich per-card config, live preview strip, grouped picker, cooldown).

Builder-mode chrome: this route should be added to the AppShell's builder-mode detection (the same mechanism that suppresses gutters/footer/BottomNav for `/surveys/:id/build`, per `app/CLAUDE.md` "Application Shell"). DESIGN.md's 56px header + 3-panel fixed layout needs the full viewport, not `PageHeader` + `max-w-*` gutters. Elias: extend the existing `isBuilder` regex in `AppShell.tsx` to also match `/app/workflows/build`.

### 1.2 `WorkflowCanvasPage.tsx` is kept, unchanged in its execution model, exposed as "Advanced: Branching Canvas"

Per the task brief and TEAM.md's Anti-Goals, branching logic is explicitly not a Phase 1–5 feature of the *primary* builder. But `WorkflowCanvasPage.tsx` already exists, is tested, and gives power users true branching (`ConditionNode`'s true/false handles → `runGraph()` in `workflowEngine.ts`, which is real, working engine code — `isGraphWorkflow()` already detects branch edges and dispatches to it). Deleting or hiding it would be a regression for anyone already depending on it, and rebuilding its functionality inside the new linear card-stack is explicitly out of scope (that's the graph model DESIGN.md's vertical stack is deliberately not).

**Decision:** keep `WorkflowCanvasPage.tsx` and `ROUTES.WORKFLOW_CANVAS` exactly as-is. Add one new entry point: a ghost-button/link in the new Unified Builder's left panel footer, below the palette:

```
─────────────────────────────
Need branching logic?
[ Advanced: Branching Canvas → ]
```

This mirrors the existing cross-link pattern already in the codebase (`WorkflowBuilderPage.tsx`'s `switchToCanvas()` / `workflows.builder.needBranching` / `workflows.builder.switchToCanvas` locale keys) — reuse those keys, just relocate the affordance into the new left panel instead of inside a condition `NodeCard`. Clicking it seeds `WorkflowCanvasPage` via the same `{ seed: { name, triggerType, rules } }` router-state shape it already accepts (see `WorkflowCanvasPage.tsx` lines 39–42, `CanvasSeed`) — no new seed shape needed. The unified builder's canvas state (cards → nodes/conditions/rules) maps directly onto the existing partial-seed branch (`seed.rules`, no `nodes`/`edges`) in `WorkflowCanvasPage`'s effect (lines 117–132).

**Label copy exact text:** "Advanced: Branching Canvas" — signals (a) this is for power users, (b) it does the thing the primary builder deliberately doesn't. Do not call it "Pro Builder" or similar — "Advanced" + "Branching" tells the user exactly what capability they're opting into.

### 1.3 The NL builder tab reuses `WorkflowNLBuilderPage.tsx` logic via a route-level tab, not a re-render-in-place merge

DESIGN.md §2.1 and §2.6 describe "Crystal Builder" and "Visual Builder" as two tabs in the *same* header, sharing canvas state, with an `AnimatePresence mode="wait"` cross-fade between them (§2.6: exit `opacity 1→0, x:0→-20 @160ms`, enter `opacity 0→1, x:20→0 @200ms`). A literal reading requires the NL input area and the visual canvas to be two panels of one mounted component tree so switching tabs doesn't remount and lose canvas state.

`WorkflowNLBuilderPage.tsx` (545 lines) is a fully independent page: its own route, its own `ViewState` state machine (`input | thinking | confirm | low-confidence | unparseable | timeout`), its own lazy-loaded 3D thinking accent, its own confirm-card fill animation, its own outcome routing (`editInCanvas()` → `WorkflowCanvasPage` with a full seed, `createWorkflow()` → API + navigate away). It was built in Wave 2/3 specifically to satisfy DESIGN.md's Surface 3 spec and has its own test coverage.

**Decision: keep `WorkflowNLBuilderPage.tsx` as its own route (`ROUTES.WORKFLOW_NL_BUILD`), and make the Unified Builder's "✦ Crystal Builder" tab click `navigate()` to that route (passing current canvas state as seed) rather than mounting its logic inline.** To preserve the *feel* of a tab switch rather than a page navigation:

- Both routes render inside the same builder-mode chrome (56px header, mode-tab segmented control present on both pages — `WorkflowNLBuilderPage.tsx` needs the header added; it currently uses `PageHeader` + `max-w-2xl`, which must change to match the builder-mode full-bleed layout for the tab illusion to hold).
- The segmented-control tab component (Section 2.1 below) is a **shared component** (`BuilderModeTabs.tsx`) rendered by both pages, so clicking the inactive tab is a same-shell route change, not a full page reload — React Router will unmount/remount the route body but the header/tabs stay visually continuous if both pages share the same header component instance pattern (same DOM structure, different content below).
- Apply DESIGN.md §2.6's exact `AnimatePresence` transition to the *content area below the header* on both pages (not the header itself), keyed on `mode`.
- Canvas state continuity: when switching Visual → Crystal, pass current cards as an NL seed (pre-fill the textarea is not it — DESIGN.md says "canvas remains visible below the NL input," which this route-swap approach cannot literally satisfy). **This is the one place this decision diverges from a literal DESIGN.md reading** — flagging it rather than silently picking: literal shared-canvas-state-in-one-tree would require either (a) rebuilding the NL builder's entire state machine inside the Unified Builder, discarding tested Wave 2/3 work, or (b) lifting all of `WorkflowNLBuilderPage`'s state up a level and prop-drilling it into two render branches of one component — a large, risky refactor of a page with non-trivial async/abort/timeout logic (see its `abortRef`/`mountedRef`/`slowTimerRef` cleanup). Given the user's core complaint is about the *visual builder's* fidelity and flexibility, not the NL builder (which already works), I'm treating the merge as too risky to bundle into this rebuild. Elias's call to override if he judges the lift-state-up refactor safe — but ship the route-swap version first since it's non-destructive and low-risk.

**Net effect:** `/app/workflows/build?mode=visual` and `/app/workflows/build?mode=crystal` are two routes under the hood (`WORKFLOW_BUILD` and `WORKFLOW_NL_BUILD`) that render a shared header/tab-bar component and cross-fade their body content, giving the DESIGN.md-specified feel without a canvas-state merge. Document this as an explicit, intentional architecture note in the component so a future engineer doesn't "fix" it into two branches of dead code.

---

## 2. Component Breakdown

New files live under `app/src/pages/` (route-level) and a new `app/src/components/workflow-builder/` directory (shared pieces used by both the new builder and, where noted, reusable by other workflow pages).

| Component | File (new unless noted) | shadcn used | Net-new to `src/components/ui/`? |
|---|---|---|---|
| `WorkflowBuilderPage` | rewrite of `app/src/pages/WorkflowBuilderPage.tsx` | — (composition root) | — |
| `BuilderModeTabs` | `app/src/components/workflow-builder/BuilderModeTabs.tsx` | `Tabs`/segmented via existing `Button` group pattern (no new primitive needed — this is a styled `div` + `Button` group per DESIGN.md §2.1's `bg-gray-100 rounded-lg p-0.5` container, not Radix Tabs, since it's a route-level nav not content-tabs) | No |
| `BuilderHeader` | `app/src/components/workflow-builder/BuilderHeader.tsx` | `Button`, `Input` (inline name edit), `Badge` (unsaved-dot substitute — actually a plain span per DESIGN.md's 6px dot) | No |
| `AutomationTypeSelector` | `app/src/components/workflow-builder/AutomationTypeSelector.tsx` | `RadioGroup` (for the two radio-style cards; currently absent) | **Yes — `radio-group.tsx`** |
| `ScopeBlock` | `app/src/components/workflow-builder/ScopeBlock.tsx` | `RadioGroup`, `Select` (survey/tag combobox) | Reuses `radio-group.tsx` above |
| `AddToCanvasPalette` | `app/src/components/workflow-builder/AddToCanvasPalette.tsx` | `ScrollArea`, `Badge` (`[Crystal]` chip) | No |
| `BuilderCanvas` | `app/src/components/workflow-builder/BuilderCanvas.tsx` | plain divs + SVG overlay (see 2.3) | No |
| `CardConnectorSvg` | `app/src/components/workflow-builder/CardConnectorSvg.tsx` | Framer Motion `motion.path` | No |
| `CanvasCard` (+ variants) | `app/src/components/workflow-builder/CanvasCard.tsx` | `Card`, `Badge`, drag handle icon | No |
| `RightConfigPanel` | `app/src/components/workflow-builder/RightConfigPanel.tsx` | composition root for the panels below | — |
| `ScheduleTriggerConfigPanel` | `app/src/components/workflow-builder/panels/ScheduleTriggerConfigPanel.tsx` | `ToggleGroup`, `Select`, `RadioGroup`, `Input`, `Collapsible`, `Badge`, `Popover` + `Command` (timezone) | **Yes — `toggle-group.tsx`, `collapsible.tsx`, `popover.tsx`, `command.tsx`** |
| `NpsThresholdConfigPanel` | `.../panels/NpsThresholdConfigPanel.tsx` | `Select`, `Input` | No |
| `GenerateBriefingConfigPanel` | `.../panels/GenerateBriefingConfigPanel.tsx` | `Select`, `Switch`, `@dnd-kit/core` (sections reorder) | No new shadcn; **new npm dep** — see 2.4 |
| `EmailActionConfigPanel` | `.../panels/EmailActionConfigPanel.tsx` | `Input`, `Select`, tag-input (custom, not shadcn) | No |
| `SlackActionConfigPanel` | `.../panels/SlackActionConfigPanel.tsx` | `Input`, `Select`, `Button` | No |
| `JiraActionConfigPanel` | `.../panels/JiraActionConfigPanel.tsx` | `Select`, `Textarea`, `Input` | No |
| `InAppActionConfigPanel` | `.../panels/InAppActionConfigPanel.tsx` | `Input`, `Select` | No |
| `WorkflowSettingsPanel` (Cooldown, C-004) | `.../panels/WorkflowSettingsPanel.tsx` | `RadioGroup`, `Input` (custom minutes) | Reuses `radio-group.tsx` |
| `LivePreviewStrip` | `app/src/components/workflow-builder/LivePreviewStrip.tsx` | `Badge`-style chips (plain spans matching left-accent colors) | No |
| `GroupedTriggerPicker` | `app/src/components/workflow-builder/GroupedTriggerPicker.tsx` | `ScrollArea`, `Badge` (`[Crystal]`), `Tooltip` | No |

### 2.1 Header

56px fixed header per DESIGN.md §2.1, exactly as specified: back button, inline-editable name `<input>`, `BuilderModeTabs`, Test Run / Save / Enable buttons, unsaved-changes dot. All strings via `t()` — new locale keys under `workflows.builder.unified.*` (header, palette, panels) to avoid collision with the existing `workflows.builder.*` keys still used by `WorkflowCanvasPage`.

### 2.2 Left Panel (256px)

`AutomationTypeSelector` (two radio cards, workflow vs. briefing) → `ScopeBlock` (org-wide / survey / tag group) → `AddToCanvasPalette`, which renders `GroupedTriggerPicker` for the Triggers section (see Section 4) and flat lists for Conditions/Actions per DESIGN.md §2.2 (conditions and actions don't have a C-001-style grouping mandate — only triggers do). Bottom of panel: the "Advanced: Branching Canvas" link (Section 1.2).

State shape for the palette-to-canvas interaction: dragging (or, on narrow viewports, clicking) a palette item calls a single `addCard(kind: 'trigger'|'condition'|'action', typeKey: string, atIndex?: number)` handler owned by `WorkflowBuilderPage`. `typeKey` is the real registry string (e.g. `score.nps_drop`, `notify.slack`) — never a display label.

### 2.3 Center Canvas — card stack + connectors

This is simpler than `WorkflowCanvasPage.tsx`'s reactflow graph because it's a **linear vertical list, not a free-form graph** — no pan/zoom, no arbitrary node positions, no minimap. Recommend **not** pulling in reactflow for this surface at all; it would be architectural overkill for a fixed vertical stack and DESIGN.md's own bezier spec (§2.3, "Bezier Connector SVG Spec") is written as a from-scratch calculation, not a reactflow edge renderer.

Implementation shape:
- Canvas state is `cards: CanvasCardState[]`, an ordered array (index = vertical position). Card kinds: `trigger | condition | action`. This is intentionally close to the engine's own linear `nodes[]` array (`WorkflowNode[]` in `workflowEngine.ts`) — serialization to the API payload is closer to `WorkflowBuilderPage.tsx`'s existing `nodes = [trigger, ...conditions, ...actions]` construction (lines 118–123) than to `workflowCanvas.ts`'s graph serializer. **Reuse the existing linear serialization logic from the current `WorkflowBuilderPage.tsx.save()`** (trigger node + one condition node holding an `AND` rule array + ordered action nodes) rather than adapting `serializeCanvas()`, which is graph-shaped (positions, `EngineEdge[]`) and to be used **only** by `WorkflowCanvasPage`.
- Each card's screen position is simply its DOM flow position (no absolute x/y) — `32px` gap, `480px` max-width, centered, exactly per DESIGN.md §2.3.
- `CardConnectorSvg` renders one absolutely-positioned SVG overlay (`position:absolute; inset:0; pointer-events:none`) sized to the canvas's scroll content height. On each render (or via `ResizeObserver` on card refs), compute each adjacent card pair's bottom-center/top-center DOM coordinates (via `getBoundingClientRect()` relative to the canvas container) and feed them into DESIGN.md's `bezierPath(sx, sy, tx, ty)` function verbatim (§2.3, lines 794–802) — this pure function can be lifted as-is into `CardConnectorSvg.tsx`, it has no reactflow dependency.
- Conceptually this reuses "the idea" of `WorkflowCanvasPage`'s SVG edge rendering (reactflow renders bezier edges internally) but is a **new, simpler implementation** — do not attempt to extract shared code from reactflow's internal edge renderer; it's not exposed as a reusable utility, and the linear-stack case doesn't need reactflow's coordinate system, drag/connect state machine, or handles at all.
- `AND` separator between adjacent condition cards is a plain text row, no connector needed there (DESIGN.md §2.3, "Between conditions" spec).
- Draw-in animation and arrowhead marker are implemented exactly as DESIGN.md specifies (motion.path with `pathLength`, `<marker>` def) — no adaptation needed, these are literal Framer Motion/SVG primitives.

### 2.4 Right Panel (320px)

`RightConfigPanel` renders one of: no-selection contextual help (default — and see Section 6 for the 3D verdict on this exact state), `WorkflowSettingsPanel` (also shown by default/no-selection per C-004, see Section 5), or the config panel matching the selected card's kind/type. Panel switch is keyed by `selectedCardId`; switching panels does not need the Section 2.6-style cross-fade (that's reserved for the Visual/Crystal mode switch) but a lighter 150ms opacity fade on panel content swap is reasonable and consistent with house motion conventions (`app/CLAUDE.md`'s "Component Entrance Patterns").

**Net-new npm dependency:** `GenerateBriefingConfigPanel`'s draggable sections list uses `@dnd-kit/core` + `@dnd-kit/sortable` per DESIGN.md §2.4 ("ENT-029 applied" comment, `DndContext` + `SortableContext`). This is **not currently installed** (checked `app/package.json` — no `@dnd-kit/*` entries). Flag for Elias: this is the one genuinely new npm package this rebuild requires; evercurrent shadcn additions below are zero-new-dependency (Radix primitives are already installed transitively or directly).

### 2.5 Bottom Live Preview Strip

`LivePreviewStrip` — a derived-string component, pure function of `cards` state, exactly per DESIGN.md §2.5. No shadcn component needed; chips are styled spans keyed to each card's left-accent color (Section 2.3's card color tokens).

### 2.6 shadcn additions — dependency audit

Current `src/components/ui/`: `badge`, `button`, `card`, `dialog`, `dropdown-menu`, `input`, `label`, `progress`, `scroll-area`, `select`, `separator`, `sheet`, `switch`, `table`, `tabs`, `textarea`, `tooltip`.

DESIGN.md's config panels need `ToggleGroup`, `RadioGroup`, `Popover`, `Collapsible`, and `Command` (searchable timezone palette). Checked `app/package.json`'s installed `@radix-ui/*` packages (listed in Section "Available shadcn Primitives" context) against what each of these five needs:

| shadcn component | Radix primitive required | Installed today? | Action |
|---|---|---|---|
| `RadioGroup` | `@radix-ui/react-radio-group` | **No** | `npm install @radix-ui/react-radio-group`, then copy shadcn's `radio-group.tsx` |
| `ToggleGroup` | `@radix-ui/react-toggle-group` (+ `@radix-ui/react-toggle`) | **No** | `npm install @radix-ui/react-toggle-group @radix-ui/react-toggle`, then copy `toggle-group.tsx` + `toggle.tsx` |
| `Popover` | `@radix-ui/react-popover` | **No** | `npm install @radix-ui/react-popover`, then copy `popover.tsx` |
| `Collapsible` | `@radix-ui/react-collapsible` | **No** | `npm install @radix-ui/react-collapsible`, then copy `collapsible.tsx` |
| `Command` (cmdk-based, used inside `Popover` for searchable timezone) | `cmdk` (not a Radix package — a separate library shadcn's Command wraps) | **No** (`cmdk` absent from `package.json`) | `npm install cmdk`, then copy `command.tsx` |

**None of these five can be added with zero new npm dependencies** — contrary to what a hopeful reading of "just copy the shadcn file" might suggest, every one of them needs its underlying primitive package installed first, since only the 12 primitives listed in `app/CLAUDE.md`'s "Available shadcn Primitives" table are in `package.json` today. This is 5 new small packages (`@radix-ui/react-radio-group`, `@radix-ui/react-toggle-group`, `@radix-ui/react-toggle`, `@radix-ui/react-popover`, `@radix-ui/react-collapsible`) plus `cmdk`, all lightweight/standard and consistent with the existing Radix-based design system — this is not a scope concern, just something Elias should do in one dependency-install PR before starting the panel components so CI dependency-lock diffs are isolated from the feature diff.

---

## 3. Schedule Trigger Config Panel — precise implementation spec

This directly fixes the reported bug: **there is currently no way to configure a schedule for the Weekly Digest template.** The current registry has `time.schedule` as a real trigger type and `workflowEngine.ts`'s `runScheduledWorkflows()` (lines 571–587) already reads `triggerNode.config.cron` and calls the real `cronMatches(cron, now)` from `backend/src/lib/cron.ts` — so the engine-side plumbing exists end-to-end today; only the UI to produce a correct `config.cron` value is missing. This is exactly the gap Priya/Scenario 2 in CUSTOMER_REVIEW.md describes (analyst typing `0 9 1 * *` instead of `0 9 * * 1`).

### 3.1 State shape

```ts
type ScheduleFrequency = 'daily' | 'weekly' | 'monthly' | 'custom';

type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0 = Sunday, matches cron.ts's dow normalization

interface MonthlyConfig {
  variant: 'day_of_month' | 'ordinal_weekday' | 'last_day';
  dayOfMonth?: number;           // 1–28 only (29–31 disallowed in the picker; see 3.4)
  ordinal?: 'first' | 'second' | 'third' | 'fourth' | 'last';
  ordinalWeekday?: Weekday;
}

interface CustomIntervalConfig {
  count: number;                 // 1–365, Input type=number
  unit: 'hours' | 'days' | 'weeks' | 'months';
  startingWeekday?: Weekday;     // only meaningful when unit === 'weeks'
}

interface TimeOfDay {
  hour12: number;                // 1–12
  minute: number;                // 0–59 (default UI only exposes :00/:15/:30/:45 + "pick exact minute" escape hatch)
  meridiem: 'AM' | 'PM';
}

interface ScheduleConfigState {
  frequency: ScheduleFrequency;
  weeklyDays: Weekday[];         // min length 1 when frequency === 'weekly'
  monthly: MonthlyConfig;        // only relevant when frequency === 'monthly'
  customInterval: CustomIntervalConfig; // only relevant when frequency === 'custom'
  time: TimeOfDay;
  timezone: string;              // IANA tz name, e.g. "America/Los_Angeles"
  useBrowserTimezone: boolean;   // when true, `timezone` is derived from Intl.DateTimeFormat().resolvedOptions().timeZone, not user-picked
  developerMode: boolean;        // Collapsible open/closed
  rawCronOverride: string | null; // non-null only after the user has typed directly into the dev-mode cron field; overrides the picker-derived cron
}
```

**Default state on new Schedule Trigger card creation:** `frequency: 'daily'`, `time: { hour12: 9, minute: 0, meridiem: 'AM' }`, `timezone` = browser timezone, `useBrowserTimezone: true`, `developerMode: false`, `rawCronOverride: null`. Weekly Digest template pre-seeds `frequency: 'weekly'`, `weeklyDays: [1]` (Monday), same default time — this is what makes "create a workflow from the Weekly Digest template" produce a working schedule out of the box (Section 7's primary repro).

### 3.2 Pure functions (unit-testable in isolation, no React/DOM dependency)

All three live in a new file `app/src/lib/scheduleConfig.ts` (pure TS, mirrors the existing pattern of `app/src/lib/workflowCanvas.ts` being pure/unit-testable separate from the page component).

```ts
/**
 * Maps picker state to a 5-field cron string consumable by backend/src/lib/cron.ts's
 * cronMatches(). Must never be shown to the user directly unless developerMode is on
 * (design principle: cron is an implementation detail).
 *
 * If `rawCronOverride` is non-null, it is returned verbatim (developer-mode escape
 * hatch bypasses the picker-to-cron mapping entirely).
 */
function buildCronFromConfig(config: ScheduleConfigState): string;

/**
 * Produces the plain-English preview line, e.g.:
 *   "every Monday and Wednesday at 9:00 AM Pacific Time"
 *   "the first Monday of each month at 6:00 AM UTC"
 *   "every 3 months starting January at 6:00 AM Eastern Time"
 *   "Custom expression (not representable in picker)"  — when rawCronOverride is set
 *     AND does not correspond to any picker-representable state (see 3.5).
 */
function buildScheduleDescription(config: ScheduleConfigState): string;

/**
 * Computes the next fire time for a given cron string in a given IANA timezone.
 * Returns `null` if the cron is malformed (5-field validation, mirrors
 * backend/src/lib/cron.ts's own field-count guard) rather than throwing — the UI
 * must degrade to "Next run: unable to calculate" rather than crash the panel.
 *
 * Implementation note: this needs a real cron→next-occurrence walker, which
 * backend/src/lib/cron.ts does NOT provide today (cronMatches only tests a single
 * instant against a cron string; it has no "find the next matching minute" mode).
 * getNextRunFromCron() must implement its own forward-scan (bounded — e.g. scan
 * up to 366*24*60 minutes ahead and bail to null past that) using the same
 * parseField() semantics as backend/src/lib/cron.ts, OR (preferred, to avoid a
 * second independent cron-semantics implementation drifting from the backend's)
 * expose backend/src/lib/cron.ts's parseField()/cronMatches() as a shared package
 * import if the app can reach backend/src/lib code, OR port a minimal equivalent
 * into scheduleConfig.ts with an explicit code comment linking back to
 * backend/src/lib/cron.ts so the two are kept in sync by hand. Do not add a new
 * npm cron-parsing library (e.g. cron-parser) without checking with Nina first —
 * two different cron semantics implementations (frontend preview vs. backend
 * execution) that can disagree on edge cases (DOM+DOW "OR" semantics, see
 * cron.ts's comment on standard cron's restricted-both-fields behavior) is exactly
 * the kind of bug this rebuild is trying to eliminate. Minimum bar: whichever
 * approach is chosen, the frontend's "Next run" preview and the backend's actual
 * fire behavior must agree for every state the picker can produce.
 */
function getNextRunFromCron(cron: string, timezone: string, from?: Date): Date | null;
```

### 3.3 shadcn component mapping (exact, per field)

| Field | Component | Notes |
|---|---|---|
| "How often?" (Daily/Weekly/Monthly/Custom) | `ToggleGroup` (single-select), `ToggleGroupItem` × 4 | Default `Daily` |
| "On which days?" (weekly) | `ToggleGroup` (multiple-select), `ToggleGroupItem` × 7 | Min-1-selected validation: disable deselecting the last remaining item |
| Monthly variant radio | `RadioGroup` + `RadioGroupItem` × 3 | Default: "The 1st day of the month" |
| Monthly "1st–28th" picker | `Select` | Values 29–31 intentionally excluded from options (not just warned) — DESIGN.md's "⚠ skip warning" language describes values ≥29, but the cleanest fix per Scenario 2's spirit is to not offer months-with-gaps values at all in this variant; users needing day 29–31 should use "last day of the month" or accept the skip and see the warning. **Decision: keep DESIGN.md's literal spec — offer 1st–31st, show the skip warning for ≥29 — rather than truncating the Select options,** since some orgs may deliberately want "day 31, skips Feb/Apr/etc." Only diverge if Maya's product scope says otherwise. |
| Ordinal weekday (First/Second/.../Last × Mon–Sun) | Two `Select`s side by side | |
| Custom interval count | `Input type="number" min={1} max={365}` | |
| Custom interval unit | `Select` (Hours/Days/Weeks/Months) | |
| "Starting from next [Monday]" | `Select` (weekday) | Only rendered when `unit === 'weeks'` |
| Hour / Minute / AM-PM | `Select` (1–12) × `Select` (00/15/30/45) × `ToggleGroup` (AM/PM) | |
| "↕ Pick exact minute" | Ghost `Button` (link-styled) that swaps the 00/15/30/45 `Select` for a full 0–59 `Select` | Not a separate component — a local `exactMinute: boolean` toggle in the panel |
| Timezone picker | `Popover` containing `Command` (searchable list of IANA names) | The trigger button inside `Popover` shows the current selection, e.g. "America/Los_Angeles — Pacific Time (UTC−7)" |
| "Use my browser's timezone" / "Choose a timezone" | `RadioGroup` (2 options) | Gates whether the `Popover`/`Command` timezone picker is interactive or shows browser-derived value read-only |
| Live preview line | Plain text + `Badge`-style pill, not an input | Recomputed via `useMemo` on every field change per DESIGN.md's exact snippet (§2.4, lines 930–943) — lift that snippet's `useMemo` structure verbatim, just swap in the real function signatures from 3.2 |
| Developer mode toggle | `Collapsible` + `CollapsibleTrigger` (chevron "show ▾") | Closed by default |
| Cron expression field (inside Collapsible) | `Input` | On change, sets `rawCronOverride`; clearing the field (empty string) resets `rawCronOverride` to `null` and reverts to picker-derived cron |
| "Validates as: ..." helper line under cron input | Plain text, derived by feeding the typed cron through `buildScheduleDescription()`'s reverse-mapping attempt (3.5) | |

### 3.4 IANA timezone list source

Do not hand-roll a timezone list. Use `Intl.supportedValuesOf('timeZone')` (broadly supported in evergreen browsers; Node 20+ backend doesn't need it, this is client-only) to populate the `Command` list, formatting each entry's display label via `Intl.DateTimeFormat(undefined, { timeZone: tz, timeZoneName: 'short' })` to derive the "Pacific Time (UTC−7)"-style suffix DESIGN.md shows. No new npm dependency needed for this.

### 3.5 "Custom expression (not representable in picker)" behavior

When `rawCronOverride` is set (developer typed a cron directly) and `buildScheduleDescription()` cannot map it back to one of the picker's representable shapes (i.e., it doesn't correspond to a clean daily/weekly/monthly/custom-interval pattern the picker itself could have produced), the preview line must show the literal string `"Custom expression (not representable in picker)"` rather than attempting a partial/wrong English description. This requires `buildScheduleDescription()` to internally attempt the reverse mapping and fall back explicitly — do not guess. The picker's own controls (ToggleGroup frequency, weekday selects, etc.) should visually gray out / show a "picker disabled while custom cron is active" state while `rawCronOverride` is non-null, so the user isn't misled into thinking the toggle-group state still reflects the active schedule.

### 3.6 Card summary line binding

Per DESIGN.md §2.3's Schedule Trigger Card spec: Title = `buildScheduleDescription()` output capitalized appropriately (e.g. "Every Monday at 9:00 AM PT"), Summary = `"Next run: " + formatted(getNextRunFromCron()) + " · " + relativeTime(...)`. Both recompute on every config change via the same `useMemo` pattern as the panel's own preview line — the card and the panel must never show different next-run values, since they're driven by the same two pure functions.

### 3.7 Persisted config shape (what actually goes into `WorkflowNode.config` for the `time.schedule` trigger node)

```ts
// Persisted on the trigger node's `config` field (WorkflowNode.config in workflowEngine.ts)
{
  cron: string;                    // output of buildCronFromConfig() — this is what runScheduledWorkflows() reads today, unchanged
  // Everything below is UI-reconstruction metadata only — the engine never reads it,
  // but it MUST be persisted so re-opening the builder can rehydrate the exact picker
  // state (frequency/days/monthly/custom/time/timezone) rather than falling back to
  // "Custom expression" every time an existing schedule workflow is re-edited.
  scheduleUiState: ScheduleConfigState;
}
```

This is the single most important correctness requirement in this section: **without persisting `scheduleUiState`, every re-edit of an existing Weekly Digest schedule would show "Custom expression (not representable in picker)"** the moment the user reopens the builder, even though the schedule is perfectly representable — because `buildCronFromConfig`/`buildScheduleDescription` only have the derived `cron` string to work from on load, and reverse-engineering `0 9 * * 1` back into `{ frequency: 'weekly', weeklyDays: [1] }` is a lossy, error-prone operation (many picker states can produce the same cron; DESIGN.md doesn't ask for a cron-to-picker parser, only a picker-to-cron one). Elias: this is a schema note for whoever owns the `workflows` table's node JSON shape (Priya/Nina) — no migration needed since `nodes` is already `JSONB`, but this field must be included in whatever Zod schema validates the trigger node's `config` shape server-side, so it round-trips instead of being stripped.

---

## 4. Grouped Trigger Picker (C-001)

CUSTOMER_REVIEW.md's C-001 write-up specifies 5 groups (ALERTS / THRESHOLDS / AI SIGNALS / SCHEDULED / EVENTS) using the *canonical* trigger vocabulary that, per Section 0.1, doesn't match the real registry 1:1. Below is the same 5-group structure, remapped onto the actual 13 registry entries.

```
TRIGGER PICKER
"Pick the situation you want to automate. Not sure where to start? Try NPS Drop."

  ALERTS  (fires when something goes wrong)
    [gauge icon]        NPS Dropped              score.nps_drop
    [gauge icon]        NPS Rose                 score.nps_rise
    [heart-pulse icon]  Sentiment Spike Detected crystal.sentiment_spike     [Crystal]
    [alert-tri icon]    Anomaly Detected          crystal.anomaly_detected   [Crystal]
    [flag icon]         Verbatim Escalation       crystal.verbatim_escalation [Crystal]
    [siren icon]        Alert Fired               alert.fired

  THRESHOLDS  (fires when a number is reached)
    [flag-checkered icon] Milestone Reached        survey.milestone_reached

  AI SIGNALS  (Crystal detects these automatically)
    [sparkle icon]      New Emerging Theme         crystal.new_theme_detected  [Crystal]
    [sparkle icon]      Insight Ready              crystal.insight_ready       [Crystal]

  SCHEDULED
    [clock icon]        Time-Based Schedule        time.schedule

  EVENTS  (fires when something happens)
    [inbox icon]        Response Received          survey.response_received
    [filter icon]       Filtered Response (power)   survey.response_filtered
    [webhook icon]      Inbound Webhook             external.webhook
```

Notes on this remapping:
- `alert.fired` is placed under ALERTS (not a separate group) since CUSTOMER_REVIEW.md's own ALERTS description ("fires when something goes wrong") matches it more than any other group, and it has no natural home in the 5-group structure otherwise.
- `crystal.insight_ready` doesn't have a clean analog in CUSTOMER_REVIEW.md's original 10-trigger mapping (which had no such trigger) — placed under AI SIGNALS since it's Crystal-originated and non-deterministic like the other two entries there, and tagged `[Crystal]` for the same reason.
- `survey.response_filtered` is explicitly labeled "(power)" in its registry label already (`'Filtered response (power trigger)'`) — carry that qualifier into the picker label so users understand it's an advanced variant of Response Received, not a duplicate.
- There is no `manual` trigger and no `response_rate_drop`/`survey_lifecycle` in the real registry (Section 0.1) — they are absent from this picker. If product wants them, file against `workflowRegistry.ts`, not this spec.
- 13 real triggers across 5 groups (6/1/2/1/3) vs. CUSTOMER_REVIEW.md's 10 across the same 5 groups (4/1/1/1/3) — the ALERTS group is heavier here because the real registry has more Crystal-signal variety (`sentiment_spike`, `anomaly_detected`, `verbatim_escalation` are three distinct triggers, not folded together).

**`[Crystal]` badge convention:** exactly as CUSTOMER_REVIEW.md specifies — `text-xs bg-violet-50 text-violet-700 border border-violet-200 rounded-full px-2 py-0.5` (same token DESIGN.md already uses for the "✦ Crystal Signal" chip on response-trigger canvas cards, §2.3). Tooltip on hover: "Crystal Signals require a Growth plan. [Learn more]." — gate the actual tier-check against whatever plan/entitlement check the rest of the app uses (check with Maya/Nina if a `useEntitlements()`-style hook already exists before inventing a new one).

**Onboarding prompt:** the exact one-liner from CUSTOMER_REVIEW.md, 12px muted, above the grouped list: *"Pick the situation you want to automate. Not sure where to start? Try NPS Drop."* (adjusted from "NPS Drop or Rise" to "NPS Drop" since that's the more common first workflow per Scenario 1's own narrative — Elias/Maya's call if the exact original phrasing is preferred).

**Component:** `GroupedTriggerPicker.tsx` renders group headers (`text-xs font-bold uppercase tracking-wide text-gray-500`) + item rows, reusing `AddToCanvasPalette`'s existing drag-source mechanics (Section 2.2) — this is a rendering/grouping change to the Triggers section of the palette, not a new drag-and-drop system.

---

## 5. Cooldown / Workflow Settings Panel (C-004)

### 5.1 UI spec (exact, from CUSTOMER_REVIEW.md)

Shown in the right panel **by default when no card is selected** — i.e., `WorkflowSettingsPanel` and the "no-selection contextual help" text (DESIGN.md §2.4) are not mutually exclusive states to pick between; per C-004's explicit fix, the Workflow Settings panel (with the cooldown picker) **is** the no-selection default state, replacing DESIGN.md's plain "Select a card to configure it / Canvas tips" text with the more actionable settings panel. Keep DESIGN.md's canvas tips as a short collapsed footer inside this same panel rather than dropping them.

```
WORKFLOW SETTINGS

Cooldown period
How often can this workflow fire? Leave as "No cooldown" for workflows
that should fire on every matching event.

( ) No cooldown — fire every time
( ) 15 minutes
( ) 30 minutes
(●) 1 hour            (default)
( ) 4 hours
( ) 24 hours
( ) Custom: [ ___ ] minutes

ⓘ Suggested defaults by trigger type:
   NPS / Sentiment alerts:     4 hours
   New theme detected:         24 hours
   Response submitted:         No cooldown
   Scheduled:                  Not applicable
```

- `RadioGroup` + `RadioGroupItem` × 7 (six presets + Custom). Selecting "Custom" reveals an `Input type="number" min={0}` inline in the same row.
- The recommendation line (ⓘ) updates dynamically based on the **trigger card currently on the canvas** — remap the four example rows in the CUSTOMER_REVIEW.md text onto the real registry's groups from Section 4: `score.nps_drop`/`score.nps_rise`/`crystal.sentiment_spike` → 4 hours; `crystal.new_theme_detected`/`crystal.anomaly_detected`/`crystal.verbatim_escalation`/`crystal.insight_ready` → 24 hours; `survey.response_received`/`survey.response_filtered` → No cooldown; `time.schedule` → "Not applicable" (and the whole cooldown radio group should be disabled/grayed when the canvas's trigger is `time.schedule`, since CUSTOMER_REVIEW.md is explicit that "cooldown is irrelevant — the schedule itself is the throttle").
- If the canvas has no trigger card yet, show all six presets with no highlighted recommendation and the generic default (1 hour) pre-selected.

### 5.2 Cooldown status on the canvas / workflow card

Per C-004: "make the cooldown status visible on the workflow card during active cooldown." The `⏱ Cooldown` status pill already exists in DESIGN.md's token set (`--color-status-cooldown-bg` / `--color-status-cooldown-text`, confirmed present in `DESIGN.md` line 90–91) but I did not find an actual rendered cooldown pill anywhere in `WorkflowsPage.tsx` today (`STATUS_BADGE_VARIANT` maps `active/paused/draft/error/archived` only — no `cooldown` status value exists in the real `workflows_status_check` constraint either, see Section 0.2). Extend the pill exactly as specified: `"⏱ Cooldown — resets in 47 min"`, clickable, opens a popover: *"This workflow last fired at 2:17 PM. Cooldown is set to 60 minutes. It will be eligible to fire again at 3:17 PM. [Change cooldown →]"*. This is a `WorkflowsPage.tsx`/`WorkflowCard`-adjacent change, not part of the builder itself, but it consumes the same `cooldown_minutes` contract defined below — noting it here since it's the other half of C-004.

### 5.3 Exact contract the UI needs from the backend (for Nina — backend NOT designed here)

This section specifies **only the interface**, not the implementation, per the task brief. Nina owns the actual column/migration/enforcement logic.

**Field name and shape (workflow-level, not per-trigger-type):**
```ts
// On the Workflow type (app/src/types/index.ts) and the workflows table
cooldown_minutes: number | null;   // null / 0 = "no cooldown, fire every time"
                                    // this is a genuinely new column — it does NOT exist in
                                    // supabase/migrations/20260603000018_workflows_v2.sql or any
                                    // later migration as of this spec (verified). CUSTOMER_REVIEW.md's
                                    // claim that "the API already accepts cooldown_minutes" describes
                                    // ARCHITECTURE.md's aspirational schema, not the shipped one.
```

**What the builder UI sends on save:** the selected preset's minute value (`0 | 15 | 30 | 60 | 240 | 1440`) or the custom `Input`'s numeric value, as part of the same create/update payload the builder already sends (`POST /api/workflows` graph-shape body / `PUT /api/workflows/:id`) — i.e. one more top-level field alongside `name`, `triggerType`, `nodes`, `edges`, `status`.

**What the UI needs back to render "in cooldown" state**, on `GET /api/workflows` (list) and `GET /api/workflows/:id` (detail): a computed field, not a raw column the frontend derives itself (avoids clock-skew/timezone bugs in the client computing "resets in 47 min" from a raw `last_fired_at` + `cooldown_minutes`):

```ts
cooldown_status: {
  in_cooldown: boolean;
  cooldown_minutes: number;         // the configured value, echoed back for the settings panel to pre-select the right radio option on edit
  last_fired_at: string | null;     // ISO 8601
  cooldown_resets_at: string | null; // ISO 8601 — null when in_cooldown is false
} | null;  // null entirely when trigger_type === 'time.schedule' (cooldown not applicable)
```

**Enforcement contract (what Nina's engine change must guarantee, described from the UI's perspective only):** before a workflow's action chain executes in response to a matching trigger event, the engine must check "has this workflow fired within the last `cooldown_minutes` minutes?" and skip execution (recording a `skipped`/`cooldown` outcome, not silently dropping it — the run history / health summary (C-007, not in this spec's scope but adjacent) needs to be able to show "3 fires suppressed by cooldown this week" rather than those events vanishing with no trace). The exact mechanism (a `last_fired_at` timestamp check in `runWorkflowsForEvent`, a Redis-based check per CUSTOMER_REVIEW.md's own SECURITY_REVIEW.md reference to "defense-in-depth... Redis... `last_fired_at` timestamp per workflow," or a `cooldown_until` column a la the aspirational `ARCHITECTURE.md`) is Nina's design decision. The one hard UI requirement: **the check must happen before action execution, not just before trigger evaluation** — so that a workflow correctly shows as "would fire" in any future live-trigger-preview feature (C-010, out of scope here) while still being suppressed at execution time, matching CUSTOMER_REVIEW.md Scenario 3's hysteresis-vs-cooldown distinction.

---

## 6. 3D Placement — verdict

**Prior standing rule** (established in the NL Builder's thinking-state work, `WorkflowNLBuilderPage.tsx`'s `ThinkingCrystalAccent`): 3D belongs only where there is genuinely nothing to read yet — a moment of system latency/uncertainty where a decorative ambient signal ("Crystal is working") fills a void, rather than competing with content the user needs to parse.

Evaluating the two candidates named in the brief against that rule:

### 6.1 Right-panel no-selection / default state — **NO**

Per Section 5.1, this state is not empty — it's the `WorkflowSettingsPanel` (cooldown radio group + trigger-type-aware recommendations), which is real, information-dense, actionable content the user is likely to want to touch on first load (per Scenario 1's whole narrative: "the Workflow Settings panel shows a cooldown picker when the builder first loads, before Tom touches any other configuration"). Putting a 3D element here would directly contradict the fix this rebuild is shipping for C-004 — the entire point is that this state stopped being "nothing to read" and became the single most important piece of proactive guidance in the builder. Adding an orb or ambient animation next to a radio group the user needs to actually read and decide on would compete with it, not complement it. **No 3D here.**

### 6.2 Builder's initial empty-canvas state (zero cards placed yet) — **NO, with a narrow exception**

When a brand-new automation has zero cards, the canvas is visually empty — this is superficially the strongest candidate ("nothing to read yet"). But it fails the rule on a different axis: this state isn't a *system latency* moment (nothing is loading, nothing is being computed) — it's a *user action* moment. The correct design response to an empty canvas is to make the next action unmistakable (the palette should be visually emphasized, or a large "+ Drag a trigger here to start" dashed placeholder should occupy the canvas), not to add a decorative element that has nothing to do with the action needed. A 3D crystal floating in an empty canvas reads as "loading" or "AI is thinking," which is actively misleading here — there is no AI operation in progress; the user just hasn't dragged anything yet. This would violate the "readable at a glance" mandate by adding an element whose meaning (system-busy) contradicts the actual state (system-idle, waiting on user).

**Exception:** if the user arrives at this empty canvas via the Crystal Builder mode tab specifically *while Crystal is actively parsing their NL description* (the `thinking` view-state already implemented in `WorkflowNLBuilderPage.tsx`), that is a legitimate 3D moment — but it already exists, is already correctly scoped to the NL builder's thinking state, and this rebuild's route-swap architecture (Section 1.3) means the Unified Builder's canvas is never itself in a "Crystal is thinking with an empty canvas" state — that state belongs entirely to `WorkflowNLBuilderPage.tsx`, unchanged.

### 6.3 Overall verdict

**Zero new 3D placements in this rebuild.** The existing NL-builder thinking-state 3D accent stays exactly as-is (untouched by this spec). Every state this rebuild touches — the settings panel, the empty canvas, the config panels, the palette — has real content to read or a clear next action to signal, and 3D would dilute rather than clarify in each case. This is a deliberate, reasoned "no," not an oversight: the user's complaint about "no 3D" is really a complaint about visual richness and Tailwind/shadcn fidelity overall (flat cards, missing depth, no motion), which Section 2's card-hover/connector-draw-in/mode-switch-crossfade treatments address through the house animation system (`app/CLAUDE.md`'s `.card-tilt`/`.card-3d` hover treatments, Framer Motion draw-in, the CSS Crystal alternative) rather than through WebGL. Recommend applying the existing `.card-3d:hover` `translateZ(8px)` lift utility (already in the codebase per `app/CLAUDE.md`) to `CanvasCard` on hover — this gives the builder a tasteful "3D-adjacent" tactile feel without introducing a new WebGL surface, and is a much better answer to "this doesn't feel 3D/rich enough" than adding an ambient orb somewhere it doesn't belong.

---

## 7. Test Plan Pointers (for Kenji)

Concrete scenarios that must be covered, in addition to whatever general component/interaction tests Elias writes alongside the implementation (per `app/CLAUDE.md`'s testing rules — every new component needs a mirrored test in `src/__tests__/`):

1. **Weekly Digest template → cron correctness (the reported bug, now fixed):**
   - Create a new automation from the Weekly Digest template (whatever template-seeding mechanism exists — verify `?template=` param path pre-populates a Schedule Trigger card with `frequency: weekly`, `weeklyDays: [1]`, default time 9:00 AM).
   - Assert `buildCronFromConfig()` produces `"0 9 * * 1"` for that state.
   - Assert the Schedule Trigger card's title/summary line renders "Every Monday at 9:00 AM [tz]" and a concrete "Next run: [date]" — not a blank/placeholder value.
   - Save the workflow, reload the builder (edit mode), and assert the picker rehydrates to `weekly`/`Monday`/`9:00 AM` from `scheduleUiState` — not "Custom expression (not representable in picker)" (this is the specific regression Section 3.7 calls out).
   - Enable the workflow and assert `runScheduledWorkflows()` (real engine function, `backend/src/lib/workflowEngine.ts`) fires it at the computed cron time via `cronMatches()` — an integration-level test spanning frontend-produced cron string → backend engine execution, not just a frontend unit test.

2. **Monthly variants produce correct, distinguishable crons:**
   - "The 1st day of the month" → `0 <hh> 1 * *`.
   - "The first Monday of the month" → verify `getNextRunFromCron()` correctly skips non-first-Monday weeks (this variant cannot be expressed as a plain 5-field cron's DOM/DOW-alone semantics per `cron.ts`'s "OR when both restricted" rule — flag to Elias/Nina during implementation whether `buildCronFromConfig()` needs a documented limitation here, since standard 5-field cron genuinely cannot express "1st Monday of month" without emulation; this may require the engine-side `runScheduledWorkflows()` to do extra ordinal-week filtering beyond `cronMatches()`, which is a backend follow-up, not a frontend bug).
   - Day values 29–31 show the skip-warning copy and `getNextRunFromCron()` correctly skips February in a leap-year-aware way.

3. **Custom interval correctness:** "Every 2 weeks starting next Monday" produces a schedule whose `getNextRunFromCron()` output is exactly 14 days after the anchor date, not 7 or 13 (off-by-one on the starting weekday anchor is the likely failure mode).

4. **Developer mode escape hatch:**
   - Typing a valid-but-unusual cron directly (e.g. `*/15 9-17 * * 1-5`) into the dev-mode field sets `rawCronOverride`, and the preview line correctly reads "Custom expression (not representable in picker)" while the picker's own controls visually disable.
   - Clearing the raw cron field reverts to the last picker-derived state (not to the `daily` default) — verifies `rawCronOverride: null` doesn't destructively reset `frequency`/`weeklyDays`/etc.

5. **Grouped trigger picker renders all 13 real triggers in the right groups (not the 10-item canonical list from CUSTOMER_REVIEW.md verbatim):**
   - Snapshot/assert the picker's rendered group→trigger-type mapping against the table in Section 4 exactly — this test will catch drift if `workflowRegistry.ts`'s `TRIGGERS` array changes (add/remove a trigger) without a matching picker update, which is a realistic regression risk given the mismatch already found in Section 0.1.
   - Assert `[Crystal]` badge appears on exactly the 5 Crystal-origin triggers (`crystal.sentiment_spike`, `crystal.anomaly_detected`, `crystal.verbatim_escalation`, `crystal.new_theme_detected`, `crystal.insight_ready`) and no others.

6. **Cooldown field persists and round-trips (C-004):**
   - Set cooldown to "4 hours" in `WorkflowSettingsPanel`, save, reload in edit mode, assert the radio group re-selects "4 hours" (not silently reverting to the 1-hour default — a likely bug if the round-trip field name/shape doesn't match what Nina's backend returns).
   - Set "Custom: 90 minutes", save, reload, assert the Custom radio is selected AND the input shows `90`, not the nearest preset.
   - Select `time.schedule` as the trigger and assert the cooldown `RadioGroup` becomes disabled and shows "Not applicable" — and that this disabled state doesn't block saving the workflow (i.e., the disabled UI still sends a sane `cooldown_minutes` value, likely `null`, rather than omitting the field or sending a stale value from before the trigger switch).
   - This test needs Nina's backend contract (Section 5.3) implemented or mocked — coordinate timing with her so this isn't blocked waiting on a real column existing.

7. **Advanced: Branching Canvas hand-off still works (regression guard, not new behavior):**
   - From the new Unified Builder, click "Advanced: Branching Canvas" and assert the existing seed hand-off (`{ seed: { name, triggerType, rules } }`) still populates `WorkflowCanvasPage` correctly — this is exact existing behavior (`WorkflowBuilderPage.tsx`'s current `switchToCanvas()`), just relocated; a regression here would silently break the one escape hatch power users have for branching.

8. **Mode-tab route-swap preserves the "feels like a tab" requirement without state loss surprises:**
   - Switching from Visual to Crystal builder mid-edit (cards already on canvas) should not silently discard unsaved canvas state without warning — verify whatever confirmation/handoff Elias implements per Section 1.3's seed-passing approach actually carries the current cards into the NL builder's context (even if only as a "your visual progress: X trigger, Y actions" hint) rather than losing it outright with no indication.

---

## Summary of Key Decisions

1. **`WorkflowBuilderPage.tsx` is fully rewritten** as the 3-panel Unified Builder (card-stack canvas, not reactflow). `WorkflowCanvasPage.tsx` is untouched and reachable via a new "Advanced: Branching Canvas" link in the left panel — reuses the existing partial-seed hand-off already in the codebase.
2. **The NL builder is NOT merged inline.** `WorkflowNLBuilderPage.tsx` stays its own route; the Unified Builder's Crystal-tab click navigates to it with a shared header/tab-bar component and a cross-fade, giving the DESIGN.md "feels like a tab" effect without a risky state-lifting refactor of tested Wave 2/3 code. Flagged as an explicit, intentional divergence from a literal reading of DESIGN.md §2.6.
3. **Two real gaps between the design docs and the shipped system, both load-bearing for this spec:** (a) the actual `workflowRegistry.ts` has 13 triggers with different names than DESIGN.md/CUSTOMER_REVIEW.md's canonical 10 — Section 4 remaps C-001's grouping onto the real 13; (b) `cooldown_minutes` does not exist anywhere in the real `workflows` schema despite CUSTOMER_REVIEW.md claiming "zero backend changes" — Section 5.3 is a genuine new backend contract for Nina, not a wire-up.
4. **Schedule Trigger panel (Section 3)** is fully spec'd: state shape, three pure functions (`buildCronFromConfig`, `buildScheduleDescription`, `getNextRunFromCron`), exact shadcn mapping, and — the detail most likely to get missed — a `scheduleUiState` persistence requirement so re-editing an existing schedule doesn't degrade to "Custom expression" on every load.
5. **Five new shadcn components needed** (`RadioGroup`, `ToggleGroup`, `Popover`, `Collapsible`, `Command`), **all requiring new Radix/`cmdk` npm packages** — none are zero-dependency additions, contrary to a hopeful reading of "just copy the file." One new dependency also needed for `GenerateBriefingConfigPanel`'s drag-reorder (`@dnd-kit/core` + `@dnd-kit/sortable`).
6. **3D verdict: no new 3D placements.** Both candidate locations (empty right panel, empty canvas) fail the "nothing to read yet" test — the right panel is actually the busiest, most important default state in this whole rebuild (cooldown settings), and the empty canvas is a user-action moment, not a system-latency moment. Recommend the existing `.card-3d:hover` CSS utility on canvas cards instead, as a much better answer to the "make it feel richer" complaint than an ambient orb.

**Note on Maya's parallel scope doc:** `docs/automation-hub/BUILDER_REBUILD_SCOPE.md` did not exist when I started this work but was created by the time I finished. I read it in full. We independently arrived at the same core finding — cooldown is net-new (not a wire-up), the Weekly Digest schedule bug is the P0, and trigger grouping should use the real registry, not CUSTOMER_REVIEW.md's illustrative 10-item list — which is a strong cross-check. Three discrepancies worth surfacing rather than silently resolving:

1. **Trigger count mismatch: 12 vs. 13.** Maya's §2.2 groups a "real 12-trigger registry"; I count **13** live entries in `workflowRegistry.ts`'s `TRIGGERS` array (Section 0.1/4 above list all 13 by name). Her grouping table omits `crystal.insight_ready` entirely — it appears in neither her Alerts/Thresholds/AI Signals/Scheduled/Events breakdown nor anywhere else in her doc. I placed it under AI SIGNALS (Section 4). Elias/Kenji: reconcile against the actual array at build time (`grep -c "type:" workflowRegistry.ts`'s TRIGGERS block) rather than trusting either doc's count — this is exactly the kind of drift Section 7's test-plan item 5 is designed to catch going forward.
2. **Scope-boundary framing differs, likely without practical conflict.** Maya frames this pass narrowly as "finish three specific pieces that were speced but never shipped" (Schedule panel, trigger grouping, cooldown) and is explicit that list-page/RBAC/C-002/C-003/C-006-remainder are out of scope for this pass. My spec is broader in *architecture* scope (full builder rewrite: header, left/center/right panels, live preview strip, mode-tab relationship, Advanced Canvas link) because the task brief asked for an implementation-ready translation of the *entire* Unified Builder surface, not just the three gap items. These aren't in conflict — Maya's three items are a subset of what a full builder rewrite must include, and her sequencing (Schedule first, cooldown before trigger-grouping if forced to cut) is compatible with building the whole surface at once. Flagging only because if the actual build gets sliced into incremental PRs rather than one rewrite, Maya's priority order should govern slice sequencing, not the section order of this doc.
3. **Cooldown location agreement, minor wording difference.** Maya's §2.3 explicitly confirms cooldown lives in "the right panel's no-selection state," matching my Section 5.1 exactly — good independent convergence, no action needed, just noting it since it was a genuine judgment call (DESIGN.md itself doesn't say this) both of us made the same way.

No reconciliation blocks Elias from starting — the disagreement is a headcount-of-13-vs-12 discrepancy easily resolved by reading the source file, not a design decision split.
