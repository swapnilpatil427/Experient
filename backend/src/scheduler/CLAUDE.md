# Scheduler Service

The deployable home for **cross-cutting / DB periodic jobs** and the **scheduler
observability hub**. Runs as its own container (separately scalable), reusing the backend's
library code and dependencies — no separate `node_modules`. Same pattern as `eventEngine/`.

## What it owns (and doesn't)
- **Owns:** jobs that belong to neither the API request path nor CrystalOS — e.g.
  `expire_stale_broadcasts` (previously orphaned), and the planned `credit-reconciliation`
  and `cost-down-dividend` jobs.
- **Does NOT own / duplicate:** the API **Event Engine** jobs (scheduled workflows, alert
  sweeps, notification delivery) or the **CrystalOS scheduler** jobs (insight regen, SLA
  sweeps, survey auto-close). Those stay in their services; this one only adds a heartbeat to
  them via shared metrics.
  - **One deliberate, narrow exception:** `renotify-stale-approvals` (2026-07-01) calls
    `lib/notifications.ts::createNotification` — it's a workflow-approval nudge, not a new
    delivery pipeline. It was placed here (rather than as a third `eventEngine/processor.ts`
    `setInterval`, which is where `cronTick`/`alertSweep` — the actual per-minute workflow/alert
    sweeps — live) because it directly mirrors `expire-stale-broadcasts`'s exact shape (a
    low-frequency, DB-row-staleness sweep over a single table) and the audit's explicit ask was
    to mirror that job. If this job's scope grows (e.g. more approval-adjacent notification
    types), reconsider moving it to `eventEngine/processor.ts` alongside `alertSweep`.

## Files
| File | Role |
|---|---|
| `registry.ts` | Declarative job list — the single in-code source of truth. `{ name, intervalSec, enabled, handler }`, all env-overridable. |
| `runner.ts` | Tick loop: stamps heartbeat every tick; runs due jobs with per-job locks + metrics; isolates failures. Pure `dueJobs()` + `runJob()` are unit-tested. |
| `jobs/*.ts` | One file per job (all live): `expireStaleBroadcasts`, `reconciliation` (ledger-integrity invariants), `costDownDividend` (COGS/credit metric; dry-run apply), `creditLedgerMaintenance` (partition provisioning + retention), `credentialHealth` (integration key validity/expiry probes), `reNotifyStaleApprovals` (workflow-approval TTL nudge — never auto-rejects). |
| `leader.ts` | Postgres advisory-lock leader election — run N replicas; one leads, standbys fail over. |
| `index.ts` | Entrypoint: HTTP server (`/health`, `/health/live`, `/health/ready`, `/metrics`) + starts the runner. |

## Run it
```bash
npm --prefix backend run start:scheduler          # local (tsx), :8090
docker-compose --profile scheduler up -d scheduler # container (also in the "prod" profile)
```

## Metrics (Prometheus, on `:8090/metrics`)
- `scheduler_heartbeat_timestamp{component="scheduler"}` — stamped every tick (drives `SchedulerHeartbeatStale`)
- `scheduler_job_runs_total{job,result}`, `scheduler_job_duration_seconds{job}`, `scheduler_job_last_success_timestamp{job}`

## Adding a job
1. Add `jobs/<name>.ts` exporting `async () => JobResult | void`.
2. Register it in `registry.ts` (name, description, `intervalSec`, `enabled` flag).
3. Add it to `docs/infrastructure/scheduled-jobs.md`.
4. Add a unit test (mirror `__tests__/scheduler.test.js`).

## Config (env)
`SCHEDULER_PORT` (8090), `SCHEDULER_TICK_SEC` (30), per-job `JOB_<NAME>` (enable) +
`JOB_<NAME>_SEC` (interval). Reuses `DATABASE_URL`.

## Scaling note
Job *scheduling* must run on **exactly one instance** (these loops aren't leader-elected) —
run a single scheduler container. To scale *throughput*, parallelize within a job or add
leader election (e.g. a Postgres advisory lock) before running N replicas.
