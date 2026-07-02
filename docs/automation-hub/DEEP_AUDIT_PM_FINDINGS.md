# Xperiq Actions — Deep Audit: Full Feature Walkthrough

**Author:** Maya Okonkwo, Staff PM, Workflow Automation
**Date:** 2026-07-01
**Method:** A full, code-first walkthrough of every customer-facing surface in Xperiq
Actions — list page, sentence builder, branching canvas, NL builder, templates,
integrations settings, approvals, Crystal chat's workflow-creation path, run
history, and cross-cutting concerns (tier gating, collaboration). Every finding
below was verified by directly reading the current source (not from memory, not
re-asserted from prior docs) — either by me or by a research agent I dispatched
per surface, whose citations I spot-verified myself against the live files before
including them here. I explicitly excluded anything already confirmed/fixed by
prior waves (see `TRACKER.md`), already tracked-and-deferred (e.g. tag-scoped
cooldown's shared clock, C-005/RBAC, C-008/bulk-ops, C-009/analytics, C-010/live
preview, C-011/chaining docs), or already flagged as a known open risk (the
CrystalOS↔backend↔frontend live-seam risk, the 8-of-13-no-producer-triggers gap).
Everything in this document is **new** — found by this pass, not a restatement.

**Confidence key:** *Confirmed* = I or an agent read the exact lines and traced
the logic end to end. *Suspected* = strong circumstantial evidence, worth a
direct test before treating as certain.

---

## TOP 5 — the findings that most directly block real customer value

### 1. Editing an already-live workflow silently disables it (both builders)

**Confirmed.** `app/src/pages/WorkflowBuilderPage.tsx:382` and
`app/src/pages/WorkflowCanvasPage.tsx:173` both hardcode `status: 'draft' as const`
in the save payload — unconditionally, on every save, including `isEditMode`
edits of a workflow whose current status is `'active'`. The backend's `PUT
/api/workflows/:id` (`backend/src/routes/workflows.ts`, `if (status !== undefined)
sets.push('status = $...')`) faithfully writes whatever status it's given. The
engine only ever evaluates `WHERE status = 'active'` (`workflowEngine.ts:866`,
`:1046`) — so a workflow silently downgraded to `draft` stops firing immediately
on save, with zero warning at the moment of clicking Save/Save Changes.

**Customer scenario:** A CX manager opens an already-active "NPS Drop Alert" to
tweak the Slack message wording or bump the cooldown from 1 hour to 4 hours,
clicks "Save Changes," and gets no error — the save succeeds and they're returned
to the list. The workflow now shows a "Draft" badge instead of "Enabled." Unless
they notice the badge changed (nothing calls this out — no toast, no confirmation
dialog, no "this will pause your workflow" warning), the workflow simply stops
protecting them. This reproduces `CUSTOMER_REVIEW.md`'s Scenario 3 (silent
integration failure) but from a self-inflicted cause that's arguably worse,
because the customer did the "right" thing (routine maintenance edit) and the
product punished them for it silently.

**Impact:** Critical / Must-Fix. This affects every single edit to every active
workflow across both builders — not an edge case, the default path. It directly
contradicts the reasonable mental model "editing a setting doesn't turn the whole
thing off," and will generate exactly the kind of "is this broken?" support
tickets `CUSTOMER_REVIEW.md` warned about for the cooldown default, except worse
because there's no UI text anywhere hinting this happens.

**Suggested fix shape (not implementing):** the save payload should omit `status`
entirely when editing (let the PUT's `if (x !== undefined)` pattern leave it
untouched, matching how scope/cooldown fields are already handled), or explicitly
preserve `wf.status` from the loaded record unless the user explicitly asks to
unpublish.

---

### 2. Canvas (branching) builder discards ALL action configuration on save

**Confirmed.** `app/src/lib/workflowCanvas.ts:54`, inside `serializeCanvas()`:
```ts
return { id: n.id, type: 'action', action: d.action, config: {} };
```
Every action node serializes with a hardcoded empty `config`, regardless of
action type. This is not a missing-field bug — there is no path to populate it at
all: `ActionNode` in `WorkflowCanvasPage.tsx` (lines 280-293) renders literally
one control, an action-type `<select>` dropdown, with zero other inputs. There is
no Slack channel field, no email/notify-target picker, no Jira project key, no
approver email for `flow.approval` — nothing. Every action in every branching
workflow saves with an empty config, always, by construction.

**Customer scenario:** A customer needs real branching logic ("if severity is
critical, open a Jira ticket AND page Slack; otherwise just log it") — exactly
the use case `XM_INDUSTRY_SCENARIOS.md` scenario 14 names as the canvas builder's
reason to exist, since the sentence builder can't express conditionals at all
(see Finding 6 below). They find the canvas (it's reachable — see Finding 7), lay
out trigger → condition → two action branches, pick "Jira: Create Issue" and
"Slack: Notify," save, and enable it. Every execution creates a Jira issue with
no project key and posts to Slack with no channel — both actions run against
whatever silent default/failure path each connector takes for missing config
(per `connectors.ts`, this is typically `status: 'skipped', reason:
'not_configured'`-shaped, i.e., nothing happens). The workflow "fires" in
execution history but delivers nothing, ever, for any action, on any canvas
workflow that has ever been built.

**Impact:** Critical / Must-Fix. This is the single worst functional gap found
in this entire audit — it means the canvas builder, the only way to build
genuine branching logic, cannot produce a working workflow at all today, for
any action type, unconditionally. `flow.approval` specifically compounds with
Finding on approvals below: a canvas-built approval node can pause execution but
can never carry an approver, so it pauses forever with nobody able to act on it
via the intended email-based approval flow.

---

### 3. 5 of 8 seeded gallery templates are dead on arrival (trigger never fires)

**Confirmed.** Cross-referencing the current `workflowRegistry.ts` against the
literal seed migrations:

| Template | Trigger used | Status |
|---|---|---|
| `nps-recovery` | `survey.response_filtered` | **No producer — never fires** |
| `verbatim-escalation` | `crystal.verbatim_escalation` | **No producer — never fires** |
| `nps-win-celebration` | `score.nps_rise` | **No producer — never fires** |
| `slow-completion-flag` | `survey.response_received` | **No producer — never fires** |
| `weekly-digest` | `time.schedule` (live) | Fires, but `notify.in_app` has no recipient config and no event `userId`/`targetUserIds` for a scheduled event → 0 notifications delivered every run |
| `survey-milestone-kickoff` | `survey.milestone` (fixed, now live) | Trigger works; Slack step works; in-app step's recipient resolution unverified beyond the producer's event shape |
| `critical-alert-to-zendesk` | `alert.fired` (live) | Fully functional once Zendesk credentials are configured — the healthiest template in the gallery |
| `anomaly-to-jira` | `crystal.anomaly_detected` (live) | Trigger fires; `notify.email` step ships with **no recipient configured at all**, so it always hits the (correct, Wave 7) fail-loud `no_recipient_configured` skip — the template's last action is dead on arrival as seeded |

**Customer scenario:** A new customer's very first action in the product is
almost certainly "click a template to see what this does." Per the gallery's own
positioning ("8 working templates"), they reasonably expect all 8 to work.
5 of 8 are built on triggers with zero backend producer — they will show
`● Enabled`, pass every validation check, and never fire, for any customer,
ever, regardless of configuration. Two more fire but silently deliver nothing
useful (empty in-app notification list, or a Jira-only workflow with a
dead email step). Only 1 of 8 (`critical-alert-to-zendesk`) is fully functional
out of the box once its integration is connected.

**Impact:** High / Must-Fix before any GA claim about the template gallery. This
is a direct extension of the already-tracked no-producer-trigger gap
(`XM_INDUSTRY_SCENARIOS.md`), but it's newly concrete here: it's not just "some
triggers don't work," it's "the majority of the flagship onboarding templates
don't work," which is the worst possible place for that gap to surface, since
templates are explicitly the low-effort, high-trust first path into the product.
Recommend either building producers for the 4 dead-trigger types these templates
depend on, or pulling/relabeling those 5 templates from the gallery until the
gap is closed — shipping a gallery that's 5/8 non-functional actively damages
trust more than a smaller, honest gallery would.

---

### 4. Run history cannot distinguish success from skipped/cooldown/paused — and "success" is literally unreachable

**Confirmed.** `app/src/pages/WorkflowsPage.tsx`'s `RunHistory` component
(lines 536-541) renders the status icon via:
```ts
name={exec.status === 'success' ? 'check_circle' : exec.status === 'failed' ? 'cancel' : 'schedule'}
```
But the backend's `RunResult`/`ActionResult` status union
(`workflowEngine.ts:99,108`) and every place that writes to
`workflow_executions.status` uses `'completed'` for success — never the string
`'success'`. I confirmed this directly: `finalizeExecution` writes whatever
`res.status` is (`'completed' | 'failed' | 'skipped' | 'waiting'`), and no code
path anywhere in the backend ever produces the literal string `'success'`.
**The green checkmark branch in `RunHistory` is dead code — it can never render.**
Every successful execution, every skipped one (missing recipient, connector not
configured), every cooldown-suppressed one, and every approval-paused one all
render with the identical neutral gray "schedule" icon, distinguished only by
whatever text happens to be in `error_message` — which is empty for skipped/
cooldown/waiting states (those use a separate `output.reason` field the list
query doesn't even select).

**Customer scenario:** A CX manager opens run history to confirm their workflow
is healthy. Every single row — the ones that worked perfectly, the ones silently
skipped because Jira was never connected, and the one currently paused awaiting
an approval — looks visually identical (same gray clock icon, no distinguishing
text). There is no way to visually scan for problems; the only signal that
exists at all is the red "failed" icon for hard exceptions, which per the
Integrations audit (see below) is not how most real-world misconfigurations
actually fail.

**Impact:** High. This compounds directly with `CUSTOMER_REVIEW.md`'s already-
flagged C-007 (no health summary) — it means even a customer willing to click
into a workflow's detail view and read line-by-line still cannot tell success
from silent failure, because the one piece of UI built for exactly that job is
using a string the backend never emits.

---

### 5. Crystal chat creates workflows as inert drafts with no activation prompt, and integrations have zero cross-workflow visibility at disconnect time

**Confirmed, two compounding gaps.**

**5a.** `app/src/components/CrystalPanel.tsx`'s `create_workflow` handler
(line 733-744) creates the workflow with `status: 'draft'` (matching the
builders' own default) and shows the toast: `"Workflow created: \"{title}\".
Open Workflows to manage it."` Given Finding 1 above (draft workflows never
fire) and the fact the list page has no search/filter beyond scope (confirmed
by the WorkflowsPage audit — no name search, no "recently created" sort), a
customer who approves a Crystal-proposed workflow reasonably reads "Workflow
created" as "workflow is now protecting me," navigates away, and the workflow
sits inert until they separately discover it in an unfiltered list and click
the ambiguously-labeled "Resume" button (see Finding 6c). Nothing in the
confirm-card or toast says "you still need to activate this."

**5b.** `app/src/pages/settings/IntegrationsSettingsPage.tsx`'s Disconnect flow
shows only a generic "Are you sure you want to disconnect {connector}?" dialog
— no count, no list of workflows currently using that connector. No backend
endpoint joins `workflows` to connector usage anywhere in the codebase (confirmed
by full grep of `backend/src/routes` and `backend/src/lib`). Separately, the
workflow builder itself never fetches `GET /api/workflow-credentials` — an
admin building a `jira.create_issue` action gets the same static "env"-tier
readiness dot regardless of whether Jira is actually connected for their org.

**Customer scenario (5b):** An admin rotates a leaked Jira API token by
disconnecting and reconnecting Jira in Integrations Settings. They have 3 active
workflows using `jira.create_issue`. Disconnect gives no warning any workflow
depends on it. Between disconnect and reconnect (or if reconnect is delayed),
those 3 workflows silently skip their Jira step on every trigger with no visible
signal (per Finding 4, `skipped`/`not_configured` renders identically to a
healthy run).

**Impact:** High for 5b (this is a "confidently break production silently" trap
during completely routine credential hygiene — worse than a nitpick because
credential rotation is a security best practice the product is actively
punishing). Medium-high for 5a (compounds directly with Finding 1's blast
radius and the already-known trust-building stakes of a brand-new user's first
NL-builder interaction, called out in `XM_INDUSTRY_SCENARIOS.md` scenario 12).

---

## Full findings by surface

### 1. Workflow list page (`WorkflowsPage.tsx`)

**1a. No health signal beyond lifetime success rate (C-007 confirmed still not built).**
The card shows only `run_count`, a lifetime (not 7-day rolling) `success_rate`,
and last-run timestamp (`WorkflowsPage.tsx:39-48`, `:346-350`) — no
`consecutive_failures`, no rolling window, no warning/critical visual tier.
`health_summary` was never added to `GET /api/workflows` in any wave. A workflow
failing 12 of its last 14 runs still shows `● Enabled` with muted "86% success"
text — reproduces `CUSTOMER_REVIEW.md` Scenario 3 exactly. *Confirmed, High
priority, tracked-since-review but still fully open.*

**1b. Toggle and Delete silently swallow API failures.** `useWorkflows.ts:60-61`
(`toggleWorkflow`) and `:69-70` (`deleteWorkflow`) both optimistically update
local state and `catch { /* optimistic */ }` — a server-side failure (RBAC edge
case, network blip, 500) leaves the UI showing the action succeeded (workflow
appears disabled/deleted) while the backend row is untouched. *Confirmed, Medium-
High — this is a correctness bug, not polish, since it can leave a workflow live
when the customer believes they disabled or deleted it.*

**1c. Retry endpoint exists but has no UI trigger anywhere.** `api.ts:1348-1351`
(`retryWorkflowExecution`, wired to a real, tested `POST
/api/workflows/executions/:execId/retry`) has zero call sites in
`app/src` outside its own definition and tests. A failed execution can never be
retried from the product — the backend capability is complete and dead from the
frontend's perspective. *Confirmed, High — directly blocks the "retry from here"
flow `CUSTOMER_REVIEW.md` Scenario 5 assumed existed.*

**1d. No text search, status filter, trigger-type filter, or sort.** Only the
scope filter bar (org/survey/tag) exists. No way to search by name or filter to
"only workflows in an Error state." *Confirmed. Should-Fix, worsens as workflow
count grows past ~15-20 (a customer with a large gallery of active workflows —
now made worse by Finding 5a's "go find your new workflow in the list"
scenario).*

**1e. Pending Approvals rows carry almost no context.** Each row shows only
`workflow_name` and a static "waiting" string — no execution payload, no
description of what the paused action would actually do, no elapsed-wait time.
The approve/reject call itself also silently swallows errors on failure.
*Confirmed, Should-Fix — a customer cannot make an informed approve/reject
decision from the row alone, and can be told an action succeeded when it
didn't.*

**1f. Creator attribution data exists end-to-end but is never rendered.**
`workflows.created_by` is captured on INSERT and returned via `SELECT *`, but
`WorkflowsPage.tsx` never reads or displays it — no avatar, no name, no "created
by me" filter. This is C-005's Phase-1 ask from `CUSTOMER_REVIEW.md`, confirmed
still fully unaddressed at the UI layer despite the data being one field-read
away. *Confirmed, Must-Fix per the original review's own phasing — cheaper to
close than most items in this document since no backend work is needed.*

### 2. Sentence builder & action config forms

**2a. `notify.webhook` — a live, fully-wired backend action — has zero frontend
configuration.** `SimpleActionConfigForm.tsx`'s `FIELDS_BY_ACTION` has no entry
for `notify.webhook`, and it's not in `ContentCustomizationPanel.tsx`'s
`CONTENT_PRODUCING_ACTIONS` set either. Selecting "Webhook" renders "No
configuration needed" even though `executeAction`'s `notify.webhook` case reads
`config.url`/`config.payload`/`config.headers`/`config.method`/`config.secret`
directly. *Confirmed by direct file read. High priority — this is the exact same
bug class as the pre-Wave-9 `notify.in_app` gap, just on a different action
type, and it was missed by that fix's own sweep. Every webhook action silently
no-ops forever (`status: 'skipped', reason: 'no_url'`).*

**2b. `crystal.classify` also falls through to "no configuration needed."**
Lower urgency than 2a since it's a stub action, but the UI gives no indication
it's a stub beyond a small readiness-dot tooltip elsewhere. *Confirmed, Low-
Medium.*

**2c. 7 of 13 triggers are selectable with zero readiness signal in the UI.**
Actions have a readiness dot (green/amber/grey + tooltip) via `ActionTile.tsx`.
Triggers have no equivalent — `TriggerTile.tsx`/the underlying
`WorkflowTriggerDef` type carries no `live` field at all, so a no-producer
trigger (7 remain even after the milestone rename) renders identically to a
working one. *Confirmed. High — this is strictly worse than the action-side
version of the same problem, because there the dot at least exists; here there's
no visual signal whatsoever, and it directly explains why the dead-trigger
templates in Finding 3 look indistinguishable from working ones at build time.*

**2d. The primary Sentence Builder cannot build conditions at all.** Confirmed
by reading the full `WorkflowBuilderPage.tsx`: its only steps are
`'trigger' | 'scope' | 'action'` — no condition step, no reference to
`CONDITION_FIELDS`/`CONDITION_OPERATORS` anywhere in `serialize()`. The only
condition-editing surface in the entire product is the Canvas builder's
`ConditionNode`, whose `field` input is **raw free text**, not a dropdown of the
registry's 8 declared condition fields — a customer must type the exact
field key from memory. A mistyped field key (`NPS` vs `nps`) resolves to
`undefined` forever with zero validation error, silently making the condition
always-false (or always-true for `neq`). *Confirmed. High — "if NPS drops, notify
support" is arguably the single most common workflow a CX customer would want to
build, and building it requires leaving the flagship builder for a more
technical, unguarded canvas surface with no discoverability signposting (see
Finding 7).*

**2e. Draft is real and engine-enforced — but every save defaults to it with no
"Publish" affordance, and the one control that activates it is mislabeled.**
Covered in Top-5 Finding 1 for the edit-mode danger; the first-time-creation
angle is separate and also real: there is no "Save as Draft" vs "Save and
Enable" choice anywhere in either builder — every new workflow is silently
`draft` regardless of intent, and the only way out is the list page's toggle
button, unconditionally labeled **"Resume"** even for a workflow that has never
once run (`WorkflowsPage.tsx:373-374`: `wf.status === 'active' ? 'Pause' :
'Resume'`). *Confirmed. High — "Resume" is actively misleading copy for a
first-time activation, implying a prior active state that never existed.*

### 3. Branching canvas (`WorkflowCanvasPage.tsx`)

Covered in Top-5 Finding 2 (action config wholly discarded on save — the
canvas's core, release-blocking defect). Additional findings:

**3a. Discoverability is better than the design docs feared, but not uniformly.**
`WorkflowsPage.tsx` has a first-class, always-visible "Build on Canvas" header
button (lines 191-194) alongside "Build with Crystal" and "Build Visually" — so
at the list-page level, canvas is not a hidden escape hatch. However, the
in-builder link (`WorkflowBuilderPage.tsx`'s "Advanced: Branching Canvas,"
lines 452-454) is a small `variant="link"` control in a crowded toolbar — a user
who starts in the sentence builder and needs branching may plausibly miss it.
*Confirmed; narrower and less severe than `XM_INDUSTRY_SCENARIOS.md` scenario 14
originally worried, worth noting as a partial resolution rather than a new
finding at the list-page level, but the in-builder link remains genuinely
low-visibility.*

**3b. No test-run capability inside either builder.** `testWorkflow` only exists
on `WorkflowsPage.tsx` — a customer must save first, then return to the list, to
test a workflow at all. *Confirmed, Medium — an iteration-speed gap, not a
correctness bug.*

### 4. NL builder (`WorkflowNLBuilderPage.tsx`)

Overall UX for failure/timeout/low-confidence states is genuinely solid — this
surface is in noticeably better shape than the rest of the audit. Two real, if
minor, gaps found:

**4a. "Build Manually" from the Timeout state loses the customer's typed
description.** `buildManually()` (lines 171-173) navigates to canvas with no
router state at all — the confirm-card/low-confidence paths correctly hand off
a full seed, but the timeout path drops the typed text on the floor entirely.
*Confirmed, Low-Medium — defensible (no structured parse exists on a timeout),
but the raw text itself could still be preserved for reference/re-paste.*

**4b. The confidence badge is real (not dead code) but only shown in the
success path**, never in the low-confidence state where it would arguably be
more useful context. *Confirmed, Low, cosmetic-consistency only.*

The previously-flagged CrystalOS↔backend live-integration risk
(`XM_INDUSTRY_SCENARIOS.md` scenario 12) remains open and unchanged since Wave 3
— nothing in Waves 7-9 touched or re-verified it.

### 5. Templates

Covered in Top-5 Finding 3 in full (5 of 8 templates dead on arrival, 2 more
silently under-deliver, only 1 fully functional out of the box). One additional
note: the `survey.milestone_reached` → `survey.milestone` rename **did** land
correctly (confirmed in the current registry and the fixup migration
`20260701130100_workflow_template_fixes.sql`), and no template references the
now-stale string — that specific piece of technical debt is genuinely closed,
credit where due.

### 6. Integrations settings & connector safety

**6a. Zero cross-reference between a connector and the workflows using it, at
disconnect time or anywhere else.** Covered in Top-5 Finding 5b.

**6b. Missing-credential failures are structurally clean on the backend but
invisible on the frontend.** `connectors.ts` correctly returns
`{status:'skipped', output:{reason:'not_configured'}}` rather than throwing —
good backend hygiene — but per Top-5 Finding 4, the run-history UI has no branch
for `skipped` at all, so this clean signal never reaches the customer in
legible form. *Confirmed, High — the backend did the hard part correctly; the
frontend half of the fix was never built, making the improvement invisible.*

**6c. The builder never checks connector status while a customer is configuring
an action that needs one.** `GET /api/workflow-credentials` is called only from
`IntegrationsSettingsPage.tsx` — zero references from any workflow-builder file.
Adding a `jira.create_issue` action shows the same static "env"-tier readiness
dot regardless of whether the org has actually connected Jira. *Confirmed, High
— this is the direct mechanism behind the "customer builds a whole workflow
around Jira and discovers 6 days later nothing fired" scenario the audit brief
specifically asked about; there is truly zero warning anywhere in the builder
flow.*

**6d. Crystal Signals' "Growth plan" gating is 100% aspirational marketing copy
with zero code enforcement.** Grepped the entire backend and frontend for any
tier/plan/entitlement check on `crystal.anomaly_detected`/`crystal.sentiment_spike`/
`crystal.new_theme_detected` — none exists. The only artifact is a locale string
(`crystalTooltip`, wired to a tooltip on the trigger tile in
`TriggerTile.tsx:42`) that says "Crystal Signals require a Growth plan" with no
backing check anywhere — not in `workflowRegistry.ts`'s type definitions
(`WorkflowTriggerDef` has no plan field), not in any route middleware, not in
any frontend disabled-state. A billing/plan system exists generically elsewhere
in the codebase (`creditPlans.ts`, `billing.ts`) but is never referenced from
any workflow file. *Confirmed. Medium-High priority if Growth-tier pricing is
already being sold on this claim — it's currently pure revenue leakage: every
customer on every plan, including Free, has full unrestricted access to the
exact capability marketing calls the paid differentiator.*

### 7. Approvals (`flow.approval`)

**7a. No TTL/expiry mechanism — a pending approval sits forever.** Confirmed by
checking every scheduled job in `backend/src/scheduler/registry.ts` (5 jobs,
none touch `workflow_approvals` or `status='waiting'`) and the existing
stuck-execution reaper (`workflowQueue.ts::reapStuckExecutions`, which
explicitly only matches `status='executing'`, never `'waiting'`). This is a
different failure mode than the reaper was built for, and nothing covers it.
*Confirmed, High/Must-Fix-adjacent for any time-sensitive approval use case — an
approver who leaves the company or misses a notification permanently strands
that execution with no auto-escalation, no re-notification, and no one alerted.*

**7b. Paused-on-approval executions are visually indistinguishable from normal
runs in history.** Ties directly into Top-5 Finding 4 — `waiting` status falls
into the same generic gray icon bucket. A customer would reasonably conclude a
paused execution is "stuck" or "still running" rather than understanding it
needs their action via the (separately under-informative, per 1e) Pending
Approvals panel. *Confirmed, High.*

**7c. Minor: a malformed decision payload defaults to approved, not rejected.**
`POST /api/workflows/approvals/:executionId`'s decision parsing
(`workflows.ts:59`) treats anything that isn't literally `'reject'`/`'rejected'`
as `'approved'` — a client bug or malformed request silently approves rather
than failing safe. *Confirmed, Low-Medium — narrow but worth a fail-closed
default given approvals gate consequential actions by design.*

### 8. Crystal chat's `create_workflow` path

Covered in Top-5 Finding 5a. Additionally: the resulting workflow is genuinely
findable and editable afterward (it does land as a normal row via
`createGraphWorkflow`, `invalidate('workflows')` correctly refreshes the list) —
so this is not a "lands in a weird unreachable state" bug, it's specifically a
"looks activated, isn't" messaging gap layered on top of the universal
draft-by-default problem (Finding 2e).

### 9. Run history / observability

Covered extensively in Top-5 Finding 4 and section 6b above. One additional,
distinct finding:

**9a. Dead-letter status exists in the schema but is never surfaced anywhere.**
`workflow_executions.dead_letter` (boolean) plus `attempt_count`/`next_retry_at`
fully capture "will auto-retry" vs. "retries exhausted" — but the
`GET /:id/executions` query never selects any of the three columns, and the
frontend type/rendering has zero knowledge of them (confirmed via grep — zero
non-test references in `app/src`). *Confirmed, Should-Fix — the data modeling
work is already done; this is purely an unexposed API field plus a missing UI
branch, cheaper to close than most findings here.*

### 10. Cross-cutting

**10a. Concurrent edits are last-write-wins, silently.** No version/etag/
`updated_at`-comparison exists on `PUT /api/workflows/:id` or
`updateWorkflowSchema`. Two admins with `workflows:manage` editing the same
workflow: the second save unconditionally overwrites the first with no warning
to either party. *Confirmed. This directly extends C-005's already-flagged
"undefined RBAC/collaboration model" — the specific new information here is
that it's not just permissions that are undefined, saves themselves have no
conflict protection at all.*

**10b. No `updated_by` column — only `created_by`.** `workflows` captures who
created a row but never who last modified it; no separate audit-log/history
table exists (`workflow_executions` logs run telemetry only, never config
changes). *Confirmed. An admin cannot answer "who changed this workflow's
recipient last week" — a real gap for any enterprise security/compliance
conversation, extending C-005/C-003's already-named "Missing Enterprise
Workflow Features" audit-log ask from `CUSTOMER_REVIEW.md`.*

**10c. Tier gating — see 6d above** (repeated here only for cross-reference
completeness; not a duplicate finding).

---

## What this means, prioritized for engineering dispatch

**Fix immediately (both are one-line-shaped fixes with outsized blast radius):**
1. Stop both builders from sending `status: 'draft'` unconditionally on save —
   omit the field on edit, or preserve the loaded workflow's existing status.
2. Wire `SimpleActionConfigForm.tsx`'s `FIELDS_BY_ACTION` for `notify.webhook`
   (url/method/headers/payload/secret) — same shape as the Wave 9 `notify.in_app`
   fix, just a different action type that fix's sweep missed.

**Fix next (structural, each blocks a whole surface from delivering value):**
3. Canvas builder action config — either give `ActionNode` real per-action-type
   fields (mirroring the sentence builder's `SimpleActionConfigForm`/
   `ContentCustomizationPanel`), or explicitly gate canvas-builder actions behind
   a "configure in sentence view" round-trip until real fields exist. Shipping
   the canvas builder as-is with silently-empty configs is worse than not having
   it.
4. Template gallery — either build producers for the 4 remaining dead-trigger
   types these templates depend on, or pull/relabel the 5 non-functional
   templates. A gallery that's 5/8 broken actively erodes the trust the gallery
   exists to build.
5. Run-history status rendering — fix the `'success'` vs `'completed'` string
   mismatch (trivial), then add real branches for `skipped`/`cooldown`/`waiting`
   with the human-readable reason already available in `output.reason` (just
   needs to be selected by the query and rendered).

**Fix soon (real, but narrower blast radius each):**
6. Cross-reference workflows to connector usage before allowing Disconnect (or
   at minimum warn with a count).
7. Wire the already-built, already-tested retry endpoint to an actual button in
   `RunHistory`.
8. Approval TTL/expiry — even a simple "flag as stale after 72h + re-notify"
   sweep (mirroring the existing `expireStaleBroadcasts` pattern already used
   elsewhere in the scheduler) would close the worst of this.
9. Surface `created_by` on the workflow card (data already exists, zero backend
   work) and add an `updated_by` column for the next audit-trail pass.
10. Either build real tier enforcement for Crystal Signal triggers or stop
    marketing them as gated, whichever matches the actual GTM timeline.

**Track, don't drop everything for:** toggle/delete silent-failure-on-error
(1b), no search/filter on the list page (1d), thin Pending-Approvals context
(1e), sentence builder's total absence of a condition step (2d, note this is
larger than a quick-fix — it may need real design work, not just a form field),
dead-letter status not surfaced (9a), concurrent-edit last-write-wins (10a).
