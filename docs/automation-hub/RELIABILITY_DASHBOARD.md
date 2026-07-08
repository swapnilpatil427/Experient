# Xperiq Actions — Reliability Dashboard Spec

**Status:** Spec only — no live Grafana instance in this sandbox to wire up. This is a
concrete, implementable spec: panel list, exact queries, and alert thresholds, written
against the real `lib/workflowQueue.ts` / `lib/workflowEngine.ts` behavior and the
existing `prom-client` conventions in `backend/src/lib/metrics.ts`.

**Owner:** Kenji Watanabe (QA/Reliability). **Source of truth for behavior:**
`docs/automation-hub/ADR_EXECUTION_ARCHITECTURE.md`.

---

## 1. Gap: no workflow metrics exist yet

`backend/src/lib/metrics.ts` today has HTTP, AI, DB, business-event, credit, scheduler,
and credential-health metrics — but **nothing workflow-specific**. `scheduler_heartbeat_timestamp`
already has a `component` label that could carry `workflow_queue`, and
`scheduler_job_runs_total` / `scheduler_job_duration_seconds` could technically carry
a `job="workflow_retry_sweep"` label, but there is no counter/histogram/gauge for:
queue depth, per-execution latency, DLQ depth, or per-action-type error rate.

**This section proposes the new metrics** (naming follows the existing
`snake_case_total` / `_seconds` / gauge-no-suffix conventions already used in
`metrics.ts`). None of these are implemented yet — implementing them is a fast-follow,
not part of this doc-only deliverable. Emission points are called out per metric so
whoever wires this up (likely inside `workflowQueue.ts` / `workflowEngine.ts`, or a thin
wrapper so Priya/David's files stay untouched per code-ownership) knows exactly where.

| New metric | Type | Labels | Emitted from | Purpose |
|---|---|---|---|---|
| `workflow_queue_depth` | Gauge | `stream` | periodic poll of `XLEN workflow:triggers` (add to the same interval tick as `sweepDueRetries`) | Panel 1 |
| `workflow_queue_pending_count` | Gauge | `consumer_group` | periodic `XPENDING workflow:triggers workflow-processor` (summary form) | Panel 1b — in-flight/unacked backlog, distinct from unread backlog |
| `workflow_execution_duration_seconds` | Histogram | `trigger_type`, `status` | wrap the `runWorkflow` call site in `workflowQueue.ts::handleTrigger` (start timer before `runWorkflowsForEvent`, observe on return) — mirrors the `dbDuration`/`aiDuration` pattern already in `metrics.ts` | Panel 2 |
| `workflow_dead_letter_total` | Counter | `trigger_type` | increment inside `sweepDueRetries`'s dead-letter branch, and inside `finalizeExecution`'s `attempt >= MAX_ATTEMPTS` branch (both dead-letter paths per ADR §2.3) | Panel 3 (rate) |
| `workflow_dead_letter_depth` | Gauge | (none, or `org_id` if cardinality allows) | periodic `SELECT count(*) FROM workflow_executions WHERE dead_letter = TRUE` on the same tick as the retry sweep | Panel 3 (absolute depth — this is the one the alert fires on) |
| `workflow_action_total` | Counter | `action`, `status` (`completed\|failed\|skipped\|waiting`) | increment inside `executeAction`'s return path (one line per branch, or a single wrapper around the `switch`) | Panel 4 |
| `workflow_retry_sweep_total` | Counter | `result` (`republished\|dead_lettered\|noop`) | increment inside `sweepDueRetries` per outcome | Panel 5 |
| `workflow_trigger_publish_total` | Counter | `result` (`published\|redis_unavailable\|error`) | increment inside `publishWorkflowTrigger` | Panel 6 |

**Reuse, don't duplicate:** `scheduler_heartbeat_timestamp{component="workflow_queue"}`
should be stamped from `workflowQueue.ts::start()`'s loop (same `touchHeartbeat` call
`eventEngine/processor.ts` already makes for `component="event_engine"`) — this is a
one-line addition to an existing metric, not a new one, and it's what lets
`SchedulerHeartbeatStale` catch a wedged workflow consumer for free.

---

## 2. Panel list

### Panel 1 — Queue depth (unread backlog)
- **Type:** Time series (line), single stream.
- **Query (Prometheus/PromQL):**
  ```promql
  workflow_queue_depth{stream="workflow:triggers"}
  ```
- **Redis ground truth** (what the metric samples, for manual verification during an
  incident): `XLEN workflow:triggers`.
- **What it tells you:** publish rate is outpacing consume rate — either the consumer
  is down/slow, or a burst of trigger events (e.g. a large CSV import firing thousands
  of `survey.response_filtered` events) has arrived faster than one `wq-<pid>` consumer
  can drain at `COUNT 20` per `XREADGROUP` call.

### Panel 1b — Pending (claimed-but-unacked) entries
- **Type:** Time series (line).
- **Query:** `workflow_queue_pending_count{consumer_group="workflow-processor"}`
- **Redis ground truth:** `XPENDING workflow:triggers workflow-processor` (summary form
  — total pending count).
- **What it tells you:** entries a consumer has read but not yet ACKed — sustained
  growth here (rather than queue depth) points at a crashed/hung consumer, since
  `reclaimStale` only runs every 6th tick (~ once per 6 poll cycles) and only reclaims
  entries idle > 30s.

### Panel 2 — Execution latency (p50/p95/p99)
- **Type:** Time series, three lines.
- **Queries:**
  ```promql
  histogram_quantile(0.50, sum(rate(workflow_execution_duration_seconds_bucket[5m])) by (le))
  histogram_quantile(0.95, sum(rate(workflow_execution_duration_seconds_bucket[5m])) by (le))
  histogram_quantile(0.99, sum(rate(workflow_execution_duration_seconds_bucket[5m])) by (le))
  ```
- **Split-by-trigger-type variant** (for triage): add `by (le, trigger_type)` and a
  Grafana template variable on `trigger_type`.
- **What it tells you:** this is the direct instrument for Kenji's mandate line "Own
  the workflow execution SLO: 99.5% of workflow runs complete within 30 seconds of
  trigger event" — p99 crossing 30s is the SLO breach signal; p95 > 10s is the
  earlier-warning alert threshold (§4).
- **Caveat (be honest about what this measures):** this histogram, as scoped above,
  times `runWorkflowsForEvent` inside the consumer — i.e. **evaluation + execution
  latency from the moment the consumer picks the message up**, not from the original
  triggering event. The ADR notes an additional "sub-second, up to 5s under load" gap
  between publish and consume (the `XREADGROUP` `BLOCK 5000` window) that this panel
  does not capture. If the true trigger-to-completion SLO needs to include that gap,
  the histogram's start-timer must move to `publishWorkflowTrigger`'s call site instead
  (stamp `ts` — already present in the `XADD` payload — and diff against `Date.now()`
  in `handleTrigger`), which is a slightly bigger change than the wrapper described in
  §1. Flagging this now so nobody grafana's a false sense of SLO coverage.

### Panel 3 — Dead-letter queue
- **Type:** Two panels side by side: (a) a Stat panel for current depth, (b) a time
  series for the rate of new dead-letters.
- **Queries:**
  ```promql
  # (a) current depth — the alert-worthy number
  workflow_dead_letter_depth

  # (b) rate of new dead-letters, for trend/rate-of-change context
  sum(rate(workflow_dead_letter_total[15m])) by (trigger_type)
  ```
- **SQL ground truth** (what depth polls, and what an on-call engineer runs by hand
  during an incident — see ADR §2.3, "Dead letters are queryable directly"):
  ```sql
  SELECT trigger_type, count(*), min(completed_at) AS oldest
    FROM workflow_executions
   WHERE dead_letter = TRUE
   GROUP BY trigger_type
   ORDER BY count(*) DESC;
  ```
- **What it tells you:** a systemic downstream failure (e.g. Zendesk API down, a
  misconfigured webhook secret) exhausts every attempt for every workflow using that
  action — depth panel catches "still broken," rate panel catches "started breaking
  15 minutes ago."

### Panel 4 — Action error rate by type
- **Type:** Time series, one line per `action` label (stacked or overlaid), plus a
  Table panel for the current snapshot sorted by error rate descending.
- **Query (per-action error rate, the number the alert fires on):**
  ```promql
  sum(rate(workflow_action_total{status="failed"}[15m])) by (action)
    /
  sum(rate(workflow_action_total[15m])) by (action)
  ```
- **Table panel query** (current window, human-readable %):
  ```promql
  100 * (
    sum(increase(workflow_action_total{status="failed"}[1h])) by (action)
      /
    sum(increase(workflow_action_total[1h])) by (action)
  )
  ```
- **What it tells you:** distinguishes "Zendesk is down" (only `zendesk.create_ticket`
  spikes) from "the queue/engine itself is broken" (every action type spikes
  simultaneously) — the single most useful triage signal for on-call.

### Panel 5 — Retry sweep health
- **Type:** Time series, stacked bars (republished vs dead-lettered vs no-op-tick).
- **Query:**
  ```promql
  sum(rate(workflow_retry_sweep_total[15m])) by (result)
  ```
- **Paired with:** `scheduler_heartbeat_timestamp{component="workflow_queue"}` (existing
  metric, reused per §1) plotted as `time() - scheduler_heartbeat_timestamp{component="workflow_queue"}`
  — if this exceeds ~90s (1.5x the sweep interval), the sweep loop itself has died,
  which is a **silent failure mode**: no dead-letters get created, no retries get
  republished, and failed executions just sit at `status='failed', dead_letter=false`
  forever with a stale `next_retry_at`. This is worth its own alert (§4).

### Panel 6 — Publish reliability (best-effort path visibility)
- **Type:** Time series.
- **Query:**
  ```promql
  sum(rate(workflow_trigger_publish_total[15m])) by (result)
  ```
- **What it tells you:** `publishWorkflowTrigger` is deliberately best-effort — it
  returns `null` silently when Redis is down (see `eventEngine/processor.ts::handleEvent`,
  which only logs a warning). Without this panel, a Redis outage that drops workflow
  triggers on the floor produces **no operator-visible signal at all** except an
  eventual "why didn't my workflow fire" support ticket. This is the single biggest
  observability gap found during this review — see RUNBOOKS.md §2 (Redis outage).

---

## 3. Dashboard layout (suggested)

```
Row 1: [Queue depth]        [Pending entries]      [Sweep health + heartbeat age]
Row 2: [Latency p50/p95/p99 ------------------------------------------------- ]
Row 3: [DLQ depth (stat)]   [DLQ rate]              [Publish reliability]
Row 4: [Action error rate by type ------------------] [Action error table]
```

Template variables: `org_id` (optional, for a per-tenant drill-down view — only if
label cardinality is acceptable at your Prometheus retention/cardinality budget;
default view should stay unlabeled/aggregate), `trigger_type`, `action`.

---

## 4. Alerting thresholds (from TEAM.md, Kenji's mandate)

| Alert | Condition (PromQL) | For | Severity | Notes |
|---|---|---|---|---|
| `WorkflowDlqDepthHigh` | `workflow_dead_letter_depth > 10` | `15m` | Warning → Page if sustained `1h` | Matches TEAM.md mandate literally: "DLQ depth > 10" |
| `WorkflowExecutionLatencyHigh` | `histogram_quantile(0.95, sum(rate(workflow_execution_duration_seconds_bucket[5m])) by (le)) > 10` | `10m` | Warning | TEAM.md: "execution latency p95 > 10s"; see Panel 2 caveat on what this does/doesn't measure |
| `WorkflowActionErrorRateHigh` | `sum(rate(workflow_action_total{status="failed"}[15m])) by (action) / sum(rate(workflow_action_total[15m])) by (action) > 0.05` | `15m` | Warning, Critical if `> 0.25` | TEAM.md: "action error rate > 5%"; per-`action` label so a single bad connector doesn't get diluted by healthy ones in an aggregate |
| `WorkflowSloBreach` | `histogram_quantile(0.99, sum(rate(workflow_execution_duration_seconds_bucket[5m])) by (le)) > 30` | `5m` | Critical | Direct instrument of the mandate's SLO line: "99.5% of workflow runs complete within 30 seconds" — p99 > 30s for 5 continuous minutes is the practical proxy for the 99.5% SLO burning down |
| `WorkflowQueueConsumerStalled` (not in TEAM.md, found during this review) | `time() - scheduler_heartbeat_timestamp{component="workflow_queue"} > 90` | `2m` | Critical | Silent-failure catch: sweep/consumer loop died — see Panel 5 |
| `WorkflowTriggerPublishDegraded` (not in TEAM.md, found during this review) | `sum(rate(workflow_trigger_publish_total{result="redis_unavailable"}[5m])) > 0` | `2m` | Critical | Redis outage on the publish side is otherwise silent (best-effort by design) — see RUNBOOKS.md §2 |

The two extra alerts beyond TEAM.md's three explicit thresholds are proposed additions
based on reading the actual failure modes in `workflowQueue.ts`/`processor.ts` — both
close the same gap: **the current design has failure paths that degrade silently by
design** (best-effort publish, a sweep loop with no liveness signal), and TEAM.md's
three alerts don't cover either.

---

## 5. Verification note

There is no live Grafana/Prometheus instance in this sandbox, so none of the panels or
alert rules above have been applied to a running dashboard — this is the spec to hand
to whoever provisions Grafana (Nina Reeves per TEAM.md's platform-expert mandate, or
ops). The PromQL above assumes the new metrics in §1 are implemented first; until then,
Panels 3's SQL fallback and manual `XLEN`/`XPENDING` checks in Panels 1/1b are the
today-available equivalents for a human running them by hand during an incident (see
RUNBOOKS.md, which uses exactly these manual queries).
