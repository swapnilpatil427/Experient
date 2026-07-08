# Xperiq Actions — Failure Mode Runbooks

**Owner:** Kenji Watanabe (QA/Reliability). **Scope:** the three failure modes named in
Kenji's TEAM.md mandate — third-party timeout, Redis outage, Postgres write failure —
for the async workflow execution path (`lib/workflowQueue.ts` + `lib/workflowEngine.ts`
+ `eventEngine/processor.ts`). Written against the real code, not the aspirational
BullMQ/six-table design superseded by `ADR_EXECUTION_ARCHITECTURE.md`.

Each entry: **Symptom → Diagnosis → Immediate mitigation → Root-cause follow-up.**
Read `RELIABILITY_DASHBOARD.md` alongside this — every diagnosis step below references
a dashboard panel where one exists, and a manual query for when it doesn't (metrics in
that doc are a proposed fast-follow, not live yet).

---

## 1. Third-party timeout (connector hangs or errors: Jira/Salesforce/ServiceNow/Zendesk/webhook)

### Symptom
- Workflows using a specific action (e.g. `zendesk.create_ticket`, `notify.webhook`)
  start failing; `workflow_executions.status = 'failed'` rows accumulate with
  `attempt_count` climbing toward `MAX_ATTEMPTS` (5).
- Users report "my Slack/Zendesk automation stopped firing."
- If sustained past 5 attempts (the ADR's backoff schedule: 30s → 60s → 120s → 240s
  between attempts, then dead-letter), affected executions land in
  `workflow_executions WHERE dead_letter = TRUE`.

### Diagnosis
1. **Confirm it's action-scoped, not systemic:** check Dashboard Panel 4 (action error
   rate by type) — if only one `action` label is spiking, it's a specific connector/
   third party, not the queue or engine. Manual equivalent (no metrics yet):
   ```sql
   SELECT wse.node_type, wse.node_id, wse.status, count(*)
     FROM workflow_step_executions wse
     JOIN workflow_executions we ON we.id = wse.execution_id
    WHERE we.created_at > NOW() - INTERVAL '30 minutes' AND wse.status = 'failed'
    GROUP BY 1,2,3 ORDER BY count(*) DESC;
   ```
2. **Confirm it's a timeout, not an auth/config error:** connectors (`connectors.ts`)
   return `{ status: 'failed', output: { status: <http_status> } }` on a non-2xx HTTP
   response, or `{ status: 'failed', error: <message> }` on a thrown/rejected fetch
   (network error, DNS failure, or a hang past whatever timeout wraps `fetch` —
   **note:** as of this review, none of the connectors in `connectors.ts` wrap `fetch`
   in an explicit `AbortController` timeout; a truly hung TCP connection relies on
   Node's default socket/keep-alive behavior, not a connector-level timeout — see
   root-cause follow-up). Check `workflow_step_executions.error_message` for the
   specific execution:
   ```sql
   SELECT error_message, output FROM workflow_step_executions
    WHERE execution_id = '<exec_id>' ORDER BY id DESC;
   ```
3. **Confirm the retry/backoff machinery is actually working, not stuck:** check
   `attempt_count` / `next_retry_at` on the affected row(s):
   ```sql
   SELECT id, workflow_id, attempt_count, next_retry_at, dead_letter, status
     FROM workflow_executions WHERE id = '<exec_id>';
   ```
   If `next_retry_at` is in the past and the row hasn't retried, the sweep itself may
   be stalled — see §2's "sweep/consumer liveness" check, it's the same underlying loop.

### Immediate mitigation
- **If it's one org's misconfigured credentials** (e.g. an expired Zendesk API token):
  this is normally the org's own vaulted credential (`workflow_connector_credentials`
  via `workflowCredentials.ts`) or the shared env var it fell back to — verify which
  via `listConfiguredConnectors(orgId)`, then have the org (or an admin with access)
  rotate the credential through the settings UI/`/api/workflow-credentials` route. No
  code deploy needed.
- **If the third party itself is down** (their status page confirms an outage): let the
  existing backoff/DLQ machinery do its job — this is exactly what it's for. Do not
  manually retry en masse until the third party recovers, since that just re-fails and
  burns attempts faster. Once the third party recovers, dead-lettered executions can be
  manually replayed via the existing `POST /api/workflows/executions/:execId/retry`
  route (works unmodified against `dead_letter = TRUE` rows per ADR §2.3).
- **If it's actively hanging (not erroring)** and no per-connector timeout exists (see
  root-cause below): the blast radius is contained to that one workflow's execution —
  `workflowQueue.ts`'s consumer loop calls `runWorkflowsForEvent` per stream batch
  entry, and a hang in one workflow's action does NOT block the stream/queue for
  *other* trigger events already dispatched to the same batch iteration only insofar as
  each entry in a batch is awaited sequentially inside `processBatch`'s for-loop — a
  genuinely hung `fetch` **will** stall that batch's remaining entries until Node's
  default socket timeout eventually fires. This is worth escalating if observed (see
  root-cause).

### Root-cause follow-up
- **Add explicit per-connector timeouts.** None of `jiraCreateIssue` /
  `salesforceUpdateContact` / `servicenowCreateIncident` / `zendeskCreateTicket` /
  `notify.webhook`'s `fetch` calls in `connectors.ts` / `workflowEngine.ts` pass an
  `AbortSignal.timeout(...)` (or equivalent). Recommend a shared ~10s timeout wrapper
  (a fast-follow — out of scope for this QA pass since it means touching
  `connectors.ts`, which is David's file per the wave's ownership split; flagged here,
  not fixed by me).
- **File a ticket to add `workflow_execution_duration_seconds` and
  `workflow_action_total`** (see `RELIABILITY_DASHBOARD.md` §1) so this diagnosis step
  becomes a dashboard glance instead of an ad hoc SQL query.
- Confirm whether `processBatch`'s sequential per-entry await (§2.3 concern above) is
  an acceptable design given per-connector timeouts are added, or whether batch entries
  should run concurrently (`Promise.allSettled`) — currently sequential, which is a
  latency amplifier under a hung connector even after a timeout is added (a 10s timeout
  × 20 entries in one `COUNT 20` batch = up to 200s for that batch if many hang).

---

## 2. Redis outage (workflow trigger queue unavailable)

### Symptom
- No workflow executions are being created for event-driven triggers at all — not
  failing, not dead-lettering, just **silently absent**. This is the most dangerous
  failure mode in the system because it is silent by design.
- Notifications still work (or degrade separately) — the notification stream
  (`notifications:events`) and the workflow stream (`workflow:triggers`) are two
  independent Redis Streams, but both live on the same Redis instance/URL
  (`REDIS_URL`), so a full Redis outage takes both down together.
- `time.schedule` (cron) workflows are UNAFFECTED — `runScheduledWorkflows` is
  triggered by a plain `setInterval` in `eventEngine/processor.ts`, not through Redis.

### Diagnosis
1. **Confirm Redis is actually down** (vs. just the workflow queue looking quiet
   because there's genuinely no trigger traffic):
   ```bash
   redis-cli -u $REDIS_URL PING
   redis-cli -u $REDIS_URL XLEN workflow:triggers
   redis-cli -u $REDIS_URL XINFO GROUPS workflow:triggers
   ```
   If `PING` fails or times out, Redis is down/unreachable.
2. **Check the silent-degrade code paths that would otherwise hide this:**
   - `publishWorkflowTrigger` (`workflowQueue.ts`): `if (!redis || redis.status !== 'ready') return null;`
     — a down Redis means every event-driven workflow trigger is silently dropped.
     `eventEngine/processor.ts::handleEvent` calls this in a `try/catch` that only logs
     a `warn` (`workflow_trigger_publish_failed`) — **grep the logs for that event name**
     as the fastest confirmation:
     ```bash
     grep workflow_trigger_publish_failed <log output>
     ```
   - `workflowQueue.ts::start()`: `const redis = getRedisBlockingClient(); if (!redis) { log('warn', ...); return; }`
     — if Redis was down at process boot, the entire consumer loop never started (not
     "started and stalled" — never started at all). Check for the boot-time log line
     `Workflow Queue: no REDIS_URL — processor disabled` (note: this specific message
     fires on a *missing* `REDIS_URL`, not a reachable-but-down Redis; a configured but
     unreachable Redis instead blocks at `await new Promise((r) => redis.once('ready', r))`
     indefinitely — the process looks "up" but the consumer loop is parked forever).
3. **Dashboard check (once metrics land, see RELIABILITY_DASHBOARD.md §1):**
   `workflow_trigger_publish_total{result="redis_unavailable"}` rate > 0 is the direct
   signal; until then, this diagnosis is log-grep only, which is the biggest
   observability gap this review found.

### Immediate mitigation
- **Restore Redis connectivity** (standard Redis incident response — failover to
  replica, restart the instance, fix network/security-group issue, whatever the actual
  outage cause is; out of scope for workflow-specific detail here).
- **No data is silently corrupted by the outage itself** — a dropped
  `publishWorkflowTrigger` call means the workflow simply never runs for that trigger
  event; there is no partial/inconsistent state to repair. However, **there is no
  automatic backfill**: once Redis is back, previously-dropped trigger events are gone
  (the notification event that would have published them was already fully processed
  and ACKed on the notification stream, independent of whether the workflow publish
  inside `handleEvent` succeeded).
  - **Backfill option:** if the underlying business events are still reconstructable
    from source data (e.g. `survey.response_filtered` events correspond to rows in
    `responses` within the outage window), a manual replay script calling
    `runWorkflowsForEvent` directly for the affected time window is the only recovery
    path — there is no built-in "replay missed triggers" tool today (candidate Wave 2/3
    backlog item, not built).
- **Once Redis is back up, restart the backend/Event Engine process** if
  `workflowQueue.ts::start()` never got a chance to run `ensureGroup`/enter its loop
  (i.e. it returned early at boot because `REDIS_URL` was unset, or is parked on
  `redis.once('ready', ...)` from a stale connection object) — a fresh process
  guarantees a clean `ensureGroup` + loop start against the now-healthy Redis.

### Root-cause follow-up
- **Add the `WorkflowTriggerPublishDegraded` alert** (RELIABILITY_DASHBOARD.md §4) —
  today this failure is invisible except via log-grepping, which nobody does
  proactively. This is the single highest-priority observability gap found in this
  review.
- **Consider a durable fallback queue** (e.g. write a `workflow_pending_triggers` outbox
  row in Postgres alongside/instead of the Redis publish attempt, drained once Redis
  recovers) if silent trigger loss during a Redis outage is judged unacceptable for the
  product's reliability bar — currently it's "best-effort, drop on failure" by
  explicit design (ADR: "never blocks notification delivery"), which is a reasonable
  choice for decoupling latency but means Redis is a hard dependency for workflow
  delivery guarantees, full stop. Flagging the tradeoff, not overriding the design
  decision (Priya's file, and a real product tradeoff, not a bug).

---

## 3. Postgres write failure (execution/step logging, retry sweep, idempotency INSERT)

### Symptom
- Varies by which write fails:
  - **`runWorkflow`'s initial INSERT into `workflow_executions` fails** (connection
    error, pool exhaustion, deadlock): the whole `runWorkflow` call throws before
    `execId` exists — no execution row, no side effects, workflow silently doesn't run
    for that trigger. Caught one level up in `runWorkflowsForEvent`'s per-workflow
    `try/catch` ("one workflow's failure must not abort the rest") — so other
    workflows for the same event still get a chance to run, but this one is a no-op,
    not retried (no execution row means no `attempt_count`/`next_retry_at` to hang a
    retry off of).
  - **A step-log INSERT (`workflow_step_executions`) fails mid-run:** `logStep` is
    `await`ed but not wrapped in a try/catch in `runNodes`/`runGraph` — a DB failure
    here **throws out of the node loop**, caught by `runWorkflow`'s own try/catch
    (`res = { status: 'failed', conditionsPassed: true }`), so the execution is marked
    `'failed'` even if the action itself actually succeeded seconds earlier. This is a
    real gap: **a Postgres blip during step-logging can mis-record a successful action
    as a failed execution**, feeding the normal retry/backoff path and potentially
    re-running an action that already had a side effect (e.g. a second Zendesk ticket).
  - **`finalizeExecution`'s UPDATE fails:** the execution row is stuck at
    `status = 'executing'` forever (never reaches a terminal state) — invisible to the
    retry sweep, which only looks at `status = 'failed'`.
  - **`sweepDueRetries`'s queries fail:** caught per-row in the republish loop
    (`log('warn', ..., 'workflow retry republish failed')` — logged and skipped, that
    row stays due and gets retried on the next sweep tick), but the two top-level
    `query(...)` calls for `dead` and `due` are NOT wrapped — a Postgres outage during
    the sweep throws out of `sweepDueRetries` entirely, caught by the `setInterval`
    callback's own `.catch` in `workflowQueue.ts::start()` (`workflow retry sweep
    failed`) — the sweep just skips that minute's tick, no crash.

### Diagnosis
1. **Check Postgres health directly** — connection count, replication lag, disk, the
   usual DB on-call checklist (out of scope for workflow-specific detail).
2. **Check for the specific log signatures** above:
   ```bash
   grep -E "workflow retry sweep failed|workflow retry republish failed|workflow trigger handling failed" <log output>
   ```
3. **Look for "stuck executing" rows** (finalizeExecution UPDATE failure symptom):
   ```sql
   SELECT id, workflow_id, org_id, created_at
     FROM workflow_executions
    WHERE status = 'executing' AND created_at < NOW() - INTERVAL '5 minutes';
   ```
   Any row here has been "running" far longer than any real workflow should take —
   this table has no timeout/reaper today (candidate backlog item, not built).
4. **Look for step-log gaps** (mid-run failure symptom) — an execution marked `failed`
   whose step log doesn't actually show a `'failed'` step is the tell:
   ```sql
   SELECT we.id, we.status, count(wse.id) AS step_count,
          count(*) FILTER (WHERE wse.status = 'failed') AS failed_steps
     FROM workflow_executions we
     LEFT JOIN workflow_step_executions wse ON wse.execution_id = we.id
    WHERE we.status = 'failed' AND we.created_at > NOW() - INTERVAL '1 hour'
    GROUP BY we.id, we.status
   HAVING count(*) FILTER (WHERE wse.status = 'failed') = 0;
   ```
   A nonzero result set here means "marked failed with no failed step" — i.e. some
   other exception (very plausibly a DB write blip) killed the run mid-flight.

### Immediate mitigation
- **Restore Postgres write availability** (standard DB incident response).
- **Manually terminate/investigate stuck `'executing'` rows** found in diagnosis step 3
  — there's no automated timeout, so an operator must decide whether to mark them
  `'failed'` (so they enter the normal retry/DLQ path) via a direct
  `UPDATE workflow_executions SET status = 'failed', attempt_count = ..., ...` or leave
  them (if the action is known idempotent-unsafe to retry).
- **For the mid-run mis-record case:** cross-reference the actual third-party system
  (e.g. "did the Zendesk ticket actually get created?") before manually retrying a
  `'failed'` execution whose step log looks incomplete — a naive retry risks a genuine
  duplicate side effect for exactly the reason the idempotency key exists, except this
  path bypasses it (`POST /executions/:id/retry` intentionally always creates a fresh
  execution, per ADR §2.4 — "an explicit human retry should never be silently deduped
  against a prior automatic attempt").

### Root-cause follow-up
- **Wrap `logStep` calls in `runNodes`/`runGraph` in a try/catch that logs-and-continues
  rather than propagating**, so a step-logging DB blip doesn't retroactively convert a
  successful action into a `'failed'` execution. This is a real, if narrow, bug-shaped
  gap — flagging it rather than fixing it myself, since `workflowEngine.ts` is Priya's
  file per this wave's ownership split (see top-level task scope: "DO NOT modify
  workflowQueue.ts/workflowEngine.ts/connectors.ts/workflowCredentials.ts").
- **Add a reaper for stuck `'executing'` rows** (e.g. the retry sweep additionally
  treats `status = 'executing' AND created_at < NOW() - INTERVAL 'N minutes'` as
  failed) — today nothing ever transitions them out of `'executing'` if
  `finalizeExecution` itself fails to write.
- **Wrap `sweepDueRetries`'s two top-level `query(...)` calls in try/catch** for
  symmetry with the per-row republish try/catch already present, so a transient DB
  blip during the `dead`/`due` SELECT/UPDATE doesn't skip an entire sweep tick's worth
  of both dead-lettering and republishing (currently it does — see diagnosis, "sweep
  just skips that minute's tick").

---

## Cross-cutting notes

- All three failure modes ultimately funnel through the same two escape hatches: (a)
  the per-workflow `try/catch` in `runWorkflowsForEvent` ("one workflow's failure must
  not abort the rest") and (b) the per-batch-entry `finally { xack }` in
  `processBatch`/`reclaimStale` ("ack to avoid poison-message loops"). Both are
  deliberate at-least-once, never-crash-the-loop design choices — the tradeoff is that
  individual failures are easy to miss without dashboards/alerts, since nothing
  escalates past a `log('warn'/'error', ...)` call. This is the throughline behind
  every "root-cause follow-up" item above: **the system fails safe (doesn't crash,
  doesn't duplicate-execute) but does not fail loud.** RELIABILITY_DASHBOARD.md exists
  specifically to close that gap.
