# Builder Redesign V2 — Scope & Root-Cause Validation

**Author:** Maya Okonkwo (Staff PM, Workflow Automation)
**Date:** 2026-07-01
**Status:** Validation complete. Ready for Rohan's from-scratch visual concept.
**Trigger:** User re-tried the just-shipped Wave 5 builder and rejected it on three
concrete points (verbatim below). This doc root-causes each against the actual shipped
code (not the design docs, not agent self-reports) and sets requirements for a
genuine from-scratch redesign — **not** an iteration on Wave 5 or on `DESIGN.md`.

---

## The three complaints, verbatim

1. "Does not even have window to select source, actions."
2. "How would i select which survey?"
3. "What if i do not want crystal summary, complete report on the email or somewhere."

---

## 1. Root cause per complaint

| # | Complaint | Root cause | Category |
|---|-----------|-----------|----------|
| 1 | No visible window to pick trigger/actions | Palette **exists** and is wired (`GroupedTriggerPicker` + action list in `WorkflowBuilderPage.tsx` lines 289–321), but it is visually inert: `w-64` (256px) grey sidebar, `text-xs uppercase text-gray-500` section labels, ungrouped small ghost buttons with 14px icons, no card/panel framing, no color, no empty-state call-to-action. It reads as a nav sidebar, not "the place you build your automation." | **(c) Exists but not discoverable** — a visual-prominence failure, not a missing feature. |
| 2 | No way to select which survey | There is **no scope concept anywhere in the product** — not hidden, not deprioritized, not present. No `survey_id`/`scope` column on the `workflows` table, no field on the `Workflow` TS type, no scope UI in the builder or the list page, and no backend acceptance of a scope value on create/update. | **(a) Missing data-model capability** — the most structural of the three. See §2. |
| 3 | No control over email/report content (e.g. drop Crystal summary) | `GenerateBriefingConfigPanel` — the component `DESIGN.md` and `CUSTOMER_REVIEW.md` both specify for exactly this ("Sections list... toggle switch... Required sections have their toggle disabled") — was never built, in any wave. Wave 5 shipped a generic `ActionFieldPanel` that is a single `<Select>` for action *type* only. Zero content/section control exists for any action type (email, Slack, Jira, in-app). | **(b) Missing frontend feature** — the backend/config-shape question is open (no `GenerateBriefingConfigPanel`-shaped config has ever been persisted), but this is squarely a UI gap, not a data-model gap: the action `config` JSONB column can hold whatever shape a real panel would send. |

**Read across all three:** two are real capability gaps (#2 structurally, #3 at the
UI layer) and one is a visibility/IA failure (#1). None of the three are "already
fine, user just missed it" — every complaint maps to a genuine, verifiable gap.

---

## 2. Scope selection (complaint 2) — the structurally important one

**Finding: there is no scope concept at any layer of the stack today.**

- **Database:** `supabase/migrations/20240101000000_initial.sql` creates `workflows`
  with `org_id, name, condition, action, status, trigger_count, created_by,
  created_at, updated_at`. `20260603000018_workflows_v2.sql` adds graph fields
  (`trigger_type`, `nodes`, `edges`) and templates but still only indexes on
  `org_id`. `20260701100000_workflow_cooldown.sql` adds cooldown columns. **No
  migration, ever, adds a `survey_id`, `scope_type`, or `scope_tag` column to
  `workflows`.**
- **Backend:** `backend/src/routes/workflows.ts` reads/writes `workflows` with
  plain `SELECT * ... WHERE org_id = $1` / a fixed `INSERT INTO workflows (org_id,
  name, condition, action, created_by, description, trigger_type, nodes, edges,
  status, cooldown_minutes)` — no scope column in the column list.
  `backend/src/schemas/workflows.ts`'s `createWorkflowSchema`/`updateWorkflowSchema`
  accept no scope field either. The one `survey_id: z.string().optional()` in that
  file belongs to `workflowSignalSchema` — the *inbound CrystalOS signal* payload
  (an unrelated internal contract), not the workflow entity itself. There is no
  path today for a client to tell the API "this workflow applies to survey X."
- **Frontend type:** `app/src/types/index.ts`'s `Workflow` interface has no scope
  field of any kind.
- **Frontend UI:** Neither `WorkflowBuilderPage.tsx` nor any file in
  `app/src/components/workflow-builder/` (or `panels/`) renders a scope selector.
  `WorkflowsPage.tsx`'s cards render trigger label, status, run stats — never
  scope.
- **This was spec'd and then dropped, not overlooked from day one.** `DESIGN.md`
  explicitly designs for this: a `ScopeBlock` component (`components/automations/
  builder/ScopeBlock.tsx`, "Scope radio + pickers"), a scope tag shown on every
  card (`[Survey: CSAT Q3 2026]` / `[Org-wide]`), a scope selector in the Crystal
  NL builder flow, and `scope_survey_id`/`scope_type`/`scope_tag` fields threaded
  through to templating (`{{scope_label}}`, `'__SURVEY_SCOPE__'` variable).
  Wave 5's tracker entry does not mention scope at all — it is not on the
  "explicitly deferred" list alongside the per-action panels and NL tab
  integration; it simply never entered scope for that wave.

**Why this outranks Wave 5's cooldown gap:** the cooldown gap was "a config value
existed in the design doc but not the schema" — additive, low blast radius, fixed
in one migration with no consumer-facing model change. Scope is different in kind:
it changes what a `workflow` *is* (a global rule vs. an entity bound to a survey or
tag group), touches the trigger-evaluation path (does a `response.created` event on
survey A even reach a workflow scoped to survey B?), the list page, the builder,
templates, and Crystal's NL builder and action-proposal `create_workflow` flow. This
is a data-model decision, not a UI add-on, and should be scoped as its own workstream
before Rohan's visual redesign locks in a builder layout that assumes scope is a
simple picker bolted onto the existing shape.

**Immediate ask for the redesign to be viable:** confirm with backend/data-model
owner whether `workflow_signal`/trigger evaluation is currently survey-aware at all
(e.g. does an NPS-threshold trigger fire per-survey or per-org today?). If triggers
are already implicitly org-wide only, adding survey scoping is not just a UI+column
change — it changes trigger-matching semantics in `workflowEngine.ts`. This needs a
backend spike, not just a migration, before UI work locks a design around it.

---

## 3. Report/action customization (complaint 3)

**Finding: zero content control exists on any shipped action config panel.**

`WorkflowBuilderPage.tsx`'s `ActionFieldPanel` (lines 393–408) is the entirety of
action configuration today:

```tsx
function ActionFieldPanel({ card, actionDefs, onChange }) {
  return (
    <div className="space-y-3">
      <p>...ACTION...</p>
      <Select value={card.action} onValueChange={(v) => onChange({ action: v })}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>{actionDefs.map(...)}</SelectContent>
      </Select>
    </div>
  );
}
```

This lets a user pick *which* action (Email, Slack, Jira, In-App, etc.) but exposes
no fields at all for that action's content — no recipients, no subject, no body,
and critically **no section-level control** over what a "Generate Briefing"/report
action includes. `EmailActionConfigPanel`, `SlackActionConfigPanel`,
`JiraActionConfigPanel`, `InAppActionConfigPanel`, and `GenerateBriefingConfigPanel`
do not exist anywhere in `app/src/` — confirmed by search; the only place those
names appear is as code comments in `WorkflowBuilderPage.tsx` documenting what was
deferred, and as component paths in `DESIGN.md`.

`DESIGN.md` (§ "Generate Briefing Config Panel", around line 990–1015) already
specifies the exact fix for this complaint:
- A **Sections list** — draggable, each section with a toggle switch and label,
  where `Crystal Summary` and `Recommendations` are `required` (toggle disabled +
  lock icon) but everything else (Top Themes, Moments That Mattered, Response
  Velocity Chart, etc.) is optional and off/on by the user.
- A mini live email preview that updates when sections are toggled.
- A separate "Deliver via Email" panel for recipients/subject/format, decoupled
  from section content.

**This is a pure UI gap.** The action `config` JSONB column has no fixed shape —
whatever a real panel sends is what gets persisted and (presumably) read by the
workflow-execution/report-rendering side. No backend blocker was found for this
one; the fix is "build the panel," not "add a column." (Backend should confirm the
report-rendering consumer actually reads a `sections` array from `config` — that
consumer was out of scope for this validation pass and should be verified before
Rohan finalizes the panel's exact field shape.)

---

## 4. Trigger/action visibility (complaint 1) — grounded in the actual JSX

The palette is real and functional, but structurally under-weighted relative to the
canvas and right panel:

- **Width and framing:** left panel is `w-64` (256px) flat `border-r`, no
  background differentiation, no card/section chrome — visually it is the same
  weight as a settings sidebar, not a "pick your building blocks" workspace.
- **Typography hierarchy is inverted:** section headers (`workflows.builder.unified.
  palette.triggersHeading`, etc.) use `text-xs font-bold uppercase tracking-wide
  text-gray-500` — i.e., the *labels* for "Triggers" and "Actions" are deliberately
  low-contrast gray, smaller and dimmer than the items underneath them.
- **Trigger items:** `GroupedTriggerPicker` renders each trigger as a `w-full
  ... text-sm` ghost button with a 16px icon — functionally discoverable once a
  user is already looking at that 256px column, but nothing pulls the eye there on
  first load. There's no default/first-run affordance (e.g., an arrow, a "Start
  here" callout, or an empty canvas state prompting "← choose a trigger").
- **Action items:** even plainer than triggers — 14px `add` icons, no grouping,
  no icons distinguishing Email/Slack/Jira/etc., just a flat list of text labels
  (lines 302–314).
- **Competing visual weight:** the center canvas (`BuilderCanvas`/`CanvasCard`)
  has color-coded 3px top borders, `.card-3d` hover depth, and rounded shadow
  cards — meaningfully richer styling than the palette that's supposed to feed it.
  The right panel (320px, `ScheduleTriggerConfigPanel`/`WorkflowSettingsPanel`) is
  wider than the left palette (320px vs 256px) despite the palette being the
  entry point for a brand-new workflow.
- **No entry-state guidance:** on a blank builder (`cards = []`), the center
  canvas and `LivePreviewStrip` both render minimal/empty placeholders
  (`workflows.builder.unified.livePreview.empty`) with no visual arrow or prompt
  pointing back at the left palette as "start here."

**Conclusion:** complaint 1 is category (c) — an IA/visual-hierarchy problem, not
a missing feature. The redesign should treat "where do I start" as a first-class
design problem (onboarding-style emphasis on the palette, not just correct wiring).

---

## 5. Prioritized redesign requirements

Concrete and testable, for **both** the builder and the workflow list page.

### P0 — Scope (structural, blocks the other two conceptually)
- [ ] `workflows` table gains a scope concept: `scope_type` (`org` | `survey` |
      `tag_group`, default `org` for backward compatibility with every existing
      row) + `scope_survey_id` (nullable FK to `surveys`) + `scope_tag` (nullable).
- [ ] `createWorkflowSchema`/`updateWorkflowSchema` accept and validate scope
      fields (survey-scoped requires `scope_survey_id`; tag-scoped requires
      `scope_tag`; org-scoped requires neither).
- [ ] Backend spike (pre-UI): confirm/define whether trigger evaluation in
      `workflowEngine.ts` is currently capable of being survey-aware; if not, that
      logic must be extended so a survey-scoped workflow actually only fires for
      that survey's events — otherwise the scope field is cosmetic and misleading.
- [ ] Builder: a scope selector is present **before or alongside** trigger
      selection, not buried in a settings panel — org-wide / specific survey
      (searchable survey picker) / tag group (existing tag-group picker reused
      from elsewhere in the app, e.g. `survey-tags` API).
- [ ] **List page: every workflow card displays a scope badge (`Org-wide` /
      `Survey: <name>` / `Tag: <name>`) without requiring a click** — this is the
      user's explicit ask ("helps customers understand immediately... Is it Org,
      Tag, Survey level"). Testable: render a card for each of the 3 scope types
      and assert the badge text is present in the initial DOM, no interaction
      required.
- [ ] List page: scope is filterable (e.g. "Show: All / Org-wide / This survey").

### P0 — Trigger/action selection visibility
- [ ] The trigger/action selection surface must be the visually dominant element
      on first load of a new/empty workflow — not a same-weight sidebar item.
      Testable: in a blank builder, the palette region occupies more visual
      weight (measured by rendered width/color contrast, not just DOM presence)
      than the empty canvas or settings panel.
- [ ] Section headers for Trigger / Condition / Action must not be lower-contrast
      or smaller than the items they label (reverse Wave 5's `text-gray-500
      uppercase text-xs` treatment for headers-over-content).
- [ ] Action list must be groupable/searchable once the registry grows past a
      handful of types (mirroring the trigger grouping that Wave 5 already got
      right for triggers — carry that pattern to actions).
- [ ] A blank-canvas state must visually direct the user back to the
      trigger picker (e.g., explicit "1. Pick a trigger →" prompt), removing any
      ambiguity about where to begin.

### P0 — Report/action content control
- [ ] Every action type that sends content externally (Email, Slack, Jira,
      in-app announcement, "Generate Briefing") exposes a real config panel with
      actual content fields — not a bare type-select.
- [ ] For report/briefing-shaped actions specifically: a Sections list where each
      section (Crystal Summary, Top Themes, Moments That Mattered, Recommendations,
      Response Velocity Chart, etc.) has an independent on/off toggle. Some
      sections may be marked required (locked toggle, visually distinct from
      optional ones) but **Crystal Summary must be an optional, toggleable
      section, not implicitly required** — directly answering the user's
      complaint that they want to be able to drop it.
- [ ] Section toggle state persists in the action's `config` and is honored by
      whatever renders the actual email/report (verify this consumer exists /
      define it if it doesn't — flagged as an open item, see §3).
- [ ] A live/preview affordance (does not need to be a pixel-perfect render) shows
      the user what will be included before they save, so "what's in this email"
      is answerable without sending a test.

### P1 — Consistency / carry-through
- [ ] Scope badge and section-toggle state both surface in run history / test
      results context (e.g., a test-run result should be legible as "ran against
      Survey X" when scope is survey-specific).
- [ ] NL builder (Crystal-driven `create_workflow` proposals) must also set scope
      explicitly — either by inferring it from conversation context or by asking —
      not silently defaulting to org-wide. (`DESIGN.md`'s NL builder scope-inference
      card, e.g. "I couldn't identify a single survey, so I set scope to all CSAT
      surveys," is a reasonable pattern to reuse for behavior, not layout.)

---

## 6. What NOT to carry forward from Wave 5

The user was explicit: **do not reuse the previous design.** This section
separates underlying data/behavior plumbing worth keeping from the visual/layout
decisions that must be abandoned.

### Keep (architecture/data, invisible to the redesign)
- The linear `CanvasCardState` model (`lib/builderCanvas.ts`) — trigger →
  condition → action as an ordered list — is a reasonable underlying shape for
  a *linear* builder and does not need to be re-litigated just because the visual
  layout changes. (If Rohan's concept moves to a graph/branching-first model,
  this should be revisited, but that's a UX decision, not something forced by
  today's complaints.)
- `scheduleConfig.ts` (`buildCronFromConfig`/`buildScheduleDescription`/
  `getNextRunFromCron`) — this solved a real, previously-broken bug (Weekly
  Digest scheduling) and is presentation-agnostic logic. Keep regardless of
  layout.
- The trigger registry grouping data (`lib/triggerGroups.ts`) — the *grouping
  logic* (which triggers belong to which category) is sound; only the *visual
  treatment* of that grouping in the sidebar needs to change.
- Cooldown as a workflow-level setting (backend contract) — unrelated to this
  redesign's complaints, no reason to touch it.

### Abandon (visual/layout — the actual subject of the complaints)
- **The fixed 3-panel (256px / flex / 320px) frame itself.** This exact
  proportion and framing is what produced complaint 1 (palette underweighted)
  and gave scope nowhere natural to live. Rohan should not start from "3 panels,
  adjust widths" — the panel-count and proportions should be a fresh decision.
- **Low-contrast gray-on-gray section headers in the palette** (`text-xs
  font-bold uppercase tracking-wide text-gray-500`) — directly contributed to
  the palette reading as secondary chrome instead of the primary workspace.
  Do not reuse this treatment for the redesign's equivalent labels.
- **The generic `ActionFieldPanel`/`ConditionFieldPanel` pattern** (a bare
  `<Select>` / raw `<Input>` triplet with no domain-specific fields) — this was
  always known as an interim stand-in, not a design choice; the redesign should
  design real per-action panels from `DESIGN.md`'s intent (adapted, not copied
  verbatim per the "no previous design" instruction) rather than extend the
  generic pattern further.
- **Treating scope as absent / an afterthought.** Wave 5's layout has no slot for
  it at all. Do not try to retrofit a scope picker into the existing right-panel
  `WorkflowSettingsPanel` treatment (small, collapsed-by-default, low visual
  priority) — scope needs first-class placement given how core it is to
  understanding a workflow, per the user's own framing.
- **List-page cards that bury identity in body text.** Today's `WorkflowsPage.tsx`
  card leads with a name badge and a status pill, with trigger type as small
  muted text and no scope indicator at all. The redesign's list card should be
  re-thought from "what does a user need to know before clicking anything" —
  scope and trigger should likely both be front-and-center, not the current
  hierarchy (name → status → trigger-as-afterthought).

---

## Summary for Rohan (redesign inputs)

1. **Scope is not a UI nice-to-have — it doesn't exist in the schema.** Loop in
   backend before finalizing any layout that assumes a scope value is always
   available; this may need its own migration + engine change landed first or in
   parallel.
2. **Report/action content control is a pure frontend build** — `DESIGN.md`'s
   Sections-list concept (draggable, some locked, Crystal Summary togglable) is
   directionally correct and can inform (not be copied into) the new design.
3. **Palette visibility is a hierarchy/emphasis problem**, fixable through layout
   and typography choices alone — no new capability needed, just don't repeat
   Wave 5's low-contrast, same-weight-as-everything-else treatment.
4. Treat this as three coordinated but independently-testable requirements, not
   one big "redesign the builder" ask — each has a distinct owner path (data
   model / frontend feature / visual design) and should be tracked that way in
   `docs/automation-hub/TRACKER.md` once Rohan's concept lands.
