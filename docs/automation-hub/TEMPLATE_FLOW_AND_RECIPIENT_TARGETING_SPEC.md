# Template Flow & Recipient Targeting — Spec

**Author:** Rohan Desai (Principal Product Designer, Builder Experiences)
**Status:** Ready for implementation (Elias)
**Date:** 2026-07-01
**Related:** `docs/automation-hub/BUILDER_REDESIGN_V2_CONCEPT.md`, `docs/automation-hub/XM_VERIFICATION_REPORT.md` (Nina's parallel backend security fixes — see Issue 2 §6)

This spec covers two confirmed, real gaps hit while using the product:

1. **"Use Template" creates a workflow with zero feedback** — fix: route into a builder pre-filled with the template, persist only on explicit Save.
2. **Email/in-app recipients can't target a role, department, group, or multiple people** — the current free-text field is dead code. Fix: a proper "Notify who?" targeting control, coordinated with Nina's backend `notify.email`/`notify.in_app` targeting work.

No code changes in this document — this is the spec Elias builds from.

---

## ISSUE 1 — "Use Template" navigation flow

### Root cause (confirmed)

`WorkflowTemplates.use()` in `app/src/pages/WorkflowsPage.tsx` (lines 616–627) calls `api.createWorkflowFromTemplate(tpl)` directly on button click — an immediate, real `POST /api/workflows` write. There is no navigation, no toast, no confirmation. The list silently refreshes via `invalidate('workflows')` and the user has to find their new draft themselves.

### Fix: navigate into a builder, persist only on Save

This is not a new mechanism — it's an extension of the **seed** pattern that already exists for two other cross-links in this codebase:

| Existing seed producer | Consumer | Shape |
|---|---|---|
| Linear builder → Canvas ("Advanced: Branching Canvas") | `WorkflowCanvasPage` | `{ name, triggerType }` (partial — `WorkflowBuilderPage.switchToCanvas()`, line 326) |
| NL builder → Canvas ("Edit in canvas" handoff) | `WorkflowCanvasPage` | `{ name, description, triggerType, nodes, edges }` (full — treated identically to an edit-mode fetch, `WorkflowCanvasPage.tsx` lines 107–116) |
| Edit existing workflow | `WorkflowBuilderPage` / `WorkflowCanvasPage` | `{ workflowId }` → page fetches and hydrates itself |

`WorkflowTemplate` (`app/src/lib/api.ts` line 245) already has the exact shape the "full" canvas seed wants: `{ slug, name, description, category, trigger_type, nodes: unknown[], edges: unknown[], is_featured }`. **No new seed shape is needed.** Templates map onto the existing `CanvasSeed` interface almost verbatim:

```ts
// CanvasSeed (WorkflowCanvasPage.tsx, existing — unchanged)
interface CanvasSeed {
  name?: string;
  description?: string;
  triggerType?: string;
  rules?: Rule[];
  nodes?: EngineNode[];
  edges?: EngineEdge[];
}
```

Template → seed mapping (trivial field rename, done at the "Use Template" click site):

```ts
{
  name: tpl.name,
  description: tpl.description,
  triggerType: tpl.trigger_type ?? undefined,
  nodes: tpl.nodes as EngineNode[],
  edges: tpl.edges as EngineEdge[],
}
```

### Routing decision: linear builder vs. canvas

Reuse `resolveEditRoute()` (`app/src/lib/workflowEditRoute.ts`) exactly as the "Edit" button on each workflow card already does (`WorkflowsPage.tsx` line 406) — do not invent a second routing rule:

```ts
const target = resolveEditRoute(tpl.nodes as EngineNode[], tpl.edges as EngineEdge[]);
navigate(target, { state: { seed: { name: tpl.name, description: tpl.description, triggerType: tpl.trigger_type ?? undefined, nodes: tpl.nodes, edges: tpl.edges } } });
```

`resolveEditRoute()` sends anything with `edges` carrying a `branch: 'true'|'false'` value, or more than one condition node, to `ROUTES.WORKFLOW_CANVAS`; everything else (the common case — straight-line trigger → optional single condition → ordered actions) goes to `ROUTES.WORKFLOW_BUILD` (the sentence builder).

**Gap to close in `WorkflowBuilderPage` (the linear/sentence builder):** its current `LocationState.seed` type is only `{ name?, triggerType? }` (line 42) — it does not consume `nodes`/`edges`/`description` at all. Most templates are linear (single trigger → 1–2 actions, no branches), so they'll route here, and the seed needs extending:

- Add `description?: string`, `nodes?: EngineNode[]`, `edges?: EngineEdge[]` to `WorkflowBuilderPage`'s `LocationState.seed`.
- On mount (same effect block at lines 101–117), when `seed.nodes` is present: parse it the same way `getWorkflow()`'s edit-mode fetch already does (lines 125–156) — walk `nodes`, find the `type === 'trigger'` node for `triggerType`/schedule config, map `type === 'action'` nodes into `ActionState[]` (reusing the existing `hasContentShape` branch that already distinguishes `contentConfig` shape from `simpleConfig`). This is a refactor-to-share, not new logic: extract the node-parsing block from the edit-mode `useEffect` into a shared `hydrateFromNodes(nodes)` helper, call it from both the edit-mode fetch and the template-seed branch.
- Set `description` from `seed.description` alongside `name`.

This is the only net-new frontend logic issue 1 requires — everything else is wiring against seed/routing mechanisms that already exist.

### What happens if the user navigates away without saving

**No-op — matches editing an existing workflow and cancelling.** Nothing was persisted by the "Use Template" click itself (that's the whole point of the fix); the builder page only calls `api.createGraphWorkflow()` when the user explicitly clicks Save (`WorkflowBuilderPage.save()`, line 313, or the canvas equivalent). Back button / route-away is already a plain unmount with no draft-persistence side effect anywhere in these builders today, so this falls out for free — no new "discard draft" confirmation dialog is needed for v1. (If Elias's testing finds users losing meaningful in-progress edits on accidental back-navigation, that's a separate, pre-existing builder-wide gap — not scoped to this fix — and should be filed separately rather than special-cased for templates.)

### Button relabel: "Use Template" → "Start from Template"

**Yes, relabel it.** "Use Template" reads as a completed action ("I used it, it's done"); "Start from Template" correctly frames it as the beginning of an editing session. This is a one-string change:

- Locale key `workflows.useTemplate` (`app/src/locales/en.ts`) — update string from "Use Template" to "Start from Template".
- Loading-state label `workflows.adding` ("Adding...") should also change since nothing is being "added" anymore — it becomes irrelevant: with no network round-trip blocking the button (navigation is instant), the transient disabled/spinner state (`usingSlug` in `WorkflowTemplates`) can be removed entirely. Clicking the button now just calls `navigate()` synchronously — no `async`, no loading state, no `try/catch`, no `finally`. This also deletes the now-unneeded `invalidate('workflows')` call on this path (no mutation happened, so no other view needs to know).
- Icon stays `add` — "start something new" is still the right affordance.

### Component/state breakdown for Elias

**`app/src/pages/WorkflowsPage.tsx` — `WorkflowTemplates` component:**
- Delete: `usingSlug` state, the `try/catch/finally` in `use()`, the `api.createWorkflowFromTemplate()` call, the `invalidate('workflows')` call, the `onUse` prop entirely (no longer needed — nothing changes on this page after the click).
- Replace `use(tpl)` with a synchronous `useTemplate(tpl)` that computes the seed and calls `navigate(resolveEditRoute(...), { state: { seed: {...} } })`.
- Button: remove `disabled={usingSlug === tpl.slug}` and the conditional label; always render `t('workflows.useTemplate')` (now "Start from Template").
- `WorkflowTemplates` no longer needs `onUse` — update its call site (`<WorkflowTemplates onUse={reload} />` at line 229) to `<WorkflowTemplates />`.

**`app/src/pages/WorkflowBuilderPage.tsx`:**
- Extend `LocationState.seed` type (line 42) to add `description?, nodes?: EngineNode[], edges?: EngineEdge[]`.
- Extract a `hydrateFromNodes(nodes: EngineNode[]): { triggerType, scheduleConfig, actions }`-shaped helper from the existing edit-mode fetch body (lines 129–155), reuse it in the `useEffect` at lines 101–117 when `seed.nodes` is present.
- Import `EngineNode`/`EngineEdge` types (already imported in `WorkflowsPage.tsx`, not yet in this file).

**`app/src/pages/WorkflowCanvasPage.tsx`:** no changes — its seed-consumption already fully handles `seed.nodes`/`seed.edges` (lines 107–116), since this is exactly the shape the NL-builder handoff already produces.

**Locale (`app/src/locales/en.ts`):** update `workflows.useTemplate` string; delete `workflows.adding` if unused elsewhere (grep before removing).

### States / screens

1. **Templates grid (unchanged visually)** — cards with name, description, featured badge, and now a "Start from Template" button.
2. **Click → instant navigation** (no loading spinner, no network wait) to either:
   - Sentence builder (`/workflows/build`) pre-filled with name, description, trigger pill, and action clauses already populated from the template — user sees a complete, editable sentence immediately.
   - Canvas builder (`/workflows/canvas`) pre-filled with nodes/edges laid out, for branching templates.
3. **User edits freely** (change trigger, add/remove actions, adjust scope) — this is a completely normal "new workflow" authoring session, just pre-seeded.
4. **Save** → `POST /api/workflows` fires for the first time here, exactly like any hand-built workflow. Same success path: `invalidate('workflows')` + `navigate(ROUTES.WORKFLOWS)`.
5. **Back/away without Save** → no-op, nothing was ever created, list page shows no new workflow (correctly).

---

## ISSUE 2 — "Notify who?" recipient targeting

### Root cause (confirmed, traced end-to-end)

1. `AdvancedFieldsDisclosure.tsx` renders a free-text `recipients` `Input` for `notify.email` (and a `channel` input for `notify.slack`).
2. `ContentCustomizationPanel.tsx` wires it into `ActionContentConfig.recipients?: string` (`contentSections.ts` line 79).
3. **`WorkflowBuilderPage.serialize()`** (line 279–293) builds each action node's `config` from `a.contentConfig` (for `CONTENT_PRODUCING_ACTIONS`, which includes `notify.email`) or `a.simpleConfig` — but nowhere does it read, transform, or forward `recipients`. Whatever the user types into that field is captured in React state, then silently dropped at serialization. It never reaches `POST /api/workflows`.
4. Even if it were wired up, the backend only reads `config.userId` — a single Xperiq user id (`backend/src/lib/workflowEngine.ts` line 240, `case 'notify.email'`) — not a free-text string, not multiple ids, not a role/department/group. **The field was never going to work even correctly wired**, because the backend's own contract for this action doesn't accept what the UI was asking for.
5. `notify.in_app` (same file, line 196–212) already supports plural targeting via `config.userIds: string[]`, with fallbacks to `ctx.recipientUserIds` / `ctx.event.targetUserIds` / the triggering user. Email never got the same treatment.
6. Nina's backend work (confirmed via inline comments dated 2026-07-01 in `workflowEngine.ts`, `XM_VERIFICATION_REPORT.md` Priority 1) already **removed** an unsafe `ctx.event.userId` fallback from `notify.email` specifically because it was a misdirection risk — reinforcing that this action needs an explicit, structured recipient, not a guessed one. Nina is separately extending both `notify.email` and `notify.in_app` to support `userIds` (plural), `roleId`, `departmentId`, `groupId`, resolved server-side via the existing Roles/Departments/Groups APIs.

### Design: "Notify who?" targeting control

Replaces the current free-text `recipients` field in `AdvancedFieldsDisclosure.tsx`, for **both** `notify.email` and `notify.in_app` (same underlying concept, same control, per the task brief — extend consistently rather than building two different UIs for the same idea).

#### Mode selector

Segmented control (not radio buttons — this codebase doesn't have a segmented-control primitive today; **recommend building it as 4 `Button variant="outline"`/`variant="default"`-toggled buttons in a `flex` row with `rounded-xl` group styling**, matching the visual language of `ScopeFilterBar` which already does exactly this pattern for filter-pill groups elsewhere in the workflows UI). Segmented control reads better than radio here because there are only 4 mutually exclusive, short-label options and it keeps the vertical footprint tight inside an already-collapsed `AdvancedFieldsDisclosure`.

Options, in this order (most common → least common, per how targeting is actually used — individual call-outs are the most frequent case, broad group blasts are rarer and more consequential so they sit last):
1. **Specific people**
2. **A role**
3. **A department**
4. **A group**

#### Per-mode control

**"Specific people" → multi-select searchable picker.**
Reuse the user-search pattern already established in `UserDirectoryPage.tsx`: debounced (250ms) server-side search via `api.listUsers({ search })`, which returns `DirectoryUser[]` (`app/src/lib/api.ts` line 2179). Do not build a new user-search endpoint or hook — `useUsers()` (`app/src/hooks/useUsers.ts`) already wraps this.

Visual: a shadcn `Command`-style combobox is the natural fit but isn't in this app's installed primitive set (`app/CLAUDE.md` lists: badge, button, card, dialog, dropdown-menu, input, label, progress, scroll-area, select, separator, sheet, switch, table, tabs, textarea, tooltip — no `command`/`popover`/`combobox`). Rather than introduce a new primitive for one field, build this as:
- An `Input` with search icon (matches `UserDirectoryPage`'s search box styling exactly) that filters/searches as the user types.
- A dropdown-style result list rendered below it (absolute positioned, `bg-white rounded-xl shadow`, matching the existing Dialog/Card elevation language) showing matched users (`display_name`, `email`, small avatar if `avatar_url` present) — click to add.
- Selected people render as removable `Badge` chips above the input (same chip pattern `WorkflowScopeChip` and the scope filter bar already use) — `{name} ×`.
- This is the smallest new-UI surface in the whole spec; flag to Elias that if this pattern gets reused a third time elsewhere, it's worth promoting to a real shared `UserMultiSelect` component rather than copy-pasting a third time.

**"A role" / "A department" / "A group" → single-select dropdown.**
Use the existing shadcn `Select` component (already used identically for the role filter in `UserDirectoryPage.tsx` lines 99–109) populated from the real APIs:
- Roles: `GET /api/roles` → `{ roles }` (`backend/src/routes/roles.ts` — each row includes `assigned_count` already, useful for the headcount summary below without a second request).
- Departments: `GET /api/departments` → `{ tree, flat }` (`backend/src/routes/departments.ts` — use `flat` for a simple dropdown list; each row's serialized field is `directMemberCount` — **confirmed direct reports only, not subtree-inclusive** — `serializeDept()` line 187 maps `direct_member_count` straight through with no subtree rollup for the flat list, unlike `tree`'s `totalMemberCount` which does sum children, per `buildTree()` line 156). This confirms the subtree-vs-direct ambiguity flagged below is real: the flat list undercounts a department with children.
- Groups: `GET /api/groups` → `{ groups }` (`backend/src/routes/groups.ts` — `serializeGroup()` line 208 already returns `memberCount` directly in the list payload — **no follow-up `GET /api/groups/:id/members` call needed** for the summary line, only for actually resolving/displaying the member list if the UI ever needs names, which it doesn't for this picker).

**Important cross-cutting flag for Elias (and Nina) — permission gate mismatch:**
`GET /api/roles`, `GET /api/departments`, `GET /api/groups`, and `GET /api/groups/:id/members` all currently require `requirePermission('users:manage')` (visible in each route file). The workflow builder is used by anyone who can author workflows — **not necessarily** an org admin with `users:manage`. If a non-admin workflow author opens "A role"/"A department"/"A group" mode, these dropdown-population calls will 403. Two options, flagging both as open items:
1. Loosen these specific list-read endpoints (not the mutation endpoints) to a lesser permission (e.g. any authenticated org member can *read* the list of roles/departments/groups, since knowing "Customer Success is a department" isn't sensitive — only creating/editing/viewing membership PII might be).
2. Keep the gate, and the mode's dropdown shows an inline permission-denied message ("Ask an admin to enable role-based targeting for you") instead of the list, degrading gracefully rather than crashing.
Recommend (1) for `GET /api/roles` and `GET /api/departments` (name + count is low-sensitivity), but defer to Nina/backend on whether `GET /api/groups/:id/members` (which returns email + display name per member) should stay gated — that one has more of a real PII surface if a low-trust workflow author is fishing for org-chart data via a live-count call.

#### Live "this will notify N people" summary line

Directly below the mode control, always visible once a target is picked:
- **Specific people:** `This will notify {N} {N === 1 ? 'person' : 'people'}.` — trivial, `N = selected.length`, no extra API call.
- **A role:** `This will notify {assigned_count} people with the "{role.name}" role.` — `assigned_count` is already returned by `GET /api/roles`, no extra call needed.
- **A department:** `This will notify {directMemberCount} people in {department.name}.` — using the `flat` list's `directMemberCount` field (confirmed via `serializeDept()`: direct reports only, no subtree rollup). **This is an open item for Nina, not just a UI copy choice:** if the backend's actual `notify.email`/`notify.in_app` resolution for `departmentId` walks the subtree (includes child departments), the UI's direct-only count would understate the real blast radius — a correctness bug in the summary, not just a cosmetic one. The UI must match whatever the backend actually resolves; confirm subtree behavior with Nina before wiring this label, and if subtree-inclusive, either request/derive a subtree-total count or say "...including sub-departments" and fetch the tree's `totalMemberCount` instead of the flat list's `directMemberCount`.
- **A group:** `This will notify {memberCount} people in "{group.name}".` — `GET /api/groups`'s `serializeGroup()` already returns `memberCount` directly in the list payload (confirmed, line 208) — no follow-up `/members` call needed for the summary line.
- Style: small, muted (`text-xs text-on-surface-variant`), icon-prefixed with `groups` or `info` Material icon, directly under the picker — this is explicitly the highest-value UI element in this whole feature per the task brief ("this matters especially... where headcount isn't obvious from the name alone"), so it should not be relegated to a tooltip or collapsed state.
- If the resolved count is 0 (e.g. an empty department, or a role nobody's assigned to), show a warning-toned variant: `This role currently has no one assigned — no one will be notified.` so the author catches a dead configuration before saving, not after a silent no-op execution.

#### Config shape — proposed for Nina to confirm/override

```ts
type NotifyTarget =
  | { targetType: 'users'; userIds: string[] }
  | { targetType: 'role'; roleId: string }
  | { targetType: 'department'; departmentId: string }
  | { targetType: 'group'; groupId: string };
```

Embedded in the action's config alongside existing fields, e.g. for `notify.email`:
```ts
{
  targetType: 'department',
  departmentId: 'dept_123',
  subject: '...',       // existing
  sections: {...},      // existing (email only, from ActionContentConfig)
}
```

This is a discriminated union on `targetType`, matching the task brief's suggested shape (`{ targetType, userIds?, roleId?, departmentId?, groupId? }`) but tightened to a discriminated union rather than "all fields optional" — cleaner for both the frontend (exhaustive `switch` when rendering the summary/serializing) and the backend (no ambiguity if multiple id fields were accidentally populated at once). **Open item for Nina:** confirm whether the backend wants the loose "all optional, `targetType` just says which one is authoritative" shape instead, e.g. if it's easier to validate with the existing Zod schema style used elsewhere in `backend/src/schemas/`. Either shape carries the same information; happy to adjust to match whatever's more consistent with the schemas she's already written for this.

**Backward compatibility note for Nina:** existing saved workflows have `notify.email` actions with `config.userId: string` (singular, no `targetType`) and `notify.in_app` actions with `config.userIds: string[]` (no `targetType`). The engine (or a migration) needs to treat the absence of `targetType` as the legacy singular/plural-userId shape — flagging this explicitly since it's a real "old saved workflow, does it still fire" concern, not just a UI nicety.

#### Frontend type changes (contentSections.ts / AdvancedFieldsDisclosure.tsx)

- `contentSections.ts`: replace `recipients?: string` on `ActionContentConfig` with `target?: NotifyTarget` (import the type from a shared location — since `notify.in_app` isn't currently a `CONTENT_PRODUCING_ACTION` at all per `ContentCustomizationPanel.tsx` line 12 `CONTENT_PRODUCING_ACTIONS = new Set(['notify.email', 'notify.slack', 'crystal.summarize'])`, this needs one more decision below).
- **`notify.in_app` doesn't currently go through `ContentCustomizationPanel`/`AdvancedFieldsDisclosure` at all** — check `ActionStepPanelContent.tsx`/wherever `notify.in_app`'s config form actually lives today (not read in this pass — flagging as a "verify before building" item for Elias, since the brief says extend both consistently, but the two actions may currently have separate config-form code paths that both need the same new targeting sub-component dropped in).
- `AdvancedFieldsDisclosure.tsx`: rename to reflect its new job, or at minimum replace the `recipients: Input` block (lines 39–48) with the new `NotifyTargetPicker` sub-component (mode selector + per-mode control + summary line, as its own file: `app/src/components/workflow-builder/sentence/NotifyTargetPicker.tsx`) — small enough to compose cleanly, complex enough (multi-select + 3 dropdown data sources + live count) to not belong inline in `AdvancedFieldsDisclosure`.
- Keep `subject` (email) and `channel` (Slack) exactly as-is — those aren't part of this fix.

#### Serialization fix in `WorkflowBuilderPage.serialize()`

Once `target` is a real field on `ActionContentConfig`, it flows through automatically — `serialize()` already spreads the whole `contentConfig` object into the action node's `config` for `CONTENT_PRODUCING_ACTIONS` (line 287: `config = a.contentConfig as unknown as Record<string, unknown>`). No new serialization code needed beyond making sure `notify.in_app` is added to `CONTENT_PRODUCING_ACTIONS` if it isn't routed through `contentConfig` today (see flag above).

### Slack: same treatment or not?

**Confirmed: not applicable today, email/in-app only for this fix.**

Read `sendSlack()` in `backend/src/lib/channels.ts` (line 80) plus the inline confirmation already left by Nina in `workflowEngine.ts` lines 213–220 (dated 2026-07-01): Slack delivery resolves purely by `org_id` to a single org-wide webhook stored in `notification_channels` — the `userId` parameter passed into `sendSlack()` is accepted but never used for routing or in the posted payload. There is no per-user Slack delivery mechanism anywhere in this codebase (no per-user Slack OAuth identity, no DM capability) — the entire concept of "notify these specific people via Slack" doesn't have a delivery path to attach to yet. Building a role/department/group/people picker for Slack would be pure UI theater with no backend effect, which is worse than not having it.

**Recommendation:** leave `notify.slack`'s config exactly as-is (its own `channel` field in `AdvancedFieldsDisclosure`, unrelated to this fix). If/when Slack gets per-user or per-channel-selection delivery (e.g. multiple configured webhooks, one per department channel), that's a separate, larger feature (Slack workspace OAuth + channel enumeration) and should get its own spec rather than being shoehorned into this one.

### Component/state breakdown for Elias

**New:** `app/src/components/workflow-builder/sentence/NotifyTargetPicker.tsx`
- Props: `{ value: NotifyTarget | undefined; onChange: (t: NotifyTarget) => void }`.
- Internal: mode state derived from `value?.targetType` (default to `'users'` mode with empty selection when `value` is undefined); fetches roles/departments/groups lazily (only when that mode is selected, not all three up front) via `useApi()`.
- Renders: segmented mode control → per-mode picker → live count summary line (as specified above).

**Modify:** `app/src/components/workflow-builder/sentence/AdvancedFieldsDisclosure.tsx`
- Remove the `recipients` `Input` block (lines 39–48) for `notify.email`.
- Render `<NotifyTargetPicker value={value.target} onChange={(target) => onChange({ ...value, target })} />` in its place.
- Update `AdvancedFieldsValue` interface: drop `recipients?: string`, add `target?: NotifyTarget`.
- Determine (verify with Elias against `ActionStepPanelContent.tsx`) whether `notify.in_app`'s config form needs this same disclosure wired in, or whether it needs its own smaller integration point — the picker component itself is shared either way.

**Modify:** `app/src/components/workflow-builder/sentence/contentSections.ts`
- `ActionContentConfig`: replace `recipients?: string` with `target?: NotifyTarget`.
- Export `NotifyTarget` type here (or a new shared `notifyTarget.ts` module if it's needed outside the sentence-builder tree, e.g. by canvas-builder action config forms too — check `WorkflowCanvasPage`'s action node config UI before deciding).

**Modify:** `app/src/components/workflow-builder/sentence/ContentCustomizationPanel.tsx`
- Update the `AdvancedFieldsDisclosure` props spread (line 30) to pass `target` instead of `recipients`.

**Verify (not yet read in this pass):** wherever `notify.in_app`'s action config form currently lives (likely `ActionStepPanelContent.tsx` or a dedicated in-app-notify config component) — confirm it either already shares `AdvancedFieldsDisclosure` or needs the same `NotifyTargetPicker` dropped in separately.

**Locale additions (`app/src/locales/en.ts`):** mode labels ("Specific people" / "A role" / "A department" / "A group"), search placeholder, summary line templates (singular/plural, per-mode, zero-count warning variant), permission-denied fallback string.

### Screens / states

1. **Collapsed (default):** `AdvancedFieldsDisclosure` shows only the "Advanced fields" toggle — unchanged.
2. **Expanded, no target picked yet:** mode selector defaults to "Specific people", empty state ("Search for people to notify"), no summary line yet (nothing selected).
3. **"Specific people" mode, typing:** debounced dropdown of matching users appears below the search input; selecting one adds a chip and clears the input for the next search.
4. **"Specific people" mode, 1+ selected:** chips render above the input; summary line reads "This will notify 3 people."
5. **"A role"/"A department"/"A group" mode:** single Select dropdown populated from the real API; on selection, summary line updates immediately using data already in hand (role: `assigned_count` from the list call) or triggers one lightweight follow-up call (group member count) — should feel instant, not spinner-laden.
6. **Zero-count warning state:** summary line switches to warning tone + copy when the resolved target currently has no members.
7. **Permission-denied state (if option 2 above is chosen over loosening the gate):** mode's dropdown area shows a muted inline message instead of a Select, mode remains selectable but unusable — doesn't block Save on other fields.
8. **Saved workflow, re-opened for edit:** `target` rehydrates from the loaded action config exactly like every other content-config field already does via `WorkflowBuilderPage`'s edit-mode fetch (`hasContentShape` check, line 146) — no special-casing needed beyond the type change flowing through.

---

## Summary of key decisions

**Issue 1:**
- Reuse the existing `seed`/`location.state` mechanism verbatim — no new cross-page contract. `WorkflowTemplate.nodes`/`edges` already matches the `CanvasSeed` shape used by the NL-builder handoff.
- Route via the existing `resolveEditRoute()` — same rule "Edit" already uses, no new routing logic.
- One real gap to close: the linear (sentence) builder's seed currently only carries `{name, triggerType}` and needs extending to also consume `nodes`/`edges`/`description`, by extracting the existing edit-mode node-parsing logic into a shared helper.
- Navigating away without saving is already a correct no-op — no new confirmation dialog needed.
- Relabel "Use Template" → "Start from Template"; the button becomes a synchronous `navigate()` call with no loading state, no try/catch, no `invalidate()` (nothing is mutated by the click anymore).

**Issue 2:**
- One new component, `NotifyTargetPicker`, shared by `notify.email` and `notify.in_app`: 4-way mode toggle (people/role/department/group) + per-mode picker (multi-select search for people; `Select` dropdown for the other three, sourced from real `/api/roles`, `/api/departments`, `/api/groups`) + a live "this will notify N people" line that is the single highest-value piece of this UI.
- Proposed config shape: discriminated union `{ targetType: 'users'|'role'|'department'|'group', ... }` — flagged to Nina as an open item versus her preferred loose-optional-fields shape; either carries equivalent information.
- **Real blocker flagged, not glossed over:** `GET /api/roles`/`/api/departments`/`/api/groups(/:id/members)` all require `users:manage`, which non-admin workflow authors likely don't have. Needs either a permission loosen on the read-only list endpoints or a graceful degraded state in the picker — this is a decision for backend/security, not something the frontend can silently work around.
- **Backward-compat flagged:** legacy saved `notify.email`/`notify.in_app` configs have no `targetType` — engine needs to keep honoring the old singular/plural `userId`/`userIds` shape when `targetType` is absent.
- **Slack confirmed out of scope** — read `sendSlack()` directly: delivery is a single org-wide webhook resolved by `org_id`, no per-user routing exists in the codebase today, so a targeting picker for Slack would have no backend effect. Left untouched; would need real Slack per-channel/per-user delivery infrastructure first, which is a separate, larger feature.
