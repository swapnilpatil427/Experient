# Scheduled / Background Jobs — Single Source of Truth

Every recurring job in the platform, where it lives, what enables it, and what breaks if it
doesn't run. **This is the registry to check before any cloud deploy.** If you add periodic
work, add it here in the same PR.

> ⚠️ **The core risk:** background work is split across two in-process schedulers behind three
> env flags, plus one orphaned DB function. If a flag is unset on a cloud machine, that work
> **silently stops — no error, no log.** If a flag is set on *multiple* replicas, jobs run
> **N times** (duplicate workflows / alerts / insight runs). See "Cloud deployment rules" below.

---

## 1. CrystalOS scheduler — `ENABLE_SCHEDULER=true`

In-process `while True` loop in `crystalos/scheduler.py`, started in the FastAPI lifespan.
Poll cadence `SCHEDULER_POLL_SEC` (dev 300s / prod 3600s); each job has its own min-interval gate.

| Job | Cadence | What it does | If it doesn't run |
|---|---|---|---|
| `_auto_close_by_date` | every poll | Closes surveys past their end date | Surveys stay open forever |
| `_auto_close_by_response_count` | every poll | Closes surveys at response cap | Surveys over-collect |
| `sweep_zombie_runs` | 5 min | Reaps agent runs stale past heartbeat/duration | "running" runs pile up; blocks regen |
| `run_org_aggregation` | 1 h | Org-level metric snapshots | Portfolio/org metrics go stale |
| `_check_sla_breaches` | 15 min | Insight/quality SLA breach checks | Breaches missed |
| `_cx_sla_breach_sweep` | 5 min | CX case SLA breaches (ack/resolve overdue) | Cases breach SLA silently |
| `_aggregate_skill_quality` + `_flag_low_quality_skills` | nightly | Skill quality rollup + flagging | Quality signals stop |
| `_rollup_feedback_hour` | hourly | Feedback hourly rollups | Feedback analytics gaps |
| `_check_quality_sla_compliance` | nightly | Quality SLA compliance | Compliance unmeasured |
| `_cluster_capability_gaps` | weekly | Capability-gap clustering | Gap analysis stale |
| scheduled insight generation (`run_scheduler_once` → surveys due) | free 120 min / paid 15 min (`INSIGHT_INTERVAL_*_MIN`) | Auto-regenerates insights for active surveys | **Insights never auto-update** |

## 2. CrystalOS stream consumer — `ENABLE_STREAM_CONSUMER` (auto-on when `REDIS_URL` set)

| Job | Cadence | What it does | If it doesn't run |
|---|---|---|---|
| `response_stream` consumer | continuous | Progressive-tier insight triggers on new responses (10/40/100/250 thresholds) | New responses never trigger insight refresh |

## 3. Backend Event Engine — `ENABLE_EVENT_ENGINE=true` (needs `REDIS_URL`)

In `backend/src/eventEngine/processor.ts`, started in `index.ts`.

| Job | Cadence | What it does | If it doesn't run |
|---|---|---|---|
| `cronTick` → `runScheduledWorkflows()` | 1 min | Runs due `time.schedule` workflow automations | Scheduled workflows never fire |
| `alertSweep` → `runScheduledEvaluation()` | 15 min | Deterministic alert-rule evaluation | Alerts never fire |
| notification stream processor | continuous | Delivers queued notifications; `reclaimStale` every 6 ticks | Notifications never delivered |

## 4. Scheduler service — dedicated container (`backend/src/scheduler`, profile `scheduler`/`prod`)

The home for cross-cutting / DB jobs and the scheduler observability hub. Own container,
separately scalable, exposes `/health` + `/metrics`. Run with
`npm --prefix backend run start:scheduler` or `docker-compose --profile scheduler up -d scheduler`.

| Job | Cadence | What it does | Status |
|---|---|---|---|
| `expire-stale-broadcasts` → `expire_stale_broadcasts()` | 5 min | Flips `pending_approval` broadcasts past 72h to `expired` | ✅ **Now owned here** (was orphaned — no caller). |
| `credit-reconciliation` | hourly | Credit-ledger integrity invariants (read-only) → `credit_invariant_violations` metric + alert | ✅ implemented, enabled |
| `cost-down-dividend` | daily | Compute trailing COGS/credit → `credit_cogs_per_credit_usd`; allowance apply is dry-run by default | ✅ implemented (measure-only unless `COST_DOWN_DRY_RUN=false`) |
| `credit-ledger-maintenance` | daily | Provision `credit_ledger` partitions 3 months ahead + drop partitions past `CREDIT_LEDGER_RETENTION_MONTHS` (18) | ✅ implemented |
| `credential-health` | 6h | Probe each **configured** integration key (Stripe/OpenRouter/Clerk) for validity/expiry → `credential_valid{integration}`, `credential_last_check_timestamp`, `credential_days_to_expiry` + `CredentialInvalid`/`CredentialExpiringSoon` alerts. Catches keys revoked/rotated/expired *at runtime* (startup validation only checks once at boot). | ✅ implemented |
| `renotify-stale-approvals` | 1h | Re-notifies a `workflow_approvals` row's owner (`workflows.created_by`) once every `WORKFLOW_APPROVAL_RENOTIFY_HOURS` (default 72h) while it sits `status='pending'` — simple expiry + re-notify per explicit product decision, **never** auto-rejects or touches the execution's `'waiting'` status. Reuses `createNotification` (the same primitive `notify.in_app` uses). See `docs/automation-hub/DEEP_AUDIT_PM_FINDINGS.md` §7a. | ✅ implemented |
| `resume-delayed-executions` | 1 min | Auto-resumes `workflow_executions` rows waiting on a `flow.delay` pause (`status='waiting' AND wait_reason='flow.delay' AND resume_at <= now()`) — no human in the loop, unlike `renotify-stale-approvals`. Per-row atomic claim (`UPDATE ... WHERE status='waiting' ... RETURNING *`) in `workflowEngine.ts::resumeDelayedExecution` makes overlapping ticks / multiple replicas safe (only one claimant ever proceeds). Disjoint from `renotify-stale-approvals`/the approvals endpoint by construction — never selects or resumes a `flow.approval`-type wait. See `docs/automation-hub/DEEP_AUDIT_UX_FINDINGS.md` W-1. | ✅ implemented |

The scheduler runs **N replicas with leader election** (Postgres advisory lock): exactly one
executes jobs, standbys fail over automatically. `scheduler_is_leader` + `SchedulerNoLeader` alert.
Disable with `SCHEDULER_LEADER_ELECTION=false` for single-instance.

## 5. Lazy (on-read) — work without cron, but non-deterministic

| Job | Trigger | Risk |
|---|---|---|
| Credit monthly allowance reset (`resetIfElapsed`) | next balance read after the period elapses | Won't fire for an org that never reads its balance (rare — the chip reads it). Optional: a daily sweep makes it deterministic. |
| Broadcast expiry (inline at send) | only when a send is attempted | Stat counts / approval queue can show stale `pending_approval` until `expire_stale_broadcasts` runs (see §4). |

## 6. TTL-managed (Redis) — not cron, but document so they're not "lost"

| Key | TTL | Purpose |
|---|---|---|
| `crystal_threads` / `novu_thread:*` | 7 days | Conversation memory expiry |
| progressive-tier dedup `tier:{survey}:{tier}` | 30 days | Prevent duplicate tier triggers |
| permission cache `perm:*` | 5 min | RBAC cache |
| suppression / frequency-cap windows | rolling | Outreach guards |

## 7. Recommended but NOT yet built

| Job | Cadence | Why | Source |
|---|---|---|---|
| Credit / Stripe reconciliation | nightly | Ledger vs Stripe payments; debits vs CrystalOS `ai_operation_logs` — catch drift | `docs/pricing/IMPLEMENTATION.md`, `credit-system-and-stripe.md` |
| Cost-Down Dividend | monthly/quarterly | Raise allowances as COGS/credit falls | `docs/pricing/PRICING_PROPOSAL.md` |

---

## Cloud deployment rules (the "don't forget" checklist)

**Per environment, set these or the work silently stops:**

```
# Backend machine(s)
ENABLE_EVENT_ENGINE=true        # cronTick + alertSweep + notification processor
REDIS_URL=...                   # required for the Event Engine and stream consumers

# CrystalOS machine(s)
ENABLE_SCHEDULER=true           # all §1 jobs
ENABLE_STREAM_CONSUMER=true     # §2 (auto-on when REDIS_URL set)
REDIS_URL=...
SCHEDULER_POLL_SEC=3600         # prod default
INSIGHT_INTERVAL_FREE_MIN / INSIGHT_INTERVAL_PAID_MIN

# Scheduler service (§4) — its own container/process
#   command: node src/scheduler/index.js  (or npm run start:scheduler)
DATABASE_URL=...                # owns expire_stale_broadcasts + future reconciliation/dividend
SCHEDULER_PORT=8090             # exposes /health + /metrics
```

**Safety net (now in place):** every scheduler stamps `scheduler_heartbeat_timestamp{component}`.
Prometheus alerts `SchedulerHeartbeatStale` / `CrystalSchedulerHeartbeatStale` / `SchedulerDown`
fire if any scheduler goes quiet — so a forgotten flag or dead container **pages you instead of
silently rotting**. This is the answer to "we'll forget something on cloud."

**RUN SCHEDULERS ON EXACTLY ONE INSTANCE.** These loops are *not* leader-elected. If
`ENABLE_SCHEDULER` / `ENABLE_EVENT_ENGINE` are set on multiple replicas, every job runs once
per replica → duplicate workflows, duplicate alerts, duplicate insight runs, duplicate
notifications. The pattern:

- Run a **dedicated worker / scheduler process** (Fly.io **process group** or a separate
  Machine) with the flags ON.
- Web replicas (scaled for traffic) keep the flags **OFF**.

---

## What we should do about the fragmentation

1. **This registry is the single source of truth.** PR rule: any new periodic work is added here
   *and* to the deploy checklist. (Add a line to `CONTRIBUTING`/PR template: "New cron/background
   work → update `scheduled-jobs.md`.")
2. **Heartbeat + alert (strongest safety net).** Have each scheduler emit a `scheduler_heartbeat`
   metric every tick (Prometheus). Add an alert `SchedulerNotRunning` (no heartbeat for >2×
   cadence) so a forgotten flag **pages you instead of silently rotting**. This is the single
   highest-leverage fix for "we'll forget something."
3. **Fix the orphaned `expire_stale_broadcasts()`** — call it from a scheduler tick (or pg_cron).
4. **Prefer pg_cron for pure-DB jobs** (Supabase supports it): `expire_stale_broadcasts`,
   reconciliation. DB-native jobs survive app deploys and have **no duplicate-execution risk**
   (the DB is single-writer), removing them from the env-flag minefield entirely.
5. **Make credit reset deterministic** (optional) via a daily sweep, so it doesn't depend on a read.
6. **Consolidate intent:** longer term, a single job registry in code (one module that declares
   every job + cadence + enabled-flag) so the schedulers are data-driven and this doc can be
   generated from it — impossible to have a job that isn't listed.

### Status of remediations
- [x] **Heartbeat + alert** — `scheduler_heartbeat_timestamp{component}` emitted by the Event
  Engine, the CrystalOS scheduler, and the new scheduler service; alerts `SchedulerHeartbeatStale`,
  `CrystalSchedulerHeartbeatStale`, `SchedulerDown` in `docker/prometheus/rules/slo.yml`.
- [x] **Orphaned `expire_stale_broadcasts()`** — now owned by the scheduler service (`expire-stale-broadcasts` job).
- [x] **Dedicated scheduler service/container** — `backend/src/scheduler` + compose `scheduler` profile.
- [x] **`credit-reconciliation` + `cost-down-dividend`** — implemented (reconciliation enforces
  ledger invariants; cost-down measures COGS/credit, dry-run by default).
- [x] **Leader election** (Postgres advisory lock) — scheduler runs >1 replica safely.
- [x] **Alertmanager** — wired (`:9093`); add a Slack/PagerDuty receiver in `monitoring/alertmanager.yml`.
- [x] **`credit_ledger` partitioning + retention** — monthly range partitions (migration
  `20260625000002`) + `credit-ledger-maintenance` job (provision ahead + retention).
- [ ] Add the env-flag checklist above to the Fly deploy runbook.
- [ ] Consider pg_cron for pure-DB jobs (alternative to the scheduler service for DB-only work).
