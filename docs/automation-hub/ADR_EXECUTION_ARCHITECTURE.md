# ADR: Workflow Execution Architecture — Async Queue, Retry/DLQ, Idempotency

**Status:** Accepted
**Author:** Priya Krishnamurthy (Principal Backend Architect, Xperiq Actions)
**Date:** 2026-07-01
**Supersedes:** the literal schema DDL in `docs/automation-hub/WORKFLOW_SYSTEM.md` §8, and
`docs/automation-hub/TEAM.md`'s mandate line *"Design the BullMQ queue topology: trigger
evaluation queue, action execution queue, retry queue, DLQ"* (Priya's mandate, item 2).
The trigger/action/phase content in both docs — trigger taxonomy, action taxonomy, phase
sequencing, condition operators, node/edge model — is still valid and unaffected by this ADR.

---

## 1. Context: the docs described a system that was never built this way

`docs/automation-hub/TEAM.md` and `docs/automation-hub/WORKFLOW_SYSTEM.md` were written
2026-06-29, describing a **planned** Phase 1 build: a 5-table (TEAM.md) / 6-table
(WORKFLOW_SYSTEM.md §8) relational schema (`workflows`, `workflow_conditions`,
`workflow_actions`, `workflow_triggers`, `workflow_runs`/`workflow_executions`,
`workflow_run_steps`/`workflow_step_executions`, `workflow_templates`,
`workflow_connector_credentials`) and a **BullMQ** queue topology (trigger evaluation
queue, action execution queue, retry queue, DLQ).

The actual workflow engine shipped 2026-06-25 — four days *before* those docs were
written — as part of the broader platform build, independently of the Automation Hub
docs/team process. It took a different, simpler shape:

- **One `workflows` table**, evolved in place (`supabase/migrations/20260603000018_workflows_v2.sql`)
  from a pre-existing legacy `condition`/`action` automation table, with the graph
  (nodes + edges) stored as **JSONB columns** rather than normalized
  `workflow_conditions`/`workflow_actions` tables. No separate `workflow_triggers`
  table — a workflow's trigger type lives on `workflows.trigger_type` and the trigger
  node's `config.cron` (for `time.schedule`).
- `workflow_executions`, `workflow_step_executions`, `workflow_templates`,
  `workflow_approvals` — four tables, not five/six, and no
  `workflow_connector_credentials` table (connector credentials are a separate concern
  owned elsewhere — see `lib/workflowCredentials.ts`).
- **No BullMQ.** The codebase has no BullMQ/Bull dependency anywhere. All existing async
  work — the notification/alert event bus — runs on **Redis Streams + consumer groups**
  (`lib/notificationEvents.ts` + `eventEngine/processor.ts`), following the
  XREADGROUP/XACK/XAUTOCLAIM pattern for at-least-once delivery with crash recovery.
  Until this ADR, workflow execution itself had **no separate queue at all**: the Event
  Engine called `runWorkflowsForEvent()` synchronously, inline, inside the same
  `handleEvent()` that persists notifications — so a slow or hung workflow action (e.g.
  a webhook to a slow third party) could delay notification delivery for unrelated
  events sharing the same consumer loop.

This ADR resolves the discrepancy going forward: **the JSONB graph-engine schema and the
Redis Streams async pattern are the system of record.** We are not migrating to the
TEAM.md/WORKFLOW_SYSTEM.md schema or introducing BullMQ.

## 2. Decision

### 2.1 Schema: extend the existing JSONB graph-engine schema, don't replace it

Keep `workflows` (JSONB `nodes`/`edges`) + `workflow_executions` +
`workflow_step_executions` + `workflow_templates` + `workflow_approvals` as the
permanent shape. This migration (`20260701090000_workflow_async_queue.sql`) adds four
columns to `workflow_executions` — `idempotency_key`, `attempt_count`, `next_retry_at`,
`dead_letter` — rather than introducing new tables. A "dead letter" is simply a
`workflow_executions` row with `dead_letter = TRUE`; it is queried directly
(`WHERE dead_letter = TRUE`), no separate DLQ table.

**Why:** the JSONB graph model is already live, already has a working builder-agnostic
execution engine (`lib/workflowEngine.ts`: `runGraph`/`runNodes`, branching, pause/resume
for approvals), already has passing tests, and already has three migrations layered on
top of it. Normalizing into `workflow_conditions`/`workflow_actions` tables now would be
a rewrite of a working system for schema-purity reasons only, with no functional gain —
the JSONB shape is strictly more flexible for a node/edge graph than normalized rows,
and every field the six-table design wanted (retry_count, idempotency_key on steps,
parent_execution_id) is addressable as columns on the existing tables instead.

### 2.2 Async execution: Redis Streams, not BullMQ

New module `backend/src/lib/workflowQueue.ts`: a dedicated stream (`workflow:triggers`,
env-overridable via `WORKFLOW_TRIGGER_STREAM`) + consumer group (`workflow-processor`),
built with the exact same primitives as `eventEngine/processor.ts`'s notification
consumer — `XADD` to publish, `XREADGROUP`/`XACK` to consume with at-least-once
semantics, `XAUTOCLAIM` to reclaim a crashed consumer's pending messages.

`eventEngine/processor.ts::handleEvent` now calls
`workflowQueue.publishWorkflowTrigger({ orgId, triggerType, event })` instead of calling
`workflowEngine.runWorkflowsForEvent()` inline. The consumer loop (started in
`workflowQueue.start()`) reads off the stream and calls the **existing**
`runWorkflowsForEvent`/`runWorkflow` from `lib/workflowEngine.ts` — no execution logic is
duplicated. This decouples workflow evaluation latency from notification delivery: a
workflow with a slow webhook action no longer delays ACKing unrelated notification
events on the shared consumer loop.

**Why Redis Streams over BullMQ, explicitly:**
1. **Zero new dependency.** BullMQ is not in `package.json` anywhere in this codebase.
   Adding it here would introduce a second queue library alongside the Streams pattern
   already used for the (functionally identical) notification-event queue — two ways to
   do the same thing, for no capability BullMQ provides that Streams consumer groups
   don't already cover for this workload (ordered-enough delivery, consumer groups,
   pending-entry crash recovery, MAXLEN trimming).
2. **Consistency with the eventEngine precedent.** Anyone who has read
   `eventEngine/processor.ts` already understands `workflowQueue.ts` — same shape, same
   function names (`processBatch`, `reclaimStale`, `ensureGroup`), same lifecycle
   (`start`/`stop`, started from both the in-process backend path
   `ENABLE_EVENT_ENGINE=true` and the standalone Event Engine service
   `eventEngine/index.ts`).
3. **Same operational/monitoring surface.** Ops already monitors Redis Streams
   (consumer group lag, pending-entries count) for the notification queue; a second,
   structurally different queue technology (BullMQ's own Lua-scripted job store) would
   mean a second monitoring playbook, a second failure mode taxonomy, and a second set
   of Grafana panels for what is operationally the same kind of workload.
4. **No BullMQ-specific feature is needed.** BullMQ's main advantages over raw Streams —
   job priorities, rate limiting per job, delayed jobs as first-class citizens — aren't
   required here: retry/backoff is handled via `next_retry_at` + a periodic sweep (§2.3),
   which is the same "poll a due-column" shape already used by `scheduler/runner.ts` and
   `eventEngine/processor.ts`'s own cron tick.

### 2.3 Retry, backoff, and dead-letter semantics

Constants (exported from `lib/workflowQueue.ts`, env-overridable, so QA can assert them
precisely):

| Constant | Default | Env override |
|---|---|---|
| `RETRY_BASE_MS` | 30,000 (30s) | `WORKFLOW_RETRY_BASE_MS` |
| `RETRY_FACTOR` | 2 | `WORKFLOW_RETRY_FACTOR` |
| `MAX_ATTEMPTS` | 5 | `WORKFLOW_MAX_ATTEMPTS` |

`backoffMs(attempt)` = `RETRY_BASE_MS * RETRY_FACTOR^(attempt-1)` — i.e. 30s, 60s, 120s,
240s before attempts 2 through 5; the 5th failure (attempt count reaches `MAX_ATTEMPTS`)
dead-letters instead of scheduling another retry.

**Where this is stamped:** `workflowEngine.ts::finalizeExecution` (the single place every
terminal execution status is written) reads the execution's current `attempt_count`,
increments it, and — on a `'failed'` status — sets `next_retry_at = now + backoffMs(attempt)`
if `attempt < MAX_ATTEMPTS`, else sets `dead_letter = TRUE` and leaves `next_retry_at`
NULL. This is a lazy `require('./workflowQueue')` inside `finalizeExecution` (see §4) so
the single source of truth for the backoff schedule lives in one module.

**The sweep:** `workflowQueue.sweepDueRetries()` runs once a minute (same interval tick
as the stale-consumer reclaim, wired into `workflowQueue.start()`) and:
1. Marks `dead_letter = TRUE` for any `status = 'failed'` execution whose
   `attempt_count >= MAX_ATTEMPTS` and `next_retry_at` has passed (a safety net catch —
   in the normal path `finalizeExecution` already sets `dead_letter` on the terminal
   attempt, so this UPDATE is usually a no-op affecting 0 rows).
2. Re-publishes (via `publishWorkflowTrigger`) any `status = 'failed'`,
   non-dead-lettered execution whose `next_retry_at` has passed, then clears
   `next_retry_at` so it isn't republished again before the retried run's own
   pass/fail re-stamps it.

**Manual replay is unchanged:** `POST /api/workflows/executions/:execId/retry`
(`routes/workflows.ts`, pre-existing) still works unmodified against dead-lettered rows —
it doesn't check `dead_letter` today and doesn't need to; a human explicitly retrying a
`status = 'failed'` execution is a deliberate action distinct from the automatic sweep.

### 2.4 Idempotency key derivation

Redis Streams consumer groups are at-least-once: `XAUTOCLAIM` can redeliver a message a
crashed consumer already fully executed. The key must collapse **duplicate delivery of
the same logical trigger for the same workflow**, not just "this exact stream entry ID" —
because the retry sweep (§2.3) deliberately re-publishes a *new* stream entry for the
same logical retry, and that republish must still be able to correlate back to the
original failed execution rather than creating an unbounded string of duplicate rows on
every redelivery-of-a-redelivery.

**Key shape:** `${orgId}:${workflowId}:${triggerType}:${dedupField}`, where `dedupField`
is the first of `event.responseId` / `event.entityId` / `event.id` that is present on the
trigger payload, falling back to the originating stream entry ID when the event carries
no natural dedup field. Derived per-workflow (not per-event) because one trigger event
fans out to N active workflows subscribed to that trigger type, and each of those N
executions is an independent unit of work that needs its own idempotency slot.

**Enforcement:** `uq_wf_exec_idempotency_key` — a partial unique index on
`workflow_executions(idempotency_key) WHERE idempotency_key IS NOT NULL` — plus
`INSERT ... ON CONFLICT (idempotency_key) DO NOTHING RETURNING id` in
`workflowEngine.ts::runWorkflow`. When the INSERT returns no row, `runWorkflow` returns
`null` and no action executes — a duplicate redelivery is a guaranteed no-op, not a
best-effort one. The `idempotencyKey` param is **optional**: manual invocations (the
`/:id/test` and `/executions/:execId/retry` routes) omit it and always get a fresh
execution row, which is correct — an explicit human retry should never be silently
deduped against a prior automatic attempt.

### 2.5 Scheduled-workflow tick (`time.schedule` cron trigger)

The task brief that kicked off this work flagged `runScheduledWorkflows()` (the
`time.schedule` cron sweep in `workflowEngine.ts`) as dead code — defined but never
called. On inspection of the current repo state, **this is already fixed**:
`eventEngine/processor.ts::start()` already wires a `cronTick` `setInterval` (once a
minute, per the doc comment on `runScheduledWorkflows`) that calls it, and the interval
is cleared in the same shutdown path as the notification consumer's `alertSweep`. This
predates the current work (committed 2026-06-23, commit `1072bf0`) — no code change was
needed here. Noted for the record since the original task brief's premise about this
specific piece was stale; flagging so nobody "fixes" it twice.

## 3. What Kenji (QA) needs to test

- `backoffMs(1..5)` against `RETRY_BASE_MS`/`RETRY_FACTOR` — exact values, not just "it
  grows." Constants are exported named values specifically so this can be asserted
  precisely rather than snapshot-tested.
- Dead-letter transition exactly at `attempt_count === MAX_ATTEMPTS` (off-by-one is the
  classic bug here — attempt 5 with `MAX_ATTEMPTS=5` must dead-letter, not schedule a
  6th attempt).
- Idempotent duplicate handling: same `(orgId, workflowId, triggerType, dedupField)` via
  two different stream entry IDs (simulating an XAUTOCLAIM redelivery) must produce
  exactly one `workflow_executions` row and exactly one side effect (e.g. one
  notification sent), not two.
- The retry sweep's republish must clear `next_retry_at` so it isn't picked up twice in
  the same or a subsequent sweep before the retried attempt resolves.
- Chaos scenario per Kenji's mandate (duplicate trigger events, mid-flight Redis
  disconnect during `XREADGROUP`): confirm `reclaimStale` + the idempotency constraint
  together prevent a double-charge-shaped bug (e.g. two Slack messages for one NPS drop).

## 4. Implementation notes / minimal touch to `workflowEngine.ts`

Per scope, `lib/workflowEngine.ts` was intentionally treated as reuse-only. Three small,
additive changes were unavoidable and are called out explicitly:

1. `finalizeExecution` now branches on `status === 'failed'` to stamp
   `attempt_count`/`next_retry_at`/`dead_letter`, reading `backoffMs`/`MAX_ATTEMPTS` via
   a lazy `require('./workflowQueue')` (avoids a static circular import, since
   `workflowQueue.ts` imports `runWorkflowsForEvent` from `workflowEngine.ts` at the top
   level — mirrors the existing lazy-require pattern already used in
   `eventEngine/processor.ts` for cross-module calls).
2. `runWorkflow`'s options now accept an optional `idempotencyKey`; the function returns
   `WorkflowRunResult | null` (`null` = duplicate, no-op). Both existing manual callers
   (`routes/workflows.ts`'s `/test` and `/executions/:id/retry`) are unaffected — they
   don't pass a key and don't destructure a `null` case they'd need to guard.
3. `runWorkflowsForEvent` gained an optional trailing `streamId` param, used only to
   derive the per-workflow idempotency key (§2.4); omitted, behavior is identical to
   before.

No change to `executeAction`, `runGraph`, `runNodes`, `resumeWorkflow`, or the
approval/pause state machine — the execution engine's core logic is untouched.

## 5. What David (integrations) and Nina need to know

- **New exports** from `lib/workflowQueue.ts`: `publishWorkflowTrigger`,
  `runWorkflowsForEvent`'s new optional `streamId` param, `RETRY_BASE_MS`,
  `RETRY_FACTOR`, `MAX_ATTEMPTS`, `backoffMs`, `idempotencyKey`, `sweepDueRetries`,
  `STREAM_KEY`, `GROUP`.
- **New env vars** (all optional, safe defaults — see `docs/ENV_VARS.md`):
  `WORKFLOW_TRIGGER_STREAM` (default `workflow:triggers`), `WORKFLOW_RETRY_BASE_MS`
  (30000), `WORKFLOW_RETRY_FACTOR` (2), `WORKFLOW_MAX_ATTEMPTS` (5). Documented in
  `backend/.env.example` (the sandbox this change was authored in denies direct writes
  to the **root** `.env.example`, so — following the same workaround already used for
  the connector-credential vars added alongside this change — they're appended to
  `backend/.env.example` with a note explaining they canonically belong in the root
  file; someone with write access should move them there in this PR or a fast-follow).
- **New columns** on `workflow_executions` (migration
  `20260701090000_workflow_async_queue.sql`): `idempotency_key TEXT` (nullable, unique
  when set), `attempt_count INT NOT NULL DEFAULT 0`, `next_retry_at TIMESTAMPTZ`,
  `dead_letter BOOLEAN NOT NULL DEFAULT FALSE`. Any new code reading/writing
  `workflow_executions` (e.g. David's integration-action work, Nina's dashboards) should
  be aware `status = 'failed'` no longer means "terminal, no further action" — a failed
  row may still be retried automatically unless `dead_letter = TRUE`.
- **Behavior change:** workflows triggered by the event bus (survey/score/alert/Crystal
  triggers routed through `eventEngine`) now execute **asynchronously** — there can be a
  short delay (normally sub-second; up to the consumer's 5s block timeout under load)
  between the triggering event and workflow execution, whereas previously it was
  synchronous within the same event-handler call. `time.schedule` and manual
  test/retry runs are unaffected (they don't go through this queue).
- **Dead letters are queryable directly:** `SELECT * FROM workflow_executions WHERE
  dead_letter = TRUE` (indexed via `idx_wf_exec_dead_letter`) — no new table to join.

## Sign-off

**Reviewer:** Nina Reeves (Senior Engineer, Platform Integration and Architectural
Integrity)
**Date:** 2026-07-01
**Verdict: Approved, with one correctness bug found and fixed during review (see
below) and one pre-existing gap flagged for a fast-follow (not blocking).**

### What I checked

1. **JSONB graph-engine schema over the six-table normalized design.** Agree this is
   the right call. The `workflows` JSONB `nodes`/`edges` engine was live, tested, and
   load-bearing four days before the Automation Hub docs were even written — rebuilding
   it into `workflow_conditions`/`workflow_actions` tables now would cost a full rewrite
   for schema-purity with no functional gain. Adding `idempotency_key`/`attempt_count`/
   `next_retry_at`/`dead_letter` as columns on the existing `workflow_executions` table
   (rather than a new DLQ table) is consistent with how this codebase already treats
   "dead letter" and "retry" as states, not separate objects (mirrors how
   `crystal_action_proposals` tracks a funnel via a status column, not a table per
   status). No objection.

2. **Redis Streams over BullMQ.** Correct call, and correctly justified. I wrote the
   original `eventEngine/processor.ts` consumer-group pattern this mirrors — confirmed
   `workflowQueue.ts` reuses the same shape (`ensureGroup`/`processBatch`/`reclaimStale`,
   `XADD`/`XREADGROUP`/`XACK`/`XAUTOCLAIM`, `start`/`stop` lifecycle, MAXLEN trimming)
   faithfully rather than inventing a parallel idiom. There genuinely is no BullMQ
   anywhere in this codebase's `package.json`, and introducing it for one feature would
   split our operational surface (two Grafana playbooks, two failure taxonomies) for a
   capability Streams consumer groups already cover at this workload. No objection.

3. **Idempotency key derivation — found and fixed a real bug.** The key shape
   (`${orgId}:${workflowId}:${triggerType}:${dedupField}`, preferring
   `event.responseId`/`entityId`/`id` over the stream entry id) is the right shape for
   collapsing XAUTOCLAIM redeliveries. But as originally implemented, **the retry sweep
   could never actually retry anything with a natural dedup field** — which is the
   common case, since the derivation explicitly prefers those fields:
   - `sweepDueRetries()` republishes the *same* `trigger_payload` for a due retry.
   - `runWorkflowsForEvent` re-derives the *same* idempotency key for that republished
     event (same orgId/workflowId/triggerType/dedupField — the new stream entry id
     never enters the key when a dedup field is present).
   - The original failed row still holds that exact `idempotency_key` (nothing cleared
     it), and `uq_wf_exec_idempotency_key` is a unique index — so the retried attempt's
     `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING` always collides with the row
     it's supposed to be retrying, returns no row, and `runWorkflow` returns `null`
     (its documented "duplicate, no-op" behavior). The retry would silently vanish
     rather than re-execute, for every trigger type that carries a `responseId`/
     `entityId`/`id` — i.e. the primary path this whole feature exists to make
     reliable.
   - **Fix applied** (`backend/src/lib/workflowEngine.ts::finalizeExecution`): when a
     failure will be retried (`attempt < MAX_ATTEMPTS`), null out that row's
     `idempotency_key` in the same UPDATE that stamps `next_retry_at`, freeing the slot
     so the retried attempt's INSERT can claim it. On the terminal dead-lettered
     attempt, the key is left in place (nothing will retry it, and keeping it preserves
     that row's audit trail, consistent with Priya's "every action reconstructible from
     an immutable log" principle). Regression tests added in
     `workflowEngine.test.js` (`finalizeExecution retry/backoff + dead-letter
     transition` describe block) asserting the key is cleared on a will-retry failure
     and preserved on the dead-lettering one. Full suite green after the fix (see
     TRACKER.md / PR test output).
   - This was a logic bug in the interaction between two otherwise-sound mechanisms
     (idempotency + retry sweep), not a disagreement with the design — fixed directly
     per my review scope rather than kicked back.

4. **Scheduled-workflow tick correction.** Verified independently: `cronTick` in
   `eventEngine/processor.ts::start()` does call `runScheduledWorkflows` on a one-minute
   interval and is cleared on shutdown alongside `alertSweep`. Confirmed this predates
   the current wave (commit `1072bf0`, 2026-06-23) — agree no code change was needed
   here, and I appreciate the ADR flagging this explicitly so nobody "fixes" it a second
   time.

5. **Cross-layer seams (my mandate).** `connectors.ts` correctly tries per-org vaulted
   credentials first, falls back to shared env vars, and degrades to a graceful
   `not_configured` skip when neither is present — consistent with every other optional
   integration in this codebase. `notify.webhook`'s HMAC signing correctly signs the
   exact raw JSON string before it's sent, not a re-serialized copy, and correctly
   prefers `config.secret` (per-workflow) over the org-vaulted `webhook` credential.
   `eventEngine/processor.ts::handleEvent` now publishes onto `workflow:triggers`
   instead of calling `runWorkflowsForEvent` inline — verified this decouples workflow
   latency from notification ACKs as claimed, and that the workflow queue consumer is
   started/stopped in the same lifecycle as the notification consumer (no orphaned
   loop, no double-start).

### Flagged, not fixed here (fast-follow, not blocking Phase 1)

- **`routes/workflowCredentials.ts` was missing `requirePermission` entirely** —
  `requireAuth` alone let any authenticated org member (not just an admin) read which
  connectors are configured, or overwrite/delete an org's live third-party integration
  secrets (Jira/Zendesk/Slack/webhook tokens). Every comparable org-settings/secrets
  route in this codebase (`notificationChannels.ts`, `scimTokens.ts`, `roles.ts`,
  `ownership.ts`, etc.) pairs `requireAuth` with `requirePermission`. This was a
  security bug, not a design choice, so I fixed it directly: added
  `requirePermission('workflows:manage')` (the existing permission action already used
  for workflow-adjacent org settings in `ownership.ts`/`cx-cases.ts`) to all three
  routes, plus a regression test in `workflowCredentialsRoutes.test.js` asserting the
  gate is wired and denies when the permission check fails.
- ~~**Pre-existing gap:** `routes/workflows.ts` had no `requirePermission` gate~~ —
  **FIXED 2026-07-01 (follow-up to this review, coordinator-requested).** Every route
  in `routes/workflows.ts` (`GET /`, `POST /`, `PUT /:id`, `DELETE /:id`,
  `POST /:id/toggle`, `POST /:id/test`, `GET /:id/executions`, `GET /registry`,
  `GET /templates`, `GET /approvals`, `POST /approvals/:executionId`,
  `POST /executions/:execId/retry`) now requires `requirePermission('workflows:manage')`
  in addition to `requireAuth` — including the static/read-only routes (`/registry`,
  `/templates`), matching `routes/alerts.ts`'s precedent of gating its equally-static
  `GET /types` taxonomy catalog with `alerts:manage`. There is no `workflows:read`/
  `workflows:write` split in the permission catalog (unlike `contacts:read`/
  `contacts:write`), so one permission uniformly covers the whole router, exactly as
  `alerts:manage` does for `alerts.ts`. Regression tests added in the new
  `workflowsRoutesPermissions.test.js` (asserts all 12 routes 403 without the
  permission and all 12 succeed with it, plus a dedicated assertion that the static
  routes are not given a lighter-touch exception). The pre-existing
  `workflowsRetry.test.js` needed its `requirePermission` mock added (it previously had
  none, since the route had no gate to mock) to keep passing.
- **DataBus:** confirmed `create`/`toggle`/`delete` in `useWorkflows.ts` call
  `invalidate('workflows')` correctly. Found and fixed one gap in the pre-existing
  `WorkflowTemplates` component in `WorkflowsPage.tsx` — "Use Template" creates a real
  workflow via `api.createWorkflowFromTemplate` but bypassed the hook entirely and only
  refreshed the local page (`onUse={reload}`), never announcing the mutation on the
  DataBus. Added `invalidate('workflows')` there too. The credentials vault has no
  settings UI yet (correctly out of scope for Wave 1), but its mutation endpoints
  (`PUT`/`DELETE /api/workflow-credentials/:connector`) return enough info
  (`{ connector, configured }` / `{ success }`) that a future settings page can call
  `invalidate('workflows')` — or a new `'workflow-credentials'` DataBus resource if we
  want finer granularity — without any backend contract change.
- **Env vars:** `ZENDESK_SUBDOMAIN`, `ZENDESK_EMAIL`, `ZENDESK_API_TOKEN`,
  `WORKFLOW_CREDENTIALS_KEY`, `WORKFLOW_TRIGGER_STREAM`, `WORKFLOW_RETRY_BASE_MS`,
  `WORKFLOW_RETRY_FACTOR`, `WORKFLOW_MAX_ATTEMPTS` were already correctly documented in
  `docs/ENV_VARS.md` and `backend/.env.example`. The root `.env.example` write that
  three prior agents reported as sandbox-denied succeeded without issue in my session —
  I wrote the canonical entries there directly and removed the now-redundant workaround
  block from `backend/.env.example` (see TRACKER.md for the exact diff). The
  restriction the other agents hit appears to be session-specific, not a hard policy.

### Net verdict

Approved. The architecture is sound and well-reasoned against this codebase's existing
patterns — the one real bug (idempotency key colliding with retries) would have made
the retry/backoff feature silently inert in production for the common case, which is
exactly the kind of thing that's invisible until an on-call engineer wonders why DLQ
depth is climbing with `attempt_count` stuck at 1. Fixed and tested. Phase 1 can be
called done once the `workflowCredentials.ts` permission fix (done) and this sign-off
are merged; the `routes/workflows.ts` RBAC gap should be scheduled as a near-term
fast-follow before GA, not blocking Wave 1b/Wave 2 start.
