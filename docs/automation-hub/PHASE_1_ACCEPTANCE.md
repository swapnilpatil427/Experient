# Phase 1 Acceptance Criteria — Xperiq Actions (Workflow Automation)

**Sign-off owner:** Maya Okonkwo, Staff PM, Workflow Automation
**Date:** 2026-07-01
**Scope reviewed:** Wave 1 output (Priya — async queue/retry/DLQ; David — Zendesk +
signed webhooks + credentials vault; Elias — Workflow List UI), against the Phase 1
criteria in `docs/automation-hub/TEAM.md` ("Success Metrics > Phase 1 (Engine)") and
the checklist in `docs/automation-hub/TRACKER.md`.

**Method:** I did not take the team's self-reports (TRACKER.md, the ADR) at face
value. For every criterion below I either (a) re-ran the actual test suite myself,
(b) read the source that implements the claim, or (c) determined the claim requires
infrastructure this sandbox does not have and said so — rather than assuming a pass.
Where I spot-checked, I show what I checked and where.

---

## TEAM.md — Success Metrics > Phase 1 (Engine)

### 1. "All five DB tables migrated and tested locally"

**Verdict: PARTIALLY MET — with a corrected count, not a gap.**

The actual schema has **four** tables, not five: `workflows` (evolved from a
pre-existing legacy table, not created fresh), `workflow_executions`,
`workflow_step_executions`, `workflow_templates`, plus `workflow_approvals`
(referenced in TRACKER.md's "what already exists" list). That's five if you count
`workflow_approvals` — I read `20260603000018_workflows_v2.sql` and confirmed
`workflows`, `workflow_executions`, `workflow_step_executions`, `workflow_templates`
are defined there exactly as described. I did not find `workflow_approvals`'s DDL in
the file I was pointed to, so I'm not independently verifying its existence here — it's
referenced in TRACKER.md but outside my assigned reading list for this sign-off.

This is a **deliberate, documented architecture decision** (Priya's ADR,
`ADR_EXECUTION_ARCHITECTURE.md` §2.1), not an oversight: the team chose a 4-5 table
JSONB graph schema over TEAM.md's originally-specified 5-table normalized schema
(`workflow_conditions`, `workflow_actions` as separate tables) because a working
engine already existed before the design docs were written. I reviewed the ADR's
reasoning and find it sound — normalizing now would be a schema-purity rewrite of a
system that already passes tests, for no functional gain the JSONB columns don't
already provide.

**"Tested locally"** — I ran `nvm use 22 && npm test` myself in this session, not
just re-reading TRACKER.md's claim: **69 test files, 851 tests, all passing**,
matching TRACKER.md's number exactly. This exercises the schema indirectly (every
workflow test round-trips through mocked `query()` calls shaped like the real tables)
but is not the same as running the actual migration files against a live Postgres —
see item 4 below on why that's not possible in this sandbox.

### 2. "Bull queue processes 100 concurrent workflow trigger evaluations in < 5 seconds"

**Verdict: NOT VERIFIABLE IN THIS ENVIRONMENT — and the premise needs a correction.**

There is no BullMQ/Bull anywhere in this codebase (confirmed: ADR §2.2, and I did not
find a `bull` or `bullmq` dependency during review). This is an explicit, reasoned
architecture decision — Redis Streams + consumer groups instead, mirroring the
existing `eventEngine/processor.ts` pattern. I find the ADR's four stated reasons
(zero new dependency, consistency with existing precedent, shared monitoring surface,
no BullMQ-specific feature actually needed) credible engineering reasoning, not an
excuse — the workload (ordered-enough delivery, consumer groups, crash recovery via
XAUTOCLAIM) is what Streams consumer groups are for.

That said: **the 100-concurrent/<5s number itself has never been measured**, on Bull
or on Streams. I read `backend/src/__tests__/workflowQueue.test.js` directly — it unit
tests `backoffMs()` math, dead-letter transition at `MAX_ATTEMPTS`, and mocked-DB
retry-sweep behavior. It does not spin up Redis, does not publish 100 concurrent
triggers, and does not assert a wall-clock latency bound. I confirmed this sandbox has
no reachable Postgres or Redis (docker-compose defines both services, but `docker ps`
returns "permission denied while trying to connect to the docker API" — the daemon
socket is not accessible here) and there is no local `psql`/`redis-cli` binary
installed either. **I am not going to claim this metric passes because the queue
"should" be fast — it needs an actual load test against a running Redis instance,
which does not exist in this sandbox and was out of scope for me to provision.** This
is Kenji's mandate (reliability/chaos testing, Wave 1b) and his Grafana dashboard spec
is still marked "pending" in TRACKER.md — so even the team's own plan doesn't claim
this is measured yet.

### 3. "Zero failed test runs for threshold triggers across 20 test cases"

**Verdict: NOT MET, as literally specified — functionally covered, but not as a
20-case corpus.**

I read `workflowEngine.test.js` directly (`describe('evaluateConditions', ...)`,
`describe('executeAction', ...)`) looking for a labeled 20-case threshold-trigger
corpus. It does not exist as such. What exists instead: targeted unit tests for each
condition operator (`eq`, `neq`, `gt`, `lt`, `gte`, `lte`, `between`, `in`/`not_in`,
`AND`/`OR` combination, empty-conditions-pass) plus integration-style tests for
`runWorkflow`'s trigger→condition→action path (conditions pass / conditions fail).
Counting generously, I estimate 10-12 individual assertions genuinely exercise
threshold/condition logic — not the 20 TEAM.md calls for, and not organized as a
corpus a QA engineer could point to and say "here are our 20 cases, here's the pass
rate." This is a real gap, not a rounding error: TEAM.md's own Phase 3 metric (`>= 90%
precision on the 50-case Crystal signal test corpus`) implies the team's convention is
to build and name explicit numbered corpora for metrics like this, and Phase 1's
threshold-trigger corpus was never built to that standard.

**Recommendation:** this is a fast, cheap fix — assemble the existing condition-operator
tests plus ~8-10 new cases (boundary values: exactly-at-threshold, one-below,
one-above, string vs. numeric coercion edge cases per `compare()`) into an explicitly
named/counted corpus in `workflowEngine.test.js` or a new `workflowThresholds.test.js`.
I'd sign off on this criterion the moment that exists and passes — it does not require
new engine code, just test organization. I'm flagging it for Kenji (QA/Reliability,
Wave 1b) rather than writing it myself, since test authorship for someone else's
module is outside my scope here.

### 4. Bonus, TRACKER.md-only: "`npm test` (backend) still green — no regressions"

**Verdict: MET — verified live, not just re-read.**

I ran `nvm use 22 && npm test` myself in this session (not copying TRACKER.md's
number): **69 test files passed, 851 tests passed, 0 failed**, in 3.71s. This matches
TRACKER.md's claimed number exactly, which is a good sign the tracker's other
self-reported numbers are trustworthy — but I still verified the two most
consequential source-level claims independently rather than taking that as blanket
license to skip the rest of this review:

- **`runScheduledWorkflows` wiring claim** (ADR §2.5, TRACKER.md's "correction to
  earlier audit"): I grepped `eventEngine/processor.ts` directly and confirmed
  `cronTick` is a real `setInterval` at line 178 that calls
  `require('../lib/workflowEngine').runScheduledWorkflows()` at line 180, and is
  cleared on shutdown at line 201. The dead-code claim in the original audit was
  indeed stale; the correction is accurate.
- **HMAC-SHA256 webhook signing claim** (David's Wave 1 scope): I grepped
  `connectors.ts` and `workflowEngine.ts` directly and confirmed `signWebhookPayload`
  is defined in `connectors.ts`, imported into `workflowEngine.ts`, and applied at
  line 186 (`headers['X-Experient-Signature'] = 'sha256=' + signWebhookPayload(...)`),
  gated on a secret resolved from either `config.secret` or the org's vaulted webhook
  credential. This matches the claim exactly, including the precedence order
  documented in the ADR.
- **Migration column claim** (`workflow_executions` gets `idempotency_key`,
  `attempt_count`, `next_retry_at`, `dead_letter`): I read
  `20260701090000_workflow_async_queue.sql` directly and confirmed all four columns,
  the partial unique index on `idempotency_key`, and the two supporting partial
  indexes (`idx_wf_exec_due_retry`, `idx_wf_exec_dead_letter`) match the ADR's
  description exactly, column-for-column.

---

## TRACKER.md — "Phase 1 success criteria (from TEAM.md — must verify, not assume)"

This is the tracker's own restated checklist. Re-verified independently rather than
just checking the boxes the tracker already checked (it hadn't checked any — all four
were still `[ ]` at the time I read it):

- [x] **All DB tables migrated and tested locally** — PARTIALLY MET, see item 1 above
  (schema is real and tested-via-mocks; not independently run against a live Postgres
  in this sandbox; table count is 4-5 not literally 5 depending on whether
  `workflow_approvals` is counted, per a deliberate architecture change).
- [ ] **Async action queue handles concurrent trigger evaluations without lost
  executions** — NOT VERIFIABLE IN THIS ENVIRONMENT for the "handles concurrency"
  claim under real load (no Redis/Postgres reachable here). The **correctness**
  argument for why concurrent delivery shouldn't lose executions is real and
  code-reviewed: idempotency is enforced via a partial unique index
  (`uq_wf_exec_idempotency_key`) plus `INSERT ... ON CONFLICT DO NOTHING RETURNING id`
  in `runWorkflow` (I read this in the ADR §2.4 and it matches the migration's actual
  index definition), and `workflowEngine.test.js` has passing unit tests for the
  duplicate-insert-returns-null path. That is good evidence of **correctness under
  duplication**, which is a different and weaker claim than **"handles concurrency
  without lost executions" under actual concurrent load** — the latter needs a live
  test Kenji hasn't run yet (his reliability test suite is still "pending" in the
  tracker's Wave 1b row).
- [ ] **Zero failed test runs for threshold triggers across a real test corpus** — NOT
  MET as a named corpus; see item 3 above. Same gap, same recommendation.
- [x] **`npm test` (backend) still green — no regressions** — MET, verified live
  (see item 4 above).

---

## Overall sign-off verdict

**Phase 1 is substantially built and the engineering is sound, but I am not signing
off on it as fully "done" against the letter of TEAM.md's Phase 1 success metrics.**
Specifically:

- **What's genuinely done and well-built:** the async queue/retry/DLQ architecture,
  idempotency enforcement, Zendesk connector, HMAC-signed webhooks, per-org
  credentials vault, and the Workflow List UI are real, tested (851 passing tests,
  verified by me live in this session), and the two architecture corrections in the
  ADR (no 5th/6th normalized table, no BullMQ) are well-reasoned engineering
  decisions I agree with — not shortcuts dressed up as decisions.
- **What's not done, specifically:** (1) the 100-concurrent/<5s queue-throughput
  metric has never been measured against a live Redis/Postgres — it is an untested
  assumption, not a passing benchmark, and this sandbox cannot provision the
  infrastructure to measure it; (2) the "20 test cases" threshold-trigger corpus does
  not exist as a named, countable corpus — condition-operator coverage exists but
  isn't organized to that standard; (3) Kenji's reliability test suite and Grafana
  dashboard spec (which would close both gaps above) are still marked "pending" in
  Wave 1b, so even the team's own plan doesn't claim these are closed yet.
- **My call:** treat Wave 1 (Priya/David/Elias) as **shipped and code-sound**, but do
  not mark the **Phase 1 gate itself** closed until Kenji's Wave 1b reliability suite
  either produces the 20-case threshold corpus and a real concurrency test, or
  explicitly documents why those specific numbers are being waived/redefined. I would
  not want a future reader of this doc to see "Phase 1: done" and assume the 100
  concurrent/<5s number was ever actually measured — it wasn't, by anyone, yet.

This is not a rubber stamp: two of four TEAM.md Phase 1 metrics are not met as
literally written, and I'm naming them precisely rather than rounding up because the
code quality elsewhere is high.

---

## Template gallery (my own Wave 1b deliverable)

Seeded 5 additional workflow templates beyond the original 3
(`nps-recovery`, `weekly-digest`, `verbatim-escalation`) via
`supabase/migrations/20260701090200_workflow_templates_phase1_expansion.sql`:
`nps-win-celebration`, `survey-milestone-kickoff`, `slow-completion-flag`,
`critical-alert-to-zendesk`, `anomaly-to-jira`. Full rationale for each in
`docs/automation-hub/TEMPLATE_GALLERY.md`, including four template ideas from
`WORKFLOW_SYSTEM.md`'s original 15-template list that I deliberately did **not**
build because they require a trigger/action that doesn't exist in
`workflowRegistry.ts` yet (`crystal.topic_emerged`, `survey.expiring_soon`,
`crystal.prediction_alert`, a PagerDuty connector) — flagged there as gaps for Amara's
Wave 3 AI-trigger work or a future integrations wave, not built against a registry
that doesn't support them.

**Migration verification:** I do not have a reachable local Postgres in this sandbox
(`docker ps` fails with a permission-denied on the Docker daemon socket; no local
`psql`/`postgres` binary is installed) — so I could not execute this migration against
a real database. What I did instead, as a substitute for execution:
- Verified the `INSERT INTO workflow_templates (...)` column list matches the table's
  actual 8 relevant columns (`slug, name, description, category, trigger_type, nodes,
  edges, is_featured`) exactly, column-for-column, against
  `20260603000018_workflows_v2.sql`'s own `CREATE TABLE`/`INSERT` — same shape as the
  original 3-template seed, including the `ON CONFLICT (slug) DO NOTHING` idempotency
  clause.
- Parsed every `nodes`/`edges` JSON literal (10 total across 5 templates) with
  `json.loads()` to confirm they are syntactically valid JSON before Postgres would
  ever see them.
- Cross-checked every `trigger`/`action`/condition `field` string used in the 5
  templates against the live `TRIGGERS`, `ACTIONS`, and `CONDITION_FIELDS` arrays in
  `backend/src/lib/workflowRegistry.ts` — all match exactly (`score.nps_rise`,
  `survey.milestone_reached`, `survey.response_received`, `alert.fired`,
  `crystal.anomaly_detected` as triggers; `completion_time`/`severity` as condition
  fields; `notify.slack`, `notify.in_app`, `crystal.summarize`, `crystal.classify`,
  `data.tag_responses`, `zendesk.create_ticket`, `jira.create_issue`, `notify.email`
  as actions).
- Confirmed, by reading `workflowEngine.ts`'s condition-evaluation call sites
  directly, that condition nodes only see `{...ctx.event, ...ctx.event.payload}` — not
  `ctx.vars` set by a prior action. This mattered for the `critical-alert-to-zendesk`
  template: I originally considered gating the condition on `crystal.classify`'s
  output severity, then caught (by reading the code, not assuming) that this would
  silently never fire, and restructured the template to condition on the real event's
  `severity` field first, using `crystal.classify` only to enrich the downstream
  message via `{{crystalSeverity}}` templating (which does see `ctx.vars`).

**Bottom line on the migration: reviewed and cross-checked against the schema and the
registry, but unexecuted.** I'm not claiming it's proven to apply cleanly — only that
I found no syntax error, no column mismatch, and no reference to a
trigger/condition-field/action that doesn't exist today.
