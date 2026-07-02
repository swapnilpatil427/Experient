# Xperiq Actions — Deep UX/Interaction-Design Audit

**Author:** Rohan Desai (Principal Product Designer, Builder Experiences)
**Date:** 2026-07-01
**Method:** Full read of every builder/list/settings component (not skimmed), cross-checked
against `docs/automation-hub/TRACKER.md` (Waves 1–9), `BUILDER_REDESIGN_V2_CONCEPT.md` (my
own prior spec), `CUSTOMER_REVIEW.md` (C-001–C-011), and `TEMPLATE_FLOW_AND_RECIPIENT_TARGETING_SPEC.md`,
so nothing already fixed or already an explicit deferral is re-flagged as new. Independent
of Maya's parallel business-value walkthrough — not synchronized with her findings.

**Scope:** `WorkflowBuilderPage.tsx` (sentence builder), `WorkflowCanvasPage.tsx` (branching
canvas), `WorkflowNLBuilderPage.tsx` (Crystal NL builder), `WorkflowsPage.tsx` (list),
`IntegrationsSettingsPage.tsx` + connector components, `NotifyTargetPicker.tsx` and the full
`components/workflow-builder/sentence/` tree, `workflowRegistry.ts`, `workflowEngine.ts`,
and the relevant `en.ts` locale blocks.

---

## Top 5 most severe UX gaps

1. **A customer can build and save a workflow around a trigger that will never fire, with
   zero warning anywhere in the UI.** 8 of 13 registry triggers have no producer (documented
   in backend code comments only). The action side has a real live/stub/env readiness dot
   (`ActionTile.tsx`) — the trigger side (`TriggerTile.tsx`) has no equivalent at all. A user
   picks "NPS dropped" or "Response received," configures the whole sentence around it, saves,
   and the workflow silently never runs. (Finding T-1)

2. **The builder has no idea whether an org's Jira/Zendesk/Salesforce/ServiceNow credentials
   are actually configured or valid.** The readiness dot for `jira.create_issue` etc. is a
   hardcoded per-action-type registry constant (`live: 'env'`), identical for every org
   regardless of whether that org has a working, tested connection on the Integrations
   Settings page (Wave 8) or a broken one. Wave 8 and the builder are functionally unwired.
   A customer only discovers a bad Jira token when a real execution fails — and that failure
   then surfaces as a raw, untranslated exception string (see #3). (Finding I-1)

3. **Failed and skipped actions are invisible or unreadable in run history.** `error_message`
   is `err.message` from a thrown JS/HTTP exception, stored and rendered verbatim with zero
   translation layer — a customer could see a raw Axios/connector error string. Worse: a
   *gracefully skipped* step (e.g., `notify.email` skipped because its target role has zero
   members, reason `role_has_no_members`) is **not shown at all** — `GET /:id/executions` only
   returns a bare `step_count`, never per-step `output`/`error_message`, and a `skipped` status
   at the top level doesn't populate `error_message` the way a `failed` one does. This is
   exactly the "Silent Integration Failure" scenario CUSTOMER_REVIEW.md's Scenario 3
   described, now confirmed against the current shipped code, not just a design document.
   (Finding R-1, R-2)

4. **Test-run and delete/pause feedback are still generic, contradicting the product's own
   trust-building goal.** "Test run succeeded (342ms)" is the entire test-run result — no
   plain-language "this would have posted to #cx-alerts and created a Jira ticket," which is
   CUSTOMER_REVIEW.md C-002's exact, still-open ask. Delete uses one undifferentiated
   confirmation regardless of whether the workflow is a draft or an active, in-production
   automation. Pause/resume is a silent optimistic toggle with swallowed errors — a failed
   pause can leave the UI showing "paused" while the workflow is still live. (Findings
   L-2, L-3, L-4)

5. **The header's five entry-point buttons contain a literal duplicate and an unresolved
   ambiguity.** "Build Visually" and "New Workflow" navigate to the exact same route
   (`ROUTES.WORKFLOW_BUILD`) with no distinguishing behavior — confirmed directly in
   `WorkflowsPage.tsx` lines 187 and 196. "Build Visually" vs. "Build on Canvas" use
   near-identical abstract node-graph icons and near-identical "Build ___" copy with no
   supporting text explaining which is the simple sentence builder and which is the
   free-form branching canvas. Only "Build with Crystal" is unambiguous. A first-time user
   has a real, well-evidenced chance of never finding — or never understanding the point of
   — two of the product's five primary actions. (Finding L-1)

---

## 1. Visual/interaction consistency across surfaces

**Verdict: the four surfaces read as four different eras, and it shows in specific,
citable ways — not just a vague "feels different."**

- **`WorkflowsPage.tsx`** is the most visually bespoke: hardcoded hex colors throughout
  (`#2a4bd9`, `#059669`, `#d97706`, `#b41340`, `#8329c8` — `WORKFLOW_VISUALS`, stat-card
  colors, the primary "New Workflow" CTA at line 198), hand-rolled hover shadows via
  `onMouseEnter`/`onMouseLeave` setting `boxShadow` directly (lines 280–281) instead of a
  Tailwind hover class, oversized rotated-square icon badges (`w-20 h-20` outer / `w-14 h-14`
  inner, lines 287–296), and dialogs with one-off inline `boxShadow` values
  (`0 40px 80px -20px rgba(0,0,0,0.25)`, lines 460, 472) not defined as a reusable token
  anywhere else.
  - **This is a real violation, not just a style choice.** `app/CLAUDE.md`'s Brand Theme
    System explicitly requires brand-affected UI to use `var(--color-primary)` — hardcoding
    `background: '#2a4bd9'` on the primary CTA (line 198) means that button will **not**
    respond to a customer's custom brand color the way `bg-primary`-based buttons elsewhere
    in the app do. Confirmed by direct read, not inference: `Button` component's documented
    variants (`default`, `gradient`, etc.) already do this correctly; this button bypasses
    them entirely. **Confidence: high. Severity: polish gap for most orgs, blocks-brand-
    consistency for any org that has customized their brand primary color** (a real,
    revenue-adjacent gap for an enterprise-branding feature).
- **`WorkflowBuilderPage.tsx` (sentence builder, Wave 6)** and its `sentence/` component
  tree are the newest and most disciplined: pure Tailwind semantic tokens
  (`bg-success`/`text-warning`/`bg-surface-container-low`), no inline hex, consistent
  `rounded-xl`/`rounded-full` pill language, real shadcn primitives throughout.
- **`WorkflowNLBuilderPage.tsx` (Wave 3)** sits closer to the sentence builder's discipline
  (semantic tokens, plain `Card`/`Button`/`Textarea`) but has its own icon-badge convention
  (`w-6 h-6 rounded-md` colored squares in `TriggerSummaryRow`/`ConditionSummaryRow`/
  `ActionSummaryRow`) that neither `WorkflowsPage` nor the sentence builder shares — three
  surfaces, three different "icon chip" visual languages for conceptually the same idea
  (label a trigger/action with an icon).
- **`IntegrationsSettingsPage.tsx` (Wave 8)** introduces yet a fourth convention: heavy
  inline-style glassmorphism (`backdropFilter: blur(32px) saturate(180%)`, hand-picked hex
  status colors) that neither the sentence builder nor the NL builder uses.
- **Loading-state patterns differ by surface with no shared convention**: `WorkflowsPage`
  and `WorkflowBuilderPage` use a spinning-ring div; `IntegrationsSettingsPage` uses skeleton
  shimmer + a spinner-in-button; `NotifyTargetPicker` (built in the same wave as the
  Integrations page) falls back to the literal text **"Loading…"** with no skeleton or
  spinner at all (`NotifyTargetPicker.tsx` line 298) — three different loading treatments
  across code written in the same two-wave window.
- **Modal/panel patterns differ by surface**: `WorkflowsPage` uses shadcn `Dialog` for
  delete/history; the sentence builder uses its own bespoke `StepPanel` (slide-down,
  in-page); NL builder uses inline state transitions within one `Card` with no modal at all;
  Integrations uses a `ConnectorModal` dialog. Four different "how do we present a decision
  point" patterns for four surfaces of the same feature.

**Confidence: high** (direct code comparison across all four surfaces). **Severity: polish
gap** overall, but the brand-token violation on the primary CTA is a real functional
regression for brand-customized orgs.

---

## 2. Discoverability audit

### 2.1 "Advanced: Branching Canvas" escape hatch

Findable — it's always visible in the sentence builder's header row, not buried in a menu
(`WorkflowBuilderPage.tsx` lines 452–454). But:

- It's a `variant="link"` (small text link) with **no icon, no tooltip, no supporting
  copy** — contrast with the Crystal trigger badge two components away, which does get a
  tooltip explaining what "Crystal" means. The literal string is **"Advanced: Branching
  Canvas"** — three unexplained proper nouns stacked with nothing on the page defining what
  a "branch" is or contrasting it against the sentence the user is currently filling in.
  A first-time user who has never seen this product would have to guess.
- **It's a one-way door.** `WorkflowCanvasPage.tsx` has no equivalent link back to the
  sentence builder while actively editing in the canvas — a curious user who clicks through
  has no discoverable path back except browser-back or abandoning the session.
- **It silently drops configuration on the way there.** `switchToCanvas()` in create mode
  (`WorkflowBuilderPage.tsx` line 405) sends only `{ name, triggerType }` as the canvas seed
  — confirmed directly against `WorkflowCanvasPage.tsx`'s `CanvasSeed` consumption. A user
  who has already configured scope and 2+ actions in the sentence builder, then clicks
  "Advanced: Branching Canvas" to add one branching condition, loses their scope and every
  action they'd already configured. This is not documented or warned anywhere in the UI.

**Confidence: high** (verified both sides of the handoff directly). **Severity: blocks
success** for the data-loss case — this is a real, silent configuration loss, not a
theoretical one; **polish gap** for the label clarity alone.

### 2.2 "Start from Template" vs. building from scratch

Already fixed correctly in Wave 9 (verified, not re-flagged): synchronous navigation into a
pre-filled builder, zero side effects until Save, relabeled from "Use Template." No new
issues found in this specific flow.

### 2.3 Sentence builder vs. NL builder — is the difference clear before clicking?

**No — this is a genuine, well-evidenced gap.** `WorkflowsPage.tsx`'s header actions row
(lines 172–204) renders five buttons, all visually identical `variant="outline"` pills
except the solid final one:

| Button | Icon | Route |
|---|---|---|
| Integrations | `cable` | `ROUTES.SETTINGS_INTEGRATIONS` |
| Build with Crystal | `auto_awesome` | `ROUTES.WORKFLOW_NL_BUILD` |
| Build Visually | `account_tree` | `ROUTES.WORKFLOW_BUILD` |
| Build on Canvas | `schema` | `ROUTES.WORKFLOW_CANVAS` |
| **New Workflow** (solid) | `add` | `ROUTES.WORKFLOW_BUILD` |

**Confirmed directly, line-by-line:** "Build Visually" (line 187) and "New Workflow"
(line 196) both call `navigate(ROUTES.WORKFLOW_BUILD)` — the identical route, with no
distinguishing seed, state, or behavior. They are the same feature under two different
labels and two different visual weights (one outline, one solid/primary). A first-time user
has no way to know this.

**"Build Visually" vs. "Build on Canvas" is also genuinely ambiguous**: both labels start
with "Build," both icons (`account_tree` / `schema`) are abstract node-graph glyphs
indistinguishable from each other at 16px, and there is no subtext, tooltip, or caption
anywhere in the row explaining that one is the step-panel sentence builder and the other is
the free-form branching canvas — the exact two builders this whole redesign was built to
differentiate. Only "Build with Crystal" (sparkle icon, distinct branding, consistent with
Crystal's visual language elsewhere in the app) is unambiguous at a glance.

**Confidence: high** (read directly, route targets confirmed identical). **Severity:
borders on blocks-success** — 3 of 5 header buttons are confusable or outright redundant for
a first-time user, on the single highest-traffic surface of the whole feature.

### 2.4 Trigger picker: plan-tier / entitlement gating

**No gating UI exists anywhere in the trigger or action tiles.** Grepped the full
`workflow-builder/` tree for `plan|tier|gated|locked|upgrade|entitlement` — the only hit is
a code comment in `SectionChecklist.tsx` stating Crystal AI Summary is "deliberately NOT
locked." `TriggerTile.tsx` has no `disabled` prop or gating logic at all. Every trigger,
including the `isCrystal: true` ones, renders as a fully clickable tile regardless of org
plan — the purple "Crystal" badge on those tiles is informational/branding only (with a
tooltip explaining what Crystal signals are), never "requires upgrade." If plan-tier
entitlement is enforced anywhere, it is invisible in this frontend surface: a customer
without Crystal Signals access sees and can select `crystal.*` triggers identically to a
customer who has them.

**Confidence: high. Severity: blocks success** — silent capability mismatch with zero lock
icon or upgrade prompt anywhere.

---

## 3. Every confirmation/feedback moment

### 3.1 Save (sentence builder)

**This one is actually good on the core promise, with one real gap.** `save()`
(`WorkflowBuilderPage.tsx` lines 374–399): on failure, the catch block only sets `error`
and `saving` — `name`, `triggerType`, `actions`, `scope`, `cooldownMinutes` are all
untouched, so the user's in-progress sentence is never lost on a failed save. That part
matches best practice.

The gap: the error message is `err instanceof Error ? err.message : t('workflows.builder.saveError')`
— i.e., whatever raw string the API client throws is shown to the user verbatim, with no
sanitization. And although `SentencePill.tsx` already defines an `'invalid'` visual state
(dashed amber border + warning icon) specifically for this purpose, **no call site in
`WorkflowBuilderPage.tsx` ever sets a pill to `'invalid'`** — a 400 validation error (e.g.,
"scope required for this trigger type") produces only a single generic red line of text in
the crowded header row, with no indication of *which* pill needs fixing. The capability
exists in the design system; it just isn't wired to server-side validation failures.

**Confidence: high. Severity: polish gap** for the raw-message leak; **blocks-success-
adjacent** for the missing invalid-pill highlighting, since a user genuinely cannot tell
which of trigger/scope/action(s) the error refers to.

### 3.2 Toggle active/paused

`toggleWorkflow()` (`useWorkflows.ts`) does an **optimistic local flip**, calls the API,
and **silently swallows errors** (`catch { /* optimistic */ }`) — if the toggle call fails
server-side, the badge has already flipped in the UI and never reverts, with zero toast or
indication to the user that the request failed. There is no confirmation dialog for pausing
an active, in-production workflow, and no undo affordance. The only feedback is the badge
color/text and button icon swap.

**Confidence: high. Severity: polish gap** for the common case (toggle usually succeeds);
**real gap** for the failure case — a user can believe an automation is paused when the
server-side toggle silently failed, which is a meaningfully worse failure mode than a
generic silent UI toggle because the actual state (still running, still posting to Slack,
still creating tickets) diverges from what's displayed.

### 3.3 Delete confirmation

Exact copy (`WorkflowsPage.tsx` lines 470–501, `en.ts` lines 1895–1900):

> **Delete workflow?**
> This will permanently delete "{name}". This cannot be undone.
> [Cancel] [Delete]

This is one static dialog regardless of the workflow's `status` — deleting a never-run
`draft` and deleting an `active` workflow currently posting to Slack and creating Jira
tickets in production get **identical copy**, with no mention of what happens to run
history, in-flight executions, or cooldown state (contrast with `CUSTOMER_REVIEW.md`'s
own C-008 proposed bulk-delete copy, which explicitly promises "run history will be
preserved" — a strictly better, more specific pattern that exists in a design doc but
wasn't carried into this single-delete flow). `handleDeleteConfirm` also has no error
handling: a failed delete produces no visible feedback — the dialog just doesn't close,
with no explanation why.

**Confidence: high. Severity: polish gap** on tone (it does convey irreversibility, unlike
a toy "Are you sure?"), but a **real trust gap** for high-stakes active workflows — the copy
doesn't scale its severity to match the actual blast radius of what's being deleted, and
the missing failure feedback is a genuine dead-end.

### 3.4 Test-run ("Safe Run")

**Confirmed still fully open against CUSTOMER_REVIEW.md C-002.** The entire result surface
(`WorkflowsPage.tsx` lines 352–361, `en.ts` lines 1875–1876) is:

> Test run succeeded (342ms)
> — or —
> Test run failed

No per-action breakdown, no plain-language "this would have posted to #cx-alerts and
created a Jira ticket in CX," no historical-data replay option (`testWorkflow(wf.id)`
accepts only an optional synthetic payload, no "load from a real event" lookup). This is
exactly the gap C-002 named — a duration in milliseconds does not build the trust C-002's
own framing says a CX manager needs before enabling a new alert.

**Confidence: high. Severity: blocks success** relative to the feature's own stated
trust-building purpose.

### 3.5 Failed/skipped action in run history

**This is the single most concrete, most severe finding in the whole audit — confirmed at
three layers (frontend render, list endpoint, engine).**

- **Frontend** (`WorkflowsPage.tsx` line 550): `{exec.error_message && <p className="text-xs text-error mt-1">{exec.error_message}</p>}`
  — a raw, untranslated pass-through with zero formatting or remediation guidance.
- **Where `error_message` comes from** (`workflowEngine.ts` lines 684–687):
  ```ts
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    await query('UPDATE workflow_executions SET error_message = $2 WHERE id = $1', [execId, msg]);
  ```
  This is the raw exception message from whatever threw — a connector library error, an
  Axios HTTP error, anything. There is no human-readable mapping layer anywhere between the
  engine and the UI.
- **Gracefully skipped steps are worse than badly-worded — they're invisible.** The engine's
  own `no_recipient_configured` / `role_has_no_members` / `department_has_no_members` /
  `group_has_no_members` reasons (`workflowEngine.ts` lines 255, 305, 312;
  `recipientResolver.ts` lines 126–136) are stored on the **per-step** `output` column
  (`workflow_step_executions`), and a skip is `status: 'skipped'`, not `'failed'` — it never
  touches `error_message` at all. Confirmed directly: `GET /api/workflows/:id/executions`
  (`routes/workflows.ts` lines 353–361) selects only `e.error_message` and a bare
  `COUNT(*) AS step_count` from `workflow_step_executions` — **it never fetches individual
  step rows or their `output` field.** A customer whose "Weekly Digest" email quietly skips
  every week because the target department has zero members sees **"3 steps" and nothing
  else** in run history — no warning, no skip notice, no error. This is precisely the
  "Silent Integration Failure" scenario CUSTOMER_REVIEW.md's Scenario 3 predicted, now
  reproduced against the real, current, shipped schema and endpoint — not a hypothetical.

**Confidence: high** (traced through frontend render → route handler → SQL → engine
write-site). **Severity: blocks success** — this is a customer-facing diagnosability
dead-end for exactly the failure mode (integration/recipient misconfiguration) the product
is most likely to hit in practice.

---

## 4. Every empty/zero state

| State | Location | Treatment | Verdict |
|---|---|---|---|
| Empty workflow list | `WorkflowsPage.tsx` L436–455 | icon + heading ("No workflows yet") + description + gradient CTA | Well-formed |
| Empty template gallery | `WorkflowsPage.tsx` (`WorkflowTemplates`) | `if (templates.length === 0) return null` — **section vanishes entirely, no icon/message** | Inconsistent — only empty state on the page with zero signal |
| Pending approvals, zero | `WorkflowsPage.tsx` (`PendingApprovals`) | same silent `return null` | Same pattern, arguably correct for a "nothing pending" secondary widget, but undocumented as intentional |
| Run history, zero runs | `WorkflowsPage.tsx` L529–531 | text-only "No runs yet." — no icon, no CTA | Visibly lower-effort than the top-level empty state |
| Trigger category, plan-gated | Nowhere — no gating exists | N/A | See §2.4 — not an empty state, a missing state |
| Zero-configured integrations | `IntegrationsSettingsPage.tsx` | dismissible banner: "Connect at least one integration to let your workflows create tickets, update records, or post notifications automatically." | Good — informative, actionable |
| Vault unconfigured | `IntegrationsSettingsPage.tsx` | "The credentials vault isn't configured on this deployment yet. Contact your platform administrator." | Good, though "vault" is undefined jargon for a non-technical admin |
| Recipient picker, zero members (role/department/group) | `NotifyTargetPicker.tsx` L178–215 | Warning-styled line, warning icon, specific consequence copy per mode (e.g. "This role currently has no one assigned — no one will be notified.") | **Verified genuinely good, not just present** — correct visual escalation, consistent position, doesn't block save, best-written copy in the whole audit |
| Scope picker, zero survey/tag matches | `ScopeStepPanelContent.tsx` L98–100, 139–141 | explicit "no surveys match" / "no tags match" text rows | Good |

**One durability gap found on the Integrations page**: the "Connection error" state is
session-only per its own code comment — a page refresh silently reverts a broken connector
back to displaying "Connected" even though the underlying credential is still bad, until
the user runs Test Connection again. **Confidence: high (agent-verified). Severity:
moderate** — a false-healthy signal on the one page whose entire job is surfacing
connection health.

**Overall empty-state consistency verdict:** genuinely bimodal. Anything built or touched in
Wave 6/8/9 (sentence builder scope picker, recipient picker, Integrations page) has
well-designed, consequence-explaining empty states. Anything still living in the original
`WorkflowsPage.tsx` shell (template gallery, run history, pending approvals) either has no
empty-state design at all (silent `return null`) or a minimal one-line fallback — a visible
generational seam, not a deliberate content-density decision.

---

## 5. Error states and recoverability

### 5.1 Sentence builder save failure — covered in §3.1. Verdict: state preserved (good),
error message unsanitized and not pill-localized (gap).

### 5.2 Canvas builder save failure

`WorkflowCanvasPage.tsx`'s `save()` is structurally identical to the sentence builder's:
same try/catch, same raw `err.message` passthrough, same generic fallback string. Rendered
as a standalone `<p className="text-sm text-destructive">` above the canvas rather than
crammed into a flex-wrap header — marginally more legible than the sentence builder's
version, but the same underlying gap (no field-level error localization).

### 5.3 NL builder parse failure — genuinely good, better than initially assumed

**This is the one area of the product that most closely resembles CUSTOMER_REVIEW.md
C-006's intent, though not its literal three-tier structure.** `WorkflowNLBuilderPage.tsx`'s
`ViewState` union has five states: `thinking`, `confirm`, `low-confidence`, `unparseable`,
`timeout`. Every non-happy-path state has at least one, usually two, recovery actions:

- **Low-confidence** (`confidence < 0.6`): shows the parsed structure at reduced opacity
  inside a dashed border (never hides it), with **"Edit in canvas"** and **"Try rewording
  instead"** — and deliberately no "Create Workflow" button (a code comment confirms this is
  an intentional guardrail, not an oversight).
- **Unparseable**: shows the backend's message plus a static "Try being more specific
  about:" hint list, and the same example-phrase chips as the initial input state
  (one click to load into the textarea).
- **Timeout**: "Try again" (re-calls generate) and "Build manually" (navigates to the
  canvas).
- **Confirm** (high confidence): always offers "Edit in canvas," "Discard," and "Create
  Workflow" — never a dead end.

**None of the four non-happy-path states is a dead end requiring the user to start over
with no guidance** — this is a real strength worth preserving, not just a gap to fix.

**However, cross-checked against C-006's literal three-tier spec, two of the three tiers are
still unbuilt:**
- **Tier 2 (no parse possible, explain why + offer a concrete alternative)** — partially
  matched by `unparseable`, but with a generic hint list rather than C-006's specific
  "your request requires X, which isn't available — here's what you can do instead" framing.
- **Tier 1 (partial parse — build what's supported, explicitly name what was skipped and
  why)** — **not implemented.** `low-confidence` is a single scalar threshold, not a
  per-clause "you asked for X, I skipped it because Y, I built Z instead" annotation. The
  `warnings` array (rendered as "Crystal assumed:") documents assumptions Crystal *made*,
  not capabilities it *dropped* — a different concept.
- **Tier 3 (ambiguous input — ask a clarifying question before building)** — **not
  implemented, and no data contract exists to support it.** `ParseWorkflowNLResult`/
  `ParseWorkflowNLError` in `api.ts` have no `ambiguities`/`clarification_needed` fields at
  all, so even if the backend added them today, this page would silently ignore them.

**Confidence: high** (verified against full component code and the full C-006 text).
**Severity: the shipped system is good UX (not a gap to fix urgently)**, but C-006 as
originally specified remains a real, un-tracked-as-resolved gap — worth either formally
closing the scope (declare the 5-state system as the intentional replacement for the
3-tier spec) or scheduling the remaining two tiers explicitly, rather than leaving it
ambiguous whether it's done.

### 5.4 Integration credential failures at build time — see §2.4/§8, Finding I-1

Restated for completeness here: the builder shows zero indication of an org's actual
connector health at configuration time. `SimpleActionConfigForm.tsx`'s field list for
`jira.create_issue` is a single bare "Project Key" input — no mention of Jira connection
status, no link to the Integrations settings page, nothing. Confirmed by grepping the
entire builder component tree for `credential`/`connector`/`integration` — zero hits.

---

## 6. Content-density and cognitive load ("read it as one sentence")

**Verdict: the sentence-as-spine promise genuinely holds at scale — but only because the
sentence deliberately shows almost nothing about each action's actual configuration, which
trades one problem for a smaller, different one.**

`ActionClauseList.tsx` renders each action as a compact pill (drag handle + label + remove
button) — e.g. "⠿ Slack message ×" — never an expanded card. Four or five actions render as
a flat wrapped row of same-styled pills:

> When [NPS dropped] on [Org-wide] then [⠿ Notify Slack ×] [⠿ Send email ×] [⠿ Tag responses ×] [⠿ Require approval ×] + Add another action

This does **not** visually degrade into the old 3-panel builder's complexity — cooldown
lives behind a separate Settings sheet, and each action's content customization (section
checklist, subject line, recipient targeting) is only visible by reopening that action's
own `StepPanel`. `LivePreviewMock` is scoped to one action at a time and stays legible
regardless of how many actions exist elsewhere in the workflow, since it never attempts an
aggregate view.

**The real cost, not previously named:** because clauses are undifferentiated pills with
**no connective language and no per-clause status glyph**, two things are lost once there
are 2+ actions:
1. **Execution order is not communicated.** Actions run in array order
   (`serialize()`'s `edges = nodes.slice(1).map(...)` linear chain), and `flow.approval`/
   `flow.stop` are order-sensitive control-flow actions, but the sentence gives no ordinal
   language ("first... then... finally...") — a user with an approval gate mixed among
   notify actions cannot tell from the sentence alone what happens before vs. after the
   pause.
2. **Per-action configuration state is invisible from the resting view.** There's no small
   indicator on a pill for "this one has custom content sections" or "this one has a
   recipient warning" — a reviewer glancing at a saved workflow's sentence has to reopen
   every single action to know what it actually does, which is a real cost for the stated
   goal of "understand immediately what this workflow is about," even though it's a much
   smaller cost than the old 3-panel shell's.

**Confidence: high. Severity: polish gap for the missing per-clause detail glyph; borderline
blocks-success for the missing execution-order language specifically when `flow.approval`/
`flow.stop` are mixed with regular actions**, since misreading order could mean a user
believes an email fires before an approval gate when it actually fires after.

---

## 7. Mobile/responsive behavior

Per `app/CLAUDE.md`'s three-breakpoint system (mobile <768px / tablet 768–1023px / desktop
≥1024px):

| Surface | Verdict | Evidence |
|---|---|---|
| Sentence builder header row | Undesigned, degrades via `flex-wrap` only | 6+ interactive elements (back button, name input, settings icon, canvas link, error/save-reason text, Save button) in one `flex items-center gap-3 mb-6 flex-wrap` row (`WorkflowBuilderPage.tsx` L438) — wraps in DOM order with no mobile-specific reordering or collapsing into a menu |
| Sentence row itself | Wraps, doesn't overflow, but `text-lg` fixed with no scale-down | `flex flex-wrap items-center gap-x-2 gap-y-3 text-lg` (L464) — complies with the "no horizontal scroll" rule but produces a tall stack of short wrapped lines on narrow viewports once 4–5 action pills are present |
| **Save-disabled reason** | **Actively hidden on mobile** | `hidden md:block` on the inline reason text (L457) — a mobile user sees a disabled Save button with **zero explanation** of what's missing, while a desktop user gets a specific reason ("Choose a trigger" / "Add an action" / etc.) |
| Step-panel tile grids | **Genuine responsive intent, done well** | `grid-cols-1 md:grid-cols-2 lg:grid-cols-3` in both `TriggerStepPanelContent.tsx` and `ActionStepPanelContent.tsx`; `ContentCustomizationPanel.tsx` correctly stacks checklist-over-preview on mobile/tablet (`grid-cols-1 lg:grid-cols-2`, with an explicit code comment confirming intent) |
| Canvas builder header | **Fixed-width inputs, no responsive treatment** | `PageHeader`'s actions slot: `<Input className="w-56" />` (name) and `<Input className="w-64" />` (description) at `WorkflowCanvasPage.tsx` L198–199 — fixed pixel-ish widths, not fluid, packed with 3 buttons in one non-wrapping `flex items-center gap-2` row |
| Canvas itself | **Realistically desktop-only** | `style={{ height: '70vh' }}` ReactFlow drag/pan/zoom canvas (L207) with no touch-specific handling anywhere — a fundamentally desktop interaction pattern |
| Integrations settings page card grid | **Genuine responsive intent** | `grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4` (confirmed at two separate call sites) |
| Recipient picker 4-way toggle | Wraps via `flex-wrap`, no dedicated mobile layout | `flex items-center gap-1.5 flex-wrap` (`NotifyTargetPicker.tsx`) — survives narrow viewports without overflow, but no stacking-to-2×2 or full-width-button mobile treatment was designed in |

**Confidence: high** (direct class-level inspection across every surface). **Severity:**
polish gap for the sentence builder (degrades ungracefully but doesn't break); **blocks
success on mobile/tablet for the canvas builder specifically** — fixed-width header inputs
plus a non-touch-optimized drag/pan/zoom canvas make it realistically unusable below
desktop; **real, if narrow, gap** for the hidden save-disabled reason, which actively
removes the one piece of guidance a stuck mobile user has.

---

## 8. Accessibility spot-check

**Overall verdict: the newer components (sentence builder tree, recipient picker) are
built with real semantic interactivity — genuinely above-average for this kind of custom
UI — with two concrete, specific exceptions.**

**What's done correctly, confirmed by direct code read:**
- `SentencePill`, `TriggerTile`, `ActionTile` are all real `<button type="button">` elements
  with `aria-pressed`/`disabled` wired through correctly — not divs with `onClick`.
- `ActionClauseList`'s drag handle, edit, and remove controls are all real buttons with
  `aria-label`s, and drag-reorder has a genuine keyboard fallback via `dnd-kit`'s
  `KeyboardSensor`/`sortableKeyboardCoordinates` — a notably above-average detail for a
  custom drag-and-drop list.
- `NotifyTargetPicker`'s per-person remove chips have correct `aria-label`s (e.g.
  "Remove {name}"); the role/department/group `Select` dropdowns inherit full Radix
  listbox ARIA semantics for free.

**Two concrete, specific gaps found:**

1. **Readiness/category tooltips are mouse-only content with no keyboard equivalent.** The
   Crystal badge tooltip (`TriggerTile.tsx`) and the live/stub/env readiness-dot tooltip
   (`ActionTile.tsx`) are the *only* place either signal is explained — but both are nested
   inside the tile's outer button with no independent focus handling or `aria-describedby`
   on the outer button, so a keyboard-only or screen-reader user selecting an action tile has
   no way to learn "this is a stub" beyond the dot's color, which itself has no `aria-label`
   or `sr-only` text alternative (only `data-testid`/`data-readiness`, which are not
   accessibility attributes). This matters more than a typical missed tooltip because the
   readiness dot is literally the only UI signal that an action "won't work yet."

2. **`NotifyTargetPicker`'s user-search combobox has zero combobox semantics or keyboard
   navigation** — confirmed directly: no `role="combobox"`, no `role="listbox"`/`"option"`,
   no `aria-expanded` on the input, no `aria-activedescendant`, and no `onKeyDown` handler
   anywhere in the file (no arrow-key navigation, no Escape-to-close). It's a plain
   absolutely-positioned div of buttons — functionally mouse-only, or Tab-only in a way that
   doesn't match a screen-reader user's expected combobox interaction pattern. This is a
   deliberate, documented simplification (a code comment cites matching
   `UserDirectoryPage`'s existing search box, and the app has no shadcn `Command`/`Popover`
   primitive installed) — a reasonable trade at the time, but still a real gap given this is
   the "Specific people" mode of a control used to configure who receives potentially
   sensitive notifications.
3. **Minor, related inconsistency**: `NotifyTargetPicker`'s 4-way mode-toggle buttons have
   no `aria-pressed`/`aria-selected` despite `ActionTile.tsx` in the very same codebase using
   `aria-pressed` correctly for an equivalent toggle-tile pattern — an inconsistency between
   two components built in different waves, not a systemic problem.

**Confidence: high** for all three (direct code inspection, not inferred from framework
defaults). **Severity: polish-to-moderate** — the foundational interactive elements
(buttons, keyboard-reorderable lists) are genuinely solid; the gaps are concentrated
specifically in tooltip-only content and one combobox pattern, not systemic across the
feature.

---

## 9. The sentence model's real limits — beyond branching

**Confirmed directly against the registry and engine source, not inferred:**
`backend/src/lib/workflowRegistry.ts`'s `ACTIONS` array has exactly two `category: 'Flow'`
entries — `flow.approval` ("Require approval") and `flow.stop` ("Stop workflow"). There is
**no `flow.delay`/`flow.wait` action, and no `delay_minutes`-style field anywhere in the
codebase** (grepped both `backend/` and `app/` for `delay_minutes`/`delayMinutes` — zero
hits). The engine's only pause primitive is:

```ts
case 'flow.approval':
  return { status: 'waiting', output: { approvalRequired: true }, pause: true };
```

and a `'waiting'` execution is **only ever resumed by an explicit human approve/reject
call** — there is no scheduler-driven auto-resume-after-N-minutes/hours path. In the
builder, `flow.approval`'s only configurable field is a free-text `approverEmail`
(`SimpleActionConfigForm.tsx`) — no duration or time picker exists anywhere in either
builder's UI, confirming the gap isn't just a missing engine feature but also absent from
the design surface entirely.

**Consequence:** a common, realistic automation pattern — "notify Slack, then if
unresolved after 24 hours, escalate to the VP" — **cannot be built in this product today**,
in either the sentence builder or the canvas. The closest workaround is chaining a second,
separate `time.schedule`-triggered workflow, which is a different top-level workflow object
entirely, not a step within one, and has no data link back to "did the first workflow's
issue get resolved." This is the same gap CUSTOMER_REVIEW.md named directly as "Multi-channel
escalation with time delay" and explicitly scoped as buildable without full branching logic
("only requires a `delay_minutes` field... enables time-delayed escalation without requiring
the full branching architecture") — confirmed here as still fully unbuilt, not a partial
implementation.

**Confidence: high** (verified against the registry source, the engine's switch statement,
and the action's own config-field list — no ambiguity). **Severity: blocks success** — this
is a foundational automation primitive missing from the product, not a builder-surface
polish issue; it constrains what's expressible regardless of which builder (sentence or
canvas) a customer uses.

**A second, smaller sentence-model limit, not previously named:** the sentence gives no way
to express execution order beyond array order (see §6) — for a model whose defining promise
is "read it as one sentence," the lack of ordinal language ("first... then... finally...")
once `flow.approval`/`flow.stop` are mixed with regular actions is a real, if narrower, gap
in the same family as the wait/delay limitation — both are cases where the underlying engine
has more sequencing/timing nuance than the sentence surface currently expresses.

---

## 10. Copy quality pass

**Overall verdict: copy quality is high and inconsistent by wave, not uniformly bad — the
newest surfaces (recipient picker, Integrations settings) have the best copy in the whole
feature; the oldest surface (`WorkflowsPage.tsx`'s test-run/run-history rendering) has the
worst.**

**Genuinely excellent, worth citing as the standard to replicate:**
- `notifyTarget.summaryZeroRole`: *"This role currently has no one assigned — no one will
  be notified."* — consequence-first, human, no jargon.
- `integrationsSettings.disconnectConfirm.body`: *"This will stop workflow actions from
  using your {connector} credentials. Workflows using {connector} actions will fall back to
  your organization's shared credentials, if configured, or fail."* — genuinely honest about
  a real consequence ("or fail"), not softened into a toy confirmation.
- No connector enum keys, `targetType` values, or other internal field names were found
  leaking into any user-facing string in either the recipient-picker or Integrations-settings
  locale blocks — every internal value is mapped to a human label before reaching copy.

**One minor register nit found, not severe:**
- `notifyTarget.permissionDenied`: *"Ask an admin to enable role/department/group targeting
  for you."* — the slash-separated list reads closer to internal shorthand than the
  otherwise carefully-written neighboring strings (e.g., "Ask an admin to enable targeting
  by role, department, or group for you" would match the surrounding tone better). Severity:
  cosmetic.

**The real copy-quality gap is not a bad string — it's an absent one:**
- `workflows.card.testSucceeded`: **"Test run succeeded ({ms}ms)"** — this is technically
  accurate but is engineering-speak by omission: it tells a business user a duration, not
  an outcome. There is no companion string anywhere describing what the test run actually
  did (see §3.4/C-002).
- `RunHistory`'s `{exec.error_message}` render has **no locale string backing it at all** —
  it's a raw runtime value, not a `t()`-wrapped key, meaning it's exempt from the project's
  own "every user-visible string goes through `t()`" rule (`app/CLAUDE.md`) by construction,
  because it was never authored as UI copy — it's a database column value rendered directly.
  This is the most consequential copy-quality finding in the audit precisely because it
  isn't really a copy problem — it's a missing translation/formatting layer between the
  engine's exception messages and anything a customer should see (see §3.5/§5.4).

**Confidence: high** (direct locale-file and component read for every quoted string).
**Severity: polish gap** for the one register nit; **the untranslated run-history error
path is the same blocks-success finding as §3.5**, restated here because it is, in the most
literal sense, a copy-quality failure — the absence of copy where copy is required.

---

## Cross-reference: what this audit confirms is already resolved (not re-flagged)

- Wave 9's "Start from Template" fix and `NotifyTargetPicker`'s core mechanism — confirmed
  working as designed by direct code read.
- CUSTOMER_REVIEW.md's cron-confusion risk (Scenario 2) — confirmed **fully resolved**,
  and better than the original ask: `ScheduleTriggerConfigPanel.tsx` is a structured
  frequency/weekday/monthly-variant UI with a live "Fires: [description] / Next run: [date]"
  preview, cron only reachable via an explicit "Developer mode" disclosure with its own
  validation preview.
- Recipient picker's zero-member state (Wave 9) — confirmed **genuinely good**, not just
  present, per the task's explicit ask to verify this rather than assume it.
- Wave 5/9's "New Workflow Modal" retirement — confirmed gone, both header entry points
  route to the real builder (though see Finding L-1 for a new problem this exposed: they
  now route to the *same* builder with no differentiation).
- Cooldown-status display on the workflow list card — confirmed **still absent**, matching
  Wave 5's own "Open follow-ups" list (not a new finding, restated here only to confirm it
  wasn't quietly fixed since).

---

## Full findings index (for tracking)

| ID | Finding | Section | Severity |
|---|---|---|---|
| T-1 | No readiness indicator for triggers with no producer (asymmetric with actions) | §2.4 | Blocks success |
| T-2 | No plan-tier/entitlement gating UI on any trigger or action tile | §2.4 | Blocks success |
| I-1 | Builder's readiness dot for integration actions is a static registry constant, not live per-org credential health | §5.4 | Blocks success |
| R-1 | `error_message` is a raw, untranslated exception string in run history | §3.5 | Blocks success |
| R-2 | Gracefully-skipped steps (zero-recipient, etc.) are invisible in run history — endpoint never fetches per-step output | §3.5 | Blocks success |
| L-1 | "Build Visually" and "New Workflow" are the same route; "Build Visually" vs. "Build on Canvas" is ambiguous | §2.3 | Blocks success (discoverability) |
| L-2 | Test-run result is duration-only, no plain-language outcome (C-002 still open) | §3.4 | Blocks success |
| L-3 | Delete confirmation copy doesn't scale severity to workflow status; no failure feedback | §3.3 | Moderate |
| L-4 | Toggle pause/resume is optimistic and silently swallows errors | §3.2 | Moderate |
| C-1 | Canvas escape hatch drops scope/actions already configured in the sentence builder | §2.1 | Blocks success |
| C-2 | Canvas has no link back to the sentence builder | §2.1 | Polish |
| C-3 | Canvas builder unusable on mobile/tablet (fixed-width header, non-touch ReactFlow) | §7 | Blocks success (mobile) |
| S-1 | Sentence pills give no execution-order language when flow.approval/flow.stop are mixed in | §6 | Polish/borderline |
| S-2 | Save-disabled reason hidden on mobile (`hidden md:block`) | §7 | Moderate |
| S-3 | `SentencePill`'s `'invalid'` state exists but is never wired to save-time validation errors | §3.1 | Polish/borderline |
| V-1 | Primary "New Workflow" CTA uses hardcoded hex, breaking brand-theming | §1 | Polish (brand orgs: functional) |
| V-2 | Four different loading-state conventions across surfaces built in adjacent waves | §1 | Polish |
| A-1 | Readiness/category tooltips are mouse-only, no keyboard/screen-reader equivalent | §8 | Polish |
| A-2 | Recipient picker's user-search has no combobox ARIA semantics or keyboard nav | §8 | Moderate |
| A-3 | Recipient picker's mode toggle lacks `aria-pressed` (inconsistent with `ActionTile`) | §8 | Polish |
| W-1 | No wait/delay action exists anywhere — `flow.approval` (human-gated) is the only pause primitive | §9 | Blocks success |
| E-1 | Template gallery / pending approvals sections silently vanish when empty (no designed empty state) | §4 | Polish |
| E-2 | Integrations page's "Connection error" state doesn't survive a page reload | §4 | Moderate |
