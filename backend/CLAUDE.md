# Xperiq — Backend (Express API, TypeScript)

## What this is
Express API written in **TypeScript**, run directly via `tsx` (no build step) under
PM2. Handles all write operations, AI calls, and business logic. All data is
Postgres-backed (no Firestore). For authoring conventions see `backend/SKILLS.md`.

## Stack
- Node.js 20+ · Express · **TypeScript (strict) via `tsx`** (no compile step; `npm run build` = `tsc` typecheck only)
- Postgres via `pg` (`src/lib/db.ts`) — primary datastore
- Redis via ioredis (`src/lib/redis.ts`) — sliding-window rate limiter (in-memory fallback)
- OpenRouter (`src/lib/openrouter.ts`) — AI model gateway
- Zod (request validation) · Pino (logging) · prom-client (metrics) · Clerk (JWT auth) · Sentry

## Directory structure
```
src/
  index.ts          # Express app entry; mounts all routers (see "Routers" below)
  routes/           # ~31 route files (.ts), plus routes/webhooks/clerk.ts (raw-body, mounted before express.json())
  lib/              # ~38 infra modules (.ts) — db, agentsClient, openrouter, httpError, metrics, logger,
                    #   redis, rbac, alertEngine, workflowEngine, exporters, connectors, … (dir is authoritative)
  middleware/       # auth, requireRole, requirePermission, rateLimiter, httpLogger, requestId, scimAuth
  schemas/          # Zod request schemas (alerts, …)
  test/setup.cjs    # registers the tsx CJS hook so .test.js files can require() .ts source
  data/             # Seed data / reference JSON
```

## Routers (mounted in `src/index.ts`)
`/api/public`, `/api/surveys` (surveys + responses + insights), `/api/insights`,
`/api/templates`, `/api/ai` (aiLimiter), `/api/workflows`, `/api/org-profile`,
`/api/orgs`, `/api/orgs/me`, `/api/users`, `/api/roles`, `/api/departments`,
`/api/groups`, `/api/survey-tags`, `/api/group-insights`, `/api/scim-tokens`,
`/api/sso-mappings`, `/api/seats`, `/api/audit-logs`, `/api/alerts`,
`/api/dashboard`, `/api/dashboard-configs`, `/api/visual`,
`/api/notification-channels`, `/scim/v2` (bearer-token auth, **no** apiLimiter),
`/api/copilot`, `/api/runs`, `/api/experience`, `/api/notifications`,
`/api/reports` (Custom Analysis — Phase 6), `/api/admin` (proxy → CrystalOS, see below).
Plus `/webhooks/clerk`, `/api/health`, `/api/metrics`.

## Two outbound paths to CrystalOS (port 8001)
- **`lib/agentsClient.ts`** — typed client for orchestration/insights/Crystal calls.
- **`/api/admin` proxy** (`routes/admin.ts`) — forwards `/api/admin/*` to `AGENTS_URL`,
  gated by Clerk `requireAuth` then injects `X-Internal-Key: AGENTS_INTERNAL_KEY`
  before forwarding (15s timeout → 504). Powers the Crystal admin UI.

## Key patterns
- All routes use `requireAuth` middleware — extracts `req.orgId` and `req.userId`
- `trust proxy: 1` set in index.js (needed behind GCP/Cloud Run load balancers for correct req.ip)
- Soft-delete on surveys: `deleted_at` timestamp, all queries filter `AND deleted_at IS NULL`
- SQL injection prevention: Always use parameterized queries (`$1`, `$2`, etc.) — never string interpolation
- Rate limiting: `REDIS_URL` env var enables Redis store; otherwise in-memory (not suitable for multi-instance)

## Environment variables
> **Full list:** `docs/ENV_VARS.md` (canonical). **Adding a `process.env.X`? Add it there AND to the matching `.env.example` in the same PR.** Key ones below.
- `DATABASE_URL` — Postgres connection string
- `REDIS_URL` — Redis connection string (optional, in-memory fallback)
- `OPENROUTER_API_KEY` — AI API key
- `AGENTS_INTERNAL_KEY` — Shared secret with the Python agents service (must match). Default `dev-internal-key-change-in-prod` is rejected in production by startup validation in `index.js`.
- `CLERK_SECRET_KEY` — Clerk JWT verification key. When absent, backend runs in dev mode (all requests authenticated as dev-user/dev-org). No SKIP_AUTH env var needed.
- `ALLOWED_ORIGIN` — CORS allowed origin (frontend URL)

## Crystal Intelligence (AI) routes
`routes/insights.ts` exposes the Crystal/AI endpoints:
- `POST /api/insights/:surveyId/generate` — trigger insight pipeline via `agentsClient.ts`
- `POST /api/insights/:surveyId/crystal` — Crystal SSE stream (proxied to CrystalOS skill-first path)
- `GET  /api/insights/:surveyId/topics` (+ `/topics/hierarchy`) — topic list / hierarchy
- `GET|DELETE /api/insights/:surveyId/crystal/history` — Crystal conversation history
- `POST|GET /api/insights/:surveyId/crystal/proposals` — **action-proposal outcome tracking**.
  POST upserts on `(org_id, proposal_key)` with `status ∈ {emitted,accepted,dismissed,succeeded,failed}`
  (idempotent); GET lists recent proposals for analytics. Backed by `crystal_action_proposals`.
- **Insight Pipeline v2 — Phase 3 (manual runs + reports):**
  - `POST /api/insights/:surveyId/runs` — start a manual/refresh run (`{ mode: expert|quick|refresh, window_start?, window_end?, label? }`).
    Daily-limit gate → 429 `RATE_LIMITED`; credit preflight → 402 `INSUFFICIENT_CREDITS`; creates `agent_runs`,
    debits credits, calls `agentsClient.triggerManualInsightRun` → 202 `{ run_id, status:'started' }`.
  - `POST /api/insights/:surveyId/runs/preview` — cost/corpus preview (no debit) → `{ estimated_cost, corpus_size, estimated_duration_label, sample_size }`.
  - `GET /api/insights/:surveyId/reports/:reportId` — manual report row (`insight_reports`) + blob document/`blob_url`.
- **Insight Pipeline v2 — Phase 4 (trail):**
  - `GET /api/insights/:surveyId/trail` — linked checkpoint list (`insight_checkpoints_v2`, falls back to legacy
    `survey_insight_checkpoints`) + manual `insight_reports`. Query: `lane` (automated|manual|all), `limit`, `cursor`.
  - `GET /api/insights/:surveyId/trail/:checkpointId` — node + `lineage_json` + `delta_from_prior` + blob.
  - `GET /api/insights/:surveyId/trail/:checkpointId/compare/:otherId` — side-by-side metric/topic diff.
- **Insight Pipeline v2 — Phase 6 (Custom Analysis):** `routes/reports.ts` mounted at `/api/reports`.
  Custom Analysis is a SEPARATE surface (own queue + tables); results go to `custom_reports` /
  `custom_report_insights` and **never** to the `insights` table.
  - `POST /api/reports/custom` — body `{ survey_id, name, filter_spec }`. Corpus count → credit
    cost via `resolveCustomCost()` (25–75 by tier); daily-limit gate → 429 `RATE_LIMITED`; credit
    preflight → 402 `INSUFFICIENT_CREDITS`; inserts `custom_reports` (status `pending`) + `agent_runs`,
    debits, calls `agentsClient.triggerCustomAnalysis` → 202 `{ report_id, run_id, status:'pending', slug }`.
  - `POST /api/reports/custom/preview` — `{ survey_id, filter_spec }` → `{ estimated_cost, corpus_size,
    sample_size, low_confidence }` (no debit).
  - `GET /api/reports/custom?survey_id=` — list org's custom reports (newest first).
  - `GET /api/reports/custom/:reportId` — report row + isolated `custom_report_insights` + blob document.
- **Tag Report** (`docs/tag-report/DESIGN.md` + `TRACKER.md`) — rolls up EXISTING per-survey
  `insight_checkpoints_v2` checkpoints across every survey sharing a tag; **never generates fresh
  AI insight** (zero `agentsClient`/CrystalOS calls in the selection path — only the explicit
  generate-a-run kick-off). Selection logic lives in `lib/tagReportSelection.ts` (tag
  validation/org-scoping, candidate-survey existence check, `effective_max_surveys` 3-tier
  resolution — does NOT touch `insight_checkpoints_v2`, does NOT do recency/backfill; that is
  CrystalOS's `tag_report.py` graph) and `lib/tagReportRunner.ts` (shared run-creation flow used
  by all three trigger sources). `lib/groupInsightRunConcurrency.ts` wraps every
  `INSERT INTO group_insight_runs` (both the pre-existing `/generate` route and Tag Report's new
  endpoints) so a concurrent duplicate attaches to the in-flight run (`uq_gir_tag_inflight`) instead
  of raising a raw `23505`. `lib/tagReportScheduler.ts` is Automated mode's due-tags sweep — reuses
  `lib/workflowQueue.ts`'s Redis Streams queue for thundering-herd jitter, ticked every 15 min from
  `eventEngine/processor.ts` (`ENABLE_EVENT_ENGINE=true`), dispatched via a dedicated
  `tag_report.automated_due` trigger type in `workflowQueue.ts::handleTrigger` (NOT
  `runWorkflowsForEvent`, which is for org-authored workflows only).
  - `routes/survey-groups.ts` (mounted `/api/group-insights`): `GET tag-reports` (index list),
    `POST tag-report/manual`, `POST tag-report/custom-range` (both `requireAuth` +
    `requireRole('analyst')`), `POST tag-report/automated` (internal-only, `requireInternalKey`,
    called by the scheduler — not `requireAuth`), `GET tag-report/:runId` (+ `group_insight_run_sources`
    join, `metric_key` partitioning), `GET tag-report/:runId/trail` (bounded `parent_run_id` walk).
  - `routes/tags.ts` (mounted `/api/survey-tags`): `GET/PATCH :id/report-config`,
    `GET :id/tag-report-history`.
  - `agentsClient.generateTagReport(...)` → CrystalOS `POST /tag-reports/generate`, mirrors
    `generateGroupInsights`'s fire-and-forget shape; passes `tag_id` (never `survey_ids` — CrystalOS
    resolves candidates itself from `effective_max_surveys` as `target_n`).
  - **Known doc/reality mismatch (pre-existing, not introduced here):** this file's own historical
    "Mounted at /api/survey-groups" header and `routes/tags.ts`'s "Mounted at /api/tags" header do
    not match their actual `src/index.ts` mount paths (`/api/group-insights`, `/api/survey-tags`).
    TRACKER.md's Tag Report endpoint list inherited the stale prefixes; the paths above are the real
    ones.

## Postgres schema highlights
See docs/SURVEY_DATA_MODEL.md for full schema.
Key tables: surveys, responses, templates, workflows, orgs, insights, survey_topics, crystal_threads, agent_runs
- `surveys.questions`: JSONB array of question objects
- `surveys.status`: CHECK constraint — 'draft' | 'active' | 'paused' | 'closed'
- `insights`: per-survey agentic insight records (layer/category/headline/trust_score)
- `survey_topics`: canonical topic registry per survey per run
- `crystal_threads`: Crystal AI conversation threads (7-day TTL via `last_active_at`)
- `agent_runs`: pipeline run tracking with `status`, `heartbeat_at`, `stream_events`
- `notification_preferences` + `notification_events`: notification infrastructure (channels: in_app/email/push)
- `crystal_action_proposals`: outcome funnel for Crystal action proposals (emitted→accepted→succeeded/failed/dismissed)
- `insight_checkpoints_v2`: Insight Pipeline v2 linked-list checkpoints (lane automated|manual, parent_checkpoint_id, delta_from_prior, lineage_json); legacy `survey_insight_checkpoints` still read as fallback
- `insight_reports`: manual insight run documents (run_mode manual_expert|manual_quick, window, blob_ref, status)
- `custom_reports` + `custom_report_insights`: Custom Analysis (Phase 6) — ISOLATED from the insights pipeline; `custom_report_insights` rows never appear in the `insights` table and never supersede live projections
- Tag Report additions (additive, `supabase/migrations/20260702{110000,120000,130000}_tag_report_*.sql`):
  `group_insight_runs.{run_mode,window_start,window_end,parent_run_id,trigger}` + the
  `uq_gir_tag_inflight` partial unique index (blocks any concurrent run per `(org_id, tag_ids)`
  while `status IN ('pending','running')`); new table `group_insight_run_sources` (per-survey,
  per-checkpoint provenance — `checkpoint_id` FKs to `insight_checkpoints_v2`, **not**
  `insight_reports`; `bracket_position 'single'|'start'|'end'`); `group_insights.metric_key`
  (`nps|csat|ces|NULL`); `survey_tags.max_surveys_override` +
  `org_insight_defaults.max_surveys_per_tag_report` (3-tier cap resolution, platform fallback 5).
  **`insight_checkpoints_v2` has no `status` column** — any row that exists is inherently a
  completed checkpoint (written once, atomically, at publish time); never filter on `status='ready'`.

## Testing

Every code change requires a corresponding test change:
- **New function or route** → add unit/integration tests in `src/__tests__/`
- **Modified behavior** → update existing tests to match new behavior; delete tests for removed behavior
- **Bug fix** → add a regression test that would have caught the bug (e.g. the `created_at` vs `generated_at` column name bug needs a test that asserts the query contains `generated_at`)

Test files mirror `src/` structure. Tests are `.js` (not `.ts`) — they `require()`
`.ts` source via the tsx CJS hook registered in `src/test/setup.cjs`.

Run tests (Node 22):
```bash
nvm use 22 && npm test                          # all tests (vitest run)
nvm use 22 && npx vitest run src/__tests__/x.test.js  # single file
```

Mock patterns:
- DB: inject into `require.cache[DB_PATH]` via `fakeMod()`
- Auth middleware: inject `requireAuth` that sets `req.orgId = 'o1'`
- HTTP: use `light-my-request` `inject()` against an Express app
- External libs (pdfmake, pptxgenjs): use `deps.load` injection pattern in exporters

## Keeping these docs in sync
- New router → register in `src/index.ts` AND add to the "Routers" list (note any non-standard limiter/auth).
- New Crystal-facing endpoint → list it under "Crystal Intelligence routes"; new tables → "Postgres schema highlights".
- New outbound call to CrystalOS → goes through `lib/agentsClient.ts` (typed) or the `/api/admin` proxy (`X-Internal-Key`); document which.
- All source is `.ts` via `tsx` (no build step); tests are `.js` via the tsx hook. Any doc referencing a `.js` source file is stale.
