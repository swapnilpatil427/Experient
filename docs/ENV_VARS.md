# Environment Variables — canonical reference

The single source of truth for every env var Xperiq reads. **Rule:** when you add a
`process.env.X` / `import.meta.env.VITE_X` / `os.getenv("X")`, add it here **and** to the matching
`.env.example` in the same PR. (See the "Keeping this in sync" rule in the root `CLAUDE.md`.)

Files: `./.env.example` (root — backend + CrystalOS + docker-compose all read the **root** `.env`),
`app/.env.example` (Vite frontend), `backend/.env.example` (backend-local overrides). CrystalOS
reads the root `.env` (and optional `crystalos/.env`).

Legend: **[req]** required to run · **[opt]** optional (feature/integration) · **[def]** has a safe default.

---

## Core (backend + CrystalOS) — root `.env`
| Var | Status | Default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | [req] | `postgresql://postgres:postgres@localhost:5432/xperiq` | Postgres connection |
| `DB_CONNECTION_TIMEOUT_MS` | [opt] | `10000` | Max wait (ms) when opening a new Postgres pool connection |
| `REDIS_URL` | [req prod / opt dev] | `redis://localhost:6379` | Rate limits, caches, streams, credit balance cache |
| `OPENROUTER_API_KEY` | [req] | — | LLM gateway |
| `AGENTS_INTERNAL_KEY` | [req] | `dev-internal-key-change-in-prod` | Shared secret: backend ↔ CrystalOS ↔ internal metering API. **Change in prod.** |
| `AGENTS_URL` | [def] | `http://localhost:8001` | Where the backend reaches CrystalOS |
| `BACKEND_INTERNAL_URL` | [def] | `http://localhost:3001` | Where CrystalOS reaches the Node backend (reverse direction of `AGENTS_URL`) — used by `lib/workflow_signal_client.py` to POST `workflow_signal` events to `/api/internal/workflows/signal` after an automated insight run detects an AI trigger. Auth reuses `AGENTS_INTERNAL_KEY` (same shared secret, both directions). |
| `AGENTS_ENV` | [def] | `dev` | `dev` \| `dev-paid` \| `production` |
| `NODE_ENV` | [def] | — | `production` gates startup validation + `/api/metrics` IP allow |
| `PORT` | [def] | `3001` | Backend port |
| `LOG_LEVEL` / `LOG_PRETTY` | [opt] | — | Log verbosity / pretty output |
| `ALLOWED_ORIGIN` / `FRONTEND_URL` | [opt] | — | CORS origin. `FRONTEND_URL` is also the base for Prism OAuth callback → FE redirects (`/app/prism/connect/:platform`); falls back to `ALLOWED_ORIGIN` then `http://localhost:5173`. |
| `PUBLIC_API_URL` | [def] | `http://localhost:3001` | Publicly-reachable backend base URL — used to build the Prism OAuth `redirect_uri` (`${PUBLIC_API_URL}/api/prism/oauth/:platform/callback`). Must be the externally-resolvable origin in prod. |

## Auth (Clerk) — optional; absent ⇒ dev mode (dev-user/dev-org)
| Var | Status | File | Purpose |
|---|---|---|---|
| `CLERK_SECRET_KEY` | [opt] | root | Backend JWT verification; absent ⇒ DEV_MODE |
| `CLERK_WEBHOOK_SECRET` | [opt] | root | Clerk webhook signature |
| `VITE_CLERK_PUBLISHABLE_KEY` | [opt] | app | Frontend Clerk; absent ⇒ demo mode |

> `SKIP_AUTH` is **deprecated** — the dev bypass now keys on the absence of `CLERK_SECRET_KEY` (DEV_MODE). Do not add it.

## Billing / Stripe — optional (manual grants work without it). Backend only.
| Var | Status | Value | Purpose |
|---|---|---|---|
| `STRIPE_SECRET_KEY` | [opt] | `sk_test_…` / `sk_live_…` | Stripe API (hosted Checkout). Also `cd backend && npm i stripe`. |
| `STRIPE_WEBHOOK_SECRET` | [opt] | `whsec_…` | Webhook signature (`/webhooks/stripe`) |
| `APP_URL` | [def] | request origin → `http://localhost:5173` | Checkout success/cancel redirects |

(No publishable key — Checkout is hosted. See `docs/test-plan/credit-system-and-stripe.md`.)

## Credit system — all optional, defaults in `backend/src/lib/creditPlans.ts`
| Var | Default | Purpose |
|---|---|---|
| `CREDIT_DEFAULT_PLAN` | `free` | Plan for new orgs w/o a profile (set `enterprise` in dev to skip the free cap) |
| `CREDIT_ALLOWANCE_{FREE,STARTER,GROWTH,ENTERPRISE,PLATFORM}` | 0/1500/12000/80000/500000 | Monthly credit allowance per plan |
| `CREDIT_COST_{INSIGHT_RUN,CRYSTAL_TURN,XO_FUSION,BROADCAST_EMAIL,BROADCAST_SMS}` | 50/15/200/2/8 | Per-action credit cost |
| `CREDIT_COST_{REFRESH,MANUAL_QUICK,MANUAL_EXPERT,CUSTOM_BASE}` | 8/15/40/25 | Insight Pipeline v2 per-run costs (platform fallback; survey/org settings may override). `CUSTOM_BASE` is the Custom Analysis base; cost scales by corpus tier via `resolveCustomCost()` — ≤500 resp = base, ≤2000 = base×2, >2000 = base×3 (25/50/75 at the default base) |
| `CREDIT_COST_{AUTOMATED_CHECKPOINT,AUTOMATED_REPORT}` | 5/15 | Insight Pipeline v2 automated run costs — checkpoint-only vs +tiered report (CrystalOS `credit_preflight`; survey/org settings may override) |
| `REFRESH_DAILY_LIMIT` | 5 | Max "Refresh" button presses per survey per day (backend; evaluated at startup) |
| `MANUAL_DAILY_RUN_LIMIT` | 10 | Max Expert + Quick manual insight runs per survey per day (backend; evaluated at startup) |
| `TAG_REPORT_MANUAL_DAILY_LIMIT` | 10 | Max Tag Report Manual + Custom Range trigger requests per (org, tag) per day (`routes/survey-groups.ts`'s `tag-report/manual`/`tag-report/custom-range`) |
| `CREDIT_COST_{ORG_SUMMARY_BASE,ORG_SUMMARY_MAX}` | 75/1500 | Org Intelligence Dashboard Custom Summary cost curve (`lib/orgSummaryCost.ts`'s `resolveOrgSummaryCost()`) — a separate, org-wide-scaled curve from `CUSTOM_BASE`'s survey-level tiers (Decision 12, `docs/org-dashboard/DECISIONS.md`); `BASE` defaults to 3× `CUSTOM_BASE`, tiered ≤2000/≤10000/>10000 org-wide responses = base/base+step/base+2×step, capped at `MAX` |
| `ORG_SUMMARY_DAILY_LIMIT` | 3 | Max Org Intelligence Dashboard Custom Summary requests per org per day (`routes/org-dashboard.ts`'s `POST /dashboard/summaries`; scoped by `org_id` only, not per-survey) |
| `CREDIT_PRICE_{STARTER,GROWTH,ENTERPRISE,PLATFORM}` | 49/299/1499/0 | Plan list price (USD) |
| `CREDIT_FREE_LIFETIME_GRANT` | 225 | One-time free-tier grant |
| `CREDIT_PERIOD_DAYS` | 30 | Allowance period length |
| `CREDIT_BALANCE_CACHE_TTL` | 10 | Redis balance-cache TTL (0 = disable) |
| `CREDIT_LEDGER_RETENTION_MONTHS` | 18 | Partition retention |
| `COST_DOWN_DRY_RUN` | true | Cost-Down Dividend apply is dry-run unless `false` |

## Scheduler / workers — optional, defaults
| Var | Default | Purpose |
|---|---|---|
| `ENABLE_EVENT_ENGINE` | `false` (true in dev script) | Backend event/cron/notification processor |
| `WORKFLOW_TRIGGER_STREAM` | `workflow:triggers` | Redis Streams key for the async workflow-trigger queue (`lib/workflowQueue.ts`); started alongside the notification processor under `ENABLE_EVENT_ENGINE` |
| `WORKFLOW_RETRY_BASE_MS` | `30000` | Base backoff delay before the first workflow-execution retry |
| `WORKFLOW_RETRY_FACTOR` | `2` | Exponential backoff multiplier per retry attempt |
| `WORKFLOW_MAX_ATTEMPTS` | `5` | Attempts (incl. first) before a failed workflow execution is dead-lettered (`workflow_executions.dead_letter`) |
| `WORKFLOW_CONNECTOR_TIMEOUT_MS` | `10000` | `AbortSignal.timeout()` applied to every outbound connector fetch (Jira/Salesforce/ServiceNow/Zendesk in `lib/connectors.ts` + `notify.webhook` in `lib/workflowEngine.ts`) so a hung TCP connection fails bounded instead of stalling the retry/backoff path |
| `WORKFLOW_EXECUTING_TIMEOUT_MIN` | `5` | Minutes a `workflow_executions` row may sit in `status = 'executing'` before the stuck-row reaper (`lib/workflowQueue.ts::sweepDueRetries`) force-fails it into the normal retry/DLQ path |
| `TAG_REPORT_JITTER_WINDOW_MS` | `300000` (5 min) | Deterministic per-(org,tag) jitter window applied at trigger time by the Tag Report Automated-mode due-tags sweep (`lib/tagReportScheduler.ts`) before enqueueing onto the shared workflow-trigger queue — avoids a thundering herd when many tags become due in the same sweep tick |
| `ENABLE_SCHEDULER` | `false` | CrystalOS in-process scheduler |
| `ENABLE_STREAM_CONSUMER` | on when `REDIS_URL` set | CrystalOS progressive-tier consumer |
| `SCHEDULER_PORT` | 8090 | Scheduler service HTTP (`/health`,`/metrics`) |
| `SCHEDULER_TICK_SEC` | 30 | Scheduler tick |
| `SCHEDULER_LEADER_ELECTION` | true | HA leader election (false = single instance) |
| `SCHEDULER_LOCK_KEY` | 728190421 | Advisory-lock key |
| `SCHEDULER_POLL_SEC` | 300 dev / 3600 prod | CrystalOS scheduler poll |
| `INSIGHT_INTERVAL_FREE_MIN` / `INSIGHT_INTERVAL_PAID_MIN` | 120 / 15 | Auto insight cadence |
| `JOB_{EXPIRE_BROADCASTS,RECONCILIATION,COST_DOWN_DIVIDEND,CREDIT_LEDGER_MAINTENANCE,CREDENTIAL_HEALTH,RENOTIFY_STALE_APPROVALS,RESUME_DELAYED_EXECUTIONS}` (+ `_SEC`) | enabled / per-job | Scheduler job toggles + intervals (`JOB_CREDENTIAL_HEALTH_SEC` default 21600 = 6h; `JOB_RENOTIFY_STALE_APPROVALS_SEC` default 3600 = 1h tick; `JOB_RESUME_DELAYED_EXECUTIONS_SEC` default 60 = 1min tick) |
| `JOB_{ORG_METRICS_DAILY,SURVEY_HEALTH_SUMMARY,ORG_METRICS_WEEKLY,ORG_TOPIC_TRENDS,ORG_HEALTH_SCORE}` (+ `_SEC`) | enabled / per-job | Org Dashboard (Command Center) scheduler job toggles + intervals — replace pg_cron (not installed in this stack; custom `pgvector/pgvector:pg16` image). Defaults: `JOB_ORG_METRICS_DAILY_SEC` 900 (15 min, also refreshes `tag_metrics`); `JOB_SURVEY_HEALTH_SUMMARY_SEC` 3600 (hourly); `JOB_ORG_METRICS_WEEKLY_SEC` 86400 (daily); `JOB_ORG_TOPIC_TRENDS_SEC` 86400 (daily tick, handler self-gates to Monday UTC since the registry has no day-of-week primitive); `JOB_ORG_HEALTH_SCORE_SEC` 86400 (daily). See `docs/org-dashboard/IMPLEMENTATION_SPEC.md` and `backend/src/scheduler/jobs/ORG_JOBS_REGISTRATION_TODO.md`. |
| `CREDENTIAL_EXPIRY_WARN_DAYS` | 14 | `credential-health` warns + alerts when a key's days-to-expiry drops below this |
| `WORKFLOW_APPROVAL_RENOTIFY_HOURS` | 72 | `renotify-stale-approvals` job: re-notify a `workflow_approvals` row's owner after it's sat `pending` this many hours since request/last notify. Never auto-rejects — simple expiry + re-notify only. |
| `WORKFLOW_RESUME_DELAYED_BATCH_SIZE` | 200 | `resume-delayed-executions` job: max `flow.delay`-waiting rows resumed per tick (oldest-due-first). Caps one tick's wall-clock time under a large post-outage backlog; leftover rows resume on subsequent ticks, not dropped. |

## Prism — data ingestion / migration engine (backend)

Prism is wired **per environment** via `APP_ENV` (resolved in `backend/src/lib/prism/config.ts`).
`getPrismConfig()` applies env-specific defaults; `validatePrismProductionConfig()` runs at boot
in `index.ts` and, in **staging/production**, refuses to start on any fatal misconfig (mirrors the
`AGENTS_INTERNAL_KEY` prod-validation precedent). See
`docs/otherplatforms/migration/production-readiness.md` for the full topology + env matrix.

### Environment selector
| Var | Status | Default | Purpose |
|---|---|---|---|
| `APP_ENV` | [def] | `development` (falls back to `NODE_ENV`: `production` ⇒ production, else development) | `development` \| `staging` \| `production`. Drives every Prism default below; the two prod-like tiers (staging/prod) enable the boot-time production-readiness gate. |

### Per-var matrix (Dev / Staging / Prod = **recommended** values; blank = unset)
| Var | Status | Default | Dev | Staging | Prod | Purpose |
|---|---|---|---|---|---|---|
| `PRISM_UPLOAD_BACKEND` | [def] | `local` dev / `s3` prod-like | `local` | `s3` | `s3` | Uploaded-file store for `prism-upload://` refs. `local` = filesystem; `s3` = object storage (requires **`@aws-sdk/client-s3`** installed). **Fatal in staging/prod if still `local`** (Fly.io disks are ephemeral/non-shared). |
| `PRISM_UPLOAD_DIR` | [def] | `<os.tmpdir()>/prism-uploads` | (default) | — | — | Root dir for the `local` backend (org-namespaced subdirs). Local-only. |
| `PRISM_UPLOAD_MAX_MB` | [def] | `60` | `60` | `60` | `60` | Max upload size (MB) for `POST /api/prism/uploads` (also the `express.raw` limit). |
| `PRISM_UPLOAD_S3_BUCKET` | [req if s3] | — | — | set | set | s3 bucket for uploads. **Fatal if `s3` and unset.** |
| `PRISM_UPLOAD_S3_REGION` | [req if s3] | — | — | set | set | s3 region. **Fatal if `s3` and unset.** |
| `PRISM_UPLOAD_S3_ENDPOINT` | [opt] | — (AWS default) | — | opt | opt | Custom S3-compatible endpoint (MinIO / Cloudflare R2 / Tigris on Fly). |
| `PRISM_UPLOAD_S3_FORCE_PATH_STYLE` | [def] | `false` | — | per-provider | per-provider | `true` for path-style addressing (MinIO / some S3-compatibles). |
| `PRISM_UPLOAD_S3_ACCESS_KEY_ID` | [opt] | — (falls back to instance IAM role) | — | opt | opt | s3 access key. Prefer instance IAM/role creds in prod; set only for static keys. |
| `PRISM_UPLOAD_S3_SECRET_ACCESS_KEY` | [opt] | — (falls back to instance IAM role) | — | opt | opt | s3 secret key. Treat as a secret; never commit. |
| `PRISM_SECRETS_BACKEND` | [def] | `local` dev / `gcp` prod-like | `local` | `gcp` | `gcp` | Credential store: `local` (envelope-encrypted file/in-mem, dev) \| `gcp` (GCP Secret Manager + Cloud KMS; `gcp_secret_manager` also accepted). **Fatal in staging/prod if `local`.** |
| `PRISM_RAW_RETENTION` | [def] | `purge_after_reconcile` | `purge_after_reconcile` | `purge_after_reconcile` | `purge_after_reconcile` | Raw-staging retention: `keep` (debug/replay) \| `purge_after_reconcile` (PII-minimizing default). |
| `PRISM_WORKER_ENABLED` | [def] | `true` | `true` (in-process) | `true` on worker group / `false` on web | `true` on worker group / `false` on web | Toggles the EXTRACT/LOAD engine worker loop (`startPrismWorker()`). Dev runs it in-process; prod runs it as a dedicated Fly `worker` process group. |
| `PRISM_MAX_CONCURRENT_EXTRACT` | [def] | `4` dev / `8` prod-like | `4` | `8` | `8` | Global EXTRACT worker concurrency cap. |
| `PRISM_SYNC_ENABLED` | [def] | `true` | `true` (in-process) | `true` on worker group / `false` on web | `true` on worker group / `false` on web | Toggles the continuous-sync (CDC) scheduler (`startPrismSyncScheduler()`). Same in-process-vs-worker-group split as the worker. |
| `PRISM_SYNC_POLL_INTERVAL_S` | [def] | `300` dev / `3600` prod-like | `300` | `3600` | `3600` | Trust-but-verify poll cadence (s) for the sync scheduler's reconciling backstop. |
| `PUBLIC_API_URL` | [def] / [req prod-like] | `http://localhost:3001` | `http://localhost:3001` | `https://api.staging…` | `https://api…` | Externally-reachable backend base — builds the Prism OAuth `redirect_uri` (`${PUBLIC_API_URL}/api/prism/oauth/:platform/callback`). **Fatal in staging/prod if unset** (OAuth breaks). |
| `FRONTEND_URL` | [opt] / [req prod-like] | falls back to `ALLOWED_ORIGIN` → `http://localhost:5173` | `http://localhost:5173` | `https://app.staging…` | `https://app…` | FE base for the post-OAuth callback redirect (`/app/prism/connect/:platform`); also the CORS-related origin. **Fatal in staging/prod if unset** (OAuth callback breaks). |
| `REDIS_URL` | [req prod-like] | `redis://localhost:6379` | optional (in-memory fallback) | set | set | Shared rate-limit token buckets, job queues, run-registry. **Fatal in staging/prod if unset** (multi-instance Prism is incorrect without it). |
| `AGENTS_INTERNAL_KEY` | [req] | `dev-internal-key-change-in-prod` | (dev default ok) | non-default | non-default | Backend ↔ CrystalOS shared secret. **Fatal in staging/prod if missing or still the dev default.** |
| `QUALTRICS_OAUTH_CLIENT_ID` / `QUALTRICS_OAUTH_CLIENT_SECRET` | [opt] | — | — | per-connector | per-connector | Qualtrics OAuth app (per-deploy creds; per-org tokens live in Secret Manager). |
| `TYPEFORM_OAUTH_CLIENT_ID` / `TYPEFORM_OAUTH_CLIENT_SECRET` | [opt] | — | — | per-connector | per-connector | Typeform OAuth app (one-click connect via `/api/prism/oauth/typeform`). |
| `SURVEYMONKEY_OAUTH_CLIENT_ID` / `SURVEYMONKEY_OAUTH_CLIENT_SECRET` | [opt] | — | — | per-connector | per-connector | SurveyMonkey OAuth app (`/api/prism/oauth/surveymonkey`). |
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` | [opt] | — | — | per-connector | per-connector | Google OAuth app (Forms + Business Profile share it, scoped) — `/api/prism/oauth/google` (aliases `google_forms`/`google_business`/`gbp`/`forms`). |
| `TRUSTPILOT_OAUTH_CLIENT_ID` / `TRUSTPILOT_OAUTH_CLIENT_SECRET` | [opt] | — | — | per-connector | per-connector | Trustpilot OAuth app (`/api/prism/oauth/trustpilot`). |
| `APPLE_ASC_ISSUER_ID` / `APPLE_ASC_KEY_ID` | [opt] | — | — | per-connector | per-connector | App Store Connect JWT identifiers (per-org `.p8` key in Secret Manager, **not** env). |

> **s3 dependency:** the `s3` upload backend requires `@aws-sdk/client-s3` to be installed
> (`cd backend && npm i @aws-sdk/client-s3`). Owned by the storage agent — not a dependency of
> `config.ts`/`index.ts`, which only validate the *intent*.
>
> **Fatal-in-prod recap** (staging/production refuse boot): `REDIS_URL` unset · `PRISM_UPLOAD_BACKEND=local`
> (or `s3` without bucket/region) · `PRISM_SECRETS_BACKEND=local` · `AGENTS_INTERNAL_KEY` missing/default ·
> `PUBLIC_API_URL` unset · `FRONTEND_URL` unset.
>
> Per-org / per-connection credentials live in **Secret Manager** (referenced by `credential_ref`),
> never in env or Postgres. See `docs/otherplatforms/migration/security-compliance.md` §2.

## Integrations — optional
| Var(s) | Purpose |
|---|---|
| `NOVU_API_KEY`, `NOVU_SECRET_KEY`, `NOVU_APP_ID`, `VITE_NOVU_APP_ID` | Novu notifications (`VITE_NOVU_APP_ID` is app) |
| `SENDGRID_API_KEY`, `NOTIFICATION_FROM_EMAIL` | Email delivery |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | Alternate LLM providers |
| `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_PROJECT_KEY` | Jira ticket sync |
| `SERVICENOW_INSTANCE_URL`, `SERVICENOW_USER`, `SERVICENOW_PASSWORD` | ServiceNow connector |
| `SF_INSTANCE_URL`, `SF_ACCESS_TOKEN` | Salesforce connector |
| `ZENDESK_SUBDOMAIN`, `ZENDESK_EMAIL`, `ZENDESK_API_TOKEN` | Zendesk ticket connector (`zendesk.create_ticket` workflow action) |

## Workflow Automation — per-org connector credentials vault
| Var | Status | Purpose |
|---|---|---|
| `WORKFLOW_CREDENTIALS_KEY` | [opt; req in prod for the vault] | 32-byte AES-256-GCM key (hex — 64 chars — or base64), used by `backend/src/lib/workflowCredentials.ts` to encrypt/decrypt the `workflow_connector_credentials` table (per-org Jira/Salesforce/ServiceNow/Zendesk/Slack/webhook credentials). Generate with `openssl rand -hex 32`. Absent/dev ⇒ vault disabled and every connector falls back to the shared env vars above (zero breaking change). Malformed (wrong decoded length) throws at read time — validated at startup, fails loud in production, warns in dev. |

Jira/Salesforce/ServiceNow/Zendesk connectors (`backend/src/lib/connectors.ts`) now check
`getCredentials(orgId, connector)` (per-org, vault-backed) FIRST, then fall back to the
matching shared env var(s) above. The `notify.webhook` workflow action HMAC-SHA256 signs
its JSON body (`X-Experient-Signature: sha256=<hex>` header) using `config.secret`
(per-workflow) or the org's vaulted `webhook` credential's `secret` field, in that order;
unsigned only when neither is set.

## Observability — optional
| Var(s) | Purpose |
|---|---|
| `SENTRY_DSN`, `VITE_SENTRY_DSN` | Error tracking (backend / app) |
| `LOKI_URL`, `LOKI_USER`, `LOKI_PASSWORD` | Log shipping |
| `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_HOST` | CrystalOS LLM tracing |
| `ALERTMANAGER_WEBHOOK_URL` | Alertmanager receiver (docker-compose) |

## CrystalOS storage / vision (prod) — optional
`GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CLOUD_PROJECT`, `CHECKPOINT_OCI_{BUCKET,NAMESPACE,REGION}`,
`CHECKPOINT_LOCAL_PATH`, `GOOGLE_VISION_KEY`, `VISION_PROVIDER`, `EVENT_BUS`, `PUBSUB_TOPIC`, `WORKER_ID`.

## Frontend — `app/.env.example`
`VITE_API_URL` [req], `VITE_CLERK_PUBLISHABLE_KEY` [opt], `VITE_NOVU_APP_ID` [opt], `VITE_SENTRY_DSN` [opt], `VITE_SUPPORT_URL` [opt — defaults to `https://support.xperiq.ai`; set to `http://localhost:3002` in local dev to link to the local support site], `VITE_INSIGHTS_TRAJECTORY_V1` [opt — defaults `true`; set `false` to hide the Phase 0.5 Insight Pipeline v2 investigation trajectory UI (Enhanced Header Band + Investigation Drawer + Topic Change Bar)].

## CrystalOS advanced tunables — defaults in `crystalos/lib/constants.py`
`INGEST_*`, `SKILL_*`, `THREAD_*`, `REPORT_*`, `HALLUCINATION_*`, `SEMANTIC_CACHE_*`, `MAX_TOKENS_PER_RUN`,
`MAX_DAILY_SPEND_USD`, `ORG_MEMORY_*`, `PRIOR_INSIGHT_*`, `USE_SKILL_RUNTIME`, `AGENTS_HOST`/`AGENTS_PORT`,
`NODE_TIMEOUT_S`. Insight Pipeline v2 (Phase 2/3): `DEFAULT_PRIOR_CHECKPOINT_LOOKBACK`,
`DEFAULT_PRIOR_CHECKPOINT_MAX_AGE_DAYS`, `DEFAULT_STREAM_THRESHOLD`, `DEFAULT_REPORT_REGEN_THRESHOLD`,
`DEFAULT_FULL_CHECKPOINT_THRESHOLD`, `DEFAULT_MEANINGFUL_DELTA_NPS_POINTS`, `DEFAULT_MEANINGFUL_DELTA_TOPIC_PCT`,
`DEFAULT_MANUAL_EXPERT_SNAPSHOTS`, `DEFAULT_MANUAL_QUICK_SAMPLE`, `DEFAULT_MANUAL_QUICK_SNAPSHOTS`,
`DEFAULT_MANUAL_QUICK_WINDOW_DAYS`, `DEFAULT_MANUAL_EXPERT_CHECKPOINT_LOOKBACK`, `DEFAULT_MANUAL_EXPERT_MAX_CORPUS`,
`DEFAULT_MANUAL_EXPERT_FULL_CORPUS_CAP`, `DEFAULT_REFRESH_LOOKBACK_DAYS`, `DEFAULT_REFRESH_MIN_RESPONSE_COUNT`,
`DEFAULT_RESPONSE_TAGGING_BATCH_SIZE` (default `1` — how many new-response stream events accumulate before
`consumers/response_stream.py` runs a lightweight sentiment/emotion/effort/topic tagging sweep,
`lib/response_tagging.py::tag_untagged_responses`; independent of `DEFAULT_STREAM_THRESHOLD`, which still gates
full report+checkpoint generation), `RESPONSE_TAGGING_SWEEP_CAP` (safety ceiling on how many untagged responses
a single tagging sweep call processes, independent of the batch-size trigger cadence above; env-tiered since
2026-07-13 — dev `50`, dev-paid `75`, staging `100`, prod `200` — larger in prod so a real backlog drains in
fewer scheduler ticks), `MAX_RESPONSE_TAGGING_ATTEMPTS` (default `3` — circuit breaker added 2026-07-13: a
response that fails tagging this many times in a row is quarantined, i.e. marked enriched with no scores, instead
of being retried forever; without this a single permanently-poisoned response would be re-selected by every
future sweep's oldest-first query and block every response behind it — see
`lib/response_tagging.py::_record_batch_failure`),
`TOPIC_DISCOVERY_CANDIDATE_THRESHOLD` (default `25` — flat candidate-buffer floor before a new topic gets
clustered + LLM-named; shared by `node_cluster` AND `lib/response_tagging.py::tag_untagged_responses` so both
"enough evidence for a new topic" checks agree)
(platform-constant fallbacks for the survey/org settings COALESCE merge), and `INSIGHT_CHECKPOINTS_V2_ENABLED`
(default `true` — dual-write `insight_checkpoints_v2` alongside the legacy `survey_insight_checkpoints` table during migration).
An explicit `INSIGHT_RESPONSE_TAGGING_BATCH_SIZE` env var (ops escape hatch, mirrors the existing but
undocumented `INSIGHT_NEW_RESPONSE_THRESHOLD`) overrides `resolve_response_tagging_batch_size`'s survey/org/
platform resolution outright.
Manual "Catch Up Tagging" job (Experience → Topics page, added 2026-07-13; renamed from "Backfill Tagging"):
cost is TIERED by backlog size, not flat (`backend/src/lib/creditPlans.ts::resolveTopicBackfillCost`, pricing
review) — `CREDIT_COST_TOPIC_BACKFILL` (default `15` — tier 1, ≤500 untagged responses), `CREDIT_COST_TOPIC_
BACKFILL_TIER2` (default `40` — 501–5,000), `CREDIT_COST_TOPIC_BACKFILL_TIER3` (default `200` — 5,001–50,000),
`CREDIT_COST_TOPIC_BACKFILL_PER_1K` (default `5` — credits per additional 1,000 responses above 50,000; unlike
Custom Analysis's bounded/sampled corpus, this job processes every untagged response with no sampling, so cost
keeps climbing above tier 3 instead of flattening out, up to the same 500-credit platform ceiling `resolveCustomCost`
uses). CrystalOS's own `POST /topics/backfill` endpoint and `lib/topic_backfill.py` orchestrator have no separate
env vars — they reuse `RESPONSE_TAGGING_SWEEP_CAP`/`MAX_RESPONSE_TAGGING_ATTEMPTS` above.
Insight Pipeline v2 (Phase 6/7): `CREDIT_COST_CUSTOM_BASE` (default `25` — base credit cost for a Custom Analysis run),
`ENABLE_RETENTION_JOB` (default `false` — gate the nightly automated-checkpoint retention/compaction job in `scheduler.py`;
dev no-op unless set to `true`), `RETENTION_BLOB_DROP_DAYS` (default `30` — grace days before a collapsed low-delta
automated checkpoint's `report_blob_ref` is dropped), `ENABLE_RESPONSE_TAGGING_BACKLOG_SWEEP` (default `true` —
gate the 15-min `run_response_tagging_backlog_sweep` job that catches untagged responses on surveys not
currently receiving live stream traffic, or whose tagging previously failed), `RESPONSE_TAGGING_BACKLOG_MAX_SURVEYS_PER_TICK`
(default `20` — cap on distinct surveys swept per tick).
Tag Report (`crystalos/graphs/tag_report.py`, added 2026-07-02): `TAG_REPORT_DEFAULT_TARGET_N` (default `5` —
survey-selection target before an org/tag override applies), `TAG_REPORT_CEILING_N` (default `20` — hard cap on
surveys scanned regardless of overrides), `TAG_REPORT_BATCH_SIZE` (default `3` — surveys fetched per
`fetch_next_batch` loop iteration), `TAG_REPORT_MIN_RESPONSE_COUNT` (default `30` — per-survey response-count floor
for trend eligibility), `TAG_REPORT_MIN_TRUST_SCORE` (default `40` — per-survey trust-score floor for trend
eligibility), `TAG_REPORT_AGREEMENT_FLOOR` (default `2` — minimum agreeing trend-eligible surveys before a metric's
`confidence_tier` can be `"confirmed"` rather than `"insufficient"`, DESIGN.md R-T2), `TAG_REPORT_STALENESS_THRESHOLD_DAYS`
(default `21` — checkpoint-age divergence across contributing surveys that triggers a staleness warning, DESIGN.md R-A2),
`TAG_REPORT_CADENCE_MISMATCH_RATIO` (default `2.0` — a survey's checkpoint cadence vs. the tag's median cadence ratio
that triggers R-T3's `cadence_mismatch` comparability warning), `TAG_REPORT_CITATIONS_PER_SURVEY` (default `3` — max
real per-response citations resolved per contributing survey when merging the report's citation manifest).
Org Intelligence Dashboard / Command Center (`routes/org-dashboard.ts`, `services/org-metrics.service.ts`, added
2026-07-04, `docs/org-dashboard/`): `ORG_DASHBOARD_MAX_RANGE_DAYS` (default `90` — the single reconciled cap on
`POST /dashboard/summaries`/`summaries/preview` date ranges, satisfying both the `org_metrics_daily`-servability
constraint and the signal-logic-validity constraint per Decision 16 item 3), `ORG_SUMMARY_MIN_N` (default `100` —
response-count floor below which a Custom Summary preview reports `low_confidence: true`; an org-wide-scaled
analogue of Custom Analysis's `custom_analysis_min_n_for_nps`), `ORG_BRIEF_REGENERATE_ESTIMATED_SECONDS` (default
`45` — `estimatedSeconds` returned by `POST /dashboard/crystal-brief/regenerate`, sized for Decision 16 item 4's
"1 guaranteed + 1 conditional LLM call per brief" cost model). See `CREDIT_COST_{ORG_SUMMARY_BASE,ORG_SUMMARY_MAX}`
and `ORG_SUMMARY_DAILY_LIMIT` in the Credit system table above for the summary cost/rate-limit knobs.
All have safe defaults — only set to tune; they don't belong in `.env.example`.

---

## Paste-ready `.env.example` templates

### `./.env.example` (root)
```dotenv
# ── Core ──────────────────────────────────────────────────────────────────
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/xperiq
REDIS_URL=redis://localhost:6379
OPENROUTER_API_KEY=
AGENTS_INTERNAL_KEY=dev-internal-key-change-in-prod
AGENTS_URL=http://localhost:8001
# BACKEND_INTERNAL_URL=http://localhost:3001
AGENTS_ENV=dev
# NODE_ENV=production
# PORT=3001
# LOG_LEVEL=info

# ── Auth (Clerk) — leave blank for dev mode (dev-user/dev-org) ─────────────
CLERK_SECRET_KEY=
CLERK_WEBHOOK_SECRET=

# ── Alternate LLMs (optional) ──────────────────────────────────────────────
# ANTHROPIC_API_KEY=
# OPENAI_API_KEY=

# ── Billing / Stripe (optional; manual grants work without) ────────────────
# STRIPE_SECRET_KEY=sk_test_...
# STRIPE_WEBHOOK_SECRET=whsec_...
APP_URL=http://localhost:5173

# ── Credit system (optional — defaults in creditPlans.ts) ──────────────────
# CREDIT_DEFAULT_PLAN=free          # set 'enterprise' locally to skip the free cap
# COST_DOWN_DRY_RUN=true
# CREDIT_LEDGER_RETENTION_MONTHS=18
# CREDIT_BALANCE_CACHE_TTL=10

# ── Workers / scheduler (optional) ─────────────────────────────────────────
ENABLE_EVENT_ENGINE=true
ENABLE_SCHEDULER=true
ENABLE_STREAM_CONSUMER=true
# SCHEDULER_PORT=8090
# SCHEDULER_LEADER_ELECTION=true
# SCHEDULER_POLL_SEC=3600
# JOB_CREDENTIAL_HEALTH_SEC=21600   # probe integration keys every 6h
# CREDENTIAL_EXPIRY_WARN_DAYS=14    # warn/alert when a key is <14d from expiry
# INSIGHT_INTERVAL_FREE_MIN=120
# INSIGHT_INTERVAL_PAID_MIN=15

# ── Prism — data ingestion / migration engine ─────────────────────────────
APP_ENV=development                   # development | staging | production (falls back to NODE_ENV)
PRISM_SECRETS_BACKEND=local           # dev: local | staging/prod: gcp (Secret Manager + KMS)
PRISM_RAW_RETENTION=purge_after_reconcile   # keep | purge_after_reconcile
PRISM_UPLOAD_BACKEND=local            # dev: local | staging/prod: s3 (needs @aws-sdk/client-s3)
# PRISM_UPLOAD_DIR=                   # local backend root; default: <os.tmpdir()>/prism-uploads
# PRISM_UPLOAD_MAX_MB=60
# ── s3 upload backend (staging/prod) — `npm i @aws-sdk/client-s3` ──
# PRISM_UPLOAD_S3_BUCKET=
# PRISM_UPLOAD_S3_REGION=
# PRISM_UPLOAD_S3_ENDPOINT=            # custom S3-compatible endpoint (R2/MinIO/Tigris)
# PRISM_UPLOAD_S3_FORCE_PATH_STYLE=false
# PRISM_UPLOAD_S3_ACCESS_KEY_ID=       # prefer instance IAM role in prod
# PRISM_UPLOAD_S3_SECRET_ACCESS_KEY=
# ── Workers (dev: in-process; prod: dedicated Fly `worker` process group) ──
PRISM_WORKER_ENABLED=true             # EXTRACT/LOAD engine worker loop
# PRISM_MAX_CONCURRENT_EXTRACT=4       # dev default 4; staging/prod 8
PRISM_SYNC_ENABLED=true               # continuous-sync (CDC) scheduler
# PRISM_SYNC_POLL_INTERVAL_S=300       # dev default 300; staging/prod 3600
# ── OAuth URLs — REQUIRED in staging/prod (boot refuses without them) ──
# PUBLIC_API_URL=http://localhost:3001   # externally-reachable backend base for OAuth redirect_uri
# FRONTEND_URL=http://localhost:5173     # FE base for OAuth callback redirects
# QUALTRICS_OAUTH_CLIENT_ID=
# QUALTRICS_OAUTH_CLIENT_SECRET=
# TYPEFORM_OAUTH_CLIENT_ID=
# TYPEFORM_OAUTH_CLIENT_SECRET=
# SURVEYMONKEY_OAUTH_CLIENT_ID=
# SURVEYMONKEY_OAUTH_CLIENT_SECRET=
# GOOGLE_OAUTH_CLIENT_ID=
# GOOGLE_OAUTH_CLIENT_SECRET=
# TRUSTPILOT_OAUTH_CLIENT_ID=
# TRUSTPILOT_OAUTH_CLIENT_SECRET=
# APPLE_ASC_ISSUER_ID=
# APPLE_ASC_KEY_ID=

# ── Notifications / Novu (optional) ────────────────────────────────────────
# NOVU_API_KEY=
# NOVU_SECRET_KEY=
# NOVU_APP_ID=
# SENDGRID_API_KEY=
# NOTIFICATION_FROM_EMAIL=

# ── CRM / ticketing connectors (optional) ─────────────────────────────────
# JIRA_BASE_URL=
# JIRA_EMAIL=
# JIRA_API_TOKEN=
# JIRA_PROJECT_KEY=
# SERVICENOW_INSTANCE_URL=
# SERVICENOW_USER=
# SERVICENOW_PASSWORD=
# SF_INSTANCE_URL=
# SF_ACCESS_TOKEN=

# ── Observability (optional) ───────────────────────────────────────────────
# SENTRY_DSN=
# LOKI_URL=
# LOKI_USER=
# LOKI_PASSWORD=
# LANGFUSE_PUBLIC_KEY=
# LANGFUSE_SECRET_KEY=
# LANGFUSE_HOST=

# ── CrystalOS storage / vision (prod, optional) ───────────────────────────
# GOOGLE_APPLICATION_CREDENTIALS=
# GOOGLE_CLOUD_PROJECT=
# CHECKPOINT_OCI_BUCKET=
# CHECKPOINT_OCI_NAMESPACE=
# CHECKPOINT_OCI_REGION=
# VISION_PROVIDER=
# GOOGLE_VISION_KEY=
```

### `app/.env.example`
```dotenv
VITE_API_URL=http://localhost:3001
# VITE_CLERK_PUBLISHABLE_KEY=
# VITE_NOVU_APP_ID=
# VITE_SENTRY_DSN=
# VITE_INSIGHTS_TRAJECTORY_V1=true   # set false to disable Phase 0.5 trajectory UI
```

### `backend/.env.example`
Backend reads the **root** `.env`; a backend-local file only needs overrides. At minimum mirror
`DATABASE_URL`, `REDIS_URL`, `OPENROUTER_API_KEY`, `AGENTS_INTERNAL_KEY`, and (if testing payments)
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `APP_URL`.

---

## Support Site (`support/`) — `support/.env.example`

| Var | Status | Default | Purpose |
|---|---|---|---|
| `NEXT_PUBLIC_API_URL` | [req] | `http://localhost:3001` | Xperiq backend API base URL |
| `NEXT_PUBLIC_SITE_URL` | [req prod] | `https://support.xperiq.ai` | Canonical site URL (used in sitemap, OG tags, IndexNow) |
| `NEXT_PUBLIC_CRYSTAL_ENABLED` | [opt] | `true` | Enable Crystal AI search panel |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | [opt] | — | Same Clerk app as the main frontend. When absent, "My Tickets" auth is disabled. |
| `CLERK_SECRET_KEY` | [opt] | — | Clerk secret for server-side token verification. Required for `/my-tickets`. |
| `REVALIDATE_SECRET` | [req prod] | — | Shared secret for ISR revalidation webhook (`x-revalidate-secret` header). Also used as `Authorization: Bearer` for IndexNow endpoint. **Change in prod.** |
| `INDEXNOW_KEY` | [opt] | — | IndexNow key for Google/Bing instant indexing pings on doc publish |

**GitHub Actions secrets** (also needed in CI):
- `FLY_API_TOKEN_SUPPORT` — Fly.io API token scoped to the `xperiq-support` app
- `REVALIDATE_SECRET` — same value as above
- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` — same key as used in the main app CI
