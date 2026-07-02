# Xperiq Actions — XM Scenario Verification Report

**Author:** Kenji Watanabe, Staff Engineer, Workflow Reliability & Testing
**Input:** `docs/automation-hub/XM_INDUSTRY_SCENARIOS.md` (Maya Okonkwo's 16-scenario
audit + priority list)
**Method:** Every finding below is verified against a REAL passing/failing test
(`backend/src/__tests__/xmScenarioVerification.test.js`, 25 new tests) plus direct
citation of the exact source lines. Nothing here is re-asserted from Maya's doc without
independent verification — several places below either strengthen, narrow, or correct
her claims based on what the tests and a fresh grep sweep actually showed.

**Baseline (verified, not assumed):** `PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npm test`
→ **77 files / 981 tests passing** before this pass (matches Wave 6's tracker entry
exactly — confirmed independently, not trusted from memory).

**Final (after this pass):** **78 files / 1006 tests passing** (net +1 file / +25
tests, zero regressions, zero pre-existing tests modified).

---

## Verdict summary

| # | Finding | Verdict |
|---|---|---|
| 1 | Manager-effectiveness misdirection (Scenario 10) | **CONFIRMED — serious, needs product decision** |
| 2 | `survey.milestone` vs `survey.milestone_reached` + no-producer list | **CONFIRMED**, plus one correction to Maya's producer list (see below) |
| 3 | `data.tag_responses` fake persistence | **CONFIRMED BUG** |
| 4 | Jira missing priority field | **CONFIRMED BUG** |
| 5 | `time.schedule` carries no survey/tag context | **CONFIRMED BUG** (structural, affects every scheduled digest template) |
| 6 | Content-customization toggle not enforced at send time | **CONFIRMED BUG** |
| 7 | Tag-scoped cooldown shared clock | **CONFIRMED design limitation** (not an emergency fix) |
| 8 | Concurrent edit-while-executing | **NOT CONFIRMED as broken** — both sub-concerns check out correctly |
| 9 | Multiple overlapping workflows, one slow/failing | **NOT CONFIRMED as broken** — works correctly, but Maya's "sequential, not parallel" observation is also confirmed true |

---

## Priority 1 — Manager-effectiveness misdirection (Scenario 10)

**Verdict: CONFIRMED. This is real and exactly as dangerous as Maya describes.**

**Test:** `xmScenarioVerification.test.js` → `Priority 1 — notify.email silent
fallback to event.userId (Scenario 10)` → `CONFIRMED BUG: an unset config.userId
silently addresses the email to event.userId...` — **PASSES**, meaning the dangerous
behavior is real and reproducible.

**Evidence:** `backend/src/lib/workflowEngine.ts:186`:
```ts
case 'notify.email': {
  const r = await sendEmail(ctx.orgId, (config.userId as string | undefined) || ctx.event.userId || '', {
```
With `config.userId` unset and `ctx.event.userId` set to a manager's id, `sendEmail`
is called with that manager's id as the recipient, and the action returns
`status: 'completed'` — indistinguishable in the execution log from a correctly
configured run. `notify.slack` (line 175) has the analogous shape: `ctx.event.userId`
flows straight into `sendSlack`'s recipient param with no config-level override
concept at all (there is no `config.channel`/`config.userId` read in the Slack case —
Slack's actual delivery target is an org-wide webhook URL looked up from
`notification_channels`, but the `userId` passed through still ends up in the
Slack message context and any downstream per-user routing).

I confirmed by direct reading (not assumption) that Maya's structural claim is
correct: there is **no** org-chart/reporting-relationship concept anywhere in
`workflowEngine.ts`, `channels.ts`, or `connectors.ts` — grepped for `manager`,
`reports_to`, `org_chart`, `subject` — nothing. The system genuinely cannot ask "is
this recipient the subject of this event" because no data model expresses that
question. This matches Maya's "Scenarios explicitly NOT achievable today, item 6"
finding exactly.

### My recommendation (evaluation only — not implementing)

**Yes: `notify.email` and `notify.slack` should require an explicit
`config.userId`/`config.channel` and refuse to silently fall back to
`event.userId`/a default channel when unset.** Reasoning:

- The fallback exists for convenience (fewer required config fields in the interim
  generic editors from Wave 5), but it converts a *missing* configuration value into
  a *silent, plausible-looking* one. A missing required field should fail loud
  (`status: 'skipped', reason: 'no_recipient_configured'` or a save-time validation
  error), not fail by guessing.
- This is cheap and scoped: it does not require the org-chart/sensitivity data model
  Maya correctly identifies as absent (item 6 in her "not achievable" list). It only
  removes a fallback path, it does not add a new capability.
- It does not fully solve Scenario 10 — an author who explicitly (if mistakenly)
  types the manager's own id into `config.userId` is still unprotected, and that
  requires the org-chart/sensitivity concept Maya named as future work. But it
  closes the *specific* misconfiguration she asked me to construct (empty
  `config.userId` + event carrying the subject's id) at near-zero cost and with no
  data-model prerequisite.
- Backward-compat note: this would be a breaking change for any workflow that
  currently relies on the fallback intentionally (e.g., "notify the response's own
  submitter" patterns, if any exist). I did not find such a template in
  `TEMPLATE_GALLERY.md` relying on this fallback, but whoever implements this should
  grep seeded templates for `notify.email`/`notify.slack` nodes with no
  `config.userId` before flipping this to hard-fail, to avoid silently breaking a
  currently-working (if accidentally-so) template.

**Recommendation: implement the fallback removal as a fast-follow, but it is not a
substitute for the real fix (org-chart-aware / sensitivity-classified recipient
resolution), which is a product/data-model decision outside this task's scope.**

---

## Priority 2 — `survey.milestone_reached` vs `survey.milestone`, and the full no-producer trigger map

**Verdict: CONFIRMED — the exact string mismatch Maya flagged is real.** Plus **one
correction to her producer list**: `external.webhook` is NOT a confirmed
live-producer trigger — I found no route anywhere in the backend that publishes it.

**Test:** `Priority 2 — ... string mismatch` → `CONFIRMED BUG: a workflow built on
the registry's survey.milestone_reached trigger type never matches an event
published as survey.milestone` — **PASSES**. A companion "control" test proves the
engine's matching logic itself is not broken — it's purely a string-literal mismatch
between the registry and the one real producer.

**Evidence — the mismatch itself:**
- `backend/src/lib/workflowRegistry.ts:27`: `{ type: 'survey.milestone_reached', ... }`
- `backend/src/routes/responses.ts:33`: `await publishNotificationEvent({ type: 'survey.milestone', orgId, ... })`
- `backend/src/lib/workflowEngine.ts:713-716`: `runWorkflowsForEvent`'s SQL does
  `WHERE org_id = $1 AND trigger_type = $2` — an **exact string match**, confirmed by
  reading the query directly, not inferred.

These are two different strings. A workflow saved with `trigger_type =
'survey.milestone_reached'` (the only value the builder UI can produce, since that's
the registry's trigger `type`) will never be returned by this query when
`routes/responses.ts` publishes `'survey.milestone'`. **Second pair of eyes
confirms Maya's finding exactly as she described it — no correction needed on this
specific claim.**

**Evidence — full producer-to-trigger-type map**, built by grepping every call site
of `runWorkflowsForEvent(`, `publishWorkflowTrigger(`, and `publishNotificationEvent(`
across the entire backend (not just the files Maya cited):

| Registry trigger type | Producer found? | Producer location | Notes |
|---|---|---|---|
| `alert.fired` | **YES — live** | `alertEngine.ts:139-145` (`fireAlert`) | Carries `payload.surveyId` |
| `time.schedule` | **YES — live** | `runScheduledWorkflows` (cron-swept every minute via `eventEngine/processor.ts`) | Carries no survey/tag data — see Priority 5 |
| `crystal.sentiment_spike` | **YES — live** | `internal-workflows.ts:46-73` (`SIGNAL_TO_TRIGGER_TYPE` map) | From CrystalOS `workflow_signal` |
| `crystal.new_theme_detected` | **YES — live** | same as above | |
| `crystal.anomaly_detected` | **YES — live** | same as above | |
| `survey.milestone_reached` | **NO — mismatched producer, not truly no-producer** | `routes/responses.ts:33` publishes `'survey.milestone'` instead | The real, reproducible bug — see above |
| `survey.response_received` | **NO producer anywhere** | — | Confirmed by full-repo grep, matches Maya |
| `survey.response_filtered` | **NO producer anywhere** | — | Confirmed by full-repo grep, matches Maya |
| `score.nps_drop` | **NO producer anywhere** | — | `evalNpsDrop` in `alertEngine.ts` computes this but files it under `alert.fired`, not a distinct `score.nps_drop` event — confirmed by grep, matches Maya |
| `score.nps_rise` | **NO producer anywhere** | — | Same as above (`evalNpsRise`) — matches Maya |
| `crystal.insight_ready` | **NO producer anywhere** | — | **Correction/resolution of Maya's "unconfirmed" flag**: I checked `internal-workflows.ts`'s `SIGNAL_TO_TRIGGER_TYPE` map directly — it only has `sentiment_spike`/`new_theme_detected`/`anomaly_detected`, no `insight_ready` entry, and no other file publishes it. This should move from "unconfirmed" to **confirmed no-producer**, same bucket as the other 5. |
| `crystal.verbatim_escalation` | **NO producer anywhere** | — | Confirmed by full-repo grep, matches Maya |
| `external.webhook` | **NO producer anywhere — CORRECTION to Maya's brief** | — | Maya's brief lists this as a "confirmed live-producer trigger... via the inbound webhook route." I grepped every route file for `runWorkflowsForEvent(` and `publishWorkflowTrigger(` calls — **`internal-workflows.ts` is the only call site of either function in the entire `src/routes/` tree.** `src/routes/prismWebhooks.ts`, `src/routes/contact-sync.ts` (which does have an inbound `/webhook/:configId` POST route), and `src/routes/webhooks/{clerk,stripe}.ts` — none of them call into the workflow trigger machinery at all. Unless there's a producer I'm missing outside `src/routes/` (I did not find one in `src/lib/` or `src/eventEngine/` either), **`external.webhook` should be added to the no-producer list, not the confirmed-live list.** |

**Net result: 8 of 13 registry triggers have no working producer today** (6
no-producer + `survey.milestone_reached`'s mismatch + the `external.webhook`
correction), not 6 as stated in Maya's summary. This is worse than her count, not
better — worth flagging plainly.

### My recommendation on the rename

**Rename the registry entry to match the producer (`survey.milestone` — NOT the other
way around).** Reasoning: `routes/responses.ts::maybeEmitResponseMilestone` is a
real, working, tested code path with actual thresholds and actual delivery.
`survey.milestone_reached` is a registry label with zero backing implementation to
change. Renaming the registry string is a one-line change
(`workflowRegistry.ts:27`) plus updating any seeded template that references it (I
did not find one in `TEMPLATE_GALLERY.md` referencing `survey.milestone_reached` by
name — worth a final grep before executing the rename, since Maya's own doc flags
`TEMPLATE_GALLERY.md` seeds as "reviewed against schema + registry but unexecuted").
Renaming the producer instead would require touching `routes/responses.ts` (a live,
already-shipped code path) for no functional gain. **This is a one-line, low-risk
fix** — flagging as trivial per the task's guidance, but not implementing it myself
per the QA-role boundary.

---

## Priority 3 — `data.tag_responses` fake persistence

**Verdict: CONFIRMED BUG.**

**Test:** `Priority 3 — data.tag_responses does not persist anything` →
`CONFIRMED BUG: executeAction returns status "completed" ... without issuing any
UPDATE/INSERT query` — **PASSES**.

**Evidence:** `backend/src/lib/workflowEngine.ts:215-218`:
```ts
case 'data.tag_responses': {
  if (!ctx.event.responseId || !config.tag) return { status: 'skipped', output: { reason: 'missing_target' } };
  return { status: 'completed', output: { tagged: ctx.event.responseId, tag: config.tag } };
}
```
There is no `query(...)` call anywhere in this case — confirmed both by direct
reading and by the test asserting `dbQuery` (the injected mock) is never called at
all when this action runs.

**No pre-existing "real" tagging mechanism exists to delegate to.** I confirmed via
research (both my own grep and a dedicated research pass): the `responses` table
has no `tags`/`tag_ids` column in any migration, there is no `response_tags` table,
and no route anywhere performs manual response tagging. `survey_tags` /
`survey_tag_mappings` exist but tag **surveys**, not individual **responses** — a
different concept entirely (this is the Program/tag-scoping mechanism Wave 6 built
for workflow scope, unrelated to marketing "tag this specific response" tagging).

**This is worse than an honest stub**, exactly as Maya says: the registry marks
`data.tag_responses` as `live: true` (confirmed, `workflowRegistry.ts:67`, and it's
in the `LIVE_ACTIONS` set at `workflowEngine.ts:146`), so the builder UI's
readiness indicator actively lies to the user about this action's completeness.

**Confirmed bug, needs a fix — not implementing myself.** A real fix needs: (a) a
`response_tags` table or a `tags TEXT[]`/JSONB column on `responses`, and (b) an
actual `UPDATE`/`INSERT` in this case. Until that data model exists, the
**cheapest correct interim fix** is to mark this action `live: false` (or `'stub'`)
in the registry so the UI stops overclaiming — a one-line change with no schema
work, immediately available if the team wants to de-risk the misleading label before
the real persistence work is scheduled.

---

## Priority 4 — Jira missing priority field

**Verdict: CONFIRMED BUG.**

**Tests:** `Priority 4 — jiraCreateIssue has no priority field...` — 3 tests, all
**PASS**: the Jira test proves `config.priority` is silently dropped from the
request body entirely (not even present as a differently-named field), and the two
contrast tests prove Zendesk and ServiceNow both do the right thing.

**Evidence — Jira** (`backend/src/lib/connectors.ts:56-91`, request body at
lines 72-79):
```ts
body: JSON.stringify({
  fields: {
    project: { key: projectKey },
    summary: config.summary || ctx.event.title || 'Experient workflow',
    description: config.description || ctx.event.body || '',
    issuetype: { name: config.issueType || 'Task' },
  },
}),
```
No `priority` key anywhere in `fields`, no read of `config.priority` anywhere in the
function. Confirmed directly by intercepting the real `fetch` call in the test: the
captured body has no `priority` property and does not even contain the string
`"urgent"` that was passed in `config.priority`.

**Evidence — contrast, Zendesk** (`connectors.ts:181`):
```ts
priority: config.priority || (ctx.event.severity === 'critical' ? 'urgent' : 'normal'),
```
**Evidence — contrast, ServiceNow** (`connectors.ts:141`):
```ts
urgency: config.urgency || (ctx.event.severity === 'critical' ? '1' : '3'),
```
Both connectors correctly read a config override with a severity-based default.
Jira has neither. This is a genuine, verified capability gap — a customer building
Scenario 4 (SLA escalation with priority routing) on Jira instead of Zendesk cannot
express priority at all today, exactly as Maya predicted, and I confirmed by
literally intercepting the outbound HTTP payload rather than trusting the source
read alone.

**Confirmed bug, needs a fix — not implementing myself.** The fix is small and
low-risk: add `priority: { name: config.priority || (severity-based default) }`
to the `fields` object (Jira's REST API v3 expects `fields.priority.name`, a
different shape than Zendesk/ServiceNow's flat string — whoever implements this
should confirm the exact Jira priority scheme name values, e.g. `Highest`/`High`/
`Medium`/`Low`/`Lowest`, against the target Jira instance's actual priority scheme,
since Jira priority names are configurable per-instance unlike Zendesk's fixed
enum).

---

## Priority 5 — `time.schedule` events carry no survey/tag context

**Verdict: CONFIRMED BUG — structural, affects every scheduled digest template.**

**Test:** `Priority 5 — ... crystal.summarize has nothing real to summarize` →
`CONFIRMED BUG: a tag-scoped scheduled workflow's crystal.summarize action produces
the generic fallback string, not survey-specific content` — **PASSES**.

**Evidence:** `backend/src/lib/workflowEngine.ts:780` (inside
`runScheduledWorkflows`):
```ts
const result = await runWorkflow(wf, { type: 'time.schedule', scheduledAt: now.toISOString() }, { orgId: wf.org_id });
```
I reproduced this exactly: constructed a `scope_type: 'tag'` scheduled workflow with
a matching cron, ran `runScheduledWorkflows`, and inspected the literal
`trigger_payload` written to the `workflow_executions` row (i.e., exactly the
`ctx.event` any action in that run would see). It is precisely
`{ type: 'time.schedule', scheduledAt: '<iso>' }` — no `surveyId`, no `tagId`, no
metric data, confirmed by `toEqual` on the full object, not a partial match.

Running `crystal.summarize` against that exact event produces
`"Crystal summary: event received."` — the generic fallback string
(`connectors.ts:222`, `bits.length ? ... : 'Crystal summary: event received.'`). A
control test in the same block proves `crystal.summarize` DOES produce real content
(`"Crystal summary: Q3 CSAT Program · NPS 42 · positive sentiment."`-shaped output)
when the event actually carries `title`/`nps`/`sentiment` fields — proving this is
specifically a **data-fetch gap between "cron fired" and "here's what to
summarize,"** not a defect in `crystal.summarize` itself.

**This confirms Maya's structural claim exactly**: every scheduled, tag-scoped or
survey-scoped digest template (Scenarios 2 and 9, and any future one) is affected
by the same root cause, since `runScheduledWorkflows` never resolves
`scope_tag_id`/`scope_survey_id` into actual survey/metric data before calling
`runWorkflow`. The workflow "fires" (execution row shows `completed`), the email/
Slack message sends, but the content is functionally empty for anything beyond a
literal, workflow-author-typed static string in `config.body`.

**Confirmed bug, needs a fix — not implementing myself, and this one is NOT
trivial** (unlike Priorities 2-4). A real fix requires: resolving the workflow's
`scope_tag_id`/`scope_survey_id` to actual survey ids, querying recent
responses/metrics for those surveys, and injecting that into the event before
`runWorkflow` is called (or into `ctx.vars` before `crystal.summarize` runs). This
is meaningfully more work than a one-line change and should be scoped as its own
task, not bundled with Priorities 2-4.

---

## Priority 6 — Content-customization toggle enforcement

**Verdict: CONFIRMED BUG — the toggle is decorative at send-time. Compliance-relevant.**

**Tests:** `Priority 6 — ContentCustomizationPanel's config.sections.crystalSummary
is never read by executeAction's notify.slack/notify.email` — 2 tests, both
**PASS**, proving the toggle has zero effect on the real outbound payload.

**Evidence — the exact config shape the frontend writes** (confirmed via research,
not assumed): `app/src/components/workflow-builder/sentence/ContentCustomizationPanel.tsx`
writes to `config.sections.crystalSummary` (boolean), per
`app/src/components/workflow-builder/sentence/contentSections.ts`'s
`ActionContentConfig`/`SectionState` interfaces. This is exactly the field/shape
that reaches the backend's action node `config` — confirmed by
`app/src/__tests__/pages/WorkflowBuilderPage.test.tsx:414-416` asserting
`slackNode.config.sections.crystalSummary === false` after saving.

**Evidence — the backend never reads it.** I grepped the entire `backend/src/`
tree for `sections`, `crystalSummary`, and `contentSections` — the only backend hit
for `crystalSummary` is `connectors.ts:223`'s **output** var
(`vars: { crystalSummary: summary }`, i.e., what `crystal.summarize` *produces*),
never a **read** of `config.sections.crystalSummary` anywhere in `executeAction`'s
`notify.email`/`notify.slack` cases (`workflowEngine.ts:174-193`). Those two cases
only ever read `config.title`/`config.subject`/`config.body` and pass them through
`render()` — a flat `{{var}}` template substitution with no awareness of
`config.sections` at all.

**I proved this concretely, not just by absence-of-a-read:** the test constructs a
`notify.slack` action with `config.sections.crystalSummary = false` AND
`config.body = '{{crystalSummary}}'` AND `ctx.vars.crystalSummary` populated (as a
prior `crystal.summarize` step would set it) — the rendered Slack body **still
contains the Crystal-generated text**, because `render()` has no branch that checks
`config.sections` before substituting `{{crystalSummary}}`. A second test proves
byte-identical output whether the toggle is `true` or `false` — the strongest
possible proof the toggle is inert at send time.

**This is exactly the "looks fine in a demo, fails in production for a
compliance-sensitive customer" gap Maya named.** The persisted config genuinely says
"off," the builder's live preview genuinely honors "off" (per Wave 6's tracker
entry — frontend-only, not verified by me in this pass), but the **real** outbound
Slack/email payload does not consult that field at all. A zero-AI-content compliance
workflow (Scenario 16) that unchecks "Crystal AI Summary" but still has
`{{crystalSummary}}` (or any Crystal-derived var) in its body template will leak
Crystal-generated text externally, with the persisted config actively lying about
what was sent.

**Confirmed bug, needs a fix — not implementing myself.** The real fix belongs in
`executeAction`'s `notify.email`/`notify.slack` cases (or in `render()`): before
substituting `{{crystalSummary}}` (or any section-gated var), check
`config.sections?.crystalSummary !== false` and blank the substitution if the
section is explicitly off. This also needs the reverse case checked (a body that
doesn't use `{{crystalSummary}}` but the workflow's template-default body
unconditionally appends a summary block) — I did not find evidence of a
template-default summary block being appended server-side (the default bodies in
`executeAction` are `ctx.event.title`/empty string, not a Crystal summary), so the
leak vector I proved (an explicit `{{crystalSummary}}` in `config.body`) may be the
only one, but whoever fixes this should verify there's no other code path that
injects `ctx.vars.crystalSummary` into a message regardless of the section toggle.

---

## Priority 7 — Tag-scoped cooldown shared clock

**Verdict: CONFIRMED design limitation.** Real, but assessed below as narrower in
practice than it might first sound — not an emergency fix.

**Tests:** `Priority 7 — cooldown_last_fired_at is a single per-workflow clock with
no per-entity dimension` — 3 tests, all **PASS**, including the exact
two-different-accounts reproduction Maya asked for.

**Evidence:** `backend/src/lib/workflowEngine.ts:486-508` (the cooldown gate inside
`runWorkflow`) keys entirely off `workflow.cooldown_last_fired_at` — a single column
on the `workflows` row (migration `20260701100000_workflow_cooldown.sql`). There is
no `entityId`/`respondentId`/account dimension anywhere in the cooldown check or in
`finalizeExecution`'s stamp (`workflowEngine.ts:401-407`,
`cooldown_last_fired_at = CASE WHEN $4 THEN NOW() ELSE cooldown_last_fired_at END`
— unconditional on the workflow row, regardless of which entity's event caused the
fire).

I reproduced the exact scenario: Account A's event fires a tag-scoped,
cooldown-set workflow (`status: 'completed'`), which stamps
`cooldown_last_fired_at`. Account B's event — a genuinely independent respondent,
matching the same tag-scoped workflow moments later — is then suppressed
(`status: 'cooldown'`) purely because it hit the same workflow row's clock. This
is a real, reproducible false-negative: a legitimate, independent signal is
silently dropped (recorded as `'cooldown'`, not lost without a trace, but never
delivered to anyone).

**Contrast confirmed:** `alertEngine.ts`'s dedup key
(`alert:dedup:{orgId}:{ruleId}:{entityId||'org'}:{windowKey}`, `alertEngine.ts:70`)
does include `entityId` — the alert layer solved the sharper version of this problem
that the workflow cooldown layer did not inherit, exactly as Maya observed.

**Severity assessment (as requested):** This only manifests when **both**
conditions hold: (a) `scope_type = 'tag'` (or theoretically `'org'`, though an
org-wide cooldown-set workflow has the same issue at an even larger blast radius —
confirmed by a third test), **and** (b) `cooldown_minutes` is set on that workflow.
A `scope_type = 'survey'` workflow has the identical mechanism (no entity
awareness), but its blast radius is naturally bounded to one survey's respondents,
which is a materially smaller and more plausible-to-overlook-as-acceptable
population than "every account across every survey under a Renewal tag." I assess
this as: **real, worth a tracked follow-up, not an emergency** — it requires
tag-scoped + cooldown-set workflows specifically to be a live pattern in an org's
template usage, which is plausible (Scenario 6 is exactly this) but not the
majority default case (most seeded templates use cooldown 0/none per
`TEMPLATE_GALLERY.md`, per Maya's own scenario notes).

**Not fixing — flagging as a design limitation for a follow-up ticket**, per the
task's framing ("assess how bad it is," not "fix it now"). A real fix would need a
per-entity cooldown key (e.g., keyed by `resolveEventSurveyId`'s survey id, or an
`entityId` extracted from the event) analogous to `alertEngine`'s dedup key —
non-trivial schema/logic work, reasonably scoped as its own task.

---

## Priority 8 — Concurrent edit-while-executing

**Verdict: NOT CONFIRMED as broken.** Both of Maya's specific concerns check out
correctly under direct inspection and test.

**Tests:** `Priority 8 — concurrent edit-while-executing...` — 3 tests, all **PASS**,
confirming CORRECT (not buggy) behavior on both sub-questions.

**Sub-question 1 — does an in-flight execution complete against a consistent
snapshot, not a corrupted mix?** Confirmed correct by construction: `runWorkflow`
(`workflowEngine.ts:474`) takes the entire `workflow` object (including `nodes`/
`edges`) as a plain in-memory argument, passed in by its caller
(`runWorkflowsForEvent`, which already `SELECT *`'d the row before this call began).
There is no re-fetch of the `workflows` row anywhere inside `runWorkflow`,
`runNodes`, or `runGraph` — the node/edge graph an execution runs against is fixed
at the moment `runWorkflow` is invoked, by ordinary JavaScript closure semantics,
not because of any explicit locking or snapshotting logic. A concurrent `PUT`
mutates the **database row**; it cannot retroactively change an already-in-flight
call's already-captured `workflow.nodes` argument. I confirmed this structurally
(there's no code path that could do otherwise) rather than via a true multi-process
race, since this codebase's execution model doesn't have a re-fetch point to race
against in the first place — the risk Maya's brief worried about (a save landing
mid-execution and corrupting the running graph) is not structurally possible given
how `runWorkflow` receives its arguments.

**Sub-question 2 — does a partial PUT that omits scope fields null out existing
scope?** Confirmed correct by direct reading of `routes/workflows.ts:212-216`:
```ts
if (scopeType !== undefined) {
  sets.push(`scope_type = $${i++}`);       vals.push(scopeType);
  sets.push(`scope_survey_id = $${i++}`);  vals.push(scopeSurveyId || null);
  sets.push(`scope_tag_id = $${i++}`);     vals.push(scopeTagId || null);
}
```
Scope columns are only added to the dynamic `SET` list **at all** when `scopeType`
is present in the request body — the same `if (x !== undefined)` pattern already
used for every other optional field in this handler
(`name`/`condition`/`action`/`description`/`triggerType`/`nodes`/`edges`/
`cooldown_minutes`, all at lines 191-205). A PUT that touches `name`/`nodes` but
never mentions `scopeType`/`scopeSurveyId`/`scopeTagId` produces a `SET` clause with
no `scope_*` columns in it whatsoever — the existing values are left completely
untouched by Postgres (a column not named in `SET` is never written). This is
already the correct, documented behavior (Wave 6's Nina notes: "Update requires
`scopeType` explicitly whenever either id field is touched (no silent guessing on a
partial PATCH)") and I reproduced the exact SET-list-construction logic in a test
to confirm the omission case never contains any scope column, and the touching case
always writes all three atomically together (never a half-updated scope pair).

**No bug found. No regression test needed to "catch" anything — the 2 tests written
here serve as permanent regression coverage for this already-correct behavior**,
which is good practice regardless (this exact class of bug — a partial update
nulling untouched fields — is common enough to be worth guarding permanently, even
absent a live incident).

---

## Priority 9 — Multiple overlapping workflows, one slow/failing

**Verdict: NOT CONFIRMED as broken — the reliability property holds.** Maya's
secondary observation (sequential, not parallel) is also independently confirmed
true, and is worth keeping on the radar as volume grows, though it is not itself a
correctness bug.

**Tests:** `Priority 9 — a hung/slow action...` — 3 tests, all **PASS**.

**Sub-question 1 — does a hard failure in workflow A prevent workflow B from
completing?** Confirmed NOT — this works correctly. `runWorkflowsForEvent`'s
`for...of` loop (`workflowEngine.ts:742-753`) wraps each workflow's `runWorkflow`
call in its own `try { ... } catch { /* one workflow's failure must not abort the
rest */ }`. I constructed two org-scoped workflows sharing `alert.fired`, made the
first workflow's Slack send throw (simulating a hung/failed connector), and
confirmed: **both** workflows produce a `workflow_executions` row (2 results
returned), the failing one is correctly recorded `status: 'failed'` (not silently
dropped, not left in a stuck state), and the healthy sibling completes normally
with `status: 'completed'`.

**Sub-question 2 — is the loop parallelized (Maya's secondary, lower-stakes
concern)?** Confirmed: **NO, it is not** — this matches Maya's own reading exactly,
re-verified independently. I proved this with a real concurrency test: workflow A's
action is made to hang on an unresolved promise; the test asserts that workflow B's
action has **not started** while A is still pending (`order` array shows only
`'A-start'`), and only proceeds to `'B-start'` after A's promise is explicitly
released. This is not a timing/flakiness inference — it's a hard proof that
`runWorkflowsForEvent` awaits each workflow's full execution before starting the
next.

**Severity assessment:** For 2 workflows sharing a trigger, this is a minor latency
concern (as Maya says) bounded by `CONNECTOR_FETCH_TIMEOUT_MS` (confirmed = 10,000ms
via direct import, env-overridable via `WORKFLOW_CONNECTOR_TIMEOUT_MS`) per slow
action — worst case, a survey with N overlapping workflows sharing a trigger and
each hitting a hung external connector serializes to up to `N × 10s` before the
last one starts. This is not a correctness bug (no data loss, no cross-contamination
between workflows, every workflow still gets its own execution row and outcome) —
it is a scalability/latency characteristic worth tracking as workflow density per
trigger grows, but does not need an urgent fix at today's usage levels. Parallelizing
via `Promise.all` is a reasonable future optimization, not a "confirmed bug."

---

## New regression tests

**File:** `backend/src/__tests__/xmScenarioVerification.test.js` — 25 new tests, one
`describe` block per priority (1 through 9), each with the primary bug-proving
assertion plus at least one contrast/control test to isolate the specific claim
being verified (so a future fix has a clear red→green target without accidentally
also breaking the contrast case).

**Test counts:**
- Before this pass: **77 files / 981 tests passing** (verified via `npm test`,
  matches the tracker's own Wave 6 entry exactly)
- After this pass: **78 files / 1006 tests passing** (net +1 file / +25 tests,
  zero regressions, zero modifications to any pre-existing test)
- Isolated run of the new file: `npx vitest run src/__tests__/xmScenarioVerification.test.js`
  → 25/25 passing

Two implementation notes on the new tests, for whoever picks up the fixes:
- Tests that assert **buggy** behavior (Priorities 1, 2, 3, 4, 5, 6) are
  intentionally written so they currently **PASS while proving the bug exists**.
  When a fix lands, the corresponding assertion should be **flipped** (e.g.,
  Priority 4's Jira test should start asserting `capturedBody.fields.priority`
  IS present, not absent) — these are the regression tests a fix should turn red
  first, then green after the flip.
- Priority 5's cron-matching test builds "now" via local-time field construction
  (next Monday at 09:00 local) rather than a fixed UTC ISO string, because
  `cron.ts::cronMatches` reads `date.getHours()/getMinutes()/getDay()` — all
  local-time getters, not UTC. A fixed UTC timestamp is timezone-sensitive and
  would silently fail in a different CI/dev machine timezone; this is a general
  gotcha worth remembering for any future test that constructs a "now" against
  `cronMatches`.

---

## What needs fixing, in priority order (for the orchestrator to dispatch)

1. **Priority 2 — rename `workflowRegistry.ts`'s `survey.milestone_reached` to
   `survey.milestone`** (match the real producer). One-line change + a check of
   seeded templates for the old string. Trivial, high-value, unblocks Scenario 5 and
   the "milestone" half of Scenario 11.
2. **Priority 2 (follow-up) — also add `crystal.insight_ready` and
   `external.webhook` to the documented no-producer list** (or build their
   producers, or remove them from the registry if truly unplanned) — a
   documentation/decision task, not necessarily a code fix, but the current state
   (customers can select these in the builder with zero warning) should not persist
   silently.
3. **Priority 4 — add a `priority`/`fields.priority.name` field to
   `jiraCreateIssue`**, mirroring Zendesk/ServiceNow's `config.X || severity-based
   default` pattern. Small, low-risk, needs confirmation of the target Jira
   instance's priority scheme names.
4. **Priority 3 — either build real response-tag persistence for
   `data.tag_responses`, or immediately relabel it `live: false`/`'stub'` in the
   registry** to stop the builder UI from overclaiming. The relabel is a one-line
   stopgap if the real persistence work isn't scheduled soon.
5. **Priority 1 — remove the silent `config.userId`/`event.userId` fallback in
   `notify.email` (and the analogous unguarded pass-through in `notify.slack`)**,
   requiring explicit configuration and failing loud (`skipped`/validation error)
   instead of guessing. Scoped, cheap, and directly closes the specific
   misconfiguration Maya asked me to construct — but explicitly NOT a full fix for
   Scenario 10, which needs a real product/data-model decision (org-chart or
   sensitivity-classification concept) that doesn't exist yet.
6. **Priority 6 — make `executeAction`'s `notify.email`/`notify.slack` cases
   actually consult `config.sections` before rendering Crystal-derived content**,
   closing the compliance-relevant gap where the toggle is currently decorative at
   send time.
7. **Priority 5 — build a data-fetch step between "cron fired" and "action
   executes"** so `scope_tag_id`/`scope_survey_id`-scoped scheduled workflows can
   pull real survey/metric data into the event before `crystal.summarize`/
   `notify.*` runs. Larger, not trivial — scope as its own task, affects every
   scheduled digest template in the gallery.
8. **Priority 7 — track as a design-limitation follow-up (not urgent):** a
   per-entity-aware cooldown key (mirroring `alertEngine`'s
   `{orgId}:{ruleId}:{entityId}:{window}` pattern) for tag-scoped/org-scoped
   cooldown-set workflows. Real, but narrower in practice than it first sounds —
   requires tag-scoped + cooldown-set to be a live usage pattern.
9. **Priority 8 and 9 — no fix needed.** Both hold up under direct testing.
   Priority 9's sequential (non-parallel) execution loop is worth keeping in mind as
   a future scalability optimization (`Promise.all` across sibling workflows) if
   workflow density per trigger grows, but is not a correctness bug today.
