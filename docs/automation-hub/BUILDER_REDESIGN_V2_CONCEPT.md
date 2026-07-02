# Builder Redesign V2 — Concept

**Author:** Rohan Desai (Principal Product Designer, Builder Experiences)
**Status:** Concept for Figma mockup — not implementation-ready yet (that's the next pass, after Figma review)
**Supersedes:** `DESIGN.md`'s "Surface 2: Unified Builder" (palette / canvas / config-panel 3-column
shell), as shipped in Wave 5 and rejected by direct stakeholder feedback on 2026-07-01.
**Figma file:** https://www.figma.com/design/MdnXeCcmoiHoGyNFikghnO (orchestrator builds from this doc)

---

## 0. What's being rejected, precisely

I read `WorkflowBuilderPage.tsx` and `WorkflowsPage.tsx` in full before writing a single word of
this doc, specifically so I wasn't going to accidentally re-derive the thing being rejected. Here's
what's actually there today, and why each of the three complaints is real, not a training/onboarding
problem:

**The builder (`WorkflowBuilderPage.tsx`).** A 56px header (name input + Save), then a 3-pane body:
a 256px-wide left palette (grouped trigger list, then a flat "add condition" button, then a flat list
of ~13 action buttons), a center scrollable card-stack canvas, and a 320px-wide right panel that
context-switches its contents based on whichever card is currently selected. Nothing is scoped to a
survey or tag anywhere — there is no such field in the `workflows` table at all (verified: the
`ALTER TABLE workflows` in `20260603000018_workflows_v2.sql` adds `nodes`/`edges`/`trigger_type` etc.,
no `survey_id`/`tag_id` column exists). Trigger and action selection live as two small lists buried in
a 256px sidebar the user has to already know to look at — nothing about the initial screen tells a
new user "start here."

**The list (`WorkflowsPage.tsx`).** Cards render a status badge, a trigger-count string, and — only
if the workflow happens to have a legacy flat `condition`/`action` shape — an "IF X THEN Y" sentence.
Graph-shaped workflows (the only kind the builder produces now) render no rule sentence at all, and
**no card anywhere shows scope**, because there is no scope data to show.

**Complaint-by-complaint, why this is structural, not cosmetic:**
1. *"Does not even have window to select source, actions."* — the palette is a persistent 256px
   sidebar sharing visual weight with "add condition" and a raw scrollable action list. Nothing marks
   trigger/action selection as the primary task of the screen; it reads as a secondary utility panel
   next to the "main" canvas.
2. *"How would I select which survey?"* — there is no UI for this because there is no data model for
   this. Not a bug in the existing builder; a missing capability end to end.
3. *"What if I do not want crystal summary, complete report on email"* — confirmed in
   `WorkflowBuilderPage.tsx`'s `ActionFieldPanel`: today's action config editor is a single `<Select>`
   for the action type, nothing else. `crystal.summarize`/`notify.email`/`notify.slack` all get the
   same bare dropdown. Zero content customization exists for any action type.

None of these are solved by rearranging the 3-panel shell. They require new information architecture.
That's what follows.

---

## 1. Chosen direction: **Option C — a hybrid of B and A, "Sentence-first, step-anchored"**

### Why not pure A (step-by-step wizard)

A wizard genuinely fixes complaints 1 and 2 — you cannot miss a full-screen "what should trigger
this?" step. But a strict linear wizard has a real cost for this product: workflows here are
frequently **edited**, not just created (edit-mode is a first-class path — `resolveEditRoute()`,
`isEditMode` branching, rehydration logic all exist because editing existing automations is common).
A wizard is great for the first 60 seconds of a *new* workflow and actively bad for "I already have
this workflow, I just want to change one action's Slack channel" — that forces a user back through
steps 1-2-3 to reach step 4, or requires a second, different edit-mode UI, which is its own kind of
inconsistency. Pure step-by-step also doesn't solve "understand immediately what this workflow is
about" for anyone glancing at a workflow they didn't build — a wizard has no resting state, it's
either mid-flow or gone.

### Why not pure B (recipe sentence, standalone)

The recipe-sentence idea is the single best answer to "understand immediately what this workflow is
about" — a sentence is legible at a glance in a way a canvas or a completed wizard never is, and it
works equally well as a *resting state* (view/edit) as it does as a *building* state (create). But a
sentence alone under-serves action content customization (complaint 3) — "then send email" as a
clickable blank is fine for *picking* the action, but the moment you need a 6-item section-toggle
checklist with a live preview, cramming that into an inline expansion under one word in a sentence
gets cramped and it stops reading as a sentence. It also under-serves multi-action chains (a real,
common shape here — e.g. Slack **and** email **and** tag responses from one trigger) since a sentence
wants to stay a sentence, not fan out into an AND-list of clauses that no longer reads as prose.

### The hybrid: sentence is the spine, each blank opens a full-focus step-panel to fill it in

The workflow is always represented as one always-visible, always-truthful sentence at the top of the
screen:

> **When** [ trigger ] **on** [ scope ] **then** [ action ], [ action ]... — **excluding cooldown**
> if set.

Every bracket is a pill. Empty pills say what's missing ("+ pick a trigger", "+ choose scope",
"+ add an action") in a visibly incomplete/dashed style, so an unfinished workflow is unmistakably
unfinished just from the sentence's shape — this alone kills complaint 1 (you cannot fail to notice
an unfilled "+ pick a trigger" pill sitting in the middle of the page's only sentence) and complaint 2
(scope is not a buried sidebar radio group, it's a mandatory clause of the sentence itself, and the
save button is disabled with an inline reason until it's filled).

Clicking any pill does **not** open a tooltip-sized inline popover (too small for trigger grouping,
scope disambiguation, or a 6-item section checklist) and does **not** navigate away to a separate
wizard-step route (loses the sentence, breaks the "always legible" property, and re-introduces the
edit-mode-vs-create-mode fork I rejected Option A for). Instead it opens a **full-width slide-down
step-panel directly beneath the sentence**, replacing the canvas/palette entirely while open. Think
of it as "the wizard step, but summoned per-blank instead of walked through linearly, and the sentence
above it never disappears." This is the actual novel piece of IA here: **the wizard's per-step focus
without the wizard's linear sequencing constraint** — you fill blanks in whatever order you want, each
one gets a full-focus screen while you're filling it, and the sentence is simultaneously the summary,
the navigation, and the completeness indicator, at all times.

This is a genuine departure from the rejected shell: no persistent 3-column layout, no palette
sidebar, no canvas, no card stack, no card-to-side-panel indirection. There is one page-level
artifact (the sentence) and one full-focus editing surface that appears per-blank and fully yields
the screen while active. Multi-action chains render as repeated "then [action]" clauses joined by
commas — the sentence degrades gracefully to a short list without becoming a canvas.

---

## 2. The workflow list page redesign

**Problem restated:** every card must show scope (Org-wide / Survey: `<name>` / Tag: `<name>`) as
unmissable, at-a-glance, first-class — not a tooltip, not buried text — and this is a genuine gap
today (no scope data exists in the schema at all).

### Visual treatment: a colored left-edge rail + leading scope chip, not just a badge

Badges alone (like today's status `Badge`) get lost in a card that already has a status pill, a
trigger-count string, and a trigger-label string competing for the same visual weight. Scope needs
to win that competition because it's the answer to the single question the user said they can't
answer. Two reinforcing signals, so it survives even a fast scan or partial color-blindness:

1. **A 4px colored rail down the entire left edge of the card** (not just behind an icon) —
   color-coded by scope *kind*, not by which specific survey/tag:
   - **Org-wide** → neutral slate rail (`var(--color-outline)` at full opacity) — deliberately the
     "quietest" of the three, since org-wide is the broadest/most-consequential blast radius and
     should not visually compete with more excitingly colored options; you want org-wide workflows to
     be sober, not decorative.
   - **Survey-scoped** → primary brand rail (`var(--color-primary)`) — the common case, gets the
     "default" brand color.
   - **Tag-scoped** → accent rail (`var(--color-accent)`, the purple token) — visually distinct from
     survey-scope at a glance since a tag can fan out to several surveys, a materially different
     blast radius than "one survey."
2. **A leading scope chip, first element in the card's top metadata row** (left of the status badge,
   not after it — first because it answers the highest-priority question) reading exactly one of:
   - `🌐 Org-wide` (icon: `public`)
   - `📋 Survey: CSAT Q3` (icon: `description`, truncates the survey name at ~24 chars with a
     tooltip for the full name)
   - `🏷 Tag: Onboarding` (icon: `sell`, shows the tag name; if the tag is a Program per
     `survey_tags.program_config`, append a small "Program" sub-label since that's a materially
     different cadence-driven object per the existing tags schema)

   The chip uses the *same rail color* as its background tint (e.g. survey-scope chip =
   `var(--color-primary)` at 10% opacity background, full-opacity text) — so the rail and the chip
   are visually the same statement made twice, once ambient (rail, catches peripheral vision scanning
   a long list) and once explicit (chip, catches a focused read of one card). This directly extends
   the file's existing `WORKFLOW_VISUALS`/`getVisuals()` per-card color convention rather than
   inventing an unrelated system — same idea (per-card identity color), repurposed to mean *scope*
   instead of arbitrary per-row variety.

3. Below the chip row, when scope is Survey or Tag, a **one-line breadcrumb-style subtext**:
   `Applies to responses from CSAT Q3` / `Applies to 4 surveys tagged "Onboarding"` — this is the
   sentence-affinity detail: even the list page borrows the builder's plain-English phrasing instead
   of a bare label, so the *voice* is consistent between "building" and "browsing" a workflow.

### Layout consequence

The existing card is a horizontal flex row (icon, then content column, then hover actions). The scope
chip becomes the **first** element of the content column's top metadata line, ahead of the existing
`Badge` (workflow-name badge) and status pill — literally first-in-reading-order, not decoratively
placed. The rail is a new `border-left: 4px solid <scope-color>` on the outer `Card`, replacing
nothing (doesn't conflict with the existing `hover:-translate-y-1`/box-shadow treatment).

### Empty/filter affordance

Add a scope filter chip-row above the card grid (`All`, `Org-wide`, `By survey ▾`, `By tag ▾`) so
"show me only workflows scoped to CSAT Q3" is a one-click filter, not a scroll-and-scan — this earns
its keep once an org has 20+ workflows across several surveys, which the current flat list has no
answer for at all.

---

## 3. The scope-selection moment in the builder

**When:** scope is the second clause of the sentence (`When [trigger] on [scope] then...`), and it is
**not optional and not skippable** — the Save action is disabled (with an inline reason chip: "Choose
who this applies to") until scope is set, exactly the same hard-gate treatment as trigger and at least
one action. Scope is promoted to a first-class sentence clause specifically because it was "buried in
a sidebar radio group" in spirit (nonexistent in practice) — giving it its own clause, not nesting it
inside the trigger step, makes it impossible to miss or intuit-past.

**How:** clicking the `[+ choose scope]` pill opens the full-focus step-panel with three big clickable
option cards, in this order:

1. **Org-wide** — icon `public`, subtext "Applies to every survey in your organization." Selecting it
   immediately resolves the step (no further sub-choice) and the sentence pill becomes `on Org-wide`.
2. **A specific survey** — icon `description`, subtext "Scope to one survey's responses." Selecting
   it expands a searchable survey picker inline in the same panel (reuses the existing survey
   search/list pattern from `SurveysListPage`, not a new component) — single-select, shows survey name
   + status + response count per row so the user can tell surveys apart at a glance. Sentence pill
   becomes `on Survey: <name>`.
3. **A tag / group** — icon `sell`, subtext "Scope to every survey sharing a tag (e.g. \"Onboarding\",
   \"Q3 NPS Program\")." Selecting it expands a tag picker (backed by the real `survey_tags` table) —
   single-select for v1 (multi-tag AND scoping is an explicit `TEAM.md` anti-goal already, consistent
   with "no multi-survey AND triggers"), each tag row shows how many surveys it currently maps to via
   `survey_tag_mappings` so the blast radius is visible before confirming ("Onboarding — 4 surveys").
   Sentence pill becomes `on Tag: <name>`.

Each option card also carries a one-line consequence statement under its subtext — e.g. "This
workflow will evaluate every response across the whole org" for Org-wide — so the choice isn't just
naming a scope, it's understanding its blast radius at the moment of choosing, which is exactly what
the user's underlying complaint was about (not being able to tell what a workflow touches).

**Data model note (flagged honestly, not hand-waved):** this requires new columns —
`workflows.scope_type` (`org` | `survey` | `tag`, default `org` for backward compat with existing
rows) and `workflows.scope_id` (nullable UUID, FK'd conditionally to `surveys.id` or `survey_tags.id`
depending on `scope_type`). The engine's trigger matching (`runWorkflowsForEvent`) needs a scope
filter added alongside its existing `trigger_type` filter — this is real backend work, not just a
frontend field, and should be scoped explicitly as its own workstream when this moves past concept
(likely Nina's territory, mirroring how she owned `cooldown_minutes` in Wave 5). I'm flagging this
here so the orchestrator doesn't discover it mid-Figma-review the way `cooldown_minutes`'s absence was
discovered mid-Wave-5.

---

## 4. Trigger and action selection

**Trigger — first sentence clause, `[+ pick a trigger]`.** Opens the full-focus step-panel with the
same 5 category groups the current `GroupedTriggerPicker` already organizes (Survey, Score, Crystal,
Alerts, Time, External per the real registry's `category` field) rendered as **large tappable tiles
in a grid**, not a scrollable list-with-headers — category is a visible section heading, each trigger
within it is a card with its label and a one-line plain-English description (e.g. `score.nps_drop` →
"NPS dropped" / "Fires when a response's NPS score is lower than a threshold you set"). This step-panel
occupies the full width the canvas/palette used to occupy — impossible to miss because for the
duration you're on this step, it *is* the screen, exactly Option A's core insight, just summoned
on-demand rather than walked through in forced sequence.

Selecting a trigger that needs config (`score.nps_drop` needs a threshold, `time.schedule` needs the
existing `ScheduleTriggerConfigPanel`) keeps you in the *same* step-panel — it doesn't kick you
forward to a new screen — showing the config form beneath the tile grid with the chosen tile now
highlighted/pinned at the top so you can still see and change your trigger choice without leaving the
step. "Done" collapses back to the sentence.

**Actions — repeated `then [+ add action]` clauses.** Same full-focus step-panel pattern, tile grid
grouped by the registry's action categories (Notify, Data, Crystal, Integration, Flow), each tile
showing the action label + a `live`/`stub`/`env` readiness indicator so a user picking
`crystal.summarize` (stub) or `jira.create_issue` (env-gated) sees that status honestly at
selection time instead of discovering it only after the workflow silently no-ops in production —
this is new relative to today's builder, which shows no readiness signal anywhere. Selecting an
action either resolves immediately (simple actions) or opens the content-customization sub-panel
described in §5 below, in the same step-panel, before returning to the sentence. Multiple actions are
added by re-opening `[+ add action]` after the first resolves — the sentence grows a new `, then
<action>` clause each time, keeping the whole chain visible and re-orderable (drag handles on each
action clause, reusing the already-installed `@dnd-kit` dependency from Wave 5 rather than adding a
new one).

---

## 5. Report/action content customization

This directly answers complaint 3. When the selected action is one of the "produces content" actions
(`notify.email`, `notify.slack`, `crystal.summarize`, or any future `report.*`/`crystal.write`),
choosing it opens a **two-column content-customization sub-panel** inside the same full-focus
step-panel (not a new screen, not the old 3-panel shell):

- **Left column — Section checklist.** This is the one idea I'm deliberately carrying over from
  `DESIGN.md`'s Unified Builder, because it's a sound interaction pattern independent of the shell it
  used to live in: a checklist of content sections the user can toggle on/off. For an email/report
  action, sections are things like `Crystal AI Summary`, `Key Metrics (NPS/CSAT)`, `Top Verbatims`,
  `Trend Chart`, `Recommended Actions`, `Raw Response Count`. Each has a checkbox, defaulting to a
  sensible preset ("Standard Digest" = summary + metrics + trend on; verbatims + raw count off), and a
  "Start from a preset ▾" dropdown (Standard Digest / Metrics Only / Full Detail / Custom) so a user
  who just wants "no Crystal summary" can either uncheck one box or pick "Metrics Only" and be done in
  one click — this is the literal fix for "what if I do not want crystal summary."
- **Right column — Live preview.** A scaled-down, realistic mock of the actual email/Slack
  message/report reflecting exactly the sections currently checked, updating live as checkboxes
  toggle — so the user sees the *consequence* of unchecking "Crystal AI Summary" immediately (the
  section visibly disappears from the preview) rather than trusting a checkbox label. For Slack, the
  preview renders as a mocked Slack message block; for email, a mocked email body; for
  `crystal.summarize` alone (no delivery channel), the preview shows the summary's own internal
  structure (which paragraphs/citations it will include).
- Below both columns, a collapsed **"Advanced fields"** disclosure (recipient list / channel name /
  subject line template) — the plumbing fields that exist today but shouldn't compete with the
  content decision for visual priority.

This sub-panel is action-type-aware (the per-action-type rich config panels Wave 5 explicitly
deferred — Slack/Email/Jira/In-App/NPS-Threshold — are exactly what this section-checklist + preview
replaces and finally delivers, closing that open follow-up from the tracker rather than leaving it
open a second wave in a row).

---

## 6. Full user journey — "Weekly NPS Digest to Slack + Email, scoped to CSAT survey, no Crystal summary"

**Screen 0 — Workflow list, empty state.**
Empty state per today's existing pattern (icon, heading, description, one CTA), CTA relabeled to
open directly into the new builder rather than a legacy "New Workflow Modal" dialog (that modal's
condition/action `<Select>` pair is itself a smaller instance of the same "not obvious what to pick"
problem — retiring it as part of this redesign, its one job is absorbed by the sentence builder's
first two clauses).

User clicks **"Create a workflow."**

**Screen 1 — Sentence builder, all blanks empty.**
Full width, centered, generous whitespace top-of-page:

```
Untitled workflow                                          [Save — disabled]

When  [+ pick a trigger]  on  [+ choose scope]  then  [+ add action]

                    ↓ (nothing else on screen yet — no canvas, no palette)
```

A small helper line under the sentence: "Fill in each blank to build your automation. Order doesn't
matter." — sets the "click any blank, any order" expectation immediately, since this is the part of
the model most different from both the old builder and a strict wizard.

User renames "Untitled workflow" → **"Weekly NPS Digest."**

**Screen 2 — Trigger step-panel (opened by clicking `[+ pick a trigger]`).**
Full-focus, sentence still visible/frozen at the top for orientation. Tile grid grouped by category;
user is going for a schedule, so under **Time** they see the `time.schedule` tile ("On a schedule
(cron)" / "Fires on a recurring schedule you define, like every Monday morning"). They click it.
The existing `ScheduleTriggerConfigPanel` UI appears beneath the tile grid (weekday/time/timezone
pickers — this component is reused as-is, it doesn't need reinventing, only rehousing). They pick
Monday 9am. Panel shows "Done" → collapses.

Sentence now reads: **When "Every Monday at 9:00 AM" on `[+ choose scope]` then `[+ add action]`.**

**Screen 3 — Scope step-panel (opened by clicking `[+ choose scope]`).**
Three option cards per §3. User clicks **"A specific survey."** Panel expands the survey search
list in place; user types "CSAT," sees "CSAT Q3" in the results with its response count, clicks it.
Consequence line shown before confirming: "This workflow will only consider responses from CSAT Q3."
"Done" → collapses.

Sentence now reads: **When "Every Monday at 9:00 AM" on Survey: CSAT Q3 then `[+ add action]`.**

**Screen 4 — First action step-panel (opened by clicking `[+ add action]`).**
Tile grid under **Notify**; user clicks `notify.slack` ("Slack message"). Because this is a
content-producing action, the two-column customization sub-panel (§5) opens directly under the tile
grid: left column shows the section checklist defaulted to "Standard Digest" (Crystal AI Summary ✓,
Key Metrics ✓, Trend Chart ✓, Top Verbatims ☐, Raw Response Count ☐); right column shows a live
mocked Slack message reflecting those three checked sections. User **unchecks "Crystal AI Summary."**
The preview updates immediately — the summary block visibly disappears from the mock Slack message,
leaving Key Metrics + Trend Chart. User expands "Advanced fields," sets the channel to `#cx-team`.
"Done" → collapses.

Sentence now reads: **When "Every Monday at 9:00 AM" on Survey: CSAT Q3 then Slack message
(`#cx-team`) `[+ add action]`.**

**Screen 5 — Second action step-panel.**
User clicks `[+ add action]` again (it re-appears after the first action resolves, at the end of the
growing action-clause list). This time picks `notify.email` under **Notify**. Same two-column
sub-panel opens; because this is a second, independent action, its section checklist starts from its
own default ("Standard Digest" again) rather than inheriting the Slack action's edited state — each
action's content is configured independently, since a Slack message and an email may reasonably want
different levels of detail. User again unchecks "Crystal AI Summary" (consistent with the ask: no
Crystal summary "on the email or somewhere," i.e. nowhere), leaves Key Metrics + Trend Chart on, adds
Top Verbatims this time (email has more room than a Slack message), sets recipients under Advanced
fields. "Done" → collapses.

Sentence now reads: **When "Every Monday at 9:00 AM" on Survey: CSAT Q3 then Slack message
(`#cx-team`), Email (`cx-team@...`).**

**Screen 6 — Review moment (not a separate screen — the sentence itself, now fully resolved).**
Because every clause is filled, the sentence itself becomes the review surface: no separate "Step 4:
Review & Customize" screen is needed (this is a direct efficiency win of the hybrid vs. pure Option A
— the completed sentence already *is* a review). The Save button un-disables. A small **"Preview full
run"** link beneath the sentence lets the user re-open either action's live preview read-only without
re-entering edit mode, for a final look. User clicks **Save.**

**Screen 7 — Back on the workflow list.**
The new "Weekly NPS Digest" card appears with: a **primary-brand-colored left rail** (survey scope),
a leading chip `📋 Survey: CSAT Q3`, subtext "Applies to responses from CSAT Q3," the plain-English
schedule description ("Every Monday at 9:00 AM"), and a compact summary of its two actions ("Slack
`#cx-team`, Email"). Scope, trigger, and actions are all visible on the list card without opening
anything — closing the loop on "helps customers understand immediately what this workflow is about"
for every future visit to the list, not just during creation.

---

## 7. Component/interaction inventory (for the Figma pass)

**New screens/states:**
1. `SentenceBuilderShell` — the persistent page frame: header (name input, scope/trigger/status
   summary strip optional, Save button with disabled+reason state), the sentence itself, helper text.
2. `SentencePill` — 4 visual states: *empty* (dashed border, muted "+ label" text, e.g.
   "+ pick a trigger"), *filled* (solid pill, resolved label, e.g. "Every Monday at 9:00 AM"),
   *filled + editable-on-click* (hover affordance, small pencil icon on hover), *invalid/warning*
   (e.g. a trigger that needs a scope-dependent field not yet resolvable — amber outline).
3. `StepPanel` — the full-focus slide-down surface. Header: back-to-sentence chevron + which clause
   is being edited ("Choosing your trigger"). Body: category-grouped tile grid (reused for trigger
   AND action selection — same component, different data source) OR the 3-option scope cards (§3).
   Footer: "Done" (enabled once a valid selection exists) / "Cancel" (discards, collapses without
   changing the pill).
4. `TriggerTile` / `ActionTile` — card in the grid: icon, label, one-line plain-English description,
   for actions also a small readiness dot (green=live, amber=stub, gray=env-gated) with a tooltip
   explaining what that means.
5. `ScopeOptionCard` — the 3 big cards (Org-wide / Survey / Tag) with icon, label, subtext,
   consequence line; Survey/Tag variants expand a search-and-select list inline when clicked.
6. `ContentCustomizationPanel` — two-column: `SectionChecklist` (preset dropdown + checkboxes) on
   the left, `LivePreviewMock` (Slack-message-shaped / email-shaped / summary-shaped, switched by
   action type) on the right, `AdvancedFieldsDisclosure` (collapsed by default) beneath both.
7. `ActionClauseList` — the repeated `, then <action>` clauses after the first action, each
   removable (x) and drag-reorderable (`@dnd-kit`, already installed), each independently
   re-openable back into its own `ContentCustomizationPanel`.
8. `WorkflowListCard` (redesign of the existing card) — adds the left scope rail, leading scope chip,
   and scope subtext ahead of the existing status/trigger-count/rule-sentence row; everything else
   (hover quick-actions, run stats, success rate) is retained as-is, this is additive, not a rewrite
   of the whole card.
9. `ScopeFilterBar` — new row above the card grid on the list page: `All / Org-wide / By survey ▾ /
   By tag ▾` chip filter.

**Rough layout notes (not pixel-precise):**
- `SentenceBuilderShell` is centered, roughly `max-w-4xl`, generous top padding — deliberately not
  edge-to-edge like the old 3-panel shell, since a sentence reads better as a contained block than a
  full-width canvas.
- `StepPanel` takes over the area below the sentence at full content width (same `max-w-7xl` outer
  bound as the rest of the app, per `app/CLAUDE.md`'s page pattern) — it is the only thing on screen
  below the frozen sentence while open, no palette/canvas remnants beside it.
- Tile grids inside `StepPanel`: `grid-cols-1 md:grid-cols-2 lg:grid-cols-3`, category headings as
  `label-caps` section dividers, consistent with the existing design system's section-heading
  convention rather than inventing new heading styles.
- `ContentCustomizationPanel`'s two columns: `grid-cols-1 lg:grid-cols-2 gap-6`, checklist left /
  preview right (preview collapses beneath the checklist on mobile/tablet per the project's
  responsive rules).
- Motion: `StepPanel` mounts/unmounts with the house entrance curve
  (`{ opacity: 0, y: 16 } → { opacity: 1, y: 0 }`, `ease: [0.22, 1, 0.36, 1]`, per `app/CLAUDE.md`),
  wrapped in `AnimatePresence` so opening one step-panel and closing it to open another doesn't jar.
  Section checkboxes toggling in `ContentCustomizationPanel` trigger a quick cross-fade on the
  affected block in `LivePreviewMock` (150–200ms) so the preview's reaction to a toggle reads as
  cause-and-effect, not a jump-cut.
- Color/rail treatment on `WorkflowListCard` and `SentencePill`/`ScopeOptionCard` reuses
  `var(--color-primary)` / `var(--color-accent)` / `var(--color-outline)` tokens (brand-reactive, per
  the three-layer cascade in `app/CLAUDE.md`) — never hardcoded hex for the scope-kind colors, since
  these need to survive a brand-theme override the same way every other brand-reactive surface does.

---

## 8. What this concept deliberately does NOT solve yet (flagged, not hidden)

- **No `scope_type`/`scope_id` columns exist on `workflows` today.** This concept assumes they will
  be added (§3's data model note) — that is real backend schema + engine-matching work, not a
  frontend-only change, and should be scoped as its own item before Figma-to-code, not discovered
  mid-build the way `cooldown_minutes` was in Wave 5.
- **Branching/canvas workflows** (the separate `WorkflowCanvasPage`/graph-branching surface) are out
  of scope for this redesign — this concept only replaces the *linear* builder
  (`WorkflowBuilderPage`). The "Advanced: switch to branching canvas" escape hatch should still exist
  somewhere (today it's a text link in the palette sidebar); in the new IA it likely lives as a small
  secondary action near the Save button ("Need branching logic? Use the canvas builder →") rather than
  inside the sentence itself, since branching genuinely can't be expressed as one sentence — but the
  exact placement is a detail for the Figma pass, not resolved here.
- **NL Builder integration** (`WorkflowNLBuilderPage`, its own route) — this concept doesn't address
  whether/how NL-built workflows land in this new sentence UI for editing; presumably a
  natural-language-parsed workflow should open directly into the fully-resolved sentence (skipping
  the empty-state screen), but that hand-off isn't spec'd here and should be confirmed with whoever
  owns that surface next.
- **Content customization for non-content actions** (`data.tag_responses`, `jira.create_issue`,
  `flow.approval`, etc.) still need their own simple field forms — §5's two-column pattern is
  specifically for content-producing actions; other action types keep a simpler single-column config
  form (still inside the same `StepPanel`, just without the preview column).
